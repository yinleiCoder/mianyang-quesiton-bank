-- 0029: 刷题练习 RPC（判分 / 组卷 / 作答 / 交卷 / 统计 / 错题本 / 收藏 / 全站正确率）。
-- 设计要点：
--   · 判分以服务端为权威（grade_answer）；Dart 端镜像同一规则做即时反馈，落库以本函数返回为准；
--   · 组卷固定 version_id 快照，题目内容随响应返回（客户端无需再查 question_versions）；
--   · 抽题显式复刻"已入库且上线"可见性谓词（DEFINER 不受 RLS 约束，必须自己写全）；
--   · 主观题为自评（grading='self'，is_correct=self_mastered）；"不会"（unknown）计一次作答且判错；
--   · 全站正确率仅聚合 grading='auto' 的作答（自评不计入，防刷），且只返回聚合值；
--   · 练习对全体登录用户开放（学生可用），不加 is_teacher 断言；写路径全部 DEFINER + require_uid。

-- =====================================================================
-- 1) 判分纯函数（服务端权威口径）
-- =====================================================================

-- 归一化：去首尾空白、去掉所有空白字符、小写、全角数字/字母/常用标点转半角
create or replace function public.norm_answer_text(p text)
returns text
language sql
immutable
set search_path = public
as $$
  select regexp_replace(
           lower(
             translate(
               translate(coalesce(p, ''),
                 '０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ',
                 '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'),
               '。，！？；：（）《》【】、—',
               '.,!?;:()<>[],-')
           ),
           '\s+', '', 'g');
$$;

-- 判分：返回 null 表示"该题型不由本函数判定"（主观题走自评）
create or replace function public.grade_answer(p_qtype text, p_content jsonb, p_answer jsonb)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  v_type text := coalesce(p_answer ->> 'type', '');
  v_keys text[];
  v_expected_keys text[];
  v_vals text[];
  v_expected text[];
  v_subs jsonb;
  v_sub_ans jsonb;
  v_sub_type text;
  i int;
begin
  -- 不会 / 空作答
  if v_type = '' or v_type = 'unknown' then
    return false;
  end if;

  if p_qtype in ('single_choice', 'multiple_choice') then
    if v_type <> 'choice' then return false; end if;
    select coalesce(array_agg(upper(btrim(x)) order by upper(btrim(x))), '{}'::text[])
      into v_keys
      from jsonb_array_elements_text(coalesce(p_answer -> 'keys', '[]'::jsonb)) x;
    select coalesce(array_agg(upper(btrim(x)) order by upper(btrim(x))), '{}'::text[])
      into v_expected_keys
      from jsonb_array_elements_text(coalesce(p_content -> 'answer' -> 'keys', '[]'::jsonb)) x;
    if v_expected_keys = '{}'::text[] or v_keys = '{}'::text[] then
      return false;
    end if;
    return v_keys = v_expected_keys;

  elsif p_qtype = 'true_false' then
    if v_type <> 'tf' then return false; end if;
    return coalesce(p_answer ->> 'value', '') <> ''
       and (p_answer ->> 'value') = (p_content -> 'answer' ->> 'value');

  elsif p_qtype = 'fill_blank' then
    if v_type <> 'blank' then return false; end if;
    select coalesce(array_agg(public.norm_answer_text(x)), '{}'::text[])
      into v_vals
      from jsonb_array_elements_text(coalesce(p_answer -> 'values', '[]'::jsonb)) x;
    select coalesce(array_agg(public.norm_answer_text(x)), '{}'::text[])
      into v_expected
      from jsonb_array_elements_text(coalesce(p_content -> 'answer' -> 'values', '[]'::jsonb)) x;
    if coalesce(array_length(v_expected, 1), 0) = 0
       or array_length(v_vals, 1) is distinct from array_length(v_expected, 1) then
      return false;
    end if;
    for i in 1 .. array_length(v_expected, 1) loop
      if v_vals[i] is null or v_vals[i] = '' or v_vals[i] <> v_expected[i] then
        return false;
      end if;
    end loop;
    return true;

  elsif p_qtype = 'short_answer' then
    -- 主观题由自评决定，不由本函数判定
    return null;

  elsif p_qtype = 'composite' then
    if v_type <> 'composite' then return false; end if;
    v_subs := coalesce(p_content -> 'sub', '[]'::jsonb);
    if jsonb_array_length(v_subs) = 0 then return false; end if;
    for i in 0 .. jsonb_array_length(v_subs) - 1 loop
      v_sub_type := v_subs -> i ->> 'type';
      v_sub_ans := coalesce(p_answer -> 'subs' -> i, '{}'::jsonb);
      if v_sub_type = 'short_answer' then
        -- 子题为主观题：自评结果代入（mastered=true 视为该子题正确）
        if coalesce(v_sub_ans ->> 'mastered', '') <> 'true' then
          return false;
        end if;
      else
        if public.grade_answer(v_sub_type, v_subs -> i, v_sub_ans) is not true then
          return false;
        end if;
      end if;
    end loop;
    return true;
  end if;

  return false;
