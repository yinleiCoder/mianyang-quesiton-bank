-- 0064: 手机号登录 —— profiles.phone、handle_new_user 支持手机号注册、手机号变更同步。
--
-- 背景：学生普遍没有邮箱、也记不住邮箱，但记得住手机号。全平台改为「邮箱或手机号」
-- **双通道**登录（不是过渡）：新学生用手机号注册，现有 44 个账号（全是邮箱，42 个 QQ 邮箱）
-- 继续用邮箱登录，老用户可在个人资料页绑定手机号后改用手机号。
--
-- 手机号的**真相源是 `auth.users.phone`**（Supabase 原生列，E.164 格式 `+8613800138000`）；
-- `profiles.phone` 只是镜像，供列表/审计展示 —— 与 `profiles.email` 的定位完全一致。
--
-- **为什么不用 Supabase 原生的 phone 认证**：启用 Phone provider 必须先配短信服务商
-- （Twilio / MessageBird / Vonage / TextLocal），而发往国内 +86 的短信要么到不了、
-- 要么需要企业资质与签名模板审批。本项目没有短信服务商，也不打算为此投入。
--
-- **实际方案：合成邮箱。** 手机号在这里的唯一作用是「一个好记的账号名」，本质是个标识符，
-- 不必占用 auth.users.phone 这一列（那一列的语义是"经短信验证过的号码"）。
-- 学生输入 `13800138000`，前端换算成 `13800138000@phone.myquiz.cn` 去 signUp/signIn。
-- 该域名由本项目自有、永不作收信用途，且邮箱确认本来就是关的（mailer_autoconfirm=true）。
--
-- 代价要如实说：
--   1. 手机号不做归属校验（谁都能拿别人号码注册）；
--   2. **忘记密码没有自助通道**，只能由管理员重置 —— 学生忘密码比忘邮箱常见得多；
--   3. 一个账号只能有一个标识符（邮箱字段只有一个），所以老用户无法"同时"用邮箱和手机号登录。
--
-- `auth.users.phone` 与下面的同步触发器仍保留：将来若真接了短信，把手机号写进
-- 原生 phone 列即可无缝切换，profile 侧不用动。

-- ---------------------------------------------------------------------------
-- 1) profiles 加 phone 列
-- ---------------------------------------------------------------------------
-- 允许多行 NULL：现有 44 个邮箱用户还没绑手机号，不能设 NOT NULL。
alter table public.profiles add column if not exists phone text;

create unique index if not exists profiles_phone_key
  on public.profiles (phone) where phone is not null;

comment on column public.profiles.phone is
  '手机号镜像（E.164，形如 +8613800138000）。真相源是 auth.users.phone，'
  '由 trg_sync_auth_phone_to_profile 同步；只在 Auth 流程内变更。';

-- ---------------------------------------------------------------------------
-- 2) handle_new_user：支持手机号注册
-- ---------------------------------------------------------------------------
-- 原来 v_name 的兜底链是 `coalesce(metadata->>'name', split_part(new.email,'@',1))`。
-- 手机号用户的 email 是 NULL，`split_part(NULL,...)` 返回 NULL，整条链断掉 →
-- 撞 `profiles.name NOT NULL`，**注册直接失败**（实测过：纯手机号 + 无 name 元数据的用户，
-- INSERT 报 `null value in column "name" violates not-null constraint`）。
-- 兜底链补上 phone，最后退到 '用户'，保证任何情况下 v_name 都非空。
--
-- 用 CREATE OR REPLACE（签名没变），ACL 不会被重置。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := coalesce(
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'name', '')), ''),
    nullif(new.phone, ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    '用户');
  -- 手机号有两个来源：原生 phone 列（将来真接短信时），或注册时随 options.data 带上来的
  -- 元数据（当前"合成邮箱"方案走的就是这条 —— 此时 auth.users.phone 是 NULL）。
  v_phone text := coalesce(
    nullif(new.phone, ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'phone', '')), ''));
  v_school uuid := nullif(new.raw_user_meta_data ->> 'school_id', '')::uuid;
  v_identity text := case
    when new.raw_user_meta_data ->> 'identity' = 'teacher' then 'teacher_pending'
    else 'student'
  end;
  v_enroll_year smallint := nullif(new.raw_user_meta_data ->> 'enroll_year', '')::smallint;
  v_major_category text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'major_category', '')), '');
  v_major text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'major', '')), '');
  v_class_name text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'class_name', '')), '');
  v_class_id uuid := nullif(new.raw_user_meta_data ->> 'class_id', '')::uuid;
  v_node uuid;
  v_cat text;
  v_cm text;
  v_cname text;
  v_is_admin boolean := false;
