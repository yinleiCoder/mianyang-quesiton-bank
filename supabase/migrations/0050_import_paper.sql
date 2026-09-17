-- 0050: AI 一键成卷 —— 导入管线加"整卷"信息，并把它变成一份试卷草稿。
--
-- 分工（重要）：解析出来的题**照旧走既有导入管线进题库草稿**（import_questions_draft，
-- 一行不改），两道审核通过后才入库。本迁移只多做一件事：把模型抽出的
-- 卷头 / 大题分节 / 每题分值 记下来，并在教师点「一键成卷」时组装成一份 paper 草稿。
-- 这样"只能使用题库中的题目"这条要求不会被 AI 路径绕过——试卷里引用的是刚建出来的
-- 题库草稿，它们在提交试卷前必须先入库（submit_paper 会拦）。
--
-- ⚠ import_save_page 是**本轮唯一要改的既有函数**。线上最新版是 0038（返回 jsonb、
--   带 p_retryable），下面那份是照 0038 逐行抄下来再加新字段的。
--   千万不要从 0035 复制——那会把 0036/0037/0038 的修复全部打回。

-- =====================================================================
-- 1) 表结构
-- =====================================================================
alter table public.import_jobs
  add column mode text not null default 'questions' check (mode in ('questions','paper')),
  -- 模型抽到的卷头暂存（考试名称/科目/标题/时长/总分），建卷时作为默认值
  add column paper_meta jsonb not null default '{}'::jsonb,
  -- 一键成卷后回填，便于"这份任务已经变成哪张卷"
  add column paper_id uuid references public.papers(id) on delete set null;

comment on column public.import_jobs.mode is 'questions=把一堆散题录进题库；paper=还原一整份试卷（额外抽卷头/大题/分值）';

alter table public.import_job_items
  add column section_title text,
  add column score numeric(6,2) check (score is null or (score >= 0 and score <= 100)),
  add column score_mode text check (score_mode is null or score_mode in ('per_item','per_blank','per_sub'));

-- 大题清单。**必须单独一张表**：分节标题只出现在某一页的页首，
-- 而它管辖的题目会跨好几页，不集中记下来的话跨页大题会散成一个个孤题。
create table public.import_job_sections (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.import_jobs(id) on delete cascade,
  seq         int not null,
  title       text not null,          -- 归一后的标题（序号「一、」与「（共32题…）」已剥离）
  instruction text,
  first_page  int,
  created_at  timestamptz not null default now(),
  unique (job_id, title)
);
comment on table public.import_job_sections is
  'AI 解析出的试卷大题清单；标题已归一（见 lib/import-pipeline.js 的 normalizeSectionTitle）';

create index idx_import_job_sections_job on public.import_job_sections (job_id, seq);

alter table public.import_job_sections enable row level security;
drop policy if exists select_import_job_section on public.import_job_sections;
create policy select_import_job_section on public.import_job_sections for select to authenticated
  using (public.is_import_job_owner(job_id));

alter table public.import_job_items
  add column section_id uuid references public.import_job_sections(id) on delete set null;
create index idx_import_job_items_section on public.import_job_items (section_id);

revoke all on public.import_job_sections from anon, authenticated;
grant select on public.import_job_sections to authenticated;

-- =====================================================================
-- 2) import_save_page：加 p_paper / p_sections，落题时带上分节与分值
-- =====================================================================
-- 参数变多了，create or replace 改不了签名，必须先 drop 旧签名（0038 的同一手法）。
drop function if exists public.import_save_page(uuid, int, uuid, text, text, text, jsonb, jsonb, text, boolean);

