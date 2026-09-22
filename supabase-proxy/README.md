# supabase-proxy

给 Supabase 换一个**能连得上的入口域名**。

## 现状：已上线（2026-09-22）

| 项 | 值 |
|---|---|
| Worker 脚本 | `supabase-proxy`，已部署（ES module 语法） |
| Worker 自定义域名 | `api.myquiz.cn` → `supabase-proxy`，证书已签发 |
| zone `myquiz.cn` | **active**（NS 已于 07:09Z 切到 Cloudflare，四个公共解析器都已传播） |
| zone 内记录 | `A myquiz.cn → 64.29.17.1`（**灰云**，Vercel apex）<br>`AAAA api.myquiz.cn → 100::`（橙云，挂 Worker 时自动生成） |
| 客户端 | `config/dev.json`、`config/prod.local.json` 均已指向 `https://api.myquiz.cn` |

上线当天的实测（对照的是同一时刻的老域名，它仍在被重置）：

```
curl https://api.myquiz.cn/auth/v1/health                    -> 401（要 apikey，说明链路已通）
curl -H "apikey: …" https://api.myquiz.cn/auth/v1/health     -> 200
curl -H "apikey: …" .../rest/v1/profiles                     -> 42501 permission denied（PostgREST 正常应答）
curl -H "apikey: …" .../auth/v1/token?grant_type=password    -> 400（GoTrue 走完鉴权逻辑）
curl https://myquiz.cn/                                      -> 307（网页端未受影响）
curl https://jwbczaoevrcrdqqvkfaz.supabase.co/auth/v1/health -> Connection was reset（老域名照旧被掐）
```

> **`jump_start` 扫描什么都没导入**，那条 Vercel 的 A 记录是手动重建的。
> 如果哪天要重做一遍这个 zone，**先建记录再切 NS**，否则 myquiz.cn 会直接解析不出来。

### ⚠️ 改了 `worker.js` 之后必须重新部署

线上那份是**通过 API 上传**的，**改仓库里的文件不会自动生效**，这点和普通代码不一样：

```bash
cd supabase-proxy && npx wrangler login && npx wrangler deploy   # 需要先取消 wrangler.toml 里 routes 的注释
```

或者让我用 Cloudflare MCP 重新传一次。

### 回滚

```bash
# 摘掉域名（App 立刻回到"连不上"的状态，但不会更糟）
# 用 Cloudflare API：DELETE /accounts/{account_id}/workers/domains/2389d29cea8bb9b7bc32388f1a846f21a64cbb44
```

客户端把 `SUPABASE_URL` 改回 `https://jwbczaoevrcrdqqvkfaz.supabase.co` 即可。
**会话存储 key 是钉死的（见下），改回来也不会登出任何人。**

## 为什么需要它

在国内部分线路上，TLS ClientHello 里 SNI 带 `supabase.co` 的连接会被**直接重置**。
实测证据（同一台机器、同一时刻）：

| 出口 IP | SNI = 项目域名 | SNI = `www.cloudflare.com` |
|---|---|---|
| 104.16.0.1 | **握手重置** | 200，TLS 0.80s |
| 162.159.10.1 | **握手重置** | 200，TLS 0.49s |
| 104.18.38.10 | **握手重置** | 200 |

同一个 IP、换个名字就通 —— 被针对的是**域名**，不是 IP、不是 Cloudflare、也不是本机
（本机无 TUN 网卡、无代理进程、hosts 干净、默认路由直达路由器）。手机热点正常，
说明服务端没毛病，问题在那条路径上。

而且它是**时好时坏**的（有人昨天能通、今天不通）。这比彻底封更麻烦：随机一批学生、
随机时间看到「网络连接失败」，复现不了，工单也没法闭环。

**所以这里只换入口域名，不动别的。** 换完以后客户端看到的是自己的域名，
路径、请求头、请求体全部原样转给 Supabase。

## 不代什么（重要）

App 会连三个域名，**只有一个是坏的**：

| 域名 | 用途 | 现状 | 代不代 |
|---|---|---|---|
| `<ref>.supabase.co` | 登录、读题、作答、**全部数据** | 被重置 | ✅ 只代这个 |
| `mianyang-question-bank.oss-cn-chengdu.aliyuncs.com` | 所有图片与附件 | 正常（国内直连） | ❌ 别碰 |
| `myquiz.cn` | 自己的服务端（Vercel hkg1） | 正常 | ❌ 别碰 |

**别把 OSS 也挂进来。** Worker 免费版是 **10 万次/天，全局共享**；一次刷题几十张图，
量级和 API 请求完全不是一个数量级，配额当天就能打爆 —— 而**爆了之后连登录都进不去**，
因为登录也走这个 Worker。为了省事把"能用的"和"不能用的"绑成一根绳，是这里最贵的错误。

---

## 前置：把 `myquiz.cn` 的 DNS 挪到 Cloudflare

Workers 的自定义域名要求 **zone 托管在 Cloudflare**。`myquiz.cn` 现在的 NS 在阿里云
（`dns19/dns20.hichina.com`），所以要改 NS。

**好消息是：这个 zone 几乎是空的。** 我查到的全部记录就这些：

| 类型 | 主机 | 值 | Cloudflare 里的设置 |
|---|---|---|---|
| A | `@` | `64.29.17.1` | **仅 DNS（灰云）** ← 网页端靠它，**别忘** |
| — | | （没有 MX / TXT / CNAME / CAA；`www` 和 `api` 都没有记录） | |

