-- 0122: 贝叶斯知识追踪（BKT）与推荐练习（只读）。
--
-- 为什么按题目级而不是标签级：
--   全库只有 10 个扁平标签，一个标签混了许多题；直接按标签做 BKT 会违反局部独立性，
--   估计不稳。这里把每题作为一个原子技能，再把掌握度按课程节点/标签聚合；
--   标签只在 sum(attempts) >= 5 时展示结论。
--
-- 模型：
--   P(L) 为掌握概率；p_L0 由题目全局正确率向 Beta 先验收缩；
--   p_G 为猜对概率（选择题 1/选项数、判断题 0.5、填空/简答/复合 0.05）；
--   p_S=0.10（失误）、p_T=0.15（学习转移）。
--   答对/答错更新后验，再走学习转移；信息增益只算观测对当前状态的互信息
--  （不把学习转移的熵增算进去），因此恒为非负。
--
-- 隐私：两个公开 RPC 只返回本人数据；不返回题干、选项、答案、解析。

-- ---------- 纯函数：熵、一次 BKT 更新、信息增益 ----------
create or replace function public.bkt_entropy(p double precision)
returns double precision
language sql
immutable
as $$
  select case
    when p is null or p <= 0 or p >= 1 then 0
    else -p * ln(p) - (1 - p) * ln(1 - p)
  end;
$$;

create or replace function public.bkt_after(
  p double precision,
  correct boolean,
  g double precision,
  s double precision default 0.10,
  t double precision default 0.15)
returns double precision
language plpgsql
immutable
as $$
declare
  posterior double precision;
begin
  if p is null then
    return null;
  end if;
  if correct then
    posterior := (p * (1 - s)) / nullif(p * (1 - s) + (1 - p) * g, 0);
  else
    posterior := (p * s) / nullif(p * s + (1 - p) * (1 - g), 0);
  end if;
  return posterior + (1 - posterior) * t;
end;
$$;

create or replace function public.bkt_info_gain(
  p double precision,
  g double precision,
  s double precision default 0.10,
  t double precision default 0.15)
returns double precision
language plpgsql
immutable
as $$
declare
  p_correct double precision;
  p_after_correct double precision;
  p_after_wrong double precision;
  expected double precision;
begin
  if p is null then
    return null;
  end if;
  p_correct := p * (1 - s) + (1 - p) * g;
  -- 后验（不含学习转移）：观测本身对隐状态的信息量
  p_after_correct := (p * (1 - s)) / nullif(p * (1 - s) + (1 - p) * g, 0);
  p_after_wrong := (p * s) / nullif(p * s + (1 - p) * (1 - g), 0);
  expected := p_correct * public.bkt_entropy(p_after_correct)
            + (1 - p_correct) * public.bkt_entropy(p_after_wrong);
  return greatest(0, public.bkt_entropy(p) - expected);
end;
$$;

revoke execute on function public.bkt_entropy(double precision) from public, anon, authenticated;
revoke execute on function public.bkt_after(double precision, boolean, double precision, double precision, double precision)
  from public, anon, authenticated;
revoke execute on function public.bkt_info_gain(double precision, double precision, double precision, double precision)
  from public, anon, authenticated;

-- ---------- 内部：当前用户的题目级 BKT 状态 ----------
-- 注意：#variable_conflict use_column 必须保留。RETURNS TABLE 的 OUT 参数
-- question_id 与 SQL 列名同名，没有它 PL/pgSQL 会报 "column reference is ambiguous"。
create or replace function public._my_bkt_items(
  p_uid uuid,
  p_days int default 365,
  p_max_items int default 600)
