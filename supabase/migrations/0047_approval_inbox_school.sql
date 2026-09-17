-- 0047: 给统一收件箱视图补一列 school_id。
--
-- 0046 建的 approval_inbox 少了"任务归属哪所学校"这一列，而管理视图（学校管理员只看本校、
-- 系统管理员看全量含待指派）正是按它过滤的。视图里不能内联 join questions/papers：
--   · 用普通 join → 视图带 security_invoker，join 受这两张表的 RLS 约束，
--     能看到审批行却看不到题目行的人会拿到 school_id = NULL，过滤静默失效；
--   · 用 definer 函数 → 绕开 RLS，拿到的就是真实归属。
-- 所以走 helper，与 is_school_admin_of_paper 同一形态。

create or replace function public.approval_target_school(p_question_id uuid, p_paper_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_question_id is not null then (select school_id from questions where id = p_question_id)
    when p_paper_id is not null then (select school_id from papers where id = p_paper_id)
    else null
  end;
$$;

-- 视图定义与 0046 完全一致，只多一列 school_id
create or replace view public.approval_inbox with (security_invoker = on) as
  select a.id, a.kind, a.stage, a.state, a.assigned_user_id, a.decided_by, a.decided_at,
         a.comment, a.created_at,
         a.version_id, a.question_id,
         null::uuid as paper_version_id, null::uuid as paper_id,
         'question'::text as target,
         public.approval_target_school(a.question_id, null) as school_id
  from public.approvals a
  union all
  select p.id, p.kind, p.stage, p.state, p.assigned_user_id, p.decided_by, p.decided_at,
         p.comment, p.created_at,
         null::uuid, null::uuid,
         p.paper_version_id, p.paper_id,
         'paper'::text,
         public.approval_target_school(null, p.paper_id)
  from public.paper_approvals p;

comment on view public.approval_inbox is
  '两类审批任务的统一收件箱（题目 + 试卷）。security_invoker=on，RLS 逐表按调用者身份生效。';

revoke all on public.approval_inbox from anon, authenticated;
grant select on public.approval_inbox to authenticated;

-- helper 只在视图里按调用者身份求值，必须授权给 authenticated
revoke execute on function public.approval_target_school(uuid, uuid) from public, anon;
grant execute on function public.approval_target_school(uuid, uuid) to authenticated;
