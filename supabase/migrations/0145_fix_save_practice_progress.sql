-- 0145: 修 save_practice_progress 里的 jsonb_object_length（2026-11-06）
--
-- 0144 第一版把"草稿里有几道题"写成了 jsonb_object_length(v_draft)。
-- **PostgreSQL 没有这个函数**（只有 jsonb_array_length），所以
--   · create function 不会报错（函数体是运行期才解析的），
--   · 直到客户端第一次调 save_practice_progress 才炸：
--     `function jsonb_object_length(jsonb) does not exist`。
-- 0144 文件已就地改正；本迁移负责把**已经跑过旧版 0144** 的库修回来。

create or replace function public.save_practice_progress(
  p_session_id uuid,
  p_mode text default null,
  p_answers jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_s practice_sessions%rowtype;
  v_key text;
  v_val jsonb;
  v_draft jsonb;
  v_n int := 0;
  v_md text;
  v_at timestamptz;
begin
  select * into v_s from practice_sessions
  where id = p_session_id and user_id = v_uid
  for update;
  if not found then raise exception '练习会话不存在或不属于你'; end if;

  v_md := case when p_mode in ('instant', 'batch', 'sequential') then p_mode else v_s.mode end;

  -- 已交卷 / 已作废：不再收草稿，静默返回。节流窗口里的最后一批请求可能晚于交卷。
  if v_s.status <> 'active' then
    return jsonb_build_object('saved', 0, 'mode', v_s.mode, 'status', v_s.status,
                              'draft_updated_at', v_s.draft_updated_at);
  end if;

  v_draft := coalesce(v_s.draft_answers, '{}'::jsonb);

  if p_answers is not null and jsonb_typeof(p_answers) = 'object' then
    for v_key, v_val in select e.key, e.value from jsonb_each(p_answers) e loop
      if v_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        continue;
      end if;
      -- 只能写进这场会话的题
      if not exists (
        select 1 from practice_session_items i
        where i.session_id = v_s.id and i.question_id = v_key::uuid
      ) then
        continue;
      end if;

      if v_val is null or jsonb_typeof(v_val) <> 'object' or v_val = '{}'::jsonb then
        v_draft := v_draft - v_key;
      else
        v_draft := v_draft || jsonb_build_object(v_key, v_val);
      end if;
      v_n := v_n + 1;
    end loop;
  end if;

  -- ⚠ 不要用 jsonb_object_length：PostgreSQL **没有**这个函数（只有
  -- jsonb_array_length）。数对象的键只能 jsonb_object_keys 再 count。
  update practice_sessions
  set draft_answers = v_draft,
      draft_updated_at = now(),
      mode = v_md,
      answered_count = case when v_md <> 'instant'
                            then (select count(*)::int from jsonb_object_keys(v_draft))
                            else answered_count end
  where id = v_s.id
  returning draft_updated_at into v_at;

  return jsonb_build_object('saved', v_n, 'mode', v_md, 'status', 'active',
                            'draft_updated_at', v_at);
end;
$$;

revoke all on function public.save_practice_progress(uuid, text, jsonb) from public, anon;
grant execute on function public.save_practice_progress(uuid, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
