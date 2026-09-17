-- 0057: 市级专家环节不再让「作者本人就是该学科专家」的题悬空 —— 统一走 route_city_expert 解析。
--
-- 背景（2026-09-17 线上实测）：一位教师同时是本学科全市唯一的市级专家。他出的题走
-- 「提交 → 教研组长通过 → 市级专家」时，review_decide 解析专家排除了 [组长本人, 作者本人]，
-- 排除后一个候选都不剩 → 任务以 assigned_user_id = NULL 落库：不进任何人的待办、不报错、
-- 作者在「我的题目」里永远停在"专家审核中"。当天线上就这样卡了 52 道题。
-- 与 0042 记录的是同一类故障（任务悬空），区别只在成因：那边是任命缺失，这边是排除项把候选清空了。
--
-- 产品口径（2026-09-17 用户确认）：某学科的市级专家通常不止一位，**优先给别的专家**；
-- 但只剩他一个时必须**正常流转给他**——宁可作者自审，也不能让题悬空。
--
-- 修法：新增 route_city_expert() 两级解析
--   1) 常规：effective_assignee 排除 [本次决策人, 作者] —— 与旧行为逐字一致，有别的专家时完全不变；
--   2) 兜底：常规为空时取**不排除任何人**的最深生效专家（通常是作者本人；若组长本人恰是唯一
--      专家，则落到组长——同一人连做两级，也比题永久悬空强）。
-- 调用点全部改为它：review_decide / submit_question（组长兼任直通）/ review_decide_paper /
-- submit_paper，以及两个 backfill（悬空修补，只在 assigned_user_id is null 的行上跑）。
-- 组长环节的解析**不动**（仍排除作者）：作者兼组长时 0014 已在提交阶段跳过该环节。
--
-- 顺带修掉 effective_assignee 的 NULL 排除项坑：作者注销后 question_versions.created_by 为 NULL
-- （0021 起），array[..., NULL] 会让 `= any(...)` 求值成 NULL，在 not(...) 下把所有候选都误判为
-- "被排除" → 专家永远指派不上。0046 已在试卷链路用 array_remove 绕开，这里收口到题目链路。

create or replace function public.route_city_expert(
  p_school uuid, p_node uuid, p_author uuid, p_decider uuid default null)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.effective_assignee(p_school, p_node, 'city_expert',
      array_remove(array[p_decider, p_author], null)),
    public.effective_assignee(p_school, p_node, 'city_expert')
  );
$$;

-- 只读解析助手，与 effective_assignee 同档。Supabase 默认给新函数授 EXECUTE，`revoke from public`
-- 拦不住 anon，必须点名（0026 的教训）。
revoke execute on function public.route_city_expert(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.route_city_expert(uuid, uuid, uuid, uuid) to authenticated;

-- =====================================================================
-- 1) 题目 · 组长通过 → 市级专家（唯一改动是专家解析那一行）
--    其余与 0012 版逐字一致（幂等通过 + 旧版本替换 + 指针切换 + 审计）
-- =====================================================================
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
  v_expert uuid;
begin
  select * into v_approval from approvals where id = p_approval_id;
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
    -- 流转专家：优先给「非组长、非作者」的专家；一个都不剩时回归作者本人（0057 route_city_expert）
    v_expert := public.route_city_expert(v_q.school_id, v_q.course_node_id, v_version.created_by, v_uid);
    insert into approvals (kind, version_id, question_id, stage, assigned_user_id)
    values ('content', v_version.id, v_q.id, 'city', v_expert);
    perform public.audit('approve_group', v_q.id, v_version.id,
      jsonb_build_object('city_expert', v_expert, 'comment', p_comment));
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

-- =====================================================================
-- 2) 题目 · 提交（组长兼任直通市级专家时也要用同一条解析）
--    其余与 0026 版逐字一致
-- =====================================================================
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

    -- 与 review_decide 组长通过后的流转一致：优先给非作者的专家；
    -- 只剩作者本人时正常流转给他（0057 route_city_expert），确实没任命才留空待指派。
    v_expert := public.route_city_expert(v_school, v_node, v_uid);
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

