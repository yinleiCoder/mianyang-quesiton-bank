-- 0069: 抽题真正按遗忘曲线落闸 —— 当天练过的题，当天不再发。
--
-- 起因（线上实测量出来的，不是推测）：0059 只把 due_at 拿去**排序**，从不用它**过滤**。
-- 候选池一旦被练完，函数就静默回退到发「还远没到期」的题。
--
-- 证据（2026-09-17，某班试用的那天）：
--   · 一个学生选「判断题 + 难度1」——该组合当时全库正好 19 道，而他要 19~20 道，
--     于是每一场练习都把整个池子原样发一遍：53 分钟内连开 19 场，场场是同样那 19 道题，
--     重复间隔中位数 3.5 分钟。逐场比对过题目集合，19/19 完全重合。
--   · 全局：10978 次作答里有 4457 次（40.6%）是「同一道题 1 小时内重复作答」，涉及 71 名学生；
--     09-17 一天就有 40 名学生踩到，09-18 还有 30 名。
--
-- 修法（产品确认过的四层）：
--   第 0 层 新题（从没练过）
--   第 1 层 到期该复习的（due_at <= now()），逾期越久越靠前
--   第 2 层 今天之前练过的，最久没练的靠前 —— 用来补满题量
--   第 3 层 今天练过的 —— **只在 p_allow_same_day 时才会进来**
-- 「当天不重复」是硬闸：候选里 today_done 的行默认一律排除。
--
-- 池子干了（第 0~2 层全空）时**不报错**，返回 status='nothing_due' + next_due_at，
-- 客户端据此提示「今天的题已练完，X 月 X 日到期」并给一个「仍然加练」按钮 ——
-- 那个按钮就是带 p_allow_same_day=true 再调一次。
-- 为什么留这个口子而不是硬拦：题库现在只有 152 道，学生一天能做 200+ 次作答，
-- 硬拦会让人在教室里直接碰壁，但重复与否该由学生自己按 —— 默认不给重复。
--
-- **「当天」按北京时间算，不是库的 UTC。** 库的 date_trunc('day', now()) 从北京时间
-- 早上 8 点起算，中职学生 7 点早自习练的题会被算成"昨天"，当天照样重复。
-- （看板那几个函数仍在用 UTC 日界，属同一类问题的另一处，本迁移不动它们。）
--
-- **先判空、再动会话**：原版是先作废旧 active 会话、再发现抽不到题。现在
-- 「今天练完了」不再顺手作废学生进行中的那场练习。
--
-- 本函数**多了一个参数**，所以必须先 drop 旧的 8 参版本：PostgreSQL 按
-- (名字, 入参类型) 认函数，直接 create or replace 会留下两个重载，
-- PostgREST 解析 RPC 时会因歧义直接报错。旧版签名见 0059。

-- =====================================================================
-- 1) 北京时间的一天起点
-- =====================================================================
create or replace function public.practice_day_start()
returns timestamptz
language sql
stable
as $$
  select date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
$$;

comment on function public.practice_day_start() is
  '北京时间当天 00:00 对应的时刻。抽题判断「今天练过没有」用它，不用库的 UTC 日界。';

-- 只在 SECURITY DEFINER 函数内部调用，不对外开（与 practice_review_state 一致）。
revoke all on function public.practice_day_start() from public, anon, authenticated;

-- =====================================================================
-- 2) 候选池（内部助手）：三个来源统一成一张表，并算好分层
-- =====================================================================
-- 抽出来是因为 start_practice_session 要跑两趟：先数一遍决定「发不发」，
-- 再取一遍真正入库。两趟若各抄一份筛选条件，迟早会改歪一处。
--
-- tier 的含义（排序用，与 p_allow_same_day 无关，那个只影响「排不排除」）：
--   0 新题 / 1 到期 / 2 今天之前练过 / 3 今天练过
create or replace function public.practice_candidates(
  p_uid uuid,
  p_source text,
  p_node_id uuid default null,
  p_qtypes text[] default null,
  p_difficulty smallint default null,
  p_tag_id uuid default null,
  p_keyword text default null,
  p_question_ids uuid[] default null)
returns table (
  question_id uuid,
  version_id uuid,
  qtype text,
  last_at timestamptz,
  due_at timestamptz,
  is_new boolean,
  today_done boolean,
  tier int)
