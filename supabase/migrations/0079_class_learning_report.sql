-- 0079: 班级学情看板（教师）。回答"这个班哪里弱、谁掉队了"。
--
-- 背景：教师端在此之前只有逐题阅卷与「我的学生」名册，**没有任何班级维度的学情**
-- （用户 2026-09-24："教师对学生及班级的学习情况一无所知"）。
--
-- 数据来源是**练习**而不是考试：线上 13,767 条练习作答 / 118 人，而考试才 10 场——
-- 学情的真实载体是练习。考试那一侧由 0077/0078 的榜与分析负责。
--
-- 三条口径（与既有页面保持一致，别在这里另立一套）：
--   · **正确率的分母是"已判分的客观题"**（`grading='auto'`），与 list_my_students 的
--     graded_count、question_accuracy 同口径；主观自评题不计入（is_correct 恒为 null）；
--   · **日界用 practice_day_start()（北京时间）**，不用 date_trunc('day', now()) ——
--     库时区是 UTC，"今天"从北京时间早上 8 点起算，早自习练的题会被算成昨天（0069 踩过）；
--   · 学生名单**逐行过 can_view_student**：班级成员与"我能看的学生"理论上可能不一致
--     （学生转过专业），以名册页为准——宁可少报，也不多露一个名字。
--
-- 权限：can_view_class（系统管理员 / 本校管理员 / 本校本专业的教师）。该函数已
-- revoke from authenticated，只能在 definer 内部调用（与 my_student_detail 同款）。

