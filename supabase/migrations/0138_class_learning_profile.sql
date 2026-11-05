-- 0138: 班级平均画像（六轴班均）
--
-- 口径与 student_learning_profile 逐轴一致，只是先按学生算出六轴，再取班均：
--   · 掌握力：BKT 365 天加权，个人门槛 ≥5 次作答；
--   · 准确率：90 天客观题，≥20 次；
--   · 勤奋度：28 天活跃 /20，≥10 次；
--   · 进步力：近 14 天 vs 前 14 天，两窗各 ≥10 次（前窗为 0 时给 50）；
--   · 知识面：version_tags 去重标签数，≥3 个（与 0133 同口径）；
--   · 稳定性：90 天每日正确率标准差，活跃 ≥5 天且作答 ≥20。
--
-- 聚合只返回班级平均值与每轴“参与计算的学生数”，不返回任何学生姓名/个人值；
-- 每轴样本 <5 人时 sufficient=false、score=null。权限走 can_view_class。
-- 只按需调用（班均 BKT 在本班 36 人上约 2–3 秒），不要塞进班级页首屏 SSR。

create or replace function public.class_learning_profile(
  p_class_id uuid,
  p_days int default 90)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_days int := greatest(30, least(coalesce(p_days, 90), 365));
  v_class classes%rowtype;
  v_axes jsonb;
  v_students int := 0;
  v_with_data int := 0;
  v_caveats text[];
