-- 0074: 加固 self_reset_password（0073 的复核补丁，改四处）。
--
-- 0073 上线后逐条复核，发现四个缺陷。按严重程度：
--
-- D1（真 bug）密码上界必须按**字节**算，不是字符。
--   bcrypt 的 72 是**字节**上限，超出部分被静默丢弃（线上实测：
--   crypt(repeat('A',72)||'X', salt) = crypt(repeat('A',72)||'Y', salt) → true，
--   第 73 字节起完全不参与哈希）。而 `char_length > 72` 是按字符数判：25 个汉字
--   = 75 字节，能过检查，学生以为设了 25 位长密码，实际只有前 24 个字生效。
--   更糟的是**两条路口径分裂**：GoTrue 的 bcrypt.GenerateFromPassword 对 >72 字节
--   直接报错，所以"注册时设不出来、忘记密码却能设出来"。改用 octet_length，与 GoTrue
--   的 len(password)（Go 的 len 是字节数）完全一致，下界也一并按字节。
--
-- D2（潜在）查账号时**存放侧也要归一化**。
--   原写法 `p.phone = v_ident` 只在 profiles.phone 存 11 位纯数字时才成立。
--   而 0064 给这一列的注释写的是「E.164，形如 +8613800138000」，个人资料页绑定手机号
--   那条路一旦被用上，这个账号就会**静默失去自助重置能力**，报的还是"姓名或号码不正确"，
--   极难归因。改成两边同口径：auth_identifier(p.phone) = v_ident。
--
-- D3（体验）姓名比对加 NFKC + 去空白。
--   中文输入法下最容易打出全角空格（U+3000）与夹杂空格的姓名，而学生记的是"怎么写"，
--   不是"几个字节"。（实测 normalize('　', NFKC) = ' '，'　' 也被 \s 匹配。）
--
-- D4（小）限流记录的清理原本只在**成功路径**跑 —— 长期没人成功重置，失败日志就永不老化。
--   挪到函数最前面，两条路径都会经过。
--
-- 顺带补一个审计字段 sessions_killed：它是"是否真把别的设备踢下线"的唯一证据。
--
-- 一处**要如实说明**的边界：踢的是 auth.sessions / refresh token。**已经签发的 access
-- token 在到期前仍然有效**（Supabase 默认 1 小时），所以"改了密码 = 所有设备立刻下线"
-- 这句话不成立，最坏情况下别人的会话还能多用一小时。要彻底吊销得改 JWT 校验（引入
-- 会话状态查询，代价是每个请求多一跳），本项目不做，但文案上不要过度承诺。
--
-- 本次不改签名、不改返回类型，所以用 create or replace（**不要 DROP**：DROP 会连 ACL
-- 一起丢掉，本仓 0065 踩过）。下面仍把 ACL 重写一遍，让它成为一次显式声明而非默认值。

-- ---------------------------------------------------------------------------
-- 姓名归一化键（与 auth_identifier 并列：都是"只用于比对、不落库"的纯函数）
-- ---------------------------------------------------------------------------
create or replace function public.name_key(p_name text)
returns text
language sql
immutable
as $$
  -- NFKC：全角→半角；再去掉所有空白（含全角空格被 NFKC 转成的普通空格）；忽略大小写
  select regexp_replace(
           lower(normalize(btrim(coalesce(p_name, '')), NFKC)),
           '\s', '', 'g'
         );
$$;

comment on function public.name_key(text) is
  '姓名比对键：NFKC 归一 + 去空白 + 忽略大小写；只用于比对，不落库、不建索引';

