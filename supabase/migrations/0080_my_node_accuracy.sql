-- 0080: 学生**自己**的知识点掌握（「我的处境」用）。
--
-- 为什么单开一个小函数，而不是往 practice_dashboard 里加一个键：
-- 那个函数被 0067 用 pg_get_functiondef + 字符串替换的方式补过 forgetting_curve，
-- 整体重写（150 行）的风险高于省一次往返的收益。这个函数 20 行、self-only、
-- 返回一行 jsonb，随时可删可改。
--
-- 粒度与 my_student_detail.node_accuracy **逐字一致**（课程层原始粒度，
-- 由客户端用自己的科目树工具上卷到顶层）——两端口径必须一样，
-- 否则"我的薄弱点"与老师看到的"班级薄弱点"会对不上。
--
-- 口径：只算客观题（grading='auto'）。主观自评题的 is_correct 由学生自己说了算，
-- 混进来会把"掌握度"变成"自我感觉"。日界用 practice_day_start()（北京时间）。

create or replace function public.my_node_accuracy(p_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_days int := least(greatest(coalesce(p_days, 30), 7), 180);
  v_from timestamptz := public.practice_day_start() - make_interval(days => v_days - 1);
begin
  return jsonb_build_object(
    'days', v_days,
    'nodes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'node_id', n.node_id, 'attempts', n.attempts, 'correct', n.correct))
      from (
        select q.course_node_id as node_id,
               count(*) as attempts,
               count(*) filter (where a.is_correct) as correct
        from practice_answers a
        join questions q on q.id = a.question_id
        where a.user_id = v_uid
          and a.grading = 'auto'
          and a.answered_at >= v_from
          and q.course_node_id is not null
        group by q.course_node_id
      ) n), '[]'::jsonb));
end;
$$;

revoke execute on function public.my_node_accuracy(int) from public, anon;
grant execute on function public.my_node_accuracy(int) to authenticated;

notify pgrst, 'reload schema';
