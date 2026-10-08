// 试卷 PDF 文档（react-pdf）。与 components/papers/paper-sheet.jsx 是**同一份卷面口径的
// 两种实现**：网页上是 HTML + Tailwind，PDF 里只能是 react-pdf 的原语（View/Text/Image），
// 因为它拿不到 DOM、也读不懂 CSS。
//
// 代价要写清楚：**改卷面排版时两个文件得一起改**。这是刻意接受的重复——换成"HTML 转 PDF"
// 就要在浏览器里跑一个排版引擎，中文断行、分页、字体嵌入全都得另外伺候。
//
// 答案口径与网页完全一致：正卷的 DOM/文档里绝不出现答案（不是"藏起来"），
// 答案版是另一个入口、另一份文档（同 app/print/paper/[id]/answers 的取舍）。
import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer"
import { CJK_FONT } from "@/lib/pdf-fonts"
import { imageBox, printableText } from "@/lib/pdf-prep"
import { blocksToText } from "@/lib/question-model"
import { cnNumeral, sectionHeading, round2 } from "@/lib/paper-model"

const S = StyleSheet.create({
  // ⚠ 行距**不能**写在 page 上：页脚是一个带 render 回调的 Text，而 react-pdf 里
  // "render 回调 + 任何 lineHeight（自带的或继承的）"会让这段文字**整个消失**，
  // 不报错、不警告，PDF 打开就是没有页脚。所以行距挂到正文包装层，页脚留在 Page 直下。
  page: {
    fontFamily: CJK_FONT,
    fontSize: 10.5,
    color: "#000",
    paddingTop: 40,
    paddingBottom: 46,
    paddingHorizontal: 40,
  },
  body: { lineHeight: 1.6 },
  head: { marginBottom: 14, paddingBottom: 10, borderBottom: "1 solid #0000004d", textAlign: "center" },
  examName: { fontSize: 12 },
  title: { fontSize: 16, fontWeight: 700, marginTop: 3 },
  headMeta: { fontSize: 10, marginTop: 6 },
  // 考生信息栏：下划线用一条同色底边，和网页上 inline-block + border-b 是一个意思
  blanks: { fontSize: 10, marginTop: 8 },
  blank: { borderBottom: "1 solid #00000099", width: 70, height: 12 },
  instructions: { border: "1 solid #00000033", padding: 8, marginBottom: 14, fontSize: 9.5 },
  section: { marginBottom: 14 },
  sectionTitle: { fontSize: 11, fontWeight: 700, marginBottom: 5 },
  sectionNote: { fontSize: 9.5, color: "#000000b3", marginBottom: 5 },
  item: { flexDirection: "row", marginBottom: 9 },
  seq: { width: 18, fontWeight: 700 },
  itemBody: { flex: 1 },
  stem: { marginBottom: 3 },
  optionRow: { flexDirection: "row", paddingLeft: 12, marginBottom: 2 },
  option: { flexDirection: "row", paddingLeft: 12, marginBottom: 2 },
  optionHalf: { width: "50%" },
  optionLetter: { width: 14 },
  optionText: { flex: 1 },
  answerLine: { paddingLeft: 12, marginTop: 2 },
  image: { marginTop: 4, marginBottom: 2 },
  mediaNote: { fontSize: 9, color: "#00000099", marginTop: 2 },
  analysis: { paddingLeft: 12, marginTop: 3 },
  answerBlock: { borderLeft: "2 solid #00000026", paddingLeft: 8, marginBottom: 10 },
  answerHead: { fontSize: 9.5, color: "#00000099", marginBottom: 2 },
  scoreTable: { marginTop: 18 },
  scoreRow: { flexDirection: "row", borderBottom: "1 solid #00000026", paddingVertical: 3, fontSize: 9.5 },
  scoreCellL: { flex: 1 },
  scoreCellN: { width: 60, textAlign: "right" },
  scoreCellS: { width: 70, textAlign: "right" },
  // 页脚：见上面 page 上的注释——这一层不许出现 lineHeight（写了页脚就没了）
  footer: { position: "absolute", bottom: 22, left: 40, right: 40, fontSize: 8, color: "#00000080", textAlign: "center" },
})

// 区块渲染：文本直接排，图片嵌进去，音频/视频/附件在纸上没法呈现——留一行说明，
// 总比网页打印时"呼啦一下整块消失"强（那条路现在就是这个效果）。
function Blocks({ blocks, images }) {
  const list = Array.isArray(blocks) ? blocks : []
  return (
    <>
      {list.map((b, i) => {
        if (b?.t === "text") return b.text ? <Text key={i}>{printableText(b.text)}</Text> : null
        if (b?.t !== "media") return null
        if (b.kind === "audio" || b.kind === "video" || b.kind === "file") {
          const what = b.kind === "audio" ? "音频" : b.kind === "video" ? "视频" : "附件"
          return (
            <Text key={i} style={S.mediaNote}>
              ［本题含{what}{b.alt ? `：${b.alt}` : ""}，请在网页端查看］
            </Text>
          )
        }
        const key = b.key ?? b.url
        const img = images?.get(key)
        if (!img?.src) {
          return (
            <Text key={i} style={S.mediaNote}>
              ［图片{b.alt ? `：${b.alt}` : ""}未能载入］
            </Text>
          )
        }
        const box = imageBox(img.width, img.height)
        return <Image key={i} src={img.src} style={[S.image, { width: box.width, height: box.height }]} />
      })}
    </>
  )
}

