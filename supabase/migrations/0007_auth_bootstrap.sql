-- 0007: 注册引导
-- 1) schools 对 anon 开放只读：注册页需未登录下拉选学校（名单低敏，仅名称/代码）
-- 2) 首个注册用户自动成为系统管理员：无 admin 时本账号置 is_admin
--    （约束仍在：is_admin 全局唯一。首个注册者由引导页提示"系统管理员请第一个注册"；
--     若被抢先，事后用 MCP 手动 update profiles 调换即可。）

grant select on public.schools to anon;
drop policy if exists select_anon_schools on public.schools;
create policy select_anon_schools on public.schools for select to anon using (true);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1));
  v_school uuid := nullif(new.raw_user_meta_data ->> 'school_id', '')::uuid;
  v_is_admin boolean := false;
begin
  if v_school is not null and not exists (select 1 from schools where id = v_school and is_active) then
    v_school := null;
  end if;
  -- 库中尚无任何档案时，本账号即系统管理员（首人引导）
  if not exists (select 1 from profiles) then
    v_is_admin := true;
  end if;
  insert into public.profiles (user_id, name, email, school_id, is_admin)
  values (new.id, v_name, coalesce(new.email, ''), v_school, v_is_admin)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
