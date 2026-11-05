-- 0137: 练习会话记录「为什么推这道题」的依据
--
-- practice_plan（0126）已经为每道题算出 reason_code / p_mastery / due_at / node_name，
-- 但 start_practice_session 只把 question_id/version_id 写进 practice_session_items，
-- 学生端拿不到推荐原因。本次：
--   · 给 practice_session_items 加四列（可空，旧会话/顺序练习不带原因）；
--   · start_practice_session 在插入题目时把 plan 里的原因一起写入；
--   · 新增 practice_session_reasons(p_session_id)：只允许会话本人读，返回逐题原因。
-- 不改 practice_session_items_json / get_practice_session 的返回形状，客户端可渐进接入。
--
-- 顺序练习（start_sequential_practice）不经过 practice_plan，保持原样。

alter table public.practice_session_items
  add column if not exists reason_code text,
  add column if not exists p_mastery numeric,
  add column if not exists due_at timestamptz,
  add column if not exists node_name text;

create or replace function public.start_practice_session(
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
  v_plan jsonb;
  v_status text;
  v_session uuid;
  v_started timestamptz;
  v_count int;
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
  v_difficulties := coalesce(
    p_difficulties,
    case when p_difficulty is null then null else array[p_difficulty] end
  );

  v_plan := public.practice_plan(
    v_uid, p_source, p_node_id, p_qtypes, v_difficulties, p_tag_id, v_kw,
    p_question_ids, p_limit, p_allow_same_day, 'balanced', now()
  );
  v_status := v_plan ->> 'status';

  if v_status = 'no_candidates' then
    raise exception '没有符合条件的题目';
  end if;
  if v_status = 'nothing_due' then
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
      'next_due_at', v_plan -> 'summary' ->> 'next_due_at',
      'same_day_count', (v_plan -> 'summary' ->> 'same_day_count')::int
    );
  end if;

  update practice_sessions set status = 'abandoned'
  where user_id = v_uid and status = 'active';

  insert into practice_sessions (user_id, source, subject_node_id, qtypes, difficulty, tag_id, keyword)
  values (v_uid, p_source, p_node_id, p_qtypes, v_difficulties, p_tag_id, v_kw)
  returning id, started_at into v_session, v_started;

  insert into practice_session_items
    (session_id, seq, question_id, version_id, reason_code, p_mastery, due_at, node_name)
  select v_session,
         case
           when p_question_ids is not null then (item ->> 'ord')::int
           else row_number() over (
             order by public.practice_qtype_rank(item ->> 'qtype'), random()
           )
         end,
         (item ->> 'question_id')::uuid,
         (item ->> 'version_id')::uuid,
         nullif(item ->> 'reason_code', ''),
         (item ->> 'p_mastery')::numeric,
         (item ->> 'due_at')::timestamptz,
         nullif(item ->> 'node_name', '')
  from jsonb_array_elements(v_plan -> 'items') item;

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
    'answers', '[]'::jsonb,
    'algorithm', 'fsrs',
    'plan_summary', v_plan -> 'summary'
  );
end;
$$;

create or replace function public.practice_session_reasons(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not exists (
    select 1 from public.practice_sessions
    where id = p_session_id and user_id = v_uid
  ) then
    raise exception '会话不存在或不属于你' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'question_id', i.question_id,
             'seq', i.seq,
             'reason_code', i.reason_code,
             'p_mastery', i.p_mastery,
             'due_at', i.due_at,
             'node_name', i.node_name) order by i.seq)
    from public.practice_session_items i
    where i.session_id = p_session_id and i.reason_code is not null
  ), '[]'::jsonb);
end;
$$;

comment on function public.practice_session_reasons(uuid) is
  '练习会话的逐题推荐依据（reason_code/p_mastery/due_at/node_name）；只允许会话本人读。';

revoke execute on function public.practice_session_reasons(uuid) from public, anon;
grant execute on function public.practice_session_reasons(uuid) to authenticated;

notify pgrst, 'reload schema';
