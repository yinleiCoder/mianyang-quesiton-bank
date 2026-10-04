-- 0085: 协同组卷 —— 创始人划子卷任务（某大题的第 X~Y 题、目标 Z 分）分给其他老师，
-- 老师只编辑自己那几段，交了即锁。
--
-- ⚠️ 落库方式与本文档的出入（2026-10-04）：这份迁移是**拆成 6 次**通过 MCP 的
-- apply_migration 分步落到线上的（新建的表/列/函数/策略都在线上、已验证），
-- 因为那条路径对含 `delete`/`drop policy` 语句的载荷会自动拒绝。拆分过程中有三处
-- 函数形状与本文档不同 —— **线上为准**：
--   ① `revoke_paper_assignment`：本文档里是 delete 掉那一行；线上**不删记录**，
--      改成"题目归还创始人 + 行挂回创始人名下、状态回 open"（见第 3d 步的说明）。
--   ② `paper_assignments_json`：线上会过滤掉"已收回"的那些行（assignee_id = created_by）。
--   ③ `assign_paper_sections`：线上的重叠检查与"这段在不在别人手里"都跳过已收回的行。
--   ④ 另外线上多了两个触发器函数：`guard_paper_items_foreign_delete`（别人的段删不掉，
--      整卷保存的闸门就落在这里）与 `fill_paper_item_pos`（新行没写 pos 时按段内顺序补 1..n ——
--      线下 `save_paper_draft` 还是 0045 原版、不写 pos，没有它卷内题序会被重排打乱）。
--   ⑤ 两个分段保存 RPC 不在本文件里，见 `0085b_paper_collab_save.sql`（含 delete，单独落）。
-- 本文档保留的是"一次性重放"的完整形态；线上实际定义可用
-- `select pg_get_functiondef(...)` 或迁移账本核对。
--
-- 设计见 docs/pending-design.md 第三节。用户 2026-10-04 补拍三条：
--   · **任意已审核教师**都能被分派（不限于同校）；
--   · 分派里的 `score` **只是显示用的目标**，不硬校验（真实分值由大题计分口径算出来，
--     硬卡会在差 0.5 分时把被指派人卡死）；
--   · 网页端做，Flutter 端这一轮不动（客户端本来就没有出卷页）。
--
-- 与文档原设计的**两处偏差**，都是现实逼的：
--   ① 文档写 `paper_assignments(paper_id, section_id)` —— 但 `save_paper_draft` 每次保存
--      都会把 sections/items **删掉重建**（id 每次都变），所以分派只能记在
--      **版本 + 大题序号 + 段内题号区间**上。挂在 paper_id 上更是错：改版会换版本。
--   ② 段内题号用新列 `paper_items.pos` 记（原来只有全局的 `seq`，而 seq 每次保存重排）。
--      全局 seq 改由 `recompute_paper_seq` 统一算出来。
--
-- 核心机制：**题目带 assignment_id**。分段保存时谁只替换自己那段（`assignment_id` 是自己
-- 那段的行），别人的题原样不动 —— 这就是"同一段只分给一个人，冲突根本不会发生"
-- （文档那句）在数据上的落点。创始人自己的题 assignment_id 为 null。
--
-- 三条状态规则：
--   · 被指派人第一次保存 → open 变 claimed；点「提交这段」→ submitted（**交了即锁**，
--     他不能再改；创始人可解锁回 claimed）；
--   · 创始人对**自己没分的段**照常编辑；已分派的段在他手里是只读的（要动先撤销/解锁）；
--   · 只要有分派被 claim 过，**整卷保存（save_paper_draft）就被拒绝** —— 否则它会把
--     别人正在写的东西整段删掉。

-- =====================================================================
-- 1) 分派表
-- =====================================================================
create table public.paper_assignments (
  id           uuid primary key default gen_random_uuid(),
  -- 挂在**版本**上：分派的是这一版的卷面（大题与题号都是版本的属性），改版要重新分派
  version_id   uuid not null references public.paper_versions(id) on delete cascade,
  -- 大题序号（= paper_sections.sort_order，1 起）。不存 section_id：它每次保存都变
  section_ord  integer not null,
  from_qno     integer not null,
  to_qno       integer not null,
  score        numeric(6,2) not null default 0,
  assignee_id  uuid not null references auth.users(id) on delete cascade,
  state        text not null default 'open',
  note         text,
  created_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint paper_assignments_state_check
    check (state in ('open', 'claimed', 'submitted', 'locked')),
  constraint paper_assignments_ord_check check (section_ord >= 1),
  constraint paper_assignments_range_check check (from_qno >= 1 and to_qno >= from_qno),
  -- 同一段不能重复分派（区间**不重叠**由 assign_paper_sections 保证：本表对客户端不开
  -- 写入口，所有写入都过那几个 SECURITY DEFINER 函数；btree_gist 没装，做不了排他约束）
  constraint paper_assignments_span_uniq unique (version_id, section_ord, from_qno, to_qno)
);
comment on table public.paper_assignments is
  '协同组卷的子卷任务：某大题的第 X~Y 题（段内题号）分给一位老师。题目的归属记在 paper_items.assignment_id 上';

