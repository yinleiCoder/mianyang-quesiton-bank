-- 0044: 试卷（组卷）核心表 —— 主档 / 不可变版本 / 大题 / 题项 + 守卫 + 分值契约 + RLS + 授权
--
-- 设计要点（与 0003 的题目模型逐条对应，但**完全独立**，一个字节都不动题目链路）：
--   · papers ↔ questions、paper_versions ↔ question_versions：主档 + 不可变快照分层；
--     「上下线」是主档级 state，不进版本。
--   · 题项只存**指针**（question_id + question_version_id），不复制 content——沿用
--     practice_session_items(0028) 的既定取舍。一张 45 题的卷因此只有几十 KB，
--     且题目日后改版/下线都不会改变已发布试卷（"考过的卷子不会变"）。
--   · 版本状态机与题目逐字相同：draft → pending_group → pending_city → published，
--     终态/旁支 returned / retracted / superseded。
--   · 审批另建 paper_approvals（见 0046），**不扩展现有 approvals 表**：
--     仓库出过两次「新迁移整体覆盖旧版函数」的事故（0026 覆盖 0014、0043 注释点名），
--     扩表会连带改 select_approval 策略 / review_decide / transfer_approval，
--     而 transfer_approval 对 paper 行会「静默地按题目语义执行」——静默错误比报错更糟。
--
-- 与题目链路唯一的共享物：subject_nodes / approver_assignments / effective_assignee /
-- check_can_author / v_blocks_text / v_blank_count / audit_log。全部只读复用。

-- ============ 试卷主档 ============
create table public.papers (
  id                           uuid primary key default gen_random_uuid(),
  school_id                    uuid not null references public.schools(id) on delete restrict,
  -- 0021 语义：作者注销后共享内容保留（显示"已注销"），故可空 + set null
  creator_id                   uuid references auth.users(id) on delete set null,
  course_node_id               uuid not null references public.subject_nodes(id) on delete restrict,
  state                        text not null default 'live' check (state in ('live','offline')),
  current_published_version_id uuid, -- FK 在 paper_versions 建表后回填
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);
comment on table public.papers is '逻辑试卷主档（归属学校/作者/课程节点/上下线）；内容在 paper_versions';

create trigger trg_papers_touch before update on public.papers
  for each row execute function public.touch_updated_at();

-- ============ 试卷版本（不可变快照） ============
create table public.paper_versions (
  id               uuid primary key default gen_random_uuid(),
  paper_id         uuid not null references public.papers(id) on delete cascade,
  version_no       int not null,
  change_type      text not null check (change_type in ('create','edit','admin_direct')),
  base_version_id  uuid references public.paper_versions(id) on delete set null,
  status           text not null default 'draft'
                   check (status in ('draft','pending_group','pending_city','published','superseded','returned','retracted')),
  -- 卷头：打印版式直接读这几列，不再二次拼装
  exam_name        text,          -- 四川省2024年高职教育单招
  subject_label    text,          -- 计算机类试题
  title            text not null check (char_length(title) between 1 and 120),
  duration_minutes int not null default 90 check (duration_minutes between 1 and 600),
  total_score      numeric(7,2) not null default 0 check (total_score >= 0),  -- 计算值，见 trg_paper_items_total
  target_score     numeric(7,2) check (target_score is null or target_score >= 0), -- 教师设定的期望总分
  header           jsonb not null default '{}'::jsonb check (jsonb_typeof(header) = 'object'),
                   -- { show_candidate_bar: true, code: "A卷" } 卷头附加项
  instructions     jsonb not null default '[]'::jsonb check (jsonb_typeof(instructions) = 'array'),
                   -- 卷首说明，与题目 content 的块结构同构 [{t:"text",text:"..."}]
  created_by       uuid references auth.users(id) on delete set null,
  submitted_at     timestamptz,
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(), -- 编辑器乐观锁用（save_paper_draft 比对）
  unique (paper_id, version_no)
);
comment on table public.paper_versions is '试卷不可变快照；状态机同题目：draft→pending_group→pending_city→published，终态 returned/retracted/superseded';
comment on column public.paper_versions.target_score is '教师设定的期望总分，仅提交时做一致性校验；真实总分恒为 total_score（唯一真相源）';
comment on column public.paper_versions.updated_at is '每次保存刷新；save_paper_draft 用它做乐观锁，防两个标签页互相覆盖';

