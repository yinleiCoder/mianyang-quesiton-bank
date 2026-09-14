-- 0019: auth.users 邮箱变更同步到 profiles.email。
-- 个人资料页允许用户自助更换邮箱（经 Supabase Auth updateUser，含确认流程）。
-- profiles.email 原本只在注册时落一次快照，此处补触发器：
-- 邮箱只在 Auth 流程内变更（service_role / 用户 API），变更后立即镜像，保证列表/审计展示一致。
-- 注意：auth.identities 的 email 由 GoTrue 自行维护，此触发器不触碰。

create or replace function public.sync_auth_email_to_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where user_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_auth_email_to_profile on auth.users;
create trigger trg_sync_auth_email_to_profile
after update of email on auth.users
for each row execute function public.sync_auth_email_to_profile();

revoke all on function public.sync_auth_email_to_profile() from public, anon;
