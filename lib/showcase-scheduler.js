// 「科学抽题算法动画」的数据入口：尺寸、分镜时间轴，以及**用真实公式预算好的数组**。
//
// 纯数据模块：不要 import React / Remotion / lucide —— 与 lib/showcase-animation.js 同规矩。
//
// 画面上的每个数字都来自 lib/practice-scheduler-reference.js（0125/0126 的逐条复刻），
// 不是为了让曲线好看编出来的。改生产算法时这里跟着变，动画就自动跟着变。
//
// 口径提醒（写文案时别讲反，详见 0125/0126 的头部注释）：
//   · 40/30/10 是保底 / 配额 / 上限，不是固定配比；
//   · 目标保持率 90% 是"把 stability 当天数用"实现的（R(S,S)=0.9），
//     生产的 practice_fsrs_interval 没有调用方，别把它当主线索；
//   · 只有客观题进 FSRS/BKT；"已掌握"是启发式（S≥30 且掌握度≥0.80），不是状态位。
import {
  bktAfter,
  bktInfoGain,
  fsrsInitial,
  fsrsNext,
  fsrsRetrievability,
} from "./practice-scheduler-reference.js"

export const SCHEDULER_VIDEO = { fps: 30, width: 1920, height: 1080 }

export const SCHEDULER_FONT =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", system-ui, sans-serif'

// 生产口径的常量（0126 / 0125 / 0122）——动画与文字解释共用这一份。
export const SCHEDULER_CONSTANTS = {
  newFloor: 0.4,
  dueQuota: 0.3,
  masteredCap: 0.1,
  masteredStability: 30,
  masteredMastery: 0.8,
  maxIntervalDays: 180,
  targetRetention: 0.9,
  bktSlip: 0.1,
  bktTransition: 0.15,
  bktWindowDays: 365,
  bktMaxItems: 600,
}

// 分镜：连续排列，最后一项的 from + duration 必须等于总帧数。
const CHAPTERS = [
  { id: "intro", label: "片头", duration: 105 },
  { id: "why", label: "随机抽的毛病", duration: 360 },
  { id: "fsrs", label: "FSRS 记忆模型", duration: 420 },
  { id: "curve", label: "遗忘曲线", duration: 330 },
  { id: "fsrsUpdate", label: "答对与答错", duration: 420 },
  { id: "bkt", label: "BKT 掌握度", duration: 420 },
  { id: "bktUpdate", label: "一次作答更新", duration: 390 },
  { id: "score", label: "五项打分", duration: 390 },
  { id: "mix", label: "40 / 30 / 10", duration: 420 },
  { id: "science", label: "科学性", duration: 330 },
  { id: "outro", label: "片尾", duration: 150 },
]

export const SCHEDULER_SCENES = (() => {
  let from = 0
  return CHAPTERS.map((chapter) => {
    const scene = { ...chapter, from }
    from += chapter.duration
    return scene
  })
})()

export const SCHEDULER_DURATION = SCHEDULER_SCENES.reduce(
  (total, scene) => Math.max(total, scene.from + scene.duration),
  0
)

export function sceneOf(id) {
  return SCHEDULER_SCENES.find((scene) => scene.id === id) ?? null
}

// ── FSRS：遗忘曲线族 ───────────────────────────────────────────────
// 同一道题在不同记忆稳定性下，保持率随天数怎么掉。
// R(t,S) = (1 + F·t/S)^(-w20)，F = 0.9^(-1/w20) - 1（0125:42-57）。
const CURVE_STABILITIES = [1, 3, 10, 30, 90]
const CURVE_MAX_DAY = 60
const CURVE_STEP = 1

export const FORGETTING_CURVES = CURVE_STABILITIES.map((stability) => {
  const points = []
  for (let day = 0; day <= CURVE_MAX_DAY; day += CURVE_STEP) {
    points.push({ day, r: fsrsRetrievability(stability, day) })
  }
  return { stability, points }
})

// 90% 保持率这条目标线：R 掉到 0.9 的那一天恰好等于 stability（R(S,S)=0.9）。
export const RETENTION_MARKERS = CURVE_STABILITIES.map((stability) => ({
  stability,
  day: stability,
  r: fsrsRetrievability(stability, stability),
}))

// ── FSRS：连续答对的间隔阶梯 ───────────────────────────────────────
// 模拟"每次都在到期那天答对"：初始 S=w3（答对 Good），到期日 = round(S) 天，
// 上限 180 天（0125:203-206）。答错分支单独算。
const LADDER_STEPS = 6

function clampInterval(stability) {
  return Math.min(
    SCHEDULER_CONSTANTS.maxIntervalDays,
    Math.max(1, Math.round(stability))
  )
}

export const FSRS_LADDER = (() => {
  const first = fsrsInitial(3)
  let stability = first.stability
  let difficulty = first.difficulty
  const steps = [{ step: 0, day: 0, stability, difficulty, interval: clampInterval(stability) }]
  let day = 0
  for (let step = 1; step <= LADDER_STEPS; step += 1) {
    const interval = clampInterval(stability)
    day += interval
    const next = fsrsNext(stability, difficulty, interval, true)
    stability = next.stability
    difficulty = next.difficulty
    steps.push({ step, day, stability, difficulty, interval: clampInterval(stability) })
  }
  return steps
})()

