-- 0059: 抽题按遗忘曲线排（新题优先 → 到期复习）、卷面按题型固定顺序、首页加本月签到。
--
-- 起因是学生试用的三条反馈：
--   ① 「题号是乱的，各个题型不是顺序的」——原来是 order by random() 从全库抽，
--      单选/判断/多选交错，答题卡按题型分组后组内题号就成了 1 3 7 12 这样。
--   ② 「应该按艾宾浩斯曲线科学抽题，而不是重复抽已经出现过的题」——原来也是随机，
--      所以刚做过的题很快又会冒出来。现在按"没做过的优先、其次到期该复习的"排。
--   ③ 首页要日历签到（本月哪几天练过）——dashboard 原来只给近 14 天。
--
-- **本函数的最新版在 0043**（题量上限 100 + p_question_ids 参数），不是 0029。
-- 下面按线上定义整体覆盖（0026 误用旧版覆盖新版的坑，见 AGENTS.md）。
--
-- 两个刻意的取舍：
--   · **新题优先于复习**：学生反馈的痛点是"重复抽已经出现过的题"，先把没做过的过一遍；
--     新题抽完了才开始按间隔复习。错题本/收藏两个来源本身就以复习为目的，不套"新题优先"。
--   · **间隔按"最近一次作答之后的连续答对次数"取档**：1/2/4/7/15/30 天。最近一次答错 → 0 连对
--     → 1 天后就该复习；连对越多间隔越长。不需要新表，全部能从 practice_answers 推出来。