create trigger trg_paper_versions_touch before update on public.paper_versions
  for each row execute function public.touch_updated_at();

-- 物理防并发双流：每卷至多一个"在流"版本（草稿/待审/退回 互斥）
create unique index uq_papers_one_inflight
  on public.paper_versions (paper_id)
  where status in ('draft','pending_group','pending_city','returned');

create index idx_paper_versions_paper on public.paper_versions (paper_id, version_no desc);

-- 回填循环外键
alter table public.papers
  add constraint fk_papers_current_version
  foreign key (current_published_version_id) references public.paper_versions(id) on delete set null;

create index idx_papers_course_node on public.papers (course_node_id);
create index idx_papers_school on public.papers (school_id);
create index idx_papers_creator on public.papers (creator_id);
create index idx_papers_live on public.papers (id) where state = 'live';

-- =====================================================================
-- 分值契约（纯函数；SQL 与 JS 各一份，口径必须逐条对齐——同 draftIssues 对齐 validate_question_content 的约定）
-- 必须建在 paper_items 之前：它的 CHECK 约束要引用 jsonb_numeric_sum。
-- =====================================================================

-- 计分点明细求和。CHECK 里要用，必须 IMMUTABLE。
-- 刻意"失败即报错"而不是静默跳过坏项：CHECK 各子句的求值顺序不保证，
-- 想靠 jsonb_typeof='array' 那道闸拦住非法输入是不可靠的；静默跳过还会让
-- ["a"] 这种脏数据算出 0 分而通过校验。这里一律给出明确的中文原因。
create or replace function public.jsonb_numeric_sum(p jsonb)
returns numeric
language plpgsql
immutable
set search_path = public
as $$
declare
  v_sum numeric := 0;
  v_item text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then
    raise exception '分值明细必须是数组';
  end if;
  for v_item in select jsonb_array_elements_text(p) loop
    if v_item !~ '^-?[0-9]+(\.[0-9]+)?$' then
      raise exception '分值明细含非数值项: %', v_item;
    end if;
    v_sum := v_sum + v_item::numeric;
  end loop;
  return v_sum;
end;
$$;

-- 把「大题默认口径」展开成某个题项的计分点明细。
-- p_custom 非空 = 教师对这一题做了显式定制（直接采用）。
-- 口径落在"计分点"而不是"题"上：per_blank 的填空题有 N 个空就是 N 个计分点，
-- 这正是需求里的"每空的分数"；复合题的 per_sub 同理。
-- 用错题型时（per_blank 配选择题）退化为整题一个计分点——规则永远有定义，不返回 NULL，
-- 由 UI 提示而不在这里报错（教师改大题口径时不该被中途拦死）。
create or replace function public.paper_item_units(
  p_qtype text, p_content jsonb, p_score_mode text, p_score_each numeric, p_custom jsonb default null)
returns numeric[]
language plpgsql
immutable
set search_path = public
as $$
declare
  v_n int := 0;
  v_stem text;
begin
  if p_custom is not null and jsonb_typeof(p_custom) = 'array' and jsonb_array_length(p_custom) > 0 then
    return (select array_agg(x::numeric) from jsonb_array_elements_text(p_custom) x);
  end if;
  if p_score_mode = 'per_blank' and p_qtype = 'fill_blank'
     and jsonb_typeof(p_content -> 'stem') = 'array' then
    v_stem := public.v_blocks_text(p_content -> 'stem');
    -- 与填空题校验同源的空位口径：连续 3+ 下划线
    v_n := public.v_blank_count(v_stem);
  elsif p_score_mode = 'per_sub' and p_qtype = 'composite'
        and jsonb_typeof(p_content -> 'sub') = 'array' then
    v_n := jsonb_array_length(p_content -> 'sub');
  end if;
  if v_n > 0 then
    return array_fill(coalesce(p_score_each, 0), array[v_n]);
  end if;
  return array[coalesce(p_score_each, 0)];
end;
$$;

