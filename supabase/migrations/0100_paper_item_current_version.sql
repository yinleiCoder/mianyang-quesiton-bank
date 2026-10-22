-- 0100: 组卷库——题项被"新版本替换"后应视为可刷新，而不是"未入库/失效"
--
-- 症状（2026-10-21 用户报）：老师正在组卷，卷面里某道题的作者随后发布了新版本。
-- 旧版变成 superseded，而 paper_version_json 的 available 只认 published，
-- 于是该题变成 available=false：
--   · 编辑器把它算进"这 N 道题还没入库"，并把「刷新题目」按钮禁用；
--   · 详情页横幅写"还没入库或版本已失效"；
--   · 组卷老师看到题"失效"，却没有任何能修的动作。
--
-- 口径：**题还活着、题库有当前入库版**，这一项就是可修复的——刷新把它钉到
-- current_published_version_id 即可。它属于 stale（题库有新版本），不属于
-- unavailable（未入库/已下线）。真正不可修复的仍然只有：
--   · 题已下线（q.state <> 'live'）；
--   · 题没有入库版本（AI 草稿 / 在审 / 被退回 / 已撤回的版本）。
--
-- 三处判据一起改，避免"界面说能刷、服务端说不能"：
--   · paper_version_json.available
--   · paper_health.problem（superseded → stale）
--   · submit_paper 的硬校验：superseded 放行到后面的"已更新到新版本"提示

create or replace function public.paper_version_json(p_version_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_sections jsonb;
  v_items jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', sec.id, 'sort_order', sec.sort_order,
           'seq_label', public.cn_numeral(sec.sort_order),
           'title', sec.title, 'instruction', sec.instruction,
           'score_mode', sec.score_mode, 'score_each', sec.score_each,
           'item_count', coalesce(it.cnt, 0), 'section_score', coalesce(it.total_score, 0),
           'items', coalesce(it.items, '[]'::jsonb)
         ) order by sec.sort_order), '[]'::jsonb)
    into v_sections
    from paper_sections sec
    left join lateral (
      select count(*) as cnt, sum(i.score) as total_score,
             jsonb_agg(jsonb_build_object(
               'id', i.id, 'seq', i.seq,
               'question_id', i.question_id, 'question_version_id', i.question_version_id,
               'qtype', i.qtype, 'difficulty', i.difficulty,
               'score', i.score, 'score_units', i.score_units,
               'origin', i.origin, 'note', i.note,
               'stale', (q.current_published_version_id is distinct from i.question_version_id),
               -- 定版指针指向旧版（superseded）但题库已有当前入库版：刷新就能修，
               -- 所以 available 仍为 true，由 stale 提示"题库有新版本"。
               -- 没有入库版（草稿/在审/退回/撤回）或题已下线，才是真的不可用。
               'available', (q.state = 'live'
                             and q.current_published_version_id is not null
                             and qv.status in ('published', 'superseded')),
               'content', qv.content
             ) order by i.seq) as items
      from paper_items i
      join question_versions qv on qv.id = i.question_version_id
      join questions q on q.id = i.question_id
      where i.section_id = sec.id
    ) it on true
    where sec.paper_version_id = p_version_id;

  -- 扁平副本：阅卷与考试按题号索引时不必自己拍平 sections
  select coalesce(jsonb_agg(elem order by ord), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(v_sections) sec,
         lateral jsonb_array_elements(sec -> 'items') with ordinality as t(elem, ord);

  select jsonb_build_object(
      'version_id', v2.id, 'paper_id', v2.paper_id, 'version_no', v2.version_no,
      'status', v2.status, 'change_type', v2.change_type, 'base_version_id', v2.base_version_id,
      'exam_name', v2.exam_name, 'subject_label', v2.subject_label, 'title', v2.title,
      'duration_minutes', v2.duration_minutes,
      'total_score', v2.total_score, 'target_score', v2.target_score,
      'header', v2.header, 'instructions', v2.instructions,
      'created_by', v2.created_by, 'submitted_at', v2.submitted_at, 'published_at', v2.published_at,
      'created_at', v2.created_at,
      -- 乐观锁用**整数微秒**而不是时间戳字符串：JS 的 Date 只有毫秒精度，
      -- 客户端一旦把它 parse 成 Date 再回传就会丢精度，比对永远失败。
      'updated_us', (extract(epoch from v2.updated_at) * 1000000)::bigint,
      'school_id', p.school_id, 'course_node_id', p.course_node_id, 'paper_state', p.state,
      'sections', v_sections, 'items', v_items)
    into v
    from paper_versions v2 join papers p on p.id = v2.paper_id
    where v2.id = p_version_id;
  return v;
end;
$$;

-- 卷面健康检查：哪几道题在题库里出了问题（改版/下线/版本丢失）
-- superseded 只保留给"指针指向的不是入库版"（草稿/在审/退回/撤回）；
-- 被新版本替换（qv.status='superseded'）属于"题库有新版本"，归 stale。
create or replace function public.paper_health(p_version_id uuid)
returns table(item_id uuid, seq int, question_id uuid, problem text)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, i.seq, i.question_id,
         case
           when q.id is null then 'missing'
           when q.state <> 'live' then 'offline'
           when qv.id is null or qv.status not in ('published', 'superseded') then 'superseded'
           else 'stale'
         end
  from paper_items i
  left join questions q on q.id = i.question_id
  left join question_versions qv on qv.id = i.question_version_id
  where i.paper_version_id = p_version_id
    -- definer 函数自己把可见性补上（这里只暴露"题目是否已下线/改版"，但仍不该跨卷窥探）
    and public.can_read_paper_version(p_version_id)
    and not (q.state = 'live' and qv.status = 'published'
             and q.current_published_version_id = i.question_version_id)
  order by i.seq;
$$;

-- 提交（与线上 0058 版逐字一致，只改 v_bad 那一处判据）。
-- 被新版本替换的题先放行，让下面 v_stale 报出真正的下一步（点「刷新题目」）；
-- 否则老师看到的是"尚未入库或已下线"，而它其实有入库版本、只是指针旧了。
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

  select array_agg(i.seq::text order by i.seq) into v_bad
  from paper_items i
  join questions q on q.id = i.question_id
  join question_versions qv on qv.id = i.question_version_id
  where i.paper_version_id = p_version_id
    and not (q.state = 'live' and (
      qv.status = 'published'
      or (qv.status = 'superseded' and q.current_published_version_id is not null)
    ));
  if v_bad is not null then
    raise exception '第 % 题尚未入库或已下线，请先在题库完成入库后再提交', array_to_string(v_bad, '、');
  end if;

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

notify pgrst, 'reload schema';
