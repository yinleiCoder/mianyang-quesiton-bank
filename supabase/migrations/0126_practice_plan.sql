-- 0126: 统一抽题计划（FSRS + BKT + 覆盖）
--
-- 一次练习的组成：
--   · 新题/覆盖保底 40%（新题池允许时），按 exposure_count 最少优先；
--   · 到期复习 30%，按 FSRS 可提取性 R 最低优先；
--   · 已掌握题最多 10%，且最长 180 天必再到期（0125 的 max_interval_days）；
--   · 其余按薄弱/最近发展区/信息增益补位；旧题总上限 = 总量 - 新题保底。
-- p_question_ids 非空时完全绕过打分/配额，按调用方数组顺序返回（AI 路径/批量选题）。
--
-- 默认练习与 AI 学习路径共用 practice_plan；start_practice_session 保持 10 参数签名。

create or replace function public.practice_plan(
  p_uid uuid,
  p_source text,
  p_node_id uuid default null,
  p_qtypes text[] default null,
  p_difficulties smallint[] default null,
  p_tag_id uuid default null,
  p_keyword text default null,
  p_question_ids uuid[] default null,
  p_limit int default 20,
  p_allow_same_day boolean default false,
  p_mode text default 'balanced',
  p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 20), 100));
  v_mode text := case
    when p_mode in ('balanced', 'weak', 'review', 'challenge') then p_mode
    else 'balanced'
  end;
  v_plan jsonb;
