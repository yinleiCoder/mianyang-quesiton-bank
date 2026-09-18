-- 0066: 题目反馈 —— 学生做题/看题时发现问题，可直接反馈给**该题作者**，作者据此再审。
--
-- 为什么新开一张表而不是复用 public.feedback：
--   两者只是形状像，**路由目标与可见性完全不同**。
--   feedback 是通用意见反馈，收件人是系统管理员（0033 的 select_admin 策略只放行 is_admin()）；
--   本题反馈挂在具体题目上，收件人是**出题人本人**，学校管理员兜底。
--   塞进一张表就得在 RLS 里按 category 分叉，策略会立刻变得没人看得懂。
--
-- 处理人 = questions.creator_id（作者），**兜底是题目所在学校的学校管理员** ——
-- 没有兜底的话，作者一离职/注销，这条反馈就永远悬着没人管。
--
-- 反馈记录**针对的是学生实际看到的那个版本**（version_id 非空）：作者改版后，
-- 旧反馈自动变成"针对 v3 的"，作者一眼能分清哪些是改版前的。
-- 只记 question_id 的话，改版后所有历史反馈看起来都像在说当前版本，会误导作者。

-- ---------------------------------------------------------------------------
-- 表
-- ---------------------------------------------------------------------------
create table if not exists public.question_reports (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  -- 学生看到的是哪一个版本。改版后旧反馈不会跟着"漂移"到新版本上。
  version_id uuid not null references public.question_versions(id) on delete cascade,
  -- **刻意允许为空**：与 feedback.user_id（级联删除）不同，这里反馈的主体是**题目**、
  -- 不是提交人。学生毕业注销后，这条"这题答案错了"仍然对作者有价值，不该跟着消失。
  -- 展示层对 null 显示「账号已注销」（lib/people.js 已有这套兜法）。
  reporter_id uuid references auth.users(id) on delete set null,
  category text not null,
  content text not null,
  status text not null default 'open',
  resolve_note text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint question_reports_category_check
    check (category in ('stem', 'answer', 'explanation', 'other')),
  constraint question_reports_status_check
    check (status in ('open', 'resolved')),
  -- 下限 2 个字：拦住"？""。"这种没有任何信息量的提交；
  -- 上限 500 是防粘贴整篇文章，真需要长文可以走意见反馈。
  constraint question_reports_content_len
    check (char_length(btrim(content)) between 2 and 500)
);

comment on table public.question_reports is
  '学生对某道题（某个具体版本）的纠错反馈。处理人是题目作者，学校管理员兜底。';

create index if not exists question_reports_question_idx
  on public.question_reports (question_id, created_at desc);
create index if not exists question_reports_open_idx
  on public.question_reports (status, created_at desc) where status = 'open';

-- 同一个学生对同一道题**同时只能有一条未处理反馈**：拦住连点/刷屏。
-- 处理完之后可以再提（比如作者说"已修订"但学生觉得没改对）。
-- 用部分唯一索引而不是在 RPC 里查一次，是为了并发点击下也不会漏。
-- reporter_id 为 null（注销）的行不受约束 —— 索引里 NULL 互不相等，正是想要的。
create unique index if not exists question_reports_open_uniq
  on public.question_reports (question_id, reporter_id) where status = 'open';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.question_reports enable row level security;

-- 「谁能处理这条反馈」的定义只写一次：作者 / 该校学校管理员 / 系统管理员。
-- 内联进每条策略会让四个地方各写一遍、迟早写歪一处。
create or replace function public.can_handle_question_report(p_question_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from questions q
    where q.id = p_question_id
      and (
        q.creator_id = (select auth.uid())
        -- 题目没挂学校时（school_id 为空）这条恒为 false，兜底落到系统管理员
        or public.is_school_admin(q.school_id)
      )
  ) or public.is_admin();
$$;

-- 提交：登录即可，但**只能以自己名义**提交（不能替别人提）
drop policy if exists qr_insert on public.question_reports;
create policy qr_insert on public.question_reports
  for insert to authenticated
  with check (reporter_id = (select auth.uid()));

