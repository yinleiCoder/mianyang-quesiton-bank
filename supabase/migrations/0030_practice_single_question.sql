-- 0030: 组卷支持指定题目（题库详情「练这道题」/ 错题与收藏按题目 id 精练）。
-- 在 0029 的 start_practice_session 基础上新增 p_question_ids 参数：
--   非空时仅从给定题目中抽取（仍要求 live + current published + published 版本）；
-- 签名变化需先 drop 旧函数再建新函数（PostgREST 按参数名调用，避免重载歧义），随后重授执行权。

drop function if exists public.start_practice_session(uuid, text[], smallint, uuid, text, int, text);

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
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception '题量需在 1~50 之间';
  end if;
  if p_source is null or p_source not in ('all', 'wrong', 'favorites') then
    raise exception '未知的练习来源';
  end if;

  -- 之前的进行中会话作废（每人同时至多一套进行中）
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
      select q.id as question_id, v.id as version_id
      from questions q
      join question_versions v on v.id = q.current_published_version_id
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
      order by random()
      limit p_limit
    )
    insert into practice_session_items (session_id, seq, question_id, version_id)
    select v_session, row_number() over (), question_id, version_id from cand;

  elsif p_source = 'wrong' then
    with latest as (
      select distinct on (a.question_id) a.question_id, a.is_correct
      from practice_answers a
      where a.user_id = v_uid
      order by a.question_id, a.answered_at desc
    ), cand as (
      select q.id as question_id, v.id as version_id
      from latest l
      join questions q on q.id = l.question_id
        and q.state = 'live' and q.current_published_version_id is not null
      join question_versions v on v.id = q.current_published_version_id and v.status = 'published'
      where l.is_correct is not true
      order by random()
      limit p_limit
    )
    insert into practice_session_items (session_id, seq, question_id, version_id)
    select v_session, row_number() over (), question_id, version_id from cand;

  else
    with cand as (
      select q.id as question_id, v.id as version_id
      from question_favorites f
      join questions q on q.id = f.question_id
        and q.state = 'live' and q.current_published_version_id is not null
      join question_versions v on v.id = q.current_published_version_id and v.status = 'published'
      where f.user_id = v_uid
      order by random()
      limit p_limit
    )
    insert into practice_session_items (session_id, seq, question_id, version_id)
    select v_session, row_number() over (), question_id, version_id from cand;
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

revoke execute on function public.start_practice_session(uuid, text[], smallint, uuid, text, int, text, uuid[]) from public, anon;
grant execute on function public.start_practice_session(uuid, text[], smallint, uuid, text, int, text, uuid[]) to authenticated;
