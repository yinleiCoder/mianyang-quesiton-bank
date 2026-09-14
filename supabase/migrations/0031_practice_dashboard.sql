-- 0031: 客户端工作台仪表盘数据（一次取全，避免多次往返）。
-- 在 0029 practice_overview 的基础上补：近 14 天逐日做题/答对（点阵与趋势）、
-- 近 7 天 vs 前 7 天（趋势对比）、题型分布（同心圆/分布图）、连续练习天数。
-- 口径与 practice_overview 一致：仅本人数据；聚合不外泄他人明细。

create or replace function public.practice_dashboard()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_total int;
  v_correct int;
  v_today int;
  v_dur bigint;
  v_wrong int;
  v_fav int;
  v_active jsonb;
  v_daily jsonb;
  v_qtypes jsonb;
  v_week int;
  v_prev_week int;
  v_streak int;
  v_last_day date;
begin
  -- 累计统计
  select count(*), count(*) filter (where is_correct),
         count(*) filter (where answered_at >= date_trunc('day', now())),
         coalesce(sum(duration_ms), 0)
    into v_total, v_correct, v_today, v_dur
  from practice_answers where user_id = v_uid;

  -- 待复习错题（最近一次为错且题目仍在线）
  select count(*) into v_wrong from (
    select distinct on (a.question_id) a.question_id, a.is_correct
    from practice_answers a where a.user_id = v_uid
    order by a.question_id, a.answered_at desc) l
  join questions q on q.id = l.question_id
    and q.state = 'live' and q.current_published_version_id is not null
  join question_versions v on v.id = q.current_published_version_id and v.status = 'published'
  where l.is_correct is not true;

  select count(*) into v_fav from question_favorites where user_id = v_uid;

  select to_jsonb(t) into v_active from (
    select id as session_id, source, total_count, answered_count, started_at
    from practice_sessions where user_id = v_uid and status = 'active'
    limit 1) t;

  -- 近 14 天逐日（含无作答的日期，补 0）
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(d, 'YYYY-MM-DD'),
           'count', coalesce(c.n, 0),
           'correct', coalesce(c.k, 0)) order by d), '[]'::jsonb)
    into v_daily
  from generate_series(
         date_trunc('day', now()) - interval '13 days',
         date_trunc('day', now()),
         interval '1 day') d
  left join (
    select date_trunc('day', answered_at) as day,
           count(*) as n,
           count(*) filter (where is_correct) as k
    from practice_answers
    where user_id = v_uid and answered_at >= date_trunc('day', now()) - interval '13 days'
    group by 1) c on c.day = d;

  -- 题型分布（按作答数排序）
  select coalesce(jsonb_agg(jsonb_build_object(
           'qtype', t.qtype, 'count', t.n, 'correct', t.k) order by t.n desc), '[]'::jsonb)
    into v_qtypes
  from (
    select v.qtype, count(*) as n, count(*) filter (where a.is_correct) as k
    from practice_answers a
    join question_versions v on v.id = a.version_id
    where a.user_id = v_uid
    group by v.qtype) t;

  -- 近 7 天 vs 前 7 天（趋势）
  select count(*) filter (where answered_at >= date_trunc('day', now()) - interval '6 days'),
         count(*) filter (where answered_at >= date_trunc('day', now()) - interval '13 days'
                            and answered_at < date_trunc('day', now()) - interval '6 days')
    into v_week, v_prev_week
  from practice_answers where user_id = v_uid;

  -- 连续练习天数（以最近一次练习日为终点向前数连续天）
  select coalesce((select len from (
             select count(*) as len, max(day) as last_day
             from (select day, day - (row_number() over (order by day))::int as anchor
                   from (select distinct date_trunc('day', answered_at)::date as day
                         from practice_answers where user_id = v_uid) s) g
             group by anchor) r
           order by last_day desc limit 1), 0),
         (select max(day) from (
             select distinct date_trunc('day', answered_at)::date as day
             from practice_answers where user_id = v_uid) s2)
    into v_streak, v_last_day;

  return jsonb_build_object(
    'total_answers', v_total,
    'correct_answers', v_correct,
    'accuracy', case when v_total > 0 then round(v_correct::numeric / v_total, 4) else 0 end,
    'today_answers', v_today,
    'total_duration_ms', v_dur,
    'wrong_count', v_wrong,
    'favorite_count', v_fav,
    'active_session', v_active,
    'daily', v_daily,
    'qtype_stats', v_qtypes,
    'week_answers', v_week,
    'prev_week_answers', v_prev_week,
    'streak_days', v_streak,
    'last_practice_day', v_last_day,
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'question_id', r.question_id,
        'version_id', r.version_id,
        'qtype', r.qtype,
        'difficulty', r.difficulty,
        'is_correct', r.is_correct,
        'grading', r.grading,
        'answered_at', r.answered_at,
        'stem_text', r.stem_text))
      from (
        select a.question_id,
               coalesce(cv.id, a.version_id) as version_id,
               coalesce(cv.qtype, av.qtype) as qtype,
               coalesce(cv.difficulty, av.difficulty) as difficulty,
               a.is_correct, a.grading, a.answered_at,
               case when cv.id is not null then left(coalesce(cv.search_text, ''), 120) end as stem_text
        from practice_answers a
        join question_versions av on av.id = a.version_id
        left join questions q on q.id = a.question_id
          and q.state = 'live' and q.current_published_version_id is not null
        left join question_versions cv on cv.id = q.current_published_version_id and cv.status = 'published'
        where a.user_id = v_uid
        order by a.answered_at desc
        limit 10) r), '[]'::jsonb));
end;
$$;

revoke execute on function public.practice_dashboard() from public, anon;
grant execute on function public.practice_dashboard() to authenticated;
