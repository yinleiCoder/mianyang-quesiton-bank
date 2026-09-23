-- 0073: 修 0072 的限流失效 —— self_reset_password 改为**返回结果**而不是 raise。
--
-- 这个 bug 是 0072 上线后端到端测试当场抓到的：故意用错姓名调一次，再查
-- password_reset_attempts，failed_rows 竟然是 0。
--
-- 根因：`raise exception` 会**回滚整个事务** —— 函数里那句"先记失败次数、再报错"
-- 的 insert 跟错误一起被回滚了。PostgREST 每个请求是一个事务，异常出到客户端 = 事务作废，
-- 函数内部任何写入都留不下。后果：失败计数永远累计不起来，`v_failed >= 5` 这道限流
-- 形同虚设，攻击者可以拿姓名无限次试错 —— 而"限流 + 审计"正是本项目为"姓名这道弱验证"
-- 安排的唯一兜底（用户明确以此换取零人工），兜底失效等于把门敞开。
--
-- **通用教训**（这个坑与本仓 0048 那条"BEFORE DELETE 守卫必须 return old"是同一类）：
-- 需要"先落库、再报错"时，plpgsql 里没有退路 —— 不能用 raise。要么返回结构化结果让
-- 调用方判断，要么把写入放到另一个事务里（本项目没有 dblink/pg_background，也不该为它引入）。
-- 所以这里选了返回 jsonb：`{"ok": true}` / `{"ok": false, "error": "<给用户看的话>"}`。
--
-- 顺带的好处：所有"拒绝"走同一条出口，客户端只需 `if (!data.ok) 显示 data.error`，
-- 不必再区分"HTTP 400 的中文 message"与"网络错误"。
--
-- 返回值变了（void → jsonb）→ create or replace 改不了返回类型，必须 DROP 重建。
-- 该函数 0072 才上线、两端客户端还没接线，此刻重建无依赖方。
-- **DROP 会把 ACL 一起丢掉**，所以重建后必须重新 revoke/grant（本仓 0065 踩过这个坑）。

drop function if exists public.self_reset_password(text, text, text);

create or replace function public.self_reset_password(
  p_identifier   text,
  p_name         text,
  p_new_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ident  text := public.auth_identifier(p_identifier);
  v_name   text := btrim(coalesce(p_name, ''));
  v_target public.profiles%rowtype;
  v_failed int;
  v_ok     int;
  v_len    int  := char_length(coalesce(p_new_password, ''));
  -- 账号不存在 / 姓名不匹配，对外**必须是同一句话**，否则接口成了账号枚举器
  v_mismatch constant text := '手机号/邮箱或姓名不正确，请核对注册时填写的信息';
begin
  -- ---- 入参格式：与"账号是否存在"无关，可以明说；不计数（刷格式不需要限流兜底） ----
  if v_ident is null then
    return jsonb_build_object('ok', false, 'error', '请输入正确的手机号或邮箱');
  end if;
  if v_name = '' then
    return jsonb_build_object('ok', false, 'error', '请填写注册时使用的姓名');
  end if;
  -- 上界 72 是 bcrypt 的截断长度：超出部分不参与哈希，必须挡住，
  -- 否则用户以为设了 80 位长密码，实际只有前 72 字节有效。
  if v_len < 6 or v_len > 72 then
    return jsonb_build_object('ok', false, 'error', '新密码长度需在 6 到 72 位之间');
  end if;
  if p_new_password = v_ident or p_new_password = p_identifier then
    return jsonb_build_object('ok', false, 'error', '新密码不能与手机号/邮箱相同');
  end if;

  -- ---- 限流（读的是已提交的记录，所以失败计数现在真的会累计） ----
  select count(*) into v_failed
    from public.password_reset_attempts
   where identifier = v_ident
     and not succeeded
     and created_at > now() - interval '1 hour';
  if v_failed >= 5 then
    return jsonb_build_object('ok', false, 'error', '尝试次数过多，请 1 小时后再试，或联系老师协助');
  end if;

  select count(*) into v_ok
    from public.password_reset_attempts
   where identifier = v_ident
     and succeeded
     and created_at > now() - interval '24 hours';
  if v_ok >= 3 then
    return jsonb_build_object('ok', false, 'error', '该账号今天重置次数已达上限，请明天再试或联系老师协助');
  end if;

  -- ---- 找账号：手机号走 profiles.phone（唯一索引），邮箱走小写比对 ----
  select p.* into v_target
    from public.profiles p
   where (p.phone is not null and p.phone = v_ident)
      or (lower(p.email) = v_ident)
   limit 1;

  -- v_scope：账号类型范围。当前"所有账号都开放"（用户已选），故不设限。
  -- 若要收窄到只给学生，把下面两行打开：
  --   if found and v_target.identity <> 'student' then
  --     return jsonb_build_object('ok', false, 'error', '该账号请联系老师或系统管理员重置');
  --   end if;

  if not found then
    -- 账号不存在：不写尝试记录（防止随机输入灌表），文案与姓名不符完全一致
    return jsonb_build_object('ok', false, 'error', v_mismatch);
  end if;

  if btrim(lower(v_target.name)) <> lower(v_name) then
    insert into public.password_reset_attempts (identifier, user_id, succeeded)
    values (v_ident, v_target.user_id, false);
    return jsonb_build_object('ok', false, 'error', v_mismatch);
  end if;

  -- ---- 通过：写新密码 ----
  update auth.users
     set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf', 10)),
         updated_at         = now()
   where id = v_target.user_id;

  -- 旧会话全部作废（auth.refresh_tokens.session_id 是 ON DELETE CASCADE，会跟着删）
  delete from auth.sessions where user_id = v_target.user_id;

  insert into public.password_reset_attempts (identifier, user_id, succeeded)
  values (v_ident, v_target.user_id, true);

  -- 审计：自助重置没有登录者（auth.uid() 为空），detail 里记全，事后可查
  perform public.audit(
    'self_reset_password', null, null,
    jsonb_build_object(
      'user_id',    v_target.user_id,
      'identifier', v_ident,
      'name',       v_target.name,
      'identity',   v_target.identity,
      'is_admin',   v_target.is_admin,
      'school_id',  v_target.school_id
    )
  );

  -- 顺手清理：本表只服务限流与追溯，留 30 天足够（表本身很小）
  delete from public.password_reset_attempts where created_at < now() - interval '30 days';

  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.self_reset_password(text, text, text) is
  '未登录自助重置密码：手机号/邮箱 + 注册姓名 对上即可设新密码；'
  '**返回 jsonb 而不是 raise**（raise 会回滚失败计数，限流会失效，见 0073 头注）；'
  '全库唯一对 anon 开放的业务函数，改动前请读完 0072/0073 的文件头';

-- ACL：DROP 重建后必须补回来（**刻意给 anon**，全库唯一例外）
revoke all on function public.self_reset_password(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.self_reset_password(text, text, text) to anon, authenticated, service_role;

-- 自检：确认返回类型已换，且失败路径是"正常返回 ok:false"而不是抛错。
-- 用**永不可能是账号**的保留域名（.invalid，RFC 2606）走一次，不会给真实账号记失败次数。
do $$
declare
  v_res jsonb;
begin
  v_res := public.self_reset_password('self-check-no-such-user@example.invalid', '不存在的姓名测试', 'newpass123');
  if v_res->>'ok' <> 'false' then
    raise exception '失败路径没有返回 ok:false，实际：%', v_res::text;
  end if;
  if public.auth_identifier('138 0013 8000') is distinct from '13800138000' then
    raise exception 'auth_identifier 契约在本次重建后被破坏';
  end if;
end $$;
