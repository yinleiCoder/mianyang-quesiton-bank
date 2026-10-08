-- 0089: 科目树能"改挂点"（拖拽画布需要的写路径）。
--
-- 背景：科目树此前只能建 / 删 / 改名（admin_create_subject_node、admin_delete_node），
-- **没有搬移**。而 admin_delete_node 明确拒绝"有子节点/题目/任命"的节点，所以想给一个
-- 已有题目的知识点换个上级，此前只能新建一个再把题目一道道挪过去 —— 实际没人会那么干。
--
-- 画布（components/admin/tree-canvas.jsx）是拖拽入口，这条是它唯一的新写路径。
--
-- 守卫（**只在 SQL 里挡真正危险的**，剩下的交给界面引导）：
--   1) 仅系统管理员（与其它 admin_* 同）；
--   2) 新父节点必须存在、且与节点**同 scope**（跨 scope 会让"公共/专业"两棵树串在一起）；
--   3) **不许成环**：新父节点不能是它自己，也不能是它的后代（沿 parent 往上走一趟即可）；
--   4) 允许 p_new_parent_id 为 null（提到顶层）。
-- 刻意**不**在这里校验 kind 组合（admin_create_subject_node 也没校验 —— 层级规则在
-- lib/subject-nodes.js 的 childKinds 里，界面按它只让拖到合法的父节点上）。
-- 如果哪天有人在 SQL 里补 kind 校验，记得两端一起改，否则"界面不让拖、直接调 RPC 却能成"。

create or replace function public.admin_move_subject_node(
  p_node_id uuid,
  p_new_parent_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_node subject_nodes%rowtype;
  v_parent subject_nodes%rowtype;
  v_cursor uuid;
  v_depth int := 0;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可维护科目树';
  end if;

  select * into v_node from subject_nodes where id = p_node_id;
  if not found then raise exception '节点不存在'; end if;

  if p_new_parent_id is not null then
    if p_new_parent_id = p_node_id then
      raise exception '不能把节点挂到它自己下面';
    end if;
    select * into v_parent from subject_nodes where id = p_new_parent_id;
    if not found then raise exception '目标节点不存在'; end if;
    if v_parent.scope <> v_node.scope then
      raise exception '不能跨目录搬移（公共 / 专业是两棵树）';
    end if;

    -- 成环检查：从新父节点往上走，撞到被搬的节点就说明它是自己的后代会形成环。
    -- MAX_DEPTH 兜底（subject_nodes 理论上不会有环，但真出现了也不能让这个函数转死）。
    v_cursor := p_new_parent_id;
    while v_cursor is not null and v_depth < 32 loop
      if v_cursor = p_node_id then
        raise exception '不能把节点搬到它自己的后代下面（会成环）';
      end if;
      select parent_id into v_cursor from subject_nodes where id = v_cursor;
      v_depth := v_depth + 1;
    end loop;
  end if;

  update subject_nodes set parent_id = p_new_parent_id where id = p_node_id;
  perform public.audit('admin_move_node', null, null,
    jsonb_build_object('node_id', p_node_id, 'from_parent', v_node.parent_id,
                       'to_parent', p_new_parent_id, 'name', v_node.name));
end;
$$;

revoke execute on function public.admin_move_subject_node(uuid, uuid) from public, anon, service_role;
grant execute on function public.admin_move_subject_node(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
