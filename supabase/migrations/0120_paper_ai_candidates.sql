-- 0120: 智能组卷候选池（只读）。
--
-- 返回"组卷优化器真正需要"的紧凑特征：题型、难度、标签、经验正确率、最近使用次数、
-- 空位数/子题空位数。**不返回题干全文、选项、答案、解析**——即使守卫被误放开，
-- 这个函数也不应该成为答案泄露的出口。
--
-- 口径：
--   · 只取 questions.state='live' 且 current_published_version_id 已发布；
--   · 科目节点按子树（选中专业大类/专业时包含其下课程）；
--   · 经验正确率只统计 grading='auto' 的练习作答（与 question_accuracy 一致）；
--   · uses_recent 只统计已发布试卷在最近 N 天内引用过该题。
create or replace function public.paper_ai_candidates(p_spec jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_node uuid;
  v_qtypes text[];
  v_diffs smallint[];
  v_tags uuid[];
  v_kw text;
  v_recent int;
  v_limit int;
  v_items jsonb;
  v_pool int;
begin
  perform public.require_uid();
  if not public.is_teacher() then
    raise exception '仅教师可使用智能组卷' using errcode = '42501';
  end if;

  v_node := nullif(p_spec ->> 'node_id', '')::uuid;
  if v_node is not null and not exists (select 1 from public.subject_nodes where id = v_node) then
    raise exception '科目节点不存在';
  end if;

  if jsonb_typeof(p_spec -> 'qtypes') = 'array' then
    select array_agg(elem::text) into v_qtypes
    from jsonb_array_elements_text(p_spec -> 'qtypes') elem;
  end if;
  if jsonb_typeof(p_spec -> 'difficulties') = 'array' then
    select array_agg(elem::smallint) into v_diffs
    from jsonb_array_elements_text(p_spec -> 'difficulties') elem;
  end if;
  if jsonb_typeof(p_spec -> 'tag_ids') = 'array' then
    select array_agg(elem::uuid) into v_tags
    from jsonb_array_elements_text(p_spec -> 'tag_ids') elem;
  end if;

  v_kw := nullif(btrim(coalesce(p_spec ->> 'keyword', '')), '');
  v_recent := greatest(0, least(coalesce((p_spec ->> 'exclude_recent_days')::int, 90), 3650));
  v_limit := greatest(1, least(coalesce((p_spec ->> 'limit')::int, 800), 800));

  with recursive subtree as (
    select sn.id
    from public.subject_nodes sn
    where v_node is not null and sn.id = v_node
    union all
    select sn.id
    from public.subject_nodes sn
    join subtree st on sn.parent_id = st.id
  ),
  base as (
    select q.id as question_id,
           v.id as version_id,
           v.qtype,
           v.difficulty,
           q.course_node_id as node_id,
           sn.name as node_name,
           v.content,
           v.search_text
    from public.questions q
    join public.question_versions v on v.id = q.current_published_version_id
    join public.subject_nodes sn on sn.id = q.course_node_id
    where q.state = 'live'
      and v.status = 'published'
      and (v_node is null or q.course_node_id in (select id from subtree))
      and (v_qtypes is null or v.qtype = any(v_qtypes))
      and (v_diffs is null or v.difficulty = any(v_diffs))
      and (
        v_kw is null
        or v.search_text ilike '%' || replace(replace(replace(v_kw, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      )
      and (
        v_tags is null
        or exists (
          select 1 from public.version_tags vt
          where vt.version_id = v.id and vt.tag_id = any(v_tags)
        )
      )
  ),
  stats as (
    select b.*,
           coalesce(pa.attempts, 0) as attempts,
           coalesce(pa.correct, 0) as correct,
           coalesce(used.uses, 0) as uses_recent,
           used.last_used_at
    from base b
    left join lateral (
      select count(*)::int as attempts,
             count(*) filter (where a.is_correct)::int as correct
      from public.practice_answers a
      where a.question_id = b.question_id
        and a.grading = 'auto'
    ) pa on true
    left join lateral (
      select count(*)::int as uses,
             max(pv.published_at) as last_used_at
      from public.paper_items pi
      join public.paper_versions pv on pv.id = pi.paper_version_id
      where pi.question_id = b.question_id
        and pv.status = 'published'
        and pv.published_at >= now() - make_interval(days => v_recent)
    ) used on true
  ),
  shaped as (
    select s.question_id,
           s.version_id,
           s.qtype,
           s.difficulty,
           s.node_id,
           s.node_name,
           s.attempts,
           s.correct,
           s.uses_recent as uses_90d,
           s.last_used_at,
           left(public.v_blocks_text(s.content -> 'stem'), 120) as stem_text,
           case when jsonb_typeof(s.content -> 'options') = 'array'
                then jsonb_array_length(s.content -> 'options') else 0 end as option_count,
           case when s.qtype = 'fill_blank'
                then public.v_blank_count(public.v_blocks_text(s.content -> 'stem')) else 0 end as blank_count,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'type', sub ->> 'type',
               'blank_count', case when sub ->> 'type' = 'fill_blank'
                 then public.v_blank_count(public.v_blocks_text(sub -> 'stem')) else 0 end
             ))
             from jsonb_array_elements(
               case when jsonb_typeof(s.content -> 'sub') = 'array'
                    then s.content -> 'sub' else '[]'::jsonb end
             ) sub
           ), '[]'::jsonb) as subs,
           coalesce((
             select jsonb_agg(t.id)
             from public.version_tags vt
             join public.tags t on t.id = vt.tag_id
             where vt.version_id = s.version_id
           ), '[]'::jsonb) as tag_ids,
           coalesce((
             select jsonb_agg(t.name)
             from public.version_tags vt
             join public.tags t on t.id = vt.tag_id
             where vt.version_id = s.version_id
           ), '[]'::jsonb) as tag_names
    from stats s
  )
  select coalesce(jsonb_agg(to_jsonb(x) - 'pool_size'), '[]'::jsonb),
         coalesce(max(x.pool_size), 0)::int
  into v_items, v_pool
  from (
    select shaped.*,
           count(*) over () as pool_size
    from shaped
    order by shaped.attempts desc, shaped.question_id
    limit v_limit
  ) x;

  return jsonb_build_object(
    'generated_at', now(),
    'pool_size', v_pool,
    'items', v_items
  );
end;
$$;

revoke execute on function public.paper_ai_candidates(jsonb) from public, anon;
grant execute on function public.paper_ai_candidates(jsonb) to authenticated;

notify pgrst, 'reload schema';
