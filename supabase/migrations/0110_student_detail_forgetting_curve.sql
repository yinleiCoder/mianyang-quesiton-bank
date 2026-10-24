-- 0110: 学生学情详情补「艾宾浩斯遗忘曲线」
--
-- 用户口径（2026-10-24）：网站要能看到学生的遗忘曲线。网页端是教师视角，
-- 唯一的"单个学生学情"入口就是 /students/[id]，所以加在 my_student_detail 的
-- 返回体里（一次 RPC 取全，不另开一次往返）。
--
-- 计算口径与学生端 practice_dashboard 的 forgetting_curve **逐字一致**（0067）：
--   · 把每次作答按「距上次练同一道题的间隔天数」分桶（0/1/2/3/5/7/14/30）；
--   · 每桶的答对率就是学生自己的保持率；
--   · 只统计 is_correct 非空的作答（主观题自评前是 NULL，算进来会被当成答错）。
--
-- 隐私：这里返回的是**聚合后的分桶**（天数/次数/答对数），没有任何作答原文，
-- 与 0063 对 my_student_detail 的隐私口径一致。

create or replace function public.my_student_detail(p_student_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s profiles%rowtype;
  v_sessions jsonb;
  v_wrong jsonb;
  v_nodes jsonb;
  v_exams jsonb;
  v_curve jsonb;
begin
  perform public.require_uid();
  if not public.can_view_student(p_student_id) then
    raise exception '你只能查看本校且专业匹配的学生' using errcode = '42501';
  end if;

  select * into v_s from profiles where user_id = p_student_id;
  if not found then
    raise exception '学生不存在';
  end if;

  -- 练习历史（近 30 次）
  select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc), '[]'::jsonb) into v_sessions
  from (
    select ps.id, ps.source, ps.subject_node_id, ps.total_count, ps.answered_count,
           ps.correct_count, ps.status, ps.started_at, ps.submitted_at, ps.duration_ms
    from practice_sessions ps
    where ps.user_id = p_student_id and ps.status <> 'abandoned'
    order by ps.started_at desc
    limit 30
  ) x;

  -- 错题：最近一次作答为错的题（口径照抄 0029 list_my_wrong_questions，只把 v_uid 换成学生）
  select coalesce(jsonb_agg(to_jsonb(x) order by x.answered_at desc), '[]'::jsonb) into v_wrong
  from (
    select l.question_id,
           coalesce(cv.id, l.version_id) as version_id,
           coalesce(cv.qtype, lv.qtype) as qtype,
           coalesce(cv.difficulty, lv.difficulty) as difficulty,
           l.answered_at,
           (select count(*) from practice_answers a
             where a.user_id = p_student_id and a.question_id = l.question_id
               and a.is_correct is not true) as wrong_count,
           case when cv.id is not null then left(coalesce(cv.search_text, ''), 120) end as stem_text,
           (cv.id is not null) as available
    from (
      select distinct on (a.question_id) a.question_id, a.version_id, a.is_correct, a.answered_at
      from practice_answers a
      where a.user_id = p_student_id
      order by a.question_id, a.answered_at desc
    ) l
    join question_versions lv on lv.id = l.version_id
    left join questions q on q.id = l.question_id
      and q.state = 'live' and q.current_published_version_id is not null
    left join question_versions cv on cv.id = q.current_published_version_id and cv.status = 'published'
    where l.is_correct is not true
    order by l.answered_at desc
    limit 50
  ) x;

  -- 按科目节点的正确率（课程级；上卷到专业/大类交给前端 subtreeIdsOf）
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_nodes
  from (
    select q.course_node_id as node_id,
           count(*) as attempts,
           count(*) filter (where pa.is_correct) as correct
    from practice_answers pa
    join questions q on q.id = pa.question_id
    where pa.user_id = p_student_id and pa.grading = 'auto'
    group by q.course_node_id
  ) x;

  -- 组卷考试：**只出成绩摘要，不出作答内容**（见上方注释）
  select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_key desc), '[]'::jsonb) into v_exams
  from (
    select a.id, pv.title as paper_title, a.status, a.total_score, a.full_score,
           a.objective_score, a.subjective_score, a.submitted_at, a.graded_at,
           a.pending_review_count, a.duration_ms,
           coalesce(a.submitted_at, a.started_at) as sort_key
    from exam_attempts a
    join paper_versions pv on pv.id = a.paper_version_id
    where a.user_id = p_student_id
      and a.status in ('submitted', 'grading', 'graded')
    order by sort_key desc
    limit 30
  ) x;

  -- 遗忘曲线（与 0067 的 practice_dashboard 逐字同口径，只把 v_uid 换成学生）
  select coalesce(jsonb_agg(jsonb_build_object(
           'days', b.bucket_days, 'attempts', b.n, 'correct', b.k) order by b.bucket_days), '[]'::jsonb)
    into v_curve
  from (
    select case
             when p.gap < 1  then 0
             when p.gap < 2  then 1
             when p.gap < 3  then 2
             when p.gap < 5  then 3
             when p.gap < 7  then 5
             when p.gap < 14 then 7
             when p.gap < 30 then 14
             else 30
           end as bucket_days,
           count(*) as n,
           count(*) filter (where p.is_correct) as k
    from (
      select a.is_correct,
             extract(epoch from (a.answered_at
               - lag(a.answered_at) over (partition by a.question_id order by a.answered_at))) / 86400.0 as gap
      from practice_answers a
      where a.user_id = p_student_id and a.is_correct is not null
    ) p
    where p.gap is not null
    group by 1
  ) b;

  return jsonb_build_object(
    'student', jsonb_build_object(
      'user_id', v_s.user_id, 'name', v_s.name, 'email', v_s.email, 'phone', v_s.phone,
      'avatar_url', v_s.avatar_url, 'school_id', v_s.school_id,
      'class_id', v_s.class_id, 'class_name', v_s.class_name,
      'enroll_year', v_s.enroll_year, 'major_category', v_s.major_category,
      'major', v_s.major, 'major_node_id', v_s.major_node_id,
      'created_at', v_s.created_at),
    'sessions', v_sessions,
    'wrong_questions', v_wrong,
    'node_accuracy', v_nodes,
    'exams', v_exams,
    'forgetting_curve', v_curve);
end;
$$;

revoke execute on function public.my_student_detail(uuid) from public, anon;
grant execute on function public.my_student_detail(uuid) to authenticated;

notify pgrst, 'reload schema';