create index idx_paper_assignments_version on public.paper_assignments (version_id, section_ord);
create index idx_paper_assignments_assignee on public.paper_assignments (assignee_id, state);

create trigger trg_paper_assignments_touch before update on public.paper_assignments
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 2) paper_items：谁写的这段、段内第几题
-- =====================================================================
alter table public.paper_items
  add column assignment_id uuid references public.paper_assignments(id) on delete set null,
  add column pos integer not null default 0;

comment on column public.paper_items.assignment_id is
  '这道题来自哪段分派（null = 创始人自己的）。分段保存靠它划边界：谁只替换自己那段的行';
comment on column public.paper_items.pos is
  '段内题号（1 起，按大题内部计）。全局题号 seq 由 recompute_paper_seq 算';

-- 存量数据回填 pos（此前只有全局 seq）
update public.paper_items i
   set pos = t.pos
  from (
    select id, row_number() over (partition by section_id order by seq) as pos
    from public.paper_items
  ) t
 where i.id = t.id;

create index idx_paper_items_assignment on public.paper_items (assignment_id)
  where assignment_id is not null;

-- =====================================================================
-- 3) 读权限：被指派人要看得见这份卷（否则他连题面都打不开）
-- =====================================================================
create or replace function public.is_paper_assignee(p_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from paper_assignments a
    where a.version_id = p_version_id and a.assignee_id = (select auth.uid())
  );
$$;

create or replace function public.is_paper_assignee_of_paper(p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from paper_assignments a
    join paper_versions v on v.id = a.version_id
    where v.paper_id = p_paper_id and a.assignee_id = (select auth.uid())
  );
$$;

-- 一条分派谁能看：被指派人本人 / 发起人 / 管理员 / 本校管理员
create or replace function public.can_read_paper_assignment(p_assignment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from paper_assignments a
    join paper_versions v on v.id = a.version_id
    where a.id = p_assignment_id
      and (
        a.assignee_id = (select auth.uid())
        or a.created_by = (select auth.uid())
        or (select public.is_admin())
        or public.is_school_admin_of_paper(v.paper_id)
      )
  );
$$;

-- can_read_paper_version 加一支：被指派人（改卷子的人看不见卷子就没法干活）
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
      -- 协同组卷：这一段分给我了
      or public.is_paper_assignee(v.id)
      -- 审批参与人（组长/专家）要能看到待审的那一版
      or exists (
        select 1 from paper_approvals a
        where a.paper_version_id = v.id
          and ((select auth.uid()) = any(a.assigned_user_ids) or a.decided_by = (select auth.uid())))
      -- 组卷库：已发布且该版本仍是当前版本，且试卷在线
      or (v.status = 'published' and p.state = 'live' and p.current_published_version_id = v.id)
    )
  );
$$;

-- papers 的可见性跟着放开一支：被分派的人要在列表/详情里找到这份卷
drop policy if exists select_paper on public.papers;
create policy select_paper on public.papers for select to authenticated using (
  creator_id = (select auth.uid())
  or (select public.is_admin())
  or public.is_school_admin_of_paper(id)
  or public.is_paper_approver(id)
  or (state = 'live' and current_published_version_id is not null)
  or public.is_paper_assignee_of_paper(id)
);

alter table public.paper_assignments enable row level security;

drop policy if exists select_paper_assignment on public.paper_assignments;
create policy select_paper_assignment on public.paper_assignments
  for select to authenticated
  using (public.can_read_paper_assignment(id));

-- 不建 insert/update/delete 策略：所有写入都过下面的 RPC（与题目链路同口径）

revoke all on public.paper_assignments from anon, authenticated;
grant select on public.paper_assignments to authenticated;

