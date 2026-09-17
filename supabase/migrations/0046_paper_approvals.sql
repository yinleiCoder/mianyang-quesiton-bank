-- 0046: 试卷审批 —— 决定函数 / 转派 / 待指派回填 / 统一收件箱视图
--
-- 题目链路的 approvals 表、select_approval 策略、review_decide、transfer_approval、
-- backfill_waiting_assignees 全部**一个字节都不动**（仓库出过两次"新迁移整体覆盖旧版函数"的事故）。
-- 试卷审批另建表（0044 的 paper_approvals）、另起函数名，与旧链零重叠。

-- =====================================================================
-- 0) 修正 0044 的版本守卫：BEFORE DELETE 返回 NULL 会静默取消删除
-- =====================================================================
-- 0044 首版在 DELETE 分支写的是 `return new`，而 DELETE 触发器的 NEW 恒为 NULL ——
-- PostgreSQL 把"BEFORE 触发器返回 NULL"解释为**跳过这次删除**。后果不是报错而是静默：
-- `delete from papers` 的 on delete cascade 被吞掉，父卷没了、版本行还在，
-- 而级联删除不会回头复查外键，于是留下一批孤儿行且无人报错（本迁移之前已复现）。
-- 这里重写一遍（create or replace 幂等），0044 的文件也已同步改正。
create or replace function public.guard_paper_version_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status in ('published', 'superseded', 'retracted') then
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
    return old;   -- 必须返回 OLD：返回 NULL 会静默取消删除
  end if;
  return new;
end;
$$;

-- 审批记录守卫：同样不能复用 0003 的 guard_approval_immutable（它在 DELETE 分支也返回 new）。
-- 独立写一份，顺带把"已决不可改删 + 未决可删"的语义写清楚。
create or replace function public.guard_paper_approval_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.state in ('approved', 'returned', 'cancelled') then
    raise exception '已决审批记录不可修改或删除';
  end if;
  if tg_op = 'DELETE' then
    return old;   -- 未决任务随试卷删除时放行（同样必须返回 OLD）
  end if;
  return new;
end;
$$;

drop trigger if exists trg_paper_approvals_guard on public.paper_approvals;
create trigger trg_paper_approvals_guard
  before update or delete on public.paper_approvals
  for each row execute function public.guard_paper_approval_immutable();

-- =====================================================================
-- 1) 决定：通过 / 退回（结构与 0012 版 review_decide 逐条对齐，靶表换成 paper_*）
-- =====================================================================