language sql
stable
security definer
set search_path = public
as $$
  with recursive subtree as (
    select sn.id from subject_nodes sn where p_node_id is not null and sn.id = p_node_id
    union all
    select sn.id from subject_nodes sn join subtree st on sn.parent_id = st.id
  ),
  review as (
    select rs.question_id as qid, rs.last_at, rs.due_at
    from public.practice_review_state(p_uid) rs
  ),
  -- 错题本：最近一次作答为错的题。全是已作答过的，所以不存在"新题"
  wrong_latest as (
    select distinct on (a.question_id) a.question_id as qid, a.is_correct
    from practice_answers a
    where a.user_id = p_uid
    order by a.question_id, a.answered_at desc
  ),
  base as (
    -- 题库
    select q.id as qid, v.id as vid, v.qtype as qt, r.last_at, r.due_at,
           (r.qid is null) as new_q
    from questions q
    join question_versions v on v.id = q.current_published_version_id
    left join review r on r.qid = q.id
    where p_source = 'all'
      and q.state = 'live'
      and v.status = 'published'
      and (p_node_id is null or q.course_node_id in (select id from subtree))
      and (p_qtypes is null or v.qtype = any(p_qtypes))
      and (p_difficulty is null or v.difficulty = p_difficulty)
      and (p_tag_id is null or exists (
            select 1 from version_tags vt where vt.version_id = v.id and vt.tag_id = p_tag_id))
      and (p_question_ids is null or q.id = any(p_question_ids))
      and (p_keyword is null or v.search_text ilike
            '%' || replace(replace(replace(p_keyword, '\', '\\'), '%', '\%'), '_', '\_') || '%')
    union all
    -- 错题本
    select q.id, v.id, v.qtype, r.last_at, r.due_at, false
    from wrong_latest w
    join questions q on q.id = w.qid
      and q.state = 'live' and q.current_published_version_id is not null
    join question_versions v on v.id = q.current_published_version_id and v.status = 'published'
    left join review r on r.qid = q.id
    where p_source = 'wrong' and w.is_correct is not true
    union all
    -- 收藏
    select q.id, v.id, v.qtype, r.last_at, r.due_at, false
    from question_favorites f
    join questions q on q.id = f.question_id
      and q.state = 'live' and q.current_published_version_id is not null
    join question_versions v on v.id = q.current_published_version_id and v.status = 'published'
    left join review r on r.qid = q.id
    where p_source = 'favorites' and f.user_id = p_uid
  )
  select b.qid,
         b.vid,
         b.qt,
         b.last_at,
         b.due_at,
         b.new_q,
         -- 只有"练过、且最后一次是在今天（北京时间的今天）"才算今天练过
         (not b.new_q and b.last_at is not null
            and b.last_at >= public.practice_day_start()) as today_done,
         case
           when b.new_q then 0
           when b.due_at is not null and b.due_at <= now() then 1
           when b.last_at is not null and b.last_at < public.practice_day_start() then 2
           else 3
         end as tier
  from base b;
$$;

comment on function public.practice_candidates(uuid, text, uuid, text[], smallint, uuid, text, uuid[]) is
  '练习候选池（按来源三选一）：每题一行，带 due_at / last_at / 是否新题 / 是否今天练过 / 分层 tier。';

-- 只在 SECURITY DEFINER 函数内部调用，不对外开（p_uid 是参数，开出去等于能查别人的复习状态）。
revoke all on function public.practice_candidates(uuid, text, uuid, text[], smallint, uuid, text, uuid[])
  from public, anon, authenticated;

-- =====================================================================
-- 3) 抽题
-- =====================================================================
-- 旧的 8 参版本必须显式 drop，否则与新版并存成两个重载，PostgREST 会因歧义报错
drop function if exists public.start_practice_session(
  uuid, text[], smallint, uuid, text, integer, text, uuid[]);

create or replace function public.start_practice_session(
  p_node_id uuid default null,
  p_qtypes text[] default null,
  p_difficulty smallint default null,
  p_tag_id uuid default null,
  p_keyword text default null,
  p_limit int default 20,
  p_source text default 'all',
  p_question_ids uuid[] default null,
  p_allow_same_day boolean default false)
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
  v_total int;
  v_eligible int;
  v_same_day int;
  v_next_due timestamptz;
  v_kw text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception '题量需在 1~100 之间';
  end if;
  if p_source is null or p_source not in ('all', 'wrong', 'favorites') then
    raise exception '未知的练习来源';
  end if;

  v_kw := nullif(btrim(coalesce(p_keyword, '')), '');

  -- **先判断有没有可发的题，再决定动不动会话。**
  -- 顺序反过来的话，「今天练完了」会先把学生进行中的会话静默作废掉，再说没题 ——
  -- 他那场练习就白白没了。
  select count(*),
         count(*) filter (where p_allow_same_day or not c.today_done),
         count(*) filter (where c.today_done),
         min(c.due_at) filter (where c.due_at > now())
    into v_total, v_eligible, v_same_day, v_next_due
  from public.practice_candidates(v_uid, p_source, p_node_id, p_qtypes,
                                  p_difficulty, p_tag_id, v_kw, p_question_ids) c;

  -- 一条候选都没有 = 筛选条件本身没命中（真错，客户端弹提示）
  if v_total = 0 then
    raise exception '没有符合条件的题目';
  end if;

  -- 有题，但今天能发的都发完了。不建会话、不动旧会话，把「下次什么时候有」交回客户端。
  if v_eligible = 0 then
    return jsonb_build_object(
      'session_id', null,
      'source', p_source,
      'status', 'nothing_due',
      'started_at', null,
      'total_count', 0,
      'answered_count', 0,
      'correct_count', 0,
      'items', '[]'::jsonb,
      'answers', '[]'::jsonb,
      'next_due_at', v_next_due,
      'same_day_count', v_same_day);
  end if;

  -- 之前的进行中会话作废（每人同时至多一场）
  update practice_sessions set status = 'abandoned'
  where user_id = v_uid and status = 'active';

  insert into practice_sessions (user_id, source, subject_node_id, qtypes, difficulty, tag_id, keyword)
  values (v_uid, p_source, p_node_id, p_qtypes, p_difficulty, p_tag_id, v_kw)
  returning id, started_at into v_session, v_started;

  -- **先按学习策略选题**，再把选中这几十道的**卷面顺序**排成题型分块。
  -- 顺序不能反：先按题型取 limit 的话，题库里单选最多时整张卷子会全是单选。
  insert into practice_session_items (session_id, seq, question_id, version_id)
  select v_session,
         row_number() over (order by public.practice_qtype_rank(c.qtype), random()),
         c.question_id, c.version_id
  from (
    select * from public.practice_candidates(v_uid, p_source, p_node_id, p_qtypes,
                                            p_difficulty, p_tag_id, v_kw, p_question_ids) c0
    where p_allow_same_day or not c0.today_done
    order by c0.tier,                                       -- 新题 → 到期 → 补位 → （加练）
             -- 到期层：逾期越久越靠前
             case when c0.tier = 1 then c0.due_at end asc,
             -- 补位层 / 加练层：最久没练的靠前
             case when c0.tier >= 2 then c0.last_at end asc,
             random()
    limit p_limit
  ) c;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    -- 上面已经确认过 eligible > 0，正常到不了这里。留着是为了万一：
    -- 宁可清掉刚建的空会话，也不能把一场 0 题的会话留在 active 里
    --（首页会一直显示「继续练习」，点进去是空卷）。
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

comment on function public.start_practice_session(uuid, text[], smallint, uuid, text, int, text, uuid[], boolean) is
  '组卷并开始一场练习。新题 → 到期复习 → 今天之前练过的最久没练的（补位）；'
  '当天练过的一律不发，除非 p_allow_same_day=true。'
  '池子干了返回 status=nothing_due（不建会话、不作废旧会话），并给出 next_due_at 与 same_day_count。';

-- 默认是给 PUBLIC 的，要按 0006 的口径收口；authenticated 才需要能调
revoke all on function public.start_practice_session(
  uuid, text[], smallint, uuid, text, int, text, uuid[], boolean) from public, anon;
grant execute on function public.start_practice_session(
  uuid, text[], smallint, uuid, text, int, text, uuid[], boolean) to authenticated, service_role;
