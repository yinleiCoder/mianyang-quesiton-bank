-- 0041: 一次往返取回鉴权上下文（档案 + 角色 + 生效任命）。
-- 动机：lib/auth.js 原本是 3 次串行往返（getUser → profiles → Promise.all(roles, assignments)），
-- 每跳 170–460ms，是每次页面加载的固定开销（实测 /auth/v1/user 172 次/24h、均值 282ms）。
--
-- 为什么不用 PostgREST 的嵌套 select：profiles / user_roles / approver_assignments 的 user_id
-- 都指向 auth.users，三张表彼此之间没有外键，PostgREST 探测不到关系，嵌不出来。
--
-- 为什么 security definer 是安全的：函数体内只用 auth.uid() 取「调用者自己」的行，
-- 与外层 RLS 的口径等价（等于把三条本人可见的查询合并成一次），不存在读他人的路径。
-- 与 practice_dashboard(0031) 同一取舍。**不要给本函数加参数**，否则这一点要重新论证。
--
-- 未登录返回 json null（不 raise）：调用方据此判定未登录，与「真出错」区分开。
-- 未登录本来也调不到：execute 只授给 authenticated。

create or replace function public.auth_context()
returns jsonb
language plpgsql
stable
security definer
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

  -- 档案行可能缺失（理论上有 handle_new_user 兜底）。这里不当未登录处理：
  -- 保持既有语义「user 有值、profile 为空」，避免把人踢去登录页。
  select jsonb_build_object(
           'user_id',    p.user_id,
           'name',       p.name,
           'email',      p.email,
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

  -- 组长/专家身份只落在 approver_assignments（user_roles 不镜像），按生效任命判定入口
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

revoke execute on function public.auth_context() from public, anon;
grant execute on function public.auth_context() to authenticated;
