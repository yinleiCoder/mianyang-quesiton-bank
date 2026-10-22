-- 0101: 撤回题目 = 回到草稿；历史上"已撤回"的版本给一条恢复路径
--
-- 症状（2026-10-21 用户报）：在「我的题目」里撤回一道待审的题，整行只剩「已撤回」
-- 徽标——编辑、重新提交、删除全都不出现，也没有任何恢复入口。原因是：
--   · retract_question 把版本置为 retracted（终态）；
--   · 工作台的行内动作只认 draft / returned / 在审；
--   · 防篡改守卫又禁止再改 retracted 行。
-- 而撤回确认框写的却是"撤回后题目回到草稿态，可修改后重新提交"——实现与文案不一致。
--
-- 两处一起改：
--   1. retract_question：pending_group / pending_city → **draft**（与文案一致，
--      撤回后立刻能看到「编辑 / 提交审核」）；
--   2. 新增 restore_retracted_question：把历史上（或管理员直编时）置为 retracted
--      的**最新**版本恢复成 draft。守卫用事务级开关放行这一条受限迁移，
--      写法与 0012 放行 published → superseded 相同。

-- 防篡改守卫：在原有 supersede 口子之外，再加一条 retracted → draft（仅供恢复函数使用）。
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
    -- 撤回恢复：只允许 retracted → draft，且除 status 外所有字段原样。
    -- 开关由 restore_retracted_question 在事务内临时打开，杜绝旁路。
    if tg_op = 'UPDATE'
       and old.status = 'retracted' and new.status = 'draft'
       and current_setting('app.allow_unretract', true) = 'on'
       and (to_jsonb(new) - 'status') is not distinct from (to_jsonb(old) - 'status') then
      return new;
    end if;
    raise exception '该状态的版本不可直接修改';
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception '只能删除纯草稿版本';
    end if;
    return old;
  end if;
  return new;
end;
$$;

-- 教师撤回自己的待审提交 → 回到草稿（可修改后重新提交；再次提交全链重审）
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
  update question_versions set status = 'draft' where id = p_version_id;
  -- 只取消该版本自身的等待任务；独立的上下线事件不受影响
  update approvals set state = 'cancelled'
  where state = 'waiting' and version_id = p_version_id;
  perform public.audit('retract_version', v_qid, p_version_id);
end;
$$;

-- 恢复历史上"已撤回"的版本：retracted → draft。
-- 只允许恢复**当前最新**的撤回版本：它后面已有新版本时，恢复旧版会与版本号/审批口径打架。
create or replace function public.restore_retracted_question(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_qid uuid;
  v_no int;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select question_id, version_no into v_qid, v_no
  from question_versions
  where id = p_version_id and created_by = v_uid and status = 'retracted';
  if not found then
    raise exception '只能恢复自己撤回的版本';
  end if;

  if exists (
    select 1 from question_versions v
    where v.question_id = v_qid and v.version_no > v_no
  ) then
    raise exception '该题已有更新的版本，不能恢复这个旧版本';
  end if;

  -- 与 uq_questions_one_inflight 对齐：每题同时只能有一个在流版本
  if exists (
    select 1 from question_versions v
    where v.question_id = v_qid
      and v.status in ('draft', 'pending_group', 'pending_city', 'returned')
  ) then
    raise exception '该题已有未完成的版本，请先处理它';
  end if;

  perform set_config('app.allow_unretract', 'on', true);
  update question_versions set status = 'draft'
  where id = p_version_id and status = 'retracted';
  if not found then
    raise exception '该版本已不是撤回状态，请刷新后重试';
  end if;
  perform set_config('app.allow_unretract', 'off', true);

  perform public.audit('restore_version', v_qid, p_version_id);
end;
$$;

revoke execute on function public.restore_retracted_question(uuid) from public, anon;
grant execute on function public.restore_retracted_question(uuid) to authenticated;

notify pgrst, 'reload schema';
