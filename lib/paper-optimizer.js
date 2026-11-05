// 智能组卷的纯函数内核（可单测）。
//
// 输入：spec（约束）+ candidates（paper_ai_candidates RPC 返回的紧凑特征）。
// 输出：可直接交给编辑器 applyPlan 的 sections + 可解释的配比报告。
//
// 算法：
//   1) 按大题把目标难度配比拆成槽位；
//   2) 贪心填槽（难度匹配 + 标签覆盖 + 曝光 + 标签相似度，带固定 seed 的抖动）；
//   3) 模拟退火做交换（内层用 O(N) 的代价，成对相似度只在最终报告里精算）。
// 分值口径与 lib/paper-units.js 的 per_item/per_blank/per_sub 一致；测试里与
// expandUnits 对照，避免"优化器算出的总分和保存后的总分不是一回事"。
import { effectiveDifficultyBand, exposurePenalty } from "@/lib/item-stats"

export const DEFAULT_WEIGHTS = {
  difficulty: 1.0,
  tag: 0.6,
  exposure: 0.5,
  similarity: 0.7,
  score: 1.2,
  hard: 100,
}

const BANDS = [1, 2, 3]

function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function optionalNum(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashSeed(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function effectiveMode(mode, qtype) {
  if (mode === "per_blank" && (qtype === "fill_blank" || qtype === "composite")) return "per_blank"
  if (mode === "per_sub" && qtype === "composite") return "per_sub"
  return "per_item"
}

/** 单个候选在这道大题口径下的分值（与 paper-units 展开后的合计一致）。 */
export function itemScoreForCandidate(section, candidate) {
  const each = num(section?.score_each, 0)
  const qtype = candidate?.qtype
  const mode = effectiveMode(section?.score_mode, qtype)
  if (mode === "per_item") return each
  if (qtype === "fill_blank") return Math.max(num(candidate?.blank_count, 1), 1) * each
  const subs = Array.isArray(candidate?.subs) ? candidate.subs : []
  if (mode === "per_sub") return Math.max(subs.length, 1) * each
  let units = 0
  for (const sub of subs) {
    units += sub?.type === "fill_blank" ? Math.max(num(sub.blank_count, 1), 1) : 1
  }
  return Math.max(units, 1) * each
}

/** 把某大题的目标配比拆成 count 个难度槽位，余数按小数部分分配。 */
export function sectionTargetBands(section) {
  const count = num(section?.count, 0)
  const mix = section?.difficulty_mix ?? { 1: 0.3, 2: 0.5, 3: 0.2 }
  const raw = BANDS.map((band) => num(mix[band], 0) * count)
  const base = raw.map((value) => Math.floor(value))
  const left = count - base.reduce((sum, value) => sum + value, 0)
  const order = [0, 1, 2].sort((a, b) => raw[b] - base[b] - (raw[a] - base[a]))
  for (let i = 0; i < left; i++) base[order[i % 3]] += 1
  const bands = []
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < base[i]; j++) bands.push(BANDS[i])
  }
  return bands
}

function matchesSection(section, candidate) {
  const qtypes =
    Array.isArray(section?.qtypes) && section.qtypes.length > 0
      ? section.qtypes
      : section?.qtype
        ? [section.qtype]
        : null
  if (qtypes && !qtypes.includes(candidate?.qtype)) return false
  const diffs = Array.isArray(section?.difficulties) ? section.difficulties.map(Number) : null
  if (diffs && diffs.length > 0 && !diffs.includes(Number(candidate?.difficulty))) return false
  const tags = Array.isArray(section?.tag_ids) ? section.tag_ids : []
  if (tags.length > 0) {
    const own = Array.isArray(candidate?.tag_ids) ? candidate.tag_ids : []
    if (!tags.some((tag) => own.includes(tag))) return false
  }
  return true
}

function tagJaccard(a, b) {
  const A = new Set(Array.isArray(a) ? a : [])
  const B = new Set(Array.isArray(b) ? b : [])
  if (A.size === 0 && B.size === 0) return 0
  let inter = 0
  for (const value of A) if (B.has(value)) inter += 1
  return inter / (A.size + B.size - inter)
}

