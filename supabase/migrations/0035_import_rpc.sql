-- 0035: 批量导入的写路径（全部 SECURITY DEFINER，客户端零 DML）。
-- 分工：任务生命周期（建/放弃）→ 页推进（认领/回写/重试/跳过）→ 人工校对（改题/批量状态）
--       → 入库（生成草稿，复用既有校验与标签/媒体装配）。
-- 三条设计要点：
--   · **写操作只认任务创建者**：读可以由本校管理员/系统管理员看（0034 的 select 策略），
--     但推进解析与入库会写代价（token 钱、草稿归属），所以比读更严。
--   · **入库逐项子事务隔离**：一道题的内容不合法不能拖垮另外 24 道（begin…exception 包住单题）。
--     并且一次最多 25 道——authenticated 角色的 statement_timeout 是 8s（实测），
--     几百题一个事务必然超时，分片是硬要求而不是优化。
--   · **幂等锚点是 item.status='imported'**：重复调用入库直接回传已生成的 id，不重复建题。

-- ============ 内部：重算任务计数与收口状态 ============
-- 不授给客户端：只有本文件的 definer 函数调用它。
create or replace function public.import_refresh_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int;
  v_done int;
  v_failed int;
  v_items int;
  v_kept int;
  v_imported int;
  v_pending_page int;
  v_cur_status text;
begin
  select status into v_cur_status from import_jobs where id = p_job_id;
  if v_cur_status in ('discarded', 'done') then
    return;  -- 终态不再回退
  end if;

  select count(*),
         count(*) filter (where status = 'done'),
         count(*) filter (where status = 'failed')
    into v_total, v_done, v_failed
  from import_job_pages where job_id = p_job_id;

  -- kept 含 failed：入库失败的题仍然是「教师要的题」，否则一失败就会被误判为「已全部入库」
  select count(*),
         count(*) filter (where status in ('kept', 'imported', 'failed')),
         count(*) filter (where status = 'imported')
    into v_items, v_kept, v_imported
  from import_job_items where job_id = p_job_id;

  -- 还有可认领的页吗（pending，或租约已过期的 running，且没到重试上限）
  select count(*) into v_pending_page
  from import_job_pages
  where job_id = p_job_id
    and attempts < 3
    and (status = 'pending' or (status = 'running' and lease_expires_at < now()));

  update import_jobs
  set total_pages = v_total,
      done_pages = v_done,
      failed_pages = v_failed,
      item_count = v_items,
      kept_count = v_kept,
      imported_count = v_imported,
      status = case
        when v_cur_status = 'running' and v_pending_page = 0
             and (v_done + v_failed > 0 or v_total = 0) then 'review'
        when v_cur_status = 'importing' and v_kept > 0 and v_kept = v_imported then 'done'
        else v_cur_status
      end,
      finished_at = case
        when v_cur_status = 'importing' and v_kept > 0 and v_kept = v_imported then now()
        else finished_at
      end,
      updated_at = now()
  where id = p_job_id;

  -- 收口时补一条任务级审计（只发一次：上面刚把它置为 done）
  if v_cur_status = 'importing' and v_kept > 0 and v_kept = v_imported then
    perform public.audit('import_finish_job', null, null,
      jsonb_build_object('job_id', p_job_id, 'imported', v_imported));
  end if;
end;
$$;

revoke execute on function public.import_refresh_job(uuid) from public, anon, authenticated;

