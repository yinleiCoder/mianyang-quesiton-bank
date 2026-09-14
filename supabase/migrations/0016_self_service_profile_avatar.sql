-- 0016: 个人资料自助维护（姓名 / 学校 / 头像 URL）。
-- profiles 新增 avatar_url（存 OSS 对象相对 key 或完整 URL，由前端按需拼接）；
-- update_own_profile 供登录用户改自己的姓名/学校/头像：
--   · 姓名必填；
--   · 换校须目标学校存在且启用；有生效教研组长任命时禁止换校（先停用，防任命漂移）；
--   · 解除学校绑定（置空）前须已撤销学校管理员身份（user_roles 由系统管理员管理）；
--   · 邮箱改不了——邮箱是认证身份，须经 Supabase Auth updateUser（前端走 auth API）。
-- 写路径仍收口：客户端无 DML，全部经 SECURITY DEFINER RPC + require_uid() 断言。

alter table public.profiles add column if not exists avatar_url text;

create or replace function public.update_own_profile(p_name text, p_school_id uuid, p_avatar_url text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_cur profiles%rowtype;
begin
  if p_name is null or trim(p_name) = '' then
    raise exception '姓名不能为空';
  end if;
  select * into v_cur from profiles where user_id = v_uid;
  if not found then
    raise exception '档案不存在';
  end if;

  if p_school_id is distinct from v_cur.school_id then
    if p_school_id is not null then
      if not exists (select 1 from schools where id = p_school_id and is_active) then
        raise exception '目标学校不存在或已停用';
      end if;
      if exists (select 1 from approver_assignments
                 where user_id = v_uid and is_active and role = 'group_leader') then
        raise exception '你已有生效的教研组长任命，请先联系学校管理员停用后再更换学校';
      end if;
    end if;
    -- 置空学校：若担任学校管理员需先撤销（user_roles 由系统管理员管理）
    if p_school_id is null and exists (
      select 1 from user_roles where user_id = v_uid and role = 'school_admin') then
      raise exception '你仍担任学校管理员，请先联系系统管理员撤销后再解除学校绑定';
    end if;
  end if;

  update profiles
  set name = trim(p_name),
      school_id = p_school_id,
      avatar_url = nullif(trim(coalesce(p_avatar_url, '')), ''),
      updated_at = now()
  where user_id = v_uid;
end;
$$;

revoke execute on function public.update_own_profile(text, uuid, text) from public, anon;
grant execute on function public.update_own_profile(text, uuid, text) to authenticated;
