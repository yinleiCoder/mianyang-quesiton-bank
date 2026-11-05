-- 0125: FSRS-6 记忆状态（只读计算层）
--
-- 目的：把 0059 的固定 1/2/4/7/15/30 天阶梯换成 DSR 记忆模型：
--   R(t,S) = (1 + F*t/S)^(-w20)，F = 0.9^(-1/w20)-1，R(S,S)=0.9；
--   给定目标保持率 r，间隔 I = (S/F)*(r^(-1/w20)-1)，r=0.9 时 I=S。
-- 二元数据映射：对 → Good(3)，错 → Again(1)；P1 用官方默认权重，不按用户拟合。
--
-- 计算型、不写回：每次抽题只 replay 一次（平均 ~346 条/用户），
-- 不新增写路径、不做历史 backfill。性能不够再考虑缓存表。
--
-- 上限：due_at 取 min(FSRS 间隔, max_interval_days=180)。这条是“已掌握题也
-- 不会永远不出现”的保证；没有它，S 很大的题可能几年都不再到期。

create or replace function public.practice_fsrs_weights()
returns double precision[]
language sql
immutable
as $$
  select array[
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
    1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
    1.8729, 0.5425, 0.0912, 0.0658, 0.1542
  ]::double precision[];
$$;

-- FSRS-6 初始状态：rating 1=Again / 3=Good（二元数据不会出现 2/4）
create or replace function public.practice_fsrs_initial(p_rating int)
returns table (stability double precision, difficulty double precision)
language plpgsql
immutable
as $$
declare
  w double precision[] := public.practice_fsrs_weights();
  v_rating int := greatest(1, least(4, coalesce(p_rating, 3)));
begin
  return query select
    w[v_rating]::double precision,
    least(10, greatest(1, w[5] - exp(w[6] * (v_rating - 1)) + 1));
end;
$$;

create or replace function public.practice_fsrs_retrievability(
  p_stability double precision,
  p_elapsed_days double precision)
returns double precision
language plpgsql
immutable
as $$
declare
  w double precision[] := public.practice_fsrs_weights();
  v_s double precision := greatest(coalesce(p_stability, 0.01), 0.01);
  v_t double precision := greatest(coalesce(p_elapsed_days, 0), 0);
  v_factor double precision := power(0.9, -1.0 / w[21]) - 1;
begin
  return least(1, greatest(0, power(1 + v_factor * v_t / v_s, -w[21])));
end;
$$;

create or replace function public.practice_fsrs_interval(
  p_stability double precision,
  p_retention double precision default 0.9)
returns double precision
language plpgsql
immutable
as $$
declare
  w double precision[] := public.practice_fsrs_weights();
  v_s double precision := greatest(coalesce(p_stability, 0.01), 0.01);
  v_r double precision := least(0.98, greatest(0.70, coalesce(p_retention, 0.9)));
  v_factor double precision := power(0.9, -1.0 / w[21]) - 1;
begin
  return (v_s / v_factor) * (power(v_r, -1.0 / w[21]) - 1);
end;
$$;

create or replace function public.practice_fsrs_next(
  p_stability double precision,
  p_difficulty double precision,
  p_elapsed_days double precision,
  p_correct boolean)
returns table (stability double precision, difficulty double precision)
language plpgsql
immutable
as $$
#variable_conflict use_column
declare
  w double precision[] := public.practice_fsrs_weights();
  v_s double precision := greatest(coalesce(p_stability, 0.01), 0.01);
  v_d double precision := least(10, greatest(1, coalesce(p_difficulty, 5)));
  v_t double precision := greatest(coalesce(p_elapsed_days, 0), 0);
  v_rating int := case when p_correct then 3 else 1 end;
  v_r double precision := public.practice_fsrs_retrievability(v_s, v_t);
  v_s_new double precision;
  v_d_star double precision;
  v_d0_easy double precision := (select i.difficulty from public.practice_fsrs_initial(4) i);
begin
  if p_correct then
    if v_t < 0.5 then
      -- FSRS-6 same-day 分支；答对不允许把稳定性降下去
      v_s_new := greatest(v_s, v_s * exp(w[18] * (v_rating - 3 + w[19])) * power(v_s, -w[20]));
    else
      v_s_new := v_s * (
        1 + exp(w[9]) * (11 - v_d) * power(v_s, -w[10]) * (exp(w[11] * (1 - v_r)) - 1)
      );
    end if;
  else
    v_s_new := least(
      v_s,
      w[12] * power(v_d, -w[13]) * (power(v_s + 1, w[14]) - 1) * exp(w[15] * (1 - v_r))
    );
  end if;

  v_d_star := v_d + (-w[7] * (v_rating - 3)) * (10 - v_d) / 9;
  v_d := least(10, greatest(1, w[8] * v_d0_easy + (1 - w[8]) * v_d_star));

  return query select
    least(36500, greatest(0.01, v_s_new)),
    v_d;
