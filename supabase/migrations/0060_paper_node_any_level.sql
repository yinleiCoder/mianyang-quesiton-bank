-- 0060: 试卷可以挂在「专业大类 / 专业」层，题目仍然只能挂课程与公共学科。
--
-- 现象（线上）：新建试卷的科目下拉只列公共学科与课程（口径照抄了 can_attach_question），
-- 于是"计算机类模拟卷"这种按专业大类组织的卷子根本建不出来；服务端 create_paper_draft
-- 也借 check_can_author 走同一条"节点可挂题"断言，就算前端放开也会被拒。
--
-- 产品口径（2026-09-17 用户）：题挂在末端的课程/公共学科上，**卷子可以挂在专业大类**，
-- 卷内含其下各课程的题。组卷库的按科目筛选（list_papers）本来就是子树口径
-- （`p.course_node_id in (select id from subtree)`），所以只要放开建卷这一处，
-- 专业大类卷子自然汇总到它下面各课程的题，筛选也按子树命中。
--
-- 修法：新增 check_can_author_paper()——is_teacher / 学校绑定 / 节点存在且未冻结照旧，
-- 只把"节点可挂题"换成"节点可用于组卷"（任意 kind 都行）；create_paper_draft 改用它。
-- **check_can_author 一个字不动**：出题与 AI 导入仍然只能落在公共学科/课程上
--（导入任务还会在同一个节点上生成草稿题，所以那边的节点规则不能一起放开）。

create or replace function public.check_can_author_paper(p_course_node uuid)
returns uuid  -- 返回作者的 school_id（与 check_can_author 同约定）
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_school uuid;
  v_frozen boolean;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select school_id into v_school from profiles where user_id = v_uid;
  if v_school is null then
    raise exception '你的账号未绑定学校，无法组卷';
  end if;
  select is_frozen into v_frozen from subject_nodes where id = p_course_node;
  if not found then
    raise exception '科目节点不存在';
  end if;
  if v_frozen then
    raise exception '该科目节点已冻结，暂不能建卷';
  end if;
  return v_school;
end;
$$;

-- 内部助手（与 check_can_author 同档）：只由 definer 函数调用，不对客户端开放
revoke execute on function public.check_can_author_paper(uuid) from public, anon, authenticated;

-- 建卷（其余与 0045 版逐字一致，只换节点校验那一行）
create or replace function public.create_paper_draft(p_course_node uuid, p_meta jsonb default '{}'::jsonb)
returns uuid  -- 返回 paper_versions.id
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_school uuid;
  v_paper uuid;
  v_version uuid;
begin
  -- 与出题不同：试卷可挂在专业大类/专业层（汇总其下课程的题），见文件头注
  v_school := public.check_can_author_paper(p_course_node);

  insert into papers (school_id, creator_id, course_node_id)
  values (v_school, v_uid, p_course_node)
  returning id into v_paper;

  insert into paper_versions
    (paper_id, version_no, change_type, status, title, exam_name, subject_label,
     duration_minutes, target_score, header, instructions, created_by)
  values
    (v_paper, 1, 'create', 'draft',
     coalesce(nullif(trim(p_meta ->> 'title'), ''), '未命名试卷'),
     nullif(trim(p_meta ->> 'exam_name'), ''),
     nullif(trim(p_meta ->> 'subject_label'), ''),
     coalesce(nullif(p_meta ->> 'duration_minutes', '')::int, 90),
     nullif(p_meta ->> 'target_score', '')::numeric,
     coalesce(p_meta -> 'header', '{}'::jsonb),
     coalesce(p_meta -> 'instructions', '[]'::jsonb),
     v_uid)
  returning id into v_version;

  perform public.paper_audit('create_paper_draft', v_paper, v_version,
    jsonb_build_object('course_node', p_course_node));
  return v_version;
end;
$$;

notify pgrst, 'reload schema';
