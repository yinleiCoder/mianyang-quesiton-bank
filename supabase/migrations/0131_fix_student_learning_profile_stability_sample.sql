-- 0131: 修正学习画像稳定性的 caveat 与 sample
--
-- 0130 已修好 caveats 数组拼接；本次只改两处口径（2026-11-03 验库实测）：
--   · “稳定性样本不足 5 个活跃日”原先误判 28 天活跃天数 v_active_days，
--     稳定性实际用的是 90 天活跃天数 v_stability_days；
--   · stability 轴的 sample 原先回作答次数，改为活跃天数（与该轴的 5 天门槛一致）。
-- 已执行过 0128/0130 的库只需跑这一条；其余逻辑与 0130 完全一致。
--
-- 原 0128 说明：一次 RPC 取全：掌握力 / 准确率 / 勤奋度 / 进步力 / 知识面 / 稳定性。
-- 口径：
--   · 练习作答只取 grading='auto' 且 is_correct is not null；
--   · 掌握力复用 0122 的 _my_bkt_items（BKT，365 天窗口，权重 1+least(attempts,3)）；
--   · 其余轴默认 90 天；勤奋度 28 天、进步力 14+14 天；
--   · 日界按北京时间（practice_day_start 同口径）。
--
-- 权限：自己看自己；教师看学生走 can_view_student（本校 + 专业子树）。
-- 返回体只含聚合分数与计数，不含作答原文/姓名以外的个人信息。
--
-- persona/summary 不在 SQL 里算：Web 用 lib/profile-persona.js、Flutter 用
-- utils/profile_persona.dart，两端测试互为清单；RPC 只回 axes/raw/caveats。

create or replace function public.student_learning_profile(
  p_student_id uuid default null,
  p_days int default 90)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_target uuid := coalesce(p_student_id, v_uid);
  v_days int := greatest(30, least(coalesce(p_days, 90), 365));
  v_profile profiles%rowtype;
  v_major_name text;
  v_attempts int := 0;
  v_correct int := 0;
  v_active_days int := 0;
  v_recent_attempts int := 0;
  v_recent_correct int := 0;
  v_prev_attempts int := 0;
  v_prev_correct int := 0;
  v_distinct_nodes int := 0;
  v_stability_sd numeric;
  v_stability_days int := 0;
  v_bkt_weighted numeric;
  v_bkt_weight numeric;
  v_bkt_attempts int := 0;
  v_mastery numeric;
  v_accuracy numeric;
  v_effort numeric;
  v_growth numeric;
  v_breadth numeric;
  v_stability numeric;
  v_mastery_score int;
  v_accuracy_score int;
  v_effort_score int;
  v_growth_score int;
  v_breadth_score int;
  v_stability_score int;
  v_caveats text[];
