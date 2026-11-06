-- 0146: AI 解析的「答案区」——答案单独上传，先解析成答案键，再与题目页比对。
--
-- 0034 建表时就留了 answer_mode / answer_from / answer_to（注释写着 "v1.1 卷末答案页"），
-- 但一直没接 UI。现在落地，形状和当初设想的不完全一样：
--   · 答案区是**另一个文件**（也可以是同一份 PDF 的另一段页码），不是「卷末几页」这一个特例；
--   · 答案键（qno → 答案文本）存在 import_jobs.answer_key 上，随任务走，
--     刷新/换设备都能续跑（源文件仍然只在浏览器里，不上传）；
--   · 与答案键不一致的那份答案存在 import_job_items.answer_alt 上——**两份都保留**，
--     老师在校对页二选一。answer_alt 是预览期的辅助信息，绝不进 content
--     （import_questions_draft 会把 content 原样抄进 question_versions）。
--
-- ⚠ 不碰 import_save_page（0050 的 5300 字主链路）。需要多写一列时用**包装函数**
--   import_save_page_with_alts：它只是调用原函数再补一次 UPDATE，原函数的租约、幂等、
--   人工修改守卫一条都没变。

-- ============ 列 ============
alter table public.import_jobs
  add column if not exists answer_key jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.import_jobs'::regclass and conname = 'import_jobs_answer_key_object'
  ) then
    alter table public.import_jobs
      add constraint import_jobs_answer_key_object check (jsonb_typeof(answer_key) = 'object');
  end if;
end $$;

comment on column public.import_jobs.answer_key is
  '答案区解析出来的答案键：{version, source:{kind,name,pages}, from, to, entries:[{page,section,qno,answer_text,analysis}], pages:[{page_no,ok,error,at}], truncated, partial, skipped, parsed_at}';

alter table public.import_job_items
  add column if not exists answer_alt jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.import_job_items'::regclass and conname = 'import_job_items_answer_alt_object'
  ) then
    alter table public.import_job_items
      add constraint import_job_items_answer_alt_object
      check (answer_alt is null or jsonb_typeof(answer_alt) = 'object');
  end if;
end $$;

comment on column public.import_job_items.answer_alt is
  '与 content.answer 不一致的那份答案（答案区 vs AI 推导）：{from:"key"|"ai", answer} 或复合题 {from, subs:[{index,answer}]}；只在预览期用，入库前不会被带进 question_versions';

-- ============ flags 白名单（照 0054 的写法，约束名是 PG 自动生成的，不能硬编码） ============
do $$
declare
  v_name text;
begin
  select conname into v_name
  from pg_constraint
  where conrelid = 'public.import_job_items'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%flags%';
  if v_name is not null then
    execute format('alter table public.import_job_items drop constraint %I', v_name);
  end if;
end $$;

alter table public.import_job_items
  add constraint import_job_items_flags_check
  check (flags <@ array['cross_page', 'merged_cross_page', 'has_figure', 'has_formula',
                         'answer_missing', 'blank_mismatch', 'qno_gap', 'low_confidence',
                         'dup_in_job', 'dup_in_bank', 'truncated', 'no_analysis',
                         'ai_analysis', 'ai_answer', 'answer_from_key', 'answer_conflict']);

comment on column public.import_job_items.flags is
  '需人工注意的点：跨页/含图/含公式/缺答案/AI 推导的答案/答案来自答案区/两份答案不一致/空位不匹配/跳号/低置信/重复';

