-- 0053: 修正 import_build_paper 的「追加到已有草稿」路径。
--
-- 症状：对同一份草稿第二次调用（把另一批题追加进来）报
--   duplicate key value violates unique constraint "paper_sections_paper_version_id_sort_order_key"
-- 根因：v_sort / v_seq 都从 1 开始编号，而追加时卷面上已经有 1..N 了。
--   `unique(paper_version_id, sort_order)` 与 `unique(paper_version_id, seq)` 都会撞。
--
-- 顺带修一个体验问题：追加时同名大题应该**复用**，而不是在卷面上再开一个
-- 「单项选择题」——同一份卷出现两个同名大题，教师还得手动合并。
-- （只按标题匹配。标题是归一过的，这正是 normalizeSectionTitle 存在的意义之一。）

create or replace function public.import_build_paper(
  p_job_id uuid,
  p_item_ids uuid[],
  p_paper_version_id uuid default null,
  p_meta jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_job import_jobs%rowtype;
  v_ver_row paper_versions%rowtype;
  v_school uuid;
  v_paper uuid;
  v_version uuid;
  v_meta jsonb;
  v_sec record;
  v_item record;
  v_sec_id uuid;
  -- 追加时要接着已有编号往下排，不能从 1 重来
  v_sort int := 0;
  v_seq int := 0;
  v_added int := 0;
  v_skipped int := 0;
  v_uniform boolean;
  v_mode text;
  v_each numeric;
  v_units numeric[];
  v_warn text[] := '{}';
  v_secs jsonb := '[]'::jsonb;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select * into v_job from import_jobs where id = p_job_id;
  if not found then
    raise exception '导入任务不存在';
  end if;
  if v_job.created_by is distinct from v_uid then
    raise exception '只能处理自己的导入任务';
  end if;
  if v_job.status not in ('review', 'importing', 'done') then
    raise exception '任务还在解析中，请等解析完成后再成卷';
  end if;

  if p_paper_version_id is null then
    v_school := public.check_can_author(v_job.course_node_id);
    v_meta := v_job.paper_meta || coalesce(p_meta, '{}'::jsonb);
    insert into papers (school_id, creator_id, course_node_id)
    values (v_school, v_uid, v_job.course_node_id)
    returning id into v_paper;

    insert into paper_versions
      (paper_id, version_no, change_type, status, title, exam_name, subject_label,
       duration_minutes, target_score, created_by)
    values
      (v_paper, 1, 'create', 'draft',
       coalesce(nullif(trim(v_meta ->> 'title'), ''), v_job.title, 'AI 还原试卷'),
       nullif(trim(coalesce(v_meta ->> 'exam_name', '')), ''),
       nullif(trim(coalesce(v_meta ->> 'subject_label', '')), ''),
       coalesce(nullif(v_meta ->> 'duration_minutes', '')::int, 90),
       nullif(v_meta ->> 'total_score', '')::numeric,
       v_uid)
    returning id into v_version;
  else
    select * into v_ver_row from paper_versions where id = p_paper_version_id;
    if not found then
      raise exception '试卷不存在';
    end if;
    if v_ver_row.created_by is distinct from v_uid then
      raise exception '只能把题追加到自己的试卷里';
    end if;
    if v_ver_row.status not in ('draft', 'returned') then
      raise exception '只能往草稿或被退回的试卷里追加题目';
    end if;
    v_version := v_ver_row.id;
    v_paper := v_ver_row.paper_id;

    -- 追加：接着卷面已有的编号往下排
    select coalesce(max(sort_order), 0) into v_sort from paper_sections where paper_version_id = v_version;
    select coalesce(max(seq), 0) into v_seq from paper_items where paper_version_id = v_version;
  end if;

  for v_sec in
    with picked as (
      select i.*, coalesce(s.seq, 9999) as sec_seq,
             coalesce(s.title, '未分大题') as sec_title,
             coalesce(s.instruction, null) as sec_instruction,
             coalesce(s.id, '00000000-0000-0000-0000-000000000000'::uuid) as sec_id
      from import_job_items i
      left join import_job_sections s on s.id = i.section_id
      where i.job_id = p_job_id and i.id = any(p_item_ids) and i.status = 'imported'
    )
    select sec_id, sec_seq, sec_title, sec_instruction,
           count(*) as n,
           count(*) filter (where score is null) as n_noscore,
           (count(distinct coalesce(score_mode, 'per_item')) = 1
            and count(distinct coalesce(score, 0)) = 1) as uniform,
           min(coalesce(score_mode, 'per_item')) as mode,
           min(coalesce(score, 0)) as each
    from picked
    group by sec_id, sec_seq, sec_title, sec_instruction
    order by sec_seq
  loop
    -- 卷面上已有同名大题（追加场景）就直接复用，不再开一个
    select id into v_sec_id from paper_sections
    where paper_version_id = v_version and title = left(v_sec.sec_title, 60)
    limit 1;

    if v_sec_id is null then
      v_sort := v_sort + 1;
      v_uniform := v_sec.uniform and v_sec.n_noscore = 0;
      if v_uniform then
        v_mode := v_sec.mode; v_each := v_sec.each;
      else
        v_mode := 'per_item'; v_each := 0;
      end if;

      insert into paper_sections
        (paper_version_id, sort_order, title, instruction, score_mode, score_each)
      values (v_version, v_sort, left(v_sec.sec_title, 60), v_sec.sec_instruction, v_mode, v_each)
      returning id into v_sec_id;

      v_secs := v_secs || jsonb_build_object(
        'title', v_sec.sec_title, 'item_count', v_sec.n,
        'score_mode', v_mode, 'score_each', v_each, 'uniform', v_uniform);
    else
      -- 复用已有大题：口径以卷面上现有的为准（教师在编辑器里可能已经调过），
      -- 新增的题按它的口径算分，而不是按解析出来的分值硬套
      select score_mode, score_each into v_mode, v_each
      from paper_sections where id = v_sec_id;
      v_uniform := (v_mode <> 'per_item' or v_each > 0) and v_sec.n_noscore = 0;
      if not v_uniform then v_mode := 'per_item'; v_each := 0; end if;
      v_warn := v_warn || format('大题「%s」卷面上已存在，新题按它的分值（%s %s 分）计入',
                                 v_sec.sec_title, v_mode, v_each);
    end if;

    if v_sec.n_noscore > 0 and v_uniform = false and v_sec.n_noscore = v_sec.n then
      v_warn := v_warn || format('大题「%s」有 %s 道题没抽到分值，已按 0 分放入，请在编辑器里补',
                                 v_sec.sec_title, v_sec.n_noscore);
    end if;
    if v_sec.sec_title = '未分大题' and v_sec.n > 0 then
      v_warn := v_warn || format('有 %s 道题没归到大题，已放入「未分大题」', v_sec.n);
    end if;

    for v_item in
      select i.*, qv.qtype as v_qtype, qv.difficulty as v_diff, qv.content as v_content
      from import_job_items i
      join question_versions qv on qv.id = i.version_id
      where i.job_id = p_job_id and i.id = any(p_item_ids) and i.status = 'imported'
        and coalesce(i.section_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_sec.sec_id
      order by i.page_no, i.seq
    loop
      v_seq := v_seq + 1;
      v_units := public.paper_item_units(
        v_item.v_qtype, v_item.v_content, v_mode, v_each,
        case when v_uniform then null else to_jsonb(array[coalesce(v_item.score, 0)]) end);

      insert into paper_items
        (paper_version_id, section_id, seq, question_id, question_version_id,
         qtype, difficulty, score, score_units, origin)
      values
        (v_version, v_sec_id, v_seq, v_item.question_id, v_item.version_id,
         v_item.v_qtype, v_item.v_diff,
         (select coalesce(sum(u), 0) from unnest(v_units) u), to_jsonb(v_units), 'import')
      on conflict (paper_version_id, question_id) do nothing;
      if found then v_added := v_added + 1; else v_skipped := v_skipped + 1; end if;
    end loop;
  end loop;

  if v_sort = 0 and v_added = 0 and v_skipped = 0 then
    raise exception '没有可用的题目：请先在预览页把题目入库（「一键成卷」只处理已入库的题）';
  end if;

  update import_jobs set paper_id = v_paper where id = p_job_id;

  perform public.paper_audit('import_build_paper', v_paper, v_version,
    jsonb_build_object('job_id', p_job_id, 'added', v_added, 'skipped', v_skipped));

  return jsonb_build_object(
    'paper_id', v_paper,
    'paper_version_id', v_version,
    'sections', v_secs,
    'added', v_added,
    'skipped', v_skipped,
    'warnings', to_jsonb(v_warn));
end;
$$;

revoke execute on function public.import_build_paper(uuid, uuid[], uuid, jsonb) from public, anon;
grant execute on function public.import_build_paper(uuid, uuid[], uuid, jsonb) to authenticated;