-- =====================================================================
-- 4) 题项可用性判定：抽出来给三处共用
-- =====================================================================
-- save_paper_draft 里原本内联着这段（"第 N 题引用的题库版本不可用"）。
-- 分派后的分段保存要用同一条判据，抽出来一处维护。
create or replace function public.resolve_paper_item(p_question_version_id uuid)
returns table(
  version_id uuid, question_id uuid, qtype text, difficulty smallint, content jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  return query
  select qv.id, qv.question_id, qv.qtype, qv.difficulty, qv.content
  from question_versions qv
  join questions q on q.id = qv.question_id
  where qv.id = p_question_version_id
    and (
      (qv.status = 'published' and q.state = 'live')
      -- 自己的题可以先放进来（还没入库的草稿题，AI 成卷那条路）
      or qv.created_by = v_uid
    );

  if not found then
    raise exception '题库版本不存在或不可用（未入库、已下线，且不是你自己的题）' using errcode = '22023';
  end if;
end;
$$;

-- =====================================================================
-- 5) 分派（创始人）
-- =====================================================================
-- 创始人划任务。**追加/更新**语义（不是整表重建）：按 (大题序号, 段内区间) 定位，
-- 已存在的更新分值/说明（换人只允许在没人动手时，见下）。
create or replace function public.assign_paper_sections(p_version_id uuid, p_assignments jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver paper_versions%rowtype;
  v_row jsonb;
  v_ord int;
  v_from int;
  v_to int;
  v_assignee uuid;
  v_score numeric;
  v_note text;
  v_id uuid;
  v_prev paper_assignments%rowtype;
  v_sections int;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select * into v_ver from paper_versions where id = p_version_id;
  if not found then
    raise exception '试卷不存在';
  end if;
  if v_ver.created_by is distinct from v_uid then
    raise exception '只有创始人能分派子卷任务';
  end if;
  if v_ver.status not in ('draft', 'returned') then
    raise exception '只有草稿或被退回的卷子能分派（已提交/已入库的请先发起改版）';
  end if;
  if jsonb_typeof(coalesce(p_assignments, '[]'::jsonb)) <> 'array' then
    raise exception '分派格式错误';
  end if;

  select count(*) into v_sections from paper_sections where paper_version_id = p_version_id;

  for v_row in select * from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) loop
    v_ord := coalesce(nullif(v_row ->> 'section_ord', '')::int, 0);
    v_from := coalesce(nullif(v_row ->> 'from_qno', '')::int, 0);
    v_to := coalesce(nullif(v_row ->> 'to_qno', '')::int, 0);
    v_assignee := nullif(v_row ->> 'assignee_id', '')::uuid;
    v_score := coalesce(nullif(v_row ->> 'score', '')::numeric, 0);
    v_note := nullif(trim(coalesce(v_row ->> 'note', '')), '');

    if v_ord < 1 or v_ord > v_sections then
      raise exception '第 % 个大题不存在（这份卷子共 % 个大题）', v_ord, v_sections;
    end if;
    if v_from < 1 or v_to < v_from then
      raise exception '题号区间不合法：第 %~% 题', v_from, v_to;
    end if;
    if v_score < 0 then
      raise exception '分值不能为负';
    end if;
    if v_assignee is null then
      raise exception '请选择被指派的老师';
    end if;
    if v_assignee = v_uid then
      raise exception '不用给自己分派 —— 没分出去的段本来就是你的';
    end if;
    if not exists (select 1 from profiles where user_id = v_assignee and identity = 'teacher') then
      raise exception '只能分派给审核通过的教师';
    end if;

    -- 与**别的**段重叠？（同版本同大题，排除自己这条）
    if exists (
      select 1 from paper_assignments a
      where a.version_id = p_version_id and a.section_ord = v_ord
        and not (a.from_qno = v_from and a.to_qno = v_to)
        and int4range(a.from_qno, a.to_qno, '[]') && int4range(v_from, v_to, '[]')
    ) then
      raise exception '第 % 大题的第 %~% 题与已有分派重叠', v_ord, v_from, v_to;
    end if;

    select * into v_prev from paper_assignments
     where version_id = p_version_id and section_ord = v_ord
       and from_qno = v_from and to_qno = v_to;

    if found then
      -- 改人 / 改分：已经有人动手了就不许换人（否则他的活白干），只许改分值与说明
      if v_prev.assignee_id <> v_assignee and v_prev.state <> 'open' then
        raise exception '第 % 大题第 %~% 题已经有人在做了，要换人请先撤销这段', v_ord, v_from, v_to;
      end if;
      update paper_assignments
         set assignee_id = v_assignee, score = v_score, note = v_note
       where id = v_prev.id;
      v_id := v_prev.id;
    else
      insert into paper_assignments
        (version_id, section_ord, from_qno, to_qno, score, assignee_id, note, created_by)
      values
        (p_version_id, v_ord, v_from, v_to, v_score, v_assignee, v_note, v_uid)
      returning id into v_id;
    end if;

    perform public.paper_audit('assign_paper_section', v_ver.paper_id, p_version_id,
      jsonb_build_object('assignment_id', v_id, 'section_ord', v_ord,
                         'from_qno', v_from, 'to_qno', v_to,
                         'assignee_id', v_assignee, 'score', v_score));
  end loop;

  return public.paper_assignments_json(p_version_id);
end;
$$;

