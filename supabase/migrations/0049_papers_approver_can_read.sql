-- 0049: 让审批参与人能读到 papers 主档。
--
-- 症状：组长打开待审试卷的审批详情，页面显示「试卷不存在」。
-- 根因：0044 给 papers 写的 SELECT 策略是
--   作者 / 系统管理员 / 本校学校管理员 / 「已发布且在线」
--   ——**漏了"审批参与人"这一支**，而题目的 select_question(0004) 里是有的：
--   `or exists (select 1 from approvals a where a.question_id = questions.id
--               and (a.assigned_user_id = auth.uid() or a.decided_by = auth.uid()))`
--
-- 后果很隐蔽：paper_versions / paper_sections / paper_items 的策略走 can_read_paper_version，
-- 那里**有**审批参与人分支，所以卷面内容读得到；唯独主档行读不到，页面在取 paper 那一步
-- 就断了（返回 null → 渲染"试卷不存在"），看起来像"这份卷子没了"。
--
-- 与题目链路同样的 RLS 破环铁律：策略里不内联 join，一律走 definer helper。

create or replace function public.is_paper_approver(p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from paper_approvals a
    where a.paper_id = p_paper_id
      and (a.assigned_user_id = (select auth.uid()) or a.decided_by = (select auth.uid()))
  );
$$;

comment on function public.is_paper_approver(uuid) is
  '当前用户是否为该试卷任一版本的审批参与人（处理人或决策人）；供 papers 的 RLS 策略用';

-- 重写 papers 策略，补上审批参与人分支（其余三支与 0044 完全一致）
drop policy if exists select_paper on public.papers;
create policy select_paper on public.papers for select to authenticated using (
  creator_id = (select auth.uid())
  or (select public.is_admin())
  or (select public.is_school_admin_of_paper(papers.id))
  or (select public.is_paper_approver(papers.id))
  or (state = 'live' and current_published_version_id is not null)
);

-- 策略按调用者身份求值，helper 必须授权给 authenticated
revoke execute on function public.is_paper_approver(uuid) from public, anon;
grant execute on function public.is_paper_approver(uuid) to authenticated;
