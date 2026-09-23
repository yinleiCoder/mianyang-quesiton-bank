-- 0072: 学生自助找回密码 —— 未登录状态下，凭「手机号或邮箱 + 注册时的姓名」自己设新密码。
--
-- ⚠️ **本文件的函数体已被 0073 推翻，以 0073（以及后来的 0074）为准。**
--   下面 self_reset_password 的 `returns void` + `raise exception` 是**错误示范**：
--   raise 会回滚整个事务，失败计数留不下来，限流形同虚设（端到端测试当场抓到）。
--   返回类型已改成 jsonb。将来要写"先落库、再报错"的函数，别照抄这里的写法。
--   本文件其余部分（限流表、auth_identifier、ACL 的论证）仍然有效。
--
-- 背景：0064 的头注当时如实写着「**忘记密码没有自助通道**，只能由管理员重置」，
-- 而实际情况比那句话更糟：管理员**也没有**重置手段（全库无任何写密码的函数），
-- 唯一出路是删号重注册。而学生忘密码比忘邮箱常见得多，这条通道必须补上。
--
-- ---------------------------------------------------------------------------
-- 为什么必须自己写 auth.users 的哈希，而不是调 GoTrue Admin API
-- ---------------------------------------------------------------------------
-- Supabase 官方路径（resetPasswordForEmail）走邮件：学生账号的 email 是合成地址
-- `手机号@phone.myquiz.cn`（见 lib/phone.js 顶部），**没有人收信**，此路不通；
-- 原生 phone OTP 需要短信服务商，国内不可行（0064 已论证）。Admin API 需要
-- service_role key，而本项目**没有、也不应引入**（lib/api-auth.js 的原话）。
--
-- 剩下的一条路就是 SECURITY DEFINER 直接写 auth.users.encrypted_password。
-- 上线前逐条实测过的前提（缺一条这个方案就不成立）：
--   · postgres 角色 rolbypassrls = true            → definer 函数不受 auth.users 的 RLS 阻挡
--   · has_column_privilege(postgres, auth.users, encrypted_password, UPDATE) = true
--   · 存量哈希是 bcrypt：left(encrypted_password,4) = '$2a$'、长度 60
--   · pgcrypto 已装，但位于 **extensions** schema → 函数内必须写 `extensions.crypt(...)`，
--     否则 set search_path = public 之下找不到函数（这是最容易漏的一处）
--   · 生成参数用 gen_salt('bf', 10)：成本 10 与存量一致（GoTrue 自己就是 10）
-- 本仓已有先例：admin_delete_user 同样是 SECURITY DEFINER 里直接 `delete from auth.users`。
--
-- ---------------------------------------------------------------------------
-- 安全姿态：本函数是全库唯一对 anon 开放 EXECUTE 的业务函数
-- ---------------------------------------------------------------------------
-- 其余业务 RPC 一律 `revoke execute ... from public, anon`。这条必须开——"没登录的人
-- 要能重置自己的密码"是它的全部意义。正因如此，加固是硬要求而不是可选项：
--   1) 失败限流：同一标识符 1 小时内最多 5 次失败（姓名比对失败才计数）；
--   2) 成功限流：同一标识符 24 小时内最多 3 次成功 —— 每次成功都要现算一次 bcrypt
--      （成本 10，约几十毫秒 CPU），不限次就等于给了一条廉价的 CPU 消耗通道；
--   3) 统一错误文案：账号不存在 / 姓名不匹配 对外是同一句话，不泄露账号是否存在；
--   4) 只给「存在的账号」写尝试记录 —— 拿随机手机号刷这个接口不会往表里灌一行数据；
--   5) 尝试记录表对 anon/authenticated 完全关闭（RLS 开启且无策略 + revoke all），
--      只有本 definer 函数写得进去。
--
-- 已知且接受的残留风险（写在这里，避免将来被人当成漏洞报上来）：
--   · **姓名挡不住同班同学** —— 同学之间本就知道彼此姓名。用户已知悉并选择以此换取
--     零人工；兜底是限流 + 审计（每次重置都写 audit_log，可查谁在何时重置了哪个号）。
--   · **限流本身会泄露"这个号有账号"**：同一手机号第 6 次尝试的报错文案不同。
--     这与注册接口的 "User already registered" 属同一量级的泄露，不额外收紧。
--
-- 用户已明确选择：**所有账号（含教师、学校管理员、市级专家、系统管理员）都开放自助重置**，
-- 风险以限流 + 审计兜底。若要收窄到只给学生，见函数内 v_scope 处的注释，改一行即可。
--
-- ---------------------------------------------------------------------------
-- 三个刻意的设计决定
-- ---------------------------------------------------------------------------
--   · **重置成功 = 踢掉该账号所有设备**（delete from auth.sessions，refresh_tokens 级联）：
--     密码换了，旧会话就该失效；否则"改了密码，别人挂着的会话还活着"。
--   · **重置后不在这里建会话**：本函数不签 JWT。两端客户端在成功后自己用新密码
--     signInWithPassword —— 那条路本来就是公开的，不需要任何额外权限。
--   · **手机号归一化在这里是第三条实现**（前两条：lib/phone.js 与 core/utils/phone.dart，
--     各有一套互为对齐清单的测试）。它只为"把用户输入对上已存的规范手机号"服务，
--     不产生新的存储口径，因此**必须与那两条逐条对齐**：剥 [\s\-()]、剥一个前导 +、
--     仅当长度 > 11 时剥前导 86、再要求 ^1[3-9]\d{9}$。文件末尾的自检块把这些用例钉死。

