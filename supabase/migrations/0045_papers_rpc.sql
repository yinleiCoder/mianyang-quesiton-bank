-- 0045: 试卷读写 RPC（组卷 / 提交 / 撤回 / 改版 / 组卷库 / 健康检查）
--
-- 取舍沿用 0028-0031 的练习模块：读路径**一次返回 jsonb 整卷快照**，客户端不再二次查库。
-- 为什么非要走 RPC 而不让客户端直接查表：题项引用的是**定版指针**，题目改版/下线后
-- 那一版在 RLS 下不可见（question_versions 策略只放行"当前入库版本"），
-- 而"考过的卷子不会变"要求这些内容照常渲染——只有 definer 函数能读到它们。
--
-- 唯一写入口是 save_paper_draft（整卷 PUT）。逐条增删会产生 N 次往返 + N 次合计重算，
-- 中途失败还会留下半截卷（一道题既不在 A 大题也不在 B 大题）。

-- =====================================================================
-- 助手
-- =====================================================================

-- 大题序号的中文写法（一、二、…二十一）。放服务端算，避免前后端各写一套中文数字。
create or replace function public.cn_numeral(p_n int)
returns text
language sql
immutable
as $$
  select case
    when p_n between 1 and 10 then
      (array['一','二','三','四','五','六','七','八','九','十'])[p_n]
    when p_n between 11 and 19 then
      '十' || (array['一','二','三','四','五','六','七','八','九'])[p_n - 10]
    when p_n between 20 and 99 then
      (array['二','三','四','五','六','七','八','九'])[p_n / 10 - 1] || '十'
      || case when p_n % 10 = 0 then ''
              else (array['一','二','三','四','五','六','七','八','九'])[p_n % 10] end
    else p_n::text
  end;
$$;

-- 整卷快照。打印 / 组卷库详情 / 审批详情 / 阅卷 / 考试五处共用同一个结构。
-- 内部助手：definer 视角能读到定版指针指向的任何版本（含已被替换/题目已下线的内容），
-- 因此**必须先做可见性断言**，只由 get_paper_version 对外暴露。
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
               'available', (qv.status = 'published' and q.state = 'live'),
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