-- ============ 建任务 ============
create or replace function public.import_create_job(
  p_course_node uuid,
  p_title text,
  p_source jsonb,
  p_page_from int,
  p_page_to int,
  p_answer jsonb default '{}'::jsonb,
  p_tag_ids uuid[] default '{}'::uuid[],
  p_defaults jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_school uuid;
  v_title text := trim(coalesce(p_title, ''));
  v_kind text := p_source ->> 'kind';
  v_name text := trim(coalesce(p_source ->> 'name', ''));
  v_pages int := coalesce((p_source ->> 'pages')::int, 0);
  v_sha text := nullif(trim(coalesce(p_source ->> 'sha256', '')), '');
  v_active int;
  v_id uuid;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  -- 建任务时就校验节点可挂题（教师账号/学校绑定/节点未冻结），并把 school_id 快照下来，
  -- 保证与后面生成的题目归属一致（题目归属不可传参，见 check_can_author）
  v_school := public.check_can_author(p_course_node);
  perform public.check_tags_exist(p_tag_ids);

  if v_title = '' then
    raise exception '请填写任务名称（便于在历史任务里找到它）';
  end if;
  if v_kind is null or v_kind not in ('pdf', 'docx', 'image') then
    raise exception '不支持的源文件类型';
  end if;
  if v_name = '' then
    raise exception '源文件名不能为空';
  end if;
  if p_page_from is null or p_page_to is null or p_page_from < 1 or p_page_to < p_page_from then
    raise exception '页码范围不合法';
  end if;
  if p_page_to - p_page_from + 1 > 500 then
    raise exception '单个任务最多 500 页，请拆成多次导入';
  end if;
  if (SELECT count(*) FROM import_jobs
      WHERE created_by = v_uid AND status IN ('running', 'review', 'importing')) >= 2 then
    raise exception '你还有未完成的导入任务，请先处理完再新建（最多同时 2 个）';
  end if;

  insert into import_jobs (
    created_by, school_id, course_node_id, title, source_kind, source_name, source_pages, source_sha256,
    page_from, page_to, image_mode, image_detail, answer_mode, answer_from, answer_to,
    gen_analysis, default_qtype, default_difficulty, tag_ids, status, total_pages)
  values (
    v_uid, v_school, p_course_node, v_title, v_kind, v_name, greatest(v_pages, 0), v_sha,
    p_page_from, p_page_to,
    coalesce(nullif(p_source ->> 'image_mode', ''), 'auto'),
    coalesce(nullif(p_source ->> 'image_detail', ''), 'high'),
    coalesce(nullif(p_answer ->> 'mode', ''), 'embedded'),
    nullif(p_answer ->> 'from', '')::int,
    nullif(p_answer ->> 'to', '')::int,
    coalesce((p_defaults ->> 'gen_analysis')::boolean, true),
    nullif(p_defaults ->> 'qtype', ''),
    coalesce((p_defaults ->> 'difficulty')::smallint, 2),
    coalesce(p_tag_ids, '{}'::uuid[]),
    'running',
    p_page_to - p_page_from + 1)
  returning id into v_id;

  -- 页行一次写全：进度、认领、重试都只改这张表，前端内存里不留任何权威状态
  insert into import_job_pages (job_id, page_no)
  select v_id, gs from generate_series(p_page_from, p_page_to) gs;

  perform public.audit('import_create_job', null, null,
    jsonb_build_object('job_id', v_id, 'pages', p_page_to - p_page_from + 1,
                       'kind', v_kind, 'node', p_course_node));

  return v_id;
end;
$$;

revoke execute on function public.import_create_job(uuid, text, jsonb, int, int, jsonb, uuid[], jsonb) from public, anon;
grant execute on function public.import_create_job(uuid, text, jsonb, int, int, jsonb, uuid[], jsonb) to authenticated;

-- ============ 认领页（并发与续跑的支点） ============
create or replace function public.import_claim_pages(
  p_job_id uuid,
  p_limit int default 3,
  p_lease_seconds int default 300)
returns setof public.import_job_pages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_hour int;
  v_limit int := least(greatest(coalesce(p_limit, 3), 1), 10);
  v_lease int := least(greatest(coalesce(p_lease_seconds, 300), 30), 3600);
begin
  if not exists (select 1 from import_jobs where id = p_job_id and created_by = v_uid) then
    raise exception '任务不存在，或你不是它的创建者';
  end if;

  -- 跑飞保护：一小时内认领超过 600 页就停手（多半是脚本出错或页面被反复刷新）
  select count(*) into v_hour
  from import_job_pages pg
  join import_jobs j on j.id = pg.job_id
  where j.created_by = v_uid and pg.attempts > 0 and pg.updated_at > now() - interval '1 hour';
  if v_hour >= 600 then
    raise exception '本小时已处理超过 600 页，请稍后再继续（防止误操作把额度跑光）';
  end if;

  -- FOR UPDATE SKIP LOCKED：多标签页同时跑也不会拿到同一页
  return query
  update import_job_pages p
  set status = 'running',
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => v_lease),
      attempts = p.attempts + 1,
      error = null
  where p.id in (
    select id from import_job_pages
    where job_id = p_job_id
      and attempts < 3
      and (status = 'pending' or (status = 'running' and lease_expires_at < now()))
    order by page_no
    limit v_limit
    for update skip locked
  )
  returning p.*;

  perform public.import_refresh_job(p_job_id);
