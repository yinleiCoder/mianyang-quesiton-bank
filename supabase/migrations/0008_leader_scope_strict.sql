-- 收紧教研组长任命/停用权限：仅限该校学校管理员
-- 分工约定（RBAC）：系统管理员只任命学校管理员与市级专家；教研组长由各校学校管理员任命。
-- UI 已按此隐藏系统管理员入口（M2 验收反馈），此处收口 DB 层（原实现 is_admin() 放行系统管理员）。

create or replace function public.assign_group_leader(p_user_id uuid, p_node_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_target_school uuid;
  v_role assignee_role := 'group_leader';
  v_id uuid;
begin
  select school_id into v_target_school from profiles where user_id = p_user_id;
  if v_target_school is null then
    raise exception '目标用户未绑定学校';
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
    raise exception '该岗位已有人在任；如需换人请先停用现有任命';
  end;
  perform public.audit('assign_group_leader', null, null,
    jsonb_build_object('user_id', p_user_id, 'school_id', v_target_school, 'node_id', p_node_id));
  return v_id;
end;
$$;

create or replace function public.revoke_approver(p_assignment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_row approver_assignments%rowtype;
begin
  select * into v_row from approver_assignments where id = p_assignment_id;
  if not found then
    raise exception '任命不存在';
  end if;
  if v_row.role = 'city_expert' then
    if not public.is_admin() then
      raise exception '仅系统管理员可停用市级专家任命';
    end if;
  else
    if not public.is_school_admin(v_row.school_id) then
      raise exception '仅该校学校管理员可停用教研组长任命';
    end if;
  end if;
  update approver_assignments set is_active = false where id = p_assignment_id;
  perform public.audit('revoke_approver', null, null,
    jsonb_build_object('assignment_id', p_assignment_id));
end;
$$;
