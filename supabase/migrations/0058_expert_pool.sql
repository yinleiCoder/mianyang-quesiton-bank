-- 0058: 市级专家从「一岗一人」改成「岗位池」——同一节点可任命多位，任务同时发给全池，谁先处理算谁的。
--
-- 用户口径（2026-09-17）：教研组长一个学校一个学科只能有一位；市级专家不该是唯一岗位，
-- 同一节点的专家都该在待办里看到新题，谁先处理算谁的。
--
-- 两件事：
--   A) 约束：uq_approver_one_active 原本对 (role, school, node) 全体生效 → 一个节点全市只能有一位专家。
--      收敛成只约束教研组长；另加一条"同一人不在同一节点重复在任"。
--   B) 派单：审批任务的「处理人」从单值 assigned_user_id 改为集合 assigned_user_ids uuid[]。
--      市级环节 = 最深一层有任命的那个节点上的**全部**在岗专家（创建时刻快照，仍不随任命变更）；
--      组长环节 = 池里 0 或 1 人（约束保证一岗一人）。
--      决定权 = 池内任一成员：state 一离开 waiting，其余人的待办里自动消失，不需要额外清理，
--      也不需要防并发抢占——review_decide 的 `update ... where state='waiting'` 加 `if not found`
--      本来就是原子的，后到者拿到的是「该任务已被处理」。
--
-- 为什么用数组列而不是新建 approvals_assignees 关联表：池永远整取整存（可见性 / 待办 / 决定权 /
-- 建单 / 转派 / 回填），没有任何"按人增量维护"的需求；关联表要多一张表的 RLS 与视图聚合、
-- 每处查询多一次 join，换来的只有外键级联。代价明确记下：数组列挂不了外键，删账号时由
-- admin_delete_user 在 app.user_cleanup 窗口里显式 array_remove（见 G 段）；非应用路径直接删
-- auth.users 会留下一个悬空 uuid —— 任务仍可读、管理员可转派，只是处理人名显示为空。
--
-- 口径统一：转派 = 把池**替换成**目标一人（"从现在起只归他"），不是往池里加人。
-- 在途任务不重算（沿用 0042 的快照规矩）：本次只给空池补人；已存在的池原样保留，
-- 否则管理员的手工转派会被下一次重算冲掉。

-- =====================================================================
-- A) 任命约束：一岗一人只对教研组长生效
-- =====================================================================
drop index if exists public.uq_approver_one_active;
-- 组长：一个学校一个学科节点只能有一位在任（school_id 由 chk_approver_scope 保证非空）
create unique index uq_approver_one_active
  on public.approver_assignments (role, school_id, node_id)
  where is_active and role = 'group_leader';
-- 同一人在同一节点同一角色只保留一条在任记录（专家池里出现两条一模一样的条目没有意义）
create unique index uq_approver_no_dup_user
  on public.approver_assignments (role, user_id, node_id,
                                  coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_active;

comment on table public.approver_assignments is
  '审核岗位：教研组长(学校+科目节点，一岗一人，覆盖后代) / 市级专家(科目节点，全市，一节点多位=岗位池)';

-- 任命 RPC 的报错文案跟着改：专家侧不再有"岗位已有人"，只有"同一人重复在任"
create or replace function public.assign_city_expert(p_user_id uuid, p_node_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可任命市级专家';
  end if;
  if not exists (select 1 from profiles where user_id = p_user_id) then
    raise exception '目标用户不存在';
  end if;
  if not exists (select 1 from subject_nodes where id = p_node_id) then
    raise exception '科目节点不存在';
  end if;
  begin
    insert into approver_assignments (user_id, role, school_id, node_id, created_by)
    values (p_user_id, 'city_expert', null, p_node_id, v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception '该专家已在本节点在任';
  end;
  perform public.audit('assign_city_expert', null, null,
    jsonb_build_object('user_id', p_user_id, 'node_id', p_node_id));
  return v_id;
end;
$$;

-- =====================================================================
-- B) 处理人集合：assigned_user_id uuid → assigned_user_ids uuid[]
-- =====================================================================
-- 两件必须先做的事，否则这一节根本跑不过：
--   1) 视图与四条策略都写着 assigned_user_id，PG 会以"被依赖"为由拒绝 drop column，先拆掉（D 段重建）；
--   2) 搬运数据要 UPDATE 到已决行，会撞防篡改守卫（它保护的是"已决记录不被改"，
--      而这次只是把同一份数据换个列存）—— 事务内临时停守卫，搬完立刻恢复。
-- 全在一个事务里，外部不会看到这个中间态。
drop view if exists public.approval_inbox;
drop policy if exists select_approval on public.approvals;
drop policy if exists select_question on public.questions;
drop policy if exists select_version on public.question_versions;
drop policy if exists select_paper_approval on public.paper_approvals;

alter table public.approvals disable trigger trg_approvals_guard;
alter table public.paper_approvals disable trigger trg_paper_approvals_guard;

alter table public.approvals
  add column assigned_user_ids uuid[] not null default '{}'::uuid[];
update public.approvals set assigned_user_ids = array[assigned_user_id] where assigned_user_id is not null;
-- 顺带删掉 approvals_assigned_user_id_fkey（0021 的 ON DELETE SET NULL）：数组列挂不了外键，
-- 删账号路径由 admin_delete_user 显式处理
alter table public.approvals drop column assigned_user_id;

