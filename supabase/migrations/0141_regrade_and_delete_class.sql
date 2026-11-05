-- 0141: ① 阅卷可以反悔改分；② 学校管理员可以删除班级
--
-- ① 阅卷反悔（2026-11-05 用户提）
--   之前 grade_exam_answer 只接受 status in ('submitted','grading')，
--   一旦点了「完成阅卷」（status='graded'），某道题判错就再也改不回来 ——
--   阅卷台里那道题虽然还列着，但保存必然报「这场考试不在阅卷中」。
--
--   现在允许对已出分的场次重新给分，并把**总分一起重算**：
--   客观分 = sum(score) where grading='auto'，主观分 = sum(score) where grading='manual'，
--   总分 = 两者之和。状态仍是 graded（不需要再点一次"完成阅卷"），graded_at/graded_by
--   记到最后一次改动的人。
--
--   注意：只动这一场考试；不碰成绩榜的合并口径（0118 的 paper_leaderboard
--   仍按 total_score 排序，改完分下一次读榜就是新分数）。
--
-- ② 删除班级
--   班级管理页一直只有「停用」（停用后学生仍在册、仍能在名册里看到）。
--   用户要的是**真删**。安全边界：班里还有学生就拒绝 —— 先转班或移出班级，
--   否则学生会变成 class_id 指向已删除班级的孤儿。
--   权限与 admin_update_class 同源：系统管理员，或该校学校管理员。

-- ---------- ① 阅卷反悔 ----------
create or replace function public.grade_exam_answer(
  p_attempt_id uuid,
  p_paper_item_id uuid,
  p_units jsonb,
  p_comment text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
  v_item paper_items%rowtype;
  v_score numeric;
  v_n int;
begin
  select * into v_a from exam_attempts where id = p_attempt_id;
  if not found then raise exception '考试记录不存在'; end if;
  if not public.is_paper_grader(v_a.paper_id) then
    raise exception '只有试卷作者、本校管理员或系统管理员可以阅卷' using errcode = '42501';
  end if;
  -- 已出分的场次也允许改分（阅卷人反悔），见 0141 头注
  if v_a.status not in ('submitted', 'grading', 'graded') then
    raise exception '这场考试不在阅卷中';
  end if;

  select * into v_item from paper_items where id = p_paper_item_id and paper_version_id = v_a.paper_version_id;
  if not found then raise exception '这道题不属于这场考试'; end if;

  if p_units is null or jsonb_typeof(p_units) <> 'array' then
    raise exception '给分格式错误（应为数组）';
  end if;
  v_n := jsonb_array_length(p_units);
  if v_n <> jsonb_array_length(v_item.score_units) then
    raise exception '给分点数量不对：这题有 % 个给分点，收到 % 个', jsonb_array_length(v_item.score_units), v_n;
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(p_units) with ordinality as t(v, ord)
    where (t.v)::numeric < 0
       or (t.v)::numeric > (v_item.score_units ->> (t.ord - 1)::int)::numeric
  ) then
    raise exception '给分超出了一道题的分值上限';
  end if;

  select coalesce(sum(x::numeric), 0) into v_score from jsonb_array_elements_text(p_units) x;

  update exam_answers
  set units = coalesce((
        select jsonb_agg(jsonb_build_object(
                 'ok', (t.v)::numeric >= (v_item.score_units ->> (t.ord - 1)::int)::numeric,
                 'score', (t.v)::numeric) order by t.ord)
        from jsonb_array_elements_text(p_units) with ordinality as t(v, ord)), '[]'::jsonb),
      manual_score = v_score,
      score = v_score,
      grading = 'manual',
      is_correct = v_score >= v_item.score,
      comment = p_comment,
      scored_by = v_uid,
      scored_at = now()
  where attempt_id = p_attempt_id and paper_item_id = p_paper_item_id;

  update exam_attempts
  set pending_review_count = (
        select count(*) from exam_answers
        where attempt_id = p_attempt_id and grading = 'pending'),
      -- 每次给分都重算这道场次的三个分：已出分的场次改分后总分必须跟着变
      objective_score = coalesce((select sum(score) from exam_answers
                                  where attempt_id = p_attempt_id and grading = 'auto'), 0),
      subjective_score = coalesce((select sum(score) from exam_answers
                                   where attempt_id = p_attempt_id and grading = 'manual'), 0),
      total_score = coalesce((select sum(score) from exam_answers
                              where attempt_id = p_attempt_id), 0),
      status = case when v_a.status = 'graded' then 'graded' else 'grading' end,
      graded_at = case when v_a.status = 'graded' then now() else graded_at end,
      graded_by = case when v_a.status = 'graded' then v_uid else graded_by end
  where id = p_attempt_id;

  return jsonb_build_object('score', v_score, 'grading', 'manual');
end;
$$;

-- ---------- ② 删除班级 ----------
create or replace function public.admin_delete_class(p_class_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_school uuid;
  v_students int;
begin
  perform public.require_uid();
  select school_id into v_school from classes where id = p_class_id;
  if not found then
    raise exception '班级不存在';
  end if;
  if not (public.is_admin() or public.is_school_admin(v_school)) then
    raise exception '仅该校学校管理员可删除班级' using errcode = '42501';
  end if;

  select count(*) into v_students from profiles where class_id = p_class_id;
  if v_students > 0 then
    raise exception '这个班还有 % 名学生，请先在「学生名册」里把他们转到别的班或移出班级，再删除', v_students;
  end if;

  delete from classes where id = p_class_id;
  perform public.audit('admin_delete_class', null, null,
    jsonb_build_object('class_id', p_class_id, 'school_id', v_school));
end;
$$;

revoke execute on function public.admin_delete_class(uuid) from public, anon;
grant execute on function public.admin_delete_class(uuid) to authenticated;
