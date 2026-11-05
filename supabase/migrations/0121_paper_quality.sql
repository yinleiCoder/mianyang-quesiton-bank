-- 0121: 试题质量诊断（经典测验理论 CTT，只读）。
--
-- 口径：
--   · 只统计官方、已出分（status='graded'）的考试；
--   · 只统计当前入库版本（paper.current_published_version_id）；
--   · 二分题 p = 做对人数 / 作答人数；多分题 p = 平均得分 / 满分；
--   · 区分度 r = 题目得分与"其余题总分"的 Pearson 相关（点二列是其特例）；
--   · 干扰项上下 27% 按总分排序分组，D = 高分组选中率 - 低分组选中率；
--   · 不返回学生姓名，只返回聚合计数。
create or replace function public.ctt_corr(p_x numeric[], p_y numeric[])
returns double precision
language plpgsql
immutable
as $$
begin
  if p_x is null or p_y is null
     or array_length(p_x, 1) is distinct from array_length(p_y, 1)
     or coalesce(array_length(p_x, 1), 0) < 2 then
    return null;
  end if;
  return (select corr(x, y) from unnest(p_x, p_y) as t(x, y));
end;
$$;

revoke execute on function public.ctt_corr(numeric[], numeric[]) from public, anon, authenticated;

create or replace function public.paper_quality_diagnostics(p_paper_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_paper papers%rowtype;
  v_ver paper_versions%rowtype;
  v_attempts int;
  v_n_group int;
  v_items jsonb;
begin
  select * into v_paper from papers where id = p_paper_id;
  if not found then
    raise exception '试卷不存在';
  end if;
  if v_paper.current_published_version_id is null then
    raise exception '这份试卷还没有入库的版本，没有分析可言';
  end if;
  select * into v_ver from paper_versions where id = v_paper.current_published_version_id;
  if not found then
    raise exception '这份试卷还没有入库的版本，没有分析可言';
  end if;
  if not public.is_paper_grader(p_paper_id) then
    raise exception '只有教师/管理员能看试题质量诊断' using errcode = '42501';
  end if;

  select count(*)::int into v_attempts
  from exam_attempts a
  where a.paper_version_id = v_ver.id
    and a.is_official
    and a.status = 'graded';

  -- CTE 只在定义它的那条语句里可见；RETURN 里要用的值先落到变量。
  v_n_group := greatest(1, ceil(v_attempts * 0.27)::int);

  with items as (
    select i.id as paper_item_id,
           i.question_id,
           i.question_version_id,
           i.seq,
           i.qtype,
           i.difficulty,
           i.score as max_score,
           left(public.v_blocks_text(qv.content -> 'stem'), 160) as stem_text,
           sn.name as node_name,
           qv.content as content
    from paper_items i
    join question_versions qv on qv.id = i.question_version_id
    left join questions q on q.id = i.question_id
    left join subject_nodes sn on sn.id = q.course_node_id
    where i.paper_version_id = v_ver.id
  ),
  attempts as (
    select a.id as attempt_id, a.total_score
    from exam_attempts a
    where a.paper_version_id = v_ver.id
      and a.is_official
      and a.status = 'graded'
  ),
  ranked as (
    select a.attempt_id,
           a.total_score,
           row_number() over (order by a.total_score desc, a.attempt_id) as rn,
           count(*) over () as n
    from attempts a
  ),
  bound as (
    select coalesce(max(n), 0)::int as n,
           greatest(1, ceil(coalesce(max(n), 0) * 0.27)::int) as k
    from ranked
  ),
  ans as (
    select aa.paper_item_id,
           aa.attempt_id,
           aa.answer,
           aa.score,
           aa.is_correct,
           r.total_score,
           r.rn,
           b.n,
           b.k
    from exam_answers aa
    join ranked r on r.attempt_id = aa.attempt_id
    cross join bound b
    where aa.grading <> 'pending'
  ),
  item_stats as (
    select i.paper_item_id,
           count(a.attempt_id)::int as n,
           count(a.attempt_id) filter (where a.answer = '{}'::jsonb)::int as blank,
           count(a.attempt_id) filter (where a.is_correct)::int as correct_count,
           coalesce(sum(a.score), 0) as score_sum,
           avg(a.score) as score_mean,
           public.ctt_corr(
             array_agg(a.score),
             array_agg(a.total_score - a.score)
           ) as r_pb
    from items i
    left join ans a on a.paper_item_id = i.paper_item_id
    group by i.paper_item_id
  ),
  item_final as (
    select i.*,
           coalesce(s.n, 0) as n,
           coalesce(s.blank, 0) as blank,
           coalesce(s.correct_count, 0) as correct_count,
           coalesce(s.score_sum, 0) as score_sum,
           s.score_mean,
           s.r_pb,
           case
             when coalesce(s.n, 0) = 0 then null
             when i.qtype in ('single_choice', 'multiple_choice', 'true_false')
               then least(1, greatest(0, s.correct_count::numeric / s.n))
             when i.max_score > 0
               then least(1, greatest(0, s.score_sum / (s.n * i.max_score)))
             else null
           end as p_value
    from items i
    left join item_stats s on s.paper_item_id = i.paper_item_id
  ),
  picks as (
    select a.paper_item_id,
           x.opt_key,
           a.attempt_id,
           a.rn,
           a.n,
           a.k
    from ans a
    cross join lateral (
      select jsonb_array_elements_text(a.answer -> 'keys') as opt_key
      union all
      select (a.answer ->> 'value')::boolean::text
      where a.answer ? 'value'
    ) x
    where x.opt_key is not null
  ),
  pick_counts as (
    select p.paper_item_id,
           p.opt_key,
           count(distinct p.attempt_id)::int as cnt,
           count(distinct p.attempt_id) filter (where p.rn <= p.k)::int as upper_cnt,
           count(distinct p.attempt_id) filter (where p.rn > p.n - p.k)::int as lower_cnt
    from picks p
    group by p.paper_item_id, p.opt_key
  ),
  option_layout as (
    select i.paper_item_id,
           e.ord::int as ord,
           e.elem ->> 'key' as key,
           case
             when jsonb_typeof(e.elem -> 'label') = 'array' then public.v_blocks_text(e.elem -> 'label')
             when e.elem ? 'label' then e.elem ->> 'label'
             when e.elem ? 'text' then e.elem ->> 'text'
             else ''
           end as text,
           coalesce((i.content -> 'answer' -> 'keys') ? (e.elem ->> 'key'), false) as is_key
    from items i
    cross join lateral jsonb_array_elements(coalesce(i.content -> 'options', '[]'::jsonb))
      with ordinality e(elem, ord)
    where i.qtype in ('single_choice', 'multiple_choice')
    union all
    select i.paper_item_id,
           1,
           'true',
           '正确',
           coalesce((i.content -> 'answer' ->> 'value')::boolean, false)
    from items i
    where i.qtype = 'true_false'
    union all
    select i.paper_item_id,
           2,
           'false',
           '错误',
           not coalesce((i.content -> 'answer' ->> 'value')::boolean, false)
    from items i
    where i.qtype = 'true_false'
  ),
  item_options as (
    select ol.paper_item_id,
           jsonb_agg(jsonb_build_object(
             'key', ol.key,
             'text', ol.text,
             'is_key', ol.is_key,
             'count', coalesce(pc.cnt, 0),
             'upper_count', coalesce(pc.upper_cnt, 0),
             'lower_count', coalesce(pc.lower_cnt, 0)
           ) order by ol.ord) as options
    from option_layout ol
    left join pick_counts pc
      on pc.paper_item_id = ol.paper_item_id and pc.opt_key = ol.key
    group by ol.paper_item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'paper_item_id', f.paper_item_id,
    'question_id', f.question_id,
    'version_id', f.question_version_id,
    'seq', f.seq,
    'qtype', f.qtype,
    'difficulty', f.difficulty,
    'stem_text', f.stem_text,
    'max_score', f.max_score,
    'node_name', f.node_name,
    'n', f.n,
    'blank', f.blank,
    'correct_count', f.correct_count,
    'score_sum', f.score_sum,
    'score_mean', f.score_mean,
    'p_value', f.p_value,
    'p_se', case
      when f.p_value is not null and f.n > 0
        then sqrt((f.p_value * (1 - f.p_value)) / f.n)
      else null
    end,
    'r_pb', f.r_pb,
    'options', coalesce(io.options, '[]'::jsonb)
  ) order by f.seq), '[]'::jsonb)
  into v_items
  from item_final f
  left join item_options io on io.paper_item_id = f.paper_item_id;

  return jsonb_build_object(
    'paper', jsonb_build_object(
      'paper_id', p_paper_id,
      'version_id', v_ver.id,
      'title', v_ver.title,
      'exam_name', v_ver.exam_name,
      'total_score', v_ver.total_score,
      'item_count', (select count(*) from paper_items where paper_version_id = v_ver.id)
    ),
    'summary', jsonb_build_object(
      'attempts', v_attempts,
      'n_group', v_n_group,
      'items', jsonb_array_length(v_items),
      'note', case when v_attempts < 30 then '样本不足 30 人，区分度仅供参考' else null end
    ),
    'items', v_items
  );
end;
$$;

revoke execute on function public.paper_quality_diagnostics(uuid) from public, anon;
grant execute on function public.paper_quality_diagnostics(uuid) to authenticated;

notify pgrst, 'reload schema';
