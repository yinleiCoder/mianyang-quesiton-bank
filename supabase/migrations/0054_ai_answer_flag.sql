-- 0054: 允许 AI 推导答案，并给它一个可被人工识别的标记。
--
-- 背景（2026-09-17 实测）：一份真题正文里**一个答案都没有**，而提示词当时写的是
-- 「抽不出答案时不要给答案，也不要编造」。结果模型只在自己会做时才补答案——
-- 那次 5 道题只有 1 道能入库（唯一那道是道计算题，模型自己算出来了），
-- 其余全被 validate_question_content 的「答案不能为空」拦下。
--
-- 产品决策改为：**AI 负责推导答案，教师在校对页逐题复核并可以改**。
-- 所以：
--   · 提示词改成「原卷有答案照抄、没有就自己解，并把推导过程写进解析」；
--   · 模型推导出来的答案打上 ai_answer 标记，教师一眼能看出哪些需要重点核对；
--   · 实在推不出来（题目信息不全 / 有多个同样合理的答案）才留空。
--
-- flags 有白名单约束，加标记必须同步放行，否则 import_save_page 会整页写入失败。

do $$
declare
  v_name text;
begin
  -- 约束名是 PG 自动生成的，别硬编码；按"包含 flags 的那条 check"找出来
  select conname into v_name
  from pg_constraint
  where conrelid = 'public.import_job_items'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%flags%';
  if v_name is not null then
    execute format('alter table public.import_job_items drop constraint %I', v_name);
  end if;
end $$;

alter table public.import_job_items
  add constraint import_job_items_flags_check
  check (flags <@ array['cross_page', 'merged_cross_page', 'has_figure', 'has_formula',
                         'answer_missing', 'blank_mismatch', 'qno_gap', 'low_confidence',
                         'dup_in_job', 'dup_in_bank', 'truncated', 'no_analysis',
                         'ai_analysis', 'ai_answer']);

comment on column public.import_job_items.flags is
  '需人工注意的点：跨页/含图/含公式/缺答案/AI 推导的答案/空位不匹配/跳号/低置信/重复';
