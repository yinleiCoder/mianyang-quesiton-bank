-- 0059: 学生账号不得被任命为审核岗位 —— 三个任命 RPC 前置身份断言。
--
-- 现象（线上）：用户管理页对学生账号照样列出「任命学校管理员 / 任命教研组长 / 任命市级专家」。
-- 学生账号**全部绑定了学校**（线上 40 个学生的 school_id 都非空），所以这几条路真能走通：
-- 把学生任命成市级专家之后，他会出现在审批收件箱里，可以审题入库。
--
-- 产品口径（2026-09-17 用户）：审核岗位面向教师，学生只该被「查看资料」。
--
-- 两个层面一起收口，只改 UI 挡不住直接调 RPC：
--   1) DB（本迁移）：assign_group_leader / assign_city_expert / admin_assign_school_admin 各加一条
--      `identity = 'student'` 断言；学生经「教师身份审核」（review_teacher_identity，0025）转成
--      教师后照常可任命。
--   2) UI：components/admin/users-manager.jsx 对学生隐藏三项任命、操作列改为「查看资料」弹窗。
--
-- 注：teacher_pending（教师·待审核）**不在**拦截范围内 —— 那是"还没审"，不是"不是老师"。
-- 线上现有 4 条任命全是 teacher，无需清理数据。

-- 教研组长任命（其余与 0008 版逐字一致；unique_violation 文案顺带覆盖 0058 新加的重复在任索引）
create or replace function public.assign_group_leader(p_user_id uuid, p_node_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_target_school uuid;
  v_target_identity text;
  v_role assignee_role := 'group_leader';
  v_id uuid;
begin
  select school_id, identity into v_target_school, v_target_identity
  from profiles where user_id = p_user_id;
  if v_target_school is null then
    raise exception '目标用户未绑定学校';
  end if;
  if v_target_identity = 'student' then
    raise exception '该账号是学生，不能任命为教研组长';
  end if;
  if not public.is_school_admin(v_target_school) then
    raise exception '仅该校学校管理员可任命教研组长';
  end if;
  if not exists (select 1 from subject_nodes where id = p_node_id) then
    raise exception '科目节点不存在';
  end if;
  begin
    insert into approver_assignments (user_id, role, school_id, node_id, created_by)
    values (p_user_id, v_role, v_target_school, p_node_id, v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception '该岗位已有人在任（或该教师已在本节点在任）；如需换人请先停用现有任命';
  end;
  perform public.audit('assign_group_leader', null, null,
    jsonb_build_object('user_id', p_user_id, 'school_id', v_target_school, 'node_id', p_node_id));
  return v_id;
end;
$$;

-- 市级专家任命（其余与 0058 版逐字一致）
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
  if exists (select 1 from profiles where user_id = p_user_id and identity = 'student') then
    raise exception '该账号是学生，不能任命为市级专家';
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

-- 学校管理员任命（其余与 0004 版逐字一致）
create or replace function public.admin_assign_school_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可任命学校管理员';
  end if;
  if not exists (select 1 from profiles where user_id = p_user_id) then
    raise exception '目标用户不存在';
  end if;
  if exists (select 1 from profiles where user_id = p_user_id and identity = 'student') then
    raise exception '该账号是学生，不能任命为学校管理员';
  end if;
  if exists (select 1 from profiles where user_id = p_user_id and school_id is null) then
    raise exception '目标用户未绑定学校，无法任命为学校管理员';
  end if;
  begin
    insert into user_roles (user_id, role, created_by) values (p_user_id, 'school_admin', v_uid);
  exception when unique_violation then
    raise exception '该用户已是学校管理员';
  end;
  perform public.audit('admin_assign_school_admin', null, null,
    jsonb_build_object('user_id', p_user_id));
end;
$$;

notify pgrst, 'reload schema';
