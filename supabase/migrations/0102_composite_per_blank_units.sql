-- 0102: 复合题的计分点从"每个小问"细化到"每个空"
--
-- 症状（2026-10-22 用户报）：组卷库里复合题只能按小问设分，不能单独设每个空的分数。
-- 例如一道复合题：小问 1 有 2 空、小问 2 有 3 空、小问 3 是简答；
-- 旧口径只给 3 个计分点（每个小问一个），教师没法把"小问 2 的 3 个空"拆开给分。
--
-- 新口径：
--   · per_sub（每小问）：每个小问的**总分仍是 score_each**，均摊到它的各空；
--     小问是填空题时按空数拆，除不尽的余数给最后一空。总分不变，只是可逐空调整。
--   · per_blank（每空）：复合题里每个 fill_blank 子题的每一空都是 score_each；
--     其它题型的小问仍是一个计分点。这样"每空 2 分"也能直接套在材料题上。
--   · per_item：整题一个计分点（不变）。
--
-- 判分必须同步改：grade_exam_units 原来假定"一个子题一个计分点"。
-- 现在按 p_unit_count（= 落库 score_units 的长度）判断口径：
--   · 长度等于"按空展开"的数 → 逐空判分（复合题里的 fill_blank 子题逐空比对）；
--   · 否则按旧口径（一个子题一个计分点）判，存量试卷/旧作答不受影响。
--
-- 只改计算函数，不迁移已落库的 paper_items.score_units：已发布试卷的分值明细
-- 是定稿快照，不能被新口径重算。草稿打开时编辑器会把与"新默认值"不一致的
-- score_units 还原成 custom_units（不自动改老师已经设过的分）；复合题右栏的
-- 「按空细分」可把整题/每小问的分均摊到各空，再逐空调整。

create or replace function public.paper_item_units(
  p_qtype text, p_content jsonb, p_score_mode text, p_score_each numeric, p_custom jsonb default null)
returns numeric[]
language plpgsql
immutable
set search_path = public
as $$
declare
  v_mode text;
  v_each numeric := coalesce(p_score_each, 0);
  v_units numeric[] := '{}';
  v_sub jsonb;
  v_n int;
  v_base numeric;
  v_j int;
begin
  if p_custom is not null and jsonb_typeof(p_custom) = 'array' and jsonb_array_length(p_custom) > 0 then
    return (select array_agg(x::numeric) from jsonb_array_elements_text(p_custom) x);
  end if;

  -- 与 lib/paper-model.js 的 effectiveScoreMode 逐条对齐
  v_mode := case
    when p_score_mode = 'per_blank' and p_qtype in ('fill_blank', 'composite') then 'per_blank'
    when p_score_mode = 'per_sub' and p_qtype = 'composite' then 'per_sub'
    else 'per_item'
  end;

  if v_mode = 'per_item' then
    return array[v_each];
  end if;

  if p_qtype = 'fill_blank' then
    if jsonb_typeof(p_content -> 'stem') = 'array' then
      v_n := public.v_blank_count(public.v_blocks_text(p_content -> 'stem'));
    end if;
    if v_n > 0 then
      return array_fill(v_each, array[v_n]);
    end if;
    return array[v_each];
  end if;

  -- composite：每个 fill_blank 子题按空拆；其它子题一个计分点
  for v_sub in select value from jsonb_array_elements(coalesce(p_content -> 'sub', '[]'::jsonb)) loop
    if v_sub ->> 'type' = 'fill_blank' and jsonb_typeof(v_sub -> 'stem') = 'array' then
      v_n := public.v_blank_count(public.v_blocks_text(v_sub -> 'stem'));
    else
      v_n := 0;
    end if;
    if v_n < 1 then v_n := 1; end if;

    if v_mode = 'per_sub' and v_n > 1 then
      -- 小问总分 = score_each，均摊到各空；余数给最后一空，保证小问合计不变
      v_base := round(v_each / v_n, 2);
      for v_j in 1 .. v_n loop
        if v_j < v_n then
          v_units := v_units || v_base;
        else
          v_units := v_units || round(v_each - v_base * (v_n - 1), 2);
        end if;
      end loop;
    else
      v_units := v_units || array_fill(v_each, array[v_n]);
    end if;
  end loop;

  if cardinality(v_units) = 0 then
    return array[v_each];
  end if;
  return v_units;
end;
$$;

-- 判分：新增"按空"分支；旧口径（一个子题一个计分点）保留给存量试卷。
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
  -- 学生点"不会"：全部计分点判错，但仍算一次作答（与练习口径一致）
  if v_ans ->> 'type' = 'unknown' then
    return jsonb_build_object('grading', 'auto',
      'units', (select jsonb_agg(false) from generate_series(1, greatest(p_unit_count, 1))),
      'is_correct', false);
  end if;

  if p_qtype in ('single_choice', 'multiple_choice') then
    -- 选择题没有部分分：多选'漏选给一半'这类规则各校不同，要做得先有配置，本期不做
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
    -- **按空给分**：这正是"每空的分数"落地的地方。
    -- 学生填的答案与标准答案按序逐空比对，对几个给几分。
    v_given := coalesce(v_ans -> 'values', '[]'::jsonb);
    for v_i in 0 .. p_unit_count - 1 loop
      v_ok := public.exam_norm_text(v_given ->> v_i) <> ''
              and public.exam_norm_text(v_given ->> v_i)
                  = public.exam_norm_text(p_content -> 'answer' -> 'values' ->> v_i);
      v_units := v_units || v_ok;
    end loop;
    -- is_correct = 全部给分点都拿到（`false = any` 比 array 包含运算符好读，也不会在空数组上炸）
    return jsonb_build_object('grading', 'auto', 'units', to_jsonb(v_units),
      'is_correct', not (false = any(v_units)));
  end if;

  if p_qtype = 'composite' then
    v_sub_count := coalesce(jsonb_array_length(p_content -> 'sub'), 0);

    -- 每个子题占几个计分点：fill_blank 按空（至少 1），其它题型 1
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

    -- 有简答子题：整题转人工（与旧口径一致）
    for v_i in 0 .. v_sub_count - 1 loop
      if (p_content -> 'sub' -> v_i ->> 'type') = 'short_answer' then
        return jsonb_build_object('grading', 'manual',
          'units', (select jsonb_agg(false) from generate_series(1, greatest(p_unit_count, 1))),
          'is_correct', null);
      end if;
    end loop;

    -- 新口径：计分点数与"按空展开"一致 → 逐空判分。
    -- 旧试卷的 score_units 长度是子题数，不会命中这一段。
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

    -- 旧口径 / 自定义长度：一个子题一个计分点（存量试卷按原样判，不重算分数）
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

  -- short_answer：主观题一律人工。给 grading=manual 让上层置 pending
  return jsonb_build_object('grading', 'manual',
    'units', (select jsonb_agg(false) from generate_series(1, greatest(p_unit_count, 1))),
    'is_correct', null);
end;
$$;

notify pgrst, 'reload schema';
