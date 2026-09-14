-- 0022: admin_delete_user 授权扩展 —— 本校学校管理员也可删除本校用户。
-- 删除语义仍同 0015（个人数据级联；共享内容/历史/在途任务引用置空，见 0021）。
-- 授权矩阵（删除者视角）：
--   · 系统管理员（profiles.is_admin）    ：可删任何人，除外：自己、其他系统管理员账号；
--   · 学校管理员（user_roles school_admin）：可删本校用户，除外：
--       自己、系统管理员账号、其他学校管理员、在任市级专家
--     （后两类岗位由系统管理员授予/管理，删人即连带撤销任命，故归系统管理员处理；
--       教研组长任命属本校管辖，随删除级联清除即可）。
-- 注：school_admin 的"本校"由 profiles.school_id 决定（user_roles 不存学校）。

create or replace function public.admin_delete_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := public.require_uid();
  v_me     profiles%rowtype;
  v_target profiles%rowtype;
  v_is_sys boolean;
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

  delete from auth.users where id = p_user_id;
  if not found then
    raise exception '用户不存在（认证记录缺失）';
  end if;

  perform public.audit('admin_delete_user', null, null,
    jsonb_build_object('user_id', p_user_id, 'name', v_target.name, 'email', v_target.email,
                       'actor_role', case when v_is_sys then 'system_admin' else 'school_admin' end));
end;
$$;

revoke execute on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;