-- 撤销一段：删掉分派，它下面已有的题**归还创始人**（assignment_id 置 null，
-- 由外键 on delete set null 完成）—— 不连带删题（题是别人挑的，不该因为改派就消失）
create or replace function public.revoke_paper_assignment(p_assignment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a paper_assignments%rowtype;
  v_ver paper_versions%rowtype;
begin
  select * into v_a from paper_assignments where id = p_assignment_id;
  if not found then
    raise exception '分派不存在';
  end if;
  select * into v_ver from paper_versions where id = v_a.version_id;
  if v_ver.created_by is distinct from v_uid then
    raise exception '只有创始人能撤销分派';
  end if;
  if v_ver.status not in ('draft', 'returned') then
    raise exception '卷子已提交或已入库，不能再动分派';
  end if;

  delete from paper_assignments where id = p_assignment_id;
  perform public.recompute_paper_seq(v_a.version_id);
  perform public.paper_audit('revoke_paper_assignment', v_ver.paper_id, v_a.version_id,
    jsonb_build_object('assignment_id', p_assignment_id, 'assignee_id', v_a.assignee_id,
                       'section_ord', v_a.section_ord));
end;
$$;

-- 创始人锁定 / 解锁：submitted → locked（确认这段），locked/submitted → claimed（解锁让他再改）
create or replace function public.set_paper_assignment_state(p_assignment_id uuid, p_state text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a paper_assignments%rowtype;
  v_ver paper_versions%rowtype;
begin
  if p_state not in ('open', 'claimed', 'locked') then
    raise exception '状态不合法（创始人只能置 open / claimed / locked）';
  end if;
  select * into v_a from paper_assignments where id = p_assignment_id;
  if not found then
    raise exception '分派不存在';
  end if;
  select * into v_ver from paper_versions where id = v_a.version_id;
  if v_ver.created_by is distinct from v_uid then
    raise exception '只有创始人能改分派状态';
  end if;
  if v_ver.status not in ('draft', 'returned') then
    raise exception '卷子已提交或已入库，不能再动分派';
  end if;

  update paper_assignments set state = p_state where id = p_assignment_id;
  perform public.paper_audit(
    case when p_state = 'locked' then 'lock_paper_assignment' else 'reopen_paper_assignment' end,
    v_ver.paper_id, v_a.version_id,
    jsonb_build_object('assignment_id', p_assignment_id, 'from', v_a.state, 'to', p_state));
end;
$$;

-- =====================================================================
-- 6) 分段保存（创始人自己的段 / 被指派人的段）
-- =====================================================================
-- 创始人编辑**自己**的题（assignment_id 为 null 的那些）+ 大题表头（标题/说明/计分口径）。
-- 已分派出去的题一行都不碰。
--
-- **没有乐观锁参数**（与 save_paper_draft 不同）：版本级的 `updated_us` 在协作期间必然失效 ——
-- `trg_paper_items_total` 会在任何题项变动后 update paper_versions，`trg_paper_versions_touch`
-- 于是刷新 updated_at，于是**任何一个被指派人存一次，其他人的 token 全废**。
-- 分段保存本身是"一段一个写者"，不需要版本级锁；同一人两个标签页互相覆盖是唯一代价，
-- 记在这里。整卷保存（save_paper_draft）的乐观锁原样保留。
create or replace function public.save_paper_section(
  p_version_id uuid, p_section_ord integer, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver paper_versions%rowtype;
  v_sec paper_sections%rowtype;
  v_sec_id uuid;
  v_item jsonb;
  v_qv record;
  v_units numeric[];
  v_custom jsonb;
  v_mode text;
  v_each numeric;
  v_pos int := 0;
  v_base int;      -- 临时 seq 的起点：接在当前最大值之后，保证不与别的段的临时值撞
  v_min_assigned int;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select * into v_ver from paper_versions where id = p_version_id;
  if not found then
    raise exception '试卷不存在';
  end if;
  if v_ver.created_by is distinct from v_uid then
    raise exception '这一段不在你手里（只有创始人与被指派人能改）';
  end if;
  if v_ver.status not in ('draft', 'returned') then
    raise exception '只能编辑草稿或被退回的试卷';
  end if;

  select * into v_sec from paper_sections
   where paper_version_id = p_version_id and sort_order = p_section_ord;
  if not found then
    raise exception '第 % 个大题不存在', p_section_ord;
  end if;
  v_sec_id := v_sec.id;

  -- 表头（只有创始人能改）
  v_mode := coalesce(nullif(p_payload ->> 'score_mode', ''), v_sec.score_mode);
  if v_mode not in ('per_item', 'per_blank', 'per_sub') then
    raise exception '计分口径不合法';
  end if;
  v_each := coalesce(nullif(p_payload ->> 'score_each', '')::numeric, v_sec.score_each);
  if v_each < 0 or v_each > 100 then
    raise exception '每小题分值必须在 0~100 之间';
  end if;

  -- 这一段里分出去的段，最小起点：创始人自己的题只能排在它前面
  select min(from_qno) into v_min_assigned from paper_assignments
   where version_id = p_version_id and section_ord = p_section_ord;

  -- 换掉"自己的"题（别人的一行不碰）
  delete from paper_items
   where paper_version_id = p_version_id and section_id = v_sec_id and assignment_id is null;

  select coalesce(max(seq), 0) into v_base from paper_items where paper_version_id = p_version_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    if v_min_assigned is not null and v_pos >= v_min_assigned then
      raise exception '第 % 大题从第 % 题起已分派给别人，你在这里最多放 % 道题',
        p_section_ord, v_min_assigned, v_min_assigned - 1;
    end if;

    select * into v_qv from public.resolve_paper_item(
      nullif(v_item ->> 'question_version_id', '')::uuid);
    if v_item ->> 'question_id' is not null
       and (v_item ->> 'question_id')::uuid <> v_qv.question_id then
      raise exception '第 % 题的题目与版本不匹配', v_pos;
    end if;

    v_custom := case when v_item ? 'custom_units' and jsonb_typeof(v_item -> 'custom_units') = 'array'
                     then v_item -> 'custom_units' else null end;
    if v_custom is not null and jsonb_array_length(v_custom) > 0 then
      perform public.jsonb_numeric_sum(v_custom);
    end if;
    v_units := public.paper_item_units(v_qv.qtype, v_qv.content, v_mode, v_each, v_custom);

    begin
      insert into paper_items
        (paper_version_id, section_id, seq, pos, question_id, question_version_id,
         qtype, difficulty, score, score_units, origin, note, assignment_id)
      values
        (p_version_id, v_sec_id, v_base + v_pos, v_pos, v_qv.question_id, v_qv.version_id,
         v_qv.qtype, v_qv.difficulty,
         (select coalesce(sum(u), 0) from unnest(v_units) u),
         to_jsonb(v_units),
         coalesce(nullif(v_item ->> 'origin', ''), 'bank'),
         nullif(trim(v_item ->> 'note'), ''), null);
    exception when unique_violation then
      raise exception '第 % 大题的第 % 题与卷内已有题目重复（同一份试卷不能用两道相同的题）', p_section_ord, v_pos;
    end;
  end loop;

  update paper_sections set
    title = coalesce(nullif(trim(p_payload ->> 'title'), ''), title),
    instruction = case when p_payload ? 'instruction'
                       then nullif(trim(p_payload ->> 'instruction'), '') else instruction end,
    score_mode = v_mode,
    score_each = v_each
  where id = v_sec_id;

  perform public.recompute_paper_seq(p_version_id);
  perform public.paper_audit('save_paper_section', v_ver.paper_id, p_version_id,
    jsonb_build_object('section_ord', p_section_ord, 'items', v_pos));

  return public.paper_version_json(p_version_id);
end;
$$;

-- 被指派人保存自己那一段：题只能落在 [from_qno, to_qno] 内，数量不能超过区间长度。
-- 第一次保存把 open 置成 claimed（"有人在做了"）。
--
-- **乐观锁是段级的**（`paper_assignments.updated_at`，每次保存显式刷新），不是版本级的：
-- 见 save_paper_section 的注释 —— 版本级 token 一存就废，会把协作变成"每存一次全屋刷新"。
-- 段级 token 保护的正是文档要的那件事：**交完又被改**、以及创始人解锁后旧页面还能写。
create or replace function public.save_paper_assignment(
  p_assignment_id uuid, p_items jsonb, p_expected_us bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a paper_assignments%rowtype;
  v_ver paper_versions%rowtype;
  v_cur_us bigint;
  v_sec paper_sections%rowtype;
  v_item jsonb;
  v_qv record;
  v_units numeric[];
  v_custom jsonb;
  v_pos int := 0;
  v_base int;
  v_cap int;
  v_new_us bigint;
begin
  select * into v_a from paper_assignments where id = p_assignment_id;
  if not found then
    raise exception '分派不存在';
  end if;
  if v_a.assignee_id is distinct from v_uid then
    raise exception '这一段不在你手里' using errcode = '42501';
  end if;
  if v_a.state in ('submitted', 'locked') then
    raise exception '这一段已提交（交了即锁）。要改请联系创始人解锁';
  end if;

  select * into v_ver from paper_versions where id = v_a.version_id;
  if v_ver.status not in ('draft', 'returned') then
    raise exception '卷子已提交或已入库，不能再改';
  end if;

  v_cur_us := (extract(epoch from v_a.updated_at) * 1000000)::bigint;
  if p_expected_us is not null and p_expected_us <> v_cur_us then
    raise exception '这一段在别处被改过（或在另一个标签页里编辑），请刷新页面后重试'
      using errcode = '40001';
  end if;

  select * into v_sec from paper_sections
   where paper_version_id = v_a.version_id and sort_order = v_a.section_ord;
  if not found then
    raise exception '第 % 个大题不存在（卷面结构可能被创始人改过，请刷新）', v_a.section_ord;
  end if;

  v_cap := v_a.to_qno - v_a.from_qno + 1;
  if coalesce(jsonb_array_length(coalesce(p_items, '[]'::jsonb)), 0) > v_cap then
    raise exception '这一段是第 %~% 题，最多 % 道题', v_a.from_qno, v_a.to_qno, v_cap;
  end if;

  delete from paper_items where assignment_id = p_assignment_id;

  select coalesce(max(seq), 0) into v_base from paper_items where paper_version_id = v_a.version_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    select * into v_qv from public.resolve_paper_item(
      nullif(v_item ->> 'question_version_id', '')::uuid);
    if v_item ->> 'question_id' is not null
       and (v_item ->> 'question_id')::uuid <> v_qv.question_id then
      raise exception '第 % 题（段内第 % 题）的题目与版本不匹配', v_a.from_qno + v_pos - 1, v_pos;
    end if;

    v_custom := case when v_item ? 'custom_units' and jsonb_typeof(v_item -> 'custom_units') = 'array'
                     then v_item -> 'custom_units' else null end;
    if v_custom is not null and jsonb_array_length(v_custom) > 0 then
      perform public.jsonb_numeric_sum(v_custom);
    end if;
    v_units := public.paper_item_units(v_qv.qtype, v_qv.content, v_sec.score_mode, v_sec.score_each, v_custom);

    begin
      insert into paper_items
        (paper_version_id, section_id, seq, pos, question_id, question_version_id,
         qtype, difficulty, score, score_units, origin, note, assignment_id)
      values
        (v_a.version_id, v_sec.id, v_base + v_pos, v_a.from_qno + v_pos - 1,
         v_qv.question_id, v_qv.version_id,
         v_qv.qtype, v_qv.difficulty,
         (select coalesce(sum(u), 0) from unnest(v_units) u),
         to_jsonb(v_units),
         coalesce(nullif(v_item ->> 'origin', ''), 'bank'),
         nullif(trim(v_item ->> 'note'), ''), p_assignment_id);
    exception when unique_violation then
      raise exception '第 % 题与卷内已有题目重复（同一份试卷不能用两道相同的题）', v_a.from_qno + v_pos - 1;
    end;
  end loop;

  -- 每次保存都刷新这一段自己的 token（trg_paper_assignments_touch 会写 updated_at）
  update paper_assignments
     set state = case when v_a.state = 'open' and v_pos > 0 then 'claimed' else state end,
         updated_at = now()
   where id = p_assignment_id
   returning (extract(epoch from updated_at) * 1000000)::bigint into v_new_us;

  perform public.recompute_paper_seq(v_a.version_id);
  perform public.paper_audit('save_paper_assignment', v_ver.paper_id, v_a.version_id,
    jsonb_build_object('assignment_id', p_assignment_id, 'items', v_pos));

  return jsonb_build_object(
    'version', public.paper_version_json(v_a.version_id),
    'assignment_us', v_new_us);
end;
$$;

-- 被指派人交这段：attempted → submitted（交了即锁）
create or replace function public.submit_paper_assignment(p_assignment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a paper_assignments%rowtype;
  v_ver paper_versions%rowtype;
  v_items int;
begin
  select * into v_a from paper_assignments where id = p_assignment_id;
  if not found then
    raise exception '分派不存在';
  end if;
  if v_a.assignee_id is distinct from v_uid then
    raise exception '这一段不在你手里' using errcode = '42501';
  end if;
  if v_a.state in ('submitted', 'locked') then
    raise exception '这一段已经交过了';
  end if;

  select * into v_ver from paper_versions where id = v_a.version_id;
  if v_ver.status not in ('draft', 'returned') then
    raise exception '卷子已提交或已入库，不能再改';
  end if;

  select count(*) into v_items from paper_items where assignment_id = p_assignment_id;
  if v_items = 0 then
    raise exception '这一段还没有题目，先挑题再交';
  end if;

  update paper_assignments set state = 'submitted' where id = p_assignment_id;
  perform public.paper_audit('submit_paper_assignment', v_ver.paper_id, v_a.version_id,
    jsonb_build_object('assignment_id', p_assignment_id, 'items', v_items));
end;
$$;

-- =====================================================================
-- 7) 序号重排 + 读取用的 JSON
-- =====================================================================
-- 全局题号 seq = 按（大题顺序，段内题号）排。先整体挪到高位再落位 ——
-- (paper_version_id, seq) 是**普通唯一索引**，一条 UPDATE 里直接改会撞瞬时冲突。
create or replace function public.recompute_paper_seq(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update paper_items set seq = 1000000 + seq where paper_version_id = p_version_id;
  with ordered as (
    select i.id, row_number() over (order by s.sort_order, i.pos, i.id) as new_seq
    from paper_items i
    join paper_sections s on s.id = i.section_id
    where i.paper_version_id = p_version_id
  )
  update paper_items i set seq = o.new_seq from ordered o where i.id = o.id;
end;
$$;

-- 一版卷子的分派清单（创始人合卷视图 / 被指派人看自己的段都用它）
create or replace function public.paper_assignments_json(p_version_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_uid();
  if not public.can_read_paper_version(p_version_id) then
    raise exception '无权查看这份试卷' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'section_ord', a.section_ord,
             'from_qno', a.from_qno, 'to_qno', a.to_qno,
             'score', a.score, 'state', a.state, 'note', a.note,
             'assignee_id', a.assignee_id,
             'assignee_name', (select name from profiles where user_id = a.assignee_id),
             'item_count', (select count(*) from paper_items i where i.assignment_id = a.id),
             'section_title', (select s.title from paper_sections s
                                where s.paper_version_id = a.version_id and s.sort_order = a.section_ord))
           order by a.section_ord, a.from_qno)
    from paper_assignments a where a.version_id = p_version_id), '[]'::jsonb);
end;
$$;

-- 这道卷的题项归属：段编辑器要知道"哪几道题是这段的、它们排在第几"。
-- 单独一个 RPC 而不是往 paper_version_json 里塞：那个函数被打印/详情/审批多处共用，
-- 改它的返回形状风险不成比例（虽然只是加键）。
create or replace function public.paper_item_ownership(p_version_id uuid)
returns table(item_id uuid, section_ord integer, pos integer, assignment_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_uid();
  if not public.can_read_paper_version(p_version_id) then
    raise exception '无权查看这份试卷' using errcode = '42501';
  end if;
  return query
  select i.id, s.sort_order, i.pos, i.assignment_id
  from paper_items i
  join paper_sections s on s.id = i.section_id
  where i.paper_version_id = p_version_id
  order by s.sort_order, i.pos;
end;
$$;

-- 「我参与的组卷」：跨卷子的我的任务列表
create or replace function public.list_my_paper_assignments(
  p_limit integer default 50, p_offset integer default 0)
returns table(
  assignment_id uuid, paper_id uuid, version_id uuid, paper_title text,
  section_ord integer, section_title text, from_qno integer, to_qno integer,
  score numeric, state text, item_count bigint, version_status text, updated_at timestamptz,
  total_count bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  return query
  select a.id, v.paper_id, a.version_id, v.title,
         a.section_ord,
         (select s.title from paper_sections s
           where s.paper_version_id = a.version_id and s.sort_order = a.section_ord),
         a.from_qno, a.to_qno, a.score, a.state,
         (select count(*) from paper_items i where i.assignment_id = a.id),
         v.status, a.updated_at,
         count(*) over () as total_count
  from paper_assignments a
  join paper_versions v on v.id = a.version_id
  where a.assignee_id = v_uid
  order by (a.state in ('open', 'claimed')) desc, a.updated_at desc
  limit v_limit offset v_offset;
end;
$$;

-- =====================================================================
-- 8) 整卷保存加一道闸：有人在写分派的段时不许整卷重建
-- =====================================================================
-- save_paper_draft 会 delete 掉全部 sections/items 再重建 —— 分派出去的段一旦有人 claim，
-- 整卷保存就会把别人的活删掉。open（已分派但没人动手）仍然允许：创始人可以继续调整骨架。
create or replace function public.save_paper_draft(
  p_version_id uuid, p_meta jsonb, p_sections jsonb, p_expected_us bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver paper_versions%rowtype;
  v_cur_us bigint;
  v_sec jsonb;
  v_item jsonb;
  v_sort int := 0;
  v_seq int := 0;
  v_pos int := 0;
  v_sec_id uuid;
  v_mode text;
  v_each numeric;
  v_qv record;
  v_units numeric[];
  v_custom jsonb;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select * into v_ver from paper_versions where id = p_version_id;
  if not found then
    raise exception '试卷不存在';
  end if;
  if v_ver.created_by is distinct from v_uid then
    raise exception '只能编辑自己的试卷';
  end if;
  if v_ver.status not in ('draft', 'returned') then
    raise exception '只能编辑草稿或被退回的试卷';
  end if;

  -- 0085：有分派任务在途（有人 claim 过）时不许整卷重建
  if exists (
    select 1 from paper_assignments a
    where a.version_id = p_version_id and a.state in ('claimed', 'submitted', 'locked')
  ) then
    raise exception '这份卷有分派任务在途（已有人在编辑），不能整卷保存。请逐段编辑，或先撤销分派';
  end if;

  v_cur_us := (extract(epoch from v_ver.updated_at) * 1000000)::bigint;
  if p_expected_us is not null and p_expected_us <> v_cur_us then
    raise exception '这份草稿在别处被修改过，请刷新页面后重试' using errcode = '40001';
  end if;

  if p_meta is null then p_meta := '{}'::jsonb; end if;
  if p_sections is null then p_sections := '[]'::jsonb; end if;
  if jsonb_typeof(p_sections) <> 'array' then
    raise exception '卷面结构格式错误';
  end if;

  delete from paper_items where paper_version_id = p_version_id;
  delete from paper_sections where paper_version_id = p_version_id;

  for v_sec in select * from jsonb_array_elements(p_sections) loop
    v_sort := v_sort + 1;
    v_mode := coalesce(nullif(v_sec ->> 'score_mode', ''), 'per_item');
    if v_mode not in ('per_item', 'per_blank', 'per_sub') then
      raise exception '第 % 大题的计分口径不合法', v_sort;
    end if;
    v_each := coalesce(nullif(v_sec ->> 'score_each', '')::numeric, 0);
    if v_each < 0 or v_each > 100 then
      raise exception '第 % 大题的每小题分值必须在 0~100 之间', v_sort;
    end if;

    insert into paper_sections
      (paper_version_id, sort_order, title, instruction, score_mode, score_each)
    values
      (p_version_id, v_sort,
       coalesce(nullif(trim(v_sec ->> 'title'), ''), '第' || public.cn_numeral(v_sort) || '大题'),
       nullif(trim(v_sec ->> 'instruction'), ''), v_mode, v_each)
    returning id into v_sec_id;

    v_pos := 0;   -- 段内题号（v_seq 是全局临时序号，只用于占住唯一的 seq）
    for v_item in select * from jsonb_array_elements(coalesce(v_sec -> 'items', '[]'::jsonb)) loop
      v_seq := v_seq + 1;
      v_pos := v_pos + 1;
      begin
        select * into v_qv from public.resolve_paper_item(
          nullif(v_item ->> 'question_version_id', '')::uuid);
        if v_item ->> 'question_id' is not null
           and (v_item ->> 'question_id')::uuid <> v_qv.question_id then
          raise exception '第 % 大题的段内第 % 题：题目与版本不匹配', v_sort, v_pos;
        end if;

        v_custom := case when v_item ? 'custom_units' and jsonb_typeof(v_item -> 'custom_units') = 'array'
                         then v_item -> 'custom_units' else null end;
        if v_custom is not null and jsonb_array_length(v_custom) > 0 then
          perform public.jsonb_numeric_sum(v_custom);
        end if;
        v_units := public.paper_item_units(v_qv.qtype, v_qv.content, v_mode, v_each, v_custom);

        insert into paper_items
          (paper_version_id, section_id, seq, pos, question_id, question_version_id,
           qtype, difficulty, score, score_units, origin, note, assignment_id)
        values
          (p_version_id, v_sec_id, 1000000 + v_seq, v_pos, v_qv.question_id, v_qv.version_id,
           v_qv.qtype, v_qv.difficulty,
           (select coalesce(sum(u), 0) from unnest(v_units) u),
           to_jsonb(v_units),
           coalesce(nullif(v_item ->> 'origin', ''), 'bank'),
           nullif(trim(v_item ->> 'note'), ''), null);
      exception when unique_violation then
        raise exception '第 % 大题的段内第 % 题与卷内已有题目重复（同一份试卷不能用两道相同的题）', v_sort, v_pos;
      end;
    end loop;
  end loop;

  update paper_versions set
    title = coalesce(nullif(trim(p_meta ->> 'title'), ''), title),
    exam_name = nullif(trim(coalesce(p_meta ->> 'exam_name', '')), ''),
    subject_label = nullif(trim(coalesce(p_meta ->> 'subject_label', '')), ''),
    duration_minutes = coalesce(nullif(p_meta ->> 'duration_minutes', '')::int, duration_minutes),
    target_score = case when p_meta ? 'target_score'
                        then nullif(p_meta ->> 'target_score', '')::numeric
                        else target_score end,
    header = coalesce(p_meta -> 'header', header),
    instructions = coalesce(p_meta -> 'instructions', instructions)
  where id = p_version_id;

  perform public.recompute_paper_seq(p_version_id);

  perform public.paper_audit('save_paper_draft', v_ver.paper_id, p_version_id,
    jsonb_build_object('sections', jsonb_array_length(p_sections),
                       'items', (select count(*) from paper_items where paper_version_id = p_version_id)));

  -- 返回形状与 0045 版逐字一致（编辑器在消费它，别顺手改成 paper_version_json）
  return jsonb_build_object(
    'version_id', p_version_id,
    'total_score', (select total_score from paper_versions where id = p_version_id),
    'target_score', (select target_score from paper_versions where id = p_version_id),
    'item_count', (select count(*) from paper_items where paper_version_id = p_version_id),
    'section_count', (select count(*) from paper_sections where paper_version_id = p_version_id),
    'updated_us', (select (extract(epoch from updated_at) * 1000000)::bigint
                     from paper_versions where id = p_version_id),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'seq', i.seq, 'section_id', i.section_id,
               'score', i.score, 'score_units', i.score_units,
               'stale', (q.current_published_version_id is distinct from i.question_version_id),
               'available', (qv.status = 'published' and q.state = 'live'))
             order by i.seq)
      from paper_items i
      join question_versions qv on qv.id = i.question_version_id
      join questions q on q.id = i.question_id
      where i.paper_version_id = p_version_id), '[]'::jsonb));