end;
$$;

revoke execute on function public.import_claim_pages(uuid, int, int) from public, anon;
grant execute on function public.import_claim_pages(uuid, int, int) to authenticated;

-- ============ 回写一页的解析结果 ============
-- p_items 的每个元素是已经规范化过的 item：{qno,qtype,difficulty,content,flags,confidence,source_quote}
create or replace function public.import_save_page(
  p_job_id uuid,
  p_page_no int,
  p_lease_token uuid,
  p_mode text,
  p_status text,
  p_error text default null,
  p_items jsonb default '[]'::jsonb,
  p_usage jsonb default '{}'::jsonb,
  p_raw text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_page import_job_pages%rowtype;
  v_count int := coalesce(jsonb_array_length(p_items), 0);
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

  if v_count > 0 then
    insert into import_job_items (
      job_id, page_no, seq, qno, qtype, difficulty, content, flags, confidence, source_quote, content_hash)
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
          || '|' || coalesce(t.x -> 'content' ->> 'answer', ''))
    from jsonb_array_elements(p_items) with ordinality as t(x, ord);
  end if;

  update import_job_pages
  set status = p_status,
      mode = coalesce(nullif(p_mode, ''), mode),
      error = p_error,
      usage = coalesce(p_usage, '{}'::jsonb),
      raw_text = left(p_raw, 40000),
      lease_token = null,
      lease_expires_at = null
  where id = v_page.id;

  perform public.import_refresh_job(p_job_id);
end;
$$;

