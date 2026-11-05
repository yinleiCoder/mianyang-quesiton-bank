-- 0119: 参赛 AI 功能的只读查询索引（只做加法，不改数据语义）。
--
-- 用途：
--   · 智能组卷候选池：practice_answers 按题聚合、paper_versions 按发布时间过滤；
--   · 试题质量 CTT：exam_answers 按 paper_item 聚合；
--   · 知识追踪：practice_session_items 按题回查。
-- 这些索引只影响读性能，不改变任何写入/判分逻辑。
create index if not exists idx_panswers_q_user_time
  on public.practice_answers (question_id, user_id, answered_at)
  where grading = 'auto';

create index if not exists idx_paper_versions_published_at
  on public.paper_versions (published_at desc)
  where status = 'published';

create index if not exists idx_exam_answers_item
  on public.exam_answers (paper_item_id) include (is_correct, score);

create index if not exists idx_psession_items_question
  on public.practice_session_items (question_id);

notify pgrst, 'reload schema';
