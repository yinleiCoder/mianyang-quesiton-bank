-- 0113: AI 分析的数据面扩展（成绩分布 / 题型难度 / 学生分层 / 时间 / 主观题样本）
--
-- 用户 2026-10-24 的维度清单：
--   · 成绩分布与关键指标（平均/中位/及格/优秀/最高最低/分数段）；
--   · 题型与难度分析；
--   · 学生分层与重点关注（只给"学生N"编号）；
--   · 时间管理与作答完整度；
--   · 归类：典型错误的归因编码；
--   · 看人：错误类型对应到具体学生群体；
--   · 判层：抽取主观题典型作答，用 SOLO/简化层级判断思维结构瓶颈；
--   · 定策：可操作的课堂改进动作 + 短期可验证的观察指标。
--
-- 原 payload 已有：整体分数概览、逐题正确率/选项/错答编号、本班近 30 天练习。
-- 本次补：
--   questions[].difficulty               每题难度（1/2/3）
--   questions[].samples                  主观题（short_answer）的匿名作答样本
--   questions[].sub_samples              综合题里简答子题的匿名作答样本
--   students[]                           每个"学生N"的得分率/用时/按题型与难度的错题数
--   score.pass_rate / excellent_rate     及格率（≥60%）/ 优秀率（≥80%）
--   score.avg_duration_ms / max_duration_ms
--   score.blank_answers / answer_records 空答数与作答记录数
--
-- 隐私：样本带的是"学生N"编号，不是姓名；这是"看人/判层"必需的，且与 0088
-- 「不把姓名交给模型」的规矩一致。自由文本仍只截断 300 字。
--
-- 指纹：class_ai_report / save_class_ai_report 用 payload 的 md5 比较，payload 变了
-- 旧报告会自动变成 stale（页面提示重新生成），这是本次扩展的预期行为。