revoke execute on function public.import_save_page(uuid, int, uuid, text, text, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.import_save_page(uuid, int, uuid, text, text, text, jsonb, jsonb, text) to authenticated;

-- ============ 人工校对：改一道题 / 批量改状态 ============
create or replace function public.import_update_item(
  p_item_id uuid,
  p_qtype text,
  p_difficulty smallint,
  p_content jsonb,
  p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_item import_job_items%rowtype;
  v_job uuid;
begin
  select i.* into v_item
  from import_job_items i join import_jobs j on j.id = i.job_id
  where i.id = p_item_id and j.created_by = v_uid
  for update of i;
  if not found then
    raise exception '题目不存在，或你不是该任务的创建者';
  end if;
  if v_item.status = 'imported' then
    raise exception '该题已生成草稿，请到「我的题目」里修改';
  end if;
  if p_status is not null and p_status not in ('pending', 'kept', 'skipped') then
    raise exception '状态不合法（只接受 pending / kept / skipped）';
  end if;
  if p_qtype is not null and p_qtype not in
     ('single_choice', 'multiple_choice', 'true_false', 'fill_blank', 'short_answer', 'composite') then
    raise exception '题型不合法';
  end if;
  if p_difficulty is not null and (p_difficulty < 1 or p_difficulty > 3) then
    raise exception '难度不合法';
  end if;

  update import_job_items
  set qtype = coalesce(p_qtype, qtype),
      difficulty = coalesce(p_difficulty, difficulty),
      content = coalesce(p_content, content),
      -- 人工改过的题不再挂着「低置信 / 缺答案」这类提示：那些是给人工看的，改完就该消失
      flags = case when p_content is null and p_status is null then flags
                   else array(select f from unnest(flags) f
                              where f not in ('low_confidence', 'answer_missing', 'blank_mismatch', 'qno_gap')) end,
      status = coalesce(p_status, case when status = 'failed' then 'pending' else status end),
      error = null,
      content_hash = case when p_content is null then content_hash
                          else md5(coalesce(public.v_blocks_text(p_content -> 'stem'), '')
                                   || '|' || coalesce(p_content ->> 'answer', '')) end
  where id = p_item_id;

  select job_id into v_job from import_job_items where id = p_item_id;
  perform public.import_refresh_job(v_job);
end;
$$;

revoke execute on function public.import_update_item(uuid, text, smallint, jsonb, text) from public, anon;
grant execute on function public.import_update_item(uuid, text, smallint, jsonb, text) to authenticated;

create or replace function public.import_set_items_status(p_item_ids uuid[], p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_jobs uuid[];
  v_job uuid;
begin
  if p_status not in ('pending', 'kept', 'skipped') then
    raise exception '状态不合法（只接受 pending / kept / skipped）';
  end if;
  if p_item_ids is null or cardinality(p_item_ids) = 0 then
    raise exception '没有选择题目';
  end if;
  if cardinality(p_item_ids) > 500 then
    raise exception '一次最多操作 500 道题';
  end if;

  select array_agg(distinct i.job_id) into v_jobs
  from import_job_items i join import_jobs j on j.id = i.job_id
  where i.id = any(p_item_ids) and j.created_by = v_uid;
  if v_jobs is null then
    raise exception '题目不存在，或你不是这些任务的创建者';
  end if;

  update import_job_items i
  set status = p_status, error = null
  from import_jobs j
  where i.job_id = j.id and j.created_by = v_uid
    and i.id = any(p_item_ids)
    and i.status <> 'imported';

  foreach v_job in array v_jobs loop
    perform public.import_refresh_job(v_job);
  end loop;
end;
$$;

revoke execute on function public.import_set_items_status(uuid[], text) from public, anon;
grant execute on function public.import_set_items_status(uuid[], text) to authenticated;

-- ============ 重试失败页 / 跳过页 ============
create or replace function public.import_retry_pages(p_job_id uuid, p_page_nos int[] default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_n int;
begin
  if not exists (select 1 from import_jobs where id = p_job_id and created_by = v_uid) then
    raise exception '任务不存在，或你不是它的创建者';
  end if;

  update import_job_pages
  set status = 'pending', attempts = 0, error = null, lease_token = null, lease_expires_at = null
  where job_id = p_job_id
    and (p_page_nos is null or page_no = any(p_page_nos))
    and (p_page_nos is not null or status in ('failed', 'skipped'));
  get diagnostics v_n = row_count;

  perform public.import_refresh_job(p_job_id);
  return v_n;
end;
$$;

revoke execute on function public.import_retry_pages(uuid, int[]) from public, anon;
grant execute on function public.import_retry_pages(uuid, int[]) to authenticated;

create or replace function public.import_skip_page(p_job_id uuid, p_page_no int)
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

  update import_job_pages
  set status = 'skipped', lease_token = null, lease_expires_at = null
  where job_id = p_job_id and page_no = p_page_no and status in ('pending', 'failed');
  if not found then
    raise exception '只能跳过尚未解析完成或解析失败的页';
  end if;

  perform public.import_refresh_job(p_job_id);
end;
$$;

revoke execute on function public.import_skip_page(uuid, int) from public, anon;
grant execute on function public.import_skip_page(uuid, int) to authenticated;

-- ============ 库内查重（按需调用，v1 未接 UI） ============
create or replace function public.import_find_similar(p_job_id uuid, p_threshold real default 0.55)
returns table (item_id uuid, question_id uuid, version_id uuid, similarity real, stem text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_import_job_owner(p_job_id) then
    raise exception '任务不存在或无权访问';
  end if;

  return query
  select i.id, v.question_id, v.id,
         similarity(v.search_text, public.v_blocks_text(i.content -> 'stem'))::real,
         left(public.v_blocks_text(i.content -> 'stem'), 80)
  from import_job_items i
  join question_versions v
    on v.status = 'published'
   and v.search_text is not null
   and similarity(v.search_text, public.v_blocks_text(i.content -> 'stem')) > p_threshold
  where i.job_id = p_job_id
  order by 4 desc
  limit 200;
end;
$$;

revoke execute on function public.import_find_similar(uuid, real) from public, anon;
grant execute on function public.import_find_similar(uuid, real) to authenticated;

-- ============ 批量入库：生成草稿 ============
-- 复用 create_draft 审计动作名 + detail 带 import_job_id：/admin/audit 无需改动就能按题追溯来源。
create or replace function public.import_questions_draft(p_job_id uuid, p_item_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_job import_jobs%rowtype;
  v_school uuid;
  r record;
  v_ok boolean;
  v_err text;
  v_qid uuid;
  v_vid uuid;
  v_results jsonb := '[]'::jsonb;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;

  select * into v_job from import_jobs where id = p_job_id;
  if not found then
    raise exception '任务不存在';
  end if;
  if v_job.created_by <> v_uid then
    raise exception '只有任务创建者可以入库';
  end if;
  if v_job.status not in ('review', 'importing', 'done') then
    raise exception '任务尚未解析完成，不能入库';
  end if;
  if p_item_ids is null or cardinality(p_item_ids) = 0 then
    raise exception '没有选择要入库的题目';
  end if;
  if cardinality(p_item_ids) > 25 then
    raise exception '一次最多入库 25 道（客户端需分片调用）';
  end if;

  -- 节点的可挂题状态在建任务后可能变化（被冻结、被删除）：每次入库都重新校验，
  -- 顺便再取一次 school_id（与建任务时一致，这里用于兜底）
  v_school := public.check_can_author(v_job.course_node_id);
  perform public.check_tags_exist(v_job.tag_ids);

  update import_jobs set status = 'importing' where id = p_job_id and status = 'review';

  -- FOR UPDATE：两个标签页同时点「确认入库」时串行化，靠下面的 imported 判断保证不重复建题
  for r in
    select * from import_job_items
    where job_id = p_job_id and id = any(p_item_ids)
    order by page_no, seq
    for update
  loop
    v_ok := true;
    v_err := null;
    v_qid := null;
    v_vid := null;

    begin
      if r.status = 'imported' then
        -- 幂等：已经建过就直接回传原来那套 id
        v_qid := r.question_id;
        v_vid := r.version_id;
      else
        perform public.validate_question_content(r.qtype, r.content);

        insert into questions (school_id, creator_id, course_node_id)
        values (v_school, v_uid, v_job.course_node_id)
        returning id into v_qid;

        -- search_text 必须在这里算：它只写一次（发布流程不会重算），漏了这道题将来入库后
        -- 用关键词永远搜不到（题库检索走 question_versions.search_text）
        insert into question_versions
          (question_id, version_no, change_type, qtype, difficulty, content,
           search_text, created_by, status)
        values (v_qid, 1, 'create', r.qtype, r.difficulty, r.content,
                public.question_search_text(r.content), v_uid, 'draft')
        returning id into v_vid;

        perform public.replace_version_tags(v_vid, v_job.tag_ids);
        perform public.sync_version_media(v_vid, r.content);

        perform public.audit('create_draft', v_qid, v_vid,
          jsonb_build_object('import_job_id', p_job_id, 'item_id', r.id, 'page_no', r.page_no));

        update import_job_items
        set status = 'imported', question_id = v_qid, version_id = v_vid, error = null
        where id = r.id;
      end if;
    exception when others then
      -- 单题失败不影响同批其他题：子事务回滚掉这题的 questions/versions 插入
      v_ok := false;
      v_err := sqlerrm;
      v_qid := null;
      v_vid := null;
      update import_job_items set status = 'failed', error = v_err where id = r.id;
    end;

    v_results := v_results || jsonb_build_object(
      'item_id', r.id, 'ok', v_ok, 'question_id', v_qid, 'version_id', v_vid, 'error', v_err);
  end loop;

  perform public.import_refresh_job(p_job_id);
  return v_results;
end;
$$;

revoke execute on function public.import_questions_draft(uuid, uuid[]) from public, anon;
grant execute on function public.import_questions_draft(uuid, uuid[]) to authenticated;

-- ============ 放弃任务（软删，已入库的草稿保留） ============
create or replace function public.import_discard_job(p_job_id uuid)
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

  update import_jobs
  set status = 'discarded'
  where id = p_job_id;

  perform public.audit('import_discard_job', null, null, jsonb_build_object('job_id', p_job_id));
end;
$$;

revoke execute on function public.import_discard_job(uuid) from public, anon;
grant execute on function public.import_discard_job(uuid) to authenticated;