-- ============ 卷面大题（分节） ============
create table public.paper_sections (
  id               uuid primary key default gen_random_uuid(),
  paper_version_id uuid not null references public.paper_versions(id) on delete cascade,
  sort_order       int not null check (sort_order >= 1),
  title            text not null check (char_length(title) between 1 and 60), -- 单项选择题
  instruction      text,                                                       -- 每小题只有一个选项符合题意
  score_mode       text not null default 'per_item'
                   check (score_mode in ('per_item','per_blank','per_sub')),
  score_each       numeric(6,2) not null default 0 check (score_each >= 0 and score_each <= 100),
  unique (paper_version_id, sort_order),
  -- 供 paper_items 的复合外键引用：只写 (paper_version_id, sort_order) 会让
  -- 「题项与大题必须同版本」这条不变量无法在约束层表达
  unique (paper_version_id, id)
);
comment on table public.paper_sections is '卷面大题（一、单项选择题…）；score_mode 决定计分粒度，score_each 是每个计分点的分值';
comment on column public.paper_sections.score_mode is 'per_item 每题 / per_blank 每空（仅填空题有意义）/ per_sub 每子题（仅复合题有意义）；用错题型时退化为整题一个计分点';

-- ============ 卷面题项 ============
create table public.paper_items (
  id                  uuid primary key default gen_random_uuid(),
  paper_version_id    uuid not null references public.paper_versions(id) on delete cascade,
  section_id          uuid not null,
  seq                 int not null check (seq >= 1),   -- 卷内连续编号 1..N（跨大题累加）
  question_id         uuid not null references public.questions(id) on delete restrict,
  question_version_id uuid not null references public.question_versions(id) on delete restrict,
  qtype               text not null check (qtype in ('single_choice','multiple_choice','true_false',
                                                     'fill_blank','short_answer','composite')),
  difficulty          smallint not null default 2 check (difficulty between 1 and 3),
  score               numeric(6,2) not null default 0 check (score >= 0),
  -- 计分点明细：[3] / [2,2,2,2] / [3,3,4]。永远物化（服务端算好落库），
  -- 因此只需一条不变量 score = Σ score_units，没有"未计算"的中间态
  score_units         jsonb not null default '[0]'::jsonb
                      check (jsonb_typeof(score_units) = 'array'
                             and jsonb_array_length(score_units) >= 1
                             and public.jsonb_numeric_sum(score_units) = score),
  origin              text not null default 'bank' check (origin in ('bank','import')),
  note                text,
  unique (paper_version_id, seq),
  unique (paper_version_id, question_id),   -- 同一份卷不重复用同一题（口径同 practice_session_items）
  -- 复合外键：题项与其所属大题必须属于同一版本（单列 FK 表达不了这条）
  foreign key (paper_version_id, section_id)
    references public.paper_sections (paper_version_id, id) on delete cascade
);
comment on table public.paper_items is '卷面题项：只存题库指针不复制内容；question_version_id 是拖入那一刻的当前入库版本';
comment on column public.paper_items.score_units is '计分点分值明细，合计恒等于 score；打印与阅卷都读它，保证同一数字全系统只有一处算出来';

create index idx_paper_items_version on public.paper_items (paper_version_id, seq);
create index idx_paper_items_question on public.paper_items (question_id);
create index idx_paper_items_qversion on public.paper_items (question_version_id);

