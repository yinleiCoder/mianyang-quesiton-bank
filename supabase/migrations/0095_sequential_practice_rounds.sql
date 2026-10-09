-- 0095：顺序讲练（教师讲练）分轮 —— 让第 101 题之后也讲得到
--
-- 问题（2026-10-09 用户提出）：0090 的 `p_limit` 上限是 100，而抽题**每次都从第 1 道
-- 开始**，于是"再来一轮"永远拿到同一批前 100 道，题库里第 101 道之后的题在讲练模式下
-- 根本到不了。题量上限本身是对的（0043 刻意定的 100），缺的是**轮次**。
--
-- 做法：加一个 `p_offset`，语义就是"这一轮从题库顺序的第几道开始"。轮大小 = p_limit，
-- 第 N 轮 = offset (N-1)*p_limit。客户端据此给「上一轮 / 下一轮」。
-- **不改** `start_practice_session`（学生智能练习的主链路），也不动 `practice_candidates`。
--
-- 两个顺带修掉的坑：
--   1. `get_practice_session` 补返 `scored`。此前续练拿不到这个字段，客户端只能按路由
--      默认值当"即时练习"重开——**于是续练一场课堂讲练时，作答会被真的提交到服务端**，
--      正好违反 0090「一轮里一个答案都不提交」，而且没有任何地方会报错：错题本、正确率、
--      遗忘曲线会被静默污染。会话自己说得出自己是不是不计分，客户端就不必猜。
--   2. 返回值补 `total_available`：前端要算"共几轮、还有没有下一轮"，否则只能在点下去
--      报错之后才知道到头了。
--
-- 注意 `p_offset` 之上还有一个固有性质：它是**按下标分页**。讲练过程中若有人新发布了题，
-- `published_at desc` 的头部会插入新行，后续轮次的边界会随之平移（可能重复或漏掉个别题）。
-- 课堂上这一窗口很短，且顺序练习本来就是"过一遍"，故不为此改成游标分页；
-- 真要稳定，得记住上一轮最后一题的 (published_at, question_id) 作游标——留作后话。

-- =====================================================================
-- 1) 分轮抽题
-- =====================================================================
-- 旧的 8 参版本必须显式 drop，否则与新版并存成两个重载，PostgREST 会因歧义报错
-- （同 0069 对 start_practice_session 的处理）。
drop function if exists public.start_sequential_practice(
  uuid, text[], smallint, uuid, text, integer, text, uuid[]);

create or replace function public.start_sequential_practice(
  p_node_id uuid default null,
  p_qtypes text[] default null,
  p_difficulty smallint default null,
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

  -- 先数清楚有多少题，再决定动不动会话（与智能练习同一条纪律：空手而归不许作废进行中的练习）。
  -- 「已经到最后一轮」也要在**动会话之前**拦住——教师点到头时，正在讲的那一场必须原样留着。
  select count(*) into v_total
  from public.practice_candidates(
    v_uid, p_source, p_node_id, p_qtypes, p_difficulty, p_tag_id, v_kw, p_question_ids);

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
  values (v_uid, p_source, p_node_id, p_qtypes, p_difficulty, p_tag_id, v_kw, false)
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
         v_uid, p_source, p_node_id, p_qtypes, p_difficulty, p_tag_id, v_kw, p_question_ids) c
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

comment on function public.start_sequential_practice(uuid, text[], smallint, uuid, text, integer, text, uuid[], integer) is
  '顺序讲练抽题（不计分）：按题库顺序连排，p_offset 分轮（轮大小 = p_limit，第 N 轮从 (N-1)*p_limit 开始）。'
  '返回 total_available 供前端算轮次（2026-10-09 / 0095）。';

revoke execute on function public.start_sequential_practice(
  uuid, text[], smallint, uuid, text, integer, text, uuid[], integer) from public, anon;
grant execute on function public.start_sequential_practice(
  uuid, text[], smallint, uuid, text, integer, text, uuid[], integer) to authenticated;

-- =====================================================================
-- 2) 续练要认得出"这是一场不计分的课堂讲练"
-- =====================================================================
-- 只加一个键，签名不变（不 drop，授权自动保留）。
create or replace function public.get_practice_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_s practice_sessions%rowtype;
begin
  select * into v_s from practice_sessions where id = p_session_id and user_id = v_uid;
  if not found then
    raise exception '练习会话不存在或不属于你';
  end if;
  return jsonb_build_object(
    'session_id', v_s.id,
    'source', v_s.source,
    'status', v_s.status,
    'started_at', v_s.started_at,
    'submitted_at', v_s.submitted_at,
    'duration_ms', v_s.duration_ms,
    'total_count', v_s.total_count,
    'answered_count', v_s.answered_count,
    'correct_count', v_s.correct_count,
    -- 续练时必须知道这个：scored=false 的会话要按"课堂讲练"重开，
    -- 否则会把作答提交到服务端，静默污染学生的统计（见 0090 的文件头）。
    'scored', v_s.scored,
    'items', public.practice_session_items_json(v_s.id),
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'question_id', a.question_id,
        'answer', a.answer,
        'grading', a.grading,
        'is_correct', a.is_correct,
        'self_mastered', a.self_mastered,
        'duration_ms', a.duration_ms,
        'answered_at', a.answered_at))
      from practice_answers a where a.session_id = v_s.id), '[]'::jsonb));
end;
$$;
