-- 0056: 考生端的两个只读入口：「我的考试记录」与「单场考试详情」。
--
-- 服务端此前只有「起考 / 交卷 / 阅卷」，考生查不了自己的历史。看似 PostgREST 直查
-- exam_attempts 就够了（它有 select_own 策略），但试卷标题在 paper_versions 上，
-- 而那条策略只放行**仍是当前入库版**的那一版——试卷一改版，历史成绩就查不到标题，
-- 列表变成一片「（无标题）」。所以读路径与 list_papers 同口径，走 definer。
--
-- **标准答案的可见性由本文件决定。** 这是本迁移唯一有产品含义的地方：
--   · 考试中（start_exam_attempt）：卷面剥掉答案（exam_paper_json，见 0052）；
--   · 出分后（status = 'graded'）：换成带答案的完整快照（paper_version_json）。
-- 界线画在「教师点过出成绩」那一刻，而不是「交卷」那一刻：待阅卷期间就把答案发下去，
-- 等于让学生在自己还没被判分的时候先看到正确答案。
--
-- 主观题（含含主观子题的复合题）在出分前一直是 pending，学生只看得到「待阅卷」。

-- =====================================================================
-- 我的考试记录
-- =====================================================================
-- 进行中的那场也要列出来：它是「继续答题」的唯一入口——
-- 学生交卷前退出客户端，再回来时得能从列表里接着答（start_exam_attempt 也认这唯一一场）。
create or replace function public.list_my_exam_attempts(
  p_limit int default 20, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb;
  v_total int;
begin
  select count(*)::int into v_total from exam_attempts where user_id = v_uid;

  select coalesce(jsonb_agg(x.payload order by x.sort_key desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'attempt_id', a.id, 'paper_id', a.paper_id,
               'paper_version_id', a.paper_version_id,
               -- 标题取的是**这场考试当时用的那一版**，不是试卷的当前版：
               -- 卷子事后改版，历史成绩单上仍要写当时那个卷名。
               'title', v.title, 'exam_name', v.exam_name, 'subject_label', v.subject_label,
               'status', a.status, 'started_at', a.started_at, 'deadline_at', a.deadline_at,
               'submitted_at', a.submitted_at, 'graded_at', a.graded_at,
               'total_score', a.total_score, 'full_score', a.full_score,
               'objective_score', a.objective_score, 'subjective_score', a.subjective_score,
               'pending_review_count', a.pending_review_count, 'duration_ms', a.duration_ms,
               'item_count', (select count(*) from paper_items i
                              where i.paper_version_id = a.paper_version_id)
             ) as payload,
             coalesce(a.submitted_at, a.started_at) as sort_key
      from exam_attempts a
      join paper_versions v on v.id = a.paper_version_id
      where a.user_id = v_uid
      order by sort_key desc
      limit v_limit offset v_offset
    ) x;

  return jsonb_build_object(
    'total', v_total, 'limit', v_limit, 'offset', v_offset, 'attempts', v_rows);
end;
$$;

-- =====================================================================
-- 单场考试详情（成绩单 / 出分后的复盘）
-- =====================================================================
-- 与 start_exam_attempt 返回**同一个形状**（attempt / paper / answers），
-- 客户端因此能用同一套模型吃下「开考」「续考」「查成绩」三条路径。
-- answers 比 start 那次多带了判分字段（units / score / grading / is_correct / comment），
-- start 的瘦对象里没有它们，缺字段按默认值解析即可。
create or replace function public.get_my_exam_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
begin
  select * into v_a from exam_attempts where id = p_attempt_id;
  if not found then
    raise exception '考试记录不存在';
  end if;
  -- 阅卷人另有 get_exam_attempt_for_review；本函数只服务考生本人。
  if v_a.user_id is distinct from v_uid then
    raise exception '这不是你的考试' using errcode = '42501';
  end if;

  return jsonb_build_object(
    -- graded_by 是教师 id，考生不需要知道是谁判的
    'attempt', (select to_jsonb(a) - 'graded_by' from exam_attempts a where a.id = v_a.id),
    -- 唯一的分叉点，见文件头。两个函数的差别**只有 content.answer 在不在**。
    'paper', case when v_a.status = 'graded'
                  then public.paper_version_json(v_a.paper_version_id)
                  else public.exam_paper_json(v_a.paper_version_id) end,
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'paper_item_id', aa.paper_item_id, 'seq', aa.seq, 'answer', aa.answer,
               'units', aa.units, 'score', aa.score, 'grading', aa.grading,
               'is_correct', aa.is_correct, 'comment', aa.comment) order by aa.seq)
      from exam_answers aa where aa.attempt_id = v_a.id), '[]'::jsonb));
end;
$$;

revoke execute on function public.list_my_exam_attempts(int, int) from public, anon;
revoke execute on function public.get_my_exam_attempt(uuid) from public, anon;

grant execute on function public.list_my_exam_attempts(int, int) to authenticated;
grant execute on function public.get_my_exam_attempt(uuid) to authenticated;
