-- 0098：难度改多选 —— 组卷时"易 + 中"可以一起练
--
-- 题型（p_qtypes）从 0029 起就是数组，难度却一直是单个 smallint，
-- 于是"练易和中"只能分两场练。客户端把难度芯片从单选换成多选（与题型一致），这里跟上。
--
-- ⚠ **空数组 ≠ 不限**：`v.difficulty = any('{}')` 恒为假，传空数组会一道题都取不到。
--    所以客户端的空集合一律传 **null**——与 p_qtypes 是同一条纪律，
--    映射写在 QuestionFilter.toRpcParams()，改一个必须改另一个。
--
-- ⚠ **旧的 p_difficulty 保留，不删**：线上还有旧版客户端，而升级弹窗可以「稍后再说」，
--    发出去的老包会一直在。把参数删掉，它们的「开始练习」会当场报 PGRST202
--    （PostgREST 找不到函数），学生一道题都练不了。所以两个参数**并存**，
--    p_difficulties 优先，只传 p_difficulty 的按单元素数组处理，都不传 = 不限。
--    等旧包退干净了，再单独开一个迁移把 p_difficulty 删掉。
--
-- ⚠ 但**不能**用 create or replace 在函数上"加一个参数"：那是另一个签名，会留下一个
--    9 参的重载。旧客户端只传 p_difficulty 时两个候选都能匹配，PostgREST 会以歧义
--    报错（PGRST203）——比直接删掉还糟。所以必须 drop 旧的 9 参版本，只留 10 参这一个。

-- =====================================================================
-- 1) 会话记录的那一列也改成数组
-- =====================================================================
-- 它只写不读（全库没有一处 select 它，客户端的历史列表也不取），
-- 改类型不会影响任何查询；留着 smallint 才是问题：多选时只能存其中一个，历史就成了假话。
-- 老数据用 using 把单值包成单元素数组。
alter table public.practice_sessions
  alter column difficulty type smallint[]
  using (case when difficulty is null then null else array[difficulty] end);

comment on column public.practice_sessions.difficulty is
  '组卷时的难度筛选（1 易 / 2 中 / 3 难，可多选）；null = 不限';

-- =====================================================================
-- 2) 候选池：单个难度 → 难度数组
-- =====================================================================
-- 只在 SECURITY DEFINER 函数内部调用，签名随便改；但**参数类型变了就是另一个函数**，
-- create or replace 会留下一个并存的重载，必须先 drop。
drop function if exists public.practice_candidates(
  uuid, text, uuid, text[], smallint, uuid, text, uuid[]);

create function public.practice_candidates(
  p_uid uuid,
  p_source text,
  p_node_id uuid default null,
  p_qtypes text[] default null,
  p_difficulties smallint[] default null,
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
      and (p_difficulties is null or v.difficulty = any(p_difficulties))
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

comment on function public.practice_candidates(uuid, text, uuid, text[], smallint[], uuid, text, uuid[]) is
  '练习候选池（按来源三选一）：每题一行，带 due_at / last_at / 是否新题 / 是否今天练过 / 分层 tier。'
  'p_difficulties 是数组（0098），null = 不限。';

-- 只在 SECURITY DEFINER 函数内部调用，不对外开（p_uid 是参数，开出去等于能查别人的复习状态）。
revoke all on function public.practice_candidates(uuid, text, uuid, text[], smallint[], uuid, text, uuid[])
  from public, anon, authenticated;

-- =====================================================================
-- 3) 抽题：智能练习（保留 p_difficulty 兼容旧客户端）
-- =====================================================================
-- 旧的 9 参版本必须显式 drop，否则与新版并存成两个重载，PostgREST 会因歧义报错
-- （旧客户端只传 p_difficulty 时两个签名都能匹配）。
drop function if exists public.start_practice_session(
  uuid, text[], smallint, uuid, text, integer, text, uuid[], boolean);