begin
  with cand as (
    select c.*,
           fs.reviews, fs.stability, fs.difficulty as fsrs_difficulty,
           fs.retrievability, fs.due_at as fsrs_due_at,
           coalesce(ex.exposure_count, 0)::int as exposure_count, ex.last_exposed_at,
           b.p_mastery, b.p_correct, b.info_gain,
           coalesce(b.difficulty, 2) as authored_difficulty,
           coalesce(b.node_name, sn.name) as node_name
    from public.practice_candidates(
      p_uid, p_source, p_node_id, p_qtypes, p_difficulties, p_tag_id, p_keyword, p_question_ids
    ) c
    left join public.practice_fsrs_state(p_uid, p_now) fs on fs.question_id = c.question_id
    left join public.practice_exposure_state(p_uid) ex on ex.question_id = c.question_id
    left join public._my_bkt_items(p_uid, 365, 600) b on b.question_id = c.question_id
    left join public.questions q on q.id = c.question_id
    left join public.subject_nodes sn on sn.id = q.course_node_id
  ),
  scored as (
    select c.*,
           case
             when coalesce(c.reviews, 0) = 0 then 0
             when c.fsrs_due_at <= p_now then 1
             when c.stability >= 30 and coalesce(c.p_mastery, 0) >= 0.80 then 3
             else 2
           end as class_tier,
           case when coalesce(c.reviews, 0) = 0 then 0.5 else coalesce(c.p_mastery, 0.5) end as mastery,
           case when coalesce(c.reviews, 0) = 0 then 0.5 else coalesce(c.p_correct, 0.5) end as pc,
           case when coalesce(c.reviews, 0) = 0 then 0.2 else coalesce(c.info_gain, 0.2) end as ig,
           case when coalesce(c.reviews, 0) = 0 then 0.5 else coalesce(c.retrievability, 0.5) end as r
    from cand c
  ),
  weighted as (
    select s.*,
           case
             when s.class_tier = 0 then 'new_item'
             when s.class_tier = 1 then 'due_review'
             when s.class_tier = 3 then 'mastered'
             when s.mastery < 0.6 then 'weak_node'
             when s.ig >= 0.2 then 'high_info'
             else 'consolidate'
           end as reason_code,
           (case v_mode when 'review' then 0.55 when 'weak' then 0.15 when 'challenge' then 0.20 else 0.38 end) * (1 - s.r)
           + (case v_mode when 'weak' then 0.35 when 'review' then 0.12 when 'challenge' then 0.10 else 0.22 end)
             * greatest(0, (0.8 - s.mastery) / 0.8)
           + (case v_mode when 'challenge' then 0.35 when 'weak' then 0.20 when 'review' then 0.08 else 0.14 end)
             * exp(-power(s.pc - (case when v_mode = 'challenge' then 0.55 else 0.70 end), 2) / (2 * 0.15 * 0.15))
           + (case v_mode when 'challenge' then 0.15 when 'weak' then 0.15 when 'review' then 0.05 else 0.10 end)
             * least(1, greatest(0, s.ig / ln(2)))
           + 0.10 * (1 - least(1, s.exposure_count / 2.0))
           + (case when coalesce(s.reviews, 0) = 0 then 0.06 else 0 end)
           - (case when coalesce(s.reviews, 0) = 0 and s.last_exposed_at >= p_now - interval '3 days' then 0.10 else 0 end)
             as score
    from scored s
  ),
  stats as (
    select count(*)::int as total,
           count(*) filter (where p_allow_same_day or not w.today_done)::int as eligible,
           count(*) filter (where w.today_done)::int as same_day_count,
           min(w.fsrs_due_at) filter (where w.fsrs_due_at > p_now) as next_due_at,
           count(*) filter (
             where coalesce(w.reviews, 0) = 0
               and w.exposure_count = 0
               and (p_allow_same_day or not w.today_done)
           )::int as zero_exposure
    from weighted w
  ),
  quota as (
    select s.*,
           (case when p_source = 'all'
             then least(
               (select count(*) from weighted w
                 where w.class_tier = 0 and (p_allow_same_day or not w.today_done)),
               greatest(1, round(v_limit * 0.40))
             )
             else 0 end)::int as new_floor,
           least(
             (select count(*) from weighted w
               where w.class_tier = 1 and (p_allow_same_day or not w.today_done)),
             greatest(1, round(v_limit * 0.30))
           )::int as due_quota,
           greatest(1, round(v_limit * 0.10))::int as mastered_cap
    from stats s
  ),
  new_pick as (
    select * from (
      select w.*,
             row_number() over (
               order by w.exposure_count,
                        w.last_exposed_at nulls first,
                        md5(w.question_id::text || to_char(p_now, 'YYYY-MM-DD')),
                        w.question_id
             ) as ord
      from weighted w
      where p_question_ids is null
        and (p_allow_same_day or not w.today_done)
        and w.class_tier = 0
    ) x
    where x.ord <= (select new_floor from quota)
  ),
  due_pick as (
    select * from (
      select w.*,
             row_number() over (
               order by w.r asc, w.fsrs_due_at asc, w.question_id
             ) as ord
      from weighted w
      where p_question_ids is null
        and (p_allow_same_day or not w.today_done)
        and w.class_tier = 1
    ) x
    where x.ord <= (select due_quota from quota)
  ),
  filler as (
    select * from (
      select w.*,
             row_number() over (partition by w.class_tier order by w.score desc, w.question_id) as class_rn,
             row_number() over (order by w.score desc, w.question_id) as ord
      from weighted w
      where p_question_ids is null
        and (p_allow_same_day or not w.today_done)
        and not exists (select 1 from new_pick n where n.question_id = w.question_id)
        and not exists (select 1 from due_pick d where d.question_id = w.question_id)
    ) x
    where (x.class_tier <> 3 or x.class_rn <= (select mastered_cap from quota))
      and x.ord <= greatest(
        0,
        v_limit - (select count(*) from new_pick) - (select count(*) from due_pick)
      )
  ),
  picked as (
    select question_id, version_id, qtype, class_tier, score, reason_code,
           mastery, pc, ig, stability, fsrs_difficulty, retrievability,
           exposure_count, last_exposed_at, fsrs_due_at, node_name,
           authored_difficulty, ord, 0 as slot
    from new_pick
    union all
    select question_id, version_id, qtype, class_tier, score, reason_code,
           mastery, pc, ig, stability, fsrs_difficulty, retrievability,
           exposure_count, last_exposed_at, fsrs_due_at, node_name,
           authored_difficulty, ord, 1 as slot
    from due_pick
    union all
    select question_id, version_id, qtype, class_tier, score, reason_code,
           mastery, pc, ig, stability, fsrs_difficulty, retrievability,
           exposure_count, last_exposed_at, fsrs_due_at, node_name,
           authored_difficulty, ord, 2 as slot
    from filler
    union all
    select x.question_id, x.version_id, x.qtype, x.class_tier, x.score, x.reason_code,
           x.mastery, x.pc, x.ig, x.stability, x.fsrs_difficulty, x.retrievability,
           x.exposure_count, x.last_exposed_at, x.fsrs_due_at, x.node_name,
           x.authored_difficulty, x.ord, 0 as slot
    from (
      select distinct on (w.question_id)
             w.*, q.ord::int as ord
      from unnest(p_question_ids) with ordinality q(id, ord)
      join weighted w on w.question_id = q.id
      where p_question_ids is not null
        and (p_allow_same_day or not w.today_done)
        and q.ord <= v_limit
      order by w.question_id, q.ord
    ) x
  )
  select jsonb_build_object(
    'status',
    case
      when (select total from stats) = 0 then 'no_candidates'
      when (select eligible from stats) = 0 then 'nothing_due'
      else 'ok'
    end,
    'summary', jsonb_build_object(
      'total', (select total from stats),
      'eligible', (select eligible from stats),
      'same_day_count', (select same_day_count from stats),
      'next_due_at', (select next_due_at from stats),
      'new_floor', (select new_floor from quota),
      'due_quota', (select due_quota from quota),
      'mastered_cap', (select mastered_cap from quota),
      'old_cap', v_limit - (select new_floor from quota),
      'zero_exposure_count', (select zero_exposure from stats),
      'max_starvation_sessions', case
        when (select new_floor from quota) > 0
          then ceil((select zero_exposure from stats)::numeric / (select new_floor from quota))::int
        else null
      end,
      'algorithm', 'fsrs',
      'fsrs_version', 6,
      'target_retention', 0.90,
      'max_interval_days', (select max_interval_days from public.practice_config)
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'question_id', question_id,
        'version_id', version_id,
        'qtype', qtype,
        'tier', class_tier,
        'score', round(score::numeric, 3),
        'reason_code', reason_code,
        'p_mastery', round(mastery::numeric, 3),
        'p_correct', round(pc::numeric, 3),
        'info_gain', round(ig::numeric, 3),
        'stability', round(stability::numeric, 3),
        'difficulty_fsrs', round(fsrs_difficulty::numeric, 3),
        'retrievability', round(retrievability::numeric, 3),
        'difficulty', authored_difficulty,
        'node_name', node_name,
        'exposure_count', exposure_count,
        'last_exposed_at', last_exposed_at,
        'due_at', fsrs_due_at,
        'ord', ord
      ) order by slot, ord)
      from picked
    ), '[]'::jsonb)
  ) into v_plan;

  return v_plan;