-- ===========================================================================
-- 1) 尝试记录（限流用；同时也是"谁在什么时候试过"的取证源）
-- ===========================================================================
create table if not exists public.password_reset_attempts (
  id         bigserial primary key,
  identifier text not null,               -- 归一化后的手机号或小写邮箱
  user_id    uuid references auth.users(id) on delete cascade,  -- 未命中账号时为 null
  succeeded  boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.password_reset_attempts is
  '自助重置密码的尝试记录，只服务限流与审计；对 anon/authenticated 全关，由 self_reset_password 独占写入';
comment on column public.password_reset_attempts.identifier is
  '归一化后的标识符（手机号 11 位数字 / 小写邮箱）；不命中账号的尝试**不写不计数**，避免被随机输入灌满';

create index if not exists idx_pwreset_ident on public.password_reset_attempts (identifier, created_at desc);
create index if not exists idx_pwreset_created on public.password_reset_attempts (created_at);

-- 全关：RLS 开启且不建任何策略 = 谁都读不到；再显式收回权限（Supabase 新建表默认给 anon 授权）
alter table public.password_reset_attempts enable row level security;
revoke all on public.password_reset_attempts from anon, authenticated;
revoke all on sequence public.password_reset_attempts_id_seq from anon, authenticated;

-- ===========================================================================
-- 2) 标识符归一化（口径同 lib/phone.js / core/utils/phone.dart）
-- ===========================================================================
create or replace function public.auth_identifier(p_input text)
returns text
language plpgsql
immutable
as $$
declare
  v_raw    text := btrim(coalesce(p_input, ''));
  v_digits text;
begin
  if v_raw = '' then
    return null;
  end if;

  -- 含 @ 一律按邮箱：小写化（与 toAuthIdentifier 的 `raw.toLowerCase()` 一致）
  if position('@' in v_raw) > 0 then
    return lower(v_raw);
  end if;

  -- 否则按手机号，剥离顺序与 JS/Dart 逐条一致
  v_digits := regexp_replace(v_raw, '[\s\-()]', '', 'g');
  if left(v_digits, 1) = '+' then
    v_digits := substr(v_digits, 2);
  end if;
  if left(v_digits, 2) = '86' and length(v_digits) > 11 then
    v_digits := substr(v_digits, 3);
  end if;

  return case when v_digits ~ '^1[3-9][0-9]{9}$' then v_digits end;
end;
$$;

comment on function public.auth_identifier(text) is
  '把「手机号或邮箱」归一化成可比对的形式；口径与 lib/phone.js / core/utils/phone.dart 对齐，三者改动必须同步';

