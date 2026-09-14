-- 0004: RLS 策略 + 授权收口 + 安全写函数集（SECURITY DEFINER）
-- 客户端（authenticated/anon）无任何表级 DML；所有写操作经下述函数，函数内强校验 + 同事务审计。

-- =====================================================================
-- 1) 权限助手
-- =====================================================================

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from profiles where user_id = auth.uid() and is_admin);
$$;

-- 当前用户是否为某学校的学校管理员（学校管理员仅能管理自己档案所属学校）
create or replace function public.is_school_admin(p_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from user_roles ur
    join profiles p on p.user_id = ur.user_id
    where ur.user_id = auth.uid() and ur.role = 'school_admin'
      and p.school_id = p_school_id
  );
$$;

create or replace function public.require_uid()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception '未登录' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- 求"最深生效任命"：p_node 沿祖先向上（含自身），返回匹配该角色/学校且不在排除集中的用户
-- 组长: p_school 生效; 专家: 忽略 p_school（school_id IS NULL）
create or replace function public.effective_assignee(
  p_school uuid, p_node uuid, p_role assignee_role, p_exclude uuid[] default '{}'::uuid[])
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  with recursive chain(id, depth, parent_id) as (
    select id, 0, parent_id from subject_nodes where id = p_node
    union all
    select sn.id, c.depth + 1, sn.parent_id
    from chain c
    join subject_nodes sn on sn.id = c.parent_id
  )
  select aa.user_id
  from chain c
  join approver_assignments aa on aa.node_id = c.id and aa.is_active and aa.role = p_role
    and (aa.school_id = p_school or (p_role = 'city_expert'))
    and not (aa.user_id = any(p_exclude))
  order by c.depth asc
  limit 1;
$$;

