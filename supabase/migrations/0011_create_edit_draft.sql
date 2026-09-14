-- 教师对"已入库题"发起修改 = 新建下一个版本的草稿（走完整两级审批；旧版本在审批期间照常使用）。
-- 与 create_question_draft 的区别：不新建 questions 行；version_no = max+1；change_type='edit'；
-- base_version_id 指向当前入库版本；节点沿用题目原节点（不接受客户端传节点）。
-- 触发约束：每问至多一个在流版本（draft/pending_group/pending_city/returned）已由部分唯一索引兜底。

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