alter table public.paper_approvals
  add column assigned_user_ids uuid[] not null default '{}'::uuid[];
update public.paper_approvals set assigned_user_ids = array[assigned_user_id] where assigned_user_id is not null;
alter table public.paper_approvals drop column assigned_user_id;

alter table public.approvals enable trigger trg_approvals_guard;
alter table public.paper_approvals enable trigger trg_paper_approvals_guard;

comment on column public.approvals.assigned_user_ids is
  '处理人集合（创建时刻快照）：市级环节=该节点全部在岗专家，组长环节=0/1 人；空集=待指派。任一人处理即整单结束';
comment on column public.paper_approvals.assigned_user_ids is
  '处理人集合（创建时刻快照），语义同 approvals.assigned_user_ids';

-- 收件箱索引：数组包含查询用 GIN（@> ARRAY[uid]）
create index idx_approvals_inbox on public.approvals using gin (assigned_user_ids) where state = 'waiting';
create index idx_paper_approvals_inbox on public.paper_approvals using gin (assigned_user_ids) where state = 'waiting';

-- =====================================================================
-- C) 路由：从"最深一位"改成"最深一层的全部"
-- =====================================================================
-- 与 effective_assignee 同口径，只是取回整层人（rank=1 即深度最小的那一层）
create or replace function public.effective_assignees(
  p_school uuid, p_node uuid, p_role assignee_role, p_exclude uuid[] default '{}'::uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  with recursive chain(id, depth, parent_id) as (
    select id, 0, parent_id from subject_nodes where id = p_node
    union all
    select sn.id, c.depth + 1, sn.parent_id
    from chain c
    join subject_nodes sn on sn.id = c.parent_id
  ),
  cand as (
    select aa.user_id, rank() over (order by c.depth asc) as rk, aa.created_at
    from chain c
    join approver_assignments aa on aa.node_id = c.id and aa.is_active and aa.role = p_role
      and (aa.school_id = p_school or (p_role = 'city_expert'))
      -- array_remove 掉 NULL：作者注销后 created_by 为 NULL，数组里混进 NULL 会让 `= any(...)`
      -- 求值成 NULL，在 not(...) 下把所有候选都误判为"被排除"（0046/0057 的同一个坑）
      and not (aa.user_id = any (array_remove(coalesce(p_exclude, '{}'::uuid[]), null)))
  )
  select coalesce(array_agg(cand.user_id order by cand.created_at, cand.user_id), '{}'::uuid[])
  from cand
  where cand.rk = 1;
$$;

-- 市级专家池：先排除 [本次决策人, 作者]；一个都不剩时退回不排除任何人的那一层
--（只剩作者本人时也正常流转给他——宁可作者自审，也不能让题悬空，见 0057）
create or replace function public.route_city_experts(
  p_school uuid, p_node uuid, p_author uuid, p_decider uuid default null)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(public.effective_assignees(p_school, p_node, 'city_expert',
      array_remove(array[p_decider, p_author], null)), '{}'::uuid[]),
    public.effective_assignees(p_school, p_node, 'city_expert')
  );
$$;