function bigrams(text) {
  const value = String(text ?? "").replace(/\s+/g, "")
  const out = new Set()
  for (let i = 0; i < value.length - 1; i++) out.add(value.slice(i, i + 2))
  return out
}

function bigramJaccard(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 && B.size === 0) return 0
  let inter = 0
  for (const value of A) if (B.has(value)) inter += 1
  return inter / (A.size + B.size - inter)
}

function similarity(a, b) {
  return 0.5 * tagJaccard(a?.tag_ids, b?.tag_ids) + 0.5 * bigramJaccard(a?.stem_text, b?.stem_text)
}

function greedyFill(spec, candidates, rng) {
  const sections = (spec?.sections ?? []).map((section, index) => ({ ...section, __index: index }))
  const selected = []
  const used = new Set()
  const warnings = []
  const requestedTags = Array.isArray(spec?.requested_tag_ids) ? spec.requested_tag_ids : []

  for (const section of sections) {
    const bands = sectionTargetBands(section)
    for (let slot = 0; slot < num(section.count, 0); slot++) {
      const targetBand = bands[slot] ?? 2
      const covered = new Set(selected.flatMap((item) => item.tag_ids ?? []))
      let best = null
      let bestCost = Infinity
      for (const candidate of candidates) {
        if (used.has(candidate.question_id) || !matchesSection(section, candidate)) continue
        const band = effectiveDifficultyBand(candidate)
        const bandCost = band === targetBand ? 0 : band === 2 || targetBand === 2 ? 0.5 : 1
        const newTags = (candidate.tag_ids ?? []).filter(
          (tag) => requestedTags.includes(tag) && !covered.has(tag)
        )
        const tagCost = requestedTags.length === 0 ? 0 : newTags.length > 0 ? 0 : 0.5
        const simMax =
          selected.length === 0
            ? 0
            : Math.max(...selected.map((item) => tagJaccard(candidate.tag_ids, item.tag_ids)))
        const cost =
          DEFAULT_WEIGHTS.difficulty * bandCost +
          DEFAULT_WEIGHTS.tag * tagCost +
          DEFAULT_WEIGHTS.exposure * exposurePenalty(candidate.uses_90d) +
          DEFAULT_WEIGHTS.similarity * simMax
        const jitter = rng() * 0.04
        if (cost + jitter < bestCost) {
          bestCost = cost + jitter
          best = candidate
        }
      }
      if (!best) {
        warnings.push(
          `大题「${section.title ?? section.qtype ?? "未命名"}」第 ${slot + 1} 题没有可用候选`
        )
        break
      }
      used.add(best.question_id)
      selected.push({
        ...best,
        sectionIndex: section.__index,
        __score: itemScoreForCandidate(section, best),
      })
    }
  }
  return { sections, selected, warnings }
}

