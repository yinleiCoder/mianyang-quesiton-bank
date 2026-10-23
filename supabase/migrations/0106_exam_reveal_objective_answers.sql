-- 0106: 交卷后立即揭示客观题答案；顶层简答题仍等阅卷
--
-- 0105 已把复合题（含简答子题）改成按参考答案自动判分。剩下的问题是：
-- 只要卷子里还有**顶层简答题**，attempt 就停在 submitted，get_my_exam_attempt
-- 走的是 exam_paper_json（所有答案都剥掉），于是学生连客观题的答案与解析都看不到。
--
-- 用户 2026-10-22 口径：交卷立即出全部答案，**除非遇到简答题这种主观题**。
-- 落点：
--   · submitted / grading：返回"客观题带答案、顶层简答题不带答案"的卷面；
--   · graded：仍返回完整卷面（所有答案）；
--   · in_progress / abandoned / expired：仍剥掉所有答案（考试中绝不能下发）。
--
-- 实现：
--   · exam_paper_json_impl(version, reveal_objective) —— 唯一的分叉点；
--   · exam_paper_json(version) —— 原入口，永远剥答案（start_exam_attempt 用）；
--   · exam_paper_json_for_result(version) —— 只给"已交卷"的成绩单用。
--   · 复合题整体算客观题（0105），所以 reveal 时保留它的答案；
--     只有 **qtype='short_answer' 的顶层题** 被剥掉。

create or replace function public.exam_paper_json_impl(p_version_id uuid, p_reveal_objective boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_snap jsonb;
  v_secs jsonb;
  v_items jsonb;
begin
  v_snap := public.paper_version_json(p_version_id);
  if v_snap is null then return null; end if;

  select coalesce(jsonb_agg(
           jsonb_set(s, '{items}', coalesce((
             select jsonb_agg(
                      jsonb_set(it, '{content}',
                        case when p_reveal_objective and (it ->> 'qtype') <> 'short_answer'
                             then it -> 'content'
                             else public.strip_answers(it -> 'content') end)
                      order by it -> 'seq')
             from jsonb_array_elements(s -> 'items') it), '[]'::jsonb))
           order by s -> 'sort_order'), '[]'::jsonb)
    into v_secs
    from jsonb_array_elements(v_snap -> 'sections') s;

  select coalesce(jsonb_agg(
           jsonb_set(it, '{content}',
             case when p_reveal_objective and (it ->> 'qtype') <> 'short_answer'
                  then it -> 'content'
                  else public.strip_answers(it -> 'content') end)
           order by it -> 'seq'), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(v_snap -> 'items') it;

  return jsonb_set(jsonb_set(v_snap, '{sections}', v_secs), '{items}', v_items);
end;
$$;

-- 原入口：考试中/未交卷，所有答案都剥掉
create or replace function public.exam_paper_json(p_version_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.exam_paper_json_impl(p_version_id, false);
$$;

-- 成绩单入口：已交卷，客观题带答案，顶层简答题仍剥掉
create or replace function public.exam_paper_json_for_result(p_version_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.exam_paper_json_impl(p_version_id, true);
$$;

-- 考生读成绩单：submitted/grading 走"客观题带答案"，graded 走完整卷面
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
  if v_a.user_id is distinct from v_uid then
    raise exception '这不是你的考试' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'attempt', (select to_jsonb(a) - 'graded_by' from exam_attempts a where a.id = v_a.id),
    'paper', case
               when v_a.status = 'graded' then public.paper_version_json(v_a.paper_version_id)
               when v_a.status in ('submitted', 'grading')
                 then public.exam_paper_json_for_result(v_a.paper_version_id)
               else public.exam_paper_json(v_a.paper_version_id)
             end,
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'paper_item_id', aa.paper_item_id, 'seq', aa.seq, 'answer', aa.answer,
               'units', aa.units, 'score', aa.score, 'grading', aa.grading,
               'is_correct', aa.is_correct, 'comment', aa.comment) order by aa.seq)
      from exam_answers aa where aa.attempt_id = v_a.id), '[]'::jsonb));
end;
$$;

-- 内部助手，不对客户端开放（get_my_exam_attempt / start_exam_attempt 由 definer 调用）
revoke execute on function public.exam_paper_json_impl(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.exam_paper_json_for_result(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