// 选项：短的俩俩并排、长的自己占一行（与 paper-sheet 里 col-span-2 的观感对齐）
function OptionRows({ options, answerKeys, showAnswer, images }) {
  const rows = []
  let pending = null
  for (const [i, o] of (options ?? []).entries()) {
    const cell = { key: o.key ?? String.fromCharCode(65 + i), blocks: o.label }
    const long = blocksToText(o.label).length > 14
    if (long) {
      if (pending) rows.push([pending]), (pending = null)
      rows.push([cell])
    } else if (pending) {
      rows.push([pending, cell])
      pending = null
    } else {
      pending = cell
    }
  }
  if (pending) rows.push([pending])

  return (
    <>
      {rows.map((row, ri) => (
        <View key={ri} style={S.optionRow}>
          {row.map((cell) => (
            <View key={cell.key} style={[S.option, row.length === 1 ? { flex: 1 } : S.optionHalf]}>
              <Text style={[S.optionLetter, showAnswer && answerKeys.has(cell.key) ? { fontWeight: 700 } : null]}>
                {cell.key}.
              </Text>
              <View style={S.optionText}>
                <Blocks blocks={cell.blocks} images={images} />
              </View>
            </View>
          ))}
        </View>
      ))}
    </>
  )
}

// 单题内容：与 components/questions/question-view.jsx 的 variant="paper" 逐条对齐
function Body({ qtype, content, showAnswer, images }) {
  const c = content ?? {}
  const answer = c.answer ?? {}
  const answerKeys = new Set(Array.isArray(answer.keys) ? answer.keys : [])
  const isChoice = qtype === "single_choice" || qtype === "multiple_choice"
  const subs = Array.isArray(c.sub) ? c.sub : []

  if (qtype === "composite") {
    return (
      <View>
        {blocksToText(c.stem).trim() ? <Blocks blocks={c.stem} images={images} /> : null}
        {subs.map((sub, i) => (
          <View key={i} style={{ marginTop: 4 }}>
            <Text style={{ fontWeight: 700 }}>（{i + 1}）</Text>
            <Body qtype={sub.type} content={sub} showAnswer={showAnswer} images={images} />
          </View>
        ))}
        {showAnswer && blocksToText(c.analysis).trim() ? (
          <View style={S.analysis}>
            <Blocks blocks={[{ t: "text", text: "解析：" }, ...(c.analysis ?? [])]} images={images} />
          </View>
        ) : null}
      </View>
    )
  }

  return (
    <View>
      <View style={S.stem}>
        <Blocks blocks={c.stem} images={images} />
      </View>
      {isChoice && (c.options?.length ?? 0) > 0 && (
        <OptionRows options={c.options} answerKeys={answerKeys} showAnswer={showAnswer} images={images} />
      )}
      {showAnswer && isChoice && answerKeys.size > 0 && (
        <Text style={[S.answerLine, { fontWeight: 700 }]}>正确答案：{[...answerKeys].join("、")}</Text>
      )}
      {showAnswer && qtype === "true_false" && (
        <Text style={[S.answerLine, { fontWeight: 700 }]}>
          正确答案：{answer.value === true ? "正确" : answer.value === false ? "错误" : "—"}
        </Text>
      )}
      {showAnswer && qtype === "fill_blank" && (
        <Text style={S.answerLine}>
          参考答案：{(answer.values ?? []).map((x, i) => `${i + 1}. ${printableText(x)}`).join("　")}
        </Text>
      )}
      {showAnswer && qtype === "short_answer" && (
        <View style={S.answerLine}>
          {(answer.samples ?? []).map((s, i) => (
            <Text key={i}>{printableText(s)}</Text>
          ))}
        </View>
      )}
      {showAnswer && qtype !== "composite" && blocksToText(c.analysis).trim() ? (
        <View style={S.analysis}>
          <Blocks blocks={[{ t: "text", text: "解析：" }, ...(c.analysis ?? [])]} images={images} />
        </View>
      ) : null}
    </View>
  )
}

