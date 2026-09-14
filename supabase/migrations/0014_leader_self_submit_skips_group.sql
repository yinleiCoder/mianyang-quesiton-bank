-- 0014: 组长兼任教师 —— 作者本人就是组长环节唯一候选时，提交直送市级专家。
-- 背景：原实现遇到"组长环节唯一候选 = 作者本人"直接拦截（提示联系转派），
-- 但中职课程常只有一位教师且兼组长，自审不可行、转派徒增人工。产品确认改为：
-- 提交时若沿祖先找不到"作者之外"的组长任命，但作者本人恰是该节点（沿祖先）的组长
-- （兼任），则跳过组长环节，与"组长通过后"的同一逻辑流转市级专家：
--   版本直置 pending_city + 创建 city 环节任务（排除作者本人；无可用专家则待指派）。
-- 其余路径不变：有可用组长 → 组长环节；确实未配置任何组长 → 仍拦截提示任命。

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
  v_leader uuid;
  v_expert uuid;
  v_skip_group boolean := false;
  v_frozen boolean;
begin
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
  v_leader := public.effective_assignee(v_school, v_node, 'group_leader', array[v_uid]);
  if v_leader is null then
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

    -- 与 review_decide 组长通过后的流转一致：专家沿祖先最深生效、排除作者本人；
    -- 无可用专家（未任命/唯一专家即本人）→ assigned_user_id NULL，管理员待指派。
    v_expert := public.effective_assignee(v_school, v_node, 'city_expert', array[v_uid]);
    begin
      insert into approvals (kind, version_id, question_id, stage, assigned_user_id)
      values ('content', p_version_id, v_qid, 'city', v_expert);
    exception when unique_violation then
      raise exception '该版本已在审核中，请刷新页面查看';
    end;
    perform public.audit('submit_version', v_qid, p_version_id,
      jsonb_build_object('skip_group', 'self_group_leader', 'city_expert', v_expert));
    return;
  end if;

  begin
    update question_versions
    set status = 'pending_group', submitted_at = now()
    where id = p_version_id;

    insert into approvals (kind, version_id, question_id, stage, assigned_user_id)
    values ('content', p_version_id, v_qid, 'group', v_leader);
  exception when unique_violation then
    raise exception '该版本已在审核中，请刷新页面查看';
  end;

  perform public.audit('submit_version', v_qid, p_version_id,
    jsonb_build_object('group_leader', v_leader));
end;
$$;