create or replace function public.import_save_page(
  p_job_id uuid,
  p_page_no int,
  p_lease_token uuid,
  p_mode text,
  p_status text,
  p_error text default null,
  p_items jsonb default '[]'::jsonb,
  p_usage jsonb default '{}'::jsonb,
  p_raw text default null,
  p_retryable boolean default false,
  p_paper jsonb default '{}'::jsonb,
  p_sections jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_page import_job_pages%rowtype;
  v_count int := coalesce(jsonb_array_length(p_items), 0);
  v_result jsonb;
begin
  if not exists (select 1 from import_jobs where id = p_job_id and created_by = v_uid) then
    raise exception '任务不存在，或你不是它的创建者';
  end if;
  if p_status not in ('done', 'failed') then
    raise exception '页状态不合法（只接受 done / failed）';
  end if;

  select * into v_page from import_job_pages
  where job_id = p_job_id and page_no = p_page_no
  for update;
  if not found then
    raise exception '第 % 页不属于该任务', p_page_no;
  end if;
  -- 租约不符 = 这页已被另一个标签页认领（或租约过期后被人接手）：丢弃这次结果，不覆盖
  if v_page.lease_token is distinct from p_lease_token then
    raise exception '该页已被其他标签页处理，本次结果已丢弃' using errcode = '40001';
  end if;
  -- 教师已经改过/入过库的页，不允许被重新解析覆盖
  if exists (select 1 from import_job_items
             where job_id = p_job_id and page_no = p_page_no and status in ('kept', 'imported')) then
    raise exception '该页题目已有人工修改或已入库，不能被重新解析覆盖';
  end if;

  delete from import_job_items
  where job_id = p_job_id and page_no = p_page_no and status <> 'imported';

  -- 大题先登记：题目行要挂 section_id，所以必须在插题之前。
  -- on conflict 只补 instruction，不动 seq——先出现的页决定顺序（卷首的大题总在更前面），
  -- 跨页重复上报同一个大题时不会把它挪到后面去。
  if coalesce(jsonb_array_length(p_sections), 0) > 0 then
    insert into import_job_sections (job_id, seq, title, instruction, first_page)
    select p_job_id,
           coalesce((select max(s.seq) from import_job_sections s where s.job_id = p_job_id), 0) + t.ord::int,
           t.x ->> 'title',
           nullif(t.x ->> 'instruction', ''),
           p_page_no
    from jsonb_array_elements(p_sections) with ordinality as t(x, ord)
    where coalesce(t.x ->> 'title', '') <> ''
    on conflict (job_id, title) do update
      set instruction = coalesce(import_job_sections.instruction, excluded.instruction);
  end if;

  -- 题目里出现、而 sections 漏报的大题也要补登记（跨页时模型很容易只给题不给 sections）
  if v_count > 0 then
    insert into import_job_sections (job_id, seq, title, first_page)
    select p_job_id,
           coalesce((select max(s.seq) from import_job_sections s where s.job_id = p_job_id), 0)
             + row_number() over (order by t.x ->> 'section_title'),
           t.x ->> 'section_title',
           p_page_no
    from (
      select distinct x from jsonb_array_elements(p_items) x
      where coalesce(x ->> 'section_title', '') <> ''
    ) t(x)
    where not exists (
      select 1 from import_job_sections s
      where s.job_id = p_job_id and s.title = t.x ->> 'section_title')
    on conflict (job_id, title) do nothing;
  end if;

  if v_count > 0 then
    insert into import_job_items (
      job_id, page_no, seq, qno, qtype, difficulty, content, flags, confidence, source_quote, content_hash,
      section_id, section_title, score, score_mode)
    select
      p_job_id,
      p_page_no,
      (t.ord - 1),
      nullif(t.x ->> 'qno', ''),
      t.x ->> 'qtype',
      coalesce((t.x ->> 'difficulty')::smallint, 2),
      coalesce(t.x -> 'content', '{}'::jsonb),
      coalesce((select array_agg(e) from jsonb_array_elements_text(coalesce(t.x -> 'flags', '[]'::jsonb)) e), '{}'::text[]),
      (t.x ->> 'confidence')::real,
      t.x ->> 'source_quote',
      -- 卷内/跨卷去重的依据：题干纯文本 + 答案的规范化文本（只作提示，不建唯一约束）
      md5(coalesce(public.v_blocks_text(t.x -> 'content' -> 'stem'), '')
          || '|' || coalesce(t.x -> 'content' ->> 'answer', '')),
      (select s.id from import_job_sections s
       where s.job_id = p_job_id and s.title = nullif(t.x ->> 'section_title', '')),
      nullif(t.x ->> 'section_title', ''),
      nullif(t.x ->> 'score', '')::numeric,
      nullif(t.x ->> 'score_mode', '')
    from jsonb_array_elements(p_items) with ordinality as t(x, ord);
  end if;

  -- 卷头：只补空缺的键。卷头通常只在第 1 页出现，后续页给 {} 不该把已有值抹掉；
  -- 反过来说，先解析到的那一页写进去的值就是权威（后面页即便又"看到"也不覆盖）。
  if p_paper is not null and p_paper <> '{}'::jsonb then
    update import_jobs j
    set paper_meta = j.paper_meta || coalesce(
      (select jsonb_object_agg(kv.key, kv.value)
       from jsonb_each(p_paper) kv
       where not (j.paper_meta ? kv.key)), '{}'::jsonb)
    where j.id = p_job_id;
  end if;

  update import_job_pages
  set status = case
        -- 可重试的失败且还有重试额度：回到 pending，跑批循环下一轮会自动再试一次
        when p_status = 'failed' and p_retryable and v_page.attempts < 3 then 'pending'
        else p_status
      end,
      mode = coalesce(nullif(p_mode, ''), mode),
      error = p_error,
      usage = coalesce(p_usage, '{}'::jsonb),
      raw_text = left(p_raw, 40000),
      lease_token = null,
      lease_expires_at = null
  where id = v_page.id;

  -- 重算任务计数（也负责把 running 收口成 review / importing 收口成 done）
  perform public.import_refresh_job(p_job_id);

  -- 回传进度：客户端据此就地更新，不必再查一次（0038 的取舍）
  select jsonb_build_object(
           'page', jsonb_build_object(
             'page_no', pg.page_no, 'status', pg.status,
             'attempts', pg.attempts, 'error', pg.error),
           'job', jsonb_build_object(
             'status', j.status, 'total_pages', j.total_pages, 'done_pages', j.done_pages,
             'failed_pages', j.failed_pages, 'item_count', j.item_count,
             'kept_count', j.kept_count, 'imported_count', j.imported_count)
         )
    into v_result
  from import_job_pages pg, import_jobs j
  where pg.job_id = p_job_id and pg.page_no = p_page_no and j.id = p_job_id;

  return v_result;
end;
$$;

revoke execute on function public.import_save_page(uuid, int, uuid, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb) from public, anon;
grant execute on function public.import_save_page(uuid, int, uuid, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb) to authenticated;

-- 把任务标成"整卷还原"模式。单开一个函数而不是改 import_create_job 的签名：
-- 改签名要 drop 旧函数再建，风险高且会打断已经在跑的导入任务。
create or replace function public.import_set_paper_mode(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not exists (select 1 from import_jobs where id = p_job_id and created_by = v_uid) then
    raise exception '任务不存在，或你不是它的创建者';
  end if;
  update import_jobs set mode = 'paper' where id = p_job_id;
end;
$$;

revoke execute on function public.import_set_paper_mode(uuid) from public, anon;
grant execute on function public.import_set_paper_mode(uuid) to authenticated;

-- =====================================================================
-- 3) 一键成卷
-- =====================================================================
-- 前置约定：调用方**先**把要用的题逐片 import_questions_draft 入库（每片 ≤25 道，
-- 逐题子事务、status='imported' 作幂等锚点），再来调本函数。这里只处理
-- status='imported' 的题，其余跳过并写进 warnings——避免"卷子里引用了一批
-- 还没入库的题"这种半成品。
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
  v_noscore int;
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

  -- ============ 目标试卷 ============
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
  end if;

  -- ============ 按大题逐个装题 ============
  -- 顺序取自 import_job_sections.seq（就是页面出现的先后），
  -- 没有分节的题统一归到"未分大题"并给出提示。
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
           -- 同一大题内所有题的分值口径一致时，才能用一句话写进大题标题
           (count(distinct coalesce(score_mode, 'per_item')) = 1
            and count(distinct coalesce(score, 0)) = 1) as uniform,
           min(coalesce(score_mode, 'per_item')) as mode,
           min(coalesce(score, 0)) as each
    from picked
    group by sec_id, sec_seq, sec_title, sec_instruction
    order by sec_seq
  loop
    v_sort := v_sort + 1;
    v_uniform := v_sec.uniform and v_sec.n_noscore = 0;
    if v_uniform then
      v_mode := v_sec.mode; v_each := v_sec.each;
    else
      -- 分值不齐：大题本身不带口径，逐题写死明细（见下面的 custom_units）
      v_mode := 'per_item'; v_each := 0;
      if v_sec.n_noscore > 0 then
        v_warn := v_warn || format('大题「%s」有 %s 道题没抽到分值，已按 0 分放入，请在编辑器里补',
                                   v_sec.sec_title, v_sec.n_noscore);
      elsif v_sec.n > 1 then
        v_warn := v_warn || format('大题「%s」每题分值不一致，已逐题写入', v_sec.sec_title);
      end if;
    end if;
    if v_sec.sec_title = '未分大题' then
      v_warn := v_warn || format('有 %s 道题没归到大题，已放入「未分大题」', v_sec.n);
    end if;

    insert into paper_sections
      (paper_version_id, sort_order, title, instruction, score_mode, score_each)
    values (v_version.id, v_sort, left(v_sec.sec_title, 60), v_sec.sec_instruction, v_mode, v_each)
    returning id into v_sec_id;

    for v_item in
      select i.*, qv.qtype as v_qtype, qv.difficulty as v_diff, qv.content as v_content
      from import_job_items i
      join question_versions qv on qv.id = i.version_id
      where i.job_id = p_job_id and i.id = any(p_item_ids) and i.status = 'imported'
        and coalesce(i.section_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_sec.sec_id
      order by i.page_no, i.seq
    loop
      v_seq := v_seq + 1;
      -- 大题口径统一时不给 custom（让题跟着大题走，教师改大题分值能一次改一片）；
      -- 不统一时才逐题写死
      v_units := public.paper_item_units(
        v_item.v_qtype, v_item.v_content, v_mode, v_each,
        case when v_uniform then null else to_jsonb(array[coalesce(v_item.score, 0)]) end);

      insert into paper_items
        (paper_version_id, section_id, seq, question_id, question_version_id,
         qtype, difficulty, score, score_units, origin)
      values
        (v_version.id, v_sec_id, v_seq, v_item.question_id, v_item.version_id,
         v_item.v_qtype, v_item.v_diff,
         (select coalesce(sum(u), 0) from unnest(v_units) u), to_jsonb(v_units), 'import')
      on conflict (paper_version_id, question_id) do nothing;
      if found then v_added := v_added + 1; else v_skipped := v_skipped + 1; end if;
    end loop;

    v_secs := v_secs || jsonb_build_object(
      'title', v_sec.sec_title, 'item_count', v_sec.n,
      'score_mode', v_mode, 'score_each', v_each, 'uniform', v_uniform);
  end loop;

  if v_sort = 0 then
    raise exception '没有可用的题目：请先在预览页把题目入库（「一键成卷」只处理已入库的题）';
  end if;

  update import_jobs set paper_id = v_paper where id = p_job_id;

  perform public.paper_audit('import_build_paper', v_paper, v_version.id,
    jsonb_build_object('job_id', p_job_id, 'sections', v_sort, 'added', v_added, 'skipped', v_skipped));

  return jsonb_build_object(
    'paper_id', v_paper,
    'paper_version_id', v_version.id,
    'sections', v_secs,
    'added', v_added,
    'skipped', v_skipped,
    'warnings', to_jsonb(v_warn));
end;
$$;

revoke execute on function public.import_build_paper(uuid, uuid[], uuid, jsonb) from public, anon;
grant execute on function public.import_build_paper(uuid, uuid[], uuid, jsonb) to authenticated;