create function public.start_practice_session(
  p_node_id uuid default null,
  p_qtypes text[] default null,
  p_difficulty smallint default null,
  p_difficulties smallint[] default null,
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
  v_difficulties smallint[];
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception '题量需在 1~100 之间';
  end if;
  if p_source is null or p_source not in ('all', 'wrong', 'favorites') then
    raise exception '未知的练习来源';
  end if;

  v_kw := nullif(btrim(coalesce(p_keyword, '')), '');
  -- 新参数优先；只有旧客户端才会走到后半段（p_difficulty 是 0098 之前的唯一口径）
  v_difficulties := coalesce(
    p_difficulties,
    case when p_difficulty is null then null else array[p_difficulty] end);

  -- **先判断有没有可发的题，再决定动不动会话。**
  -- 顺序反过来的话，「今天练完了」会先把学生进行中的会话静默作废掉，再说没题 ——
  -- 他那场练习就白白没了。
  select count(*),
         count(*) filter (where p_allow_same_day or not c.today_done),
         count(*) filter (where c.today_done),
         min(c.due_at) filter (where c.due_at > now())
    into v_total, v_eligible, v_same_day, v_next_due
  from public.practice_candidates(v_uid, p_source, p_node_id, p_qtypes,
                                  v_difficulties, p_tag_id, v_kw, p_question_ids) c;

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
  values (v_uid, p_source, p_node_id, p_qtypes, v_difficulties, p_tag_id, v_kw)
  returning id, started_at into v_session, v_started;

  -- **先按学习策略选题**，再把选中这几十道的**卷面顺序**排成题型分块。
  -- 顺序不能反：先按题型取 limit 的话，题库里单选最多时整张卷子会全是单选。
  insert into practice_session_items (session_id, seq, question_id, version_id)
  select v_session,
         row_number() over (order by public.practice_qtype_rank(c.qtype), random()),
         c.question_id, c.version_id
  from (
    select * from public.practice_candidates(v_uid, p_source, p_node_id, p_qtypes,
                                            v_difficulties, p_tag_id, v_kw, p_question_ids) c0
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

comment on function public.start_practice_session(uuid, text[], smallint, smallint[], uuid, text, int, text, uuid[], boolean) is
  '组卷并开始一场练习。新题 → 到期复习 → 今天之前练过的最久没练的（补位）；'
  '当天练过的一律不发，除非 p_allow_same_day=true。'
  '池子干了返回 status=nothing_due（不建会话、不作废旧会话），并给出 next_due_at 与 same_day_count。'
  '难度取 p_difficulties（数组，0098），p_difficulty 只为旧客户端保留。';

-- 默认是给 PUBLIC 的，要按 0006 的口径收口；authenticated 才需要能调
revoke all on function public.start_practice_session(
  uuid, text[], smallint, smallint[], uuid, text, int, text, uuid[], boolean) from public, anon;
grant execute on function public.start_practice_session(
  uuid, text[], smallint, smallint[], uuid, text, int, text, uuid[], boolean) to authenticated, service_role;

-- =====================================================================
-- 4) 抽题：顺序讲练 —— 同一处改法
-- =====================================================================
drop function if exists public.start_sequential_practice(
  uuid, text[], smallint, uuid, text, integer, text, uuid[], integer);

create function public.start_sequential_practice(
  p_node_id uuid default null,
  p_qtypes text[] default null,
  p_difficulty smallint default null,
  p_difficulties smallint[] default null,
  p_tag_id uuid default null,
  p_keyword text default null,
  p_limit integer default 20,
  p_source text default 'all',
  p_question_ids uuid[] default null,
  p_offset integer default 0)
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
  v_kw text;
  v_difficulties smallint[];
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception '题量需在 1~100 之间';
  end if;
  if p_offset is null or p_offset < 0 then
    raise exception '轮次起点不能为负';
  end if;
  if p_source is null or p_source not in ('all', 'wrong', 'favorites') then
    raise exception '未知的练习来源';
  end if;

  v_kw := nullif(btrim(coalesce(p_keyword, '')), '');
  -- 新参数优先；只有旧客户端才会走到后半段
  v_difficulties := coalesce(
    p_difficulties,
    case when p_difficulty is null then null else array[p_difficulty] end);

  -- 先数清楚有多少题，再决定动不动会话（与智能练习同一条纪律：空手而归不许作废进行中的练习）。
  -- 「已经到最后一轮」也要在**动会话之前**拦住——教师点到头时，正在讲的那一场必须原样留着。
  select count(*) into v_total
  from public.practice_candidates(
    v_uid, p_source, p_node_id, p_qtypes, v_difficulties, p_tag_id, v_kw, p_question_ids);

  if v_total = 0 then
    raise exception '没有符合条件的题目';
  end if;
  if p_offset >= v_total then
    raise exception '已经是最后一轮了（符合条件共 % 道题）', v_total;
  end if;

  -- 一场只能有一个进行中的会话（0028 的唯一索引）；新开一场就作废旧的，与智能练习一致
  update practice_sessions set status = 'abandoned'
  where user_id = v_uid and status = 'active';

  insert into practice_sessions (user_id, source, subject_node_id, qtypes, difficulty, tag_id, keyword, scored)
  values (v_uid, p_source, p_node_id, p_qtypes, v_difficulties, p_tag_id, v_kw, false)
  returning id, started_at into v_session, v_started;

  -- 顺序：题库列表的顺序（published_at desc，最新入库的在前）。
  --
  -- seq 用**全局序号**（row_number 在 offset 之前算），不是每轮重新从 1 数：
  -- 窗口函数先于 offset/limit 求值，所以第 2 轮（offset=100）的第一条 seq 正好是 101，
  -- 与"题库里第 101 道"对得上，教师看到「第 101 题」不必自己加。
  -- （客户端刷题页的题号取自列表下标，不读 seq，故不受影响。）
  insert into practice_session_items (session_id, seq, question_id, version_id)
  select v_session,
         row_number() over (order by v.published_at desc nulls last, c.question_id),
         c.question_id, c.version_id
  from public.practice_candidates(
         v_uid, p_source, p_node_id, p_qtypes, v_difficulties, p_tag_id, v_kw, p_question_ids) c
  join question_versions v on v.id = c.version_id
  order by v.published_at desc nulls last, c.question_id
  offset p_offset
  limit p_limit;

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
    'scored', false,
    'offset', p_offset,
    'total_available', v_total,
    'items', public.practice_session_items_json(v_session),
    'answers', '[]'::jsonb);
end;
$$;

comment on function public.start_sequential_practice(uuid, text[], smallint, smallint[], uuid, text, integer, text, uuid[], integer) is
  '顺序讲练抽题（不计分）：按题库顺序连排，p_offset 分轮（轮大小 = p_limit，第 N 轮从 (N-1)*p_limit 开始）。'
  '返回 total_available 供前端算轮次（2026-10-09 / 0095）。'
  '难度取 p_difficulties（数组，0098），p_difficulty 只为旧客户端保留。';

revoke execute on function public.start_sequential_practice(
  uuid, text[], smallint, smallint[], uuid, text, integer, text, uuid[], integer) from public, anon;
grant execute on function public.start_sequential_practice(
  uuid, text[], smallint, smallint[], uuid, text, integer, text, uuid[], integer) to authenticated;

-- 函数签名变了，PostgREST 的 schema cache 得重新读一遍，否则新参数它认不出来
notify pgrst, 'reload schema';