end;
$$;

-- =====================================================================
-- 9) 授权收口
-- =====================================================================
revoke all on function public.is_paper_assignee(uuid) from public, anon;
revoke all on function public.is_paper_assignee_of_paper(uuid) from public, anon;
revoke all on function public.can_read_paper_assignment(uuid) from public, anon;
revoke all on function public.resolve_paper_item(uuid) from public, anon;
revoke all on function public.recompute_paper_seq(uuid) from public, anon, authenticated;
revoke all on function public.paper_assignments_json(uuid) from public, anon;
revoke all on function public.assign_paper_sections(uuid, jsonb) from public, anon;
revoke all on function public.revoke_paper_assignment(uuid) from public, anon;
revoke all on function public.set_paper_assignment_state(uuid, text) from public, anon;
revoke all on function public.save_paper_section(uuid, integer, jsonb) from public, anon;
revoke all on function public.save_paper_assignment(uuid, jsonb, bigint) from public, anon;
revoke all on function public.submit_paper_assignment(uuid) from public, anon;
revoke all on function public.paper_item_ownership(uuid) from public, anon;
revoke all on function public.list_my_paper_assignments(integer, integer) from public, anon;

-- 被策略引用的函数必须给 authenticated EXECUTE（0066 的教训）
grant execute on function public.is_paper_assignee(uuid) to authenticated;
grant execute on function public.is_paper_assignee_of_paper(uuid) to authenticated;
grant execute on function public.can_read_paper_assignment(uuid) to authenticated;
-- resolve_paper_item 只在 SECURITY DEFINER 函数体里用，不给 authenticated（同 require_uid）
grant execute on function public.paper_assignments_json(uuid) to authenticated;
grant execute on function public.assign_paper_sections(uuid, jsonb) to authenticated;
grant execute on function public.revoke_paper_assignment(uuid) to authenticated;
grant execute on function public.set_paper_assignment_state(uuid, text) to authenticated;
grant execute on function public.save_paper_section(uuid, integer, jsonb) to authenticated;
grant execute on function public.save_paper_assignment(uuid, jsonb, bigint) to authenticated;
grant execute on function public.submit_paper_assignment(uuid) to authenticated;
grant execute on function public.paper_item_ownership(uuid) to authenticated;
grant execute on function public.list_my_paper_assignments(integer, integer) to authenticated;

notify pgrst, 'reload schema';
