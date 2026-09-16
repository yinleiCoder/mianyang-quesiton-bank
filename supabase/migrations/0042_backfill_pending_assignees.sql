-- 0042: 任命一生效，就把仍然「待指派」的在途任务流转到人。
--
-- 背景：任务的处理人是**创建时刻的快照**（有意为之：之后调整任命不改变在途任务的归属）。
-- 代价是——提交时若还没有对应审核人，任务就以 assigned_user_id = NULL 落库，之后**永远没人处理**：
-- RLS 只放行处理人/管理员，review_decide 也只认处理人，作者在「我的题目」里只看到「专家审核中」干等。
-- 现实中任命顺序不可控（先提交后任命、任命挂在更浅或更深的节点上），这个洞一定会被踩到：
-- 2026-09-16 线上实例=7 道题提交于 06:32–06:35，市级专家 06:41 才任命，7 条任务全部卡死。
--
-- 修法：给 approver_assignments 挂**语句级触发器**——任何建/改任命的路径（assign_city_expert、
-- assign_group_leader、将来新增的 RPC、手工 SQL）都会在同一个事务里把「无处理人的在途内容任务」
-- 重新解析一遍。解析口径与提交时**完全相同**：effective_assignee 沿祖先链、最深处优先、
-- 排除作者本人（作者不能审自己的题），所以补出来的处理人正是"当初有任命的话本该拿到它的人"。
--
-- 为什么不直接在 assign_city_expert / assign_group_leader 里加调用：这两个函数在后续迁移里
-- 还会被整体覆盖（0026 就误覆盖过 0014 的组长兼任直通，0027 才补回），写在里面的调用迟早会丢；
-- 触发器挂在表上，谁建任命都绕不过去。
--
-- 只补「无处理人」的行：在途任务的处理人一经确定就不因任命调整而变（快照语义不变）。

create or replace function public.backfill_waiting_assignees()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixed int := 0;
  v_role  assignee_role;
  v_to    uuid;
  r       record;
begin
  for r in
    select a.id, a.question_id, a.stage, a.version_id, q.school_id, q.course_node_id, q.creator_id
    from approvals a
    join questions q on q.id = a.question_id
    where a.state = 'waiting'
      and a.kind = 'content'
      and a.assigned_user_id is null
      and a.stage in ('group', 'city')
    for update of a
  loop
    v_role := case when r.stage = 'group' then 'group_leader' else 'city_expert' end::assignee_role;
    -- 排除作者本人：与 submit_question / transfer_approval 同一条规矩
    select public.effective_assignee(r.school_id, r.course_node_id, v_role, array[r.creator_id])
      into v_to;
    if v_to is not null then
      update approvals set assigned_user_id = v_to where id = r.id;
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

create or replace function public.trg_assignments_backfill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 停用任命也走这里：补不出人来的话它什么都不会改（只动 assigned_user_id is null 的行）
  perform public.backfill_waiting_assignees();
  return null;  -- 语句级触发器
end;
$$;

drop trigger if exists trg_assignments_backfill on public.approver_assignments;
create trigger trg_assignments_backfill
  after insert or update of is_active on public.approver_assignments
  for each statement execute function public.trg_assignments_backfill();

-- 收口：backfill 是内部助手（与 write_audit 同档），只由触发器以 definer 身份调用，客户端不直接调；
-- 触发器函数本身不需要执行权（直接调用会被 PG 拒），但本仓其它触发器函数都留着 authenticated 授权，
-- 这里跟随同一形态，免得下次有人拿 ACL 对比时以为漏了一行。
revoke execute on function public.backfill_waiting_assignees() from public, anon, authenticated;
revoke execute on function public.trg_assignments_backfill() from public, anon;
grant execute on function public.trg_assignments_backfill() to authenticated;

-- 一次性补救：把本迁移之前就已经卡住的待指派任务补上处理人
select public.backfill_waiting_assignees();
