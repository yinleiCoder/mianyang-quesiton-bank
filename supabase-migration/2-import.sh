#!/usr/bin/env bash
# 把 1-export.sh 的产物灌进新项目。
#
# 顺序不是随意的：**auth.users 必须先于 public**。public.profiles.id 有指向 auth.users 的外键，
# 反过来灌会整片外键失败。
set -euo pipefail

cd "$(dirname "$0")"
BACKUP=backup

if [[ ! -f .env.migration.local ]]; then
  echo "缺少 .env.migration.local —— 见 CHECKLIST.md 第 0 步" >&2
  exit 1
fi
set -a; source .env.migration.local; set +a
: "${NEW_DB_URL:?NEW_DB_URL 未设置}"

for f in old-public.sql old-auth-users.sql; do
  [[ -s "$BACKUP/$f" ]] || { echo "缺少 $BACKUP/$f —— 先跑 1-export.sh" >&2; exit 1; }
done

pg() { docker run --rm -i postgres:17-alpine "$@"; }
psql_new() { pg psql "$NEW_DB_URL" -v ON_ERROR_STOP=1 "$@"; }

echo "==> 目标库自检（必须是全新的空库，public 里不该有业务表）"
psql_new -Atc "select 'server ' || current_setting('server_version')"
psql_new -Atc "select 'public 现有业务表: ' || count(*) from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'"

echo "==> [1/5] 建扩展"
# citext 在本项目里是装在 public 的（advisors 也提示过），保持与旧库一致
psql_new -c 'create extension if not exists citext with schema public;'
psql_new -c 'create extension if not exists pg_trgm with schema public;'

echo "==> [2/5] auth 用户（users + identities）"
psql_new -f - < "$BACKUP/old-auth-users.sql"

echo "==> [3/5] public schema"
# pg_dump 会带上 `CREATE SCHEMA public;` 这类语句，而新库的 public 已存在，
# 在 ON_ERROR_STOP=1 下会直接中断。这三行对已存在的 schema 是纯 no-op，滤掉即可。
grep -vE '^(CREATE SCHEMA public;|ALTER SCHEMA public OWNER TO|COMMENT ON SCHEMA public )' \
  "$BACKUP/old-public.sql" | psql_new -f -

echo "==> [4/5] 还原权限（**最关键的一步**）"
# 不跑这步的话：新项目自带的默认权限会在 CREATE 时给 anon 自动授权，pg_dump 又不会 revoke 掉，
# 结果 0006 那类"收回 anon/service_role 执行权"的加固全部静默失效 —— 不报错，但全开着。
# 脚本由 1-export.sh 从旧库反向生成，逐对象还原成旧库的样子。
for f in fix-acl-func.sql fix-acl-rel.sql; do
  [[ -s "$BACKUP/$f" ]] || { echo "缺少 $BACKUP/$f —— 重跑 1-export.sh" >&2; exit 1; }
  psql_new -q -f - < "$BACKUP/$f" && echo "  $f  OK"
done

# 列级授权必须**最后**补：上面每条 `REVOKE ALL ON TABLE` 会把 attacl 里的列级授权一并清掉，
# 而 rel 脚本是按 relacl 还原的、根本看不见列级授权 —— tags 就这么丢过
# `anon select(id,name)`（0040），表现是题库页 42501 permission denied for table tags。
# 库里没有列级授权时这个文件是空的，跳过即可。
if [[ -s "$BACKUP/fix-acl-col.sql" ]]; then
  psql_new -q -f - < "$BACKUP/fix-acl-col.sql" && echo "  fix-acl-col.sql  OK"
else
  echo "  fix-acl-col.sql  空（旧库没有列级授权），跳过"
fi

echo "==> [5/5] 刷 PostgREST 的 schema 缓存"
psql_new -c "notify pgrst, 'reload schema';"

echo
echo "==> 行数核对（括号内为旧库的值）"
psql_new -Atc "select '  public.questions      ' || count(*) || '   (152)' from public.questions
  union all select '  auth.users            ' || count(*) || '   (44)'  from auth.users
  union all select '  public.practice_answers ' || count(*) || '   (6464)' from public.practice_answers
  union all select '  public.profiles       ' || count(*) from public.profiles"
echo
echo "导入完成。接着做 CHECKLIST.md 的第 3 步（面板配置）和第 4 步（改环境变量）。"
