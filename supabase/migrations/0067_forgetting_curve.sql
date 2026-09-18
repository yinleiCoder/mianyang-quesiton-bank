-- 0067: 遗忘曲线 —— practice_dashboard 增加 forgetting_curve 字段。
--
-- 产品要求：首页原「近两周练习」折线图换成「遗忘曲线图」，参考墨墨背单词的做法 ——
-- 那里是把**用户自己的遗忘曲线**与**艾宾浩斯理论曲线**画在同一张图上对比。
--
-- 真实曲线怎么来的：把每一次作答按「距上次练同一道题的间隔天数」分桶，统计该桶的答对率。
-- 间隔越长答对率越低，这条下降的曲线就是学生自己的遗忘保持率。
-- 理论曲线（艾宾浩斯）是常量，画在图里即可，不进数据库。
--
-- 为什么并进 practice_dashboard 而不是单开一个 RPC：首页的数据全由这一个 RPC 供，
-- DashboardStore 也只在它一处刷新（练习完自动更新）。另开一个 RPC 就得再配一套
-- 刷新时机，为一个图不值当。jsonb 加键是向后兼容的。
--
-- **本迁移不重抄整个函数体**（100 行，抄错一个字就是事故），改用「读线上定义 + 定点替换
-- + 三处替换逐一校验」。任何一处没替换成功就整体失败 —— 宁可失败也不要静默留下半成品。

do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'practice_dashboard';

  if v_def is null then
    raise exception '找不到 practice_dashboard';
  end if;

  -- 1) 声明变量
  v_new := replace(
    v_def,
    E'  v_heatmap_daily jsonb;\nbegin',
    E'  v_heatmap_daily jsonb;\n  v_curve jsonb;\nbegin');
  if v_new = v_def then
    raise exception 'practice_dashboard 的 declare 段与预期不符（变量声明未插入）';
  end if;

  -- 2) 计算曲线（插在 return 之前）
  v_def := v_new;
  v_new := replace(
    v_def,
    E'  return jsonb_build_object(\n    ''total_answers'', v_total,',
    E'  -- 遗忘曲线：把每一次作答按「距上次练同一道题的间隔」分桶，统计该桶的答对率。\n'
    || E'  -- 间隔越长答对率越低 —— 这条下降的曲线就是学生**自己**的遗忘保持率。\n'
    || E'  --\n'
    || E'  -- 只统计 is_correct 非空的作答（主观题自评前是 NULL，算进来会被当成答错）。\n'
    || E'  -- 窗口函数按 question_id 分区取上一次作答时间；第一次练某题没有"上一次"，\n'
    || E'  -- gap 为 NULL 天然被排除在曲线之外。\n'
    || E'  select coalesce(jsonb_agg(jsonb_build_object(\n'
    || E'           ''days'', b.bucket_days, ''attempts'', b.n, ''correct'', b.k) order by b.bucket_days), ''[]''::jsonb)\n'
    || E'    into v_curve\n'
    || E'  from (\n'
    || E'    select case\n'
    || E'             when p.gap < 1  then 0\n'
    || E'             when p.gap < 2  then 1\n'
    || E'             when p.gap < 3  then 2\n'
    || E'             when p.gap < 5  then 3\n'
    || E'             when p.gap < 7  then 5\n'
    || E'             when p.gap < 14 then 7\n'
    || E'             when p.gap < 30 then 14\n'
    || E'             else 30\n'
    || E'           end as bucket_days,\n'
    || E'           count(*) as n,\n'
    || E'           count(*) filter (where p.is_correct) as k\n'
    || E'    from (\n'
    || E'      select a.is_correct,\n'
    || E'             extract(epoch from (a.answered_at\n'
    || E'               - lag(a.answered_at) over (partition by a.question_id order by a.answered_at))) / 86400.0 as gap\n'
    || E'      from practice_answers a\n'
    || E'      where a.user_id = v_uid and a.is_correct is not null\n'
    || E'    ) p\n'
    || E'    where p.gap is not null\n'
    || E'    group by 1\n'
    || E'  ) b;\n\n'
    || E'  return jsonb_build_object(\n    ''total_answers'', v_total,');
  if v_new = v_def then
    raise exception 'practice_dashboard 的 return 段与预期不符（曲线计算未插入）';
  end if;

  -- 3) 把曲线塞进返回值
  v_def := v_new;
  v_new := replace(
    v_def,
    E'    ''heatmap_to'', to_char(date_trunc(''day'', now()), ''YYYY-MM-DD''),',
    E'    ''heatmap_to'', to_char(date_trunc(''day'', now()), ''YYYY-MM-DD''),\n'
    || E'    ''forgetting_curve'', v_curve,');
  if v_new = v_def then
    raise exception 'practice_dashboard 的返回值与预期不符（forgetting_curve 键未插入）';
  end if;

  execute v_new;
end $$;
