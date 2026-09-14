-- 0038: import_save_page 顺带回传进度，消掉跑批期间的"刷新查询"。
-- 背景：客户端为了显示进度，原本每存一页就要再查两次（任务 + 页列表）。按实际跑批算，
--   这类刷新占全部数据库请求的八成以上（防抖后仍有约 100 次/分），
--   既压 PostgREST 的内部连接池（撞到过 PGRST003「Timed out acquiring connection」），
--   也制造了"刷新失败 → 未处理 rejection → 页面上 [object Object]"这类噪声。
-- 而这些计数在落库那一刻就已经知道了——直接回传即可，客户端合并进本地状态，
-- 跑批期间一次多余查询都不用发（只有收尾时拉一次完整列表，那次要取题）。
-- 返回：{ page: {page_no,status,attempts,error}, job: {status,total_pages,done_pages,failed_pages,
--                                                    item_count,kept_count,imported_count} }
-- 注意：返回类型变了，必须 drop 旧签名（create or replace 不能改返回类型）。

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
  p_retryable boolean default false)
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

  -- 回传进度：客户端据此就地更新，不必再查一次
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

revoke execute on function public.import_save_page(uuid, int, uuid, text, text, text, jsonb, jsonb, text, boolean) from public, anon;
grant execute on function public.import_save_page(uuid, int, uuid, text, text, text, jsonb, jsonb, text, boolean) to authenticated;
