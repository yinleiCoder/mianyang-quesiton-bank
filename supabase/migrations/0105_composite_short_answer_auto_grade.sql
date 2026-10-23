-- 0105: 复合题全部按客观题判分（简答子题也按参考答案比对）
--
-- 用户 2026-10-22 口径：复合题应当全部是客观题、按参考答案判分；交卷后立即出
-- 全部答案，除非整题本身就是简答题这种主观题。
--
-- 旧口径：复合题里只要有一个 short_answer 子题，整题转人工、考试停在 submitted，
-- 于是学生交卷后看不到任何标准答案与解析（本轮用户报的"考试复盘没有解析"）。
--
-- 新口径：
--   · grade_sub_objective 增加 short_answer：学生写的原文（p_given.text）与
--     参考答案 samples 任一按 exam_norm_text 归一化后完全一致，即算答对；
--   · grade_exam_units 的复合题不再因为有简答子题就整题转人工，逐子题调用
--     grade_sub_objective（简答子题现在也能返回 true/false）；
--   · **顶层的 short_answer 题**仍走人工阅卷（这是用户说的例外）。
--
-- 兼容性：只影响新判分/新交卷；已经停在 pending 的历史作答不会被自动改写，
-- 教师仍可在阅卷台给分，或学生重考一场。