// 卷头
function Head({ snap }) {
  const header = snap.header ?? {}
  const showCandidateBar = header.show_candidate_bar !== false
  return (
    <View style={S.head}>
      {snap.exam_name ? <Text style={S.examName}>{printableText(snap.exam_name)}</Text> : null}
      <Text style={S.title}>{printableText(snap.title)}</Text>
      {snap.subject_label ? <Text style={{ fontSize: 10, marginTop: 3 }}>{printableText(snap.subject_label)}</Text> : null}
      <Text style={S.headMeta}>
        总分 {round2(snap.total_score)} 分 · 考试时间 {snap.duration_minutes} 分钟
        {header.code ? `（${printableText(header.code)}）` : ""}
      </Text>
      {showCandidateBar && (
        <View style={[S.blanks, { flexDirection: "row", justifyContent: "center", alignItems: "flex-end" }]}>
          <Text>姓名 </Text>
          <View style={S.blank} />
          <Text>　学号 </Text>
          <View style={S.blank} />
          <Text>　得分 </Text>
          <View style={[S.blank, { width: 50 }]} />
        </View>
      )}
    </View>
  )
}

// 卷末分数速查表（只在答案版）
function ScoreTable({ sections, snapshot }) {
  const rows = sections.flatMap((s) => s.items ?? [])
  if (rows.length === 0) return null
  return (
    <View style={S.scoreTable} break>
      <Text style={[S.sectionTitle, { marginBottom: 6 }]}>分数构成</Text>
      {sections.map((s, si) => (
        <View key={s.id ?? si} style={S.scoreRow}>
          <Text style={S.scoreCellL}>
            {cnNumeral(si + 1)}、{printableText(s.title)}
          </Text>
          <Text style={S.scoreCellN}>{s.items?.length ?? 0} 题</Text>
          <Text style={S.scoreCellS}>{round2(s.section_score)} 分</Text>
        </View>
      ))}
      <View style={[S.scoreRow, { fontWeight: 700 }]}>
        <Text style={S.scoreCellL}>合计</Text>
        <Text style={S.scoreCellN}>{rows.length} 题</Text>
        <Text style={S.scoreCellS}>{round2(snapshot.total_score)} 分</Text>
      </View>
    </View>
  )
}

export function PaperPdfDocument({ snapshot, mode = "paper", images }) {
  const sections = snapshot?.sections ?? []
  const withAnswers = mode === "answers"
  const instructions = (snapshot?.instructions ?? []).filter((b) => b?.t === "text" && b.text?.trim())

  return (
    <Document
      title={`${snapshot?.title ?? "试卷"}${withAnswers ? "（参考答案）" : ""}`}
      author="职教高考联盟"
      subject={snapshot?.exam_name ?? ""}
      creator="职教高考联盟 · 共建题库"
    >
      <Page size="A4" style={S.page} wrap>
        {/* 正文整块包一层：行距（lineHeight）挂在这里，不能挂 Page——原因见 S.page 的注释 */}
        <View style={S.body}>
          <Head snap={snapshot} />

          {instructions.length > 0 && (
            <View style={S.instructions}>
              {instructions.map((b, i) => (
                <Text key={i}>{printableText(b.text)}</Text>
              ))}
            </View>
          )}

          {sections.length === 0 && <Text style={{ textAlign: "center", marginTop: 24 }}>这份试卷还没有题目</Text>}

          {sections.map((sec, si) => (
            <View key={sec.id ?? si} style={S.section}>
              <Text style={S.sectionTitle} minPresenceAhead={40}>
                {printableText(sectionHeading(sec, si))}
              </Text>
              {sec.instruction ? <Text style={S.sectionNote}>{printableText(sec.instruction)}</Text> : null}
              {(sec.items ?? []).map((it, ii) =>
                withAnswers ? (
                  <View key={it.id ?? ii} style={S.answerBlock} wrap={false}>
                    <Text style={S.answerHead}>
                      {it.seq}. （{round2(it.score)} 分
                      {it.score_units?.length > 1 ? `，共 ${it.score_units.length} 个给分点` : ""}）
                    </Text>
                    <Body qtype={it.qtype} content={it.content} showAnswer images={images} />
                    {it.score_units?.length > 1 && (
                      <Text style={{ fontSize: 9.5, marginTop: 3 }}>
                        评分标准：{it.score_units.map((u, i) => `${i + 1}. ${round2(u)} 分`).join("　")}
                      </Text>
                    )}
                  </View>
                ) : (
                  <View key={it.id ?? ii} style={S.item} wrap={false}>
                    <Text style={S.seq}>{it.seq}.</Text>
                    <View style={S.itemBody}>
                      <Body qtype={it.qtype} content={it.content} images={images} />
                    </View>
                  </View>
                )
              )}
            </View>
          ))}

          {withAnswers && <ScoreTable sections={sections} snapshot={snapshot} />}
        </View>

        <Text
          style={S.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `职教高考联盟 · ${withAnswers ? "参考答案" : "试卷"} · 第 ${pageNumber} / ${totalPages} 页`
          }
        />
      </Page>
    </Document>
  )
}