-- ============ 试卷审批任务 ============
-- 与 approvals 同构但独立成表。为什么不扩展现有 approvals：
--   1) approvals.question_id 是 NOT NULL，放不开；改约束会波及 9 处查询；
--   2) uq_approvals_one_noncontent 的谓词是 kind <> 'content'，对 question_id 为 NULL 的
--      试卷行去重会失效（PG 唯一索引里 NULL 互不相等）；
--   3) transfer_approval 对试卷行会"静默地按题目语义执行"（select * into v_q from questions
--      where id = null → 全 NULL → is_school_admin(NULL) 为 false），学校管理员被无声拒绝。
--      静默错误比报错更糟。
-- 建在 0044 而不是审批 RPC 那个迁移里，是因为 can_read_paper_version 要用到它。
create table public.paper_approvals (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null default 'paper'
                   check (kind in ('paper','paper_offline','paper_restore')),
  paper_version_id uuid references public.paper_versions(id) on delete cascade,
  paper_id         uuid not null references public.papers(id) on delete cascade,
  stage            text not null check (stage in ('group','city')),
  state            text not null default 'waiting' check (state in ('waiting','approved','returned','cancelled')),
  -- 快照化指派（同 approvals）：之后调整任命/移动节点不影响在途任务
  assigned_user_id uuid references auth.users(id) on delete set null,
  decided_by       uuid references auth.users(id) on delete set null,
  decided_at       timestamptz,
  comment          text,
  created_at       timestamptz not null default now(),
  -- 内容任务必挂版本；上下线事件不挂
  check ((kind = 'paper') = (paper_version_id is not null))
);
comment on table public.paper_approvals is '试卷审批任务；assignee 于创建时刻快照，content 两阶段流转，paper_offline/restore 仅组长级事件';

-- 每版本每环节至多一个未决任务
create unique index uq_paper_approvals_one_waiting
  on public.paper_approvals (paper_version_id, stage) where state = 'waiting';
-- 上下线事件：同一卷同时至多一个未决非内容事件
create unique index uq_paper_approvals_one_noncontent
  on public.paper_approvals (paper_id, kind) where state = 'waiting' and kind <> 'paper';

create index idx_paper_approvals_inbox on public.paper_approvals (assigned_user_id) where state = 'waiting';
create index idx_paper_approvals_paper on public.paper_approvals (paper_id, created_at desc);
create index idx_paper_approvals_version on public.paper_approvals (paper_version_id);

-- 已决审批记录不可改删。直接复用 0003 的守卫：它只读 old.state，与表结构无关。
create trigger trg_paper_approvals_guard
  before update or delete on public.paper_approvals
  for each row execute function public.guard_approval_immutable();

-- =====================================================================
-- 守卫触发器
-- =====================================================================

-- 版本行防篡改：与 0012 的 guard_version_immutable 同构。
-- 关键差异：事务开关用**独立**的 app.allow_paper_supersede。
-- 若与题目共用 app.allow_supersede，某天有人在同一个事务里发布试卷时打开了它，
-- 题目版本的守卫会被同时放开——跨表串扰，物理隔离才安全。
create or replace function public.guard_paper_version_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status in ('published', 'superseded', 'retracted') then
    -- 唯一合法的入库后迁移：新版本发布时系统把旧 published 行标记为 superseded。
    -- 必须带事务级开关授权，且除 status 外所有字段不得变化。
    if tg_op = 'UPDATE'
       and old.status = 'published' and new.status = 'superseded'
       and current_setting('app.allow_paper_supersede', true) = 'on'
       and new.paper_id is not distinct from old.paper_id
       and new.version_no is not distinct from old.version_no
       and new.change_type is not distinct from old.change_type
       and new.base_version_id is not distinct from old.base_version_id
       and new.exam_name is not distinct from old.exam_name
       and new.subject_label is not distinct from old.subject_label
       and new.title is not distinct from old.title
       and new.duration_minutes is not distinct from old.duration_minutes
       and new.total_score is not distinct from old.total_score
       and new.target_score is not distinct from old.target_score
       and new.header is not distinct from old.header
       and new.instructions is not distinct from old.instructions
       and new.created_by is not distinct from old.created_by
       and new.submitted_at is not distinct from old.submitted_at
       and new.published_at is not distinct from old.published_at
       and new.created_at is not distinct from old.created_at then
      return new;
    end if;
    raise exception '该状态的试卷版本不可直接修改';
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception '只能删除纯草稿版本的试卷';
    end if;
    -- 必须返回 OLD：BEFORE DELETE 触发器返回 NULL 会**静默取消**这次删除。
    -- 踩过的坑：这里原本写 `return new`（DELETE 时 NEW 恒为 NULL），后果是
    -- `delete from papers` 的 on delete cascade 被吞掉——父卷没了、版本行还在，
    -- 而且 PG 的级联删除不会回头复查外键，于是留下一批孤儿行却不报任何错。
    return old;
  end if;
  return new;
end;
$$;

create trigger trg_paper_versions_guard
  before update or delete on public.paper_versions
  for each row execute function public.guard_paper_version_immutable();

