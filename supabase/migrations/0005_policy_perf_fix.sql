-- 0005: 0004 遗漏与策略性能修复
-- 1) version_tags 补开 RLS（0004 收口后唯一未开策略的核心表）
-- 2) 策略顶层 auth.uid()/is_admin() 包成标量子查询 → initplan 只求值一次（100k+ 行场景避免逐行重算）
-- 3) 补 question_versions(created_by, status) 索引：支撑"我的题目/我的提交"高频路径

-- ============ 1) version_tags RLS ============
alter table public.version_tags enable row level security;
drop policy if exists select_any_auth on public.version_tags;
create policy select_any_auth on public.version_tags for select to authenticated using (true);
grant select on public.version_tags to authenticated;

-- ============ 2) 策略 initplan 化 ============
drop policy if exists select_question on public.questions;
create policy select_question on public.questions for select to authenticated using (
  creator_id = (select auth.uid())
  or (select public.is_admin())
  or exists (
    select 1 from profiles p join user_roles r on r.user_id = p.user_id
    where p.user_id = (select auth.uid()) and r.role = 'school_admin' and p.school_id = questions.school_id)
  or exists (select 1 from approvals a where a.question_id = questions.id
             and (a.assigned_user_id = (select auth.uid()) or a.decided_by = (select auth.uid())))
  or (state = 'live' and current_published_version_id is not null)
);

drop policy if exists select_version on public.question_versions;
create policy select_version on public.question_versions for select to authenticated using (
  created_by = (select auth.uid())
  or (select public.is_admin())
  or exists (
    select 1 from questions q
    join profiles p on p.user_id = (select auth.uid())
    join user_roles r on r.user_id = p.user_id and r.role = 'school_admin'
    where q.id = question_versions.question_id and p.school_id = q.school_id)
  or exists (select 1 from approvals a where a.version_id = question_versions.id
             and (a.assigned_user_id = (select auth.uid()) or a.decided_by = (select auth.uid())))
  or (status = 'published'
      and exists (select 1 from questions q
                  where q.id = question_versions.question_id and q.state = 'live'
                    and q.current_published_version_id = question_versions.id))
);

drop policy if exists select_approval on public.approvals;
create policy select_approval on public.approvals for select to authenticated using (
  assigned_user_id = (select auth.uid())
  or decided_by = (select auth.uid())
  or (select public.is_admin())
  or exists (
    select 1 from questions q
    join profiles p on p.user_id = (select auth.uid())
    join user_roles r on r.user_id = p.user_id and r.role = 'school_admin'
    where q.id = approvals.question_id and p.school_id = q.school_id)
  or exists (select 1 from questions q where q.id = approvals.question_id and q.creator_id = (select auth.uid()))
);

drop policy if exists select_audit on public.audit_log;
create policy select_audit on public.audit_log for select to authenticated using (
  user_id = (select auth.uid())
  or (select public.is_admin())
  or exists (
    select 1 from questions q
    join profiles p on p.user_id = (select auth.uid())
    join user_roles r on r.user_id = p.user_id and r.role = 'school_admin'
    where q.id = audit_log.question_id and p.school_id = q.school_id)
);

-- ============ 3) 作者维度索引 ============
create index idx_qversions_creator on public.question_versions (created_by, status);
