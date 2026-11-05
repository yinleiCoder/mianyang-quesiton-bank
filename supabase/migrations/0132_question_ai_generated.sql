-- 0132: AI 生成的草稿打持久化标记
--
-- 变式题由模型生成，草稿入库后审核人需要一眼看出“这是 AI 草稿”。
-- 只允许版本创建者（管理员兜底）在 draft 状态标记；提交后标记仍保留，供审核详情展示。
-- 不改变任何审批规则：AI 草稿仍走两级审批，绝不自动发布。

alter table public.question_versions
  add column if not exists ai_generated boolean not null default false;

comment on column public.question_versions.ai_generated is
  '是否由 AI 生成（变式题等）；仅标记草稿，不改变审批与发布规则';

create or replace function public.mark_question_draft_ai_generated(p_version_id uuid)
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
    raise exception '只能标记草稿';
  end if;
  if v_version.created_by <> v_uid and not public.is_admin() then
    raise exception '只能标记自己的草稿';
  end if;
  update question_versions set ai_generated = true where id = p_version_id;
  perform public.audit('mark_ai_generated', v_version.question_id, p_version_id, '{}'::jsonb);
end;
$$;

revoke execute on function public.mark_question_draft_ai_generated(uuid) from public, anon;
grant execute on function public.mark_question_draft_ai_generated(uuid) to authenticated;

notify pgrst, 'reload schema';