create or replace function public.review_decide_paper(
  p_approval_id uuid, p_pass boolean, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_approval paper_approvals%rowtype;
  v_version paper_versions%rowtype;
  v_paper papers%rowtype;
  v_expert uuid;
begin
  select * into v_approval from paper_approvals where id = p_approval_id;
  if not found then
    raise exception '审批任务不存在';
  end if;
  if v_approval.state <> 'waiting' then
    raise exception '该任务已被处理';
  end if;
  if v_approval.assigned_user_id is distinct from v_uid then
    raise exception '该任务不在你的待办中（可能已转派）';
  end if;

  -- ============ 退回 ============
  if not p_pass then
    if p_comment is null or trim(p_comment) = '' then
      raise exception '退回时必须填写审批意见';
    end if;
    update paper_approvals set state = 'returned', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
    -- 关闭同版本/同事件的其他等待任务
    update paper_approvals set state = 'cancelled'
    where state = 'waiting' and id <> p_approval_id
      and (paper_version_id = v_approval.paper_version_id
           or (v_approval.paper_version_id is null
               and paper_id = v_approval.paper_id and kind = v_approval.kind));
    if v_approval.paper_version_id is not null then
      update paper_versions set status = 'returned'
      where id = v_approval.paper_version_id and status in ('pending_group', 'pending_city');
    end if;
    perform public.paper_audit('review_paper_return', v_approval.paper_id, v_approval.paper_version_id,
      jsonb_build_object('stage', v_approval.stage, 'comment', p_comment));
    return;
  end if;

  -- ============ 通过 ============
  select * into v_paper from papers where id = v_approval.paper_id;

  if v_approval.kind in ('paper_offline', 'paper_restore') then
    update paper_approvals set state = 'approved', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
    update papers
    set state = case when v_approval.kind = 'paper_offline' then 'offline' else 'live' end
    where id = v_paper.id;
    perform public.paper_audit(
      case when v_approval.kind = 'paper_offline' then 'approve_paper_offline' else 'approve_paper_restore' end,
      v_paper.id, null, jsonb_build_object('comment', p_comment));
    return;
  end if;

  select * into v_version from paper_versions where id = v_approval.paper_version_id;
  if v_version.status <> 'pending_' || v_approval.stage then
    raise exception '版本当前状态与任务环节不匹配';
  end if;

  if v_approval.stage = 'group' then
    update paper_approvals set state = 'approved', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
    update paper_versions set status = 'pending_city' where id = v_version.id;
    -- 流转专家（排除组长本人与作者本人）；无可用专家时任务待指派。
    -- array_remove 去掉作者已注销留下的 NULL：数组里混进 NULL 会让 `= any(...)` 求值成 NULL，
    -- 于是在 not(...) 下把所有人都误判为"被排除"——这正是题目链路 effective_assignee 的已知坑
    v_expert := public.effective_assignee(v_paper.school_id, v_paper.course_node_id, 'city_expert',
      array_remove(array[v_uid, v_version.created_by], null));
    insert into paper_approvals (kind, paper_version_id, paper_id, stage, assigned_user_id)
    values ('paper', v_version.id, v_paper.id, 'city', v_expert);
    perform public.paper_audit('approve_paper_group', v_paper.id, v_version.id,
      jsonb_build_object('city_expert', v_expert, 'comment', p_comment));
    return;
  end if;

  -- ============ 市级专家通过 = 入库（幂等） ============
  update paper_approvals set state = 'approved', decided_by = v_uid, decided_at = now(), comment = p_comment
  where id = p_approval_id and state = 'waiting';
  if not found then
    raise exception '该任务已被处理';
  end if;
  update paper_versions
  set status = 'published', published_at = now()
  where id = v_version.id and status = 'pending_city';
  if not found then
    raise exception '版本入库状态变更失败，请刷新后重试';
  end if;
  -- 旧入库版本标记为已被替换。用**独立**的事务开关（不是题目的 app.allow_supersede），
  -- 否则同一事务里发布试卷会连带把题目版本的防篡改守卫也放开
  perform set_config('app.allow_paper_supersede', 'on', true);
  update paper_versions set status = 'superseded'
  where paper_id = v_paper.id and status = 'published' and id <> v_version.id;
  perform set_config('app.allow_paper_supersede', 'off', true);
  update papers set current_published_version_id = v_version.id where id = v_paper.id;
  perform public.paper_audit('approve_paper_city_publish', v_paper.id, v_version.id,
    jsonb_build_object('comment', p_comment));
end;
$$;

-- =====================================================================
-- 2) 转派（结构同 transfer_approval；绝不能复用它——它对试卷行会静默按题目语义执行）
-- =====================================================================

create or replace function public.transfer_paper_approval(p_approval_id uuid, p_to_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_approval paper_approvals%rowtype;
  v_paper papers%rowtype;
begin
  select * into v_approval from paper_approvals where id = p_approval_id;
  if not found then
    raise exception '审批任务不存在';
  end if;
  if v_approval.state <> 'waiting' then
    raise exception '只有待处理任务可以转派';
  end if;
  select * into v_paper from papers where id = v_approval.paper_id;
  if not (public.is_admin()
          or (v_approval.stage = 'group' and public.is_school_admin(v_paper.school_id))) then
    raise exception '无权转派该任务';
  end if;
  if not exists (select 1 from profiles where user_id = p_to_user) then
    raise exception '目标用户不存在';
  end if;
  if v_approval.paper_version_id is not null
     and p_to_user = (select created_by from paper_versions where id = v_approval.paper_version_id) then
    raise exception '不能转派给作者本人';
  end if;
  if v_approval.assigned_user_id is not distinct from p_to_user then
    raise exception '目标用户已是该任务处理人';
  end if;
  update paper_approvals set assigned_user_id = p_to_user where id = p_approval_id;
  perform public.paper_audit('transfer_paper_approval', v_paper.id, v_approval.paper_version_id,
    jsonb_build_object('from', v_approval.assigned_user_id, 'to', p_to_user));
end;
$$;

-- =====================================================================
-- 3) 待指派回填（0042 的同构体，挂在同一张表上但用独立触发器）
-- =====================================================================
-- 现实中任命顺序不可控（先提交后任命），任务会以 assigned_user_id = NULL 落库而永远没人处理。
-- 0042 已为题目的任务解决同一问题；试卷任务需要自己的一份。
-- 两个回填函数解析口径完全相同：effective_assignee 沿祖先链、最深优先、排除作者本人。

