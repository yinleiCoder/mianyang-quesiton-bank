-- 0012: 放行"发布替换"所需的 published → superseded 迁移，同时保持入库内容不可篡改。
-- 背景：0003 的防篡改守卫把所有 published 行写死，导致 review_decide 的市级通过分支
-- （第 500-501 行把旧入库版本置 superseded）报"该状态的版本不可直接修改"——改版 v2 通过后永远无法替换 v1。
-- 方案：守卫放行一条受限迁移——old=published & new=superseded 且除 status 外所有字段原样，
-- 并显式要求会话开关 app.allow_supersede='on'（由发布函数用事务级 set_config 临时打开，杜绝旁路）。

create or replace function public.guard_version_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status in ('published', 'superseded', 'retracted') then
    -- 唯一合法的入库后迁移：新版本发布时系统将旧 published 行标记为 superseded。
    -- 必须带事务级开关授权，且除 status 外所有字段不得变化（内容/归属/时间戳原样）。
    if tg_op = 'UPDATE'
       and old.status = 'published' and new.status = 'superseded'
       and current_setting('app.allow_supersede', true) = 'on'
       and new.question_id is not distinct from old.question_id
       and new.version_no is not distinct from old.version_no
       and new.change_type is not distinct from old.change_type
       and new.base_version_id is not distinct from old.base_version_id
       and new.qtype is not distinct from old.qtype
       and new.difficulty is not distinct from old.difficulty
       and new.content is not distinct from old.content
       and new.search_text is not distinct from old.search_text
       and new.created_by is not distinct from old.created_by
       and new.submitted_at is not distinct from old.submitted_at
       and new.published_at is not distinct from old.published_at
       and new.created_at is not distinct from old.created_at then
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

-- 同步改写 review_decide：市级通过（入库）分支在 supersede 语句前后开/关事务级开关。
-- 其余逻辑与 0004 完全一致（幂等通过 + 旧版本替换 + 指针切换 + 审计）。
create or replace function public.review_decide(
  p_approval_id uuid, p_pass boolean, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_approval approvals%rowtype;
  v_version question_versions%rowtype;
  v_q questions%rowtype;
  v_expert uuid;
begin
  select * into v_approval from approvals where id = p_approval_id;
  if not found then
    raise exception '审批任务不存在';
  end if;
  if v_approval.state <> 'waiting' then
    raise exception '该任务已被处理';
  end if;
  if v_approval.assigned_user_id is distinct from v_uid then
    raise exception '该任务不在你的待办中（可能已转派）';
  end if;

  -- ============ 退回 ============
  if not p_pass then
    if p_comment is null or trim(p_comment) = '' then
      raise exception '退回时必须填写审批意见';
    end if;
    update approvals set state = 'returned', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
    -- 关闭同版本/同事件的其他等待任务
    update approvals set state = 'cancelled'
    where state = 'waiting' and id <> p_approval_id
      and (version_id = v_approval.version_id
           or (v_approval.version_id is null and question_id = v_approval.question_id and kind = v_approval.kind));
    if v_approval.version_id is not null then
      update question_versions set status = 'returned'
      where id = v_approval.version_id and status in ('pending_group', 'pending_city');
    end if;
    perform public.audit('review_return', v_approval.question_id, v_approval.version_id,
      jsonb_build_object('stage', v_approval.stage, 'comment', p_comment));
    return;
  end if;

  -- ============ 通过 ============
  select * into v_q from questions where id = v_approval.question_id;

  if v_approval.kind in ('offline', 'restore') then
    update approvals set state = 'approved', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
    update questions set state = case when v_approval.kind = 'offline' then 'offline' else 'live' end
    where id = v_q.id;
    perform public.audit(case when v_approval.kind = 'offline' then 'approve_offline' else 'approve_restore' end,
      v_q.id, null, jsonb_build_object('comment', p_comment));
    return;
  end if;

  select * into v_version from question_versions where id = v_approval.version_id;
  if v_version.status <> 'pending_' || v_approval.stage then
    raise exception '版本当前状态与任务环节不匹配';
  end if;

  if v_approval.stage = 'group' then
    update approvals set state = 'approved', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
    update question_versions set status = 'pending_city' where id = v_version.id;
    -- 流转专家（排除组长本人与作者本人）；无可用专家时任务待指派
    v_expert := public.effective_assignee(v_q.school_id, v_q.course_node_id, 'city_expert',
      array[v_uid, v_version.created_by]);
    insert into approvals (kind, version_id, question_id, stage, assigned_user_id)
    values ('content', v_version.id, v_q.id, 'city', v_expert);
    perform public.audit('approve_group', v_q.id, v_version.id,
      jsonb_build_object('city_expert', v_expert, 'comment', p_comment));
    return;
  end if;

  -- ============ 市级专家通过 = 入库（幂等） ============
  update approvals set state = 'approved', decided_by = v_uid, decided_at = now(), comment = p_comment
  where id = p_approval_id and state = 'waiting';
  if not found then
    raise exception '该任务已被处理';
  end if;
  update question_versions
  set status = 'published', published_at = now()
  where id = v_version.id and status = 'pending_city';
  if not found then
    raise exception '版本入库状态变更失败，请刷新后重试';
  end if;
  -- 旧入库版本标记为已被替换（事务级授权，防篡改守卫只放行 status 迁移）
  perform set_config('app.allow_supersede', 'on', true);
  update question_versions set status = 'superseded'
  where question_id = v_q.id and status = 'published' and id <> v_version.id;
  perform set_config('app.allow_supersede', 'off', true);
  update questions set current_published_version_id = v_version.id where id = v_q.id;
  perform public.audit('approve_city_publish', v_q.id, v_version.id,
    jsonb_build_object('comment', p_comment));
end;
$$;
