-- 0052: 考试与阅卷的读写 RPC。
--
-- 判分权威在服务端：客户端只提交作答，得分一律由 grade_exam_units 算出来。
-- 主观题（简答，以及含简答子题的复合题）进 pending，教师用 grade_exam_answer 逐计分点给分。

-- =====================================================================
-- 卷面快照（**去掉答案**）
-- =====================================================================
-- 考试用的卷面绝不能带答案：paper_version_json 是给教师/打印用的，它带 content.answer。
-- 这里在服务端把它剥掉再下发——不是"前端不显示"，是根本不发下去。
create or replace function public.strip_answers(p_content jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v jsonb;
  v_subs jsonb;
begin
  if p_content is null then return null; end if;
  v := p_content - 'answer';
  if jsonb_typeof(v -> 'sub') = 'array' then
    select coalesce(jsonb_agg(s - 'answer' order by ord), '[]'::jsonb)
      into v_subs
      from jsonb_array_elements(v -> 'sub') with ordinality as t(s, ord);
    v := jsonb_set(v, '{sub}', v_subs);
  end if;
  return v;
end;
$$;

create or replace function public.exam_paper_json(p_version_id uuid)
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
             select jsonb_agg(jsonb_set(it, '{content}', public.strip_answers(it -> 'content')) order by it -> 'seq')
             from jsonb_array_elements(s -> 'items') it), '[]'::jsonb))
           order by s -> 'sort_order'), '[]'::jsonb)
    into v_secs
    from jsonb_array_elements(v_snap -> 'sections') s;

  select coalesce(jsonb_agg(jsonb_set(it, '{content}', public.strip_answers(it -> 'content')) order by it -> 'seq'), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(v_snap -> 'items') it;

  return jsonb_set(jsonb_set(v_snap, '{sections}', v_secs), '{items}', v_items);
end;
$$;

-- =====================================================================
-- 考试（考生端；本轮 Flutter 未接，接口先就位）
-- =====================================================================

create or replace function public.start_exam_attempt(p_paper_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver paper_versions%rowtype;
  v_paper papers%rowtype;
  v_attempt uuid;
  v_full numeric;
  v_obj_full numeric;
begin
  select * into v_ver from paper_versions where id = p_paper_version_id;
  if not found then
    raise exception '试卷不存在';
  end if;
  if v_ver.status <> 'published' then
    raise exception '这份试卷还没有入库，不能考试';
  end if;
  select * into v_paper from papers where id = v_ver.paper_id;
  if v_paper.state <> 'live' then
    raise exception '这份试卷已下线';
  end if;
  if not exists (select 1 from paper_items where paper_version_id = v_ver.id) then
    raise exception '试卷是空的';
  end if;

  -- 满分快照：起考这一刻冻结。试卷日后改版，历史成绩的分母不会跟着变
  select coalesce(sum(score), 0),
         coalesce(sum(score) filter (where qtype <> 'short_answer'), 0)
    into v_full, v_obj_full
  from paper_items where paper_version_id = v_ver.id;

  begin
    insert into exam_attempts (paper_id, paper_version_id, user_id, status,
                               deadline_at, full_score, objective_full_score)
    values (v_paper.id, v_ver.id, v_uid, 'in_progress',
            now() + make_interval(mins => v_ver.duration_minutes), v_full, v_obj_full)
    returning id into v_attempt;
  exception when unique_violation then
    -- 同一份卷同时只能有一场进行中：把上一场原样交回去，客户端接着答
    select id into v_attempt from exam_attempts
    where paper_version_id = v_ver.id and user_id = v_uid and status = 'in_progress';
    if v_attempt is null then
      raise exception '已经开始过这场考试了，请刷新';
    end if;
  end;

  return jsonb_build_object(
    'attempt', (select to_jsonb(a) - 'graded_by' from exam_attempts a where a.id = v_attempt),
    'paper', public.exam_paper_json(v_ver.id),
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'paper_item_id', aa.paper_item_id, 'answer', aa.answer, 'seq', aa.seq))
      from exam_answers aa where aa.attempt_id = v_attempt), '[]'::jsonb));
end;
$$;

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
  r record;