create or replace function public.backfill_waiting_paper_assignees()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixed int := 0;
  v_role assignee_role;
  v_to uuid;
  r record;
begin
  for r in
    select a.id, a.paper_id, a.stage, a.paper_version_id,
           p.school_id, p.course_node_id, p.creator_id
    from paper_approvals a
    join papers p on p.id = a.paper_id
    where a.state = 'waiting'
      and a.kind = 'paper'
      and a.assigned_user_id is null
      and a.stage in ('group', 'city')
    for update of a
  loop
    v_role := case when r.stage = 'group' then 'group_leader' else 'city_expert' end::assignee_role;
    select public.effective_assignee(r.school_id, r.course_node_id, v_role,
               array_remove(array[r.creator_id], null))
      into v_to;
    if v_to is not null then
      update paper_approvals set assigned_user_id = v_to where id = r.id;
      perform public.paper_audit('backfill_paper_assignee', r.paper_id, r.paper_version_id,
        jsonb_build_object('stage', r.stage, 'to', v_to));
      v_fixed := v_fixed + 1;
    end if;
  end loop;
  return v_fixed;
end;
$$;

create or replace function public.trg_paper_assignments_backfill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.backfill_waiting_paper_assignees();
  return null;  -- 语句级触发器
end;
$$;

drop trigger if exists trg_paper_assignments_backfill on public.approver_assignments;
create trigger trg_paper_assignments_backfill
  after insert or update of is_active on public.approver_assignments
  for each statement execute function public.trg_paper_assignments_backfill();

-- =====================================================================
-- 4) 统一收件箱视图
-- =====================================================================
-- 仓库共有 9 处在查 approvals 做收件箱/侧栏角标/工作台待办统计。不统一的话，
-- 新增的试卷任务会被这些地方静默漏掉（"待我处理"少算了，且不报错）。
--
-- ⚠ security_invoker = on 是**硬要求**：不写就是 definer 语义（视图以属主身份跑），
-- 等于绕过 RLS，把全市审批行连同批注、决策人暴露给任意登录用户。
create or replace view public.approval_inbox with (security_invoker = on) as
  select a.id, a.kind, a.stage, a.state, a.assigned_user_id, a.decided_by, a.decided_at,
         a.comment, a.created_at,
         a.version_id, a.question_id,
         null::uuid as paper_version_id, null::uuid as paper_id,
         'question'::text as target
  from public.approvals a
  union all
  select p.id, p.kind, p.stage, p.state, p.assigned_user_id, p.decided_by, p.decided_at,
         p.comment, p.created_at,
         null::uuid, null::uuid,
         p.paper_version_id, p.paper_id,
         'paper'::text
  from public.paper_approvals p;

comment on view public.approval_inbox is
  '两类审批任务的统一收件箱（题目 + 试卷）。security_invoker=on，RLS 逐表按调用者身份生效。';

revoke all on public.approval_inbox from anon, authenticated;
grant select on public.approval_inbox to authenticated;

-- =====================================================================
-- 5) 授权收口
-- =====================================================================

revoke execute on function public.review_decide_paper(uuid, boolean, text) from public, anon;
revoke execute on function public.transfer_paper_approval(uuid, uuid) from public, anon;
grant execute on function public.review_decide_paper(uuid, boolean, text) to authenticated;
grant execute on function public.transfer_paper_approval(uuid, uuid) to authenticated;

revoke execute on function public.backfill_waiting_paper_assignees() from public, anon, authenticated;
revoke execute on function public.trg_paper_assignments_backfill() from public, anon;
grant execute on function public.trg_paper_assignments_backfill() to authenticated;

-- 一次性补救：把本迁移之前就已经卡住的待指派试卷任务补上处理人
select public.backfill_waiting_paper_assignees();
