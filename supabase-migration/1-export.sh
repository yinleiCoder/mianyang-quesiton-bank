#!/usr/bin/env bash
# 从旧项目导出。
#
# 为什么不用 Supabase CLI：本机没装，而 docker 有 —— `docker run postgres:17 pg_dump` 一样能跑，
# 还省掉一次全局安装。镜像版本必须 >= 服务端版本（旧库 PG 17.6），跨大版本 pg_dump 会直接拒绝。
#
# 为什么绕开 HTTP：旧项目的 PostgREST/Auth 容器已经挂了（521），但 Postgres 进程活着，
# 所以走区域连接池的 session 模式直连 —— 这条路不经过挂掉的那一层。
set -euo pipefail

cd "$(dirname "$0")"
BACKUP=backup
mkdir -p "$BACKUP"

# 凭据从不入库的文件读入，免得出现在命令历史里
if [[ ! -f .env.migration.local ]]; then
  echo "缺少 .env.migration.local —— 见 CHECKLIST.md 第 0 步" >&2
  exit 1
fi
set -a; source .env.migration.local; set +a
: "${OLD_DB_URL:?OLD_DB_URL 未设置}"

# alpine 变体体积只有标准镜像的约 1/4，客户端工具（pg_dump/psql）完全一样
PG_IMAGE=postgres:17-alpine
# -i 是给最后一步 `psql -f -` 从管道读用的
pg() { docker run --rm -i "$PG_IMAGE" "$@"; }

echo "==> 连通性自检"
if ! pg psql "$OLD_DB_URL" -Atc "select 'ok'" | grep -q '^ok$'; then
  echo "连不上旧库。先确认连接串用的是 5432（session 模式）而不是 6543。" >&2
  exit 1
fi
pg psql "$OLD_DB_URL" -Atc "select 'server ' || current_setting('server_version')
  || ' | db ' || pg_size_pretty(pg_database_size(current_database()))"

# 1) 全库兜底。旧实例还在抖，先把整份拿到手再谈别的。
echo "==> [1/4] 全库导出（保险）→ $BACKUP/old-full.sql"
pg pg_dump "$OLD_DB_URL" --no-owner --format=plain > "$BACKUP/old-full.sql"

# 2) public：表 / 函数 / 策略 / 触发器 / 权限。
#    **不加 --no-privileges**：0006 迁移把函数对 anon/service_role 的 EXECUTE 挨个收回了，
#    丢掉权限等于把安全加固全丢回默认状态（新函数默认 PUBLIC 可执行）。
echo "==> [2/4] public schema → $BACKUP/old-public.sql"
pg pg_dump "$OLD_DB_URL" --no-owner --schema=public --format=plain > "$BACKUP/old-public.sql"

# 3) auth 只取 users / identities：
#    - data-only：新项目的 auth schema 已由平台建好，再灌一遍结构会撞
#    - --column-inserts：按列名匹配，新项目 GoTrue 版本若多/少列也不至于整段 COPY 失败
#    sessions / refresh_tokens 不搬 —— 新项目 JWT secret 不同，搬过去也验不过
echo "==> [3/4] auth.users + auth.identities → $BACKUP/old-auth-users.sql"
pg pg_dump "$OLD_DB_URL" --data-only --column-inserts --no-owner \
  --table=auth.users --table=auth.identities --format=plain > "$BACKUP/old-auth-users.sql"

# 4) 权限修复脚本（**关键，别删这一步**）
#
# pg_dump 恢复不出正确的 ACL：新项目自带
#   ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS/TABLES TO anon
# 于是每条 CREATE 都会自动给 anon 授权，而 pg_dump 只输出 REVOKE ... FROM PUBLIC、不管 anon
# （它复现的是"结果 ACL"，默认建函数时 anon 没权限，就认为不需要 revoke）。
# 结果就是 0006 那类"收回 anon/service_role"的加固**静默失效** —— 不报错，但全开着。
#
# 所以这里从旧库反向生成精确脚本：先 REVOKE 四类角色，再按旧库 proacl 逐条 GRANT 回来。
AGG="string_agg(coalesce(g.rolname,'PUBLIC') || ':' || a.privilege_type, ',' order by coalesce(g.rolname,'PUBLIC'), a.privilege_type)"
echo "==> [4/4] 生成 ACL 修复脚本 → $BACKUP/fix-acl-*.sql"
pg psql "$OLD_DB_URL" -Atc "
with f as (
  select p.oid, p.oid::regprocedure::text as sig, p.proacl
  from pg_proc p
  where p.pronamespace='public'::regnamespace
    and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
),
rev as (select format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role;', sig) stmt, sig, 0 ord from f),
gr as (
  select format('GRANT EXECUTE ON FUNCTION %s TO %s;', f.sig, coalesce(g.rolname,'PUBLIC')) stmt, f.sig, 1 ord
  from f, aclexplode(f.proacl) a left join pg_roles g on g.oid = a.grantee
  where a.privilege_type='EXECUTE'
)
select stmt from (select * from rev union all select * from gr) t order by sig, ord, stmt;" \
  > "$BACKUP/fix-acl-func.sql"

pg psql "$OLD_DB_URL" -Atc "
with r as (
  select c.relname, case when c.relkind='S' then 'SEQUENCE' else 'TABLE' end kw, c.relacl
  from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','S')
),
rev as (select format('REVOKE ALL ON %s public.%I FROM PUBLIC, anon, authenticated, service_role;', kw, relname) stmt, relname, 0 ord from r),
gr as (select format('GRANT %s ON %s public.%I TO %s;', a.privilege_type, r.kw, r.relname, coalesce(g.rolname,'PUBLIC')) stmt, r.relname, 1 ord
       from r, aclexplode(r.relacl) a left join pg_roles g on g.oid=a.grantee)
select stmt from (select * from rev union all select * from gr) t order by relname, ord, stmt;" \
  > "$BACKUP/fix-acl-rel.sql"

echo
echo "导出完成："
ls -lh "$BACKUP" | tail -n +2 | awk '{print "  " $9 "  " $5}'
echo
echo "接着跑：bash 2-import.sh"