returns table (
  question_id uuid,
  version_id uuid,
  qtype text,
  difficulty smallint,
  node_id uuid,
  node_name text,
  tag_ids uuid[],
  attempts int,
  correct int,
  last_at timestamptz,
  p_mastery double precision,
  p_correct double precision,
  info_gain double precision,
  due_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_days int := greatest(1, least(coalesce(p_days, 365), 3650));
  v_max int := greatest(1, least(coalesce(p_max_items, 600), 2000));
begin
  return query
  with recursive my as (
    select a.question_id,
           count(*)::int as attempts,
           count(*) filter (where a.is_correct)::int as correct,
           max(a.answered_at) as last_at
    from public.practice_answers a
    where a.user_id = p_uid
      and a.grading = 'auto'
      and a.is_correct is not null
      and a.answered_at >= now() - make_interval(days => v_days)
    group by a.question_id
    order by max(a.answered_at) desc
    limit v_max
  ),
  meta as (
    select m.question_id,
           m.attempts,
           m.correct,
           m.last_at,
           v.id as version_id,
           v.qtype,
           v.difficulty,
           q.course_node_id as node_id,
           sn.name as node_name,
           case when jsonb_typeof(v.content -> 'options') = 'array'
                then jsonb_array_length(v.content -> 'options') else 0 end as option_count,
           coalesce((
             select array_agg(vt.tag_id)
             from public.version_tags vt
             where vt.version_id = v.id
           ), '{}'::uuid[]) as tag_ids,
           coalesce(gs.n, 0) as global_n,
           coalesce(gs.c, 0) as global_c
    from my m
    join public.questions q on q.id = m.question_id
    join public.question_versions v on v.id = q.current_published_version_id
    left join public.subject_nodes sn on sn.id = q.course_node_id
    left join (
      select a.question_id,
             count(*)::int as n,
             count(*) filter (where a.is_correct)::int as c
      from public.practice_answers a
      where a.grading = 'auto'
        and a.is_correct is not null
        and a.question_id in (select m2.question_id from my m2)
      group by a.question_id
    ) gs on gs.question_id = m.question_id
  ),
  shaped as (
    select meta.*,
           least(0.90, greatest(0.05,
             (global_c + 0.6)::double precision / (global_n + 2)::double precision
           )) as p_l0,
           case
             when qtype in ('single_choice', 'multiple_choice')
               then 1.0 / greatest(option_count, 2)::double precision
             when qtype = 'true_false' then 0.5
             else 0.05
           end as p_g
    from meta
  ),
  seq as (
    select a.question_id,
           a.is_correct,
           a.answered_at,
           row_number() over (partition by a.question_id order by a.answered_at) as rn
    from public.practice_answers a
    where a.user_id = p_uid
      and a.grading = 'auto'
      and a.is_correct is not null
      and a.question_id in (select m2.question_id from my m2)
      and a.answered_at >= now() - make_interval(days => v_days)
  ),
  bkt as (
    select s.question_id,
           s.rn,
           public.bkt_after(m.p_l0, s.is_correct, m.p_g, 0.10, 0.15) as p
    from seq s
    join shaped m on m.question_id = s.question_id
    where s.rn = 1
    union all
    select s.question_id,
           s.rn,
           public.bkt_after(b.p, s.is_correct, m.p_g, 0.10, 0.15)
    from bkt b
    join seq s on s.question_id = b.question_id and s.rn = b.rn + 1
    join shaped m on m.question_id = s.question_id
  ),
  final as (
    select distinct on (b.question_id)
           b.question_id,
           b.p
    from bkt b
    order by b.question_id, b.rn desc
  )
  select m.question_id,
         m.version_id,
         m.qtype,
         m.difficulty,
         m.node_id,
         m.node_name,
         m.tag_ids,
         m.attempts,
         m.correct,
         m.last_at,
         f.p as p_mastery,
         (f.p * (1 - 0.10) + (1 - f.p) * m.p_g) as p_correct,
         public.bkt_info_gain(f.p, m.p_g, 0.10, 0.15) as info_gain,
         rs.due_at
  from shaped m
  join final f on f.question_id = m.question_id
  left join public.practice_review_state(p_uid) rs on rs.question_id = m.question_id;
end;
$$;

revoke execute on function public._my_bkt_items(uuid, int, int) from public, anon, authenticated;

-- ---------- 公开：掌握度画像 ----------
create or replace function public.my_bkt_profile(
  p_days int default 365,
  p_max_items int default 600)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_days int := greatest(1, least(coalesce(p_days, 365), 3650));
  v_items_count int;
  v_overall double precision;
  v_nodes jsonb;
  v_tags jsonb;
begin
  with items as (
    select * from public._my_bkt_items(v_uid, v_days, p_max_items)
  ),
  counted as (
    select count(*)::int as n,
           case when sum(1 + least(attempts, 3)) > 0
             then sum(p_mastery * (1 + least(attempts, 3))) / sum(1 + least(attempts, 3))
             else null end as overall
    from items
  )
  select n, overall into v_items_count, v_overall from counted;

  with items as (
    select * from public._my_bkt_items(v_uid, v_days, p_max_items)
  ),
  node_agg as (
    select node_id,
           node_name,
           count(*)::int as attempted_items,
           sum(1 + least(attempts, 3)) as weight,
           sum(p_mastery * (1 + least(attempts, 3))) / sum(1 + least(attempts, 3)) as mastery
    from items
    where node_id is not null
    group by node_id, node_name
  ),
  node_totals as (
    select q.course_node_id as node_id, count(*)::int as total_items
    from public.questions q
    join public.question_versions v on v.id = q.current_published_version_id
    where q.state = 'live' and v.status = 'published'
    group by q.course_node_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'node_id', n.node_id,
    'node_name', n.node_name,
    'mastery', round(n.mastery::numeric, 3),
    'attempted_items', n.attempted_items,
    'total_items', coalesce(t.total_items, 0),
    'coverage', case when coalesce(t.total_items, 0) > 0
      then round(n.attempted_items::numeric / t.total_items, 3) else null end
  ) order by n.mastery asc), '[]'::jsonb)
  into v_nodes
  from node_agg n
  left join node_totals t using (node_id);

  with items as (
    select * from public._my_bkt_items(v_uid, v_days, p_max_items)
  ),
  tag_rows as (
    select it.question_id, it.attempts, it.p_mastery, u.tag_id
    from items it
    cross join lateral unnest(it.tag_ids) as u(tag_id)
  ),
  tag_agg as (
    select tag_id,
           sum(attempts)::int as attempts,
           count(*)::int as items,
           sum(1 + least(attempts, 3)) as weight,
           sum(p_mastery * (1 + least(attempts, 3))) / sum(1 + least(attempts, 3)) as mastery
    from tag_rows
    group by tag_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'tag_id', a.tag_id,
    'tag_name', t.name,
    'mastery', round(a.mastery::numeric, 3),
    'attempts', a.attempts,
    'items', a.items,
    'insufficient', a.attempts < 5
  ) order by a.mastery asc), '[]'::jsonb)
  into v_tags
  from tag_agg a
  join public.tags t on t.id = a.tag_id;

  return jsonb_build_object(
    'generated_at', now(),
    'cold_start', coalesce(v_items_count, 0) = 0,
    'model', jsonb_build_object(
      'name', 'BKT',
      'p_t', 0.15,
      'p_s', 0.10,
      'p_l0', '题目全局正确率向 Beta 先验收缩',
      'window_days', v_days
    ),
    'overall_mastery', case when v_overall is null then null else round(v_overall::numeric, 3) end,
    'nodes', v_nodes,
    'tags', v_tags,
    'items_count', coalesce(v_items_count, 0)
  );
