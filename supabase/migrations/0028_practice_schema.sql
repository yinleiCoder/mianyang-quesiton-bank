-- 0028: 刷题练习数据表（会话 / 题单项 / 作答记录 / 收藏）。
-- 面向 Flutter 刷题客户端（学生与教师均可用），云端保存做题历史、错题本、收藏与统计。
--   · practice_sessions：一次组卷（筛选条件快照 + 进度计数 + 计时）；每人同时至多一套进行中；
--   · practice_session_items：组卷题目快照（固定 version_id 与顺序），支持"继续练习"精确定位；
--   · practice_answers：逐题作答与判分结果（服务端判分为准，自评题记 self_mastered）；
--   · question_favorites：收藏（仅已入库且上线的题可收藏，由 RPC 校验）。
-- 读路径：仅本人可读（RLS own-row）；写路径全部走 0029 的 SECURITY DEFINER RPC，客户端无 DML。

-- ============ 表结构 ============
create table public.practice_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  source          text not null default 'all' check (source in ('all', 'wrong', 'favorites')),
  subject_node_id uuid references public.subject_nodes(id) on delete set null,
  qtypes          text[],
  difficulty      smallint,
  tag_id          uuid references public.tags(id) on delete set null,
  keyword         text,
  total_count     int not null default 0,
  answered_count  int not null default 0,
  correct_count   int not null default 0,
  status          text not null default 'active' check (status in ('active', 'submitted', 'abandoned')),
  started_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  duration_ms     bigint not null default 0,
  created_at      timestamptz not null default now()
);
comment on table public.practice_sessions is '刷题会话（组卷快照 + 进度），每人同时至多一个 active';

-- 每人至多一套进行中的练习
create unique index uq_practice_one_active on public.practice_sessions (user_id) where status = 'active';
create index idx_practice_sessions_user on public.practice_sessions (user_id, started_at desc);

create table public.practice_session_items (
  session_id  uuid not null references public.practice_sessions(id) on delete cascade,
  seq         int not null,
  question_id uuid not null references public.questions(id) on delete cascade,
  version_id  uuid not null references public.question_versions(id),
  primary key (session_id, seq),
  unique (session_id, question_id)
);
comment on table public.practice_session_items is '组卷题目快照：固定版本与顺序（换版/下线不中断本次练习）';
create index idx_psession_items_version on public.practice_session_items (version_id);

create table public.practice_answers (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.practice_sessions(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  question_id   uuid not null references public.questions(id) on delete cascade,
  version_id    uuid not null references public.question_versions(id),
  answer        jsonb not null default '{}'::jsonb,
  grading       text not null default 'auto' check (grading in ('auto', 'self', 'none')),
  is_correct    boolean,
  self_mastered boolean,
  duration_ms   bigint not null default 0,
  answered_at   timestamptz not null default now(),
  unique (session_id, question_id)
);
comment on table public.practice_answers is '逐题作答记录（服务端判分；主观题为自评 self_mastered）';
create index idx_panswers_user_time on public.practice_answers (user_id, answered_at desc);
create index idx_panswers_question on public.practice_answers (question_id, is_correct);
create index idx_panswers_user_question on public.practice_answers (user_id, question_id, answered_at desc);

create table public.question_favorites (
  user_id     uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, question_id)
);
comment on table public.question_favorites is '题目收藏（每人每题目一行）';

-- ============ RLS：仅本人可读 ============
alter table public.practice_sessions enable row level security;
alter table public.practice_session_items enable row level security;
alter table public.practice_answers enable row level security;
alter table public.question_favorites enable row level security;

drop policy if exists select_own on public.practice_sessions;
create policy select_own on public.practice_sessions for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists select_own on public.practice_session_items;
create policy select_own on public.practice_session_items for select to authenticated
  using (exists (
    select 1 from public.practice_sessions s
    where s.id = session_id and s.user_id = (select auth.uid())
  ));

drop policy if exists select_own on public.practice_answers;
create policy select_own on public.practice_answers for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists select_own on public.question_favorites;
create policy select_own on public.question_favorites for select to authenticated
  using (user_id = (select auth.uid()));

-- ============ 授权收口：无 DML，仅本人只读 ============
revoke all on public.practice_sessions, public.practice_session_items,
  public.practice_answers, public.question_favorites
  from anon, authenticated;

grant select on public.practice_sessions, public.practice_session_items,
  public.practice_answers, public.question_favorites
  to authenticated;
