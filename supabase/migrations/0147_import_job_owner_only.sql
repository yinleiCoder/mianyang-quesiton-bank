-- 0147: AI 解析任务按教师隔离 —— 读也只看自己的
--
-- 背景（2026-11-06 用户口径）：AI 智能解析题库资料绑定创建它的老师，**不同老师之间
-- 完全隔离**。同校学校管理员与系统管理员也不再能看别人的解析任务。
--
-- 0034 当初把读取放宽成「本人 / 本校学校管理员 / 系统管理员」，但写路径从 0035 起
-- 就只认创建者（认领/回写/入库/放弃逐条校验），读写口径本来就不一致。实际影响：
-- 学校管理员在页面上能看到同校其他老师正在解析的整卷内容、答案区与还没定稿的题目。
-- 解析中的材料往往还没定稿，答案区也可能包含未公开的试卷内容，所以按「谁建的谁看」收口。
--
-- 落点：
--   · is_import_job_owner 改成本人 —— import_job_pages / import_job_items /
--     import_job_sections 三张表的读策略都走它，改函数即一起收口；
--     import_find_similar 的守卫也用它，自动跟着收紧。
--   · import_jobs 自己的 select 策略是内联展开的（没有走函数），必须单独改。
--   · 用 alter policy 而不是 drop + create：线上策略名固定是 select_owner（0034 建的），
--     原地改表达式即可，也避免 MCP 对含 drop 的载荷直接拒绝。
--
-- 管理侧排查问题走数据库控制台（service role），不经应用界面。
-- 写路径不变：本来就只认创建者（0129 的 import_set_item_tags 另有一次 is_admin 兜底，
-- 那是"管理员改标签"的写入便利，不泄露读取；应用界面进不去别人的任务，实际已触发不到）。

create or replace function public.is_import_job_owner(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from import_jobs j
    where j.id = p_job_id
      and j.created_by = auth.uid()
  );
$$;

comment on function public.is_import_job_owner(uuid) is
  '导入任务归属：只有创建它的教师本人。页/题/分节读策略与 import_find_similar 共用';

-- import_jobs 的读策略（0034 内联展开的「本人 / 本校学校管理员 / 系统管理员」）
alter policy select_owner on public.import_jobs to authenticated
  using (created_by = (select auth.uid()));

notify pgrst, 'reload schema';