end;
$$;

-- =====================================================================
-- 2) 内部助手：会话题目快照（含内容），仅供本文件的 RPC 调用
-- =====================================================================
create or replace function public.practice_session_items_json(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'seq', i.seq,
           'question_id', i.question_id,
           'version_id', i.version_id,
           'qtype', v.qtype,
           'difficulty', v.difficulty,
           'course_node_id', q.course_node_id,
           'content', v.content) order by i.seq), '[]'::jsonb)
  from practice_session_items i
  join question_versions v on v.id = i.version_id
  join questions q on q.id = i.question_id
  where i.session_id = p_session_id;
$$;

-- =====================================================================
-- 3) 组卷 / 续练 / 作答 / 交卷
-- =====================================================================

-- 开始一套练习：按筛选抽题（默认 20 题），返回会话与题目快照
create or replace function public.start_practice_session(
  p_node_id uuid default null,
  p_qtypes text[] default null,
  p_difficulty smallint default null,
  p_tag_id uuid default null,
  p_keyword text default null,
  p_limit int default 20,
  p_source text default 'all')
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

-- 读取会话（"继续练习"）：题目快照 + 已作答记录
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

-- 提交单题作答（可改答，取最后一次；服务端判分）
create or replace function public.submit_practice_answer(
  p_session_id uuid,
  p_question_id uuid,
  p_answer jsonb,
  p_duration_ms bigint default 0,
  p_self_mastered boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_session practice_sessions%rowtype;
  v_item practice_session_items%rowtype;
  v_qtype text;
  v_content jsonb;
  v_grading text := 'auto';
  v_correct boolean;
begin
  select * into v_session from practice_sessions where id = p_session_id and user_id = v_uid;
  if not found then
    raise exception '练习会话不存在或不属于你';
  end if;
  if v_session.status <> 'active' then
    raise exception '本次练习已结束，无法继续作答';
  end if;
  select * into v_item from practice_session_items
  where session_id = p_session_id and question_id = p_question_id;
  if not found then
    raise exception '题目不在本次练习中';
  end if;
  select qtype, content into v_qtype, v_content
  from question_versions where id = v_item.version_id;

  if v_qtype = 'short_answer' then
    if p_self_mastered is null then
      raise exception '主观题请先自评是否掌握';
    end if;
    v_grading := 'self';
    v_correct := p_self_mastered;
  elsif coalesce(p_answer ->> 'type', '') = 'unknown' then
    v_correct := false;  -- 不会：计一次作答并判错
  else
    v_correct := public.grade_answer(v_qtype, v_content, coalesce(p_answer, '{}'::jsonb));
  end if;

  insert into practice_answers (session_id, user_id, question_id, version_id, answer,
                                grading, is_correct, self_mastered, duration_ms, answered_at)
  values (p_session_id, v_uid, p_question_id, v_item.version_id, coalesce(p_answer, '{}'::jsonb),
          v_grading, v_correct, p_self_mastered, greatest(coalesce(p_duration_ms, 0), 0), now())
  on conflict (session_id, question_id) do update
  set answer = excluded.answer,
      grading = excluded.grading,
      is_correct = excluded.is_correct,
      self_mastered = excluded.self_mastered,
      duration_ms = excluded.duration_ms,
      answered_at = excluded.answered_at;

  update practice_sessions s
  set answered_count = (select count(*) from practice_answers a where a.session_id = s.id),
      correct_count = (select count(*) from practice_answers a where a.session_id = s.id and a.is_correct)
  where s.id = p_session_id;

  return jsonb_build_object(
    'is_correct', v_correct,
    'grading', v_grading,
    'correct_answer', v_content -> 'answer');
end;
$$;

-- 交卷：结算本次练习
create or replace function public.finish_practice_session(p_session_id uuid, p_duration_ms bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_session practice_sessions%rowtype;
  v_answered int;
  v_correct int;
  v_dur bigint;
begin
  select * into v_session from practice_sessions where id = p_session_id and user_id = v_uid;
  if not found then
    raise exception '练习会话不存在或不属于你';
  end if;
  if v_session.status <> 'active' then
    raise exception '本次练习已交卷或已作废';
  end if;

  select count(*), count(*) filter (where is_correct)
    into v_answered, v_correct
  from practice_answers where session_id = p_session_id;

  v_dur := greatest(coalesce(
    p_duration_ms,
    (extract(epoch from (now() - v_session.started_at)) * 1000)::bigint), 0);

  update practice_sessions
  set status = 'submitted',
      submitted_at = now(),
      duration_ms = v_dur,
      answered_count = v_answered,
      correct_count = v_correct
  where id = p_session_id;

  return jsonb_build_object(
    'total', v_session.total_count,
    'answered', v_answered,
    'correct', v_correct,
    'wrong', v_answered - v_correct,
    'omitted', v_session.total_count - v_answered,
    'accuracy', case when v_session.total_count > 0
                     then round(v_correct::numeric / v_session.total_count, 4) else 0 end,
    'duration_ms', v_dur);
end;
$$;

-- 放弃当前练习
create or replace function public.abandon_practice_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  update practice_sessions set status = 'abandoned'
  where id = p_session_id and user_id = v_uid and status = 'active';
end;
$$;

-- =====================================================================
-- 4) 统计 / 错题本 / 收藏 / 全站正确率
-- =====================================================================

-- 工作台总览：累计统计 + 进行中会话 + 最近作答
create or replace function public.practice_overview()
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
begin
  select count(*), count(*) filter (where is_correct),
         count(*) filter (where answered_at >= date_trunc('day', now())),
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

  return jsonb_build_object(
    'total_answers', v_total,
    'correct_answers', v_correct,
    'accuracy', case when v_total > 0 then round(v_correct::numeric / v_total, 4) else 0 end,
    'today_answers', v_today,
    'total_duration_ms', v_dur,
    'wrong_count', v_wrong,
    'favorite_count', v_fav,
    'active_session', v_active,
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

-- 错题本：本人最近一次作答为错的题（题目已下线时不返回题干内容）
create or replace function public.list_my_wrong_questions(p_limit int default 20, p_offset int default 0)
returns table(question_id uuid, version_id uuid, qtype text, difficulty smallint,
              answered_at timestamptz, wrong_count bigint, stem_text text, available boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  return query
  select l.question_id,
         coalesce(cv.id, l.version_id),
         coalesce(cv.qtype, lv.qtype),
         coalesce(cv.difficulty, lv.difficulty),
         l.answered_at,
         (select count(*) from practice_answers a
           where a.user_id = v_uid and a.question_id = l.question_id and a.is_correct is not true),
         case when cv.id is not null then left(coalesce(cv.search_text, ''), 120) end,
         (cv.id is not null)
  from (
    select distinct on (a.question_id) a.question_id, a.version_id, a.is_correct, a.answered_at
    from practice_answers a
    where a.user_id = v_uid
    order by a.question_id, a.answered_at desc) l
  join question_versions lv on lv.id = l.version_id
  left join questions q on q.id = l.question_id
    and q.state = 'live' and q.current_published_version_id is not null
  left join question_versions cv on cv.id = q.current_published_version_id and cv.status = 'published'
  where l.is_correct is not true
  order by l.answered_at desc
  limit greatest(coalesce(p_limit, 20), 1) offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- 收藏列表（题目已下线时保留占位，可取消收藏）
create or replace function public.list_my_favorites(p_limit int default 20, p_offset int default 0)
returns table(question_id uuid, version_id uuid, qtype text, difficulty smallint,
              created_at timestamptz, stem_text text, available boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  return query
  select f.question_id,
         cv.id,
         coalesce(cv.qtype, lv.qtype),
         coalesce(cv.difficulty, lv.difficulty),
         f.created_at,
         case when cv.id is not null then left(coalesce(cv.search_text, ''), 120) end,
         (cv.id is not null)
  from question_favorites f
  left join questions q on q.id = f.question_id
  left join question_versions cv on cv.id = q.current_published_version_id
    and q.state = 'live' and cv.status = 'published'
  left join lateral (
    select v2.qtype, v2.difficulty
    from question_versions v2
    where v2.question_id = f.question_id
    order by v2.version_no desc
    limit 1) lv on true
  where f.user_id = v_uid
  order by f.created_at desc
  limit greatest(coalesce(p_limit, 20), 1) offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- 收藏 / 取消收藏（仅已入库且在线的题目），返回新状态
create or replace function public.toggle_favorite(p_question_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not exists (
    select 1 from questions q
    join question_versions v on v.id = q.current_published_version_id
    where q.id = p_question_id and q.state = 'live' and v.status = 'published'
  ) then
    raise exception '只能收藏已入库且在线的题目';
  end if;

  if exists (select 1 from question_favorites where user_id = v_uid and question_id = p_question_id) then
    delete from question_favorites where user_id = v_uid and question_id = p_question_id;
    return false;
  end if;
  insert into question_favorites (user_id, question_id) values (v_uid, p_question_id);
  return true;
end;
$$;

-- 全站正确率（仅聚合值；自评题不计入）
create or replace function public.question_accuracy(p_question_ids uuid[])
returns table(question_id uuid, attempts bigint, correct bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  perform v_uid;
  if p_question_ids is null or coalesce(array_length(p_question_ids, 1), 0) = 0 then
    return;
  end if;
  if array_length(p_question_ids, 1) > 200 then
    raise exception '一次最多查询 200 道题的正确率';
  end if;
  return query
    select a.question_id,
           count(*)::bigint,
           (count(*) filter (where a.is_correct))::bigint
    from practice_answers a
    where a.question_id = any(p_question_ids)
      and a.grading = 'auto'
    group by a.question_id;
end;
$$;

-- =====================================================================
-- 5) 授权：仅 authenticated 可执行；内部助手不对外开放
-- =====================================================================
revoke execute on function public.norm_answer_text(text) from public, anon, authenticated;
revoke execute on function public.grade_answer(text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.practice_session_items_json(uuid) from public, anon, authenticated;

revoke execute on function public.start_practice_session(uuid, text[], smallint, uuid, text, int, text) from public, anon;
revoke execute on function public.get_practice_session(uuid) from public, anon;
revoke execute on function public.submit_practice_answer(uuid, uuid, jsonb, bigint, boolean) from public, anon;
revoke execute on function public.finish_practice_session(uuid, bigint) from public, anon;
revoke execute on function public.abandon_practice_session(uuid) from public, anon;
revoke execute on function public.practice_overview() from public, anon;
revoke execute on function public.list_my_wrong_questions(int, int) from public, anon;
revoke execute on function public.list_my_favorites(int, int) from public, anon;
revoke execute on function public.toggle_favorite(uuid) from public, anon;
revoke execute on function public.question_accuracy(uuid[]) from public, anon;

grant execute on function public.start_practice_session(uuid, text[], smallint, uuid, text, int, text) to authenticated;
grant execute on function public.get_practice_session(uuid) to authenticated;
grant execute on function public.submit_practice_answer(uuid, uuid, jsonb, bigint, boolean) to authenticated;
grant execute on function public.finish_practice_session(uuid, bigint) to authenticated;
grant execute on function public.abandon_practice_session(uuid) to authenticated;
grant execute on function public.practice_overview() to authenticated;
grant execute on function public.list_my_wrong_questions(int, int) to authenticated;
grant execute on function public.list_my_favorites(int, int) to authenticated;
grant execute on function public.toggle_favorite(uuid) to authenticated;
grant execute on function public.question_accuracy(uuid[]) to authenticated;