-- 内部审计（与被审计操作同事务）
create or replace function public.audit(p_action text, p_question_id uuid default null,
  p_version_id uuid default null, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.write_audit(p_action, p_question_id, p_version_id, p_detail);
end;
$$;

-- 公共小校验：入参标签必须全部存在，返回其 (id, name) 供快照
create or replace function public.check_tags_exist(p_tag_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t uuid;
begin
  if p_tag_ids is null then
    raise exception '标签参数为空';
  end if;
  foreach t in array p_tag_ids loop
    if not exists (select 1 from tags where id = t) then
      raise exception '标签不存在: %', t;
    end if;
  end loop;
end;
$$;

create or replace function public.replace_version_tags(p_version_id uuid, p_tag_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t uuid;
  v_name citext;
begin
  if p_tag_ids is null or cardinality(p_tag_ids) > 20 then
    raise exception '每题最多选择 20 个标签';
  end if;
  delete from version_tags where version_id = p_version_id;
  for t in select distinct unnest(p_tag_ids) loop
    select name into v_name from tags where id = t;
    if v_name is null then
      raise exception '标签不存在: %', t;
    end if;
    insert into version_tags (version_id, tag_id, tag_name) values (p_version_id, t, v_name);
  end loop;
end;
$$;

-- 出题/编辑入参校验：作者档案、课程节点可挂性
create or replace function public.check_can_author(p_course_node uuid)
returns uuid  -- 返回作者的 school_id
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_school uuid;
  v_kind subject_kind;
  v_frozen boolean;
begin
  select school_id into v_school from profiles where user_id = v_uid;
  if v_school is null then
    raise exception '你的账号未绑定学校，无法出题';
  end if;
  select kind, is_frozen into v_kind, v_frozen from subject_nodes where id = p_course_node;
  if not found then
    raise exception '课程节点不存在';
  end if;
  if not public.can_attach_question((select s from subject_nodes s where s.id = p_course_node)) then
    raise exception '该节点不可挂题目（请在课程/公共学科层出题）';
  end if;
  if v_frozen then
    raise exception '该课程节点已冻结，暂不能提交新题';
  end if;
  return v_school;
end;
$$;

-- =====================================================================
-- 2) 教师/作者题目操作
-- =====================================================================

-- 新建题目（写入草稿版本 v1）
create or replace function public.create_question_draft(
  p_course_node uuid, p_qtype text, p_difficulty smallint,
  p_content jsonb, p_tag_ids uuid[] default '{}'::uuid[])
returns uuid  -- 返回 question_versions.id
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_school uuid;
  v_question uuid;
  v_version uuid;
begin
  v_school := public.check_can_author(p_course_node);
  perform public.validate_question_content(p_qtype, p_content);
  perform public.check_tags_exist(p_tag_ids);
  if p_tag_ids is null then p_tag_ids := '{}'::uuid[]; end if;

  insert into questions (school_id, creator_id, course_node_id)
  values (v_school, v_uid, p_course_node)
  returning id into v_question;

  insert into question_versions (question_id, version_no, change_type, qtype, difficulty, content,
                                 search_text, created_by)
  values (v_question, 1, 'create', p_qtype, p_difficulty, p_content,
          public.question_search_text(p_content), v_uid)
  returning id into v_version;

  perform public.replace_version_tags(v_version, p_tag_ids);
  perform public.sync_version_media(v_version, p_content);
  perform public.audit('create_draft', v_question, v_version, jsonb_build_object('qtype', p_qtype));
  return v_version;
end;
$$;

-- 修改草稿/被退回版本内容（原地改同一行，状态不变）
create or replace function public.update_question_draft(
  p_version_id uuid, p_qtype text, p_difficulty smallint,
  p_content jsonb, p_tag_ids uuid[] default '{}'::uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not exists (
    select 1 from question_versions v
    join questions q on q.id = v.question_id
    where v.id = p_version_id and v.created_by = v_uid
      and v.status in ('draft', 'returned')
  ) then
    raise exception '只能修改自己的草稿或被退回的版本';
  end if;
  perform public.validate_question_content(p_qtype, p_content);
  if p_tag_ids is null then p_tag_ids := '{}'::uuid[]; end if;
  perform public.check_tags_exist(p_tag_ids);

  update question_versions
  set qtype = p_qtype, difficulty = p_difficulty, content = p_content,
      search_text = public.question_search_text(p_content)
  where id = p_version_id;

  perform public.replace_version_tags(p_version_id, p_tag_ids);
  perform public.sync_version_media(p_version_id, p_content);
  perform public.audit('edit_draft', (select question_id from question_versions where id = p_version_id),
    p_version_id);
end;
$$;

-- 提交（草稿或退回后重提 → 全链重启从组长环节重新审）
create or replace function public.submit_question(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_status text;
  v_qid uuid;
  v_school uuid;
  v_node uuid;
  v_leader uuid;
  v_frozen boolean;
begin
  select v.status, v.question_id into v_status, v_qid
  from question_versions v where v.id = p_version_id and v.created_by = v_uid
    and v.status in ('draft', 'returned');
  if not found then
    raise exception '找不到可提交的版本（只能提交自己的草稿或被退回的版本）';
  end if;

  select q.school_id, q.course_node_id into v_school, v_node
  from questions q where q.id = v_qid;
  select is_frozen into v_frozen from subject_nodes where id = v_node;
  if v_frozen then
    raise exception '该课程节点已冻结，暂不能提交';
  end if;

  -- 内容最终校验（含退回后修改过的版本）
  perform public.validate_question_content(
    (select qtype from question_versions where id = p_version_id),
    (select content from question_versions where id = p_version_id));

  v_leader := public.effective_assignee(v_school, v_node, 'group_leader', array[v_uid]);
  if v_leader is null then
    raise exception '该校该课程暂未配置教研组长（或组长与作者为同一人），请联系学校管理员任命后提交';
  end if;

  begin
    update question_versions
    set status = 'pending_group', submitted_at = now()
    where id = p_version_id;

    insert into approvals (kind, version_id, question_id, stage, assigned_user_id)
    values ('content', p_version_id, v_qid, 'group', v_leader);
  exception when unique_violation then
    raise exception '该版本已在审核中，请刷新页面查看';
  end;

  perform public.audit('submit_version', v_qid, p_version_id,
    jsonb_build_object('group_leader', v_leader));
end;
$$;

-- 教师撤回自己的待审提交
create or replace function public.retract_question(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_qid uuid;
begin
  select question_id into v_qid from question_versions
  where id = p_version_id and created_by = v_uid
    and status in ('pending_group', 'pending_city');
  if not found then
    raise exception '只能撤回自己待审核的提交';
  end if;
  update question_versions set status = 'retracted' where id = p_version_id;
  -- 只取消该版本自身的等待任务；独立的上下线事件不受影响
  update approvals set state = 'cancelled'
  where state = 'waiting' and version_id = p_version_id;
  perform public.audit('retract_version', v_qid, p_version_id);
end;
$$;

-- 删除纯草稿题目（从未提交过任何版本）
create or replace function public.delete_question_draft(p_question_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not exists (
    select 1 from questions q
    where q.id = p_question_id and q.creator_id = v_uid
      and not exists (
        select 1 from question_versions v where v.question_id = q.id and v.status <> 'draft')
  ) then
    raise exception '只能删除自己从未提交过的纯草稿题目';
  end if;
  perform public.audit('delete_draft', p_question_id, null, '{}'::jsonb);
  delete from questions where id = p_question_id;
end;
$$;

-- 教师发起下线/恢复申请（组长一级审批；事件非内容版本）
create or replace function public.request_question_state_change(p_question_id uuid, p_offline boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_q questions%rowtype;
  v_leader uuid;
  v_kind text := case when p_offline then 'offline' else 'restore' end;
begin
  select * into v_q from questions where id = p_question_id;
  if not found then
    raise exception '题目不存在';
  end if;
  -- 仅作者本人发起（走组长审批）；系统管理员用 admin_set_question_state 直接操作
  if v_q.creator_id <> v_uid then
    raise exception '只有作者本人能申请下线/恢复该题';
  end if;
  if public.is_admin() then
    raise exception '系统管理员请使用直接操作入口';
  end if;
  if p_offline and v_q.state <> 'live' then
    raise exception '该题当前已下线';
  end if;
  if not p_offline and v_q.state <> 'offline' then
    raise exception '该题当前并未下线';
  end if;
  if v_q.current_published_version_id is null then
    raise exception '题目尚未入库，无需下线/恢复';
  end if;

  v_leader := public.effective_assignee(v_q.school_id, v_q.course_node_id, 'group_leader',
    array[v_q.creator_id]);
  if v_leader is null then
    raise exception '该校该课程暂未配置教研组长，请联系学校管理员';
  end if;
  begin
    insert into approvals (kind, version_id, question_id, stage, assigned_user_id)
    values (v_kind, null, p_question_id, 'group', v_leader);
  exception when unique_violation then
    raise exception '该题已有待处理的同类申请，请勿重复提交';
  end;
  perform public.audit(case when p_offline then 'request_offline' else 'request_restore' end,
    p_question_id, null, jsonb_build_object('assignee', v_leader));
end;
$$;

-- =====================================================================
-- 3) 审核处理（唯一收口：通过/退回/转派）
-- =====================================================================

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
  v_updated int;
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
  update question_versions set status = 'superseded'
  where question_id = v_q.id and status = 'published' and id <> v_version.id;
  update questions set current_published_version_id = v_version.id where id = v_q.id;
  perform public.audit('approve_city_publish', v_q.id, v_version.id,
    jsonb_build_object('comment', p_comment));
end;
$$;

-- 转派（管理员/本校管理员；快照化任务在途不变，树/任命调整不影响）
create or replace function public.transfer_approval(p_approval_id uuid, p_to_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_approval approvals%rowtype;
  v_q questions%rowtype;
begin
  select * into v_approval from approvals where id = p_approval_id;
  if not found then
    raise exception '审批任务不存在';
  end if;
  if v_approval.state <> 'waiting' then
    raise exception '只有待处理任务可以转派';
  end if;
  select * into v_q from questions where id = v_approval.question_id;
  if not (public.is_admin()
          or (v_approval.stage = 'group' and public.is_school_admin(v_q.school_id))) then
    raise exception '无权转派该任务';
  end if;
  if not exists (select 1 from profiles where user_id = p_to_user) then
    raise exception '目标用户不存在';
  end if;
  if v_approval.version_id is not null
     and p_to_user = (select created_by from question_versions where id = v_approval.version_id) then
    raise exception '不能转派给作者本人';
  end if;
  if v_approval.assigned_user_id is not distinct from p_to_user then
    raise exception '目标用户已是该任务处理人';
  end if;
  update approvals set assigned_user_id = p_to_user where id = p_approval_id;
  perform public.audit('transfer_approval', v_q.id, v_approval.version_id,
    jsonb_build_object('from', v_approval.assigned_user_id, 'to', p_to_user));
end;
$$;

-- =====================================================================
-- 4) 系统管理员直接操作（绕过审批，立即生效，仍落版本与审计）
-- =====================================================================

-- 管理员直接编辑已入库题：新开 admin_direct 版本立即发布并替换
create or replace function public.admin_direct_update_question(
  p_question_id uuid, p_qtype text, p_difficulty smallint,
  p_content jsonb, p_tag_ids uuid[] default '{}'::uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_q questions%rowtype;
  v_no int;
  v_version uuid;
  v_cancelled int := 0;
  v_retracted int := 0;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可执行该操作';
  end if;
  select * into v_q from questions where id = p_question_id;
  if not found then
    raise exception '题目不存在';
  end if;
  perform public.validate_question_content(p_qtype, p_content);
  if p_tag_ids is null then p_tag_ids := '{}'::uuid[]; end if;
  perform public.check_tags_exist(p_tag_ids);

  -- 覆盖在流版本与待处理事件（审计记录覆盖原因）
  update question_versions set status = 'retracted'
  where question_id = p_question_id and status in ('pending_group', 'pending_city', 'returned');
  get diagnostics v_retracted = row_count;
  update approvals set state = 'cancelled'
  where question_id = p_question_id and state = 'waiting';
  get diagnostics v_cancelled = row_count;

  select coalesce(max(version_no), 0) + 1 into v_no from question_versions where question_id = p_question_id;
  insert into question_versions (question_id, version_no, change_type, status, qtype, difficulty,
                                 content, search_text, created_by, submitted_at, published_at)
  values (p_question_id, v_no, 'admin_direct', 'published', p_qtype, p_difficulty, p_content,
          public.question_search_text(p_content), v_uid, now(), now())
  returning id into v_version;

  update question_versions set status = 'superseded'
  where question_id = p_question_id and status = 'published' and id <> v_version;
  update questions set current_published_version_id = v_version where id = p_question_id;

  perform public.replace_version_tags(v_version, p_tag_ids);
  perform public.sync_version_media(v_version, p_content);
  perform public.audit('admin_direct_update', p_question_id, v_version,
    jsonb_build_object('version_no', v_no, 'retracted', v_retracted, 'cancelled_tasks', v_cancelled));
end;
$$;

-- 管理员直接上下线
create or replace function public.admin_set_question_state(p_question_id uuid, p_offline boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可执行该操作';
  end if;
  if not exists (select 1 from questions where id = p_question_id) then
    raise exception '题目不存在';
  end if;
  update questions set state = case when p_offline then 'offline' else 'live' end
  where id = p_question_id;
  perform public.audit(case when p_offline then 'admin_offline' else 'admin_restore' end,
    p_question_id, null, '{}'::jsonb);
end;
$$;

-- =====================================================================
-- 5) 媒体登记与清理
-- =====================================================================

-- 浏览器经服务端预签名上传成功后登记（key 由服务端生成，created_by=调用者）
create or replace function public.register_media(
  p_object_key text, p_bucket text, p_size bigint, p_mime text default null, p_sha256 text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
begin
  if p_object_key !~ '^qbank/' then
    raise exception '非法的对象路径';
  end if;
  insert into media_objects (object_key, bucket, size, mime, sha256, uploaded_by)
  values (p_object_key, p_bucket, p_size, p_mime, p_sha256, v_uid)
  returning id into v_id;
  return v_id;
end;
$$;

-- 删除未被任何版本引用的媒体（上传者本人/管理员）
create or replace function public.delete_unreferenced_media(p_media_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  m uuid;
begin
  foreach m in array p_media_ids loop
    if exists (select 1 from version_media vm where vm.media_object_id = m) then
      raise exception '媒体已被题目引用，不能删除';
    end if;
    delete from media_objects
    where id = m and (uploaded_by = v_uid or public.is_admin());
  end loop;
end;
$$;

-- 管理员孤儿媒体清理（未被任何版本引用且超过 N 天），返回清理数量
create or replace function public.admin_gc_media(p_max_age_days int default 30)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  m uuid;
  v_key text;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可执行该操作';
  end if;
  for m, v_key in
    select mo.id, mo.object_key from media_objects mo
    where mo.created_at < now() - make_interval(days => p_max_age_days)
      and not exists (select 1 from version_media vm where vm.media_object_id = mo.id)
  loop
    delete from media_objects where id = m;  -- OSS 侧文件由配套清理任务删除
    v_count := v_count + 1;
    perform public.audit('admin_gc_media', null, null, jsonb_build_object('object_key', v_key));
  end loop;
  return v_count;
end;
$$;

-- =====================================================================
-- 6) 学校 / 角色任命 / 科目树 / 标签（管理）
-- =====================================================================

create or replace function public.admin_create_school(p_name text, p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可创建学校';
  end if;
  if trim(p_name) = '' or trim(p_code) = '' then
    raise exception '学校名称与代码不能为空';
  end if;
  insert into schools (name, code) values (trim(p_name), upper(trim(p_code))) returning id into v_id;
  perform public.audit('admin_create_school', null, null,
    jsonb_build_object('name', p_name, 'code', p_code));
  return v_id;
end;
$$;

create or replace function public.admin_set_school_active(p_school_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可操作';
  end if;
  update schools set is_active = p_active where id = p_school_id;
  perform public.audit('admin_set_school_active', null, null,
    jsonb_build_object('school_id', p_school_id, 'active', p_active));
end;
$$;

create or replace function public.admin_assign_school_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可任命学校管理员';
  end if;
  if not exists (select 1 from profiles where user_id = p_user_id) then
    raise exception '目标用户不存在';
  end if;
  if exists (select 1 from profiles where user_id = p_user_id and school_id is null) then
    raise exception '目标用户未绑定学校，无法任命为学校管理员';
  end if;
  begin
    insert into user_roles (user_id, role, created_by) values (p_user_id, 'school_admin', v_uid);
  exception when unique_violation then
    raise exception '该用户已是学校管理员';
  end;
  perform public.audit('admin_assign_school_admin', null, null,
    jsonb_build_object('user_id', p_user_id));
end;
$$;

create or replace function public.admin_revoke_school_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可操作';
  end if;
  delete from user_roles where user_id = p_user_id and role = 'school_admin';
  perform public.audit('admin_revoke_school_admin', null, null,
    jsonb_build_object('user_id', p_user_id));
end;
$$;

-- 调整用户绑定学校（须先停用其组长任命）
create or replace function public.admin_set_user_school(p_user_id uuid, p_school_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可调整用户学校';
  end if;
  if not exists (select 1 from schools where id = p_school_id and is_active) then
    raise exception '目标学校不存在或已停用';
  end if;
  if exists (select 1 from approver_assignments
             where user_id = p_user_id and is_active and role = 'group_leader') then
    raise exception '请先停用该用户已有的组长任命，再调整学校';
  end if;
  update profiles set school_id = p_school_id where user_id = p_user_id;
  perform public.audit('admin_set_user_school', null, null,
    jsonb_build_object('user_id', p_user_id, 'school_id', p_school_id));
end;
$$;

-- 任命组长：学校管理员（本校）或系统管理员；目标用户需绑定该学校
create or replace function public.assign_group_leader(p_user_id uuid, p_node_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_target_school uuid;
  v_role assignee_role := 'group_leader';
  v_id uuid;
begin
  select school_id into v_target_school from profiles where user_id = p_user_id;
  if v_target_school is null then
    raise exception '目标用户未绑定学校';
  end if;
  if not (public.is_admin() or public.is_school_admin(v_target_school)) then
    raise exception '无权任命该校教研组长';
  end if;
  if not exists (select 1 from subject_nodes where id = p_node_id) then
    raise exception '科目节点不存在';
  end if;
  begin
    insert into approver_assignments (user_id, role, school_id, node_id, created_by)
    values (p_user_id, v_role, v_target_school, p_node_id, v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception '该岗位已有人在任；如需换人请先停用现有任命';
  end;
  perform public.audit('assign_group_leader', null, null,
    jsonb_build_object('user_id', p_user_id, 'school_id', v_target_school, 'node_id', p_node_id));
  return v_id;
end;
$$;

-- 任命市级专家：仅系统管理员
create or replace function public.assign_city_expert(p_user_id uuid, p_node_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可任命市级专家';
  end if;
  if not exists (select 1 from profiles where user_id = p_user_id) then
    raise exception '目标用户不存在';
  end if;
  if not exists (select 1 from subject_nodes where id = p_node_id) then
    raise exception '科目节点不存在';
  end if;
  begin
    insert into approver_assignments (user_id, role, school_id, node_id, created_by)
    values (p_user_id, 'city_expert', null, p_node_id, v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception '该岗位已有人在任；如需换人请先停用现有任命';
  end;
  perform public.audit('assign_city_expert', null, null,
    jsonb_build_object('user_id', p_user_id, 'node_id', p_node_id));
  return v_id;
end;
$$;

-- 停用任命（组长：任命本校的管理员或系统管理员；专家：系统管理员）
create or replace function public.revoke_approver(p_assignment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_row approver_assignments%rowtype;
begin
  select * into v_row from approver_assignments where id = p_assignment_id;
  if not found then
    raise exception '任命不存在';
  end if;
  if v_row.role = 'city_expert' then
    if not public.is_admin() then
      raise exception '仅系统管理员可停用市级专家任命';
    end if;
  else
    if not (public.is_admin() or public.is_school_admin(v_row.school_id)) then
      raise exception '无权停用该任命';
    end if;
  end if;
  update approver_assignments set is_active = false where id = p_assignment_id;
  perform public.audit('revoke_approver', null, null,
    jsonb_build_object('assignment_id', p_assignment_id));
end;
$$;

-- 科目树维护（系统管理员）
create or replace function public.admin_create_subject_node(
  p_scope subject_scope, p_kind subject_kind, p_parent_id uuid,
  p_name text, p_sort_order int default 0)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可维护科目树';
  end if;
  if trim(p_name) = '' then
    raise exception '名称不能为空';
  end if;
  insert into subject_nodes (scope, kind, parent_id, name, sort_order, created_by)
  values (p_scope, p_kind, p_parent_id, trim(p_name), p_sort_order, v_uid)
  returning id into v_id;
  perform public.audit('admin_create_node', null, null,
    jsonb_build_object('name', p_name, 'kind', p_kind::text, 'scope', p_scope::text, 'parent', p_parent_id));
  return v_id;
end;
$$;

create or replace function public.admin_rename_node(p_node_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可维护科目树';
  end if;
  update subject_nodes set name = trim(p_name) where id = p_node_id;
  perform public.audit('admin_rename_node', null, null, jsonb_build_object('node_id', p_node_id, 'name', p_name));
end;
$$;

-- new_parent = null 表示移到该目录顶层
create or replace function public.admin_move_node(p_node_id uuid, p_new_parent uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可维护科目树';
  end if;
  update subject_nodes set parent_id = p_new_parent where id = p_node_id; -- 触发层级矩阵校验
  perform public.audit('admin_move_node', null, null,
    jsonb_build_object('node_id', p_node_id, 'parent', p_new_parent));
end;
$$;

create or replace function public.admin_set_node_frozen(p_node_id uuid, p_frozen boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可维护科目树';
  end if;
  update subject_nodes set is_frozen = p_frozen where id = p_node_id;
  perform public.audit('admin_set_node_frozen', null, null,
    jsonb_build_object('node_id', p_node_id, 'frozen', p_frozen));
end;
$$;

-- 删除节点：无子节点/题目/任命时允许；其余提示冻结
create or replace function public.admin_delete_node(p_node_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可维护科目树';
  end if;
  if exists (select 1 from subject_nodes where parent_id = p_node_id)
     or exists (select 1 from questions where course_node_id = p_node_id)
     or exists (select 1 from approver_assignments where node_id = p_node_id) then
    raise exception '该节点下已有子节点/题目/任命，不能删除（可冻结）';
  end if;
  delete from subject_nodes where id = p_node_id;
  perform public.audit('admin_delete_node', null, null, jsonb_build_object('node_id', p_node_id));
end;
$$;

-- 标签：改名 / 合并
create or replace function public.admin_rename_tag(p_tag_id uuid, p_new_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可管理标签';
  end if;
  if trim(p_new_name) = '' then
    raise exception '标签名不能为空';
  end if;
  begin
    update tags set name = trim(p_new_name) where id = p_tag_id;
  exception when unique_violation then
    raise exception '已存在同名标签';
  end;
  perform public.audit('admin_rename_tag', null, null,
    jsonb_build_object('tag_id', p_tag_id, 'name', p_new_name));
end;
$$;

-- 合并：from 并入 to（引用全部重指；在途版本的快照名同步为目标名；历史快照保留原样）
create or replace function public.admin_merge_tag(p_from_tag uuid, p_to_tag uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_to_name citext;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可管理标签';
  end if;
  if p_from_tag = p_to_tag then
    raise exception '不能合并到自己';
  end if;
  select name into v_to_name from tags where id = p_to_tag;
  if not found then
    raise exception '目标标签不存在';
  end if;
  if not exists (select 1 from tags where id = p_from_tag) then
    raise exception '源标签不存在';
  end if;
  update version_tags set tag_id = p_to_tag where tag_id = p_from_tag;
  update version_tags vt set tag_name = v_to_name
  where vt.tag_id = p_to_tag and vt.version_id in (
    select id from question_versions where status in ('draft','pending_group','pending_city','returned'));
  -- 源标签若已无引用则删除，否则保留
  delete from tags where id = p_from_tag
    and not exists (select 1 from version_tags where tag_id = p_from_tag);
  perform public.audit('admin_merge_tag', null, null,
    jsonb_build_object('from', p_from_tag, 'to', p_to_tag));
end;
$$;

-- 新建标签（教师自由打标签，唯一忽略大小写）
create or replace function public.create_tag(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
begin
  if trim(p_name) = '' then
    raise exception '标签名不能为空';
  end if;
  begin
    insert into tags (name, created_by) values (trim(p_name), v_uid) returning id into v_id;
  exception when unique_violation then
    raise exception '标签已存在';
  end;
  return v_id;
end;
$$;

-- =====================================================================
-- 7) 权限收口：RLS + 授权
-- =====================================================================

-- 元数据/低敏表：登录即可读
alter table public.schools enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.subject_nodes enable row level security;
alter table public.approver_assignments enable row level security;
alter table public.tags enable row level security;
alter table public.media_objects enable row level security;
alter table public.version_media enable row level security;

drop policy if exists select_any_auth on public.schools;
create policy select_any_auth on public.schools for select to authenticated using (true);
drop policy if exists select_any_auth on public.profiles;
create policy select_any_auth on public.profiles for select to authenticated using (true);
drop policy if exists select_any_auth on public.user_roles;
create policy select_any_auth on public.user_roles for select to authenticated using (true);
drop policy if exists select_any_auth on public.subject_nodes;
create policy select_any_auth on public.subject_nodes for select to authenticated using (true);
drop policy if exists select_any_auth on public.approver_assignments;
create policy select_any_auth on public.approver_assignments for select to authenticated using (true);
drop policy if exists select_any_auth on public.tags;
create policy select_any_auth on public.tags for select to authenticated using (true);
drop policy if exists select_any_auth on public.media_objects;
create policy select_any_auth on public.media_objects for select to authenticated using (true);
drop policy if exists select_any_auth on public.version_media;
create policy select_any_auth on public.version_media for select to authenticated using (true);

-- 问题类：可见性策略（全市共享的是"已入库且上线"内容；其余按作者/本校管理员/审批参与/系统管理员）
alter table public.questions enable row level security;
alter table public.question_versions enable row level security;
alter table public.approvals enable row level security;

drop policy if exists select_question on public.questions;
create policy select_question on public.questions for select to authenticated using (
  creator_id = auth.uid()
  or public.is_admin()
  or exists (
    select 1 from profiles p join user_roles r on r.user_id = p.user_id
    where p.user_id = auth.uid() and r.role = 'school_admin' and p.school_id = questions.school_id)
  or exists (select 1 from approvals a where a.question_id = questions.id
             and (a.assigned_user_id = auth.uid() or a.decided_by = auth.uid()))
  or (state = 'live' and current_published_version_id is not null)
);

drop policy if exists select_version on public.question_versions;
create policy select_version on public.question_versions for select to authenticated using (
  created_by = auth.uid()
  or public.is_admin()
  or exists (
    select 1 from questions q
    join profiles p on p.user_id = auth.uid()
    join user_roles r on r.user_id = p.user_id and r.role = 'school_admin'
    where q.id = question_versions.question_id and p.school_id = q.school_id)
  or exists (select 1 from approvals a where a.version_id = question_versions.id
             and (a.assigned_user_id = auth.uid() or a.decided_by = auth.uid()))
  or (status = 'published'
      and exists (select 1 from questions q
                  where q.id = question_versions.question_id and q.state = 'live'
                    and q.current_published_version_id = question_versions.id))
);

drop policy if exists select_approval on public.approvals;
create policy select_approval on public.approvals for select to authenticated using (
  assigned_user_id = auth.uid()
  or decided_by = auth.uid()
  or public.is_admin()
  or exists (
    select 1 from questions q
    join profiles p on p.user_id = auth.uid()
    join user_roles r on r.user_id = p.user_id and r.role = 'school_admin'
    where q.id = approvals.question_id and p.school_id = q.school_id)
  or exists (select 1 from questions q where q.id = approvals.question_id and q.creator_id = auth.uid())
);

-- 审计日志：本人/系统管理员/本校学校管理员
alter table public.audit_log enable row level security;
drop policy if exists select_audit on public.audit_log;
create policy select_audit on public.audit_log for select to authenticated using (
  user_id = auth.uid()
  or public.is_admin()
  or exists (
    select 1 from questions q
    join profiles p on p.user_id = auth.uid()
    join user_roles r on r.user_id = p.user_id and r.role = 'school_admin'
    where q.id = audit_log.question_id and p.school_id = q.school_id)
);

-- ============ 授权收口 ============
revoke all on public.schools, public.profiles, public.user_roles, public.subject_nodes,
  public.approver_assignments, public.questions, public.question_versions,
  public.tags, public.version_tags, public.approvals, public.audit_log,
  public.media_objects, public.version_media
  from anon, authenticated;

grant select on public.schools, public.profiles, public.user_roles, public.subject_nodes,
  public.approver_assignments, public.questions, public.question_versions,
  public.tags, public.version_tags, public.approvals, public.audit_log,
  public.media_objects, public.version_media
  to authenticated;

-- 触发器自动建 profile 属 owner 写，无需额外授权

-- 写函数授权：默认 REVOKE EXECUTE FROM PUBLIC，仅 authenticated 可调用
grant execute on function public.create_question_draft(uuid, text, smallint, jsonb, uuid[]) to authenticated;
grant execute on function public.update_question_draft(uuid, text, smallint, jsonb, uuid[]) to authenticated;
grant execute on function public.submit_question(uuid) to authenticated;
grant execute on function public.review_decide(uuid, boolean, text) to authenticated;
grant execute on function public.transfer_approval(uuid, uuid) to authenticated;
grant execute on function public.retract_question(uuid) to authenticated;
grant execute on function public.delete_question_draft(uuid) to authenticated;
grant execute on function public.request_question_state_change(uuid, boolean) to authenticated;
grant execute on function public.admin_direct_update_question(uuid, text, smallint, jsonb, uuid[]) to authenticated;
grant execute on function public.admin_set_question_state(uuid, boolean) to authenticated;
grant execute on function public.admin_create_school(text, text) to authenticated;
grant execute on function public.admin_set_school_active(uuid, boolean) to authenticated;
grant execute on function public.admin_assign_school_admin(uuid) to authenticated;
grant execute on function public.admin_revoke_school_admin(uuid) to authenticated;
grant execute on function public.admin_set_user_school(uuid, uuid) to authenticated;
grant execute on function public.assign_group_leader(uuid, uuid) to authenticated;
grant execute on function public.assign_city_expert(uuid, uuid) to authenticated;
grant execute on function public.revoke_approver(uuid) to authenticated;
grant execute on function public.admin_create_subject_node(subject_scope, subject_kind, uuid, text, int) to authenticated;
grant execute on function public.admin_rename_node(uuid, text) to authenticated;
grant execute on function public.admin_move_node(uuid, uuid) to authenticated;
grant execute on function public.admin_set_node_frozen(uuid, boolean) to authenticated;
grant execute on function public.admin_delete_node(uuid) to authenticated;
grant execute on function public.admin_rename_tag(uuid, text) to authenticated;
grant execute on function public.admin_merge_tag(uuid, uuid) to authenticated;
grant execute on function public.create_tag(text) to authenticated;
grant execute on function public.register_media(text, text, bigint, text, text) to authenticated;
grant execute on function public.delete_unreferenced_media(uuid[]) to authenticated;
grant execute on function public.admin_gc_media(int) to authenticated;
-- 仅供 UI 判断用的只读助手
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_school_admin(uuid) to authenticated;
grant execute on function public.effective_assignee(uuid, uuid, assignee_role, uuid[]) to authenticated;

-- 收口：所有 public 函数默认收回 PUBLIC 执行权（仅显式授予的角色可调用）
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public', r.sig);
  end loop;
end;
$$;
