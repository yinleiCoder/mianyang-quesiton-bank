-- 0051: 考试与阅卷 —— 作答记录 + 逐计分点判分 + 教师在线阅卷。
--
-- 本轮 Flutter 端"挑一套卷考试"还没做，但**表结构与判分引擎一次设计到位**，
-- 下一轮只加客户端，不再动库。
--
-- 与练习模块（0028-0031）的关系：刻意分开，不共用 practice_* 那套。
--   · 练习是"自己的错题本"，可以随时改答、随时看答案；
--   · 考试是有时限、有分值、要交给老师判分的，两者生命周期完全不同。
--   混在一张表里，迟早要在一堆 `if mode = 'exam'` 上打补丁。
--
-- 判分**必须新写 grade_exam_units**，绝不能复用练习的 grade_answer：
-- 后者是"全对才 true"的布尔语义，用在按空给分的填空题上，
-- 学生答对 3 空错 1 空会被判 0 分。反过来也不要改 grade_answer——练习的判分口径不动。

-- =====================================================================
-- 1) 表
-- =====================================================================
create table public.exam_attempts (
  id                   uuid primary key default gen_random_uuid(),
  paper_id             uuid not null references public.papers(id) on delete restrict,
  paper_version_id     uuid not null references public.paper_versions(id) on delete restrict,
  user_id              uuid not null references auth.users(id) on delete cascade,
  status               text not null default 'in_progress'
                       check (status in ('in_progress','submitted','grading','graded','abandoned','expired')),
  started_at           timestamptz not null default now(),
  -- 截止时刻由服务端算，客户端只读——防止改本机时间续命
  deadline_at          timestamptz,
  submitted_at         timestamptz,
  graded_at            timestamptz,
  -- 满分快照：起考时冻结。试卷日后改版不能让历史成绩的分母跟着变
  full_score           numeric(7,2) not null default 0,
  objective_full_score numeric(7,2) not null default 0,
  objective_score      numeric(7,2) not null default 0,
  subjective_score     numeric(7,2) not null default 0,
  total_score          numeric(7,2) not null default 0,
  pending_review_count int not null default 0,
  duration_ms          bigint not null default 0,
  graded_by            uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now()
);
comment on table public.exam_attempts is '一次考试作答；full_score 起考时冻结，历史成绩的分母不随试卷改版变化';

-- 同一份卷同一个人同时至多一场进行中（历史补考不受限）
create unique index uq_exam_one_active on public.exam_attempts (paper_version_id, user_id)
  where status = 'in_progress';
create index idx_exam_attempts_paper on public.exam_attempts (paper_version_id, status, submitted_at desc);
create index idx_exam_attempts_user on public.exam_attempts (user_id, started_at desc);
create index idx_exam_attempts_pending on public.exam_attempts (paper_id) where status = 'submitted';

create table public.exam_answers (
  id                  uuid primary key default gen_random_uuid(),
  attempt_id          uuid not null references public.exam_attempts(id) on delete cascade,
  paper_item_id       uuid not null references public.paper_items(id) on delete restrict,
  seq                 int not null,
  answer              jsonb not null default '{}'::jsonb,
  -- 逐计分点判定：[{"ok":true,"score":2}, ...]，长度与 paper_items.score_units 一致
  units               jsonb not null default '[]'::jsonb,
  auto_score          numeric(7,2) not null default 0,
  -- 教师给分；NULL = 还没批
  manual_score        numeric(7,2),
  score               numeric(7,2) not null default 0,
  grading             text not null default 'auto' check (grading in ('auto','manual','pending')),
  is_correct          boolean,
  comment             text,
  scored_by           uuid references auth.users(id) on delete set null,
  scored_at           timestamptz,
  duration_ms         bigint not null default 0,
  answered_at         timestamptz,
  unique (attempt_id, paper_item_id)
);
comment on table public.exam_answers is '逐题作答与判分；主观题 grading=pending，教师给分后转 manual';

create index idx_exam_answers_attempt on public.exam_answers (attempt_id, seq);

