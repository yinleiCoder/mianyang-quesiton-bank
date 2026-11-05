// 抽题策略回测（只读，不写库）。
//
// 没有 service role key，所以用测试学生账号登录，RLS 只让他读自己的作答。
// 回放方式：按历史 session 时间顺序，在当前状态下分别让 FSRS 混合与旧 0099
// 策略各提一次题（只评估提议集），再用**实际作答**更新共享的 FSRS/BKT 状态。
//
// 运行：
//   BACKTEST_EMAIL=18282554435@phone.myquiz.cn BACKTEST_PASSWORD=... npm run backtest:practice
import fs from "node:fs"
import { createClient } from "@supabase/supabase-js"
import {
  bktAfter,
  bktInfoGain,
  beijingDayKey,
  daysBetween,
  fsrsInitial,
  fsrsInterval,
  fsrsNext,
  fsrsRetrievability,
  guessProbability,
  legacyDueAt,
} from "@/lib/practice-scheduler-reference"

const DAY = 86400000

function loadEnv() {
  const file = ".env.local"
  const env = {}
  if (!fs.existsSync(file)) return env
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "")
  }
  return env
}

function requireEnv(name, fallback) {
  const value = process.env[name] || fallback
  if (!value) throw new Error(`缺少 ${name}`)
  return value
}

async function fetchAll(supabase, table, select, applyFilter) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    let query = supabase.from(table).select(select).range(from, from + 999)
    if (applyFilter) query = applyFilter(query)
    const { data, error } = await query
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return rows
}

