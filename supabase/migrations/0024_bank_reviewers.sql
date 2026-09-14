-- 0024: 题库展示"作者/审核人"所需的最小读口径。
-- approvals 的 select 策略只放行任务处理人/决策人/管理员/作者（0009），跨校教师浏览全市题库
-- 看不到审批行 → 列表与详情页无法直接 join 出两级审核通过人。
-- 方案：SECURITY DEFINER 窄读函数，只返回 在库题当前发布版本的 content 通过审批（stage + 决策人），
-- 不暴露意见/时间线/其他环节内容；决策人姓名头像仍由调用方按 profiles 公开列自行装配。
-- 语义限定：question.state='live' 且 version 必须恰为该题 current_published_version_id
-- （下线的旧题、换版前的审批链一律不可见）。

create or replace function public.bank_reviewers(p_version_ids uuid[])
returns table (version_id uuid, stage text, decided_by uuid)
language sql
stable
security definer
set search_path = public
as $$
  select a.version_id, a.stage::text, a.decided_by
  from approvals a
  join questions q on q.id = a.question_id
  where a.version_id = any(p_version_ids)
    and a.kind = 'content'
    and a.state = 'approved'
    and a.decided_by is not null
    and q.state = 'live'
    and q.current_published_version_id = a.version_id
$$;

revoke execute on function public.bank_reviewers(uuid[]) from public, anon;
grant execute on function public.bank_reviewers(uuid[]) to authenticated;