function costParts(selected, spec) {
  const weights = { ...DEFAULT_WEIGHTS, ...(spec?.weights ?? {}) }
  const sections = spec?.sections ?? []
  let diffSum = 0
  for (let i = 0; i < sections.length; i++) {
    const items = selected.filter((item) => item.sectionIndex === i)
    const counts = { 1: 0, 2: 0, 3: 0 }
    for (const item of items) counts[effectiveDifficultyBand(item)] += 1
    const targetCounts = { 1: 0, 2: 0, 3: 0 }
    for (const band of sectionTargetBands(sections[i])) targetCounts[band] += 1
    const n = Math.max(items.length, 1)
    for (const band of BANDS) diffSum += Math.abs(counts[band] - targetCounts[band]) / n
  }
  const diffCost = sections.length ? diffSum / sections.length : 0

  const requestedTags = Array.isArray(spec?.requested_tag_ids) ? spec.requested_tag_ids : []
  const covered = new Set(selected.flatMap((item) => item.tag_ids ?? []))
  const tagCost = requestedTags.length
    ? requestedTags.filter((tag) => !covered.has(tag)).length / requestedTags.length
    : 0

  const expCost = selected.length
    ? selected.reduce((sum, item) => sum + exposurePenalty(item.uses_90d), 0) / selected.length
    : 0

  const totalScore = selected.reduce((sum, item) => sum + num(item.__score, 0), 0)
  const targetScore =
    spec?.target_score == null || spec.target_score === ""
      ? totalScore
      : num(spec.target_score, totalScore)
  const scoreCost = targetScore > 0 ? ((totalScore - targetScore) / targetScore) ** 2 : 0

  // 内层用"标签重复度"代替成对相似度：O(N) 可增量，成对相似度只在最终报告里精算。
  const tagCount = new Map()
  for (const item of selected) {
    for (const tag of item.tag_ids ?? []) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)
  }
  let overlap = 0
  for (const count of tagCount.values()) if (count > 1) overlap += count - 1
  const simCost = selected.length > 1 ? overlap / selected.length : 0

  let violations = 0
  for (let i = 0; i < sections.length; i++) {
    const items = selected.filter((item) => item.sectionIndex === i)
    const maxPerTag = optionalNum(sections[i].max_per_tag)
    if (maxPerTag != null) {
      const counts = new Map()
      for (const item of items) {
        for (const tag of item.tag_ids ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
      for (const count of counts.values()) if (count > maxPerTag) violations += count - maxPerTag
    }
    const maxPerNode = optionalNum(sections[i].max_per_node)
    if (maxPerNode != null) {
      const counts = new Map()
      for (const item of items) {
        const key = item.node_id ?? "?"
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      for (const count of counts.values()) if (count > maxPerNode) violations += count - maxPerNode
    }
  }

  const objective =
    weights.difficulty * diffCost +
    weights.tag * tagCost +
    weights.exposure * expCost +
    weights.similarity * simCost +
    weights.score * scoreCost +
    weights.hard * violations

  return { objective, diffCost, tagCost, expCost, simCost, scoreCost, violations, totalScore }
}

function anneal(spec, candidates, initial, rng, iterations) {
  let current = initial.slice()
  let currentCost = costParts(current, spec).objective
  let best = current.slice()
  let bestCost = currentCost
  const total = Math.max(1, num(iterations, 4000))
  const T0 = 0.5
  const Tend = 0.01

  for (let iter = 0; iter < total; iter++) {
    if (current.length === 0) break
    const at = Math.floor(rng() * current.length)
    const old = current[at]
    const section = (spec?.sections ?? [])[old.sectionIndex]
    if (!section) continue
    const used = new Set(current.map((item) => item.question_id))
    const pool = candidates.filter(
      (candidate) => !used.has(candidate.question_id) && matchesSection(section, candidate)
    )
    if (pool.length === 0) continue
    const replacement = pool[Math.floor(rng() * pool.length)]
    const next = current.slice()
    next[at] = {
      ...replacement,
      sectionIndex: old.sectionIndex,
      __score: itemScoreForCandidate(section, replacement),
    }
    const nextCost = costParts(next, spec).objective
    const delta = nextCost - currentCost
    const temperature = T0 * (Tend / T0) ** (iter / total)
    if (delta <= 0 || rng() < Math.exp(-delta / Math.max(temperature, 1e-6))) {
      current = next
      currentCost = nextCost
      if (nextCost < bestCost) {
        best = next.slice()
        bestCost = nextCost
      }
    }
  }
  return best
}

function report(spec, selected, warnings = [], seed = null) {
  const sections = (spec?.sections ?? []).map((section, index) => ({
    key: section.key ?? `s${index}`,
    title: section.title ?? "",
    instruction: section.instruction ?? "",
    score_mode: section.score_mode ?? "per_item",
    score_each: num(section.score_each, 0),
    qtype: section.qtype ?? null,
    qtypes: section.qtypes ?? null,
    items: selected
      .filter((item) => item.sectionIndex === index)
      .map((item) => ({
        question_id: item.question_id,
        version_id: item.version_id,
        qtype: item.qtype,
        difficulty: item.difficulty,
        node_id: item.node_id,
        node_name: item.node_name,
        tag_ids: item.tag_ids ?? [],
        tag_names: item.tag_names ?? [],
        attempts: item.attempts ?? 0,
        correct: item.correct ?? 0,
        uses_90d: item.uses_90d ?? 0,
        score: item.__score,
        effective_difficulty: effectiveDifficultyBand(item),
      })),
  }))

  const expected = (spec?.sections ?? []).map((section) => num(section.count, 0))
  const feasible = sections.every((section, index) => section.items.length === expected[index])
  const parts = costParts(selected, spec)

  let simSum = 0
  let simN = 0
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      simSum += similarity(selected[i], selected[j])
      simN += 1
    }
  }

  const requestedTags = Array.isArray(spec?.requested_tag_ids) ? spec.requested_tag_ids : []
  const covered = new Set(selected.flatMap((item) => item.tag_ids ?? []))
  const missingTags = requestedTags.filter((tag) => !covered.has(tag))
  const difficultyMix = { 1: 0, 2: 0, 3: 0 }
  for (const item of selected) difficultyMix[effectiveDifficultyBand(item)] += 1

  return {
    feasible,
    seed,
    sections,
    metrics: {
      total_score: parts.totalScore,
      target_score:
        spec?.target_score == null || spec.target_score === ""
          ? parts.totalScore
          : num(spec.target_score, parts.totalScore),
      difficulty_mix: difficultyMix,
      tag_coverage: {
        requested: requestedTags.length,
        covered: requestedTags.length - missingTags.length,
        missing: missingTags,
      },
      exposure_avg: parts.expCost,
      similarity_avg: simN > 0 ? simSum / simN : 0,
      objective: parts.objective,
      violations: parts.violations,
    },
    warnings: feasible ? warnings : [...warnings, "题量不足：方案不完整，请减少题数或放宽条件"],
  }
}

