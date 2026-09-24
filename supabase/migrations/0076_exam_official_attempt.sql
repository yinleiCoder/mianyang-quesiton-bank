-- 0076: 考试的「官方成绩」——本人对**这一版卷面**的第一次交卷。
--
-- 产品口径（用户 2026-09-24）："试卷的第一次考试应正式计入排行，同张试卷的后续考试均为
-- 自主练习不计入排行"。排行榜（0077）只统计官方场次。
--
-- 三个决定，改之前先读：
--  1) **用列 + 部分唯一索引，不是每次现算 row_number()**。
--     「每人每卷面只有一条官方成绩」这条不变量因此写在库里，而不是靠每个读取点各自把
--     窗口函数写对一遍（读的地方至少三处：排行榜、每题统计、我的考试列表；漏一处 tie-break
--     就会出现"两个人都是第 1 名"）。带索引的布尔列也比每次窗口排序便宜。
--  2) **按 paper_version_id 算，不按 paper_id 算**。试卷改版入库后（0044 的
--     create_paper_edit_draft → 新版本 published），那其实是另一套题、另一场考试；
--     按 paper_id 判的话，学生在 v2 上永远只能是"自主练习"，新版榜会**永远是空的**。
--     榜单只显示当前入库版本，所以同一份卷的两版各有一条官方成绩也不会重复出现。
--  3) **交卷时置位，不在判分时置位**。主观题还在待阅卷时，客观分已经定了；
--     排行榜按 status='graded' 过滤是 0077 的事，与这里的标记无关。
--
-- 回填：线上历史的 2 场考试按同样的口径补一遍（每 (版本, 人) 最早一次已交卷的那场）。

alter table public.exam_attempts
  add column if not exists is_official boolean not null default false;

comment on column public.exam_attempts.is_official is
  '是否本人对这一版卷面的第一次交卷（0076）。true 才进排行榜与每题正确率统计；重做一律 false';

update public.exam_attempts a
set is_official = true
where a.id in (
  select distinct on (x.paper_version_id, x.user_id) x.id
  from public.exam_attempts x
  where x.status in ('submitted', 'grading', 'graded')
  order by x.paper_version_id, x.user_id, x.submitted_at nulls last, x.created_at, x.id
);

-- 回填跑在前面：真出现重复会在这里**当场报错**，而不是悄悄留下一份脏数据
create unique index if not exists uq_exam_official
  on public.exam_attempts (paper_version_id, user_id) where is_official;

-- =====================================================================
-- 交卷时置位（签名逐字不变 → 老客户端照常工作，ACL 也不动）
-- =====================================================================
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

  -- 官方资格。**必须在上面那条 update 之后**——不过判定用的是 is_official 而不是
  -- submitted_at：并发下两条 update 可能互相看不见对方刚写上的时间戳，标记则是原子的。
  --
  -- 撞唯一索引时**绝不能把交卷搞失败**：失败模式不对称——标记错了能改（管理员一条
  -- update），交卷失败学生白考一场。所以退化成自主练习即可。
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

-- =====================================================================
-- 我的考试列表带上 is_official（签名不变；返回 jsonb 所以不用 drop）
-- 学生端据此标「自主练习·不计入排行」——P1 里唯一的学生可见变化
-- =====================================================================
create or replace function public.list_my_exam_attempts(p_limit integer default 20, p_offset integer default 0)
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
               'title', v.title, 'exam_name', v.exam_name, 'subject_label', v.subject_label,
               'status', a.status, 'started_at', a.started_at, 'deadline_at', a.deadline_at,
               'submitted_at', a.submitted_at, 'graded_at', a.graded_at,
               'total_score', a.total_score, 'full_score', a.full_score,
               'objective_score', a.objective_score, 'subjective_score', a.subjective_score,
               'pending_review_count', a.pending_review_count, 'duration_ms', a.duration_ms,
               'is_official', a.is_official,
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

notify pgrst, 'reload schema';