-- 对外读入口（先断言可见性）
create or replace function public.get_paper_version(p_version_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  -- 允许匿名判断之外的路径：作者/管理员/本校管理员/审批参与人/已发布
  if not public.can_read_paper_version(p_version_id) then
    raise exception '无权查看这份试卷' using errcode = '42501';
  end if;
  return public.paper_version_json(p_version_id);
end;
$$;

-- =====================================================================
-- 组卷（教师侧）
-- =====================================================================

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
  -- check_can_author 已内含 is_teacher / 学校绑定 / 节点可挂题 / 节点未冻结，并返回 school_id 供快照
  v_school := public.check_can_author(p_course_node);

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

-- 整卷保存（编辑器唯一写入口）。delete-then-insert 重建卷面，全程一个事务。
create or replace function public.save_paper_draft(
  p_version_id uuid,
  p_meta jsonb,
  p_sections jsonb,
  p_expected_us bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver paper_versions%rowtype;
  v_cur_us bigint;
  v_sec jsonb;
  v_item jsonb;
  v_sort int := 0;
  v_seq int := 0;
  v_sec_id uuid;
  v_mode text;
  v_each numeric;
  v_qv record;
  v_units numeric[];
  v_custom jsonb;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select * into v_ver from paper_versions where id = p_version_id;
  if not found then
    raise exception '试卷不存在';
  end if;
  if v_ver.created_by is distinct from v_uid then
    raise exception '只能编辑自己的试卷';
  end if;
  if v_ver.status not in ('draft', 'returned') then
    raise exception '只能编辑草稿或被退回的试卷';
  end if;

  -- 乐观锁：整卷 PUT 是 delete-then-insert，两个标签页同时编辑会静默互相覆盖
  v_cur_us := (extract(epoch from v_ver.updated_at) * 1000000)::bigint;
  if p_expected_us is not null and p_expected_us <> v_cur_us then
    raise exception '这份草稿在别处被修改过，请刷新页面后重试' using errcode = '40001';
  end if;

  if p_meta is null then p_meta := '{}'::jsonb; end if;
  if p_sections is null then p_sections := '[]'::jsonb; end if;
  if jsonb_typeof(p_sections) <> 'array' then
    raise exception '卷面结构格式错误';
  end if;

  -- 先重建卷面（触发器会跟着重算 total_score），再写卷头
  delete from paper_items where paper_version_id = p_version_id;
  delete from paper_sections where paper_version_id = p_version_id;

  for v_sec in select * from jsonb_array_elements(p_sections) loop
    v_sort := v_sort + 1;
    v_mode := coalesce(nullif(v_sec ->> 'score_mode', ''), 'per_item');
    if v_mode not in ('per_item', 'per_blank', 'per_sub') then
      raise exception '第 % 大题的计分口径不合法', v_sort;
    end if;
    v_each := coalesce(nullif(v_sec ->> 'score_each', '')::numeric, 0);
    if v_each < 0 or v_each > 100 then
      raise exception '第 % 大题的每小题分值必须在 0~100 之间', v_sort;
    end if;

    insert into paper_sections
      (paper_version_id, sort_order, title, instruction, score_mode, score_each)
    values
      (p_version_id, v_sort,
       coalesce(nullif(trim(v_sec ->> 'title'), ''), '第' || public.cn_numeral(v_sort) || '大题'),
       nullif(trim(v_sec ->> 'instruction'), ''), v_mode, v_each)
    returning id into v_sec_id;

    for v_item in select * from jsonb_array_elements(coalesce(v_sec -> 'items', '[]'::jsonb)) loop
      v_seq := v_seq + 1;
      -- 循环体要单独包一层 BEGIN：PL/pgSQL 的 FOR 不是块，EXCEPTION 只能挂在块上
      begin
        select qv.id as version_id, qv.question_id, qv.qtype, qv.difficulty, qv.content,
               qv.status, qv.created_by, q.state, q.current_published_version_id
          into v_qv
          from question_versions qv
          join questions q on q.id = qv.question_id
          where qv.id = nullif(v_item ->> 'question_version_id', '')::uuid;
        if not found then
          raise exception '第 % 题引用的题库版本不存在', v_seq;
        end if;
        if v_item ->> 'question_id' is not null
           and (v_item ->> 'question_id')::uuid <> v_qv.question_id then
          raise exception '第 % 题的题目与版本不匹配', v_seq;
        end if;

        -- 只允许引用两种来源：已入库且在线的题，或自己名下尚未入库的题（AI 一键成卷的产物）。
        -- 后者是为了让"刚解析完就能看到整卷雏形"，但它进不了发布（submit_paper 会拦住），
        -- 所以不会把别人没入库的内容泄露出去。
        if not (v_qv.status = 'published' and v_qv.state = 'live')
           and v_qv.created_by is distinct from v_uid then
          raise exception '第 % 题引用的题库版本不可用（未入库或已下线）', v_seq;
        end if;

        v_custom := case when v_item ? 'custom_units' and jsonb_typeof(v_item -> 'custom_units') = 'array'
                         then v_item -> 'custom_units' else null end;
        if v_custom is not null and jsonb_array_length(v_custom) > 0 then
          -- 先过一遍求和函数：它会对非数值项给出可读的中文原因，比后面 array_agg 的
          -- 类型转换报错清楚得多
          perform public.jsonb_numeric_sum(v_custom);
        end if;
        v_units := public.paper_item_units(v_qv.qtype, v_qv.content, v_mode, v_each, v_custom);

        insert into paper_items
          (paper_version_id, section_id, seq, question_id, question_version_id,
           qtype, difficulty, score, score_units, origin, note)
        values
          (p_version_id, v_sec_id, v_seq, v_qv.question_id, v_qv.version_id,
           v_qv.qtype, v_qv.difficulty,
           (select coalesce(sum(u), 0) from unnest(v_units) u),
           to_jsonb(v_units),
           coalesce(nullif(v_item ->> 'origin', ''), 'bank'),
           nullif(trim(v_item ->> 'note'), ''));
      exception when unique_violation then
        raise exception '第 % 题与卷内已有题目重复（同一份试卷不能用两道相同的题）', v_seq;
      end;
    end loop;
  end loop;

  update paper_versions set
    title = coalesce(nullif(trim(p_meta ->> 'title'), ''), title),
    exam_name = nullif(trim(coalesce(p_meta ->> 'exam_name', '')), ''),
    subject_label = nullif(trim(coalesce(p_meta ->> 'subject_label', '')), ''),
    duration_minutes = coalesce(nullif(p_meta ->> 'duration_minutes', '')::int, duration_minutes),
    target_score = case when p_meta ? 'target_score'
                        then nullif(p_meta ->> 'target_score', '')::numeric
                        else target_score end,
    header = coalesce(p_meta -> 'header', header),
    instructions = coalesce(p_meta -> 'instructions', instructions)
  where id = p_version_id;

  perform public.paper_audit('save_paper_draft', v_ver.paper_id, p_version_id,
    jsonb_build_object('sections', jsonb_array_length(p_sections), 'items', v_seq));

  -- 就地回传，客户端不必重查整卷（口径同 0038 的 import_save_page）
  return jsonb_build_object(
    'version_id', p_version_id,
    'total_score', (select total_score from paper_versions where id = p_version_id),
    'target_score', (select target_score from paper_versions where id = p_version_id),
    'item_count', v_seq,
    'section_count', v_sort,
    'updated_us', (select (extract(epoch from updated_at) * 1000000)::bigint from paper_versions where id = p_version_id),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'seq', i.seq, 'section_id', i.section_id,
               'score', i.score, 'score_units', i.score_units,
               'stale', (q.current_published_version_id is distinct from i.question_version_id),
               'available', (qv.status = 'published' and q.state = 'live'))
             order by i.seq)
      from paper_items i
      join question_versions qv on qv.id = i.question_version_id
      join questions q on q.id = i.question_id
      where i.paper_version_id = p_version_id), '[]'::jsonb));
