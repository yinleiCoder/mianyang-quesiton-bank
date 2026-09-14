-- 0037: 可重试的失败要能自动重试（0035 的 import_save_page 少了这个分支）。
-- 问题：官方文档明确说开启 JSON Output 后"API 有概率返回空的 content"，429/5xx 也会偶尔出现。
--   但 0035 的版本一律把失败页写成 failed，而 failed **不在认领条件里**
--   （认领只取 pending，或租约过期的 running），于是这些偶发失败会一直卡着，
--   必须教师手动点「重试失败页」——他多半不知道要点。
-- 修法：给 import_save_page 加一个 p_retryable：
--   · 可重试的失败 且 attempts < 3 → 页回到 pending，跑批循环下一轮自动再试；
--   · 不可重试的失败（内容结构性错误之类）或 attempts 已用尽 → 落到 failed（终态，等人工）。
-- 注意：改了参数列表，必须先把旧签名 drop 掉，否则 create or replace 会造出一个重载。

drop function if exists public.import_save_page(uuid, int, uuid, text, text, text, jsonb, jsonb, text);

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

  perform public.import_refresh_job(p_job_id);
end;
$$;

revoke execute on function public.import_save_page(uuid, int, uuid, text, text, text, jsonb, jsonb, text, boolean) from public, anon;
grant execute on function public.import_save_page(uuid, int, uuid, text, text, text, jsonb, jsonb, text, boolean) to authenticated;