-- 结构（大题/题项）只在草稿或退回态可写：一旦提交，卷面就在审批人眼下冻结，
-- 否则作者可以在专家审阅期间偷偷换题。
create or replace function public.guard_paper_structure_mutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version uuid;
  v_status text;
begin
  -- DELETE 触发器的 NEW 未赋值，直接读字段会报 "record new is not assigned yet"
  if tg_op = 'DELETE' then
    v_version := old.paper_version_id;
  else
    v_version := new.paper_version_id;
    if tg_op = 'UPDATE' and new.paper_version_id is distinct from old.paper_version_id then
      raise exception '不能把题项/大题挪到另一个试卷版本';
    end if;
  end if;
  select status into v_status from paper_versions where id = v_version;
  if v_status is null then
    -- 版本行已在本事务内被删掉（on delete cascade 的连带删除：PG 先删父行再删子行），
    -- 此时放行。真正的闸门在 guard_paper_version_immutable——它只允许删除纯草稿版本；
    -- 若在这里报"版本不存在"，delete_paper_draft 会因为级联删题项而整个失败。
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if v_status not in ('draft', 'returned') then
    raise exception '试卷已提交或已入库，不可直接增删改题目，请先发起改版';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger trg_paper_sections_guard
  before insert or update or delete on public.paper_sections
  for each row execute function public.guard_paper_structure_mutable();

create trigger trg_paper_items_guard
  before insert or update or delete on public.paper_items
  for each row execute function public.guard_paper_structure_mutable();

-- 全卷总分维护：题项变化后重算 total_score。
-- 放在触发器里而不是写进 RPC，是 0042 立的规矩：RPC 会被后续迁移整体覆盖，触发器不会。
-- 用行级而非语句级：语句级触发器拿不到 NEW/OLD（要拿得配 transition table，多一层限制），
-- 而行级每行重算的代价是一次走索引的 sum，一份草稿卷几十行，可以忽略。
-- 只在 draft/returned 态重算——已提交/已入库版本由守卫拦住写入，这里顺带跳过。
create or replace function public.trg_paper_items_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version uuid;
begin
  v_version := coalesce(
    case when tg_op = 'DELETE' then null else new.paper_version_id end,
    case when tg_op = 'INSERT' then null else old.paper_version_id end);
  update paper_versions v
  set total_score = coalesce(
        (select sum(i.score) from paper_items i where i.paper_version_id = v.id), 0)
  where v.id = v_version and v.status in ('draft', 'returned');
  return null;
end;
$$;

create trigger trg_paper_items_total
  after insert or update or delete on public.paper_items
  for each row execute function public.trg_paper_items_total();

-- =====================================================================
-- 审计（与被审计操作同事务）
-- =====================================================================

alter table public.audit_log
  add column paper_id uuid references public.papers(id) on delete set null,
  add column paper_version_id uuid references public.paper_versions(id) on delete set null;
create index idx_audit_paper on public.audit_log (paper_id, created_at desc);