-- 组长池：一岗一人，池里恒为 0 或 1 人（排除作者本人 = 0014 的兼任直通规矩）
create or replace function public.route_group_leader(p_school uuid, p_node uuid, p_author uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select array_remove(
    array[public.effective_assignee(p_school, p_node, 'group_leader',
      array_remove(array[p_author], null))], null);
$$;

-- 0057 的单值版已被 route_city_experts 取代，留着只会让下一个读代码的人选错
drop function if exists public.route_city_expert(uuid, uuid, uuid, uuid);

revoke execute on function public.effective_assignees(uuid, uuid, assignee_role, uuid[]) from public, anon;
revoke execute on function public.route_city_experts(uuid, uuid, uuid, uuid) from public, anon;
revoke execute on function public.route_group_leader(uuid, uuid, uuid) from public, anon;
grant execute on function public.effective_assignees(uuid, uuid, assignee_role, uuid[]) to authenticated;
grant execute on function public.route_city_experts(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.route_group_leader(uuid, uuid, uuid) to authenticated;

-- =====================================================================
-- D) 可见性：策略与收件箱视图改为"我在池里"
-- =====================================================================
drop policy if exists select_approval on public.approvals;
create policy select_approval on public.approvals for select to authenticated using (
  (select auth.uid()) = any(assigned_user_ids)
  or decided_by = (select auth.uid())
  or (select public.is_admin())
  or (select public.is_school_admin_of_question(question_id))
  or (select public.is_question_creator(question_id))
);

drop policy if exists select_paper_approval on public.paper_approvals;
create policy select_paper_approval on public.paper_approvals for select to authenticated using (
  (select auth.uid()) = any(assigned_user_ids)
  or decided_by = (select auth.uid())
  or (select public.is_admin())
  or (select public.is_school_admin_of_paper(paper_id))
  or (select public.is_paper_creator(paper_id))
);

-- 题目/版本可见性里的"审批参与人"分支（0005 版，0009 只改过 approvals 那一侧）
drop policy if exists select_question on public.questions;
create policy select_question on public.questions for select to authenticated using (
  creator_id = (select auth.uid())
  or (select public.is_admin())
  or exists (
    select 1 from profiles p join user_roles r on r.user_id = p.user_id
    where p.user_id = (select auth.uid()) and r.role = 'school_admin' and p.school_id = questions.school_id)
  or exists (select 1 from approvals a where a.question_id = questions.id
             and ((select auth.uid()) = any(a.assigned_user_ids) or a.decided_by = (select auth.uid())))
  or (state = 'live' and current_published_version_id is not null)
);

drop policy if exists select_version on public.question_versions;
create policy select_version on public.question_versions for select to authenticated using (
  created_by = (select auth.uid())
  or (select public.is_admin())
  or exists (
    select 1 from questions q
    join profiles p on p.user_id = (select auth.uid())
    join user_roles r on r.user_id = p.user_id and r.role = 'school_admin'
    where q.id = question_versions.question_id and p.school_id = q.school_id)
  or exists (select 1 from approvals a where a.version_id = question_versions.id
             and ((select auth.uid()) = any(a.assigned_user_ids) or a.decided_by = (select auth.uid())))
  or (status = 'published'
      and exists (select 1 from questions q
                  where q.id = question_versions.question_id and q.state = 'live'
                    and q.current_published_version_id = question_versions.id))
);

-- 统一收件箱视图（结构同 0047，只把 assigned_user_id 换成 assigned_user_ids）
create view public.approval_inbox with (security_invoker = on) as
  select a.id, a.kind, a.stage, a.state, a.assigned_user_ids, a.decided_by, a.decided_at,
         a.comment, a.created_at,
         a.version_id, a.question_id,
         null::uuid as paper_version_id, null::uuid as paper_id,
         'question'::text as target,
         public.approval_target_school(a.question_id, null) as school_id
  from public.approvals a
  union all
  select p.id, p.kind, p.stage, p.state, p.assigned_user_ids, p.decided_by, p.decided_at,
         p.comment, p.created_at,
         null::uuid, null::uuid,
         p.paper_version_id, p.paper_id,
         'paper'::text,
         public.approval_target_school(null, p.paper_id)
  from public.paper_approvals p;

comment on view public.approval_inbox is
  '两类审批任务的统一收件箱（题目 + 试卷）。security_invoker=on，RLS 逐表按调用者身份生效。';

revoke all on public.approval_inbox from anon, authenticated;
grant select on public.approval_inbox to authenticated;

-- =====================================================================
-- E) 试卷侧的可见性 helper 与作者工作台
-- =====================================================================
create or replace function public.is_paper_approver(p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from paper_approvals a
    where a.paper_id = p_paper_id
      and ((select auth.uid()) = any(a.assigned_user_ids) or a.decided_by = (select auth.uid()))
  );
$$;

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
          and ((select auth.uid()) = any(a.assigned_user_ids) or a.decided_by = (select auth.uid())))
      -- 组卷库：已发布且该版本仍是当前版本，且试卷在线
      or (v.status = 'published' and p.state = 'live' and p.current_published_version_id = v.id)
    )
  );
$$;

-- 作者工作台的"卡在谁那里"：单值 → 数组（前端只用来判断"是否尚未指派"）
create or replace function public.list_my_papers(p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb;
  v_total int;
begin
  select count(*)::int into v_total from papers p
  where p.creator_id = v_uid;

  select coalesce(jsonb_agg(x.payload order by x.sort_key desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'paper_id', p.id, 'version_id', v.id, 'version_no', v.version_no,
               'title', v.title, 'exam_name', v.exam_name, 'subject_label', v.subject_label,
               'status', v.status, 'total_score', v.total_score, 'target_score', v.target_score,
               'duration_minutes', v.duration_minutes,
               'published_version_id', p.current_published_version_id,
               'paper_state', p.state, 'course_node_id', p.course_node_id,
               'item_count', (select count(*) from paper_items i where i.paper_version_id = v.id),
               'health', (select count(*) from paper_items i
                          join questions q on q.id = i.question_id
                          join question_versions qv on qv.id = i.question_version_id
                          where i.paper_version_id = v.id
                            and not (q.state = 'live' and qv.status = 'published'
                                     and q.current_published_version_id = i.question_version_id)),
               'updated_at', v.updated_at, 'submitted_at', v.submitted_at, 'published_at', v.published_at,
               -- 在途任务卡在谁那里（RLS 之外由 definer 读，避免工作台再打一次往返）
               'waiting_stage', (select a.stage from paper_approvals a
                                 where a.paper_version_id = v.id and a.state = 'waiting' limit 1),
               'waiting_assignees', (select a.assigned_user_ids from paper_approvals a
                                     where a.paper_version_id = v.id and a.state = 'waiting' limit 1)
             ) as payload,
             coalesce(v.published_at, v.submitted_at, v.updated_at) as sort_key
      from papers p
      join paper_versions v on v.paper_id = p.id
      -- 每题只列一行：有在流版本就列在流的，否则列当前入库版
      where p.creator_id = v_uid
        and (v.status in ('draft','pending_group','pending_city','returned')
             or v.id = p.current_published_version_id)
      order by sort_key desc
      limit v_limit offset v_offset
    ) x;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'papers', v_rows);
end;
$$;