begin
  if v_school is not null and not exists (select 1 from schools where id = v_school and is_active) then
    v_school := null;
  end if;
  if v_enroll_year is not null and (v_enroll_year < 2000 or v_enroll_year > 2100) then
    v_enroll_year := null;
  end if;

  -- 班级优先：命中则由班级派生专业与班级名，忽略随包提交的自由文本（避免两个真相源打架）
  if v_class_id is not null then
    select c.major_node_id,
           case when n.kind = 'category' then n.name else pn.name end,
           case when n.kind = 'major'    then n.name else null end,
           c.name
      into v_node, v_cat, v_cm, v_cname
    from classes c
    join subject_nodes n on n.id = c.major_node_id
    left join subject_nodes pn on pn.id = n.parent_id
    where c.id = v_class_id and c.is_active and c.school_id = v_school;
    if not found then
      v_class_id := null;
    else
      v_major_category := v_cat;
      v_major := v_cm;
      v_class_name := v_cname;
    end if;
  end if;

  if not exists (select 1 from profiles) then
    v_is_admin := true;
  end if;
  insert into public.profiles (user_id, name, email, phone, school_id, is_admin, identity,
                               enroll_year, major_category, major, class_name,
                               major_node_id, class_id)
  values (new.id, v_name, coalesce(new.email, ''), v_phone, v_school, v_is_admin, v_identity,
          v_enroll_year, v_major_category, v_major, v_class_name,
          case when v_class_id is not null then v_node end, v_class_id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) 手机号变更同步到 profiles
-- ---------------------------------------------------------------------------
-- 0019 建了 email 的同步触发器（sync_auth_email_to_profile），这里给它配一个对称的。
-- 个人资料页绑定手机号走 supabase.auth.updateUser({ phone })，变更后立即镜像。
--
-- 注意触发器上的 `of phone` 限定：auth.users 每次登录都会更新 last_sign_in_at，
-- 不加列限定会让触发器在每次登录时都白跑一次。
create or replace function public.sync_auth_phone_to_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.phone is distinct from old.phone then
    update public.profiles set phone = nullif(new.phone, '') where user_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_auth_phone_to_profile on auth.users;
create trigger trg_sync_auth_phone_to_profile
after update of phone on auth.users
for each row execute function public.sync_auth_phone_to_profile();

-- 与 0019 同款收口：这两个函数只该由触发器调用，不给任何人 EXECUTE
revoke all on function public.sync_auth_phone_to_profile() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) auth_context 带出 phone
-- ---------------------------------------------------------------------------
-- profile 对象里已经返回 email，phone 是同一类字段（同一个 SELECT、同一个 profiles 行），
-- 加一列不增加任何往返 —— 这与「不扩 auth_context 拿角色文案」是两回事：
-- 那条讲的是为了展示教研组长/市级专家而多一次查询，这里没有多查。
--
-- 用 CREATE OR REPLACE（签名没变），ACL 不会被重置。
create or replace function public.auth_context()
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_profile  jsonb;
  v_roles    jsonb;
  v_approver boolean;
begin
  if v_uid is null then
    return null;
  end if;

  select jsonb_build_object(
           'user_id',    p.user_id,
           'name',       p.name,
           'email',      p.email,
           'phone',      p.phone,
           'school_id',  p.school_id,
           'avatar_url', p.avatar_url,
           'is_admin',   p.is_admin,
           'identity',   p.identity)
    into v_profile
  from profiles p
  where p.user_id = v_uid;

  select coalesce(jsonb_agg(r.role order by r.role), '[]'::jsonb)
    into v_roles
  from user_roles r
  where r.user_id = v_uid;

  select exists (
    select 1 from approver_assignments a
    where a.user_id = v_uid and a.is_active)
    into v_approver;

  return jsonb_build_object(
    'profile',     v_profile,
    'roles',       v_roles,
    'is_approver', v_approver);
end;
$$;
