-- 0083: 市级专家池按市收口。
--
-- 背景：0082 之后超管已经能在界面上建第二个市、把学校挂过去。而审批路由仍然只按科目节点
-- 找人 —— effective_assignees() 里市级专家那一支写着 `or (p_role = 'city_expert')`，
-- 意思是"专家与学校无关，同节点的全是候选"。只有绵阳时看不出问题，
-- **出现第二个市的当天就会跨市派单**：南充的题派给绵阳的专家。
--
-- 口径（2026-09-30 用户确认）：
--   - 市级专家只管**自己市**的题。人的市由 profile → school → city 推导（0082 的规矩），
--     所以"一人只能是一个市的专家"天然成立，不需要额外约束。
--   - 由此推出：**专家本人必须绑学校**（没学校就没有市）。任命时直接拦住，
--     而不是让他以后静默地什么都收不到 —— 需要市教科所这类不在学校的专家时，
--     给他建一所挂在市下的学校即可（平台上已有「市级题库（平台）」这种非实体学校）。
--   - **在途任务不重算**（0042/0058 的快照规矩）：本次只影响之后新建的池，
--     已派出去的任务照旧，管理员手工转派的结果也不会被冲掉。
--   - **超管转派仍可跨市**：那是应急阀（新市还没有专家时，先把题接过去审）。
--     转派本来就只放给超管（市级环节）与学校管理员（组长环节），不是教师能用的路径。
--
-- 改动集中在一个函数：effective_assignees() 是唯一的候选人筛选器，9 个调用方
-- （submit_question / submit_paper / review_decide / review_decide_paper /
--  route_city_experts / route_group_leader / 两条 backfill / request_question_state_change）
-- 全部经过它；RLS 策略与收件箱视图只认 assigned_user_ids 池、不引用它（pg_policies 查过）。
-- 单值版 effective_assignee() 一并改：它现在只被 route_group_leader 用于组长，
-- 但留着一个"市级不分市"的版本，下一个人调用时必然踩。
--
-- 组长环节不动：任命本来就带 school_id（一岗一人），学校已挂在市下，天然是市域内的。

-- =====================================================================
-- 1) 候选池：市级专家加上"与题目同市"
-- =====================================================================
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
  -- 题目/试卷所属学校的市
  scope_city as (
    select s.city_id from schools s where s.id = p_school
  ),
  cand as (
    select aa.user_id, rank() over (order by c.depth asc) as rk, aa.created_at
    from chain c
    join approver_assignments aa on aa.node_id = c.id and aa.is_active and aa.role = p_role
      and (
        aa.school_id = p_school
        -- 市级专家：只取与题目同市的（专家的市 = 他自己的 profile → school → city）。
        -- 先按市筛、再按深度 rank：本层没有同市专家时，自然沿祖先向上找同市的（0083 起）。
        -- 学校的市为空时退回"该节点全部专家"——建校必须选市，正常到不了这里；
        -- 真到了也宁可跨市派单，不能让题悬空（0057 那次线上卡 52 道题的教训）。
        or (p_role = 'city_expert' and (
             (select city_id from scope_city) is null
             or exists (
               select 1
               from profiles p
               join schools s on s.id = p.school_id
               where p.user_id = aa.user_id
                 and s.city_id = (select city_id from scope_city)
             )
           ))
      )
      -- array_remove 掉 NULL：作者注销后 created_by 为 NULL，数组里混进 NULL 会让 `= any(...)`
      -- 求值成 NULL，在 not(...) 下把所有候选都误判为"被排除"（0046/0057 的同一个坑）
      and not (aa.user_id = any (array_remove(coalesce(p_exclude, '{}'::uuid[]), null)))
  )
  select coalesce(array_agg(cand.user_id order by cand.created_at, cand.user_id), '{}'::uuid[])
  from cand
  where cand.rk = 1;
$$;

comment on function public.effective_assignees(uuid, uuid, assignee_role, uuid[]) is
  '某学校某节点下的处理人池：组长=本校（覆盖后代）；市级专家=同市（由 profile→school→city 推导）+ 覆盖后代。p_school 的市为空时市级退回不筛市';

-- 单值版：与上面同口径（它只被 route_group_leader 用，但两份必须一致）。
-- 顺带补上单值版一直缺的 array_remove —— 它对 p_exclude 里的 NULL 从来没有免疫力。
create or replace function public.effective_assignee(
  p_school uuid, p_node uuid, p_role assignee_role, p_exclude uuid[] default '{}'::uuid[])
returns uuid
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
  scope_city as (
    select s.city_id from schools s where s.id = p_school
  )
  select aa.user_id
  from chain c
  join approver_assignments aa on aa.node_id = c.id and aa.is_active and aa.role = p_role
    and (
      aa.school_id = p_school
      or (p_role = 'city_expert' and (
           (select city_id from scope_city) is null
           or exists (
             select 1
             from profiles p
             join schools s on s.id = p.school_id
             where p.user_id = aa.user_id
               and s.city_id = (select city_id from scope_city)
           )
         ))
    )
    and not (aa.user_id = any (array_remove(coalesce(p_exclude, '{}'::uuid[]), null)))
  order by c.depth asc
  limit 1;
$$;

-- =====================================================================
-- 2) 任命守卫：专家必须绑了学校（否则推导不出市，任命了也收不到题）
-- =====================================================================
-- 学校还要挂了市：schools.city_id 可空（0082 刻意留的），没挂市的学校同样推导不出市。
-- 与库里现状一致 —— 线上唯一在任的市级专家挂在盐亭职校（绵阳市）。
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
  if not exists (
    select 1 from profiles p
    join schools s on s.id = p.school_id
    where p.user_id = p_user_id and s.city_id is not null
  ) then
    raise exception '该教师未绑定学校（或学校未挂市），无法确定所属市；请先为其绑定学校（如「XX市教科所」也建成学校挂在市下）后再任命市级专家';
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

comment on table public.approver_assignments is
  '审核岗位：教研组长(学校+科目节点，一岗一人，覆盖后代) / 市级专家(科目节点，一节点多位=岗位池；管辖范围=本人 profile 所属学校的市，不在这张表上存市)';

-- create or replace 不改 ACL，但收口是一次性的、值得显式写出来（0006 的教训：默认权限会给新函数授 anon）
revoke execute on function public.effective_assignees(uuid, uuid, assignee_role, uuid[]) from public, anon;
revoke execute on function public.effective_assignee(uuid, uuid, assignee_role, uuid[]) from public, anon;
revoke execute on function public.assign_city_expert(uuid, uuid) from public, anon, service_role;
grant execute on function public.effective_assignees(uuid, uuid, assignee_role, uuid[]) to authenticated;
grant execute on function public.effective_assignee(uuid, uuid, assignee_role, uuid[]) to authenticated;
grant execute on function public.assign_city_expert(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