-- =====================================================================
-- 1) 每题的复习状态（内部助手）
-- =====================================================================
-- 返回每题：最近作答时刻、尾部连续答对次数、下次该复习的时刻。
-- 没作答过的题不出现在结果里（左连接之后为 NULL = 新题）。
create or replace function public.practice_review_state(p_uid uuid)
returns table (question_id uuid, last_at timestamptz, streak int, due_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with ordered as (
    select a.question_id as qid,
           a.is_correct as ok,
           a.answered_at as at,
           row_number() over (partition by a.question_id
                              order by a.answered_at desc) as rn
    from practice_answers a
    where a.user_id = p_uid
  ),
  -- 第一次答错的位次；没答错过就是"无穷远"
  first_wrong as (
    select o.qid, min(o.rn) as rn from ordered o
    where o.ok is not true group by o.qid
  ),
  agg as (
    select o.qid,
           max(o.at) as last_at,
           count(*) filter (where o.rn < coalesce(f.rn, 2147483647))::int as streak
    from ordered o
    left join first_wrong f on f.qid = o.qid
    group by o.qid
  )
  select agg.qid,
         agg.last_at,
         agg.streak,
         agg.last_at + make_interval(
           days => (array[1, 2, 4, 7, 15, 30])[least(agg.streak, 5) + 1]
         )
  from agg;
$$;

comment on function public.practice_review_state(uuid) is
  '每题的复习状态：最近作答时刻 + 尾部连续答对次数 + 下次该复习的时刻（间隔 1/2/4/7/15/30 天）';

-- =====================================================================
-- 2) 抽题：新题优先 → 到期复习；卷面按题型顺序
-- =====================================================================
create or replace function public.start_practice_session(
  p_node_id uuid default null,
  p_qtypes text[] default null,
  p_difficulty smallint default null,
  p_tag_id uuid default null,
  p_keyword text default null,
  p_limit int default 20,
  p_source text default 'all',
  p_question_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_session uuid;
  v_started timestamptz;
  v_count int;
  v_kw text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception '题量需在 1~100 之间';
  end if;
  if p_source is null or p_source not in ('all', 'wrong', 'favorites') then
    raise exception '未知的练习来源';
  end if;

  -- 之前的进行中会话作废（每人同时至多一场进行中）
  update practice_sessions set status = 'abandoned'
  where user_id = v_uid and status = 'active';

  v_kw := nullif(btrim(coalesce(p_keyword, '')), '');

  insert into practice_sessions (user_id, source, subject_node_id, qtypes, difficulty, tag_id, keyword)
  values (v_uid, p_source, p_node_id, p_qtypes, p_difficulty, p_tag_id, v_kw)
  returning id, started_at into v_session, v_started;

  if p_source = 'all' then
    with recursive subtree as (
      select sn.id from subject_nodes sn where p_node_id is not null and sn.id = p_node_id
      union all
      select sn.id from subject_nodes sn join subtree st on sn.parent_id = st.id
    ),
    cand as (
      select q.id as question_id, v.id as version_id, v.qtype,
             -- due_at 为 NULL 就是没做过的新题
             r.due_at, r.last_at,
             (r.question_id is null) as is_new
      from questions q
      join question_versions v on v.id = q.current_published_version_id
      left join public.practice_review_state(v_uid) r on r.question_id = q.id
      where q.state = 'live'
        and v.status = 'published'
        and (p_node_id is null or q.course_node_id in (select id from subtree))
        and (p_qtypes is null or v.qtype = any(p_qtypes))
        and (p_difficulty is null or v.difficulty = p_difficulty)
        and (p_tag_id is null or exists (
              select 1 from version_tags vt where vt.version_id = v.id and vt.tag_id = p_tag_id))
        and (p_question_ids is null or q.id = any(p_question_ids))
        and (v_kw is null or v.search_text ilike
              '%' || replace(replace(replace(v_kw, '\', '\\'), '%', '\%'), '_', '\_') || '%')
    ),
    -- **先按学习策略选题**，再把选中这几十道的**卷面顺序**排成题型分块。
    -- 顺序不能反：先按题型取 limit 的话，题库里单选最多时整张卷子会全是单选。
    picked as (
      select * from cand
      order by is_new desc,                                   -- 没做过的优先
               (due_at is not null and due_at <= now()) desc,  -- 到期该复习的其次
               coalesce(due_at, now()) asc,                    -- 逾期越久越靠前
               random()
      limit p_limit
    )
    insert into practice_session_items (session_id, seq, question_id, version_id)
    select v_session,
           row_number() over (order by public.practice_qtype_rank(qtype), random()),
           question_id, version_id
    from picked;

  elsif p_source = 'wrong' then
    -- 错题本本来就是复习用的，不套"新题优先"；只按该复习的程度排
    with latest as (
      select distinct on (a.question_id) a.question_id, a.is_correct
      from practice_answers a
      where a.user_id = v_uid
      order by a.question_id, a.answered_at desc
    ),
    cand as (
      select q.id as question_id, v.id as version_id, v.qtype,
             r.due_at
      from latest l
      join questions q on q.id = l.question_id
        and q.state = 'live' and q.current_published_version_id is not null
      join question_versions v on v.id = q.current_published_version_id and v.status = 'published'
      left join public.practice_review_state(v_uid) r on r.question_id = q.id
      where l.is_correct is not true
    ),
    picked as (
      select * from cand
      order by coalesce(due_at, now()) asc, random()
      limit p_limit
    )
    insert into practice_session_items (session_id, seq, question_id, version_id)
    select v_session,
           row_number() over (order by public.practice_qtype_rank(qtype), random()),
           question_id, version_id
    from picked;

  else
    with cand as (
      select q.id as question_id, v.id as version_id, v.qtype,
             r.due_at
      from question_favorites f
      join questions q on q.id = f.question_id
        and q.state = 'live' and q.current_published_version_id is not null
      join question_versions v on v.id = q.current_published_version_id and v.status = 'published'
      left join public.practice_review_state(v_uid) r on r.question_id = q.id
      where f.user_id = v_uid
    ),
    picked as (
      select * from cand
      order by coalesce(due_at, now()) asc, random()
      limit p_limit
    )
    insert into practice_session_items (session_id, seq, question_id, version_id)
    select v_session,
           row_number() over (order by public.practice_qtype_rank(qtype), random()),
           question_id, version_id
    from picked;
  end if;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    delete from practice_sessions where id = v_session;
    raise exception '没有符合条件的题目';
  end if;
  update practice_sessions set total_count = v_count where id = v_session;

  return jsonb_build_object(
    'session_id', v_session,
    'source', p_source,
    'status', 'active',
    'started_at', v_started,
    'total_count', v_count,
    'answered_count', 0,
    'correct_count', 0,
    'items', public.practice_session_items_json(v_session),
    'answers', '[]'::jsonb);
end;
$$;

-- 题型在卷面上的固定顺序。客户端答题卡按"首次出现"分组，这张表决定组与组谁在前。
-- 与 Flutter 端 core/constants/qtype_meta.dart 的 QuestionType 枚举顺序一致。
create or replace function public.practice_qtype_rank(p_qtype text)
returns int
language sql
immutable
as $$
  select coalesce(array_position(
    array['single_choice', 'multiple_choice', 'true_false',
          'fill_blank', 'short_answer', 'composite'], p_qtype), 99);
$$;

-- =====================================================================
-- 3) 首页签到：本月哪几天练过
-- =====================================================================
-- 加在 practice_dashboard 的返回里而不是另开一个 RPC：首页本来就只读它一次，
-- 另开一个函数等于每次进首页多打一次往返（0041 也强调过这个函数"不加参数"的取舍）。
-- 0031 是它的最新定义，下面整体覆盖，只多加一个字段与一段统计。
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
  v_checkin jsonb;
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

  -- 本月签到日（有作答的日期，按天去重）。日历把整月铺出来，打勾的就是这几天。
  select coalesce(jsonb_agg(to_char(d, 'YYYY-MM-DD') order by d), '[]'::jsonb)
    into v_checkin
  from (
    select distinct date_trunc('day', answered_at)::date as d
    from practice_answers
    where user_id = v_uid and answered_at >= date_trunc('month', now())
  ) s;

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
    'checkin_days', v_checkin,
    'checkin_month', to_char(now(), 'YYYY-MM'),
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