-- ============ 写答案键 ============
-- 客户端每解析完一页就把**累积后的完整键**整体写回（替换语义，天然幂等），
-- 所以这里不做增量合并：增量合并一旦中途失败，键里会出现两份半截数据。
create or replace function public.import_set_answer_key(p_job_id uuid, p_key jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_job import_jobs%rowtype;
  v_entries int;
  v_size int;
  v_from int;
  v_to int;
begin
  if p_key is null or jsonb_typeof(p_key) <> 'object' then
    raise exception '答案键必须是 JSON 对象';
  end if;

  select * into v_job from import_jobs where id = p_job_id for update;
  if not found or v_job.created_by <> v_uid then
    raise exception '任务不存在，或你不是它的创建者';
  end if;
  if v_job.status = 'discarded' then
    raise exception '任务已放弃，不能再写入答案区';
  end if;

  -- 题目页全部解析完（或跳过）之后写键没有任何意义：那几页不会再被认领。
  -- 只完成了一部分时**允许**写——剩下的页仍然用得上，已完成的页本来就补不回来，
  -- 界面上会明说这一点。
  if not exists (
    select 1 from import_job_pages
    where job_id = p_job_id and status in ('pending', 'running', 'failed')
  ) then
    raise exception '题目页已全部解析完成，答案区不能再补';
  end if;

  v_entries := coalesce(jsonb_array_length(coalesce(p_key -> 'entries', '[]'::jsonb)), 0);
  if v_entries > 1000 then
    raise exception '答案键条目过多（% 条，上限 1000）', v_entries;
  end if;
  v_size := pg_column_size(p_key);
  if v_size > 2 * 1024 * 1024 then
    raise exception '答案键过大（% KB，上限 2MB），请缩小答案区范围', round(v_size / 1024.0);
  end if;

  v_from := nullif(p_key ->> 'from', '')::int;
  v_to := nullif(p_key ->> 'to', '')::int;

  -- 建任务时 answer_mode 已经是 separate（答案区是必填信息之一），这里只在带了合法
  -- 页码范围时顺手把三个字段对齐；不带就只写键，不动 mode（否则会撞 0034 的 check）。
  if v_from is not null and v_to is not null and v_to >= v_from then
    update import_jobs
    set answer_key = p_key, answer_mode = 'separate', answer_from = v_from, answer_to = v_to
    where id = p_job_id;
  else
    update import_jobs set answer_key = p_key where id = p_job_id;
  end if;

  return jsonb_build_object('ok', true, 'entries', v_entries, 'bytes', v_size);
end;
$$;

revoke execute on function public.import_set_answer_key(uuid, jsonb) from public, anon;
grant execute on function public.import_set_answer_key(uuid, jsonb) to authenticated;

-- ============ 落库：原函数 + 一次补充写入 ============
-- p_alts: [{seq, alt}]。**seq 是 p_items 里的数组下标**（import_save_page 就是这么写 seq 的），
-- 不是模型返回值里的题号顺序——normalizePage 给 item.seq 赋的是「去重前」的下标，两者会错位。
create or replace function public.import_save_page_with_alts(
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
  p_sections jsonb default '[]'::jsonb,
  p_alts jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  -- 原函数先跑：租约校验、幂等锚点、人工修改守卫、任务计数一条都没变
  v_result := public.import_save_page(
    p_job_id, p_page_no, p_lease_token, p_mode, p_status, p_error,
    p_items, p_usage, p_raw, p_retryable, p_paper, p_sections);

  -- answer_alt 是**辅助信息**：写失败绝不能把已经存好、已经付过钱的那一页回滚掉。
  -- 所以整段包在子事务里，出错就当没有（页面的答案仍然是完整的，只是少了「另一份」）。
  if coalesce(jsonb_array_length(p_alts), 0) > 0 then
    begin
      update public.import_job_items i
      set answer_alt = a.x -> 'alt'
      from jsonb_array_elements(p_alts) as a(x)
      where i.job_id = p_job_id
        and i.page_no = p_page_no
        and i.seq = (a.x ->> 'seq')::int
        and i.status <> 'imported';
    exception when others then
      null;
    end;
  end if;

  return v_result;
end;
$$;

revoke execute on function public.import_save_page_with_alts(
  uuid, int, uuid, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.import_save_page_with_alts(
  uuid, int, uuid, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb) to authenticated;

-- ============ 人工改成「另一份」 ============
-- 与 import_update_item 的区别：那个是**重新填写**（内容以表单为准，另一份作废），
-- 这个是**互换**（两份都留着，只是把主次对调）。没有它，老师在预览页点一下
-- 「改用 AI 推导的答案」，答案区那份就被永久丢掉了。
create or replace function public.import_switch_item_answer(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_item import_job_items%rowtype;
  v_content jsonb;
  v_alt jsonb;
  v_new_alt jsonb;
  v_flags text[];
  v_from text;
  v_old jsonb;
  v_elem jsonb;
  v_index int;
  v_subs jsonb;
  v_old_primary_subs jsonb := '[]'::jsonb;
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
  if v_item.answer_alt is null then
    raise exception '这道题只有一份答案，没有可切换的对象';
  end if;

  v_content := v_item.content;
  v_alt := v_item.answer_alt;
  v_flags := v_item.flags;
  -- 换过去之后的主答案来自「另一份」，所以来源跟着对调
  v_from := case when 'answer_from_key' = any(v_flags) then 'ai' else 'key' end;

  if v_item.qtype = 'composite' then
    v_subs := coalesce(v_alt -> 'subs', '[]'::jsonb);
    for v_elem in select * from jsonb_array_elements(v_subs) loop
      v_index := (v_elem ->> 'index')::int;
      -- 下标缺失/不合法就跳过：jsonb_set 的路径里有 NULL 会直接抛错，把整次切换搞失败
      if v_index is null or v_index < 0 then
        continue;
      end if;
      v_old := v_content #> array['sub', v_index::text, 'answer'];
      if v_old is not null then
        v_old_primary_subs := v_old_primary_subs
          || jsonb_build_array(jsonb_build_object('index', v_index, 'answer', v_old));
      end if;
      if jsonb_typeof(v_elem -> 'answer') = 'object' then
        v_content := jsonb_set(v_content, array['sub', v_index::text, 'answer'], v_elem -> 'answer', true);
      end if;
    end loop;
    v_new_alt := jsonb_build_object('from', case when 'answer_from_key' = any(v_flags) then 'key' else 'ai' end,
                                    'subs', v_old_primary_subs);
  else
    v_old := v_content -> 'answer';
    v_new_alt := jsonb_build_object('from', case when 'answer_from_key' = any(v_flags) then 'key' else 'ai' end);
    if v_old is not null then
      v_new_alt := v_new_alt || jsonb_build_object('answer', v_old);
    end if;
    if jsonb_typeof(v_alt -> 'answer') = 'object' then
      v_content := jsonb_set(v_content, '{answer}', v_alt -> 'answer', true);
    end if;
  end if;

  update import_job_items
  set content = v_content,
      answer_alt = v_new_alt,
      -- answer_conflict 保留：两份仍然不一致，只是主次换了。
      -- answer_from_key 反过来：现在主答案来自哪一份就标哪一份。
      flags = case when v_from = 'key'
                   then (select coalesce(array_agg(distinct f), '{}'::text[])
                         from unnest(v_flags || array['answer_from_key']) f)
                   else (select coalesce(array_agg(f), '{}'::text[])
                         from unnest(v_flags) f where f <> 'answer_from_key')
              end,
      content_hash = md5(coalesce(public.v_blocks_text(v_content -> 'stem'), '')
                         || '|' || coalesce(v_content ->> 'answer', ''))
  where id = p_item_id;

  select job_id into v_job from import_job_items where id = p_item_id;
  perform public.import_refresh_job(v_job);
end;
$$;

revoke execute on function public.import_switch_item_answer(uuid) from public, anon;
grant execute on function public.import_switch_item_answer(uuid) to authenticated;

-- ============ 人工重填时作废「另一份」 ============
-- 与 0035 的版本只差两处：清掉 answer_alt、并把两个新标记一起清掉。
-- 只改状态（p_content 为 null）时不动 answer_alt——那只是在勾选/跳过，不是改答案。
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
      -- 人工改过的题不再挂着「低置信 / 缺答案 / 答案冲突」这类提示：那些是给人工看的，改完就该消失。
      -- 只改状态（勾选/跳过）时不动 0146 的两个新标记——那不是在改答案，
      -- 把它们清掉等于让「答案冲突」这个徽标在勾一下之后就消失。
      flags = case
                when p_content is null and p_status is null then flags
                when p_content is null then array(select f from unnest(flags) f
                                                  where f not in ('low_confidence', 'answer_missing',
                                                                  'blank_mismatch', 'qno_gap'))
                else array(select f from unnest(flags) f
                           where f not in ('low_confidence', 'answer_missing', 'blank_mismatch',
                                           'qno_gap', 'answer_conflict', 'answer_from_key'))
              end,
      -- 重新填过答案之后，「另一份」已经没有对照意义了
      answer_alt = case when p_content is null then answer_alt else null end,
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
