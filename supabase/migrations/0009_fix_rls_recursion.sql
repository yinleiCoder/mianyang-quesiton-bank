-- 修复 42P17 RLS 无限递归：questions 策略引用 approvals，approvals 策略又 join questions → 环。
-- 方案：approvals 策略中的跨表判断（本校管理员/作者）改为 security definer helper（绕过 RLS），
-- 策略表达式不再直接引用 questions，环断开；可读性语义与 0005 完全一致。
-- （auth.uid() 在 policy 内可直接用，helper 内改为 (select auth.uid()) 以保持 sql 稳定性）

create or replace function public.is_school_admin_of_question(p_question_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from questions q
    join profiles p on p.user_id = (select auth.uid())
    join user_roles r on r.user_id = p.user_id and r.role = 'school_admin'
    where q.id = p_question_id and p.school_id = q.school_id
  );
$$;

create or replace function public.is_question_creator(p_question_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from questions q
    where q.id = p_question_id and q.creator_id = (select auth.uid())
  );
$$;

-- 重写 approvals 唯一涉及 questions 的策略
drop policy if exists select_approval on public.approvals;
create policy select_approval on public.approvals for select to authenticated using (
  assigned_user_id = (select auth.uid())
  or decided_by = (select auth.uid())
  or (select public.is_admin())
  or (select public.is_school_admin_of_question(question_id))
  or (select public.is_question_creator(question_id))
);
