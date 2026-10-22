-- 0103: 交卷幂等 —— 已交卷/已出分的重复提交返回同一份摘要，不再报"已经交卷了"
--
-- 症状（2026-10-22 用户报）：Flutter 端点交卷后提示"交卷失败"，但服务端其实已经
-- 落库（exam_attempts.status = submitted）。原因是客户端在超时/网络抖动后重试，
-- 第一次请求已经成功，第二次撞上 `status <> 'in_progress'` 的守卫，弹出了失败面板；
-- 学生以为没交上，实际卷子已经在阅卷队列里。
--
-- 修法：
--   1. select ... for update 锁住这场考试：并发的第二次提交会等第一次提交完，
--      再读到 submitted/graded，而不是两边同时判分；
--   2. 已交卷/已出分时直接返回现有摘要（total / full_score / pending_review_count /
--      objective_score），与正常交卷的返回形状一致，客户端照常跳成绩单。
--
-- 与 0068 对练习交卷做幂等是同一类修复；考试这头当时漏了。

create or replace function public.submit_exam_attempt(
  p_attempt_id uuid, p_answers jsonb, p_duration_ms bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
  v_item record;
  v_given jsonb;
  v_res jsonb;
  v_units jsonb;
  v_n int;
  v_pending int := 0;
  v_obj numeric := 0;
begin
  -- 行锁：同一场考试的并发交卷串行化。第二次会等第一次提交，然后走下面的幂等返回。
  select * into v_a from exam_attempts where id = p_attempt_id for update;
  if not found then raise exception '考试记录不存在'; end if;
  if v_a.user_id is distinct from v_uid then raise exception '这不是你的考试'; end if;

  -- 已经交过卷：把现有结果原样还给客户端。**不能报错**——客户端超时重试时，
  -- 报错会让学生看到"交卷失败"，而卷子其实已经在阅卷队列里了。
  if v_a.status in ('submitted', 'graded') then
    return jsonb_build_object(
      'total', v_a.total_score, 'full_score', v_a.full_score,
      'pending_review_count', v_a.pending_review_count,
      'objective_score', v_a.objective_score,
      'objective_full_score', v_a.objective_full_score);
  end if;
  if v_a.status <> 'in_progress' then raise exception '这场考试已经交卷了'; end if;

  for v_item in
    select i.id, i.seq, i.qtype, i.score, i.score_units, qv.content
    from paper_items i
    join question_versions qv on qv.id = i.question_version_id
    where i.paper_version_id = v_a.paper_version_id
    order by i.seq
  loop
    v_given := coalesce(
      (select x from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) x
       where x ->> 'paper_item_id' = v_item.id::text limit 1) -> 'answer',
      '{}'::jsonb);
    v_n := greatest(jsonb_array_length(v_item.score_units), 1);
    v_res := public.grade_exam_units(v_item.qtype, v_item.content, v_given, v_n);
    v_units := v_res -> 'units';

    if v_res ->> 'grading' = 'manual' then
      v_pending := v_pending + 1;
      insert into exam_answers (attempt_id, paper_item_id, seq, answer, units, auto_score, score,
                                grading, is_correct, answered_at)
      values (v_a.id, v_item.id, v_item.seq, v_given, v_units, 0, 0, 'pending', null, now())
      on conflict (attempt_id, paper_item_id) do update
        set answer = excluded.answer, units = excluded.units, grading = 'pending',
            auto_score = 0, score = 0, is_correct = null, answered_at = now();
    else
      declare
        v_score numeric;
        v_scored jsonb;
      begin
        select coalesce(jsonb_agg(jsonb_build_object(
                 'ok', (t.u)::boolean,
                 'score', case when (t.u)::boolean
                               then coalesce((v_item.score_units ->> (t.ord - 1)::int)::numeric, 0)
                               else 0 end) order by t.ord), '[]'::jsonb),
               coalesce(sum(case when (t.u)::boolean
                                 then coalesce((v_item.score_units ->> (t.ord - 1)::int)::numeric, 0)
                                 else 0 end), 0)
          into v_scored, v_score
          from jsonb_array_elements(v_units) with ordinality as t(u, ord);
        v_units := v_scored;
        v_obj := v_obj + v_score;

        insert into exam_answers (attempt_id, paper_item_id, seq, answer, units, auto_score, score,
                                  grading, is_correct, answered_at)
        values (v_a.id, v_item.id, v_item.seq, v_given, v_units, v_score, v_score,
                'auto', (v_res ->> 'is_correct')::boolean, now())
        on conflict (attempt_id, paper_item_id) do update
          set answer = excluded.answer, units = excluded.units, grading = 'auto',
              auto_score = excluded.auto_score, score = excluded.score,
              is_correct = excluded.is_correct, answered_at = now();
      end;
    end if;
  end loop;

  update exam_attempts
  set status = case when v_pending > 0 then 'submitted' else 'graded' end,
      submitted_at = now(),
      graded_at = case when v_pending = 0 then now() else null end,
      objective_score = v_obj, total_score = v_obj,
      pending_review_count = v_pending,
      duration_ms = coalesce(p_duration_ms, 0)
  where id = v_a.id;

  begin
    update exam_attempts set is_official = true
    where id = v_a.id
      and not exists (
        select 1 from exam_attempts x
        where x.paper_version_id = v_a.paper_version_id
          and x.user_id = v_a.user_id
          and x.id <> v_a.id
          and x.is_official);
  exception when unique_violation then
    update exam_attempts set is_official = false where id = v_a.id;
  end;

  return jsonb_build_object(
    'total', v_obj, 'full_score', v_a.full_score,
    'pending_review_count', v_pending,
    'objective_score', v_obj, 'objective_full_score', v_a.objective_full_score);
end;
$$;

notify pgrst, 'reload schema';