步骤：

1. Cloudflare → Add a site → 填 `myquiz.cn` → 选 Free 计划 → 拿到两个 NS 地址
2. **先在 Cloudflare 里把上面那条 A 记录建起来**，代理状态关掉（灰云）。
   开着橙云会让 Vercel 签不了证书，网页端会挂。
3. 回阿里云控制台 → 域名 → DNS 修改 → 把 NS 换成 Cloudflare 给的那两个
4. 等生效（通常几分钟到几小时），然后验证：
   ```bash
   nslookup myquiz.cn          # 应仍是 64.29.17.1
   ```
   并**用浏览器打开 https://myquiz.cn 确认网页端正常**。

> ⚠️ 这一步动的是**网页端正在用的域名解析**，老师随时可能在用。
> 挑低峰期做，做完立刻验。表里那条 A 记录漏了，myquiz.cn 当场打不开。

**不想动主域名的备用方案**：另注册一个便宜域名（`.top`/`.xyz` 几十块一年）专门给 API 用，
steps 完全一样，只是把本文档里所有 `api.myquiz.cn` 换成它。好处是 `myquiz.cn` 一点风险都不担。

---

## 部署 Worker

**方式一：后台粘贴**（不装任何东西）

1. Cloudflare → Workers & Pages → Create → Worker，命名 `supabase-proxy`
2. 把 `worker.js` 的内容整个粘进去，Deploy
3. Settings → Domains & Routes → **Add → Custom Domain** → 填 `api.myquiz.cn`
   （zone 已经托管在 Cloudflare，它会自己建记录和证书）

**方式二：wrangler CLI**

```bash
cd supabase-proxy
npx wrangler login
# 取消 wrangler.toml 里 routes 那三行的注释，然后：
npx wrangler deploy
```

### 验证

```bash
curl -sS https://api.myquiz.cn/auth/v1/health
# 期望：{"date":"...","description":"GoTrue is a user registration and authentication API","version":"..."}
# 拿到这个就说明 Worker 通了 —— 这条路径以前是 (35) Recv failure: Connection was reset
```

再确认一次「没被打」这件事仍然成立：把上面那条命令里的域名换回
`jwbczaoevrcrdqqvkfaz.supabase.co`，如果它还是被重置、而 `api.myquiz.cn` 正常，
说明你换的正是该换的那一层。

---

## 客户端的改动

### Flutter（`mianyang_quiz/`）

| 文件 | 改什么 |
|---|---|
| `config/dev.json` | `SUPABASE_URL` → `https://api.myquiz.cn` |
| `config/prod.local.json` | 同上（**确认 Worker 已通之后再改**，见下面的发版清单） |
| `lib/bootstrap.dart` | 钉住会话存储 key（已经改好，见文件里的注释） |

**为什么要在 `bootstrap.dart` 里钉 storage key**：SDK 默认按域名第一段算会话存储 key
（`sb-<host 第一段>-auth-token`，见 supabase_flutter 的 `supabase.dart:133`），且只在没传
`localStorage` 时才自动推导。换域名会让这个 key 从 `sb-jwbczaoevrcrdqqvkfaz-…` 变成
`sb-api-…` —— **等于把所有人的本地会话丢掉，全体被登出一次**。显式钉住旧 key 之后，
会话存储与域名解耦，这次和以后换域名用户都毫无感知。

> 那个 key 的值是**第一次上线时的域名**算出来的，**以后不要再改**。改了就是又一次全体登出。

### 网页端（本仓库）

浏览器端跑的是 `createBrowserClient`，直连 `NEXT_PUBLIC_SUPABASE_URL` —— 老师在家用宽带
会撞上同一堵墙。Vercel 环境变量改成同一个地址即可：

```
NEXT_PUBLIC_SUPABASE_URL = https://api.myquiz.cn
```

服务端函数（`regions: ["hkg1"]`，跑在香港）本来就不受影响，但建议一起换，两边口径一致。

---

## 不要做的事

- **不要加 Cache Rules / Cache API**。auth 响应被缓存会串号。
- **不要把 OSS 或 `myquiz.cn` 也挂到这个 Worker 上**（理由见开头）。
- **不要在 Worker 里做路径白名单**，也不要在这里做鉴权。
- **不要改 storage key 的值**（见上）。

## 发版前检查清单

```bash
# 1. Worker 通不通
curl -sS -o /dev/null -w "%{http_code}\n" https://api.myquiz.cn/auth/v1/health   # 期望 200

# 2. 两个配置都指向反代域名
grep SUPABASE_URL config/dev.json config/prod.local.json

# 3. 老会话还在（不该出现"升级后被登出"）
#    跑起来看一眼：升级前的账号在升级后仍是登录态
```

`prod.local.json` 只有在第 1 步过了之后才可以改 —— 改早了、又打了 tag，
**所有学生都进不去**（连登录都不行）。

## 如果哪天 `api.myquiz.cn` 也被掐

说明规则升级了（从"掐某个域名"变成按别的东西匹配）。那时候要换的是**域名**本身，
不是把 OSS 拖进来。判断方法还是那一条：同一个 IP 换个 SNI 试试。

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://www.cloudflare.com/   # Cloudflare 的 IP 还通不通
```
