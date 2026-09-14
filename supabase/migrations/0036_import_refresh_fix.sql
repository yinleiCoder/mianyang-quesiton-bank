-- 0036: 修正 import_refresh_job 的收口判定（0035 的版本有两个漏洞）。
-- 问题一：只看「有没有可认领的页」，漏了**正在处理中**的页（running 且租约未过期）。
--   现象：并发跑批时，只要有一批先回写成功，任务就会提前跳到 review，
--   而同一时刻其他页还在解析中——预览页会显示「解析完成」，实际还在跑。
-- 问题二：认领后浏览器崩掉、且 attempts 已到 3 的页会**永远卡在 running**：
--   既不可再认领（attempts 用尽），也不进 failed，于是任务永远收不了口。
-- 修法：① 先回收这种「断了且没法再试」的页（判 failed 并给出人工重试的提示）；
--       ② 收口条件同时要求「无可认领」且「无在途（有效租约）」。

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
  v_claimable int;
  v_inflight int;
  v_cur_status text;
begin
  select status into v_cur_status from import_jobs where id = p_job_id;
  if v_cur_status in ('discarded', 'done') then
    return;  -- 终态不再回退
  end if;

  -- 回收：认领后断了、且已达到重试上限的页。不回收的话它既不能重试也不进终态，
  -- 任务会永远停在 running（这是浏览器中途关闭的真实后果，不是边界情况）。
  update import_job_pages
  set status = 'failed',
      error = coalesce(error, '处理中断（已达重试上限，可在页面上手动重试本页）'),
      lease_token = null,
      lease_expires_at = null
  where job_id = p_job_id
    and status = 'running'
    and lease_expires_at < now()
    and attempts >= 3;

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

  -- 还能被认领的页
  select count(*) into v_claimable
  from import_job_pages
  where job_id = p_job_id
    and attempts < 3
    and (status = 'pending' or (status = 'running' and lease_expires_at < now()));

  -- 正在被处理（租约仍有效）的页：这些都还没出结果，不能算「解析完成」
  select count(*) into v_inflight
  from import_job_pages
  where job_id = p_job_id and status = 'running' and lease_expires_at > now();

  update import_jobs
  set total_pages = v_total,
      done_pages = v_done,
      failed_pages = v_failed,
      item_count = v_items,
      kept_count = v_kept,
      imported_count = v_imported,
      status = case
        when v_cur_status = 'running' and v_claimable = 0 and v_inflight = 0
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