create or replace function public.class_learning_report(
  p_class_id uuid,
  p_days int default 30,
  p_top_questions int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_class classes%rowtype;
  v_days int := least(greatest(coalesce(p_days, 30), 7), 180);
  v_top int := least(greatest(coalesce(p_top_questions, 20), 5), 50);
  v_to date;
  v_from date;
  v_from_ts timestamptz;
  v_participation jsonb;
  v_trend jsonb;
  v_nodes jsonb;
  v_questions jsonb;
  v_alerts jsonb;
begin
  if not public.can_view_class(p_class_id) then
    raise exception '你不能查看这个班级的学情' using errcode = '42501';
  end if;
  select * into v_class from classes where id = p_class_id;
  if not found then raise exception '班级不存在'; end if;

  -- 日界：v_to = 今天（北京），v_from = 窗口首日。v_from_ts 用来卡 answered_at
  v_to := (public.practice_day_start())::date;
  v_from := v_to - (v_days - 1);
  v_from_ts := (v_from::timestamp at time zone 'Asia/Shanghai');

  -- 参与度
  select jsonb_build_object(
           'student_count', (select count(*) from profiles p
                             where p.class_id = p_class_id and public.can_view_student(p.user_id)),
           'active_count', count(distinct a.user_id),
           'answered_count', count(*),
           'correct_count', count(*) filter (where a.is_correct),
           'practiced_days', count(distinct (a.answered_at at time zone 'Asia/Shanghai')::date),
           'last_active_at', max(a.answered_at))
    into v_participation
    from practice_answers a
    join profiles p on p.user_id = a.user_id
    where p.class_id = p_class_id and public.can_view_student(p.user_id)
      and a.grading = 'auto' and a.answered_at >= v_from_ts;

  -- 逐日趋势（没有作答的日子补零——图表直接用，不要再在客户端补）
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', d.day::text,
           'answered', coalesce(t.answered, 0),
           'correct', coalesce(t.correct, 0),
           'active_students', coalesce(t.active_students, 0),
           -- 没人作答的那天正确率是 null，不是 0（0 次 ≠ 全错，与 lib/accuracy.js 同规矩）
           'accuracy', case when coalesce(t.answered, 0) > 0
                            then round(t.correct::numeric / t.answered, 4) else null end
         ) order by d.day), '[]'::jsonb)
    into v_trend
    from generate_series(v_from, v_to, interval '1 day') as d(day)
    left join (
      select (a.answered_at at time zone 'Asia/Shanghai')::date as day,
             count(*) as answered,
             count(*) filter (where a.is_correct) as correct,
             count(distinct a.user_id) as active_students
      from practice_answers a
      join profiles p on p.user_id = a.user_id
      where p.class_id = p_class_id and public.can_view_student(p.user_id)
        and a.grading = 'auto' and a.answered_at >= v_from_ts
      group by 1
    ) t on t.day = d.day::date;

  -- 知识点掌握：**课程层原始粒度**，升降到"专业/大类"由客户端用科目树做
  -- （students/student-detail.jsx 的 rollUpByTopNode 已有现成逻辑，客户端各有一套树工具）。
  -- 在 SQL 里上卷等于把展示口径写进库里，两端任何一边改层数就对不上。
  select coalesce(jsonb_agg(jsonb_build_object(
           'node_id', n.node_id, 'attempts', n.attempts, 'correct', n.correct)), '[]'::jsonb)
    into v_nodes
    from (
      select q.course_node_id as node_id, count(*) as attempts,
             count(*) filter (where a.is_correct) as correct
      from practice_answers a
      join profiles p on p.user_id = a.user_id
      join questions q on q.id = a.question_id
      where p.class_id = p_class_id and public.can_view_student(p.user_id)
        and a.grading = 'auto' and a.answered_at >= v_from_ts
        and q.course_node_id is not null
      group by q.course_node_id
      having count(*) >= 3
    ) n;

  -- 全班的高危题：错误率 ≥ 60%（与 lib/accuracy.js 的 HIGH_ERROR_RATE 同一条线）。
  -- 这里**不复用 question_accuracy**：那个是全平台口径、按 question 粒度、只吃 200 个 id 的数组，
  -- 无法按班/按时间窗过滤，硬套只会把两个口径搅在一起。
  select coalesce(jsonb_agg(jsonb_build_object(
           'question_id', t.question_id, 'qtype', t.qtype, 'difficulty', t.difficulty,
           'node_id', t.node_id, 'stem_text', t.stem_text, 'available', t.available,
           'attempts', t.attempts, 'correct', t.correct,
           'error_rate', round((t.attempts - t.correct)::numeric / t.attempts, 4))
         order by (t.attempts - t.correct)::numeric / t.attempts desc, t.attempts desc), '[]'::jsonb)
    into v_questions
    from (
      select a.question_id,
             -- qtype/difficulty 在 question_versions 上（questions 表只有状态与挂点）。
             -- 取法与 my_student_detail 一致：当前入库版优先，回退到学生作答时钉住的那一版。
             coalesce(cv.qtype, lv.qtype) as qtype,
             coalesce(cv.difficulty, lv.difficulty) as difficulty,
             q.course_node_id as node_id,
             (cv.id is not null) as available,
             case when cv.id is not null then left(coalesce(cv.search_text, ''), 100) end as stem_text,
             count(*) as attempts,
             count(*) filter (where a.is_correct) as correct
      from practice_answers a
      join profiles p on p.user_id = a.user_id
      join questions q on q.id = a.question_id
      join question_versions lv on lv.id = a.version_id
      left join question_versions cv on cv.id = q.current_published_version_id
        and cv.status = 'published' and q.state = 'live'
      where p.class_id = p_class_id and public.can_view_student(p.user_id)
        and a.grading = 'auto' and a.answered_at >= v_from_ts
      group by a.question_id, coalesce(cv.qtype, lv.qtype), coalesce(cv.difficulty, lv.difficulty),
               q.course_node_id, (cv.id is not null),
               case when cv.id is not null then left(coalesce(cv.search_text, ''), 100) end
      having count(*) >= 5 and (count(*) - count(*) filter (where a.is_correct))::numeric / count(*) >= 0.6
      order by (count(*) - count(*) filter (where a.is_correct))::numeric / count(*) desc, count(*) desc
      limit v_top
    ) t;

  -- 预警：久未练习 + 正确率下滑。
  -- 阈值随返回值一起下发，页面写文案时用这里的数字，别在前端另写一套。
  select jsonb_build_object(
    'thresholds', jsonb_build_object('inactive_days', 7, 'drop_gap', 0.15, 'drop_min_sample', 10),
    'inactive', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', s.user_id, 'name', s.name,
               'last_practiced_at', s.last_at,
               'days_idle', case when s.last_at is null then null
                                 else (v_to - (s.last_at at time zone 'Asia/Shanghai')::date) end)
             order by s.last_at nulls first)
      from (
        select p.user_id, p.name, max(a.answered_at) as last_at
        from profiles p
        left join practice_answers a on a.user_id = p.user_id and a.grading = 'auto'
        where p.class_id = p_class_id and public.can_view_student(p.user_id)
        group by p.user_id, p.name
        having max(a.answered_at) is null
            or max(a.answered_at) < now() - interval '7 days'
      ) s), '[]'::jsonb),
    'accuracy_drop', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', d.user_id, 'name', d.name,
               'recent_accuracy', round(d.recent_correct::numeric / d.recent_answered, 4),
               'prev_accuracy', round(d.prev_correct::numeric / d.prev_answered, 4),
               'delta', round((d.recent_correct::numeric / d.recent_answered)
                              - (d.prev_correct::numeric / d.prev_answered), 4))
             order by (d.recent_correct::numeric / d.recent_answered)
                      - (d.prev_correct::numeric / d.prev_answered))
      from (
        select p.user_id, p.name,
               count(*) filter (where a.answered_at >= now() - interval '7 days') as recent_answered,
               count(*) filter (where a.answered_at >= now() - interval '7 days' and a.is_correct) as recent_correct,
               count(*) filter (where a.answered_at >= now() - interval '14 days'
                                  and a.answered_at < now() - interval '7 days') as prev_answered,
               count(*) filter (where a.answered_at >= now() - interval '14 days'
                                  and a.answered_at < now() - interval '7 days' and a.is_correct) as prev_correct
        from profiles p
        join practice_answers a on a.user_id = p.user_id and a.grading = 'auto'
        where p.class_id = p_class_id and public.can_view_student(p.user_id)
          and a.answered_at >= now() - interval '14 days'
        group by p.user_id, p.name
      ) d
      -- **样本量下限不能省**：两次作答错一次就是"下降 50%"，会把预警面板变成狼来了
      where d.recent_answered >= 10 and d.prev_answered >= 10
        and (d.recent_correct::numeric / d.recent_answered)
            <= (d.prev_correct::numeric / d.prev_answered) - 0.15
    ), '[]'::jsonb)
  ) into v_alerts;

  return jsonb_build_object(
    'class', jsonb_build_object(
      'id', v_class.id, 'name', v_class.name, 'school_id', v_class.school_id,
      'school_name', (select name from schools where id = v_class.school_id),
      'major_node_id', v_class.major_node_id, 'enroll_year', v_class.enroll_year,
      'is_active', v_class.is_active),
    'window', jsonb_build_object('days', v_days, 'from', v_from::text, 'to', v_to::text,
                                 'day_boundary', 'Asia/Shanghai'),
    'participation', v_participation,
    'trend', v_trend,
    'node_accuracy', v_nodes,
    'high_error_questions', v_questions,
    'alerts', v_alerts);
end;
$$;

revoke execute on function public.class_learning_report(uuid, int, int) from public, anon;
grant execute on function public.class_learning_report(uuid, int, int) to authenticated;

notify pgrst, 'reload schema';