-- 复合题单个子题判分：补上 short_answer（按参考答案样本比对）
create or replace function public.grade_sub_objective(p_type text, p_sub jsonb, p_given jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case p_type
    when 'single_choice' then
      coalesce((select array_agg(upper(k) order by upper(k)) from jsonb_array_elements_text(coalesce(p_given -> 'keys', '[]'::jsonb)) k), '{}'::text[])
        = coalesce((select array_agg(upper(k) order by upper(k)) from jsonb_array_elements_text(coalesce(p_sub -> 'answer' -> 'keys', '[]'::jsonb)) k), '{}'::text[])
    when 'multiple_choice' then
      coalesce((select array_agg(upper(k) order by upper(k)) from jsonb_array_elements_text(coalesce(p_given -> 'keys', '[]'::jsonb)) k), '{}'::text[])
        = coalesce((select array_agg(upper(k) order by upper(k)) from jsonb_array_elements_text(coalesce(p_sub -> 'answer' -> 'keys', '[]'::jsonb)) k), '{}'::text[])
    when 'true_false' then
      (p_given ->> 'value')::boolean is not distinct from (p_sub -> 'answer' ->> 'value')::boolean
    when 'fill_blank' then
      -- 子题里的填空要求**全部**答对才算这个计分点
      not exists (
        select 1 from jsonb_array_elements_text(coalesce(p_sub -> 'answer' -> 'values', '[]'::jsonb)) with ordinality as t(v, ord)
        where public.exam_norm_text(p_given -> 'values' ->> (t.ord - 1)::int) is distinct from public.exam_norm_text(t.v)
      )
      and jsonb_array_length(coalesce(p_given -> 'values', '[]'::jsonb))
          = jsonb_array_length(coalesce(p_sub -> 'answer' -> 'values', '[]'::jsonb))
    when 'short_answer' then
      -- 复合题的简答子题按参考答案判：学生原文与任一 sample 归一化后一致。
      -- 这是"全部客观化"的落点；顶层的简答题不走这里，仍是人工阅卷。
      exists (
        select 1
        from jsonb_array_elements_text(coalesce(p_sub -> 'answer' -> 'samples', '[]'::jsonb)) s
        where public.exam_norm_text(s) <> ''
          and public.exam_norm_text(p_given ->> 'text') <> ''
          and public.exam_norm_text(p_given ->> 'text') = public.exam_norm_text(s)
      )
    else false
  end;
$$;

-- 判分引擎：复合题不再因简答子题整题转人工
create or replace function public.grade_exam_units(
  p_qtype text, p_content jsonb, p_answer jsonb, p_unit_count int)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_ans jsonb := coalesce(p_answer, '{}'::jsonb);
  v_units boolean[] := '{}';
  v_i int;
  v_j int;
  v_sub jsonb;
  v_given jsonb;
  v_ok boolean;
  v_n int;
  v_sub_count int;
  v_layout int[] := '{}';
  v_expected int := 0;
begin
  if v_ans ->> 'type' = 'unknown' then
    return jsonb_build_object('grading', 'auto',
      'units', (select jsonb_agg(false) from generate_series(1, greatest(p_unit_count, 1))),
      'is_correct', false);
  end if;

  if p_qtype in ('single_choice', 'multiple_choice') then
    v_ok := coalesce(
      (select array_agg(upper(k) order by upper(k)) from jsonb_array_elements_text(v_ans -> 'keys') k),
      '{}'::text[])
      = coalesce(
      (select array_agg(upper(k) order by upper(k)) from jsonb_array_elements_text(p_content -> 'answer' -> 'keys') k),
      '{}'::text[]);
    v_units := array_fill(v_ok, array[greatest(p_unit_count, 1)]);
    return jsonb_build_object('grading', 'auto', 'units', to_jsonb(v_units), 'is_correct', v_ok);
  end if;

  if p_qtype = 'true_false' then
    v_ok := (v_ans ->> 'value')::boolean is not distinct from (p_content -> 'answer' ->> 'value')::boolean;
    v_units := array_fill(v_ok, array[greatest(p_unit_count, 1)]);
    return jsonb_build_object('grading', 'auto', 'units', to_jsonb(v_units), 'is_correct', v_ok);
  end if;

  if p_qtype = 'fill_blank' then
    v_given := coalesce(v_ans -> 'values', '[]'::jsonb);
    for v_i in 0 .. p_unit_count - 1 loop
      v_ok := public.exam_norm_text(v_given ->> v_i) <> ''
              and public.exam_norm_text(v_given ->> v_i)
                  = public.exam_norm_text(p_content -> 'answer' -> 'values' ->> v_i);
      v_units := v_units || v_ok;
    end loop;
    return jsonb_build_object('grading', 'auto', 'units', to_jsonb(v_units),
      'is_correct', not (false = any(v_units)));
  end if;

  if p_qtype = 'composite' then
    v_sub_count := coalesce(jsonb_array_length(p_content -> 'sub'), 0);

    for v_i in 0 .. v_sub_count - 1 loop
      v_sub := p_content -> 'sub' -> v_i;
      if v_sub ->> 'type' = 'fill_blank' then
        v_n := greatest(public.v_blank_count(public.v_blocks_text(v_sub -> 'stem')), 1);
      else
        v_n := 1;
      end if;
      v_layout := v_layout || v_n;
      v_expected := v_expected + v_n;
    end loop;

    -- 新口径：不再因为出现 short_answer 子题就整题转人工；
    -- 复合题的每个子题（含简答）都由 grade_sub_objective 按参考答案判。
    if v_expected > 0 and v_expected = greatest(p_unit_count, 1) then
      for v_i in 0 .. v_sub_count - 1 loop
        v_sub := p_content -> 'sub' -> v_i;
        v_given := coalesce(v_ans -> 'subs' -> v_i, '{}'::jsonb);
        if v_sub ->> 'type' = 'fill_blank' then
          for v_j in 0 .. v_layout[v_i + 1] - 1 loop
            v_ok := public.exam_norm_text(v_given -> 'values' ->> v_j) <> ''
                    and public.exam_norm_text(v_given -> 'values' ->> v_j)
                        = public.exam_norm_text(v_sub -> 'answer' -> 'values' ->> v_j);
            v_units := v_units || v_ok;
          end loop;
        else
          v_units := v_units || public.grade_sub_objective(v_sub ->> 'type', v_sub, v_given);
        end if;
      end loop;
      return jsonb_build_object('grading', 'auto', 'units', to_jsonb(v_units),
        'is_correct', not (false = any(v_units)));
    end if;

    -- 旧口径 / 自定义长度：一个子题一个计分点
    v_units := array_fill(false, array[greatest(p_unit_count, 1)]);
    for v_i in 0 .. v_sub_count - 1 loop
      v_sub := p_content -> 'sub' -> v_i;
      if v_i <= p_unit_count - 1 then
        v_units[v_i + 1] := public.grade_sub_objective(
          v_sub ->> 'type', v_sub, v_ans -> 'subs' -> v_i);
      end if;
    end loop;
    return jsonb_build_object('grading', 'auto', 'units', to_jsonb(v_units),
      'is_correct', not (false = any(v_units)));
  end if;

  -- 顶层 short_answer：主观题一律人工。给 grading=manual 让上层置 pending。
  -- 这是用户口径里的例外：整题本身就是简答题时，交卷后不立即出答案。
  return jsonb_build_object('grading', 'manual',
    'units', (select jsonb_agg(false) from generate_series(1, greatest(p_unit_count, 1))),
    'is_correct', null);
end;
$$;

notify pgrst, 'reload schema';
