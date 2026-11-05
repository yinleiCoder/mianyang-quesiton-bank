-- 0140: 阅卷队列（侧栏「阅卷」的落地页数据）
--
-- 背景（2026-11-05）：阅卷入口只挂在「试卷详情 → 阅卷」按钮上，教师得先知道
-- 是哪份卷子才找得到；学生一交卷，没有任何地方汇总"还有几场没批"。
--
-- 这里给一个跨试卷的待阅卷汇总：只返回调用者**有权阅卷**的卷子
-- （is_paper_grader：试卷作者 / 本校管理员 / 系统管理员，与阅卷台的断言同源）。
-- 不返回学生姓名、不返回分数，只是"哪份卷子还有几场没批"。
--
-- 计数口径：status in ('submitted','grading') 的场次。
--   · submitted = 已交卷、主观题还没判；
--   · grading   = 已经批了一部分（grade_exam_answer 会把整场置为 grading）。
-- 每人每卷只算**官方成绩**那一场没有意义 —— 阅卷台按场次列出，这里也按场次数。

create or replace function public.list_my_grading_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'paper_id', g.paper_id,
             'title', g.title,
             'version_no', g.version_no,
             'pending_attempts', g.pending_attempts,
             'in_grading', g.in_grading,
             'last_submitted_at', g.last_submitted_at)
           order by g.last_submitted_at desc nulls last)
    from (
      select p.id as paper_id,
             -- 卷名取当前入库版；改版中的草稿没有参考价值。
             -- 兜底用这次待阅场次所在版本（万一当前版被下线）。
             coalesce(cv.title, max(av.title)) as title,
             coalesce(cv.version_no, max(av.version_no)) as version_no,
             count(*)::int as pending_attempts,
             count(*) filter (where a.status = 'grading')::int as in_grading,
             max(a.submitted_at) as last_submitted_at
      from exam_attempts a
      join papers p on p.id = a.paper_id
      join paper_versions av on av.id = a.paper_version_id
      left join paper_versions cv on cv.id = p.current_published_version_id
      where a.status in ('submitted', 'grading')
        and public.is_paper_grader(p.id)
      group by p.id, cv.title, cv.version_no
    ) g
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.list_my_grading_queue() from public, anon;
grant execute on function public.list_my_grading_queue() to authenticated;