function percent(part, total) {
  return total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "—"
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

const env = loadEnv()
const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", env.NEXT_PUBLIC_SUPABASE_URL)
const anon = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const email = requireEnv("BACKTEST_EMAIL")
const password = requireEnv("BACKTEST_PASSWORD")

const supabase = createClient(url, anon, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const { data: auth, error: authError } = await supabase.auth.signInWithPassword({ email, password })
if (authError) throw new Error(`登录失败：${authError.message}`)
const user = auth.user
console.log(`user=${user.id} sessions loading…`)

const [answers, sessions, sessionItems, questions, versions, versionTags, nodes] =
  await Promise.all([
    fetchAll(supabase, "practice_answers", "session_id, question_id, is_correct, answered_at, grading",
      (q) => q.eq("user_id", user.id).order("answered_at")),
    fetchAll(supabase, "practice_sessions", "id, started_at, scored",
      (q) => q.eq("user_id", user.id).order("started_at")),
    fetchAll(supabase, "practice_session_items", "session_id, question_id"),
    fetchAll(supabase, "questions", "id, course_node_id, current_published_version_id, state",
      (q) => q.eq("state", "live")),
    fetchAll(supabase, "question_versions", "id, question_id, qtype, difficulty, content",
      (q) => q.eq("status", "published")),
    fetchAll(supabase, "version_tags", "version_id, tag_id"),
    fetchAll(supabase, "subject_nodes", "id, name"),
  ])

const versionById = new Map(versions.map((version) => [version.id, version]))
const tagsByVersion = new Map()
for (const tag of versionTags) {
  const list = tagsByVersion.get(tag.version_id) ?? []
  list.push(tag.tag_id)
  tagsByVersion.set(tag.version_id, list)
}
const nodeName = new Map(nodes.map((node) => [node.id, node.name]))

const pool = questions
  .map((question) => {
    const version = versionById.get(question.current_published_version_id)
    if (!version) return null
    const options = Array.isArray(version.content?.options) ? version.content.options : []
    return {
      question_id: question.id,
      version_id: version.id,
      qtype: version.qtype,
      difficulty: version.difficulty ?? 2,
      option_count: options.length,
      tag_ids: tagsByVersion.get(version.id) ?? [],
      node_name: nodeName.get(question.course_node_id) ?? "",
    }
  })
  .filter(Boolean)
const poolById = new Map(pool.map((item) => [item.question_id, item]))
console.log(`sessions=${sessions.length} answers=${answers.length} pool=${pool.length}`)

// 全局题目正确率（BKT 先验），RPC 一次最多 200 个 id。
const accuracy = new Map()
for (let i = 0; i < pool.length; i += 200) {
  const ids = pool.slice(i, i + 200).map((item) => item.question_id)
  const { data, error } = await supabase.rpc("question_accuracy", { p_question_ids: ids })
  if (error) throw new Error(`question_accuracy: ${error.message}`)
  for (const row of data ?? []) accuracy.set(row.question_id, row)
}

const answersBySession = new Map()
for (const answer of answers) {
  const list = answersBySession.get(answer.session_id) ?? []
  list.push(answer)
  answersBySession.set(answer.session_id, list)
}
const itemCountBySession = new Map()
for (const item of sessionItems) {
  itemCountBySession.set(item.session_id, (itemCountBySession.get(item.session_id) ?? 0) + 1)
}

function createState(questionId) {
  const stats = accuracy.get(questionId)
  const attempts = Number(stats?.attempts) || 0
  const correct = Number(stats?.correct) || 0
  const item = poolById.get(questionId)
  const g = guessProbability(item?.qtype, item?.option_count)
  const p0 = Math.min(0.9, Math.max(0.05, (correct + 0.6) / (attempts + 2)))
  return {
    p: p0,
    g,
    fsrs: null,
    legacy: { streak: 0, last: null },
    lastDay: null,
  }
}

function classify(item, st, sessionStart) {
  if (!st.fsrs) return 0
  const elapsed = daysBetween(st.fsrs.last, sessionStart)
  const dueAt = new Date(st.fsrs.last).getTime() + fsrsInterval(st.fsrs.stability, 0.9) * DAY
  if (dueAt <= new Date(sessionStart).getTime()) return 1
  if (st.fsrs.stability >= 30 && st.p >= 0.8) return 3
  return 2
}

function score(item, st, exposure, sessionStart, mode = "balanced") {
  const elapsed = st.fsrs ? daysBetween(st.fsrs.last, sessionStart) : 0
  const r = st.fsrs ? fsrsRetrievability(st.fsrs.stability, elapsed) : 0.5
  const pCorrect = st.p * 0.9 + (1 - st.p) * st.g
  const info = st.fsrs ? bktInfoGain(st.p, st.g) : 0.2
  const coverage = 1 - Math.min(1, (exposure.get(item.question_id) ?? 0) / 2)
  const tier = classify(item, st, sessionStart)
  const need = Math.max(0, (0.8 - st.p) / 0.8)
  const zpdCenter = mode === "challenge" ? 0.55 : 0.7
  const zpd = Math.exp(-((pCorrect - zpdCenter) ** 2) / (2 * 0.15 * 0.15))
  const freshness = tier === 0 ? 0.06 : 0
  const penalty =
    tier === 0 && st.exposureRecent ? 0.1 : 0
  return (
    0.38 * (1 - r) +
    0.22 * need +
    0.14 * zpd +
    0.10 * Math.min(1, Math.max(0, info / Math.log(2))) +
    0.10 * coverage +
    freshness -
    penalty
  )
}

function choose(items, count) {
  return items.sort((a, b) => b.score - a.score).slice(0, count)
}

function proposeFsrs(sessionStart, limit, state, exposure) {
  const sessionDay = beijingDayKey(sessionStart)
  const ranked = []
  for (const item of pool) {
    const st = state.get(item.question_id) ?? createState(item.question_id)
    state.set(item.question_id, st)
    if (st.lastDay === sessionDay) continue
    ranked.push({ item, st, tier: classify(item, st, sessionStart), score: score(item, st, exposure, sessionStart) })
  }
  const newPool = ranked.filter((row) => row.tier === 0)
  const duePool = ranked.filter((row) => row.tier === 1)
  const newFloor = Math.min(newPool.length, Math.max(1, Math.round(limit * 0.4)))
  const dueQuota = Math.min(duePool.length, Math.max(1, Math.round(limit * 0.3)))
  const masteredCap = Math.max(1, Math.round(limit * 0.1))
  newPool.sort((a, b) =>
    (exposure.get(a.item.question_id) ?? 0) - (exposure.get(b.item.question_id) ?? 0) ||
    (a.st.lastDay ?? "").localeCompare(b.st.lastDay ?? "") ||
    a.item.question_id.localeCompare(b.item.question_id)
  )
  duePool.sort((a, b) => {
    const ra = a.st.fsrs ? fsrsRetrievability(a.st.fsrs.stability, daysBetween(a.st.fsrs.last, sessionStart)) : 0.5
    const rb = b.st.fsrs ? fsrsRetrievability(b.st.fsrs.stability, daysBetween(b.st.fsrs.last, sessionStart)) : 0.5
    return ra - rb || a.item.question_id.localeCompare(b.item.question_id)
  })
  const newPicked = newPool.slice(0, newFloor)
  const duePicked = duePool.slice(0, dueQuota)
  const used = new Set([...newPicked, ...duePicked].map((row) => row.item.question_id))
  const filler = ranked.filter((row) => !used.has(row.item.question_id) && row.tier !== 3).sort((a, b) => b.score - a.score)
  const mastered = ranked.filter((row) => !used.has(row.item.question_id) && row.tier === 3).sort((a, b) => b.score - a.score)
  const remaining = Math.max(0, limit - newPicked.length - duePicked.length)
  const picked = [...newPicked, ...duePicked, ...filler.slice(0, remaining)]
  if (picked.length < limit) {
    picked.push(...mastered.slice(0, Math.min(masteredCap, limit - picked.length)))
  }
  return {
    items: picked.map((row) => row.item),
    newCount: picked.filter((row) => row.tier === 0).length,
    dueCount: picked.filter((row) => row.tier === 1).length,
    oldCount: picked.filter((row) => row.tier > 0).length,
    dueAvailable: duePool.length,
    dueQuota,
    masteredPicked: picked.filter((row) => row.tier === 3).length,
    masteredCap,
  }
}

function proposeLegacy(sessionStart, limit, state, exposure) {
  const sessionDay = beijingDayKey(sessionStart)
  const due = []
  const fresh = []
  const prior = []
  for (const item of pool) {
    const st = state.get(item.question_id) ?? createState(item.question_id)
    state.set(item.question_id, st)
    if (st.lastDay === sessionDay) continue
    if (!st.legacy.last) {
      fresh.push(item)
      continue
    }
    const dueAt = legacyDueAt(st.legacy.last, st.legacy.streak)
    if (new Date(dueAt).getTime() <= new Date(sessionStart).getTime()) due.push({ item, dueAt })
    else prior.push({ item, last: st.legacy.last })
  }
  const dueQuota = Math.min(due.length, Math.max(1, Math.round(limit * 0.3)))
  due.sort((a, b) => a.dueAt.localeCompare(b.dueAt))
  fresh.sort((a, b) => a.question_id.localeCompare(b.question_id))
  prior.sort((a, b) => a.last.localeCompare(b.last))
  const picked = [
    ...due.slice(0, dueQuota).map((row) => row.item),
    ...fresh,
    ...due.slice(dueQuota).map((row) => row.item),
    ...prior.map((row) => row.item),
  ].slice(0, limit)
  return {
    items: picked,
    newCount: picked.filter((item) => !(state.get(item.question_id)?.legacy.last)).length,
    dueCount: picked.filter((item) => {
      const st = state.get(item.question_id)
      return st.legacy.last && new Date(legacyDueAt(st.legacy.last, st.legacy.streak)) <= new Date(sessionStart)
    }).length,
    oldCount: picked.filter((item) => state.get(item.question_id)?.legacy.last).length,
    dueAvailable: due.length,
    dueQuota,
  }
}

function applyAnswer(answer, state) {
  const st = state.get(answer.question_id) ?? createState(answer.question_id)
  state.set(answer.question_id, st)
  const correct = answer.is_correct === true
  const auto = answer.grading === "auto"
  // 先用**作答前**的状态算预测，再更新；反过来会把 R 算成 1、Brier 全是 0。
  const fsrsPrediction =
    auto && st.fsrs
      ? fsrsRetrievability(st.fsrs.stability, daysBetween(st.fsrs.last, answer.answered_at))
      : null
  const bktPrediction = auto ? st.p * 0.9 + (1 - st.p) * st.g : null

  if (auto) {
    if (!st.fsrs) st.fsrs = { ...fsrsInitial(correct ? 3 : 1), last: answer.answered_at, reviews: 1 }
    else {
      const next = fsrsNext(st.fsrs.stability, st.fsrs.difficulty, daysBetween(st.fsrs.last, answer.answered_at), correct)
      st.fsrs = { ...next, last: answer.answered_at, reviews: st.fsrs.reviews + 1 }
    }
    st.p = bktAfter(st.p, correct, st.g)
  }
  st.legacy.streak = correct ? st.legacy.streak + 1 : 0
  st.legacy.last = answer.answered_at
  st.lastDay = beijingDayKey(answer.answered_at)
  return { fsrsPrediction, bktPrediction }
}

const orderedSessions = sessions
  .filter((session) => (answersBySession.get(session.id) ?? []).length > 0)
  .sort((a, b) => new Date(a.started_at) - new Date(b.started_at))

const state = new Map()
const policy = {
  fsrs: { exposure: new Map(), first: new Map(), items: 0, newCount: 0, dueCount: 0, oldCount: 0, dueAvailable: 0, dueQuotaSum: 0, series: 0 },
  legacy: { exposure: new Map(), first: new Map(), items: 0, newCount: 0, dueCount: 0, oldCount: 0, dueAvailable: 0, dueQuotaSum: 0, series: 0 },
}
const fsrsErrors = []
const bktErrors = []
const bktOnFsrsErrors = []

orderedSessions.forEach((session, sessionIndex) => {
  const sessionAnswers = (answersBySession.get(session.id) ?? []).sort(
    (a, b) => new Date(a.answered_at) - new Date(b.answered_at)
  )
  const limit = Math.max(1, Math.min(100, itemCountBySession.get(session.id) || sessionAnswers.length))

  for (const key of ["fsrs", "legacy"]) {
    const result = key === "fsrs"
      ? proposeFsrs(session.started_at, limit, state, policy[key].exposure)
      : proposeLegacy(session.started_at, limit, state, policy[key].exposure)
    const bucket = policy[key]
    bucket.series += 1
    bucket.items += result.items.length
    bucket.newCount += result.newCount
    bucket.dueCount += result.dueCount
    bucket.oldCount += result.oldCount
    bucket.dueAvailable += result.dueAvailable
    bucket.dueQuotaSum += result.dueQuota ?? 0
    for (const item of result.items) {
      bucket.exposure.set(item.question_id, (bucket.exposure.get(item.question_id) ?? 0) + 1)
      if (!bucket.first.has(item.question_id)) bucket.first.set(item.question_id, sessionIndex)
    }
  }

  for (const answer of sessionAnswers) {
    const prediction = applyAnswer(answer, state)
    const actual = answer.is_correct ? 1 : 0
    if (prediction.fsrsPrediction != null) {
      fsrsErrors.push((prediction.fsrsPrediction - actual) ** 2)
      if (prediction.bktPrediction != null) {
        bktOnFsrsErrors.push((prediction.bktPrediction - actual) ** 2)
      }
    }
    if (prediction.bktPrediction != null) {
      bktErrors.push((prediction.bktPrediction - actual) ** 2)
    }
  }
})

console.log(`\nsessions=${orderedSessions.length} answers=${answers.length} pool=${pool.length}`)
console.log("policy   proposed  new%    due%   old%   distinct  coverage  maxWait  never  dueFill")
for (const key of ["fsrs", "legacy"]) {
  const bucket = policy[key]
  const distinct = bucket.first.size
  const waits = [...bucket.first.values()]
  const never = pool.length - distinct
  console.log(
    `${key.padEnd(7)} ${String(bucket.items).padStart(8)}  ${percent(bucket.newCount, bucket.items).padStart(6)}  ${percent(bucket.dueCount, bucket.items).padStart(5)}  ${percent(bucket.oldCount, bucket.items).padStart(5)}  ${String(distinct).padStart(8)}  ${percent(distinct, pool.length).padStart(7)}  ${String(waits.length ? Math.max(...waits) : 0).padStart(6)}  ${String(never).padStart(5)}  ${percent(Math.min(bucket.dueCount, bucket.dueQuotaSum), bucket.dueQuotaSum || 1).padStart(6)}`
  )
}
console.log(`\nBrier FSRS: ${mean(fsrsErrors)?.toFixed(4) ?? "—"} (n=${fsrsErrors.length})`)
console.log(`Brier BKT:  ${mean(bktErrors)?.toFixed(4) ?? "—"} (n=${bktErrors.length}, 全量)`)
console.log(`Brier BKT:  ${mean(bktOnFsrsErrors)?.toFixed(4) ?? "—"} (n=${bktOnFsrsErrors.length}, 与 FSRS 同口径子集)`)