/** 生成一份组卷方案。同一 spec + seed 必得同一结果。 */
export function optimizePaperPlan(spec, candidates = [], opts = {}) {
  const seed = num(opts.seed, hashSeed(JSON.stringify(spec)))
  const rng = mulberry32(seed)
  const greedy = greedyFill(spec, candidates, rng)
  const mode = opts.mode ?? spec?.mode ?? "anneal"
  let selected = greedy.selected
  if (mode !== "greedy" && selected.length > 0) {
    selected = anneal(spec, candidates, selected, rng, num(opts.iterations, 4000))
  }
  return report(spec, selected, greedy.warnings, seed)
}

/** 逐题“换一题”：在不改变题量的前提下，选使目标函数最小的替代候选。 */
export function swapPlanItem(plan, sectionIndex, itemIndex, spec, candidates = [], opts = {}) {
  const sourceSections = plan?.sections ?? []
  if (!sourceSections[sectionIndex]?.items?.[itemIndex]) return plan

  const selected = []
  let targetFlatIndex = -1
  for (let si = 0; si < sourceSections.length; si++) {
    const section = sourceSections[si]
    for (let ii = 0; ii < (section.items ?? []).length; ii++) {
      const item = section.items[ii]
      if (si === sectionIndex && ii === itemIndex) targetFlatIndex = selected.length
      selected.push({
        ...item,
        sectionIndex: si,
        __score: num(item.score, itemScoreForCandidate(section, item)),
      })
    }
  }
  if (targetFlatIndex < 0) return plan

  const section = sourceSections[sectionIndex]
  const used = new Set(selected.map((item) => item.question_id))
  const pool = candidates.filter(
    (candidate) => !used.has(candidate.question_id) && matchesSection(section, candidate)
  )
  if (pool.length === 0) return plan

  let best = null
  let bestCost = Infinity
  for (const candidate of pool) {
    const next = selected.slice()
    next[targetFlatIndex] = {
      ...candidate,
      sectionIndex,
      __score: itemScoreForCandidate(section, candidate),
    }
    const cost = costParts(next, spec).objective
    if (cost < bestCost) {
      bestCost = cost
      best = next
    }
  }
  if (!best) return plan
  return report(spec, best, ["已替换 1 题，请重新查看配比"], opts.seed ?? plan.seed ?? null)
}