create or replace function public.paper_audit(p_action text, p_paper_id uuid,
  p_paper_version_id uuid, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into audit_log (user_id, paper_id, paper_version_id, action, detail)
  values (auth.uid(), p_paper_id, p_paper_version_id, p_action, p_detail);
end;
$$;

-- =====================================================================
-- RLS 助手
-- 铁律（0009 的 42P17 事故）：策略表达式里**绝不跨表 join**，一律走 definer helper。
-- papers ↔ paper_versions ↔ paper_sections ↔ paper_items 四表互指必成环。
-- =====================================================================

create or replace function public.is_paper_creator(p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from papers p
    where p.id = p_paper_id and p.creator_id = (select auth.uid())
  );
$$;

create or replace function public.is_school_admin_of_paper(p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from papers p
    join profiles pr on pr.user_id = (select auth.uid())
    join user_roles r on r.user_id = pr.user_id and r.role = 'school_admin'
    where p.id = p_paper_id and pr.school_id = p.school_id
  );
$$;

-- 版本可见性：sections / items 复用同一个判定，避免它们各自再跨一次表。
-- 注意这是 definer 函数，不受 RLS 约束，所以谓词必须自己写全。
create or replace function public.can_read_paper_version(p_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from paper_versions v
    join papers p on p.id = v.paper_id
    where v.id = p_version_id and (
      v.created_by = (select auth.uid())
      or (select public.is_admin())
      or public.is_school_admin_of_paper(p.id)
      -- 审批参与人（组长/专家）要能看到待审的那一版
      or exists (
        select 1 from paper_approvals a
        where a.paper_version_id = v.id
          and (a.assigned_user_id = (select auth.uid()) or a.decided_by = (select auth.uid())))
      -- 组卷库：已发布且该版本仍是当前版本，且试卷在线
      or (v.status = 'published' and p.state = 'live' and p.current_published_version_id = v.id)
    )
  );
$$;

-- =====================================================================
-- 权限收口：RLS + 授权
-- =====================================================================

alter table public.papers enable row level security;
alter table public.paper_versions enable row level security;
alter table public.paper_sections enable row level security;
alter table public.paper_items enable row level security;
alter table public.paper_approvals enable row level security;

-- 试卷主档：两个条件必须同时成立（与 questions 策略同口径）——
-- 只判 state 会让"已下线但指针还在"的卷子仍出现在组卷库里。
drop policy if exists select_paper on public.papers;
create policy select_paper on public.papers for select to authenticated using (
  creator_id = (select auth.uid())
  or (select public.is_admin())
  or (select public.is_school_admin_of_paper(papers.id))
  or (state = 'live' and current_published_version_id is not null)
);

drop policy if exists select_paper_version on public.paper_versions;
create policy select_paper_version on public.paper_versions for select to authenticated
  using (public.can_read_paper_version(id));

drop policy if exists select_paper_section on public.paper_sections;
create policy select_paper_section on public.paper_sections for select to authenticated
  using (public.can_read_paper_version(paper_version_id));

drop policy if exists select_paper_item on public.paper_items;
create policy select_paper_item on public.paper_items for select to authenticated
  using (public.can_read_paper_version(paper_version_id));

-- 审批任务：与题目的 select_approval(0009) 同口径——跨表判断全走 definer helper，防 42P17 递归
drop policy if exists select_paper_approval on public.paper_approvals;
create policy select_paper_approval on public.paper_approvals for select to authenticated using (
  assigned_user_id = (select auth.uid())
  or decided_by = (select auth.uid())
  or (select public.is_admin())
  or (select public.is_school_admin_of_paper(paper_id))
  or (select public.is_paper_creator(paper_id))
);

-- 审计：试卷行沿用"本校学校管理员可见"的口径。
-- 用**新增一条 permissive 策略**而不是改写既有的 select_audit——RLS 的 permissive
-- 策略是 OR 关系，这样题目链路的审计可见性一个字节都不用动。
drop policy if exists select_audit_paper on public.audit_log;
create policy select_audit_paper on public.audit_log for select to authenticated using (
  paper_id is not null and (select public.is_school_admin_of_paper(paper_id))
);

-- 客户端零 DML：所有写操作走 SECURITY DEFINER 函数（0045 起）
revoke all on public.papers, public.paper_versions, public.paper_sections,
  public.paper_items, public.paper_approvals from anon, authenticated;
grant select on public.papers, public.paper_versions, public.paper_sections,
  public.paper_items, public.paper_approvals to authenticated;

-- 内部助手：不给客户端执行权。
-- can_read_paper_version 例外——它在 RLS 策略里按**调用者身份**求值，必须授权给 authenticated。
revoke execute on function public.jsonb_numeric_sum(jsonb) from public, anon, authenticated;
revoke execute on function public.paper_item_units(text, jsonb, text, numeric, jsonb) from public, anon, authenticated;
revoke execute on function public.paper_audit(text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.is_paper_creator(uuid) from public, anon;
revoke execute on function public.is_school_admin_of_paper(uuid) from public, anon;
revoke execute on function public.can_read_paper_version(uuid) from public, anon;
grant execute on function public.is_paper_creator(uuid) to authenticated;
grant execute on function public.is_school_admin_of_paper(uuid) to authenticated;
grant execute on function public.can_read_paper_version(uuid) to authenticated;