-- =====================================================================
-- 3) 试卷 · 组长通过 → 市级专家（与 review_decide 的改动同源）
--    其余与 0046 版逐字一致
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
    -- 流转专家：优先给「非组长、非作者」的专家；一个都不剩时回归作者本人（0057 route_city_expert）
    v_expert := public.route_city_expert(v_paper.school_id, v_paper.course_node_id, v_version.created_by, v_uid);
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
-- 4) 试卷 · 提交（组长兼任直通市级专家）
--    其余与 0045 版逐字一致
-- =====================================================================
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
  v_leader uuid;
  v_expert uuid;
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
  v_leader := public.effective_assignee(v_school, v_node, 'group_leader', array[v_uid]);
  if v_leader is null then
    if public.effective_assignee(v_school, v_node, 'group_leader') is not null then
      v_skip_group := true;
    else
      raise exception '该校该课程暂未配置教研组长，请联系学校管理员任命后提交';
    end if;
  end if;

  if v_skip_group then
    update paper_versions set status = 'pending_city', submitted_at = now() where id = p_version_id;
    -- 同 review_decide_paper：优先给非作者的专家，只剩作者本人时正常流转给他（0057）
    v_expert := public.route_city_expert(v_school, v_node, v_uid);
    begin
      insert into paper_approvals (kind, paper_version_id, paper_id, stage, assigned_user_id)
      values ('paper', p_version_id, v_ver.paper_id, 'city', v_expert);
    exception when unique_violation then
      raise exception '该试卷已在审核中，请刷新页面查看';
    end;
    perform public.paper_audit('submit_paper', v_ver.paper_id, p_version_id,
      jsonb_build_object('skip_group', 'self_group_leader', 'city_expert', v_expert, 'items', v_items));
    return;
  end if;

  begin
    update paper_versions set status = 'pending_group', submitted_at = now() where id = p_version_id;
    insert into paper_approvals (kind, paper_version_id, paper_id, stage, assigned_user_id)
    values ('paper', p_version_id, v_ver.paper_id, 'group', v_leader);
  exception when unique_violation then
    raise exception '该试卷已在审核中，请刷新页面查看';
  end;

  perform public.paper_audit('submit_paper', v_ver.paper_id, p_version_id,
    jsonb_build_object('group_leader', v_leader, 'items', v_items));
end;
$$;

-- =====================================================================
-- 5) 悬空任务的兜底修补：任命变动时重新解析（0042 / 0046 的两份，口径保持一致）
--    改动同样只在市级那一支；组长环节照旧排除作者（0014 已在提交阶段跳过该环节）
-- =====================================================================
create or replace function public.backfill_waiting_assignees()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixed int := 0;
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
    select case when r.stage = 'group'
                -- 排除作者本人：与 submit_question / transfer_approval 同一条规矩
                then public.effective_assignee(r.school_id, r.course_node_id, 'group_leader',
                       array_remove(array[r.creator_id], null))
                -- 市级环节：排除作者后无人可用时回归作者本人（0057）
                else public.route_city_expert(r.school_id, r.course_node_id, r.creator_id)
           end
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

create or replace function public.backfill_waiting_paper_assignees()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixed int := 0;
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
    select case when r.stage = 'group'
                then public.effective_assignee(r.school_id, r.course_node_id, 'group_leader',
                       array_remove(array[r.creator_id], null))
                else public.route_city_expert(r.school_id, r.course_node_id, r.creator_id)
           end
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

-- 一次性补救：把本次修复之前就悬空的市级任务补上处理人（线上 52 道题，全部回到作者本人的待办）
select public.backfill_waiting_assignees();
select public.backfill_waiting_paper_assignees();
