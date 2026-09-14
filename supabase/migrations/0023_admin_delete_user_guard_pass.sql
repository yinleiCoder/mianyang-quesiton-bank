-- 0023: 打通 admin_delete_user 与"防篡改守卫"——删除账号时引用列置空不再被拦。
-- 根因：0021 把 FK 改为 ON DELETE SET NULL 后，删除已出题用户会由 FK 级联对
--   question_versions 的 published/superseded/retracted 行、approvals 的已决行执行 UPDATE 置空，
--   分别撞上 guard_version_immutable（"该状态的版本不可直接修改"，0012 起含受权 supersede 例外）
--   与 guard_approval_immutable（"已决审批记录不可修改或删除"）→ 整个删除回滚。
-- 方案（沿用 0012 的"事务级开关 + 窄迁移"模式）：
--   · 两个守卫各放行一条受限迁移：开关 app.user_cleanup='on' 时，仅允许把
--     question_versions.created_by / approvals.assigned_user_id|decided_by 置空，
--     且该行其余字段逐位原样（to_jsonb 减法比较，字段增删不漂移）；DELETE 与其它修改依旧拒绝。
--   · admin_delete_user 在开关窗口内先显式置空所有引用列（审计/媒体/树/标签/任命创建者列无守卫，
--     一并清掉），再关闭开关、删除 auth.users——此时 FK 级联已无行可置，删除干净收口。

create or replace function public.guard_version_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status in ('published', 'superseded', 'retracted') then
    -- 唯一合法的入库后迁移：新版本发布时系统将旧 published 行标记为 superseded。
    if tg_op = 'UPDATE'
       and old.status = 'published' and new.status = 'superseded'
       and current_setting('app.allow_supersede', true) = 'on'
       and (to_jsonb(new) - 'status') is not distinct from (to_jsonb(old) - 'status') then
      return new;
    end if;
    -- 用户注销清理：仅 created_by 置空，其余字段（含 status/内容/时间戳）原样。
    if tg_op = 'UPDATE'
       and current_setting('app.user_cleanup', true) = 'on'
       and old.created_by is not null and new.created_by is null
       and (to_jsonb(new) - 'created_by') is not distinct from (to_jsonb(old) - 'created_by') then
      return new;
    end if;
    raise exception '该状态的版本不可直接修改';
  end if;
  if tg_op = 'DELETE' and old.status <> 'draft' then
    raise exception '只能删除纯草稿版本';
  end if;
  return new;
end;
$$;

create or replace function public.guard_approval_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.state in ('approved', 'returned', 'cancelled') then
    -- 用户注销清理：仅 assigned_user_id / decided_by 置空，其余字段（含意见/时间/环节）原样。
    if tg_op = 'UPDATE'
       and current_setting('app.user_cleanup', true) = 'on'
       and (new.assigned_user_id is null or new.decided_by is null)
       and (to_jsonb(new) - 'assigned_user_id' - 'decided_by')
           is not distinct from (to_jsonb(old) - 'assigned_user_id' - 'decided_by') then
      return new;
    end if;
    raise exception '已决审批记录不可修改或删除';
  end if;
  return new;
end;
$$;

-- admin_delete_user v3：授权矩阵同 0022（系统管理员全校 / 学校管理员仅本校普通教师）；
-- 删除前在受权窗口内显式置空全部引用列（等待任务随之变"待指派"）。
create or replace function public.admin_delete_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := public.require_uid();
  v_me       profiles%rowtype;
  v_target   profiles%rowtype;
  v_is_sys   boolean;
  v_versions bigint;
  v_approvals bigint;
begin
  select * into v_me from profiles where user_id = v_uid;
  v_is_sys := coalesce(v_me.is_admin, false);

  if not v_is_sys then
    if v_me.school_id is null
       or not exists (select 1 from user_roles r where r.user_id = v_uid and r.role = 'school_admin') then
      raise exception '仅系统管理员或本校学校管理员可删除用户';
    end if;
  end if;

  if p_user_id = v_uid then
    raise exception '不能删除当前登录账号';
  end if;

  select * into v_target from profiles where user_id = p_user_id;
  if not found then
    raise exception '用户不存在';
  end if;
  if v_target.is_admin then
    raise exception '系统管理员账号不可删除';
  end if;

  if not v_is_sys then
    if v_target.school_id is distinct from v_me.school_id then
      raise exception '只能删除本校用户';
    end if;
    if exists (select 1 from user_roles r where r.user_id = p_user_id and r.role = 'school_admin') then
      raise exception '该用户为学校管理员，需由系统管理员删除';
    end if;
    if exists (select 1 from approver_assignments a
               where a.user_id = p_user_id and a.role = 'city_expert' and a.is_active) then
      raise exception '该用户担任市级专家，需由系统管理员删除';
    end if;
  end if;

  -- 保留共享内容与历史：引用列显式置空（守卫放行窗口；等待审批任务随之变"待指派"）
  perform set_config('app.user_cleanup', 'on', true);
  update questions set creator_id = null where creator_id = p_user_id;
  update question_versions set created_by = null where created_by = p_user_id;
  get diagnostics v_versions = row_count;
  update approvals set assigned_user_id = null, decided_by = null
   where assigned_user_id = p_user_id or decided_by = p_user_id;
  get diagnostics v_approvals = row_count;
  update media_objects set uploaded_by = null where uploaded_by = p_user_id;
  update audit_log set user_id = null where user_id = p_user_id;
  update tags set created_by = null where created_by = p_user_id;
  update subject_nodes set created_by = null where created_by = p_user_id;
  update approver_assignments set created_by = null where created_by = p_user_id;
  update user_roles set created_by = null where created_by = p_user_id;
  perform set_config('app.user_cleanup', 'off', true);

  delete from auth.users where id = p_user_id;
  if not found then
    raise exception '用户不存在（认证记录缺失）';
  end if;

  perform public.audit('admin_delete_user', null, null,
    jsonb_build_object('user_id', p_user_id, 'name', v_target.name, 'email', v_target.email,
                       'actor_role', case when v_is_sys then 'system_admin' else 'school_admin' end,
                       'versions_kept', v_versions, 'approval_refs_cleared', v_approvals));
end;
$$;

revoke execute on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;
