-- 0006: 授权矩阵彻底收口 —— 平台默认将函数 EXECUTE 授予 anon/service_role
-- 函数内部 auth.uid()/is_admin 断言已构成安全闭环，此处再删掉 anon/service_role 的执行权，
-- 使 authenticated 成为唯一可调用者（与 0004 的 GRANT 列表一致）。触发器与 SECURITY DEFINER
-- 内部调用均按 owner(postgres) 执行，不受影响。
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from anon, service_role', r.sig);
  end loop;
end;
$$;