end;
$$;

revoke execute on function public.my_bkt_profile(int, int) from public, anon;
grant execute on function public.my_bkt_profile(int, int) to authenticated;

-- ---------- 公开：推荐练习 ----------
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
  v_mode text := case
    when p_mode in ('balanced', 'weak', 'review', 'challenge') then p_mode
    else 'balanced'
  end;
  v_item_ids jsonb;
  v_stages jsonb;
  v_overall double precision;
  v_considered int;
  v_cold boolean;
  v_next_due timestamptz;
begin
  with recursive subtree as (
    select sn.id
    from public.subject_nodes sn
    where p_node_id is not null and sn.id = p_node_id
    union all
    select sn.id
    from public.subject_nodes sn
    join subtree st on sn.parent_id = st.id
  ),
  global as (
    select a.question_id,
           count(*)::int as n,
           count(*) filter (where a.is_correct)::int as c
    from public.practice_answers a
    where a.grading = 'auto'
      and a.is_correct is not null
    group by a.question_id
  ),
  candidates as (
    select q.id as question_id,
           v.id as version_id,
           v.qtype,
           v.difficulty,
           q.course_node_id as node_id,
           sn.name as node_name,
           case when jsonb_typeof(v.content -> 'options') = 'array'
                then jsonb_array_length(v.content -> 'options') else 0 end as option_count,
           coalesce(g.n, 0) as global_n,
           coalesce(g.c, 0) as global_c
    from public.questions q
    join public.question_versions v on v.id = q.current_published_version_id
    left join public.subject_nodes sn on sn.id = q.course_node_id
    left join global g on g.question_id = q.id
    where q.state = 'live'
      and v.status = 'published'
      and (p_node_id is null or q.course_node_id in (select id from subtree))
      and not exists (
        select 1 from public.practice_answers a
        where a.user_id = v_uid
          and a.question_id = q.id
          and a.answered_at >= public.practice_day_start()
      )
  ),
  items as (
    select * from public._my_bkt_items(v_uid, 365, 600)
  ),
  state as (
    select c.*,
           coalesce(i.p_mastery, x.p_l0) as mastery,
           coalesce(i.p_correct, x.p_l0 * (1 - 0.10) + (1 - x.p_l0) * x.p_g) as p_correct,
           coalesce(i.info_gain, public.bkt_info_gain(x.p_l0, x.p_g, 0.10, 0.15)) as info_gain,
           i.last_at,
           i.due_at,
           i.attempts
    from candidates c
    left join items i using (question_id)
    cross join lateral (
      select least(0.90, greatest(0.05,
               (c.global_c + 0.6)::double precision / (c.global_n + 2)::double precision
             )) as p_l0,
             case
               when c.qtype in ('single_choice', 'multiple_choice')
                 then 1.0 / greatest(c.option_count, 2)::double precision
               when c.qtype = 'true_false' then 0.5
               else 0.05
             end as p_g
    ) x
  ),
  scored as (
    select s.*,
           greatest(0, 0.80 - s.mastery) / 0.80 as need,
           exp(-power(s.p_correct - 0.70, 2) / (2 * 0.15 * 0.15)) as zpd,
           least(1, greatest(0, s.info_gain / ln(2))) as info_norm,
           case
             when s.last_at is null then 1
             when s.last_at < now() - interval '1 day' then 0.5
             else 0
           end as novelty,
           case when s.due_at is not null and s.due_at <= now() then 1 else 0 end as due,
           case
             when s.mastery < 0.60 and (s.p_correct < 0.70 or s.difficulty = 1) then 'foundation'
             when s.mastery < 0.60 then 'consolidate'
             else 'challenge'
           end as stage,
           case
             when s.last_at is null then 'new_item'
             when s.due_at is not null and s.due_at <= now() then 'due_review'
             when s.mastery < 0.60 then 'weak_node'
             when s.info_gain >= 0.20 then 'high_info'
             else 'consolidate'
           end as reason_code
    from state s
  ),
  weighted as (
    select scored.*,
           case v_mode
             when 'weak' then
               0.60 * need + 0.20 * zpd + 0.10 * info_norm + 0.05 * novelty + 0.05 * due
             when 'review' then
               0.25 * need + 0.20 * zpd + 0.10 * info_norm + 0.05 * novelty + 0.40 * due
             when 'challenge' then
               0.25 * need
               + 0.35 * exp(-power(p_correct - 0.55, 2) / (2 * 0.15 * 0.15))
               + 0.15 * info_norm + 0.15 * novelty + 0.10 * due
             else
               0.40 * need + 0.25 * zpd + 0.20 * info_norm + 0.10 * novelty + 0.05 * due
           end as score
    from scored
  ),
  ranked as (
    select w.*,
           row_number() over (partition by w.node_id order by w.score desc, w.question_id) as node_rn
    from weighted w
  ),
  picked as (
    select * from ranked
    -- 每节点上限随推荐量自适应：至少 3，约 limit/2。
    -- 只有两个主节点时，固定 3 会把 20 题的推荐压成 6 题。
    where node_rn <= greatest(3, ceil(v_limit::numeric / 2)::int)
    order by score desc, question_id
    limit v_limit
  )
  select coalesce(jsonb_agg(p.question_id), '[]'::jsonb) into v_item_ids
  from picked p;

  with recursive subtree as (
    select sn.id
    from public.subject_nodes sn
    where p_node_id is not null and sn.id = p_node_id
    union all
    select sn.id
    from public.subject_nodes sn
    join subtree st on sn.parent_id = st.id
  ),
  global as (
    select a.question_id,
           count(*)::int as n,
           count(*) filter (where a.is_correct)::int as c
    from public.practice_answers a
    where a.grading = 'auto'
      and a.is_correct is not null
    group by a.question_id
  ),
  candidates as (
    select q.id as question_id,
           v.id as version_id,
           v.qtype,
           v.difficulty,
           q.course_node_id as node_id,
           sn.name as node_name,
           case when jsonb_typeof(v.content -> 'options') = 'array'
                then jsonb_array_length(v.content -> 'options') else 0 end as option_count,
           coalesce(g.n, 0) as global_n,
           coalesce(g.c, 0) as global_c
    from public.questions q
    join public.question_versions v on v.id = q.current_published_version_id
    left join public.subject_nodes sn on sn.id = q.course_node_id
    left join global g on g.question_id = q.id
    where q.state = 'live'
      and v.status = 'published'
      and (p_node_id is null or q.course_node_id in (select id from subtree))
      and not exists (
        select 1 from public.practice_answers a
        where a.user_id = v_uid
          and a.question_id = q.id
          and a.answered_at >= public.practice_day_start()
      )
  ),
  items as (
    select * from public._my_bkt_items(v_uid, 365, 600)
  ),
  state as (
    select c.*,
           coalesce(i.p_mastery, x.p_l0) as mastery,
           coalesce(i.p_correct, x.p_l0 * (1 - 0.10) + (1 - x.p_l0) * x.p_g) as p_correct,
           coalesce(i.info_gain, public.bkt_info_gain(x.p_l0, x.p_g, 0.10, 0.15)) as info_gain,
           i.last_at,
           i.due_at,
           i.attempts
    from candidates c
    left join items i using (question_id)
    cross join lateral (
      select least(0.90, greatest(0.05,
               (c.global_c + 0.6)::double precision / (c.global_n + 2)::double precision
             )) as p_l0,
             case
               when c.qtype in ('single_choice', 'multiple_choice')
                 then 1.0 / greatest(c.option_count, 2)::double precision
               when c.qtype = 'true_false' then 0.5
               else 0.05
             end as p_g
    ) x
  ),
  scored as (
    select s.*,
           greatest(0, 0.80 - s.mastery) / 0.80 as need,
           exp(-power(s.p_correct - 0.70, 2) / (2 * 0.15 * 0.15)) as zpd,
           least(1, greatest(0, s.info_gain / ln(2))) as info_norm,
           case
             when s.last_at is null then 1
             when s.last_at < now() - interval '1 day' then 0.5
             else 0
           end as novelty,
           case when s.due_at is not null and s.due_at <= now() then 1 else 0 end as due,
           case
             when s.mastery < 0.60 and (s.p_correct < 0.70 or s.difficulty = 1) then 'foundation'
             when s.mastery < 0.60 then 'consolidate'
             else 'challenge'
           end as stage,
           case
             when s.last_at is null then 'new_item'
             when s.due_at is not null and s.due_at <= now() then 'due_review'
             when s.mastery < 0.60 then 'weak_node'
             when s.info_gain >= 0.20 then 'high_info'
             else 'consolidate'
           end as reason_code
    from state s
  ),
  weighted as (
    select scored.*,
           case v_mode
             when 'weak' then
               0.60 * need + 0.20 * zpd + 0.10 * info_norm + 0.05 * novelty + 0.05 * due
             when 'review' then
               0.25 * need + 0.20 * zpd + 0.10 * info_norm + 0.05 * novelty + 0.40 * due
             when 'challenge' then
               0.25 * need
               + 0.35 * exp(-power(p_correct - 0.55, 2) / (2 * 0.15 * 0.15))
               + 0.15 * info_norm + 0.15 * novelty + 0.10 * due
             else
               0.40 * need + 0.25 * zpd + 0.20 * info_norm + 0.10 * novelty + 0.05 * due
           end as score
    from scored
  ),
  ranked as (
    select w.*,
           row_number() over (partition by w.node_id order by w.score desc, w.question_id) as node_rn
    from weighted w
  ),
  picked as (
    select * from ranked
    where node_rn <= greatest(3, ceil(v_limit::numeric / 2)::int)
    order by score desc, question_id
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', p.stage,
    'title', case p.stage when 'foundation' then '补齐薄弱基础'
                           when 'consolidate' then '巩固易错点'
                           else '迁移与挑战' end,
    'description', case p.stage when 'foundation' then '掌握度 < 0.60，先补最薄的一块'
                                 when 'consolidate' then '已有一点基础，练到稳定'
                                 else '掌握度较好，换更难/更综合的题' end,
    'items', p.items
  ) order by p.ord), '[]'::jsonb)
  into v_stages
  from (
    select picked.stage,
           case picked.stage when 'foundation' then 1 when 'consolidate' then 2 else 3 end as ord,
           jsonb_agg(jsonb_build_object(
             'question_id', picked.question_id,
             'version_id', picked.version_id,
             'qtype', picked.qtype,
             'difficulty', picked.difficulty,
             'node_name', picked.node_name,
             'p_mastery', round(picked.mastery::numeric, 3),
             'p_correct', round(picked.p_correct::numeric, 3),
             'info_gain', round(picked.info_gain::numeric, 3),
             'score', round(picked.score::numeric, 3),
             'reason_code', picked.reason_code
           ) order by picked.score desc) as items
    from picked
    group by picked.stage
  ) p;

  select count(*)::int into v_considered from (
    select q.id
    from public.questions q
    join public.question_versions v on v.id = q.current_published_version_id
    where q.state = 'live' and v.status = 'published'
  ) x;

  with items as (
    select * from public._my_bkt_items(v_uid, 365, 600)
  )
  select case when sum(1 + least(attempts, 3)) > 0
           then sum(p_mastery * (1 + least(attempts, 3))) / sum(1 + least(attempts, 3))
           else null end,
         count(*) = 0
  into v_overall, v_cold
  from items;

  if jsonb_array_length(v_item_ids) = 0 then
    select min(due_at) into v_next_due
    from public.practice_review_state(v_uid)
    where due_at > now();
    return jsonb_build_object(
      'status', 'nothing_due',
      'generated_at', now(),
      'next_due_at', v_next_due,
      'model', jsonb_build_object('name', 'BKT', 'p_t', 0.15, 'p_s', 0.10),
      'summary', jsonb_build_object(
        'overall_mastery', case when v_overall is null then null else round(v_overall::numeric, 3) end,
        'items_considered', v_considered,
        'limit', v_limit
      ),
      'stages', '[]'::jsonb,
      'item_ids', '[]'::jsonb
    );
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'generated_at', now(),
    'cold_start', coalesce(v_cold, true),
    'model', jsonb_build_object(
      'name', 'BKT',
      'p_t', 0.15,
      'p_s', 0.10,
      'p_l0', '题目全局正确率向 Beta 先验收缩',
      'window_days', 365
    ),
    'summary', jsonb_build_object(
      'overall_mastery', case when v_overall is null then null else round(v_overall::numeric, 3) end,
      'items_considered', v_considered,
      'limit', v_limit
    ),
    'stages', v_stages,
    'item_ids', v_item_ids
  );
end;
$$;

revoke execute on function public.my_recommended_practice(int, uuid, text) from public, anon;
grant execute on function public.my_recommended_practice(int, uuid, text) to authenticated;

notify pgrst, 'reload schema';