begin
  select * into v_a from exam_attempts where id = p_attempt_id;
  if not found then raise exception '考试记录不存在'; end if;
  if v_a.user_id is distinct from v_uid then raise exception '这不是你的考试'; end if;
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
      -- 主观题：先给 0 分、置 pending，教师给了分才动 score
      insert into exam_answers (attempt_id, paper_item_id, seq, answer, units, auto_score, score,
                                grading, is_correct, answered_at)
      values (v_a.id, v_item.id, v_item.seq, v_given, v_units, 0, 0, 'pending', null, now())
      on conflict (attempt_id, paper_item_id) do update
        set answer = excluded.answer, units = excluded.units, grading = 'pending',
            auto_score = 0, score = 0, is_correct = null, answered_at = now();
    else
      -- 客观题：逐计分点给分。填空题答对 3 空错 1 空就是 3 空的分，
      -- 这正是"只能全对"的布尔判分做不到的地方。
      --
      -- grade_exam_units 回的是**布尔数组**（对该分点是否拿到），分值在 paper_items.score_units 里，
      -- 所以在这里把两者 zip 起来，落库的 units 才带分数（阅卷页要按分点显示）。
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
      objective_score = v_obj,
      total_score = v_obj,
      pending_review_count = v_pending,
      duration_ms = coalesce(p_duration_ms, 0)
  where id = v_a.id;

  return jsonb_build_object(
    'total', v_obj, 'full_score', v_a.full_score,
    'pending_review_count', v_pending,
    'objective_score', v_obj, 'objective_full_score', v_a.objective_full_score);
end;
$$;

-- =====================================================================
-- 阅卷（教师端）
-- =====================================================================

-- 队列：这份卷子有哪些人要判
create or replace function public.list_exam_attempts_for_paper(
  p_paper_id uuid, p_only_pending boolean default true, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_rows jsonb;
begin
  if not public.is_paper_grader(p_paper_id) then
    raise exception '只有试卷作者、本校管理员或系统管理员可以阅卷' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(x.payload order by x.sort_key desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'attempt_id', a.id, 'user_id', a.user_id, 'user_name', coalesce(p.name, '（已注销）'),
               'status', a.status, 'submitted_at', a.submitted_at, 'graded_at', a.graded_at,
               'total_score', a.total_score, 'full_score', a.full_score,
               'objective_score', a.objective_score, 'subjective_score', a.subjective_score,
               'pending_review_count', a.pending_review_count,
               'duration_ms', a.duration_ms
             ) as payload,
             coalesce(a.submitted_at, a.started_at) as sort_key
      from exam_attempts a
      left join profiles p on p.user_id = a.user_id
      where a.paper_id = p_paper_id
        and a.status in ('submitted', 'grading', 'graded')
        and (not p_only_pending or a.pending_review_count > 0)
      order by sort_key desc
      limit v_limit offset greatest(coalesce(p_offset, 0), 0)
    ) x;

  return jsonb_build_object('attempts', v_rows);
end;
$$;

-- 阅卷详情：题目 + 考生作答 + 参考答案 + 逐计分点评分标准
create or replace function public.get_exam_attempt_for_review(p_attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
  v_snap jsonb;
begin
  select * into v_a from exam_attempts where id = p_attempt_id;
  if not found then raise exception '考试记录不存在'; end if;
  if not public.is_paper_grader(v_a.paper_id) then
    raise exception '只有试卷作者、本校管理员或系统管理员可以阅卷' using errcode = '42501';
  end if;

  -- 阅卷人要看到**带答案**的卷面（不然没法判），所以这里是 paper_version_json 而不是 exam_paper_json
  v_snap := public.paper_version_json(v_a.paper_version_id);

  return jsonb_build_object(
    'attempt', jsonb_build_object(
      'id', v_a.id, 'user_id', v_a.user_id,
      'user_name', coalesce((select name from profiles where user_id = v_a.user_id), '（已注销）'),
      'status', v_a.status, 'submitted_at', v_a.submitted_at, 'graded_at', v_a.graded_at,
      'total_score', v_a.total_score, 'full_score', v_a.full_score,
      'objective_score', v_a.objective_score, 'subjective_score', v_a.subjective_score,
      'pending_review_count', v_a.pending_review_count),
    'paper', v_snap,
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'paper_item_id', aa.paper_item_id, 'seq', aa.seq, 'answer', aa.answer,
               'units', aa.units, 'auto_score', aa.auto_score, 'manual_score', aa.manual_score,
               'score', aa.score, 'grading', aa.grading, 'is_correct', aa.is_correct,
               'comment', aa.comment) order by aa.seq)
      from exam_answers aa where aa.attempt_id = v_a.id), '[]'::jsonb));