-- =====================================================================
-- 2) 判分引擎
-- =====================================================================
-- 归一化：去空白、全角转半角、小写。与练习的 norm_answer_text 同一口径，
-- 但**各自独立**——两边的判分策略将来可能分叉（比如考试对大小写更严格）。
create or replace function public.exam_norm_text(p text)
returns text
language sql
immutable
as $$
  select lower(btrim(translate(coalesce(p, ''),
    '　ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ０１２３４５６７８９',
    ' ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')));
$$;

-- 客观题逐计分点判分。返回 jsonb：
--   {"grading":"auto"|"manual", "units":[bool...], "is_correct":bool}
-- units 的长度必须与 paper_items.score_units 一致（调用方保证）。
create or replace function public.grade_exam_units(
  p_qtype text, p_content jsonb, p_answer jsonb, p_unit_count int)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_ans jsonb := coalesce(p_answer, '{}'::jsonb);
  v_units boolean[] := '{}';
  v_i int;
  v_sub jsonb;
  v_given jsonb;
  v_ok boolean;
  v_all boolean;
  v_n int;
begin
  -- 学生点"不会"：全部计分点判错，但仍算一次作答（与练习口径一致）
  if v_ans ->> 'type' = 'unknown' then
    return jsonb_build_object('grading', 'auto',
      'units', (select jsonb_agg(false) from generate_series(1, greatest(p_unit_count, 1))),
      'is_correct', false);
  end if;

  if p_qtype in ('single_choice', 'multiple_choice') then
    -- 选择题没有部分分：多选'漏选给一半'这类规则各校不同，要做得先有配置，本期不做
    v_ok := coalesce(
      (select array_agg(upper(k) order by upper(k)) from jsonb_array_elements_text(v_ans -> 'keys') k),
      '{}'::text[])
      = coalesce(
      (select array_agg(upper(k) order by upper(k)) from jsonb_array_elements_text(p_content -> 'answer' -> 'keys') k),
      '{}'::text[]);
    v_units := array_fill(v_ok, array[greatest(p_unit_count, 1)]);
    return jsonb_build_object('grading', 'auto', 'units', to_jsonb(v_units), 'is_correct', v_ok);
  end if;

  if p_qtype = 'true_false' then
    v_ok := (v_ans ->> 'value')::boolean is not distinct from (p_content -> 'answer' ->> 'value')::boolean;
    v_units := array_fill(v_ok, array[greatest(p_unit_count, 1)]);
    return jsonb_build_object('grading', 'auto', 'units', to_jsonb(v_units), 'is_correct', v_ok);
  end if;

  if p_qtype = 'fill_blank' then
    -- **按空给分**：这正是"每空的分数"落地的地方。
    -- 学生填的答案与标准答案按序逐空比对，对几个给几分。
    v_given := coalesce(v_ans -> 'values', '[]'::jsonb);
    for v_i in 0 .. p_unit_count - 1 loop
      v_ok := public.exam_norm_text(v_given ->> v_i) <> ''
              and public.exam_norm_text(v_given ->> v_i)
                  = public.exam_norm_text(p_content -> 'answer' -> 'values' ->> v_i);
      v_units := v_units || v_ok;
    end loop;
    -- is_correct = 全部给分点都拿到（`false = any` 比 array 包含运算符好读，也不会在空数组上炸）
    return jsonb_build_object('grading', 'auto', 'units', to_jsonb(v_units),
      'is_correct', not (false = any(v_units)));
  end if;

  if p_qtype = 'composite' then
    -- 复合题：一个子题一个计分点。子题是简答 → 整题转人工
    v_units := array_fill(false, array[greatest(p_unit_count, 1)]);
    v_all := true;
    for v_i in 0 .. jsonb_array_length(coalesce(p_content -> 'sub', '[]'::jsonb)) - 1 loop
      v_sub := p_content -> 'sub' -> v_i;
      if v_sub ->> 'type' = 'short_answer' then
        return jsonb_build_object('grading', 'manual', 'units', to_jsonb(v_units), 'is_correct', null);
      end if;
      if v_i <= p_unit_count - 1 then
        v_units[v_i + 1] := public.grade_sub_objective(
          v_sub ->> 'type', v_sub, v_ans -> 'subs' -> v_i);
      end if;
    end loop;
    return jsonb_build_object('grading', 'auto', 'units', to_jsonb(v_units),
      'is_correct', not (false = any(v_units)));
  end if;

  -- short_answer：主观题一律人工。给 grading=manual 让上层置 pending
  return jsonb_build_object('grading', 'manual',
    'units', (select jsonb_agg(false) from generate_series(1, greatest(p_unit_count, 1))),
    'is_correct', null);
