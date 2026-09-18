# Supabase 项目迁移清单（旧 → 新）

> **状态：已于 2026-09-18 执行完成。** 实际结果与验证记录见本文末尾「执行结果」一节。
> 两个区域与最初设想不同，已修正：旧项目在**孟买 ap-south-1**，新项目在**东京 ap-northeast-1**
> （Supabase 没有香港区；记忆里的 hkg1 是 Vercel 的区域，不是 Supabase 的）。

背景：旧项目 `jmsryficskggsruhicys`（孟买 ap-south-1，PG 17.6）**HTTP 层宕机**——
带 apikey 的真实请求返回 Cloudflare 521，面板因此显示 PostgREST / Auth 不健康；
但 **Postgres 进程本身是活的**（能查能写），所以可以绕过 HTTP 层直接导数据。

目标：新建一个项目，把 `public` + `auth` 搬过去，改环境变量指过去。

---

## 第 0 步：只有你能做的三件事

1. **新建项目**（Dashboard → New project）
   - Region 选 **Southeast Asia (Hong Kong)**，与旧项目同区（客户端与 Vercel 都在 hkg1，跨区会有额外延迟）
   - **Postgres 版本选 17**（旧库 17.6，跨大版本 dump 恢复会出问题）
   - 记下：project ref、DB 密码
2. **拿旧库的数据库密码**：旧项目 Dashboard → Project Settings → Database → Connection string。
   迁不动的只有这一个凭据 —— 有它才能跑 `pg_dump`。
3. **把两个连接串写进 `supabase-migration/.env.migration.local`**（模板见 `.env.migration.example`，
   该文件已被 `.gitignore` 排除）。别贴进聊天记录里。

连接串格式（**注意端口**）：

```
# 旧库（孟买）：HTTP 挂了但数据库活着，走区域连接池的 session 模式（5432）
OLD_DB_URL=postgresql://postgres.jmsryficskggsruhicys:<旧库密码>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
# 新库（东京）
NEW_DB_URL=postgresql://postgres.<新 ref>:<新库密码>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres
```

> **必须是 5432（session 模式），不能是 6543（transaction 模式）。**
> pg_dump 依赖会话级状态（临时表、SET），transaction 模式每次语句可能换连接，dump 会随机失败。

## 第 1 步：导出（先跑这个，它是保险）

```bash
bash supabase-migration/1-export.sh
```

产出在 `supabase-migration/backup/`：

| 文件 | 内容 | 用途 |
|---|---|---|
| `old-full.sql` | 全库结构+数据 | **保险**。旧实例万一彻底挂掉，靠它兜底 |
| `old-public.sql` | `public` schema（表/函数/策略/触发器/权限） | 灌进新库 |
| `old-auth.sql` | `auth` schema | 只挑 `users` / `identities` 灌 |

脚本会先做一次连通性自检。**连不上先别继续**，回来看是不是池子也不通了。

## 第 2 步：导入

```bash
bash supabase-migration/2-import.sh
```

脚本按顺序做：建扩展 → 灌 public → 灌 auth 用户 → 刷 PostgREST 缓存。

> ⚠️ **不要用 `--no-privileges` 导出。** 本项目靠 `0006_revoke_extra_roles.sql` 把函数对
> `anon`/`service_role` 的 EXECUTE 挨个收回了；丢掉权限就等于把这些安全加固全丢了。

## 第 3 步：新项目面板上补配置（SQL 导不出来，只能手点）

这些**不在数据库里**，dump 一定带不过去：

- **Authentication → URL Configuration**：Site URL 改 `https://myquiz.cn`，Redirect URLs 一并补
- **Authentication → Email Templates**：确认邮件 / 重置密码的中文文案
- **Authentication → Providers**：按旧项目开的一致（邮箱登录是否要求确认等）
- **Authentication → SMTP**：若旧项目配了自定义发信，这里要重配
- **JWT 有效期**：与旧项目一致
- **API Settings**：暴露的 schema（默认 `public`）——如果旧项目动过，这里要跟上

## 第 4 步：改环境变量（三处，漏一处就有一条路径连回旧库）

| 位置 | 变量 |
|---|---|
| 本机 `.env.local` | `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Vercel 项目 env | 同上（Production / Preview / Development 三套都要） |
| Flutter `config/dev.json`、`config/prod.local.json`、CI 的 `config/ci.local.json` | `SUPABASE_URL`、`SUPABASE_ANON_KEY` |

本项目**没有也不需要 `service_role` key**（见 `lib/api-auth.js` 的说明），所以没有第三个密钥要换。

## 第 5 步：⚠️ 客户端必须发新版本

`mianyang_quiz` 的 Supabase 地址是**编译期常量**：

```dart
static const String supabaseUrl = String.fromEnvironment('SUPABASE_URL');
```

也就是说**已经安装出去的客户端把旧项目地址写死了**，改环境变量对它们无效。换项目后
所有旧客户端一律连不上，必须发一版新客户端让用户升级（走现有的 GitHub Releases 检查更新链路）。

好在旧后端**本来就是挂的**，旧客户端此刻已经是坏的 —— 迁移不会让它更糟，但**你得准备好今天能发一版客户端**。

> 长期建议：新项目挂一个**自定义域名**（如 `api.myquiz.cn`）。以后再迁移只改 DNS，
> 客户端一行都不用动。这次先不折腾，但值得排上。

## 第 6 步：验证

```bash
# 1. REST 通了（应返回 200 而不是 521）
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "apikey: <新 anon key>" \
  "https://<新 ref>.supabase.co/rest/v1/questions?select=id&limit=1"