-- 纯函数、只在本文件的 definer 函数里用，不对外开放
revoke all on function public.auth_identifier(text) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 3) 自助重置
-- ===========================================================================
create or replace function public.self_reset_password(
  p_identifier   text,
  p_name         text,
  p_new_password text
)
returns void
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
begin
  -- ---- 入参格式：这些错误与"账号是否存在"无关，可以明说 ----
  if v_ident is null then
    raise exception '请输入正确的手机号或邮箱';
  end if;
  if v_name = '' then
    raise exception '请填写注册时使用的姓名';
  end if;
  -- 上界 72 是 bcrypt 的截断长度：超过它的部分不会参与哈希，必须挡住，
  -- 否则用户以为设了 80 位长密码，实际只前 72 字节有效。
  if v_len < 6 or v_len > 72 then
    raise exception '新密码长度需在 6 到 72 位之间';
  end if;
  if p_new_password = v_ident or p_new_password = p_identifier then
    raise exception '新密码不能与手机号/邮箱相同';
  end if;

  -- ---- 限流：先看记录，再决定要不要继续往下走 ----
  select count(*) into v_failed
    from public.password_reset_attempts
   where identifier = v_ident
     and not succeeded
     and created_at > now() - interval '1 hour';
  if v_failed >= 5 then
    raise exception '尝试次数过多，请 1 小时后再试，或联系老师协助';
  end if;

  select count(*) into v_ok
    from public.password_reset_attempts
   where identifier = v_ident
     and succeeded
     and created_at > now() - interval '24 hours';
  if v_ok >= 3 then
    raise exception '该账号今天重置次数已达上限，请明天再试或联系老师协助';
  end if;

  -- ---- 找账号：手机号走 profiles.phone（唯一索引），邮箱走小写比对 ----
  select p.* into v_target
    from public.profiles p
   where (p.phone is not null and p.phone = v_ident)
      or (lower(p.email) = v_ident)
   limit 1;

  -- v_scope：账号类型范围。用户已选"所有账号都开放"，故此处不设限。
  -- 若要收窄到只给学生，把下面两行打开：
  --   if found and v_target.identity <> 'student' then
  --     raise exception '该账号请联系老师或系统管理员重置';
  --   end if;

  if not found then
    -- 账号不存在：不写尝试记录（防止随机输入灌表），文案与姓名不符完全一致
    raise exception '手机号/邮箱或姓名不正确，请核对注册时填写的信息';
  end if;

  if btrim(lower(v_target.name)) <> lower(v_name) then
    insert into public.password_reset_attempts (identifier, user_id, succeeded)
    values (v_ident, v_target.user_id, false);
    raise exception '手机号/邮箱或姓名不正确，请核对注册时填写的信息';
  end if;

  -- ---- 写新密码 ----
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
end;
$$;

comment on function public.self_reset_password(text, text, text) is
  '未登录自助重置密码：手机号/邮箱 + 注册姓名 对上即可设新密码；全库唯一对 anon 开放的业务函数，改动前请读完文件头';

-- ACL：**刻意给 anon**（全库唯一例外）。create or replace 不会重置 ACL，重复执行本文件是安全的。
-- 先 revoke 再 grant：Supabase 的默认权限会给 anon 一条**显式**授权，只 revoke from public 是收不掉的。
revoke all on function public.self_reset_password(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.self_reset_password(text, text, text) to anon, authenticated, service_role;

-- ===========================================================================
-- 4) 自检：把三端归一化契约钉死（纯函数、与环境无关，跑在迁移里最合适）
-- ===========================================================================
do $$
declare
  r      record;
  v_got  text;
  v_hash text;
begin
  -- 用例取自 lib/phone.js / core/utils/phone.dart 两侧测试的交集，改一处必须三处同步
  for r in
    select * from (values
      ('13800138000',           '13800138000'),
      ('138 0013 8000',         '13800138000'),
      ('138-0013-8000',         '13800138000'),
      ('(138)0013-8000',        '13800138000'),
      ('+8613800138000',        '13800138000'),
      ('8613800138000',         '13800138000'),
      ('  +86 138-0013-8000 ',  '13800138000'),
      ('1380013800',            null),   -- 10 位
      ('12800138000',           null),   -- 第二位非法
      ('861380013800',          null),   -- 剥掉 86 后只剩 10 位
      ('1380013800a',           null),
      ('',                      null),
      (null,                    null),
      ('Teacher@Example.COM',   'teacher@example.com'),
      (' Test@phone.myquiz.cn ', 'test@phone.myquiz.cn')
    ) as t(inp, want)
  loop
    v_got := public.auth_identifier(r.inp);
    if v_got is distinct from r.want then
      raise exception 'auth_identifier 契约不符：输入 % 期望 % 实际 %',
        coalesce(r.inp, '<null>'), coalesce(r.want, '<null>'), coalesce(v_got, '<null>');
    end if;
  end loop;

  -- bcrypt 自检：确认 pgcrypto 可用、格式与 GoTrue 的存量哈希一致（$2a$10$、60 字符）、
  -- 且"自己生成的哈希自己能验、错密码验不过"——写错这个前缀就没法登录，值得在迁移里钉一次
  v_hash := extensions.crypt('self-check-pw', extensions.gen_salt('bf', 10));
  if v_hash !~ '^\$2a\$10\$' or length(v_hash) <> 60 then
    raise exception 'bcrypt 生成结果与 GoTrue 存量格式不符：%', left(v_hash, 7);
  end if;
  if extensions.crypt('self-check-pw', v_hash) is distinct from v_hash then
    raise exception 'bcrypt 往返校验失败：自己生成的哈希自己验不过';
  end if;
  if extensions.crypt('wrong-pw', v_hash) = v_hash then
    raise exception 'bcrypt 校验异常：错误密码竟然通过';
  end if;
end $$;
