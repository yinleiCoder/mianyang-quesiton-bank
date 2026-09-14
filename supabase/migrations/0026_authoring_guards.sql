-- 0026: 出题/维护类写函数加教师身份断言 + 内部辅助函数执行权收口。
-- 背景：新增学生身份（0025）后，check_can_author 原仅校验"已绑定学校"，绑校学生将能直接出题/建标签/登记媒体。
--   · 下述函数统一前置 public.is_teacher()（identity='teacher' 或系统管理员）；
--   · 存量教师（0025 已回填 teacher）不受影响，全链行为不变；
--   · 顺带把仅供内部调用的辅助函数从 anon/authenticated 收回执行权：Supabase 默认权限会把新函数
--     EXECUTE 授予 anon/authenticated，0004 的 revoke from public 拦不住；SECURITY DEFINER 函数以
--     属主身份调用这些助手，收回后不受影响。is_question_creator / is_school_admin_of_question 被
--     RLS 策略以内联方式调用（调用者身份求值），必须保留，不在收回之列。

-- =====================================================================
-- 1) 出题/维护类函数：is_teacher 前置断言
-- =====================================================================

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
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
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
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
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

-- 提交（草稿或退回后重提 → 全链重启从组长环节重新审；作者兼任组长时直送市级专家，逻辑同 0014）
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
  v_expert uuid;
  v_skip_group boolean := false;
  v_frozen boolean;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
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

  -- 组长路由：排除作者本人后沿祖先找最深生效任命。
  --  有结果 → 常规组长环节；
  --  无结果且不含排除能解出组长（即唯一候选=作者本人，兼任）→ 跳过组长环节；
  --  完全无任何任命 → 拦截提示。
  v_leader := public.effective_assignee(v_school, v_node, 'group_leader', array[v_uid]);
  if v_leader is null then
    if public.effective_assignee(v_school, v_node, 'group_leader') is not null then
      v_skip_group := true;
    else
      raise exception '该校该课程暂未配置教研组长，请联系学校管理员任命后提交';
    end if;
  end if;

  if v_skip_group then
    update question_versions
    set status = 'pending_city', submitted_at = now()
    where id = p_version_id;

    -- 与 review_decide 组长通过后的流转一致：专家沿祖先最深生效、排除作者本人；
    -- 无可用专家（未任命/唯一专家即本人）→ assigned_user_id NULL，管理员待指派。
    v_expert := public.effective_assignee(v_school, v_node, 'city_expert', array[v_uid]);
    begin
      insert into approvals (kind, version_id, question_id, stage, assigned_user_id)
      values ('content', p_version_id, v_qid, 'city', v_expert);
    exception when unique_violation then
      raise exception '该版本已在审核中，请刷新页面查看';
    end;
    perform public.audit('submit_version', v_qid, p_version_id,
      jsonb_build_object('skip_group', 'self_group_leader', 'city_expert', v_expert));
    return;
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

-- 教师对"已入库题"发起修改 = 新建下一个版本的草稿（走完整两级审批；旧版本在审批期间照常使用）
create or replace function public.create_edit_draft(
  p_question_id uuid, p_qtype text, p_difficulty smallint,
  p_content jsonb, p_tag_ids uuid[] default '{}'::uuid[])
returns uuid  -- 返回 question_versions.id
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_q questions%rowtype;
  v_frozen boolean;
  v_version uuid;
  v_next_no int;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select * into v_q from questions where id = p_question_id;
  if not found then
    raise exception '题目不存在';
  end if;
  if v_q.creator_id <> v_uid then
    raise exception '只有作者本人能为已入库题发起改版';
  end if;
  if v_q.state <> 'live' then
    raise exception '题目当前不在线，无法改版（下线期间请先恢复上线）';
  end if;
  if v_q.current_published_version_id is null then
    raise exception '题目尚未入库，请直接编辑草稿';
  end if;
  if exists (
    select 1 from question_versions v
    where v.question_id = p_question_id and v.status in ('draft','pending_group','pending_city','returned')
  ) then
    raise exception '该题已有在审/未完成的修改版本，请先处理它';
  end if;
  select is_frozen into v_frozen from subject_nodes where id = v_q.course_node_id;
  if v_frozen then
    raise exception '该课程节点已冻结，不能为该题发起新版本';
  end if;

  perform public.validate_question_content(p_qtype, p_content);
  if p_tag_ids is null then p_tag_ids := '{}'::uuid[]; end if;
  perform public.check_tags_exist(p_tag_ids);

  select coalesce(max(version_no), 0) + 1 into v_next_no from question_versions where question_id = p_question_id;
  insert into question_versions
    (question_id, version_no, change_type, base_version_id, status, qtype, difficulty, content,
     search_text, created_by)
  values
    (p_question_id, v_next_no, 'edit', v_q.current_published_version_id, 'draft',
     p_qtype, p_difficulty, p_content, public.question_search_text(p_content), v_uid)
  returning id into v_version;

  perform public.replace_version_tags(v_version, p_tag_ids);
  perform public.sync_version_media(v_version, p_content);
  perform public.audit('create_edit_draft', p_question_id, v_version,
    jsonb_build_object('version_no', v_next_no, 'base', v_q.current_published_version_id));
  return v_version;
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
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
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

-- 登记题目媒体（OSS 直传后调用；头像不经过本函数）
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
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
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
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  foreach m in array p_media_ids loop
    if exists (select 1 from version_media vm where vm.media_object_id = m) then
      raise exception '媒体已被题目引用，不能删除';
    end if;
    delete from media_objects
    where id = m and (uploaded_by = v_uid or public.is_admin());
  end loop;
end;
$$;

-- =====================================================================
-- 2) 内部辅助函数执行权收口（仅属主/定义者函数内部调用）
-- =====================================================================
revoke execute on function public.require_uid() from anon, authenticated;
revoke execute on function public.audit(text, uuid, uuid, jsonb) from anon, authenticated;
revoke execute on function public.write_audit(text, uuid, uuid, jsonb) from anon, authenticated;
revoke execute on function public.check_tags_exist(uuid[]) from anon, authenticated;
revoke execute on function public.replace_version_tags(uuid, uuid[]) from anon, authenticated;
revoke execute on function public.sync_version_media(uuid, jsonb) from anon, authenticated;
revoke execute on function public.validate_question_content(text, jsonb) from anon, authenticated;
revoke execute on function public.v_blocks_text(jsonb) from anon, authenticated;
revoke execute on function public.v_choice(jsonb, jsonb, boolean) from anon, authenticated;
revoke execute on function public.v_simple_question(text, jsonb) from anon, authenticated;
revoke execute on function public.v_blank_count(text) from anon, authenticated;
revoke execute on function public.collect_media_keys(jsonb) from anon, authenticated;
revoke execute on function public.question_search_text(jsonb) from anon, authenticated;
revoke execute on function public.can_attach_question(subject_nodes) from anon, authenticated;
revoke execute on function public.check_can_author(uuid) from anon, authenticated;
