// 班级 AI 分析的提示词与返回结构校验。集中一处便于迭代 —— 改提示词是这类功能最主要的调优手段。
//
// **SYSTEM_PROMPT 必须逐字节稳定**（与 lib/import-prompts.js 同一条规矩）：上游按前缀命中提示缓存，
// 命中与未命中的输入价差 50 倍。所以卷名、班级、成绩、复习进度一律进 user 消息。
//
// 数据里**没有学生姓名**（服务端 0088 的 _class_ai_data 只给"学生N"编号）。提示词里必须
// 明确要求模型沿用这个编号、不要猜名字 —— 否则它会写"张同学""李同学"，教师当成真事就坏了。

export const SYSTEM_PROMPT = `你是中等职业学校（中职）的教学分析助手，帮任课教师读懂一次考试：
这套卷子考得怎么样、学生的知识点掌握在哪里、接下来该复习什么。

只输出一个 json 对象（开启 JSON Output 后官方要求提示词里出现 json 字样），
不要任何解释文字、不要 Markdown 代码块。对象结构：
{
  "overview": "整体表现，3~5 句：参加人数、整体水平、最突出的一个信号",
  "strengths": ["这次考得好的地方", "2~3 条，没有就给空数组"],
  "key_points": [
    {"point": "知识点名称", "mastery": "较好 | 一般 | 薄弱", "evidence": "依据：哪几题、正确率多少"}
  ],
  "weak_points": [
    {"point": "知识点名称", "evidence": "依据", "suggestion": "课堂上怎么补，一句话"}
  ],
  "question_notes": [
    {"seq": 1, "note": "这道题的讲评要点，一句话；干扰项为什么有吸引力"}
  ],
  "plan": {
    "consolidate": ["知识巩固：先补什么，可操作"],
    "extend": ["适度拓展：往哪延伸"],
    "improve": ["能力提升：训练什么"]
  },
  "caveats": "数据的局限（参加人数少、样本小、还有未判分的题等），一句话；没有就空字符串"
}

硬性规则：
1. 一切结论**只能来自给的数据**。数据里没有的（学生平时表现、上次考了多少、教材进度）不要编。
   数据不足以判断时，在 caveats 里说明，不要用"可能""应该"凑字数。
2. 学生的称呼**只能用数据里的编号**（如"学生3"）。**不要猜姓名、不要写"张同学"**。
   同一编号在本次分析里始终是同一个人，可以据此说"学生3 三题都错"。
3. 题号用数据里的 seq，写"第 5 题"。
4. 分清三种"没分"：没参加（参加人数少于班级人数）、还有题没判分（pending > 0）、
   以及确实考得差。**没参加不等于考得差**，别混为一谈。
5. 正确率是"已判分的作答"里的比例。correct_rate 为 null 表示这题还没人判分，
   **不要当成 0%**。
6. plan 要与"复习进度"对齐。数据里有两处依据，**按这个顺序用**：
   ① 教师填写的"近期复习进度"（user 消息里会给）—— 有它就以它为准，巩固从教师复习到的位置接上；
   ② 教师没填时，看数据里的 practice（本班最近 30 天的练习，按最弱的知识点排序）——
      **练到过的知识点说明已经教过**（没掌握就是这次要巩固的），没出现在里面的说明还没到；
      而"练得最多又最弱"的那几个，就是最该优先补的。
   两处都没有（班级近 30 天没练过）时，才只按这次考试暴露的薄弱点排。
7. 每条都要短：一句话说清。overview 之外，单个数组不超过 6 条。
8. 语气是同事之间的教学建议，不是给学生看的评语。不用"加油""同学们"这类话。`

/**
 * 构造一次分析请求的 messages。
 *
 * payload 是服务端 0088 的 _class_ai_data 产出的那份（**不要在这里加工学生身份**：
 * 里面本来就没有姓名，只有"学生N"；这里再改一次只会让指纹与内容对不上）。
 *
 * progressNote：教师填的"近期复习进度"（可选）。它进 user 消息，**绝不进 system**。
 */
export function buildAiReportMessages(payload, { progressNote } = {}) {
  const note = (progressNote ?? "").trim()
  const tail = [
    note
      ? `教师填写的**近期复习进度**：${note}\n请让 plan 与它对齐（从教师复习到的位置接上，不要另起一头）。`
      : `教师**没有填写**近期复习进度：请用数据里的 practice（本班最近 30 天的练习，最弱的排前面）`
        + `推断教学进度 —— 练到过的说明教过了（其中最弱的就是这次要补的），没出现的说明还没到；`
        + `不要假设教师教过练习里没有的内容。`,
    "请只输出 JSON 对象，字段照上面给的例子，不要多也不要少。",
  ].join("\n")

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: `这次考试的数据（json）：\n${JSON.stringify(payload)}` },
        { type: "text", text: tail },
      ],
    },
  ]
}

/**
 * 校验模型返回的对象。**宁可判定为失败让教师重试，也不要把半截报告渲染出来** ——
 * 报告是要拿去做教学决定的，缺了 plan 或 overview 就没有价值。
 * @returns {{ ok: true, report: object } | { ok: false, reason: string }}
 */
export function validateAiReport(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, reason: "模型没有返回 json 对象" }
  }
  const overview = typeof obj.overview === "string" ? obj.overview.trim() : ""
  if (!overview) return { ok: false, reason: "报告缺少「整体表现」" }
  const plan = obj.plan
  const hasPlan =
    plan && typeof plan === "object" && ["consolidate", "extend", "improve"].some((k) => arr(plan[k]).length > 0)
  if (!hasPlan && arr(obj.key_points).length === 0 && arr(obj.weak_points).length === 0) {
    return { ok: false, reason: "报告里没有任何知识点或复习建议" }
  }
  return { ok: true, report: obj }
}

/** 数组字段的统一读取：模型偶尔会给成字符串或 null，一律当空数组。 */
export function arr(v) {
  return Array.isArray(v) ? v : []
}