end;
$$;

-- 重新把题项钉到题库当前入库版本（题目改版后提交被拦，教师点一下修复）
create or replace function public.paper_refresh_items(p_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver paper_versions%rowtype;
  v_rec record;
  v_units numeric[];
  v_fixed int := 0;
  v_bad text[] := '{}';
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select * into v_ver from paper_versions where id = p_version_id;
  if not found or v_ver.created_by is distinct from v_uid then
    raise exception '只能编辑自己的试卷';
  end if;
  if v_ver.status not in ('draft', 'returned') then
    raise exception '只能编辑草稿或被退回的试卷';
  end if;

  -- 先分清"修不了"和"能修"：已下线/未入库的题没有可换的目标版本，只能请教师从卷面移除
  select array_agg(i.seq::text order by i.seq) into v_bad
  from paper_items i
  join questions q on q.id = i.question_id
  where i.paper_version_id = p_version_id
    and (q.state <> 'live' or q.current_published_version_id is null);
  if v_bad is not null then
    raise exception '第 % 题在题库中已下线或尚未入库，无法刷新，请先从卷面移除',
      array_to_string(v_bad, '、');
  end if;

  for v_rec in
    select i.id, sec.score_mode, sec.score_each, q.current_published_version_id as new_qv
    from paper_items i
    join paper_sections sec on sec.id = i.section_id
    join questions q on q.id = i.question_id
    where i.paper_version_id = p_version_id
      and q.current_published_version_id <> i.question_version_id
    order by i.seq
  loop
    select content, qtype, difficulty into v_content, v_qtype, v_difficulty
    from question_versions where id = v_rec.new_qv;
    -- 换版会让空位/子题个数变化，因此分值明细必须按新内容重算（不能沿用旧的）
    v_units := public.paper_item_units(v_qtype, v_content, v_rec.score_mode, v_rec.score_each, null);
    update paper_items
    set question_version_id = v_rec.new_qv, qtype = v_qtype, difficulty = v_difficulty,
        score = (select coalesce(sum(u), 0) from unnest(v_units) u),
        score_units = to_jsonb(v_units)
    where id = v_rec.id;
    v_fixed := v_fixed + 1;
  end loop;

  perform public.paper_audit('refresh_paper_items', v_ver.paper_id, p_version_id,
    jsonb_build_object('fixed', v_fixed));
  return jsonb_build_object('fixed', v_fixed);
end;
$$;

-- 提交（草稿或退回后重提 → 全链重启从组长环节重新审；作者兼任组长时直送市级专家，逻辑同 0014/0026）
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
    v_expert := public.effective_assignee(v_school, v_node, 'city_expert', array[v_uid]);
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

create or replace function public.retract_paper(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver paper_versions%rowtype;
begin
  select * into v_ver from paper_versions where id = p_version_id;
  if not found then
    raise exception '试卷不存在';
  end if;
  if v_ver.created_by is distinct from v_uid then
    raise exception '只能撤回自己提交的试卷';
  end if;
  if v_ver.status not in ('pending_group', 'pending_city') then
    raise exception '只有审核中的试卷可以撤回';
  end if;
  update paper_versions set status = 'retracted' where id = p_version_id;
  update paper_approvals set state = 'cancelled'
  where paper_version_id = p_version_id and state = 'waiting';
  perform public.paper_audit('retract_paper', v_ver.paper_id, p_version_id);
end;
$$;

create or replace function public.delete_paper_draft(p_paper_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_paper papers%rowtype;
begin
  select * into v_paper from papers where id = p_paper_id;
  if not found then
    raise exception '试卷不存在';
  end if;
  if v_paper.creator_id is distinct from v_uid and not public.is_admin() then
    raise exception '只能删除自己创建的试卷';
  end if;
  -- 口径同 delete_question_draft：只允许删除"从没提交过"的纯草稿
  if exists (select 1 from paper_versions where paper_id = p_paper_id and status <> 'draft') then
    raise exception '该试卷提交过审核，不能删除（可在审核中撤回，或发起改版）';
  end if;
  perform public.paper_audit('delete_paper_draft', p_paper_id, null,
    jsonb_build_object('title', (select title from paper_versions where paper_id = p_paper_id limit 1)));
  delete from papers where id = p_paper_id;
end;
$$;

-- 为已入库试卷发起改版：复制当前入库版的卷面，并把仍存活的题项重新钉到题库最新版本
create or replace function public.create_paper_edit_draft(p_paper_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_paper papers%rowtype;
  v_base paper_versions%rowtype;
  v_next_no int;
  v_new uuid;
  v_frozen boolean;
  v_sec record;
  v_item record;
  v_sec_id uuid;
  v_units numeric[];
  v_content jsonb;
  v_qtype text;
  v_difficulty smallint;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select * into v_paper from papers where id = p_paper_id;
  if not found then
    raise exception '试卷不存在';
  end if;
  if v_paper.creator_id is distinct from v_uid then
    raise exception '只有作者本人能为已入库试卷发起改版';
  end if;
  if v_paper.state <> 'live' then
    raise exception '试卷当前不在线，无法改版（下线期间请先恢复上线）';
  end if;
  if v_paper.current_published_version_id is null then
    raise exception '试卷尚未入库，请直接编辑草稿';
  end if;
  if exists (
    select 1 from paper_versions v
    where v.paper_id = p_paper_id and v.status in ('draft','pending_group','pending_city','returned')
  ) then
    raise exception '该试卷已有在审/未完成的修改版本，请先处理它';
  end if;
  select is_frozen into v_frozen from subject_nodes where id = v_paper.course_node_id;
  if v_frozen then
    raise exception '该课程节点已冻结，不能为该试卷发起新版本';
  end if;

  select * into v_base from paper_versions where id = v_paper.current_published_version_id;
  select coalesce(max(version_no), 0) + 1 into v_next_no from paper_versions where paper_id = p_paper_id;

  insert into paper_versions
    (paper_id, version_no, change_type, base_version_id, status, title, exam_name, subject_label,
     duration_minutes, target_score, header, instructions, created_by)
  values
    (p_paper_id, v_next_no, 'edit', v_base.id, 'draft', v_base.title, v_base.exam_name, v_base.subject_label,
     v_base.duration_minutes, v_base.target_score, v_base.header, v_base.instructions, v_uid)
  returning id into v_new;

  for v_sec in select * from paper_sections where paper_version_id = v_base.id order by sort_order loop
    insert into paper_sections (paper_version_id, sort_order, title, instruction, score_mode, score_each)
    values (v_new, v_sec.sort_order, v_sec.title, v_sec.instruction, v_sec.score_mode, v_sec.score_each)
    returning id into v_sec_id;

    for v_item in
      select i.*, q.state as q_state, q.current_published_version_id as q_current
      from paper_items i
      join questions q on q.id = i.question_id
      where i.section_id = v_sec.id
      order by i.seq
    loop
      -- 重新钉到题库当前入库版本：改版后旧版已是 superseded，沿用旧指针会让新草稿
      -- 一提交就被"已更新到新版本"拦住。题目已下线（或无入库版）时保留原指针，
      -- 由 paper_health 打徽标，教师在编辑器里自行决定去留。
      if v_item.q_state = 'live' and v_item.q_current is not null
         and v_item.q_current <> v_item.question_version_id then
        select content, qtype, difficulty into v_content, v_qtype, v_difficulty
        from question_versions where id = v_item.q_current;
        -- 换版可能改变空位/子题个数，分值明细必须按新内容重算
        v_units := public.paper_item_units(v_qtype, v_content, v_sec.score_mode, v_sec.score_each, null);
        insert into paper_items
          (paper_version_id, section_id, seq, question_id, question_version_id,
           qtype, difficulty, score, score_units, origin, note)
        values
          (v_new, v_sec_id, v_item.seq, v_item.question_id, v_item.q_current,
           v_qtype, v_difficulty,
           (select coalesce(sum(u), 0) from unnest(v_units) u), to_jsonb(v_units),
           v_item.origin, v_item.note);
      else
        insert into paper_items
          (paper_version_id, section_id, seq, question_id, question_version_id,
           qtype, difficulty, score, score_units, origin, note)
        values
          (v_new, v_sec_id, v_item.seq, v_item.question_id, v_item.question_version_id,
           v_item.qtype, v_item.difficulty, v_item.score, v_item.score_units,
           v_item.origin, v_item.note);
      end if;
    end loop;
  end loop;

  perform public.paper_audit('create_paper_edit_draft', p_paper_id, v_new,
    jsonb_build_object('version_no', v_next_no, 'base', v_base.id));
  return v_new;
end;
$$;

-- =====================================================================
-- 读侧
-- =====================================================================

create or replace function public.list_papers(
  p_node uuid default null, p_kw text default null,
  p_limit int default 20, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb;
  v_total int;
begin
  -- count(*) over () 在一次扫描里同时给出总数与当前页；分页放在外层，
  -- 这样不必把同一段 CTE 写两遍（写两遍最容易在改过滤条件时只改一处）
  with recursive subtree as (
    select id from subject_nodes where id = p_node
    union all
    select sn.id from subject_nodes sn join subtree st on sn.parent_id = st.id
  ),
  hit as (
    select v.id as version_id, v.paper_id, v.title, v.exam_name, v.subject_label,
           v.total_score, v.duration_minutes, v.version_no, v.published_at,
           p.school_id, p.course_node_id,
           (select count(*) from paper_items i where i.paper_version_id = v.id) as item_count,
           count(*) over () as total_count
    from paper_versions v
    join papers p on p.id = v.paper_id
    where v.status = 'published' and p.state = 'live' and p.current_published_version_id = v.id
      and (p_node is null or p.course_node_id in (select id from subtree))
      -- 关键词用 strpos 做大小写不敏感的包含匹配：不用 LIKE 就不必处理 %/_ 的转义，
      -- 教师搜「100%」这类词也不会变成通配符
      and (p_kw is null or trim(p_kw) = ''
           or strpos(lower(v.title), lower(trim(p_kw))) > 0
           or strpos(lower(coalesce(v.exam_name, '')), lower(trim(p_kw))) > 0)
  ),
  page as (
    select * from hit order by published_at desc nulls last limit v_limit offset v_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'version_id', g.version_id, 'paper_id', g.paper_id, 'title', g.title,
           'exam_name', g.exam_name, 'subject_label', g.subject_label,
           'total_score', g.total_score, 'duration_minutes', g.duration_minutes,
           'version_no', g.version_no, 'published_at', g.published_at,
           'school_id', g.school_id, 'course_node_id', g.course_node_id,
           'item_count', g.item_count) order by g.published_at desc nulls last), '[]'::jsonb),
         coalesce(max(g.total_count), 0)::int
    into v_rows, v_total
    from page g;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'papers', v_rows);
end;
$$;

-- 我的试卷：草稿 / 在审 / 已退回 / 已入库全都要看得到，并带上卡在哪一步
create or replace function public.list_my_papers(p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
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
               'waiting_assignee', (select a.assigned_user_id from paper_approvals a
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

-- 卷面健康检查：哪几道题在题库里出了问题（改版/下线/版本丢失）
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
           when qv.id is null or qv.status <> 'published' then 'superseded'
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

-- =====================================================================
-- 授权收口
-- =====================================================================

revoke execute on function public.cn_numeral(int) from public, anon, authenticated;
revoke execute on function public.paper_version_json(uuid) from public, anon, authenticated;
revoke execute on function public.paper_refresh_items(uuid) from public, anon;
grant execute on function public.paper_refresh_items(uuid) to authenticated;

revoke execute on function public.get_paper_version(uuid) from public, anon;
revoke execute on function public.create_paper_draft(uuid, jsonb) from public, anon;
revoke execute on function public.save_paper_draft(uuid, jsonb, jsonb, bigint) from public, anon;
revoke execute on function public.submit_paper(uuid) from public, anon;
revoke execute on function public.retract_paper(uuid) from public, anon;
revoke execute on function public.delete_paper_draft(uuid) from public, anon;
revoke execute on function public.create_paper_edit_draft(uuid) from public, anon;
revoke execute on function public.list_papers(uuid, text, int, int) from public, anon;
revoke execute on function public.list_my_papers(int, int) from public, anon;
revoke execute on function public.paper_health(uuid) from public, anon;

grant execute on function public.get_paper_version(uuid) to authenticated;
grant execute on function public.create_paper_draft(uuid, jsonb) to authenticated;
grant execute on function public.save_paper_draft(uuid, jsonb, jsonb, bigint) to authenticated;
grant execute on function public.submit_paper(uuid) to authenticated;
grant execute on function public.retract_paper(uuid) to authenticated;
grant execute on function public.delete_paper_draft(uuid) to authenticated;
grant execute on function public.create_paper_edit_draft(uuid) to authenticated;
grant execute on function public.list_papers(uuid, text, int, int) to authenticated;
grant execute on function public.list_my_papers(int, int) to authenticated;
grant execute on function public.paper_health(uuid) to authenticated;
