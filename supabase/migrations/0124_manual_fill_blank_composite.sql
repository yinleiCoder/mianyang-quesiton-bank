-- 0124: 填空题、综合题全部改为教师阅卷（用户 2026-11-03 口径）
--
-- 背景：0105 之后顶层 fill_blank 与 composite（含简答子题）都是按参考答案
-- exam_norm_text 精确匹配自动判分。用户反馈：填空题/综合题的参考答案不唯一，
-- 同义写法会被判错；要求这两类**全部**交给教师阅卷，并在阅卷时提供 AI 辅助判分。
--
-- 新口径：
--   · single_choice / multiple_choice / true_false 仍自动判；
--   · 顶层 fill_blank、顶层 composite（含其 choice/tf 子题）一律 grading='manual'，
--     由 submit_exam_attempt 转成 pending，进入待阅卷队列；
--   · 顶层 short_answer 不变 manual。
--
-- 兼容性：只影响新交卷；已经 auto 的 fill/composite 保留原分、原 grading，不重判、
-- 不迁移。旧行仍可在阅卷台覆盖。不要重开 0115 的发布重算触发器。
-- 答案揭示保持 0106 现状：交卷后仍显示参考答案，只是分数等教师判。

create or replace function public.grade_exam_units(
  p_qtype text, p_content jsonb, p_answer jsonb, p_unit_count int)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_ans jsonb := coalesce(p_answer, '{}'::jsonb);
  v_units boolean[];
  v_ok boolean;
begin
  if v_ans ->> 'type' = 'unknown' then
    return jsonb_build_object(
      'grading', 'auto',
      'units', (select jsonb_agg(false) from generate_series(1, greatest(p_unit_count, 1))),
      'is_correct', false
    );
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

  -- fill_blank / composite / short_answer：一律人工。
  -- 顶层 short_answer 原本就走这里；fill_blank/composite 是本次新增。
  return jsonb_build_object(
    'grading', 'manual',
    'units', (select jsonb_agg(false) from generate_series(1, greatest(p_unit_count, 1))),
    'is_correct', null
  );
end;
$$;

-- start_exam_attempt 的 objective_full_score 原来按“非 short_answer”算，
-- 现在 fill/composite 也人工，必须只把 choice/tf 计入客观满分，否则及格线/得分率错。
-- 用定点替换（与 0099 同一套做法）：匹配不到就 raise，绝不静默漏改。
do $do$
declare
  v_def text;
  v_old text := $old$  select coalesce(sum(score), 0),
         coalesce(sum(score) filter (where qtype <> 'short_answer'), 0)
    into v_full, v_obj_full
  from paper_items where paper_version_id = v_ver.id;
$old$;
  v_new text := $new$  select coalesce(sum(score), 0),
         coalesce(sum(score) filter (where qtype in
           ('single_choice', 'multiple_choice', 'true_false')), 0)
    into v_full, v_obj_full
  from paper_items where paper_version_id = v_ver.id;
$new$;
begin
  select pg_get_functiondef('public.start_exam_attempt(uuid)'::regprocedure) into v_def;
  if position(v_old in v_def) = 0 then
    raise exception '0124：没在 start_exam_attempt 里匹配到旧的满分统计块——先 dump 线上定义再改，别硬来';
  end if;
  execute replace(v_def, v_old, v_new);
  raise notice '0124：客观满分已收窄为 choice/tf；填空/综合进入人工阅卷';
end
$do$;

notify pgrst, 'reload schema';
