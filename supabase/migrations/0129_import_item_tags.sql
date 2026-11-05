-- 0129: 导入预览的逐题标签
--
-- 背景：import_jobs.tag_ids 是**整任务**的标签；AI 逐题推荐标签后，需要按题保存，
-- 入库时才能落到各自的草稿上。这里只加一列 + 两个小 RPC，不动 import_questions_draft
-- （线上解析主链路，为一条辅助功能改它风险不成比例）：
--   1) import_set_item_tags：把建议标签存到 import_job_items.tag_ids；
--   2) set_question_draft_tags：入库后按 version_id 覆盖草稿标签
--      （import_questions_draft 先写整任务标签，随后由客户端逐题覆盖）。
--
-- 两处都只允许任务/草稿的创建者（管理员兜底），且只允许 draft 状态；
-- 标签数上限 20，与 replace_version_tags 的既有上限一致。

alter table public.import_job_items
  add column if not exists tag_ids uuid[] not null default '{}'::uuid[];

comment on column public.import_job_items.tag_ids is
  '逐题知识点标签（AI 推荐/教师采纳）；入库后由 set_question_draft_tags 覆盖到草稿；空数组=沿用任务级标签';

create or replace function public.import_set_item_tags(
  p_item_id uuid,
  p_tag_ids uuid[] default '{}'::uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_item import_job_items%rowtype;
  v_job import_jobs%rowtype;
begin
  select * into v_item from import_job_items where id = p_item_id;
  if not found then
    raise exception '题目不存在';
  end if;
  select * into v_job from import_jobs where id = v_item.job_id;
  if not found then
    raise exception '任务不存在';
  end if;
  if v_job.created_by <> v_uid and not public.is_admin() then
    raise exception '只有任务创建者可以修改标签';
  end if;
  if v_job.status = 'discarded' then
    raise exception '已放弃的任务不能再改标签';
  end if;
  if v_item.status = 'imported' then
    raise exception '这道题已经入库，请到题目编辑器里改标签';
  end if;
  if p_tag_ids is not null and cardinality(p_tag_ids) > 20 then
    raise exception '一题最多 20 个标签';
  end if;
  perform public.check_tags_exist(p_tag_ids);
  update import_job_items
  set tag_ids = coalesce(p_tag_ids, '{}'::uuid[])
  where id = p_item_id;
  perform public.audit('import_set_item_tags', null, null,
    jsonb_build_object('item_id', p_item_id, 'tag_ids', to_jsonb(coalesce(p_tag_ids, '{}'::uuid[]))));
end;
$$;

revoke execute on function public.import_set_item_tags(uuid, uuid[]) from public, anon;
grant execute on function public.import_set_item_tags(uuid, uuid[]) to authenticated;

create or replace function public.set_question_draft_tags(
  p_version_id uuid,
  p_tag_ids uuid[] default '{}'::uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_version question_versions%rowtype;
begin
  select * into v_version from question_versions where id = p_version_id;
  if not found then
    raise exception '草稿不存在';
  end if;
  if v_version.status <> 'draft' then
    raise exception '只能修改草稿的标签';
  end if;
  if v_version.created_by <> v_uid and not public.is_admin() then
    raise exception '只能修改自己的草稿';
  end if;
  if p_tag_ids is not null and cardinality(p_tag_ids) > 20 then
    raise exception '一题最多 20 个标签';
  end if;
  perform public.check_tags_exist(p_tag_ids);
  perform public.replace_version_tags(p_version_id, coalesce(p_tag_ids, '{}'::uuid[]));
  perform public.audit('set_question_draft_tags', v_version.question_id, p_version_id,
    jsonb_build_object('tag_ids', to_jsonb(coalesce(p_tag_ids, '{}'::uuid[]))));
end;
$$;

revoke execute on function public.set_question_draft_tags(uuid, uuid[]) from public, anon;
grant execute on function public.set_question_draft_tags(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';