create or replace function public._class_ai_data(p_paper_id uuid, p_class_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_paper papers%rowtype;
  v_ver paper_versions%rowtype;
  v_class classes%rowtype;
  v_students int;
  v_summary jsonb;
  v_questions jsonb;
  v_practice jsonb;
  v_student_rows jsonb;
  v_p_from timestamptz;
begin
  select * into v_paper from papers where id = p_paper_id;
  if not found then raise exception '试卷不存在'; end if;
  if v_paper.current_published_version_id is null then
    raise exception '这份试卷还没有入库的版本，没有可分析的成绩';
  end if;
  select * into v_ver from paper_versions where id = v_paper.current_published_version_id;
  select * into v_class from classes where id = p_class_id;
  if not found then raise exception '班级不存在'; end if;

  select count(*)::int into v_students
  from profiles p where p.class_id = p_class_id and public.can_view_student(p.user_id);

  -- 本班最近 30 天的练习（最弱的 8 个知识点）：教师没填复习进度时的推断依据。
  v_p_from := ((public.practice_day_start())::date - 29)::timestamp at time zone 'Asia/Shanghai';
  select coalesce(jsonb_agg(jsonb_build_object(
           'node', t.node_name, 'attempts', t.attempts,
           'correct', t.correct, 'accuracy', t.accuracy)
         order by t.accuracy asc, t.attempts desc), '[]'::jsonb)
    into v_practice
    from (
      select n.name as node_name, count(*) as attempts,
             count(*) filter (where a.is_correct) as correct,
             round((count(*) filter (where a.is_correct))::numeric / count(*), 4) as accuracy
      from practice_answers a
      join profiles p on p.user_id = a.user_id
      join questions q on q.id = a.question_id
      join subject_nodes n on n.id = q.course_node_id
      where p.class_id = p_class_id and public.can_view_student(a.user_id)
        and a.grading = 'auto' and a.answered_at >= v_p_from
      group by n.name
      having count(*) >= 3
      order by accuracy asc, count(*) desc
      limit 8
    ) t;

  with att as (
    select a.id as attempt_id, a.user_id, p.name as sname, a.status,
           a.total_score, a.full_score, a.duration_ms,
           coalesce(a.submitted_at, a.started_at) as at,
           row_number() over (order by p.name, a.user_id) as sno
    from exam_attempts a
    join profiles p on p.user_id = a.user_id
    where a.paper_id = p_paper_id
      and a.paper_version_id = v_ver.id
      and p.class_id = p_class_id
      and public.can_view_student(p.user_id)
      and a.is_official
      and a.status in ('submitted', 'grading', 'graded')
  ),
  graded as (select * from att where status = 'graded'),
  -- "学生N"：按姓名序编号，稳定、且不把姓名交给模型
  per as (
    select g.*, '学生' || g.sno as label,
           round(g.total_score / nullif(g.full_score, 0), 4) as percent
    from graded g
  ),
  ans as (
    select aa.paper_item_id, aa.answer, aa.is_correct, aa.grading, pe.label
    from exam_answers aa join per pe on pe.attempt_id = aa.attempt_id
  ),
  -- 综合题简答子题的作答样本（带编号，用于 SOLO/思维层级判断）
  sub_samples as (
    select i.id as item_id,
           (s.ord - 1)::int as sub_index,
           a.label,
           left(btrim(coalesce(a.answer -> 'subs' -> (s.ord - 1)::int ->> 'text', '')), 300) as text
    from ans a
    join paper_items i on i.id = a.paper_item_id
    join question_versions qv on qv.id = i.question_version_id
    cross join lateral jsonb_array_elements(coalesce(qv.content -> 'sub', '[]'::jsonb))
      with ordinality as s(elem, ord)
    where i.qtype = 'composite'
      and s.elem ->> 'type' = 'short_answer'
      and btrim(coalesce(a.answer -> 'subs' -> (s.ord - 1)::int ->> 'text', '')) <> ''
  ),
  agg as (
    select i.id as item_id, i.seq, i.qtype, i.score, i.difficulty,
           coalesce(cv.search_text, '') as stem,
           n.name as node_name,
           count(a.paper_item_id) as total,
           count(a.paper_item_id) filter (where a.grading <> 'pending') as graded_cnt,
           count(a.paper_item_id) filter (where a.is_correct) as correct_cnt,
           count(a.paper_item_id) filter (where a.answer = '{}'::jsonb) as blank_cnt,
           count(a.paper_item_id) filter (where a.grading = 'pending') as pending_cnt,
           -- 主观题样本：顶层 short_answer 最多 8 份
           case when i.qtype = 'short_answer' then (
             select jsonb_agg(jsonb_build_object('student', s.label, 'text', s.text)
                              order by s.label)
             from (
               select a2.label,
                      left(btrim(coalesce(a2.answer ->> 'text', '')), 300) as text
               from ans a2
               where a2.paper_item_id = i.id
                 and btrim(coalesce(a2.answer ->> 'text', '')) <> ''
               order by a2.label
               limit 8
             ) s
           ) else '[]'::jsonb end as samples,
           -- 综合题里的简答子题样本：最多 8 份（按子题序、编号）
           case when i.qtype = 'composite' then (
             select jsonb_agg(jsonb_build_object(
                      'sub_index', s.sub_index + 1,
                      'student', s.label, 'text', s.text) order by s.sub_index, s.label)
             from (
               select ss.sub_index, ss.label, ss.text
               from sub_samples ss
               where ss.item_id = i.id
               order by ss.sub_index, ss.label
               limit 8
             ) s
           ) else '[]'::jsonb end as sub_samples
    from paper_items i
    left join question_versions cv on cv.id = i.question_version_id
    left join questions q on q.id = cv.question_id
    left join subject_nodes n on n.id = q.course_node_id
    left join ans a on a.paper_item_id = i.id
    where i.paper_version_id = v_ver.id
    group by i.id, i.seq, i.qtype, i.score, i.difficulty,
             coalesce(cv.search_text, ''), n.name
  ),
  picks as (
    select a.paper_item_id, x.opt_key, a.label
    from ans a
    cross join lateral (
      select jsonb_array_elements_text(a.answer -> 'keys') as opt_key
      union all
      select (a.answer ->> 'value')::boolean::text where a.answer ? 'value'
    ) x
    where x.opt_key is not null
  ),
  opt_rows as (
    select paper_item_id, opt_key, count(*) as cnt,
           jsonb_agg(label order by label) as labels
    from picks group by paper_item_id, opt_key
  ),
  fill_rows as (
    select f.paper_item_id,
           jsonb_agg(jsonb_build_object('text', f.sample, 'count', f.cnt)
                     order by f.cnt desc, f.sample) as rows
    from (
      select a.paper_item_id, public.exam_norm_text(t.val) as norm,
             min(t.val) as sample, count(*) as cnt
      from ans a
      cross join lateral jsonb_array_elements_text(
        coalesce(a.answer -> 'values', '[]'::jsonb)) as t(val)
      where public.exam_norm_text(t.val) <> ''
      group by a.paper_item_id, public.exam_norm_text(t.val)
    ) f
    group by f.paper_item_id
  ),
  wrong_rows as (
    select paper_item_id, jsonb_agg(label order by label) as labels
    from ans a where a.is_correct is false group by a.paper_item_id
  ),
  -- 每个学生按题型 / 难度的错题数：支撑"看人"——哪些学生总在同一类题上错
  student_qtype as (
    select a.label, ag.qtype,
           count(*) as total,
           count(*) filter (where a.is_correct is false) as wrong
    from ans a
    join agg ag on ag.item_id = a.paper_item_id
    group by a.label, ag.qtype
  ),
  student_diff as (
    select a.label, ag.difficulty,
           count(*) as total,
           count(*) filter (where a.is_correct is false) as wrong
    from ans a
    join agg ag on ag.item_id = a.paper_item_id
    group by a.label, ag.difficulty
  ),
  student_json as (
    select pe.label, pe.percent, pe.duration_ms,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'qtype', q.qtype, 'wrong', q.wrong, 'total', q.total)
                    order by q.wrong desc, q.qtype)
             from student_qtype q where q.label = pe.label
           ), '[]'::jsonb) as wrong_by_qtype,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'difficulty', d.difficulty, 'wrong', d.wrong, 'total', d.total)
                    order by d.wrong desc, d.difficulty)
             from student_diff d where d.label = pe.label
           ), '[]'::jsonb) as wrong_by_difficulty
    from per pe
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
             'seq', g.seq, 'qtype', g.qtype, 'score', g.score,
             'difficulty', g.difficulty,
             'node', g.node_name,
             'stem', left(regexp_replace(g.stem, '\s+', ' ', 'g'), 200),
             'graded', g.graded_cnt, 'correct', g.correct_cnt,
             'correct_rate', case when g.graded_cnt > 0
                                  then round(g.correct_cnt::numeric / g.graded_cnt, 4) else null end,
             'blank', g.blank_cnt, 'pending', g.pending_cnt,
             'options', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'key', d.opt_key, 'is_answer', d.is_answer,
                        'count', coalesce(o.cnt, 0),
                        'students', coalesce((select jsonb_agg(s) from (
                          select jsonb_array_elements(o.labels) as s limit 10) t), '[]'::jsonb))
                      order by d.opt_key)
               from (
                 select elem ->> 'key' as opt_key,
                        coalesce((qv.content -> 'answer' -> 'keys') ? (elem ->> 'key'), false) as is_answer
                 from jsonb_array_elements(coalesce(qv.content -> 'options', '[]'::jsonb)) as o(elem)
                 union all
                 select v.key, coalesce((qv.content -> 'answer' ->> 'value')::boolean::text = v.key, false)
                 from (values ('true'), ('false')) v(key)
                 where g.qtype = 'true_false'
               ) d
               left join opt_rows o on o.paper_item_id = g.item_id and o.opt_key = d.opt_key
             ), '[]'::jsonb),
             'fill_texts', coalesce((select f.rows from fill_rows f where f.paper_item_id = g.item_id), '[]'::jsonb),
             'samples', g.samples,
             'sub_samples', g.sub_samples,
             'wrong', coalesce((select jsonb_agg(s) from (
               select jsonb_array_elements(w.labels) as s
               from wrong_rows w where w.paper_item_id = g.item_id
               limit 10) t), '[]'::jsonb))
           order by g.seq)
         from agg g
         join paper_items pi on pi.id = g.item_id
         join question_versions qv on qv.id = pi.question_version_id), '[]'::jsonb) as questions,
    (select jsonb_build_object(
             'participants', count(*) filter (where status = 'graded'),
             'ungraded', count(*) filter (where status in ('submitted', 'grading')),
             'avg_percent', round(avg(percent) filter (where status = 'graded'), 4),
             'max_percent', max(percent) filter (where status = 'graded'),
             'min_percent', min(percent) filter (where status = 'graded'),
             'median_percent', round((percentile_cont(0.5) within group (order by percent)
                                      filter (where status = 'graded'))::numeric, 4),
             'pass_rate', round((count(*) filter (where status = 'graded' and percent >= 0.6))::numeric
                                / nullif(count(*) filter (where status = 'graded'), 0), 4),
             'excellent_rate', round((count(*) filter (where status = 'graded' and percent >= 0.8))::numeric
                                     / nullif(count(*) filter (where status = 'graded'), 0), 4),
             'avg_duration_ms', round(avg(duration_ms) filter (where status = 'graded')),
             'max_duration_ms', max(duration_ms) filter (where status = 'graded'),
             'blank_answers', (select count(*) from ans a where a.answer = '{}'::jsonb),
             'answer_records', (select count(*) from ans),
             'distribution', jsonb_build_array(
               jsonb_build_object('key', 'lt60', 'label', '60% 以下',
                                  'count', count(*) filter (where status = 'graded' and percent < 0.6)),
               jsonb_build_object('key', 'p60', 'label', '60~69%',
                                  'count', count(*) filter (where status = 'graded' and percent >= 0.6 and percent < 0.7)),
               jsonb_build_object('key', 'p70', 'label', '70~79%',
                                  'count', count(*) filter (where status = 'graded' and percent >= 0.7 and percent < 0.8)),
               jsonb_build_object('key', 'p80', 'label', '80~89%',
                                  'count', count(*) filter (where status = 'graded' and percent >= 0.8 and percent < 0.9)),
               jsonb_build_object('key', 'p90', 'label', '90% 以上',
                                  'count', count(*) filter (where status = 'graded' and percent >= 0.9))))
       from per) as summary,
    coalesce((select jsonb_agg(jsonb_build_object(
             'label', s.label, 'percent', s.percent, 'duration_ms', s.duration_ms,
             'wrong_by_qtype', s.wrong_by_qtype,
             'wrong_by_difficulty', s.wrong_by_difficulty)
           order by s.label) from student_json s), '[]'::jsonb) as students
  into v_questions, v_summary, v_student_rows;

  return jsonb_build_object(
    'paper', jsonb_build_object(
      'id', v_paper.id, 'version_id', v_ver.id, 'version_no', v_ver.version_no,
      'title', v_ver.title, 'exam_name', v_ver.exam_name, 'subject_label', v_ver.subject_label,
      'full_score', v_ver.total_score),
    'class', jsonb_build_object(
      'id', v_class.id, 'name', v_class.name, 'student_count', v_students),
    'summary', v_summary,
    'payload', jsonb_build_object(
      'paper', jsonb_build_object(
        'title', v_ver.title, 'exam_name', v_ver.exam_name,
        'subject_label', v_ver.subject_label, 'full_score', v_ver.total_score,
        'question_count', jsonb_array_length(v_questions)),
      'class', jsonb_build_object(
        'student_count', v_students,
        'participants', v_summary -> 'participants',
        'ungraded', v_summary -> 'ungraded'),
      'score', v_summary,
      'students', v_student_rows,
      'practice', jsonb_build_object('days', 30, 'weak_nodes', v_practice),
      'questions', v_questions));
end;
$$;

revoke execute on function public._class_ai_data(uuid, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