revoke all on function public.name_key(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 主函数
-- ---------------------------------------------------------------------------
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
  v_killed int;
  v_bytes  int  := octet_length(coalesce(p_new_password, ''));
  v_mismatch constant text := '手机号/邮箱或姓名不正确，请核对注册时填写的信息';
begin
  -- 顺手清理放最前面：原来只在成功路径跑，没人成功重置时失败日志会永不老化。
  -- 本表只服务限流与追溯，留 30 天足够，且表本身很小（只有存在的账号会被记录）。
  delete from public.password_reset_attempts where created_at < now() - interval '30 days';

  -- ---- 入参格式：与"账号是否存在"无关，可以明说；不计数 ----
  if v_ident is null then
    return jsonb_build_object('ok', false, 'error', '请输入正确的手机号或邮箱');
  end if;
  if v_name = '' then
    return jsonb_build_object('ok', false, 'error', '请填写注册时使用的姓名');
  end if;
  -- **按字节判**（D1）：72 字节 ≈ 24 个汉字。用字符数会让 25 个汉字蒙混过关，
  -- 而 bcrypt 只取前 72 字节 —— 用户以为的长密码其实是截断的。
  if v_bytes < 6 then
    return jsonb_build_object('ok', false, 'error', '新密码长度至少 6 位');
  end if;
  if v_bytes > 72 then
    return jsonb_build_object('ok', false, 'error', '新密码过长：最多 72 字节（约 24 个汉字或 72 个字母）');
  end if;
  if p_new_password = v_ident or p_new_password = p_identifier then
    return jsonb_build_object('ok', false, 'error', '新密码不能与手机号/邮箱相同');
  end if;

  -- ---- 限流 ----
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

  -- ---- 找账号：**两侧同口径**归一化（D2），否则 E.164 形态的 profiles.phone 静默失配 ----
  select p.* into v_target
    from public.profiles p
   where public.auth_identifier(p.phone) = v_ident
      or lower(p.email) = v_ident
   limit 1;

  -- v_scope：账号类型范围。当前"所有账号都开放"（用户已选），故不设限。
  -- 若要收窄到只给学生：if found and v_target.identity <> 'student' then
  --   return jsonb_build_object('ok', false, 'error', v_mismatch); end if;
  -- 注意**必须用同一句 v_mismatch**：换一句专属文案等于把接口变成身份枚举器。

  if not found then
    return jsonb_build_object('ok', false, 'error', v_mismatch);
  end if;

  -- 姓名比对走 name_key（D3）：NFKC + 去空白 + 忽略大小写
  if public.name_key(v_target.name) is distinct from public.name_key(p_name) then
    insert into public.password_reset_attempts (identifier, user_id, succeeded)
    values (v_ident, v_target.user_id, false);
    return jsonb_build_object('ok', false, 'error', v_mismatch);
  end if;

  -- ---- 通过：写新密码 ----
  update auth.users
     set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf', 10)),
         updated_at         = now()
   where id = v_target.user_id;

  -- 旧会话作废（auth.refresh_tokens.session_id 是 ON DELETE CASCADE，会跟着删）。
  -- 注意 access token 到期前仍然有效，见文件头。
  delete from auth.sessions where user_id = v_target.user_id;
  get diagnostics v_killed = row_count;

  insert into public.password_reset_attempts (identifier, user_id, succeeded)
  values (v_ident, v_target.user_id, true);

  perform public.audit(
    'self_reset_password', null, null,
    jsonb_build_object(
      'user_id',         v_target.user_id,
      'identifier',      v_ident,
      'name',            v_target.name,
      'identity',        v_target.identity,
      'is_admin',        v_target.is_admin,
      'school_id',       v_target.school_id,
      'sessions_killed', v_killed
    )
  );

  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.self_reset_password(text, text, text) is
  '未登录自助重置密码：手机号/邮箱 + 注册姓名 对上即可设新密码；'
  '**返回 jsonb 而不是 raise**（raise 会回滚失败计数，限流会失效，见 0073）；'
  '密码上界按**字节**判（0074，bcrypt 截断在 72 字节）；'
  '全库唯一对 anon 开放的业务函数，改动前请读完 0072/0073/0074 的文件头';

revoke all on function public.self_reset_password(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.self_reset_password(text, text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 自检：把这次修的四条钉住
-- ---------------------------------------------------------------------------
do $$
declare
  v_res jsonb;
  v_25han text := repeat('密', 25);   -- 25 个汉字 = 75 字节，必须被拒
begin
  -- D1：上界按字节
  if octet_length(v_25han) <> 75 then
    raise exception '自检前提不成立：25 个汉字应为 75 字节，实际 %', octet_length(v_25han);
  end if;
  v_res := public.self_reset_password('self-check@example.invalid', '不存在的人', v_25han);
  if v_res->>'error' not like '新密码过长%' then
    raise exception 'D1 未生效：75 字节的密码没有被拒，实际返回 %', v_res::text;
  end if;

  -- 6 个字节的密码要放行到"找账号"那一步（而不是被长度拦住）
  v_res := public.self_reset_password('self-check@example.invalid', '不存在的人', 'abcdef');
  if (v_res->>'error') like '新密码长度%' then
    raise exception '下界误伤 6 字节密码：%', v_res::text;
  end if;

  -- D3：姓名归一化（全角空格 + 内部空格 + 全角字母）
  if public.name_key('李　四') <> public.name_key('李四') then
    raise exception 'D3 未生效：全角空格没被归一';
  end if;
  if public.name_key(' 张 三 ') <> public.name_key('张三') then
    raise exception 'D3 未生效：内部/首尾空格没被去掉';
  end if;
  if public.name_key('ＬｉＨｕａ') <> public.name_key('lihua') then
    raise exception 'D3 未生效：全角字母没被归一';
  end if;
end $$;
