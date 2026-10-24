-- 0108: practice_dashboard —— 热力图窗口改回真实的近 20 周，日界改北京时间
--
-- 症状（2026-10-24 对齐客户端时发现）：
--   · 返回体里 heatmap_from 是 **139 天前**、heatmap_to 是今天（20 周窗口），
--     但 heatmap_daily 只统计**本月**（`answered_at >= date_trunc('month', now())`）。
--     客户端按 20 周画格子，于是 90% 的格子永远是空的——既不像"这个月练得少"，
--     也看不出学期内的投入变化。
--   · today_answers 用的是库的 UTC 日界。北京时间早上 7 点练的题会被算成"昨天"，
--     首页「今日 x / 目标」于是从 0 开始（0069 已经在抽题侧修过同一个坑）。
--
-- 本迁移只改这两处口径 + daily 的日界，其余字段与 0077/0086 的线上定义逐字一致。
-- 客户端仍可只读自己有把握的键：jsonb 是向后兼容的。

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
  v_heatmap_daily jsonb;
  v_curve jsonb;
  v_today_date date := (now() at time zone 'Asia/Shanghai')::date;
begin
  -- 今日已答：按**北京时间**当天 00:00 起算（0069 的 practice_day_start）
  select count(*), count(*) filter (where is_correct),
         count(*) filter (where answered_at >= public.practice_day_start()),
         coalesce(sum(duration_ms), 0)
    into v_total, v_correct, v_today, v_dur
  from practice_answers where user_id = v_uid;

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

  -- 近 14 天趋势：按北京时间切日，并补零（图表要连续）
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(d::date, 'YYYY-MM-DD'),
           'count', coalesce(c.n, 0),
           'correct', coalesce(c.k, 0)) order by d), '[]'::jsonb)
    into v_daily
  from generate_series(
         v_today_date - 13,
         v_today_date,
         interval '1 day') as g(d)
  left join (
    select (answered_at at time zone 'Asia/Shanghai')::date as day,
           count(*) as n,
           count(*) filter (where is_correct) as k
    from practice_answers
    where user_id = v_uid
      and answered_at >= public.practice_day_start() - interval '13 days'
    group by 1) c on c.day = d::date;

  select coalesce(jsonb_agg(jsonb_build_object(
           'qtype', t.qtype, 'count', t.n, 'correct', t.k) order by t.n desc), '[]'::jsonb)
    into v_qtypes
  from (
    select v.qtype, count(*) as n, count(*) filter (where a.is_correct) as k
    from practice_answers a
    join question_versions v on v.id = a.version_id
    where a.user_id = v_uid
    group by v.qtype) t;

  select count(*) filter (where answered_at >= public.practice_day_start() - interval '6 days'),
         count(*) filter (where answered_at >= public.practice_day_start() - interval '13 days'
                            and answered_at < public.practice_day_start() - interval '6 days')
    into v_week, v_prev_week
  from practice_answers where user_id = v_uid;

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

  -- 热力图逐日答题数：**近 20 周（139 天前 ~ 今天）**，与 heatmap_from/to 对齐。
  -- 只给有作答的日子（没作答的格子客户端按 0 画），省得每次传 140 条零。
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(c.day, 'YYYY-MM-DD'), 'count', c.n) order by c.day), '[]'::jsonb)
    into v_heatmap_daily
  from (
    select (answered_at at time zone 'Asia/Shanghai')::date as day, count(*) as n
    from practice_answers
    where user_id = v_uid
      and answered_at >= public.practice_day_start() - interval '139 days'
    group by 1
  ) c;

  -- 遗忘曲线：把每一次作答按「距上次练同一道题的间隔」分桶，统计该桶的答对率。
  -- 间隔越长答对率越低 —— 这条下降的曲线就是学生**自己**的遗忘保持率。
  --
  -- 只统计 is_correct 非空的作答（主观题自评前是 NULL，算进来会被当成答错）。
  -- 窗口函数按 question_id 分区取上一次作答时间；第一次练某题没有"上一次"，
  -- gap 为 NULL 天然被排除在曲线之外。
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
      where a.user_id = v_uid and a.is_correct is not null
    ) p
    where p.gap is not null
    group by 1
  ) b;

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
    'heatmap_daily', v_heatmap_daily,
    'heatmap_from', to_char(v_today_date - 139, 'YYYY-MM-DD'),
    'heatmap_to', to_char(v_today_date, 'YYYY-MM-DD'),
    'forgetting_curve', v_curve,
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

comment on function public.practice_dashboard() is
  '学生学情看板：汇总 + 近 14 天趋势 + 近 20 周热力图 + 遗忘曲线 + 最近作答。日界按北京时间。';

revoke execute on function public.practice_dashboard() from public, anon;
grant execute on function public.practice_dashboard() to authenticated;

notify pgrst, 'reload schema';