end;
$$;

-- 逐计分点给分。p_units = [2, 2, 0] 这样的数组，长度必须等于该题的计分点数。
create or replace function public.grade_exam_answer(
  p_attempt_id uuid, p_paper_item_id uuid, p_units jsonb, p_comment text default null)
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
  if v_a.status not in ('submitted', 'grading') then
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
  -- 逐点封顶：给多了会凭空造分，而总分是按 sum 结算的
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

  -- 还有几题没判。状态统一置 grading，收尾要教师显式点「出成绩」——
  -- 最后一题判完就自动出分的话，教师改主意想重判就没有回旋余地了。
  update exam_attempts
  set pending_review_count = (
        select count(*) from exam_answers
        where attempt_id = p_attempt_id and grading = 'pending'),
      status = 'grading'
  where id = p_attempt_id;

  return jsonb_build_object('score', v_score, 'grading', 'manual');
end;
$$;

-- 结算：把逐题得分汇总成成绩单
create or replace function public.finish_exam_grading(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
  v_obj numeric;
  v_subj numeric;
  v_left int;
begin
  select * into v_a from exam_attempts where id = p_attempt_id;
  if not found then raise exception '考试记录不存在'; end if;
  if not public.is_paper_grader(v_a.paper_id) then
    raise exception '只有试卷作者、本校管理员或系统管理员可以阅卷' using errcode = '42501';
  end if;

  select count(*) into v_left from exam_answers where attempt_id = p_attempt_id and grading = 'pending';
  if v_left > 0 then
    raise exception '还有 % 道题没判分，判完才能出成绩', v_left;
  end if;

  select coalesce(sum(score) filter (where grading = 'auto'), 0),
         coalesce(sum(score) filter (where grading = 'manual'), 0)
    into v_obj, v_subj
  from exam_answers where attempt_id = p_attempt_id;

  update exam_attempts
  set status = 'graded', graded_at = now(), graded_by = v_uid,
      objective_score = v_obj, subjective_score = v_subj, total_score = v_obj + v_subj,
      pending_review_count = 0
  where id = p_attempt_id;

  return jsonb_build_object(
    'total_score', v_obj + v_subj, 'objective_score', v_obj, 'subjective_score', v_subj,
    'full_score', v_a.full_score);
end;
$$;

-- 阅卷台首屏统计
create or replace function public.exam_dashboard(p_paper_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_paper_grader(p_paper_id) then
    raise exception '只有试卷作者、本校管理员或系统管理员可以阅卷' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'total', count(*),
      'pending', count(*) filter (where a.pending_review_count > 0),
      'graded', count(*) filter (where a.status = 'graded'),
      'avg_score', round(avg(a.total_score) filter (where a.status = 'graded'), 2),
      'max_score', max(a.total_score) filter (where a.status = 'graded'),
      'min_score', min(a.total_score) filter (where a.status = 'graded'))
    from exam_attempts a
    where a.paper_id = p_paper_id and a.status in ('submitted','grading','graded'));
end;
$$;

revoke execute on function public.strip_answers(jsonb) from public, anon, authenticated;
revoke execute on function public.exam_paper_json(uuid) from public, anon, authenticated;

revoke execute on function public.start_exam_attempt(uuid) from public, anon;
revoke execute on function public.submit_exam_attempt(uuid, jsonb, bigint) from public, anon;
revoke execute on function public.list_exam_attempts_for_paper(uuid, boolean, int, int) from public, anon;
revoke execute on function public.get_exam_attempt_for_review(uuid) from public, anon;
revoke execute on function public.grade_exam_answer(uuid, uuid, jsonb, text) from public, anon;
revoke execute on function public.finish_exam_grading(uuid) from public, anon;
revoke execute on function public.exam_dashboard(uuid) from public, anon;

grant execute on function public.start_exam_attempt(uuid) to authenticated;
grant execute on function public.submit_exam_attempt(uuid, jsonb, bigint) to authenticated;
grant execute on function public.list_exam_attempts_for_paper(uuid, boolean, int, int) to authenticated;
grant execute on function public.get_exam_attempt_for_review(uuid) to authenticated;
grant execute on function public.grade_exam_answer(uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.finish_exam_grading(uuid) to authenticated;
grant execute on function public.exam_dashboard(uuid) to authenticated;
