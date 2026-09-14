// 规范化层的自检：喂进"模型会真实吐出的脏数据"，检查输出是否严格符合 content 契约。
// 用 node 直接跑：npm run test:import（别名由 scripts/alias-loader.mjs 提供）。
// 这个模块是"模型输出不可信"的第一道闸门，改动 normalize* 后请务必跑一遍。
import { normalizePage, normalizeQuestion, draftIssues, costOf } from "@/lib/import-pipeline"
import { salvageJson } from "@/lib/deepseek"

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? " → " + JSON.stringify(extra) : ""}`)
  }
}
const blocksText = (b) => (b ?? []).filter((x) => x.t === "text").map((x) => x.text).join("\n")

console.log("\n【1】干净的单选：原样通过，不该有任何 flags")
{
  const { items } = normalizePage({
    page_no: 1,
    questions: [
      {
        qno: "1",
        qtype: "single_choice",
        difficulty: 1,
        stem: "1. 下列正确的是（  ）",
        options: [
          { key: "A", text: "甲" },
          { key: "B", text: "乙" },
        ],
        answer: { type: "choice", keys: ["B"] },
        analysis: "因为乙正确",
        confidence: 0.9,
        source_quote: "下列正确的是",
      },
    ],
  })
  ok(items.length === 1, "抽出一题")
  ok(items[0].content.answer.keys[0] === "B", "答案保留")
  ok(items[0].content.options[0].label[0].text === "甲", "选项转成文本块")
  ok(items[0].flags.length === 0, "无 flags", items[0].flags)
  ok(items[0].issues.length === 0, "草稿级校验通过", items[0].issues)
}

console.log("\n【2】脏输入：中文题型、选项是字符串数组、小写答案、中文难度")
{
  const { items } = normalizePage({
    page_no: 2,
    questions: [
      {
        qtype: "单选题",
        difficulty: "难",
        stem: "关于内存的说法",
        options: ["A. 甲", "B. 乙", "C. 丙"],
        answer: "c",
      },
    ],
  })
  const it = items[0]
  ok(it.qtype === "single_choice", "中文题型归一", it.qtype)
  ok(it.difficulty === 3, "中文难度归一", it.difficulty)
  ok(it.content.options.length === 3 && it.content.options[0].key === "A", "选项 key 由位置补全")
  ok(it.content.options[2].label[0].text === "丙", "字符串选项（含 A. 前缀）仍能取到文字", it.content.options[2])
  ok(it.content.answer.keys[0] === "C", "小写答案转大写", it.content.answer)
}

console.log("\n【3】答案给的是序号（1 基）要能映射成字母；给不存在的字母要被判为缺答案")
{
  const it = normalizeQuestion(
    { qtype: "single_choice", stem: "题", options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }], answer: { keys: [2] } }
  )
  ok(it.content.answer?.keys?.[0] === "B", "序号 2 → B", it.content.answer)
  const it2 = normalizeQuestion(
    { qtype: "single_choice", stem: "题", options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }], answer: { keys: ["Z"] } }
  )
  ok(!it2.content.answer && it2.flags.includes("answer_missing"), "越界答案 → 标缺答案而不是硬塞")
}

console.log("\n【4】判断题的各种写法")
{
  for (const [raw, want] of [["对", true], ["错误", false], ["√", true], ["×", false], [true, true], ["T", true], ["F", false]]) {
    const it = normalizeQuestion({ qtype: "true_false", stem: "题", answer: { value: raw } })
    ok(it.content.answer?.value === want, `判断题 answer=${JSON.stringify(raw)} → ${want}`, it.content.answer)
  }
  const bad = normalizeQuestion({ qtype: "判断题", stem: "题", answer: { value: "说不准" } })
  ok(bad.flags.includes("answer_missing"), "认不出的判断答案 → 标缺答案")
}

console.log("\n【5】填空题：空位与答案数量不一致要能被预检抓到")
{
  const it = normalizeQuestion({
    qtype: "fill_blank",
    stem: "填空：______ 和 ______",
    answer: { values: ["只有一个"] },
  })
  ok(it.content.answer.values.length === 1, "答案保留原样（不擅自补）")
  ok(it.issues.some((s) => s.includes("空位")), "预检报出空位数不匹配", it.issues)
  ok(draftIssues("fill_blank", it.content).length > 0, "draftIssues 同样报出")

  const good = normalizeQuestion({ qtype: "fill_blank", stem: "填空：______", answer: { values: ["内存"] } })
  ok(good.issues.length === 0, "匹配时不报错", good.issues)
}

console.log("\n【6】主观题：多行字符串 → samples 数组")
{
  const it = normalizeQuestion({ qtype: "short_answer", stem: "简述", answer: "第一点\n第二点\n\n第三点" })
  ok(it.content.answer.samples.length === 3, "按行拆成 3 条", it.content.answer)
  ok(it.content.answer.samples[2] === "第三点", "内容正确")
}

console.log("\n【7】复合题：子题带 type、嵌套 composite 被剥掉、超 20 道截断")
{
  const subs = Array.from({ length: 22 }, (_, i) => ({ type: "single_choice", stem: `小题${i}`, options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }], answer: { keys: ["A"] } }))
  subs[0] = { type: "composite", stem: "嵌套的", sub: [{ type: "single_choice", stem: "x" }] }
  const it = normalizeQuestion({ qtype: "composite", stem: "阅读材料…", sub: subs })
  ok(it.content.sub.length === 20, "子题截断到 20", it.content.sub.length)
  ok(it.content.sub.every((s) => s.type && s.type !== "composite"), "子题都有 type 且无嵌套 composite")
  ok(it.flags.includes("low_confidence"), "截断过要标出来")
}

console.log("\n【8】模型自己发明 media 块 → 剥掉并换占位")
{
  const it = normalizeQuestion({
    qtype: "single_choice",
    stem: "看图回答",
    options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
    answer: { keys: ["A"] },
  })
  ok(!JSON.stringify(it.content).includes('"media"'), "内容里不含 media 块")
  const withFig = normalizeQuestion({
    qtype: "short_answer",
    stem: "见图 [[图1]] 作答",
    answer: { samples: ["答案"] },
  })
  ok(withFig.content.stem[0].text.includes("[[图1]]"), "占位保留")
  ok(withFig.flags.includes("has_figure"), "标了 has_figure")
}

console.log("\n【9】题干为空/缺题干 → 丢弃（返回 null）")
{
  ok(normalizeQuestion({ qtype: "single_choice", stem: "   ", answer: { keys: ["A"] } }) === null, "空题干丢弃")
  const { stats } = normalizePage({ questions: [{ qtype: "single_choice", stem: "" }, { qtype: "true_false", stem: "有效题", answer: { value: true } }] })
  ok(stats.parsed === 2 && stats.kept === 1 && stats.dropped === 1, "统计正确", stats)
}

console.log("\n【10】同页重复题 → 去重并标记")
{
  const q = { qtype: "true_false", stem: "同一道题", answer: { value: true } }
  const { items } = normalizePage({ questions: [q, { ...q }] })
  ok(items.length === 1, "只留一道")
  ok(items[0].flags.includes("dup_in_job"), "标了 dup_in_job")
}

console.log("\n【11】截断 JSON 的抢救")
{
  const truncated = '{"page_no":3,"questions":[{"qno":"1","qtype":"true_false","stem":"甲","answer":{"type":"tf","value":true}},{"qno":"2","qtype":"true_false","stem":"乙","answ'
  const salvaged = salvageJson(truncated)
  ok(salvaged && salvaged._salvaged === true, "识别为抢救结果")
  ok(salvaged.questions.length === 1, "救出完整的那一道")
  ok(salvageJson('```json\n{"page_no":1,"questions":[]}\n```')?.page_no === 1, "剥掉代码块围栏")
  ok(salvageJson("这不是 JSON") === null, "完全不是 JSON 时返回 null")
}

console.log("\n【12】费用折算")
{
  const c = costOf([
    { prompt_tokens: 100000, prompt_cache_hit_tokens: 80000, completion_tokens: 20000 },
    { prompt_tokens: 50000, prompt_cache_hit_tokens: 0, completion_tokens: 10000 },
  ])
  ok(c.prompt === 150000 && c.hit === 80000 && c.miss === 70000, "token 分类正确", c)
  ok(c.usd > 0.03 && c.usd < 0.06, `费用量级合理（${c.usd} USD）`, c)
}

console.log("\n【13】选项前缀剥离不得误伤正文（RAM 开头的选项）")
{
  const it = normalizeQuestion({
    qtype: "single_choice",
    stem: "题",
    options: ["A. RAM 断电后数据不丢失", "B、ROM 只能读", "（C）Cache 更快"],
    answer: { keys: ["C"] },
  })
  const texts = it.content.options.map((o) => o.label[0].text)
  ok(it.content.options[0].key === "A" && texts[0] === "RAM 断电后数据不丢失", "A. 前缀剥离且正文完整", texts[0])
  ok(it.content.options[1].key === "B" && texts[1] === "ROM 只能读", "顿号分隔也能剥", texts[1])
  ok(it.content.options[2].key === "C" && texts[2] === "Cache 更快", "全角括号也能剥", texts[2])
  ok(it.issues.length === 0, "剥离后仍能通过校验", it.issues)

  // 正文里出现的单个字母（不带分隔符）不能被当成 key
  const it2 = normalizeQuestion({ qtype: "short_answer", stem: "t 分布是什么", answer: { samples: ["x"] } })
  ok(it2.content.stem[0].text === "t 分布是什么", "题干不受影响")
  const it3 = normalizeQuestion({
    qtype: "single_choice", stem: "题",
    options: ["x 轴表示时间", "y 轴表示速度"], answer: { keys: ["A"] },
  })
  ok(it3.content.options[0].label[0].text === "x 轴表示时间", "无分隔符时不当成前缀", it3.content.options[0].label[0].text)
}

console.log(`
通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
