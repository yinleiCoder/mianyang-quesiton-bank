-- 0090：顺序练习（教师讲练）—— 按题库顺序过题，且**不计入学习统计**
--
-- 与 start_practice_session 的关系：**刻意不改它**。那是全站学生智能练习的主链路
-- （新题→到期→补位四层 + 当天已练不发，0069），为一个新模式去动它的风险不成比例。
-- 这里新开一个函数，共用同一个候选池 practice_candidates，只换"挑哪几道"与"怎么排"。
--
-- 三条与智能练习不同的口径（用户 2026-10-08 拍板）：
--   1. **顺序**：按题库列表的顺序（published_at desc，同刻用 question_id 兜底）——
--      就是学生在「题库」页从上往下看到的顺序。可复现、可预期，不随机、不按遗忘曲线。
--   2. **不按当天已练过滤**：课堂讲练就是要连着过一遍，跳过"今天做过的"会破坏顺序。
--      代价：这些题当天仍可能被智能练习抽到（不计入，所以不占用当日额度）。
--   3. **不计入统计**：会话 scored = false，且客户端**不写 practice_answers**——
--      错题本 / 正确率 / 遗忘曲线 / 今日已练 / 热力图**全部派生自 practice_answers**，
--      不写就等于自动不进任何统计（这条比"写了再到处过滤"可靠得多：少过滤一处就是静默污染）。
--      练习记录里留一条，记录页按 scored 标「课堂讲练·不计分」。

alter table public.practice_sessions
  add column if not exists scored boolean not null default true;

comment on column public.practice_sessions.scored is
  '是否计入学习统计。false = 课堂顺序练习：不写 practice_answers，统计里看不见它（2026-10-08 / 0090）';

create or replace function public.start_sequential_practice(
  p_node_id uuid default null,
  p_qtypes text[] default null,
  p_difficulty smallint default null,
  p_tag_id uuid default null,
  p_keyword text default null,
  p_limit integer default 20,
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

  v_kw := nullif(btrim(coalesce(p_keyword, '')), '');

  -- 先看有没有题，再决定动不动会话（与智能练习同一条纪律：空手而归不许作废进行中的练习）
  if not exists (
    select 1 from public.practice_candidates(
      v_uid, p_source, p_node_id, p_qtypes, p_difficulty, p_tag_id, v_kw, p_question_ids)
  ) then
    raise exception '没有符合条件的题目';
  end if;

  -- 一场只能有一个进行中的会话（0028 的唯一索引）；新开一场就作废旧的，与智能练习一致
  update practice_sessions set status = 'abandoned'
  where user_id = v_uid and status = 'active';

  insert into practice_sessions (user_id, source, subject_node_id, qtypes, difficulty, tag_id, keyword, scored)
  values (v_uid, p_source, p_node_id, p_qtypes, p_difficulty, p_tag_id, v_kw, false)
  returning id, started_at into v_session, v_started;

  -- 顺序：题库列表的顺序（published_at desc，最新入库的在前）。
  -- row_number 在 limit 之前算，所以 seq 正好是 1..N，与卷面顺序一致。
  insert into practice_session_items (session_id, seq, question_id, version_id)
  select v_session,
         row_number() over (order by v.published_at desc nulls last, c.question_id),
         c.question_id, c.version_id
  from public.practice_candidates(
         v_uid, p_source, p_node_id, p_qtypes, p_difficulty, p_tag_id, v_kw, p_question_ids) c
  join question_versions v on v.id = c.version_id
  order by v.published_at desc nulls last, c.question_id
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
    'items', public.practice_session_items_json(v_session),
    'answers', '[]'::jsonb);
end;
$$;

revoke execute on function public.start_sequential_practice(uuid, text[], smallint, uuid, text, integer, text, uuid[]) from public, anon;
grant execute on function public.start_sequential_practice(uuid, text[], smallint, uuid, text, integer, text, uuid[]) to authenticated;
