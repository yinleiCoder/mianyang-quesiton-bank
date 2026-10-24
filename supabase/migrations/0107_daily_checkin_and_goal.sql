-- 0107: 每日打卡 + 今日目标题数
--
-- 用户口径（2026-10-24）：
--   · 打卡数据存云端，**进入软件就算当天打卡**（不是"练过题才算"）；
--   · 今日目标默认 **20 题**（原先是客户端写死的 10），可在「我的」里改；
--   · 连续打卡天数要能跨设备一致，所以不能只放 shared_preferences。
--
-- 为什么单独一张表而不是继续从 practice_answers 推：
--   练题天数 != 打开软件的天数。学生今天只是进来看看错题本，也应该算打卡。
--   把两件事混在一个口径里，改任何一边都会悄悄改掉另一边。
--
-- 历史数据：上线前把**已经练过题的日子**回填成打卡记录，否则老学生的连续天数
-- 会从 1 重新开始（他们明明已经连续练了很多天）。回填按北京时间切日。
--
-- 日界：与抽题口径一致，用 Asia/Shanghai（0069 的 practice_day_start）。
-- 库默认的 UTC 日界会让早上 7 点打开软件的学生被算成"昨天"。

-- =====================================================================
-- 1) 打卡表
-- =====================================================================
create table if not exists public.daily_checkins (
  user_id    uuid not null references auth.users(id) on delete cascade,
  day        date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

comment on table public.daily_checkins is
  '每日打卡：每人每天至多一行。由 record_daily_checkin 写入，只经 SECURITY DEFINER 读写。';

create index if not exists idx_daily_checkins_user_day
  on public.daily_checkins (user_id, day desc);

alter table public.daily_checkins enable row level security;
-- 刻意不建策略：这张表只给 definer 函数用。默认权限会给 anon/authenticated
-- 自动授权，所以必须显式收回（0088 同款处理）。
revoke all on public.daily_checkins from public, anon, authenticated;

-- =====================================================================
-- 2) 今日目标：放在 profiles 上，跨设备同源
-- =====================================================================
alter table public.profiles
  add column if not exists daily_goal smallint not null default 20
  check (daily_goal between 5 and 200);

comment on column public.profiles.daily_goal is
  '今日目标题数（5~200），默认 20。只用于首页进度条与提醒，不参与任何统计或排行。';

-- =====================================================================
-- 3) 回填：把历史上练过题的日子补成打卡
-- =====================================================================
-- 只补"有作答"的日子。没作答、但打开过软件的日子没有历史记录，补不出来，
-- 这是可接受的：从本次上线起，打开软件就会被记下来。
insert into public.daily_checkins (user_id, day)
select distinct pa.user_id,
       (pa.answered_at at time zone 'Asia/Shanghai')::date
from public.practice_answers pa
where pa.user_id is not null
on conflict (user_id, day) do nothing;

-- =====================================================================
-- 4) 打卡 RPC：进软件时调一次，返回连续天数与目标
-- =====================================================================
create or replace function public.record_daily_checkin()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_today date := (now() at time zone 'Asia/Shanghai')::date;
  v_goal smallint;
  v_streak int := 0;
  v_total int;
begin
  insert into public.daily_checkins (user_id, day)
  values (v_uid, v_today)
  on conflict (user_id, day) do nothing;

  select daily_goal into v_goal from public.profiles where user_id = v_uid;

  select count(*) into v_total
  from public.daily_checkins where user_id = v_uid;

  -- 连续段：把日期按行号错位（day - row_number），同一段连续日期的 anchor 相同。
  -- 取"最后一天所在的那一段"的长度 —— 今天刚插入，所以最后一天就是今天。
  with days as (
    select day from public.daily_checkins where user_id = v_uid
  ),
  gaps as (
    select day, day - (row_number() over (order by day))::int as anchor
    from days
  )
  select count(*) into v_streak
  from gaps
  where anchor = (select anchor from gaps order by day desc limit 1);

  return jsonb_build_object(
    'day', to_char(v_today, 'YYYY-MM-DD'),
    'streak_days', coalesce(v_streak, 0),
    'total_days', coalesce(v_total, 0),
    'daily_goal', coalesce(v_goal, 20));
end;
$$;

comment on function public.record_daily_checkin() is
  '记录今天已打卡（幂等）并返回连续打卡天数、累计天数与今日目标。客户端在进入软件时调用。';

revoke execute on function public.record_daily_checkin() from public, anon;
grant execute on function public.record_daily_checkin() to authenticated;

-- =====================================================================
-- 5) 修改今日目标
-- =====================================================================
create or replace function public.set_my_daily_goal(p_goal int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_goal int := coalesce(p_goal, 20);
begin
  if v_goal < 5 or v_goal > 200 then
    raise exception '今日目标应在 5~200 题之间' using errcode = '22023';
  end if;

  update public.profiles set daily_goal = v_goal where user_id = v_uid;
  return v_goal;
end;
$$;

comment on function public.set_my_daily_goal(int) is
  '修改自己的今日目标题数（5~200），返回落库后的值。';

revoke execute on function public.set_my_daily_goal(int) from public, anon;
grant execute on function public.set_my_daily_goal(int) to authenticated;

notify pgrst, 'reload schema';