-- =====================================================================
-- F) 写入路径：建单 / 决定 / 转派 / 回填
-- =====================================================================
-- 提交（组长环节建单）。其余与 0057 版逐字一致
create or replace function public.submit_question(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_status text;
  v_qid uuid;
  v_school uuid;
  v_node uuid;
  v_leader uuid[];
  v_expert uuid[];
  v_skip_group boolean := false;
  v_frozen boolean;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select v.status, v.question_id into v_status, v_qid
  from question_versions v where v.id = p_version_id and v.created_by = v_uid
    and v.status in ('draft', 'returned');
  if not found then
    raise exception '找不到可提交的版本（只能提交自己的草稿或被退回的版本）';
  end if;

  select q.school_id, q.course_node_id into v_school, v_node
  from questions q where q.id = v_qid;
  select is_frozen into v_frozen from subject_nodes where id = v_node;
  if v_frozen then
    raise exception '该课程节点已冻结，暂不能提交';
  end if;

  -- 内容最终校验（含退回后修改过的版本）
  perform public.validate_question_content(
    (select qtype from question_versions where id = p_version_id),
    (select content from question_versions where id = p_version_id));

  -- 组长路由：排除作者本人后沿祖先找最深生效任命。
  --  有结果 → 常规组长环节；
  --  无结果且不含排除能解出组长（即唯一候选=作者本人，兼任）→ 跳过组长环节；
  --  完全无任何任命 → 拦截提示。
  v_leader := public.route_group_leader(v_school, v_node, v_uid);
  if cardinality(v_leader) = 0 then
    if public.effective_assignee(v_school, v_node, 'group_leader') is not null then
      v_skip_group := true;
    else
      raise exception '该校该课程暂未配置教研组长，请联系学校管理员任命后提交';
    end if;
  end if;

  if v_skip_group then
    update question_versions
    set status = 'pending_city', submitted_at = now()
    where id = p_version_id;

    -- 市级池：该节点最深一层的全部专家（排除作者本人；只剩他自己时仍正常流转给他）
    v_expert := public.route_city_experts(v_school, v_node, v_uid);
    begin
      insert into approvals (kind, version_id, question_id, stage, assigned_user_ids)
      values ('content', p_version_id, v_qid, 'city', v_expert);
    exception when unique_violation then
      raise exception '该版本已在审核中，请刷新页面查看';
    end;
    perform public.audit('submit_version', v_qid, p_version_id,
      jsonb_build_object('skip_group', 'self_group_leader', 'city_experts', v_expert));
    return;
  end if;

  begin
    update question_versions
    set status = 'pending_group', submitted_at = now()
    where id = p_version_id;

    insert into approvals (kind, version_id, question_id, stage, assigned_user_ids)
    values ('content', p_version_id, v_qid, 'group', v_leader);
  exception when unique_violation then
    raise exception '该版本已在审核中，请刷新页面查看';
  end;

  perform public.audit('submit_version', v_qid, p_version_id,
    jsonb_build_object('group_leader', v_leader));
end;
$$;

-- 下线/恢复申请：同样是组长环节建单
create or replace function public.request_question_state_change(p_question_id uuid, p_offline boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_q questions%rowtype;
  v_pool uuid[];
  v_kind text := case when p_offline then 'offline' else 'restore' end;
begin
  select * into v_q from questions where id = p_question_id;
  if not found then
    raise exception '题目不存在';
  end if;
  -- 仅作者本人发起（走组长审批）；系统管理员用 admin_set_question_state 直接操作
  if v_q.creator_id <> v_uid then
    raise exception '只有作者本人能申请下线/恢复该题';
  end if;
  if public.is_admin() then
    raise exception '系统管理员请使用直接操作入口';
  end if;
  if p_offline and v_q.state <> 'live' then
    raise exception '该题当前已下线';
  end if;
  if not p_offline and v_q.state <> 'offline' then
    raise exception '该题当前并未下线';
  end if;
  if v_q.current_published_version_id is null then
    raise exception '题目尚未入库，无需下线/恢复';
  end if;

  v_pool := public.route_group_leader(v_q.school_id, v_q.course_node_id, v_q.creator_id);
  if cardinality(v_pool) = 0 then
    raise exception '该校该课程暂未配置教研组长，请联系学校管理员';
  end if;
  begin
    insert into approvals (kind, version_id, question_id, stage, assigned_user_ids)
    values (v_kind, null, p_question_id, 'group', v_pool);
  exception when unique_violation then
    raise exception '该题已有待处理的同类申请，请勿重复提交';
  end;
  perform public.audit(case when p_offline then 'request_offline' else 'request_restore' end,
    p_question_id, null, jsonb_build_object('assignee', v_pool));
end;
$$;

-- 决定（组长通过 → 建市级池）。其余与 0057 版逐字一致
create or replace function public.review_decide(
  p_approval_id uuid, p_pass boolean, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_approval approvals%rowtype;
  v_version question_versions%rowtype;
  v_q questions%rowtype;
  v_expert uuid[];
begin
  select * into v_approval from approvals where id = p_approval_id;
  if not found then
    raise exception '审批任务不存在';
  end if;
  if v_approval.state <> 'waiting' then
    raise exception '该任务已被处理';
  end if;
  -- 处理人是一组人（岗位池）：池内任一人都有决定权，谁先处理算谁的
  if not (v_uid = any(v_approval.assigned_user_ids)) then
    raise exception '该任务不在你的待办中（可能已转派或已被他人处理）';
  end if;

  -- ============ 退回 ============
  if not p_pass then
    if p_comment is null or trim(p_comment) = '' then
      raise exception '退回时必须填写审批意见';
    end if;
    update approvals set state = 'returned', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
    -- 关闭同版本/同事件的其他等待任务
    update approvals set state = 'cancelled'
    where state = 'waiting' and id <> p_approval_id
      and (version_id = v_approval.version_id
           or (v_approval.version_id is null and question_id = v_approval.question_id and kind = v_approval.kind));
    if v_approval.version_id is not null then
      update question_versions set status = 'returned'
      where id = v_approval.version_id and status in ('pending_group', 'pending_city');
    end if;
    perform public.audit('review_return', v_approval.question_id, v_approval.version_id,
      jsonb_build_object('stage', v_approval.stage, 'comment', p_comment));
    return;
  end if;

  -- ============ 通过 ============
  select * into v_q from questions where id = v_approval.question_id;

  if v_approval.kind in ('offline', 'restore') then
    update approvals set state = 'approved', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
    update questions set state = case when v_approval.kind = 'offline' then 'offline' else 'live' end
    where id = v_q.id;
    perform public.audit(case when v_approval.kind = 'offline' then 'approve_offline' else 'approve_restore' end,
      v_q.id, null, jsonb_build_object('comment', p_comment));
    return;
  end if;

  select * into v_version from question_versions where id = v_approval.version_id;
  if v_version.status <> 'pending_' || v_approval.stage then
    raise exception '版本当前状态与任务环节不匹配';
  end if;

  if v_approval.stage = 'group' then
    update approvals set state = 'approved', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
    update question_versions set status = 'pending_city' where id = v_version.id;
    -- 市级池：优先给「非组长、非作者」的专家；一个都不剩时回归作者本人（0057 的口径）
    v_expert := public.route_city_experts(v_q.school_id, v_q.course_node_id, v_version.created_by, v_uid);
    insert into approvals (kind, version_id, question_id, stage, assigned_user_ids)
    values ('content', v_version.id, v_q.id, 'city', v_expert);
    perform public.audit('approve_group', v_q.id, v_version.id,
      jsonb_build_object('city_experts', v_expert, 'comment', p_comment));
    return;
  end if;

  -- ============ 市级专家通过 = 入库（幂等） ============
  update approvals set state = 'approved', decided_by = v_uid, decided_at = now(), comment = p_comment
  where id = p_approval_id and state = 'waiting';
  if not found then
    raise exception '该任务已被处理';
  end if;
  update question_versions
  set status = 'published', published_at = now()
  where id = v_version.id and status = 'pending_city';
  if not found then
    raise exception '版本入库状态变更失败，请刷新后重试';
  end if;
  -- 旧入库版本标记为已被替换（事务级授权，防篡改守卫只放行 status 迁移）
  perform set_config('app.allow_supersede', 'on', true);
  update question_versions set status = 'superseded'
  where question_id = v_q.id and status = 'published' and id <> v_version.id;
  perform set_config('app.allow_supersede', 'off', true);
  update questions set current_published_version_id = v_version.id where id = v_q.id;
  perform public.audit('approve_city_publish', v_q.id, v_version.id,
    jsonb_build_object('comment', p_comment));
end;
$$;

-- 转派：把池替换成目标一人（"从现在起只归他"）。其余与 0004 版逐字一致
create or replace function public.transfer_approval(p_approval_id uuid, p_to_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_approval approvals%rowtype;
  v_q questions%rowtype;
begin
  select * into v_approval from approvals where id = p_approval_id;
  if not found then
    raise exception '审批任务不存在';
  end if;
  if v_approval.state <> 'waiting' then
    raise exception '只有待处理任务可以转派';
  end if;
  select * into v_q from questions where id = v_approval.question_id;
  if not (public.is_admin()
          or (v_approval.stage = 'group' and public.is_school_admin(v_q.school_id))) then
    raise exception '无权转派该任务';
  end if;
  if not exists (select 1 from profiles where user_id = p_to_user) then
    raise exception '目标用户不存在';
  end if;
  if v_approval.version_id is not null
     and p_to_user = (select created_by from question_versions where id = v_approval.version_id) then
    raise exception '不能转派给作者本人';
  end if;
  if p_to_user = any(v_approval.assigned_user_ids) then
    raise exception '目标用户已是该任务处理人';
  end if;
  update approvals set assigned_user_ids = array[p_to_user] where id = p_approval_id;
  perform public.audit('transfer_approval', v_q.id, v_approval.version_id,
    jsonb_build_object('from', v_approval.assigned_user_ids, 'to', p_to_user));
end;
$$;

-- 试卷侧：提交 / 决定 / 转派
create or replace function public.submit_paper(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver paper_versions%rowtype;
  v_school uuid;
  v_node uuid;
  v_frozen boolean;
  v_items int;
  v_empty text[];
  v_bad text[];
  v_stale text[];
  v_leader uuid[];
  v_expert uuid[];
  v_skip_group boolean := false;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select * into v_ver from paper_versions
  where id = p_version_id and created_by = v_uid and status in ('draft', 'returned');
  if not found then
    raise exception '找不到可提交的试卷（只能提交自己的草稿或被退回的版本）';
  end if;

  select p.school_id, p.course_node_id into v_school, v_node from papers p where p.id = v_ver.paper_id;
  select is_frozen into v_frozen from subject_nodes where id = v_node;
  if v_frozen then
    raise exception '该课程节点已冻结，暂不能提交';
  end if;

  -- ============ 卷面硬校验（"只能使用题库中的题目"这条要求的落点）============
  select count(*) into v_items from paper_items where paper_version_id = p_version_id;
  if v_items = 0 then
    raise exception '试卷还没有任何题目，无法提交';
  end if;

  select array_agg(sec.title order by sec.sort_order) into v_empty
  from paper_sections sec
  where sec.paper_version_id = p_version_id
    and not exists (select 1 from paper_items i where i.section_id = sec.id);
  if v_empty is not null then
    raise exception '这些大题下面还没有题目：%', array_to_string(v_empty, '、');
  end if;

  -- 全卷题目必须已入库且在线（AI 一键成卷进来的草稿题会在这里被拦住）
  select array_agg(i.seq::text order by i.seq) into v_bad
  from paper_items i
  join questions q on q.id = i.question_id
  join question_versions qv on qv.id = i.question_version_id
  where i.paper_version_id = p_version_id
    and not (q.state = 'live' and qv.status = 'published');
  if v_bad is not null then
    raise exception '第 % 题尚未入库或已下线，请先在题库完成入库后再提交', array_to_string(v_bad, '、');
  end if;

  -- 定版指针落后于题库当前版本：内容会与教师看到的预览不一致，要求先刷新
  select array_agg(i.seq::text order by i.seq) into v_stale
  from paper_items i
  join questions q on q.id = i.question_id
  where i.paper_version_id = p_version_id
    and q.current_published_version_id is distinct from i.question_version_id;
  if v_stale is not null then
    raise exception '第 % 题在题库中已更新到新版本，请点「刷新题目」后再提交', array_to_string(v_stale, '、');
  end if;

  if v_ver.target_score is not null and v_ver.target_score <> v_ver.total_score then
    raise exception '全卷合计 % 分与设定的总分 % 分不一致（相差 %）',
      v_ver.total_score, v_ver.target_score, v_ver.total_score - v_ver.target_score;
  end if;

  -- ============ 审批路由（与 submit_question 逐条对齐）============
  v_leader := public.route_group_leader(v_school, v_node, v_uid);
  if cardinality(v_leader) = 0 then
    if public.effective_assignee(v_school, v_node, 'group_leader') is not null then
      v_skip_group := true;
    else
      raise exception '该校该课程暂未配置教研组长，请联系学校管理员任命后提交';
    end if;
  end if;

  if v_skip_group then
    update paper_versions set status = 'pending_city', submitted_at = now() where id = p_version_id;
    v_expert := public.route_city_experts(v_school, v_node, v_uid);
    begin
      insert into paper_approvals (kind, paper_version_id, paper_id, stage, assigned_user_ids)
      values ('paper', p_version_id, v_ver.paper_id, 'city', v_expert);
    exception when unique_violation then
      raise exception '该试卷已在审核中，请刷新页面查看';
    end;
    perform public.paper_audit('submit_paper', v_ver.paper_id, p_version_id,
      jsonb_build_object('skip_group', 'self_group_leader', 'city_experts', v_expert, 'items', v_items));
    return;
  end if;

  begin
    update paper_versions set status = 'pending_group', submitted_at = now() where id = p_version_id;
    insert into paper_approvals (kind, paper_version_id, paper_id, stage, assigned_user_ids)
    values ('paper', p_version_id, v_ver.paper_id, 'group', v_leader);
  exception when unique_violation then
    raise exception '该试卷已在审核中，请刷新页面查看';
  end;

  perform public.paper_audit('submit_paper', v_ver.paper_id, p_version_id,
    jsonb_build_object('group_leader', v_leader, 'items', v_items));
end;
$$;

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
  v_expert uuid[];
begin
  select * into v_approval from paper_approvals where id = p_approval_id;
  if not found then
    raise exception '审批任务不存在';
  end if;
  if v_approval.state <> 'waiting' then
    raise exception '该任务已被处理';
  end if;
  if not (v_uid = any(v_approval.assigned_user_ids)) then
    raise exception '该任务不在你的待办中（可能已转派或已被他人处理）';
  end if;

  if not p_pass then
    if p_comment is null or trim(p_comment) = '' then
      raise exception '退回时必须填写审批意见';
    end if;
    update paper_approvals set state = 'returned', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
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
    v_expert := public.route_city_experts(v_paper.school_id, v_paper.course_node_id, v_version.created_by, v_uid);
    insert into paper_approvals (kind, paper_version_id, paper_id, stage, assigned_user_ids)
    values ('paper', v_version.id, v_paper.id, 'city', v_expert);
    perform public.paper_audit('approve_paper_group', v_paper.id, v_version.id,
      jsonb_build_object('city_experts', v_expert, 'comment', p_comment));
    return;
  end if;

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
  perform set_config('app.allow_paper_supersede', 'on', true);
  update paper_versions set status = 'superseded'
  where paper_id = v_paper.id and status = 'published' and id <> v_version.id;
  perform set_config('app.allow_paper_supersede', 'off', true);
  update papers set current_published_version_id = v_version.id where id = v_paper.id;
  perform public.paper_audit('approve_paper_city_publish', v_paper.id, v_version.id,
    jsonb_build_object('comment', p_comment));
end;
$$;

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
  if p_to_user = any(v_approval.assigned_user_ids) then
    raise exception '目标用户已是该任务处理人';
  end if;
  update paper_approvals set assigned_user_ids = array[p_to_user] where id = p_approval_id;
  perform public.paper_audit('transfer_paper_approval', v_paper.id, v_approval.paper_version_id,
    jsonb_build_object('from', v_approval.assigned_user_ids, 'to', p_to_user));
end;
$$;

-- 空池回填（0042 / 0046 的同构体，解析口径改为池）
create or replace function public.backfill_waiting_assignees()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixed int := 0;
  v_to    uuid[];
  r       record;
begin
  for r in
    select a.id, a.question_id, a.stage, a.version_id, q.school_id, q.course_node_id, q.creator_id
    from approvals a
    join questions q on q.id = a.question_id
    where a.state = 'waiting'
      and a.kind = 'content'
      and a.assigned_user_ids = '{}'::uuid[]
      and a.stage in ('group', 'city')
    for update of a
  loop
    -- 组长环节：排除作者本人（0014 已在提交阶段跳过该环节，这里只是兜底）
    -- 市级环节：该节点最深一层的全部专家，含作者本人（0057 的口径）
    v_to := case when r.stage = 'group'
                 then public.route_group_leader(r.school_id, r.course_node_id, r.creator_id)
                 else public.route_city_experts(r.school_id, r.course_node_id, r.creator_id)
            end;
    if cardinality(v_to) > 0 then
      update approvals set assigned_user_ids = v_to where id = r.id;
      -- user_id 取自 auth.uid()：任命是管理员发起的，日志就记在他名下；迁移里的一次性补救
      -- 没有请求上下文，auth.uid() 为空 → 审计页显示「（系统）」，正好是本意
      perform public.audit('backfill_assignee', r.question_id, r.version_id,
        jsonb_build_object('stage', r.stage, 'to', v_to));
      v_fixed := v_fixed + 1;
    end if;
  end loop;
  return v_fixed;
end;
$$;

create or replace function public.backfill_waiting_paper_assignees()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixed int := 0;
  v_to uuid[];
  r record;
begin
  for r in
    select a.id, a.paper_id, a.stage, a.paper_version_id,
           p.school_id, p.course_node_id, p.creator_id
    from paper_approvals a
    join papers p on p.id = a.paper_id
    where a.state = 'waiting'
      and a.kind = 'paper'
      and a.assigned_user_ids = '{}'::uuid[]
      and a.stage in ('group', 'city')
    for update of a
  loop
    v_to := case when r.stage = 'group'
                 then public.route_group_leader(r.school_id, r.course_node_id, r.creator_id)
                 else public.route_city_experts(r.school_id, r.course_node_id, r.creator_id)
            end;
    if cardinality(v_to) > 0 then
      update paper_approvals set assigned_user_ids = v_to where id = r.id;
      perform public.paper_audit('backfill_paper_assignee', r.paper_id, r.paper_version_id,
        jsonb_build_object('stage', r.stage, 'to', v_to));
      v_fixed := v_fixed + 1;
    end if;
  end loop;
  return v_fixed;
end;
$$;

-- =====================================================================
-- G) 删账号：池里摘掉本人
--    0023 只给题目侧的两个守卫开了"注销清理"口子（guard_version_immutable /
--    guard_approval_immutable），试卷是后来加的、没跟上：paper_approvals 用的是自己的
--    guard_paper_approval_immutable，paper_versions 的守卫也没有清理分支。于是
--    "删除出过卷子/审过卷子的用户"会在 delete from auth.users 触发 FK 级联置空时撞守卫报错、
--    整单回滚（FK 级联发生在 admin_delete_user 关掉开关之后，所以窗口根本没覆盖到）。
--    这里把三个守卫一次补齐，并在 admin_delete_user 里显式清理试卷侧的引用列。
-- =====================================================================
create or replace function public.guard_approval_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.state in ('approved', 'returned', 'cancelled') then
    -- 用户注销清理：只允许从处理人池里**移除**人、以及把 decided_by 置空，其余字段原样。
    -- 池"只减不增"（<@）比 0023 版的宽松判据更紧。
    if tg_op = 'UPDATE'
       and current_setting('app.user_cleanup', true) = 'on'
       and new.assigned_user_ids <@ old.assigned_user_ids
       and (new.decided_by is null or new.decided_by = old.decided_by)
       and (to_jsonb(new) - 'assigned_user_ids' - 'decided_by')
           is not distinct from (to_jsonb(old) - 'assigned_user_ids' - 'decided_by') then
      return new;
    end if;
    raise exception '已决审批记录不可修改或删除';
  end if;
  return new;
end;
$$;

-- 试卷审批守卫：补同一条清理口子（其余与 0048 版逐字一致）
create or replace function public.guard_paper_approval_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.state in ('approved', 'returned', 'cancelled') then
    if tg_op = 'UPDATE'
       and current_setting('app.user_cleanup', true) = 'on'
       and new.assigned_user_ids <@ old.assigned_user_ids
       and (new.decided_by is null or new.decided_by = old.decided_by)
       and (to_jsonb(new) - 'assigned_user_ids' - 'decided_by')
           is not distinct from (to_jsonb(old) - 'assigned_user_ids' - 'decided_by') then
      return new;
    end if;
    raise exception '已决审批记录不可修改或删除';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- 试卷版本守卫：补 created_by 置空的清理口子（其余与 0044 版逐字一致）。
-- 不加这条，删账号时 paper_versions_created_by_fkey 的 SET NULL 级联会被守卫拦下。
create or replace function public.guard_paper_version_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status in ('published', 'superseded', 'retracted') then
    -- 唯一合法的入库后迁移：新版本发布时系统把旧 published 行标记为 superseded。
    if tg_op = 'UPDATE'
       and old.status = 'published' and new.status = 'superseded'
       and current_setting('app.allow_paper_supersede', true) = 'on'
       and (to_jsonb(new) - 'status') is not distinct from (to_jsonb(old) - 'status') then
      return new;
    end if;
    -- 用户注销清理：仅 created_by 置空，其余字段（含 status/卷面/时间戳）原样
    if tg_op = 'UPDATE'
       and current_setting('app.user_cleanup', true) = 'on'
       and old.created_by is not null and new.created_by is null
       and (to_jsonb(new) - 'created_by') is not distinct from (to_jsonb(old) - 'created_by') then
      return new;
    end if;
    raise exception '该状态的试卷版本不可直接修改';
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception '只能删除纯草稿版本的试卷';
    end if;
    -- 必须返回 OLD：BEFORE DELETE 触发器返回 NULL 会**静默取消**这次删除（0048 的坑）
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.admin_delete_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := public.require_uid();
  v_me       profiles%rowtype;
  v_target   profiles%rowtype;
  v_is_sys   boolean;
  v_versions bigint;
  v_approvals bigint;
begin
  select * into v_me from profiles where user_id = v_uid;
  v_is_sys := coalesce(v_me.is_admin, false);

  if not v_is_sys then
    if v_me.school_id is null
       or not exists (select 1 from user_roles r where r.user_id = v_uid and r.role = 'school_admin') then
      raise exception '仅系统管理员或本校学校管理员可删除用户';
    end if;
  end if;

  if p_user_id = v_uid then
    raise exception '不能删除当前登录账号';
  end if;

  select * into v_target from profiles where user_id = p_user_id;
  if not found then
    raise exception '用户不存在';
  end if;
  if v_target.is_admin then
    raise exception '系统管理员账号不可删除';
  end if;

  if not v_is_sys then
    if v_target.school_id is distinct from v_me.school_id then
      raise exception '只能删除本校用户';
    end if;
    if exists (select 1 from user_roles r where r.user_id = p_user_id and r.role = 'school_admin') then
      raise exception '该用户为学校管理员，需由系统管理员删除';
    end if;
    if exists (select 1 from approver_assignments a
               where a.user_id = p_user_id and a.role = 'city_expert' and a.is_active) then
      raise exception '该用户担任市级专家，需由系统管理员删除';
    end if;
  end if;

  -- 保留共享内容与历史：引用列显式清理（守卫放行窗口；池被清空的等待任务随之变"待指派"）
  perform set_config('app.user_cleanup', 'on', true);
  update questions set creator_id = null where creator_id = p_user_id;
  update question_versions set created_by = null where created_by = p_user_id;
  get diagnostics v_versions = row_count;
  update approvals set assigned_user_ids = array_remove(assigned_user_ids, p_user_id), decided_by = null
   where p_user_id = any(assigned_user_ids) or decided_by = p_user_id;
  get diagnostics v_approvals = row_count;
  -- 试卷侧同理（数组列没有外键兜底，必须显式摘）
  update paper_approvals set assigned_user_ids = array_remove(assigned_user_ids, p_user_id), decided_by = null
   where p_user_id = any(assigned_user_ids) or decided_by = p_user_id;
  update papers set creator_id = null where creator_id = p_user_id;
  update paper_versions set created_by = null where created_by = p_user_id;
  update media_objects set uploaded_by = null where uploaded_by = p_user_id;
  update audit_log set user_id = null where user_id = p_user_id;
  update tags set created_by = null where created_by = p_user_id;
  update subject_nodes set created_by = null where created_by = p_user_id;
  update approver_assignments set created_by = null where created_by = p_user_id;
  update user_roles set created_by = null where created_by = p_user_id;
  perform set_config('app.user_cleanup', 'off', true);

  delete from auth.users where id = p_user_id;
  if not found then
    raise exception '用户不存在（认证记录缺失）';
  end if;

  perform public.audit('admin_delete_user', null, null,
    jsonb_build_object('user_id', p_user_id, 'name', v_target.name, 'email', v_target.email,
                       'actor_role', case when v_is_sys then 'system_admin' else 'school_admin' end,
                       'versions_kept', v_versions, 'approval_refs_cleared', v_approvals));
end;
$$;

-- =====================================================================
-- H) 一次性补救：空池补人（在途任务不重算，见文件头注）
-- =====================================================================
select public.backfill_waiting_assignees();
select public.backfill_waiting_paper_assignees();

-- 视图换了列、若干函数换了签名：PostgREST 的 schema 缓存不刷会继续按旧列名解析（PGRST202/42703）
notify pgrst, 'reload schema';