begin
  if v_target <> v_uid and not public.can_view_student(v_target) then
    raise exception '你只能查看本校且专业匹配的学生' using errcode = '42501';
  end if;

  select * into v_profile from profiles where user_id = v_target;
  if not found then
    raise exception '学生不存在';
  end if;
  select name into v_major_name from subject_nodes where id = v_profile.major_node_id;

  -- 1) 总作答 / 正确（90 天，客观题）
  select count(*)::int,
         count(*) filter (where is_correct)::int
    into v_attempts, v_correct
  from practice_answers
  where user_id = v_target
    and grading = 'auto'
    and is_correct is not null
    and answered_at >= now() - make_interval(days => v_days);

  -- 2) 28 天活跃天数（北京时间日界）
  select count(distinct (answered_at at time zone 'Asia/Shanghai')::date)::int
    into v_active_days
  from practice_answers
  where user_id = v_target
    and grading = 'auto'
    and is_correct is not null
    and answered_at >= now() - interval '28 days';

  -- 3) 近 14 天 vs 前 14 天
  select count(*) filter (where answered_at >= now() - interval '14 days')::int,
         count(*) filter (where answered_at >= now() - interval '14 days' and is_correct)::int,
         count(*) filter (where answered_at < now() - interval '14 days')::int,
         count(*) filter (where answered_at < now() - interval '14 days' and is_correct)::int
    into v_recent_attempts, v_recent_correct, v_prev_attempts, v_prev_correct
  from practice_answers
  where user_id = v_target
    and grading = 'auto'
    and is_correct is not null
    and answered_at >= now() - interval '28 days';

  -- 4) 知识面：不同课程节点数（90 天）
  select count(distinct q.course_node_id)::int
    into v_distinct_nodes
  from practice_answers pa
  join questions q on q.id = pa.question_id
  where pa.user_id = v_target
    and pa.grading = 'auto'
    and pa.is_correct is not null
    and pa.answered_at >= now() - make_interval(days => v_days)
    and q.course_node_id is not null;

  -- 5) 稳定性：每日正确率的标准差（活跃日 ≥5 才有结论）
  select stddev_samp(day_acc), count(*)::int
    into v_stability_sd, v_stability_days
  from (
    select (pa.answered_at at time zone 'Asia/Shanghai')::date as day,
           count(*) filter (where pa.is_correct)::numeric / count(*) as day_acc
    from practice_answers pa
    where pa.user_id = v_target
      and pa.grading = 'auto'
      and pa.is_correct is not null
      and pa.answered_at >= now() - make_interval(days => v_days)
    group by 1
  ) d;

  -- 6) 掌握力：BKT 加权掌握度（365 天，与 my_bkt_profile 同口径）
  select sum(p_mastery * (1 + least(attempts, 3))),
         sum(1 + least(attempts, 3)),
         sum(attempts)::int
    into v_bkt_weighted, v_bkt_weight, v_bkt_attempts
  from public._my_bkt_items(v_target, 365, 600);
  v_bkt_attempts := coalesce(v_bkt_attempts, 0);

  v_mastery := case
    when v_bkt_weight > 0 then v_bkt_weighted / v_bkt_weight
    else null
  end;
  v_accuracy := case when v_attempts > 0 then v_correct::numeric / v_attempts else null end;
  v_effort := least(1, v_active_days / 20.0);
  v_growth := case
    when v_recent_attempts >= 10 and v_prev_attempts >= 10 then
      greatest(0, least(100,
        50 + ((v_recent_correct::numeric / v_recent_attempts)
            - (v_prev_correct::numeric / v_prev_attempts)) * 100))
    when v_recent_attempts >= 10 and v_prev_attempts = 0 then 50
    else null
  end;
  v_breadth := 100 * (1 - exp(-v_distinct_nodes / 8.0));
  v_stability := case
    when v_stability_days >= 5 then
      100 * greatest(0, least(1, 1 - coalesce(v_stability_sd, 0) / 0.35))
    else null
  end;

  v_mastery_score := case when v_bkt_attempts >= 5 then round(v_mastery * 100)::int end;
  v_accuracy_score := case when v_attempts >= 20 then round(v_accuracy * 100)::int end;
  v_effort_score := case when v_attempts >= 10 then round(v_effort * 100)::int end;
  v_growth_score := case when v_growth is not null then round(v_growth)::int end;
  v_breadth_score := case when v_distinct_nodes >= 3 then round(v_breadth)::int end;
  v_stability_score := case
    when v_stability_days >= 5 and v_attempts >= 20 then round(v_stability)::int
  end;

  v_caveats := array[
    '画像只反映最近 ' || v_days || ' 天的练习数据，不代表能力全貌'
  ];
  if v_bkt_attempts < 5 then
    v_caveats := array_append(v_caveats, '掌握力样本不足 5 次作答');
  end if;
  if v_attempts < 20 then
    v_caveats := array_append(v_caveats, '准确率/稳定性样本不足 20 次作答');
  end if;
  if v_stability_days < 5 then
    v_caveats := array_append(v_caveats, '稳定性样本不足 5 个活跃日');
  end if;
  if v_recent_attempts < 10 then
    v_caveats := array_append(v_caveats, '进步力近 14 天样本不足 10 次');
  end if;
  if v_distinct_nodes < 3 then
    v_caveats := array_append(v_caveats, '知识面样本不足 3 个知识点');
  end if;

  return jsonb_build_object(
    'student', jsonb_build_object(
      'user_id', v_target,
      'name', v_profile.name,
      'class_name', v_profile.class_name,
      'major_name', v_major_name),
    'window_days', v_days,
    'axes', jsonb_build_array(
      jsonb_build_object(
        'key', 'mastery', 'label', '掌握力', 'score', v_mastery_score,
        'raw', jsonb_build_object(
          'mastery', case when v_mastery is null then null else round(v_mastery, 3) end,
          'attempts', v_bkt_attempts, 'window_days', 365),
        'sample', v_bkt_attempts, 'sufficient', v_mastery_score is not null,
        'hint', 'BKT 加权掌握度'),
      jsonb_build_object(
        'key', 'accuracy', 'label', '准确率', 'score', v_accuracy_score,
        'raw', jsonb_build_object(
          'correct', v_correct, 'attempts', v_attempts, 'window_days', v_days),
        'sample', v_attempts, 'sufficient', v_accuracy_score is not null,
        'hint', '客观题正确率'),
      jsonb_build_object(
        'key', 'effort', 'label', '勤奋度', 'score', v_effort_score,
        'raw', jsonb_build_object(
          'active_days_28', v_active_days, 'goal_days', 20, 'window_days', 28),
        'sample', v_attempts, 'sufficient', v_effort_score is not null,
        'hint', '28 天活跃 20 天记满分'),
      jsonb_build_object(
        'key', 'growth', 'label', '进步力', 'score', v_growth_score,
        'raw', jsonb_build_object(
          'recent_attempts', v_recent_attempts, 'recent_correct', v_recent_correct,
          'prev_attempts', v_prev_attempts, 'prev_correct', v_prev_correct,
          'window_days', 28),
        'sample', v_recent_attempts + v_prev_attempts,
        'sufficient', v_growth_score is not null,
        'hint', '近 14 天相对前 14 天的正确率变化'),
      jsonb_build_object(
        'key', 'breadth', 'label', '知识面', 'score', v_breadth_score,
        'raw', jsonb_build_object(
          'distinct_nodes', v_distinct_nodes, 'window_days', v_days),
        'sample', v_distinct_nodes, 'sufficient', v_breadth_score is not null,
        'hint', '不同课程节点数的指数饱和'),
      jsonb_build_object(
        'key', 'stability', 'label', '稳定性', 'score', v_stability_score,
        'raw', jsonb_build_object(
          'daily_accuracy_sd', case when v_stability_sd is null then null
            else round(v_stability_sd, 3) end,
          'active_days', v_stability_days, 'window_days', v_days),
        'sample', v_stability_days, 'sufficient', v_stability_score is not null,
        'hint', '每日正确率的波动')
    ),
    'caveats', to_jsonb(v_caveats),
    'generated_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'));
end;
$$;

comment on function public.student_learning_profile(uuid, int) is
  '学习画像六轴（掌握力/准确率/勤奋度/进步力/知识面/稳定性）；自己看自己，教师看学生走 can_view_student；persona/summary 由两端纯函数拼装。';

revoke execute on function public.student_learning_profile(uuid, int) from public, anon;
grant execute on function public.student_learning_profile(uuid, int) to authenticated;

notify pgrst, 'reload schema';