-- 看：自己的 / 自己能处理的
drop policy if exists qr_select on public.question_reports;
create policy qr_select on public.question_reports
  for select to authenticated
  using (
    reporter_id = (select auth.uid())
    or public.can_handle_question_report(question_id)
  );

-- 处理：只有能处理的人能改。with check 与 using 同款 ——
-- 少了 with check 就能把 question_id 改到别人的题上去（BOLA）。
drop policy if exists qr_update on public.question_reports;
create policy qr_update on public.question_reports
  for update to authenticated
  using (public.can_handle_question_report(question_id))
  with check (public.can_handle_question_report(question_id));

-- 不建 delete 策略：反馈是审计性内容，**没有删除入口**（与已发布题目同口径）。
-- 真要清理走管理员 SQL。

-- ---------------------------------------------------------------------------
-- RPC：提交
-- ---------------------------------------------------------------------------
create or replace function public.submit_question_report(
  p_question_id uuid,
  p_version_id uuid,
  p_category text,
  p_content text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
  v_content text := btrim(coalesce(p_content, ''));
begin
  if p_category not in ('stem', 'answer', 'explanation', 'other') then
    raise exception '反馈类型不合法' using errcode = '22023';
  end if;
  if char_length(v_content) < 2 then
    raise exception '请把问题描述得再具体一点' using errcode = '22023';
  end if;
  if char_length(v_content) > 500 then
    raise exception '反馈内容过长（最多 500 字）' using errcode = '22023';
  end if;

  -- 版本必须真属于这道题：拦住"拿 A 题的 version 提 B 题的反馈"这种构造
  if not exists (
    select 1 from question_versions v
    where v.id = p_version_id and v.question_id = p_question_id
  ) then
    raise exception '题目与版本不匹配' using errcode = '22023';
  end if;

  insert into question_reports (question_id, version_id, reporter_id, category, content)
  values (p_question_id, p_version_id, v_uid, p_category, v_content)
  returning id into v_id;
  return v_id;
exception
  -- 部分唯一索引冲突 → 给一句人话，别把 23505 甩给前端
  when unique_violation then
    raise exception '你已经反馈过这道题了，作者还在处理中' using errcode = '23505';
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC：某道题的反馈列表（题目详情页的「本题反馈」区）
-- ---------------------------------------------------------------------------
create or replace function public.list_question_reports(p_question_id uuid)
returns table(
  id uuid,
  version_id uuid,
  version_no integer,
  is_current_version boolean,
  reporter_id uuid,
  category text,
  content text,
  status text,
  resolve_note text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_uid();
  -- 可见性由 RLS 兜底，这里不再过滤，但**必须**先过一遍权限判断：
  -- SECURITY DEFINER 会绕过 RLS，不显式拦一道就等于把全站反馈敞开。
  if not public.can_handle_question_report(p_question_id) then
    raise exception '只有本题作者或学校管理员可以查看反馈' using errcode = '42501';
  end if;

  return query
  select r.id, r.version_id, v.version_no,
         (v.id = q.current_published_version_id) as is_current_version,
         r.reporter_id, r.category, r.content, r.status,
         r.resolve_note, r.resolved_by, r.resolved_at, r.created_at
  from question_reports r
  join question_versions v on v.id = r.version_id
  join questions q on q.id = r.question_id
  where r.question_id = p_question_id
  order by (r.status = 'open') desc, r.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC：我的反馈收件箱（作者视角，跨题目）
-- ---------------------------------------------------------------------------
create or replace function public.question_report_inbox(
  p_status text default 'open',
  p_limit integer default 50,
  p_offset integer default 0)
returns table(
  id uuid,
  question_id uuid,
  version_id uuid,
  version_no integer,
  is_current_version boolean,
  question_state text,
  course_node_id uuid,
  reporter_id uuid,
  category text,
  content text,
  status text,
  resolve_note text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz,
  total_count bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  perform public.require_uid();

  return query
  select r.id, r.question_id, r.version_id, v.version_no,
         (v.id = q.current_published_version_id) as is_current_version,
         q.state, q.course_node_id,
         r.reporter_id, r.category, r.content, r.status,
         r.resolve_note, r.resolved_by, r.resolved_at, r.created_at,
         count(*) over () as total_count
  from question_reports r
  join questions q on q.id = r.question_id
  join question_versions v on v.id = r.version_id
  where public.can_handle_question_report(r.question_id)
    -- p_status 传 'all' 时不加过滤；其余按字面量过滤
    and (p_status = 'all' or r.status = p_status)
  order by (r.status = 'open') desc, r.created_at desc
  limit v_limit offset v_offset;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC：处理（标记已处理 + 留言；或撤销回未处理）
-- ---------------------------------------------------------------------------
create or replace function public.resolve_question_report(
  p_report_id uuid,
  p_status text,
  p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_qid uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_status not in ('open', 'resolved') then
    raise exception '状态不合法' using errcode = '22023';
  end if;

  select question_id into v_qid from question_reports where id = p_report_id;
  if not found then
    raise exception '反馈不存在';
  end if;
  if not public.can_handle_question_report(v_qid) then
    raise exception '只有本题作者或学校管理员可以处理反馈' using errcode = '42501';
  end if;

  -- 标记为已处理时**必须**留言：作者一句"已修订"或"确认无误"是学生收到的唯一回音，
  -- 不写就等于石沉大海（学生端能看到这句话）。
  if p_status = 'resolved' and v_note is null then
    raise exception '请写一句处理说明，学生会看到它' using errcode = '22023';
  end if;

  update question_reports
     set status = p_status,
         resolve_note = case when p_status = 'resolved' then v_note else null end,
         resolved_by = case when p_status = 'resolved' then v_uid else null end,
         resolved_at = case when p_status = 'resolved' then now() else null end,
         updated_at = now()
   where id = p_report_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC：待处理条数（侧栏徽标）
-- ---------------------------------------------------------------------------
create or replace function public.count_open_question_reports()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from question_reports r
  where r.status = 'open'
    and public.can_handle_question_report(r.question_id);
$$;

-- ---------------------------------------------------------------------------
-- 权限收口（0006 的口径：新函数默认对 PUBLIC 开放，必须显式收回再按需授予）
-- ---------------------------------------------------------------------------
revoke all on function public.can_handle_question_report(uuid) from public, anon;
revoke all on function public.submit_question_report(uuid, uuid, text, text) from public, anon;
revoke all on function public.list_question_reports(uuid) from public, anon;
revoke all on function public.question_report_inbox(text, integer, integer) from public, anon;
revoke all on function public.resolve_question_report(uuid, text, text) from public, anon;
revoke all on function public.count_open_question_reports() from public, anon;

-- can_handle_question_report **必须给 authenticated EXECUTE**，别照抄 require_uid 那种"只留 postgres"。
-- 原因：它被 RLS 策略引用，而**策略表达式是以查询者身份求值的** —— 没有 EXECUTE
-- 策略就会在运行时报 permission denied。is_admin / is_school_admin 同样是给 authenticated 的。
-- （反面参照：can_view_student 只有 postgres，因为它只在 SECURITY DEFINER 函数体里调用、不在策略里。）
grant execute on function public.can_handle_question_report(uuid) to authenticated;

grant execute on function public.submit_question_report(uuid, uuid, text, text) to authenticated;
grant execute on function public.list_question_reports(uuid) to authenticated;
grant execute on function public.question_report_inbox(text, integer, integer) to authenticated;
grant execute on function public.resolve_question_report(uuid, text, text) to authenticated;
grant execute on function public.count_open_question_reports() to authenticated;

grant select, insert, update on public.question_reports to authenticated;
-- anon 一行也不给：题目反馈是登录后的事
revoke all on public.question_reports from anon;