end;
$$;

-- 复合题的单个子题判分（客观子题）
create or replace function public.grade_sub_objective(p_type text, p_sub jsonb, p_given jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case p_type
    when 'single_choice' then
      coalesce((select array_agg(upper(k) order by upper(k)) from jsonb_array_elements_text(coalesce(p_given -> 'keys', '[]'::jsonb)) k), '{}'::text[])
        = coalesce((select array_agg(upper(k) order by upper(k)) from jsonb_array_elements_text(coalesce(p_sub -> 'answer' -> 'keys', '[]'::jsonb)) k), '{}'::text[])
    when 'multiple_choice' then
      coalesce((select array_agg(upper(k) order by upper(k)) from jsonb_array_elements_text(coalesce(p_given -> 'keys', '[]'::jsonb)) k), '{}'::text[])
        = coalesce((select array_agg(upper(k) order by upper(k)) from jsonb_array_elements_text(coalesce(p_sub -> 'answer' -> 'keys', '[]'::jsonb)) k), '{}'::text[])
    when 'true_false' then
      (p_given ->> 'value')::boolean is not distinct from (p_sub -> 'answer' ->> 'value')::boolean
    when 'fill_blank' then
      -- 子题里的填空要求**全部**答对才算这个计分点（计分点已经按子题切了，
      -- 再往下拆会让一个子题占多个计分点，与 paper_item_units 的 per_sub 口径冲突）
      not exists (
        select 1 from jsonb_array_elements_text(coalesce(p_sub -> 'answer' -> 'values', '[]'::jsonb)) with ordinality as t(v, ord)
        -- ordinality 给出的是 bigint，而 jsonb ->> 没有 bigint 重载，必须显式转 int
        where public.exam_norm_text(p_given -> 'values' ->> (t.ord - 1)::int) is distinct from public.exam_norm_text(t.v)
      )
      and jsonb_array_length(coalesce(p_given -> 'values', '[]'::jsonb))
          = jsonb_array_length(coalesce(p_sub -> 'answer' -> 'values', '[]'::jsonb))
    else false
  end;
$$;

-- =====================================================================
-- 3) RLS
-- =====================================================================
-- 与练习不同：阅卷人要读**别人的**卷子，所以不能照抄纯 select_own。
create or replace function public.is_paper_grader(p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from papers p
    where p.id = p_paper_id
      and (p.creator_id = (select auth.uid())
           or (select public.is_admin())
           or public.is_school_admin_of_paper(p.id))
  );
$$;

alter table public.exam_attempts enable row level security;
alter table public.exam_answers enable row level security;

drop policy if exists select_exam_attempt on public.exam_attempts;
create policy select_exam_attempt on public.exam_attempts for select to authenticated using (
  user_id = (select auth.uid())
  or (select public.is_paper_grader(paper_id))
);

drop policy if exists select_exam_answer on public.exam_answers;
create policy select_exam_answer on public.exam_answers for select to authenticated using (
  exists (
    select 1 from public.exam_attempts a
    where a.id = exam_answers.attempt_id
      and (a.user_id = (select auth.uid()) or (select public.is_paper_grader(a.paper_id)))
  )
);

revoke all on public.exam_attempts, public.exam_answers from anon, authenticated;
grant select on public.exam_attempts, public.exam_answers to authenticated;

revoke execute on function public.exam_norm_text(text) from public, anon, authenticated;
revoke execute on function public.grade_sub_objective(text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.grade_exam_units(text, jsonb, jsonb, int) from public, anon, authenticated;

revoke execute on function public.is_paper_grader(uuid) from public, anon;
grant execute on function public.is_paper_grader(uuid) to authenticated;