# 2. 行数对得上（对照旧库：questions 152 / auth.users 44）
```

再走一遍真实业务：用测试账号登录 → 打开题库列表 → 练习一题 → 提交。

---

# 执行结果（2026-09-18）

| 项目 | 结果 |
|---|---|
| 表 | 30 / 30 |
| 函数 | 162 自有 + 78 扩展（citext / pg_trgm）= 240 |
| 触发器 | 23 / 23 |
| RLS 策略 | 35 / 35 |
| 索引 | 107 / 107 |
| auth 用户 / 身份 | 44 / 44 |
| 数据 | questions 152、profiles 44、practice_answers 6464、audit_log 980 —— 全部一致 |
| 对象 ACL | 函数 162 + 表/视图/序列 32 + **列级 1 处**（tags 的 id/name）—— **0 差异** |
| 安全姿态 | anon 可执行函数 6（全是触发器函数）、可读表 3 —— 与旧库一致 |

## 过程中修掉的一个真问题

初次导入后新库 **anon 能执行全部 162 个函数**（旧库只有 6 个）。
新项目自带的 `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon` 会在
`CREATE FUNCTION` 时自动授权，而 pg_dump 只输出 `REVOKE ... FROM PUBLIC`、**不管 anon**
（它复现的是"结果 ACL"，默认建函数时 anon 无权限，所以认为不需要 revoke）。
于是 `0006_revoke_extra_roles.sql` 的加固整个失效，表的授权同理（32 个对象全不一致）。

修法：从**旧库**用 `aclexplode()` 反向生成精确的 REVOKE+GRANT 脚本补回去 ——
产物是 `backup/fix-acl-func.sql`（571 条）、`backup/fix-acl-rel.sql`（574 条）
和 `backup/fix-acl-col.sql`（列级授权，见下）。

### 补记（2026-09-18 迁移后发现的漏网之鱼）：列级授权不住在 relacl 里

上面的脚本只覆盖了 `proacl` / `relacl`，于是**列级授权**漏了 ——
`grant select (id, name) on public.tags to anon`（0040）存的是 `pg_attribute.attacl`，
`relacl` 里一个 anon 都看不到。更糟的是 `fix-acl-rel.sql` 里每条
`REVOKE ALL ON TABLE ...` 会把 `attacl` 的列级授权**一并清掉**
（第 3 步从 pg_dump 正确还原的那条也被它带走了），再按 relacl 授权时自然补不回来。

症状：题库页 `/bank` 报 `42501 permission denied for table tags`
（PostgREST 查 `select id, name from tags order by name`，角色 anon）。
`schools` / `subject_nodes` 没事，它们的授权是表级的、在 relacl 里。

修法与核对：`GRANT SELECT (id) ON TABLE public.tags TO anon;` + `(name)` —— 现在由
`1-export.sh` 生成 `fix-acl-col.sql`、`2-import.sh` 在 rel 脚本**之后**单独跑一趟。
核对口径要连列级一起看，别只看 relacl：

```sql
select c.relname, c.relacl, a.attname, a.attacl
from pg_class c left join pg_attribute a on a.attrelid=c.oid and a.attacl is not null
where c.relnamespace='public'::regnamespace and (c.relacl is not null or a.attacl is not null);
```

## 三个确认过、**不是**问题的点（核对时容易误判）

1. **函数 162 ≠ `pg_proc` 里的 240** —— 差的 78 个属于 citext / pg_trgm 扩展（它们装在 `public`）。
   pg_dump 本就不该导扩展自带函数。核对时要排除 `deptype='e'`。
2. **`CREATE SEQUENCE` 0 条** —— `audit_log_id_seq` 是 identity 序列，
   输出成 `ALTER TABLE ... ADD GENERATED`，要 grep `ADD GENERATED` 才找得到。
3. **结尾几条 `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` 报 permission denied** ——
   无害，新项目已由 Supabase 预置同样权限（`pg_default_acl` 逐条比对过）；
   但 `ON_ERROR_STOP=1` 会在这里中断脚本，要确认被跳过的只有这一组。

> 另一个坑：`string_agg(x, ',' order by 1)` 里的 `1` 指**外层 SELECT 的第一列**、不是聚合参数，
> 排序会静默失效，导致 ACL 比对出现一片假阳性 diff。

## 冒烟测试（全部通过）

- anon 读 `schools` → **200**，返回真实数据（盐亭县职业技术学校、三台综合高中）
- 模拟 `authenticated` 角色 → `auth.uid()` 正确解析、questions 可见 152、profiles 44、schools 9
- `admin_create_school` 对 anon → **401**（权限收口生效）
- `questions` 对 anon → **401**（正确 —— 旧库也只有 schools / classes / subject_nodes 三张对 anon 可读）

## 环境变量 / 硬编码已改

`.env.local`、`mianyang_quiz/config/dev.json`、`mianyang_quiz/config/prod.local.json`、
`mianyang_quiz/.github/workflows/release.yml`（Windows 与 Android **两处**）、`.mcp.json`。

## 遗留待办

- **Vercel 项目**的三套环境变量（Dashboard 里改，CLI 未安装）
- **新项目面板的 Auth 配置**：Site URL / Redirect URLs / 邮件模板 / Providers / **Confirm email 开关**
  （dump 导不出来，最后一项不一致会直接影响今天的注册流程）
- **轮换凭据**：新项目的 DB 密码、Secret key、service_role key 都进过对话记录
- **Flutter 客户端发新版本** —— 地址是编译期常量，已装出去的客户端写死旧项目

## 清理

`supabase-migration/.env.migration.local`（含两个库的密码）和 `backup/`（含 auth 密码哈希）
都已在 `.gitignore` 里，但**用完建议删掉本地副本**。
1-export.sh 和 2-import.sh 保留着，下次迁移能直接复用（记得先修 ACL 那步）。