end;
$$;

-- 当前用户的题目级 FSRS 状态。只用 auto 对错；self 自评不入 S/D。
create or replace function public.practice_fsrs_state(
  p_uid uuid,
  p_now timestamptz default now())
returns table (
  question_id uuid,
  reviews int,
  lapses int,
  stability double precision,
  difficulty double precision,
  last_review_at timestamptz,
  last_rating smallint,
  retrievability double precision,
  due_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_max_interval int := coalesce((select max_interval_days from public.practice_config), 180);
begin
  return query
  with recursive seq as (
    select a.question_id,
           a.is_correct,
           a.answered_at,
           row_number() over (partition by a.question_id order by a.answered_at, a.id) as rn
    from public.practice_answers a
    where a.user_id = p_uid
      and a.grading = 'auto'
      and a.is_correct is not null
  ),
  first as (
    select s.question_id, s.answered_at, s.is_correct, s.rn,
           case when s.is_correct then 3 else 1 end as rating,
           i.stability, i.difficulty
    from seq s
    cross join lateral public.practice_fsrs_initial(
      case when s.is_correct then 3 else 1 end
    ) i
    where s.rn = 1
  ),
  state as (
    select question_id, rn, answered_at, is_correct, rating,
           stability, difficulty, 1 as reviews,
           case when is_correct then 0 else 1 end as lapses
    from first
    union all
    select s.question_id, s.rn, s.answered_at, s.is_correct, st.rating,
           n.stability, n.difficulty,
           st.reviews + 1,
           st.lapses + case when s.is_correct then 0 else 1 end
    from state st
    join seq s on s.question_id = st.question_id and s.rn = st.rn + 1
    cross join lateral public.practice_fsrs_next(
      st.stability,
      st.difficulty,
      (greatest(0, extract(epoch from (s.answered_at - st.answered_at)) / 86400))::double precision,
      s.is_correct
    ) n
  ),
  final as (
    select distinct on (st.question_id)
           st.question_id, st.reviews, st.lapses, st.stability, st.difficulty,
           st.answered_at, st.rating
    from state st
    order by st.question_id, st.rn desc
  )
  select f.question_id,
         f.reviews,
         f.lapses,
         f.stability,
         f.difficulty,
         f.answered_at,
         f.rating::smallint,
         public.practice_fsrs_retrievability(
           f.stability,
           (greatest(0, extract(epoch from (p_now - f.answered_at)) / 86400))::double precision
         ),
         least(
           f.answered_at + make_interval(days => greatest(1, round(f.stability)::int)),
           f.answered_at + make_interval(days => v_max_interval)
         )
  from final f;
end;
$$;

-- 曝光账本：服务过（含未作答）的题都算；顺序讲练 scored=false 不算。
create or replace function public.practice_exposure_state(p_uid uuid)
returns table (question_id uuid, exposure_count int, last_exposed_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select psi.question_id,
         count(*)::int as exposure_count,
         max(ps.started_at) as last_exposed_at
  from public.practice_session_items psi
  join public.practice_sessions ps on ps.id = psi.session_id
  where ps.user_id = p_uid and ps.scored
  group by psi.question_id;
$$;

-- 单行配置：算法开关 / 目标保持率 / 最长间隔 / 是否把考试当覆盖证据。
create table if not exists public.practice_config (
  id boolean primary key default true check (id),
  scheduler text not null default 'fsrs' check (scheduler in ('fsrs', 'legacy')),
  include_exam boolean not null default false,
  target_retention numeric not null default 0.90 check (target_retention between 0.70 and 0.98),
  max_interval_days int not null default 180 check (max_interval_days between 1 and 3650),
  updated_at timestamptz not null default now()
);
insert into public.practice_config (id) values (true) on conflict (id) do nothing;

create or replace function public.practice_scheduler_mode()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select scheduler from public.practice_config where id;
$$;

revoke all on public.practice_config from public, anon, authenticated;
revoke execute on function public.practice_fsrs_weights() from public, anon, authenticated;
revoke execute on function public.practice_fsrs_initial(integer) from public, anon, authenticated;
revoke execute on function public.practice_fsrs_retrievability(double precision, double precision)
  from public, anon, authenticated;
revoke execute on function public.practice_fsrs_interval(double precision, double precision)
  from public, anon, authenticated;
revoke execute on function public.practice_fsrs_next(double precision, double precision, double precision, boolean)
  from public, anon, authenticated;
revoke execute on function public.practice_fsrs_state(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.practice_exposure_state(uuid) from public, anon, authenticated;
revoke execute on function public.practice_scheduler_mode() from public, anon, authenticated;

notify pgrst, 'reload schema';
