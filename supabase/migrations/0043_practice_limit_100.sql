-- 0043: 练习题量上限 50 → 100。
--
-- 客户端把组卷页的「题量」从 ±5 的步进器换成滑杆（上限 100），服务端这道校验必须同步放开，
-- 否则用户拖到 100 会被 '题量需在 1~50 之间' 顶回来。
--
-- 抽到的题不足申请量不是错误：三个分支都是 `limit p_limit`，有多少给多少
-- （题库一共才 7 道时选 100 就是 7 道）；一道都没有才 raise '没有符合条件的题目'。
--
-- 本函数的最新版在 0030（新增 p_question_ids 参数），不是 0029 —— 所以下面按**线上定义**
-- 整体覆盖，只改题量那两行（0026 误用旧版覆盖新版的坑，见 AGENTS.md）。

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