// 答错一次：从阶梯里某一级掉到哪里（用来做对比动画）。
export const FSRS_WRONG_FROM = 3
export const FSRS_WRONG_RESULT = (() => {
  const source = FSRS_LADDER[FSRS_WRONG_FROM]
  const next = fsrsNext(source.stability, source.difficulty, source.interval, false)
  return {
    before: source.stability,
    after: next.stability,
    difficultyBefore: source.difficulty,
    difficultyAfter: next.difficulty,
    intervalBefore: clampInterval(source.stability),
    intervalAfter: clampInterval(next.stability),
  }
})()

// ── BKT：一次作答前后 ─────────────────────────────────────────────
// p' = 后验 + (1 - 后验)·t，p_S=0.10 / p_T=0.15（0122）。
// 猜对率取四选一的 0.25，与 guessProbability('single_choice', 4) 一致。
export const BKT_GUESS = 0.25
const BKT_START = 0.5

export const BKT_BRANCHES = {
  start: BKT_START,
  correct: bktAfter(BKT_START, true, BKT_GUESS),
  wrong: bktAfter(BKT_START, false, BKT_GUESS),
}

export const BKT_LADDER = (() => {
  const corrects = []
  let p = BKT_START
  for (let i = 0; i < 4; i += 1) {
    p = bktAfter(p, true, BKT_GUESS)
    corrects.push({ attempt: i + 1, p })
  }
  const wrongs = []
  p = BKT_START
  for (let i = 0; i < 4; i += 1) {
    p = bktAfter(p, false, BKT_GUESS)
    wrongs.push({ attempt: i + 1, p })
  }
  return { corrects, wrongs }
})()

// 信息增益：H(p) - E[H(后验)]，越接近 p=0.5 越"长见识"。
export const BKT_INFO_CURVE = (() => {
  const points = []
  for (let step = 1; step < 100; step += 1) {
    const p = step / 100
    points.push({ p, gain: bktInfoGain(p, BKT_GUESS) })
  }
  return points
})()

export const BKT_INFO_PEAK = BKT_INFO_CURVE.reduce(
  (best, point) => (point.gain > best.gain ? point : best),
  BKT_INFO_CURVE[0]
)

// ── 打分：四道待选题目 ────────────────────────────────────────────
// balanced 模式的真实权重（0126:80-89）。新题在 practice_plan 里用中性特征：
// mastery 0.5 / p_correct 0.5 / info_gain 0.2 / R 0.5（0126:64-67）。
export const SCORE_WEIGHTS = { r: 0.38, need: 0.22, zpd: 0.14, info: 0.1, coverage: 0.1 }

export function balancedScore({ r, mastery, pCorrect, infoGain, exposure }) {
  const need = Math.max(0, (0.8 - mastery) / 0.8)
  const zpd = Math.exp(-Math.pow(pCorrect - 0.7, 2) / (2 * 0.15 * 0.15))
  const info = Math.min(1, Math.max(0, infoGain / Math.LN2))
  const coverage = 1 - Math.min(1, exposure / 2)
  return {
    r: SCORE_WEIGHTS.r * (1 - r),
    need: SCORE_WEIGHTS.need * need,
    zpd: SCORE_WEIGHTS.zpd * zpd,
    info: SCORE_WEIGHTS.info * info,
    coverage: SCORE_WEIGHTS.coverage * coverage,
    total:
      SCORE_WEIGHTS.r * (1 - r) +
      SCORE_WEIGHTS.need * need +
      SCORE_WEIGHTS.zpd * zpd +
      SCORE_WEIGHTS.info * info +
      SCORE_WEIGHTS.coverage * coverage,
  }
}

// 四道候选：一道新题、一道到期、一道薄弱、一道已掌握。
const SUSPECTS = [
  { id: "new", label: "没做过的新题", reason: "new_item", r: 0.5, mastery: 0.5, pCorrect: 0.5, infoGain: 0.2, exposure: 0 },
  { id: "due", label: "今天到期", reason: "due_review", r: 0.62, mastery: 0.72, pCorrect: 0.78, infoGain: 0.18, exposure: 1 },
  { id: "weak", label: "薄弱知识点", reason: "weak_node", r: 0.88, mastery: 0.38, pCorrect: 0.52, infoGain: 0.41, exposure: 1 },
  { id: "mastered", label: "已经掌握", reason: "mastered", r: 0.96, mastery: 0.91, pCorrect: 0.94, infoGain: 0.04, exposure: 2 },
]

export const SCORE_SUSPECTS = SUSPECTS.map((item) => ({
  ...item,
  parts: balancedScore(item),
})).sort((a, b) => b.parts.total - a.parts.total)

// 与 Flutter 端 lib/entity/practice_reason.dart 的 practiceReasonLabel 同口径。
export const REASON_LABELS = {
  new_item: "新题：还没练过，先建立印象",
  due_review: "到了复习时间：FSRS 预计今天会忘",
  weak_node: "薄弱知识点：掌握度偏低",
  high_info: "信息量大：一题抵几题",
  consolidate: "巩固：刚够得着，练完正好",
  mastered: "巩固题：已掌握，少量回顾",
}

// Flutter 首页四张卡片 → 章节（改这里要同时改 science_note.dart 的 scene 字段）。
export const FLUTTER_SCENES = {
  selection: "mix",
  fsrs: "fsrs",
  bkt: "bkt",
  forgetting: "curve",
}