begin
  if not public.can_view_class(p_class_id) then
    raise exception '你不能查看这个班级的画像' using errcode = '42501';
  end if;
  select * into v_class from public.classes where id = p_class_id;
  if not found then
    raise exception '班级不存在';
  end if;

  with students as (
    select p.user_id
    from public.profiles p
    where p.class_id = p_class_id and public.can_view_student(p.user_id)
  ),
  attempts as (
    select a.user_id,
           count(*)::int as attempts,
           count(*) filter (where a.is_correct)::int as correct,
           count(distinct (a.answered_at at time zone 'Asia/Shanghai')::date)
             filter (where a.answered_at >= now() - interval '28 days')::int as active_days_28
    from public.practice_answers a
    join students s on s.user_id = a.user_id
    where a.grading = 'auto' and a.is_correct is not null
      and a.answered_at >= now() - make_interval(days => v_days)
    group by a.user_id
  ),
  growth as (
    select a.user_id,
           count(*) filter (where a.answered_at >= now() - interval '14 days')::int as recent_attempts,
           count(*) filter (where a.answered_at >= now() - interval '14 days' and a.is_correct)::int as recent_correct,
           count(*) filter (where a.answered_at < now() - interval '14 days')::int as prev_attempts,
           count(*) filter (where a.answered_at < now() - interval '14 days' and a.is_correct)::int as prev_correct
    from public.practice_answers a
    join students s on s.user_id = a.user_id
    where a.grading = 'auto' and a.is_correct is not null
      and a.answered_at >= now() - interval '28 days'
    group by a.user_id
  ),
  tags as (
    select a.user_id, count(distinct vt.tag_id)::int as distinct_tags
    from public.practice_answers a
    join students s on s.user_id = a.user_id
    join public.version_tags vt on vt.version_id = a.version_id
    where a.grading = 'auto' and a.is_correct is not null
      and a.answered_at >= now() - make_interval(days => v_days)
    group by a.user_id
  ),
  stability as (
    select d.user_id,
           stddev_samp(d.day_acc) as sd,
           count(*)::int as active_days
    from (
      select a.user_id,
             (a.answered_at at time zone 'Asia/Shanghai')::date as day,
             count(*) filter (where a.is_correct)::numeric / count(*) as day_acc
      from public.practice_answers a
      join students s on s.user_id = a.user_id
      where a.grading = 'auto' and a.is_correct is not null
        and a.answered_at >= now() - make_interval(days => v_days)
      group by a.user_id, 2
    ) d
    group by d.user_id
  ),
  bkt as (
    select p.user_id,
           sum(i.p_mastery * (1 + least(i.attempts, 3))) as weighted,
           sum(1 + least(i.attempts, 3)) as weight,
           sum(i.attempts)::int as bkt_attempts
    from students s
    join public.profiles p on p.user_id = s.user_id
    cross join lateral public._my_bkt_items(p.user_id, 365, 600) i
    group by p.user_id
  ),
  per_student as materialized (
    select s.user_id,
      case when b.bkt_attempts >= 5 and b.weight > 0
           then round(b.weighted / b.weight * 100)::int end as mastery_score,
      case when a.attempts >= 20
           then round(a.correct::numeric / a.attempts * 100)::int end as accuracy_score,
      case when a.attempts >= 10
           then round(least(1, a.active_days_28 / 20.0) * 100)::int end as effort_score,
      case when g.recent_attempts >= 10 and g.prev_attempts >= 10
           then round(greatest(0, least(100,
                  50 + (g.recent_correct::numeric / g.recent_attempts
                      - g.prev_correct::numeric / g.prev_attempts) * 100)))::int
           when g.recent_attempts >= 10 and g.prev_attempts = 0 then 50 end as growth_score,
      case when t.distinct_tags >= 3
           then round(100 * (1 - exp(-t.distinct_tags / 5.0)))::int end as breadth_score,
      case when st.active_days >= 5 and a.attempts >= 20
           then round(100 * greatest(0, least(1, 1 - coalesce(st.sd, 0) / 0.35)))::int end as stability_score
    from students s
    left join attempts a on a.user_id = s.user_id
    left join growth g on g.user_id = s.user_id
    left join tags t on t.user_id = s.user_id
    left join stability st on st.user_id = s.user_id
    left join bkt b on b.user_id = s.user_id
  ),
  axis_rows as (
    select 1 as ord, 'mastery' as key, '掌握力' as label,
           round(avg(mastery_score))::int as score,
           count(mastery_score)::int as sample,
           'BKT 加权掌握度（365 天）的班均' as hint
    from per_student
    union all
    select 2, 'accuracy', '准确率', round(avg(accuracy_score))::int,
           count(accuracy_score)::int, '客观题正确率的班均'
    from per_student
    union all
    select 3, 'effort', '勤奋度', round(avg(effort_score))::int,
           count(effort_score)::int, '28 天活跃 20 天记满分的班均'
    from per_student
    union all
    select 4, 'growth', '进步力', round(avg(growth_score))::int,
           count(growth_score)::int, '近 14 天相对前 14 天正确率变化的班均'
    from per_student
    union all
    select 5, 'breadth', '知识面', round(avg(breadth_score))::int,
           count(breadth_score)::int, '不同知识点（标签）数的班均'
    from per_student
    union all
    select 6, 'stability', '稳定性', round(avg(stability_score))::int,
           count(stability_score)::int, '每日正确率波动的班均'
    from per_student
  )
  select
    (select jsonb_agg(jsonb_build_object(
              'key', key, 'label', label,
              'score', score,
              'sample', sample,
              'sufficient', sample >= 5,
              'hint', hint,
              'raw', jsonb_build_object('students', sample))
            order by ord)
     from axis_rows),
    (select count(*)::int from students),
    (select count(*)::int from per_student
     where mastery_score is not null or accuracy_score is not null
        or effort_score is not null or growth_score is not null
        or breadth_score is not null or stability_score is not null)
  into v_axes, v_students, v_with_data;

  v_caveats := array[
    '班均画像只反映最近 ' || v_days || ' 天的练习数据，不代表班级能力全貌',
    '掌握力用 BKT 365 天窗口，其余轴用 ' || v_days || ' 天',
    '每轴只统计达到个人样本门槛的学生；某轴不足 5 人时不给分',
    '只展示班级聚合值，不展示单个学生，也不用于排名'
  ];

  return jsonb_build_object(
    'class', jsonb_build_object(
      'id', v_class.id, 'name', v_class.name, 'student_count', v_students),
    'window_days', v_days,
    'axes', coalesce(v_axes, '[]'::jsonb),
    'students_with_data', v_with_data,
    'caveats', to_jsonb(v_caveats),
    'generated_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'));
end;
$$;

comment on function public.class_learning_profile(uuid, int) is
  '班级六轴平均画像；只返回班均与每轴参与人数，不返回个人值；按需调用（BKT 较慢）。';

revoke execute on function public.class_learning_profile(uuid, int) from public, anon;
grant execute on function public.class_learning_profile(uuid, int) to authenticated;

notify pgrst, 'reload schema';
