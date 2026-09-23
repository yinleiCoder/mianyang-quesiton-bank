-- 0071: 把 2026-09-22 那批导入题的标签由 word 改回 excel。
--
-- 背景：任务 b4a1d5f2「word教材习题」（源文件 习题2(1).pdf）于 2026-09-22 11:49 入库
-- 232 道题，建任务时标签错选成 word。逐题核对题干：232 题全部是电子表格内容
-- （工作表 / 单元格 / 填充柄 / 图表 / 嵌套函数 / 排序筛选），没有一题是 Word 内容；
-- 而同库其它挂着 word 标签的批次（Word 2010应用基础(二)、word(一)课后作业、
-- 09-18 那 8 题）题干确实是 Word，**不在本次范围内**，所以只按任务锚点取这一批，
-- 不做"按标签名批量替换"那种会误伤的动作。
--
-- 改两处：
--   · version_tags —— 每道题的 word 行换成 excel 行。tag_name 是建版本时的快照列
--     （见 0003：改名/合并不影响历史展示），前端列表和详情页读的就是它
--     （lib/question-workbench.js），所以换标签必须连快照一起改，只换 tag_id 会
--     出现"库里是 excel、页面上还是 word"。
--   · import_jobs.tag_ids —— 任务的标签配置，是这次错选的源头；不改的话复盘重跑
--     这单任务还会带上 word。
--
-- 不用动的地方（改之前逐个确认过）：
--   · question_versions.search_text 只收题干纯文本（question_search_text 不含标签），
--     与标签无关，不需要重算；
--   · questions 表不存标签，questions/approvals 的内容与状态一概不变——这是分类纠正，
--     不是内容改版，不触发版本流转、也不需要重新走审批；
--   · version_tags 上没有触发器，question_versions 的 guard_version_immutable
--     只管版本行本身，本迁移不碰它。
--
-- 幂等：重复执行等于无操作（excel 行已存在则 on conflict do nothing，word 行已删干净
-- 则删 0 行）；全新库上找不到该任务，直接跳过。

do $$
declare
  v_job     constant uuid := 'b4a1d5f2-8a9c-4279-9338-9e811b09a4c9';
  v_word    uuid;
  v_excel   uuid;
  v_targets uuid[];
  v_added   int;
  v_removed int;
  v_jobs    int;
begin
  select id into v_word  from public.tags where name = 'word';
  select id into v_excel from public.tags where name = 'excel';
  if v_word is null or v_excel is null then
    raise exception '标签 word/excel 不存在，无法纠正（检查环境）';
  end if;

  -- 目标集合：该任务已入库题目对应的版本（锚点在 import_job_items）
  select array_agg(distinct i.version_id)
    into v_targets
    from public.import_job_items i
   where i.job_id = v_job
     and i.version_id is not null;

  if v_targets is null then
    raise notice '任务 % 不存在或没有入库题目，跳过', v_job;
    return;
  end if;

  -- 只对"当前确实挂着 word"的版本补 excel：既不误加，也天然幂等
  insert into public.version_tags (version_id, tag_id, tag_name)
  select t.vid, v_excel, 'excel'
    from unnest(v_targets) as t(vid)
    join public.version_tags w
      on w.version_id = t.vid and w.tag_id = v_word
  on conflict (version_id, tag_id) do nothing;
  get diagnostics v_added = row_count;

  delete from public.version_tags vt
   using unnest(v_targets) as t(vid)
   where vt.version_id = t.vid
     and vt.tag_id = v_word;
  get diagnostics v_removed = row_count;

  update public.import_jobs
     set tag_ids = array_replace(tag_ids, v_word, v_excel)
   where id = v_job
     and v_word = any(tag_ids);
  get diagnostics v_jobs = row_count;

  raise notice '标签纠正完成：+% 行 excel，-% 行 word，任务标签配置改 % 条',
    v_added, v_removed, v_jobs;
end $$;