end;
$$;

revoke execute on function public.practice_plan(
  uuid, text, uuid, text[], smallint[], uuid, text, uuid[], int, boolean, text, timestamptz
) from public, anon, authenticated;

-- 默认练习：一次调用 practice_plan；p_question_ids 时 seq 按数组顺序，不重排。
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

  insert into practice_session_items (session_id, seq, question_id, version_id)
  select v_session,
         case
           when p_question_ids is not null then (item ->> 'ord')::int
           else row_number() over (
             order by public.practice_qtype_rank(item ->> 'qtype'), random()
           )
         end,
         (item ->> 'question_id')::uuid,
         (item ->> 'version_id')::uuid
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

-- AI 学习路径：复用同一个 practice_plan，item_ids 严格等于计划顺序。
create or replace function public.my_recommended_practice(
  p_limit int default 20,
  p_node_id uuid default null,
  p_mode text default 'balanced')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_limit int := greatest(5, least(coalesce(p_limit, 20), 60));
  v_plan jsonb;
  v_status text;
  v_ids jsonb;
  v_stages jsonb;
begin
  v_plan := public.practice_plan(
    v_uid, 'all', p_node_id, null, null, null, null, null,
    v_limit, false, p_mode, now()
  );
  v_status := v_plan ->> 'status';

  if v_status <> 'ok' then
    return jsonb_build_object(
      'status', v_status,
      'generated_at', now(),
      'next_due_at', v_plan -> 'summary' ->> 'next_due_at',
      'model', jsonb_build_object('name', 'FSRS+BKT', 'fsrs_version', 6),
      'summary', (v_plan -> 'summary') || jsonb_build_object(
        'items_considered', (v_plan -> 'summary' ->> 'total')::int,
        'limit', v_limit,
        'overall_mastery', null
      ),
      'stages', '[]'::jsonb,
      'item_ids', '[]'::jsonb,
      'cold_start', true
    );
  end if;

  select coalesce(jsonb_agg(item ->> 'question_id'), '[]'::jsonb)
  into v_ids
  from jsonb_array_elements(v_plan -> 'items') item;

  select coalesce(jsonb_agg(jsonb_build_object(
    'key', s.stage_key,
    'title', s.title,
    'description', s.description,
    'items', s.items
  ) order by s.ord), '[]'::jsonb)
  into v_stages
  from (
    select
      case (item ->> 'tier')::int
        when 0 then 'foundation'
        when 1 then 'due_review'
        when 2 then 'consolidate'
        else 'challenge'
      end as stage_key,
      case (item ->> 'tier')::int
        when 0 then '补齐薄弱基础'
        when 1 then '到期复习'
        when 2 then '巩固易错点'
        else '迁移与挑战'
      end as title,
      case (item ->> 'tier')::int
        when 0 then '新题/覆盖优先，先把没见过的题补上'
        when 1 then 'FSRS 可提取性低于目标的题，优先复习'
        when 2 then '已练但未到期，按薄弱/信息量补位'
        else '已掌握题，低频保持'
      end as description,
      case (item ->> 'tier')::int when 0 then 1 when 1 then 2 when 2 then 3 else 4 end as ord,
      jsonb_agg(item order by (item ->> 'score')::numeric desc) as items
    from jsonb_array_elements(v_plan -> 'items') item
    group by 1, 2, 3, 4
  ) s;

  return jsonb_build_object(
    'status', 'ok',
    'generated_at', now(),
    'cold_start', false,
    'model', jsonb_build_object(
      'name', 'FSRS+BKT',
      'fsrs_version', 6,
      'target_retention', 0.90,
      'max_interval_days', (v_plan -> 'summary' ->> 'max_interval_days')::int
    ),
    'summary', (v_plan -> 'summary') || jsonb_build_object(
      'items_considered', (v_plan -> 'summary' ->> 'total')::int,
      'limit', v_limit,
      'overall_mastery', null
    ),
    'stages', v_stages,
    'item_ids', v_ids
  );
end;
$$;

revoke execute on function public.my_recommended_practice(int, uuid, text) from public, anon;
grant execute on function public.my_recommended_practice(int, uuid, text) to authenticated;

notify pgrst, 'reload schema';
