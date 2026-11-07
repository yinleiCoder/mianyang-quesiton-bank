# 「人工智能（编程）作品」功能扩展完整方案

> 交付物：**方案**（本轮不写代码）
> 作品方向：比赛通知第（二）类 **人工智能（编程）作品**（纯软件可参赛、申报不限主题）
> 依据：`docs/0416-关于开展“AI+科技教育”中小学生作品展评……通知.pdf` + 本仓库现有代码
> 结论先行：**不再加“教师侧 AI 按钮”，而是把系统升级成「LLM 理解 + 算法求解 + 人工确认」的 AI 教学决策引擎**；新增 5 个 P0、2 个 P1 功能，全部复用现有模块。

## Context

用户已明确：本次比赛的作品方向是通知第（二）类 **人工智能（编程）作品**，不是学生科创作品展评，也不是“AI 科学探究工作台”；本轮只要**完整方案**，不写代码。

因此本方案要回答的不是“平台还能加什么功能”，而是：**在这个已经上线、已有 5 个大模型功能和 6 个确定性算法的题库系统上，还能补哪些能力，才能让它作为一件“人工智能（编程）作品”在创新性、智能性、可行性、艺术性、算法原理理解、数据处理逻辑、解决真实问题七个维度上站得住、讲得清、演示得出来。**

现状盘点得到的核心判断：现有 AI 功能都是“内容处理”（把已有材料转成另一种文字），缺的是**理解意图、约束生成、诊断决策、可解释、画像**五种能力。本方案围绕这五种能力给出 5 个 P0 + 2 个 P1，并明确不做哪些（展评、动画、同源代码执行、AI 检测）。

其中 **P0-5（学习画像雷达图）是用户追加要求**：按“小红书式”画像卡设计，但必须满足未成年人隐私与成长导向的约束（不公开分享、不跨班排名、样本不足不画雷达）。

---

## 0. 一句话结论

现有 AI 功能（导入、审题、评分建议、班级报告、教案）本质上都是**内容处理**：把已有材料转成另一种文字。人工智能（编程）作品要评的是**智能性、算法原理、数据处理逻辑、解决真实问题**，所以下一步要补的是五种能力：

1. **理解意图**：教师说一句话，系统变成可执行的组卷约束（LLM → 结构化 spec → 模拟退火）。
2. **约束生成**：在题库/标签树的允许集合里生成新内容（自动打标、变式题），而不是自由发挥。
3. **诊断决策**：从作答数据里找错因、给教学动作（错因诊断）。
4. **可解释**：每个 AI/算法决策都能说清“依据什么、用了什么方法、置信度多少、哪里不确定”。
5. **画像**：把分散的学情数字压成六轴雷达图，学生/教师一眼看懂强项、短板与下一步。

这五件事合起来，正好对应比赛评审的“算法原理、数据处理逻辑、解决问题方法”三条。

---

## 1. 作品定位与比赛口径

### 1.1 通知第（二）类怎么评

| 通知原文要求 | 对本作品的含义 |
|---|---|
| 个人或小组（2–3 人）；纯软件形式可提交 | 现有团队（PM/Web/Flutter/测试/CI）即可 |
| 作品应具备创新性、智能性、可行性和艺术性 | 四个维度都要有可演示的证据，不能只讲“我们用了大模型” |
| 初高中（含中专、职高）重点考察：对人工智能学科基本算法原理、数据处理逻辑和解决问题方法的理解 | 答辩必须能讲清：LLM 负责什么、算法负责什么、数据怎么流、结果怎么校验 |
| 申报不限主题 | 不必强行贴“科学教育”；本作品定位为 **AI + 教育科技**（用 AI 解决真实教学问题） |
| 需现场答辩展示 | 需要一条 6–8 分钟、可重复的演示脚本 |

**如果评委追问“这和科技教育有什么关系”，用三条回答**：

1. 系统本身就是科技教育的**基础设施**：题库、组卷、学情、讲评，是信息科技/人工智能课程落地的底座。
2. “人工智能”在这里不是装饰：LLM 意图解析、约束生成、BKT/FSRS/CTT、模拟退火都是可讲原理的真算法；学生用这套系统做题，本身就在接触 AI 驱动的学习。
3. 可扩展科技素养题库（P2）：把“科学/信息科技/人工智能”作为公共学科挂进现有科目树，不需要改架构；这属于内容建设，不占本轮 P0。

### 1.2 现有能力盘点（代码事实）

**五个真实大模型功能**（全部浏览器 BYOK，密钥只存 `localStorage`，站点不出钱、不存密钥）：

| 功能 | 入口 | 模型实际做什么 |
|---|---|---|
| AI 整卷导入 | `app/(app)/questions/import/page.jsx`、`components/import/*` | 逐页/逐批把 PDF/Word/拍照页转成题目 JSON（支持视觉） |
| AI 审题 | `components/questions/question-audit-panel.jsx` | 规则检查 + 六维复审（规范性/科学性/区分度/难度/标签/语言） |
| AI 评分建议 | `components/papers/ai-grade-suggest.jsx` | 按评分点给分，evidence 引用学生答案，教师确认才落库 |
| AI 班级报告 | `components/classes/ai-report-panel.jsx` | 学情数据 → 结构化诊断报告 |
| AI 讲评教案 | `components/classes/lesson-plan-panel.jsx` | 报告 → 45 分钟教案；无密钥时模板兜底 |

**六个确定性算法/统计方法**（不是大模型，是答辩时更值钱的“算法原理”）：

| 算法 | 位置 | 作用 |
|---|---|---|
| 模拟退火 + 贪心 | `lib/paper-optimizer.js` | 按题型/难度/标签/曝光/相似度组卷，可解释配比 |
| CTT | `lib/ctt.js`、`0121_paper_quality.sql` | 难度 p、区分度 r、上下 27%、干扰项 |
| BKT | `0122_bkt.sql` | 知识点掌握度 |
| FSRS-6 | `0125/0126` | 复习排期 |
| pg_trgm 查重 | `0081`、`import_find_similar` | 题目/导入查重三档 |
| Beta 收缩 | `lib/item-stats.js` | 小样本难度估计 |

**现有架构约束**（方案必须遵守）：

- 所有模型调用在**浏览器**，`lib/deepseek.js` 的 `callChat`；没有服务端 AI 路由、没有站点密钥、没有向量库/RAG。
- 学生端 AI 答疑是内嵌秘塔 AI（`metaso.cn`）的站外入口，不是本站能力；学生端没有、也不应该有站点付费密钥。
- 所有写操作走 Supabase `SECURITY DEFINER` RPC；前端只读表。
- “智能组卷”不是 LLM，是本地优化器；这一点答辩时要主动讲清，反而是加分项。

### 1.3 缺口：从“会处理内容”到“会做决策”

| 能力 | 现状 | 缺口 |
|---|---|---|
| 理解自然语言需求 | 无 | 教师仍要手填组卷表单 |
| 在约束内生成 | 导入是“抽取”，不是“生成” | 没有自动打标、没有变式题 |
| 从数据里找原因 | 班级报告是叙述性的 | 没有逐题错因分类与教学动作 |
| 让非技术用户查数据 | 页面固定报表 | 没有“问一句话出图” |
| 解释 AI/算法决策 | 分散在各页面 | 没有统一的决策卡与算法说明 |
| 一眼看懂一个学生 | 正确率、知识点、错题、考试分散在多张卡片 | 没有“六轴画像 + 画像标签 + 下一步建议” |

### 1.4 作品定位

> **AI 教学决策引擎**：LLM 负责“听懂、生成、解释”，确定性算法负责“求解、统计、校验”，教师负责“最后确认”。三者边界清晰、每一步可追溯；最后再用六轴画像把结果呈现给教师和学生，而不是丢一堆原始数字。

这句话是答辩的主线，也是所有新功能的设计原则。

---

## 2. 总体架构与统一质量闸门

### 2.1 三层结构

```
教师浏览器
  ├─ LLM 层（BYOK，直连 DeepSeek）
  │    ├─ 意图解析（一句话组卷 / 学情问数）
  │    ├─ 约束生成（自动打标 / 变式题）
  │    ├─ 诊断解释（错因诊断）
  │    └─ 画像解读（可选，仅教师侧）
  ├─ 确定性层（纯函数，可单测）
  │    ├─ paper-optimizer（模拟退火）
  │    ├─ ctt / item-stats / bkt / fsrs
  │    ├─ profile-radar（六轴画像）
  │    ├─ import-pipeline（normalizeQuestion）
  │    └─ question-audit（规则检查）
  └─ 数据层（Supabase，RLS + RPC）
       ├─ 题库/试卷/考试/学情
       ├─ 允许清单（科目树、标签树、题型、RPC intent）
       └─ 审计与缓存
```

**原则**：LLM 永远不直接写库、不直接选题、不直接定分；它输出结构化意图/草稿/建议，由确定性层校验、由教师确认。

### 2.2 六条统一质量闸门（所有新功能共用）

1. **结构化输出**：`response_format: json_object` + 严格 schema 校验 + 最多 3 次格式重试（沿用 `lib/grading-prompt.js` 的模式）。
2. **允许清单**：输出的 id/intent/qtype 必须来自本次请求附带的候选集合；模型不能“发明”科目、标签、题型。
3. **证据可核**：评分/诊断类输出的 `evidence` 必须是输入原文的子串（程序化校验，不只是提示词要求）。
4. **样本门槛**：样本不足时明确写“仅供参考/不给结论”（沿用 `lib/accuracy.js` 的“0 次作答 ≠ 0%”口径）。
5. **人工确认**：不自动写库、不自动发布、不自动改题；所有落库走现有 RPC，并写 `audit_log`。
6. **隐私与成本**：不发送学生姓名（错因诊断用匿名样本）；密钥只在教师浏览器；提示词 system 部分逐字节稳定以命中缓存。

---

## 3. P0-1：一句话组卷（旗舰功能）

### 3.1 解决什么问题

现有智能组卷要教师填：科目节点、目标分、每个大题题型/数量/分值口径/难度配比/标签/排除天数。教师真实的表达是：“出一份 90 分的高一数学期中卷，基础 60%、中档 30%、难 10%，第三章为主，近一个月用过的题不要。”

**LLM 负责把这句话变成 spec，模拟退火负责选题。** 这是整个作品最能讲清“AI 与算法分工”的功能。

### 3.2 用户流程

1. 教师在组卷页点“一句话组卷”，输入自然语言。
2. 系统显示“我理解成了”卡片：科目、目标分、各大题、难度配比、标签、排除天数；可逐项修改。
3. 教师点“生成”，调用现有 `paper_ai_candidates` + `optimizePaperPlan`，显示配比报告与预览。
4. 教师可逐题替换（现有 `swapPlanItem`），满意后应用到卷面；保存仍走现有流程。
5. 无密钥/解析失败时，自动退回现有手工表单，不挡流程。

### 3.3 输出契约（PaperIntent）

```json
{
  "node_id": "uuid|null",
  "target_score": 90,
  "exclude_recent_days": 30,
  "requested_tag_ids": ["uuid"],
  "sections": [
    {
      "title": "单项选择题",
      "qtype": "single_choice",
      "count": 10,
      "score_mode": "per_item",
      "score_each": 3,
      "difficulty_mix": { "easy": 0.6, "medium": 0.3, "hard": 0.1 },
      "max_per_tag": 3
    }
  ],
  "assumptions": ["按‘期中范围’理解为第三章及之前"],
  "clarify": "如果缺少科目或目标分，在这里问一句；否则为 null"
}
```

### 3.4 校验闸门（`validatePaperIntent`）

- `node_id` 必须在本次允许的科目节点集合内（或 null）。
- `target_score` 30–150；`exclude_recent_days` 0–365。
- `requested_tag_ids` 必须是该科目子树内的标签。
- `sections` 1–8 个；`count` 1–50；`qtype`/`score_mode` 白名单。
- `difficulty_mix` 只允许 easy/medium/hard，份额 0–1，合计 0.95–1.05。
- **映射层**：`validatePaperIntent` 把 easy/medium/hard 映射成优化器要求的 `{1,2,3}` 再调用 `optimizePaperPlan`；不要把模型输出直接塞给优化器。
- 分值合计与 `target_score` 不一致时给 warning，不直接拒绝。
- 信息不足（无科目/无目标分/无大题）时返回 `clarify`，不生成。

### 3.5 复用与新增

- 复用：`components/papers/paper-ai-planner.jsx`（现有表单与预览）、`lib/paper-candidates.js`、`lib/paper-optimizer.js` 的 `optimizePaperPlan`、`supabase/migrations/0120_paper_ai_candidates.sql`。
- 新增：`lib/paper-intent-prompt.js`（system prompt + `buildPaperIntentMessages` + `validatePaperIntent`）、`scripts/test-paper-intent.mjs`、planner 顶部的一句话输入与“理解卡片”。
- 模型：`lib/deepseek.js` 的 `callChat`，`maxTokens` 约 1500，`temperature` 0.2（意图解析要稳）。

### 3.6 测试

`scripts/test-paper-intent.mjs` 覆盖：合法意图、未知 node、未知 qtype、count 越界、难度合计不等于 1、标签不在子树、目标分与分项不一致、信息不足返回 clarify、空文本。

### 3.7 工作量与比赛映射

- 工作量：4–6 天。
- 比赛映射：智能性（自然语言理解）、算法原理（约束优化）、数据处理（schema 校验）、创新性（LLM 与优化器分工）、可行性（现有组卷链路）。

---

## 4. P0-2：AI 知识点自动打标

### 4.1 解决什么问题

教师出题时常不选标签或选得不一致；标签是 BKT 掌握度、班级弱项、组卷覆盖率的底座。人工打标枯燥，漏标会让后续所有学情分析失真。

### 4.2 用户流程

1. 在题目编辑器（`components/questions/question-editor.jsx`）与导入预览（`components/import/import-preview.jsx`）里，点“AI 推荐标签”。
2. 输入：题干/选项/答案/解析 + 当前科目节点 + 该科目子树内的标签（id、名称、路径）。
3. 输出：最多 5 个标签 + 置信度 + 一句理由；以 chips 形式显示。
4. 教师逐条采纳/忽略；“全部采纳”也只写进表单，保存仍由教师点。
5. 批量模式：导入预览里对选中项逐个调用（并发 2，沿用 `lib/bulk-rpc.js` 的逐条思路，失败不影响其他项）。

### 4.3 输出契约（TagSuggestion）

```json
{
  "tags": [
    { "tag_id": "uuid", "confidence": 0.87, "reason": "题干考查一元二次方程的判别式" }
  ],
  "caveats": "题干较短，标签仅供参考"
}
```

### 4.4 校验闸门

- `tag_id` 必须在本次候选集合内；重复 id 去掉；最多 5 个。
- `confidence` 0–1；`reason` 非空。
- 题干过短（<10 字）直接跳过，不调用模型。
- **未选科目节点时按钮禁用**：候选池 `tagsInScope` 为空，AI 无法判断学科范围；提示先选科目/建标签树。
- 不自动写 `version_tags`；不改变现有 `TagPicker` 的交互。

### 4.5 复用与新增

- 复用：`lib/tag-tree.js` 的 `tagsInScope`、`components/questions/tag-picker.jsx`（已有 `subjectNodeId` 与候选池）、`supabase/migrations/0096_tag_subject_and_tree.sql`。
- 新增：`lib/tag-suggest-prompt.js`、`scripts/test-tag-suggest.mjs`；在 `TagPicker` 上方加“AI 推荐”按钮，建议结果复用现有 chips。
- 模型：`callChat`，`maxTokens` 约 800，`temperature` 0.2。

### 4.6 测试

合法建议、未知 id、跨科目 id、重复 id、超过 5 个、置信度越界、短题干跳过、空候选集合。

### 4.7 工作量与比赛映射

- 工作量：3–5 天。
- 比赛映射：数据处理（树约束）、智能性（多标签分类）、可行性（导入/编辑器现成）、可度量（与教师标注抽样比对）。

---

## 5. P0-3：AI 变式题

### 5.1 解决什么问题

教师需要同一知识点的更多练习，但“改数、换情境、换问法”很花时间；学生也需要变式训练来防“背答案”。

### 5.2 用户流程

1. 在题目详情/编辑器点“生成变式题”，选择：变式维度（换数据/换情境/换问法/综合两个知识点）、数量（1–3）、目标难度。
2. 模型按现有题目内容 schema 生成草稿（同题型）。
3. 系统自动跑：`normalizeQuestion`（结构归一）→ `draftIssues` / `auditQuestion`（规则检查）→ `find_similar_questions`（查重）。
4. 预览页显示：题目、答案、解析、规则问题、与题库最相似的题（相似度）。
5. 教师修改后“存为草稿”；草稿带 `ai_generated` 标记，进入现有两级审批。
6. 硬规则：**永不自动发布**；客观题先行（单选/多选/判断/填空），复合题/简答后续再开。

### 5.3 输出契约（复用导入 wire schema）

```json
{
  "questions": [
    {
      "qtype": "single_choice",
      "difficulty": "medium",
      "stem": "……",
      "options": [{ "key": "A", "text": "……" }],
      "answer": ["A"],
      "analysis": "……",
      "variant_note": "把原题的匀速运动改成匀加速，考查同一公式"
    }
  ],
  "caveats": "生成题请核对答案与解析"
}
```

### 5.4 校验闸门

- 复用 `lib/import-pipeline.js` 的 `normalizeQuestion`（wire → content）与 `draftIssues`；若走编辑器表单，再经 `lib/question-model.js` 的 `fromContent` → `validateContent` 走一遍现有校验。
- 复用 `lib/question-audit.js` 的规则：答案不在选项、重复选项、“以上都不对”、否定式题干、选项过长等。
- 查重：与源题相似度 ≥0.85 视为“几乎没变”，提示重新生成；与题库其他题 ≥0.85 提示撞题。
- 答案必须存在且可判定；解析不能为空；难度枚举合法。
- 草稿写入时加 `ai_generated` 标记（建议在 `question_versions.content.flags` 里加，或新增列；方案阶段先定口径，实施时再迁移）。

### 5.5 复用与新增

- 复用：`lib/import-prompts.js` 的题型/答案格式约定、`lib/import-pipeline.js` 的归一化、`lib/question-audit.js`、`0081_find_similar_questions.sql`、`create_question_draft` RPC。
- 新增：`lib/variant-prompt.js`、`components/questions/variant-dialog.jsx`、`scripts/test-variant.mjs`、`/dev-variant` 夹具页（免登录，假题）。
- 模型：`callChat`，`maxTokens` 约 3000，`temperature` 0.8（需要多样性，但结构由 schema 约束）。

### 5.6 测试

结构非法、答案键不在选项、重复选项、空解析、难度非法、与源题过于相似、输出 0 题、输出超过 3 题、非客观题型拒绝。

### 5.7 工作量与比赛映射

- 工作量：1–2 周。
- 比赛映射：智能性（受控生成）、算法原理（归一化/规则审计）、数据处理（查重与质量门）、解决问题（题源生产）。

---

## 6. P0-4：AI 错因诊断

### 6.1 解决什么问题

现有 AI 班级报告会写“这道题错误率高”，但教师真正要的是：**学生为什么错、错在哪一类、下节课怎么补**。作答数据里已经有选项分布、错答样本、填空题高频错答，完全够做逐题诊断。

### 6.2 用户流程

1. 在班级 AI 报告页新增“逐题错因诊断”页签/区块。
2. 对错误率最高的 N 道题（默认 5 道，可调），系统取：选项分布、错答学生样本（匿名）、填空题高频错答、题型/知识点。
3. 模型按固定错因分类输出：概念混淆 / 审题偏差 / 计算错误 / 单位或格式 / 知识缺口 / 猜测 / 时间压力 / 其他。
4. 每类给：占比、证据（引用某个错误选项或学生原文）、教学动作（一句话）、可选的变式题入口（跳到 P0-3）。
5. 教师可把诊断结论写入讲评教案（现有教案面板已有入口）。

### 6.3 输出契约（ErrorDiagnosis）

```json
{
  "questions": [
    {
      "seq": 12,
      "sample": 35,
      "causes": [
        {
          "code": "concept_confusion",
          "share": 0.4,
          "evidence": "选 B 的学生把‘加速度’当成了‘速度’",
          "remedy": "用 v-t 图对比速度与加速度的方向"
        }
      ],
      "teaching_move": "先讲 B 选项的典型错误，再做一道只改数据的变式",
      "caveats": "样本 35 人，结论仅供参考"
    }
  ],
  "summary": "本卷主要失分集中在……",
  "caveats": "低于 5 份作答的题不做错因判断"
}
```

### 6.4 校验闸门

- `seq` 必须是本卷题号；`sample` 与后端数据一致。
- `code` 必须在固定分类表内；`share` 0–1，合计约 1。
- `evidence` 必须是输入样本/选项文本的子串（程序化校验）。
- 样本 <5 时只给 caveat，不给强结论。
- 不发送学生姓名；样本用“学生A/学生B”或直接引用作答文本。

### 6.5 复用与新增

- 复用：`lib/class-ai.js` 的 `loadClassAiPayload`、`supabase/migrations/0088/0113/0127` 的 `_class_ai_data`（已含选项分布、错答名单、填空高频错答）、`components/classes/ai-report-panel.jsx` 的缓存/指纹模式。
- 新增：`lib/error-diagnosis-prompt.js`、`components/classes/error-diagnosis-panel.jsx`、`supabase/migrations/<下一个可用编号>_class_error_diagnoses.sql`（当前最大 0127；definer-only 缓存表，沿用 `class_ai_lesson_plans` 的指纹模式）、`scripts/test-error-diagnosis.mjs`。
- 模型：`callChat`，`maxTokens` 约 4000，`temperature` 0.4。

### 6.6 测试

分类越界、evidence 编造、share 合计异常、样本不足、题号不存在、空数据、与报告指纹不一致时提示重新生成。

### 6.7 工作量与比赛映射

- 工作量：1–2 周。
- 比赛映射：数据处理（作答数据 → 诊断）、智能性（分类+证据）、解决问题（教学动作）、算法原理（与 CTT/统计口径一致）。

---

## 7. P0-5：学习画像雷达图（学生 / 教师双视图）

### 7.1 解决什么问题

现有学情页是一堆分散的数字：练习次数、正确率、分科目掌握、遗忘曲线、错题、考试成绩。教师要在几张卡片之间拼出一个学生的样子；学生也说不清自己“强在哪、弱在哪、下一步练什么”。

雷达图的价值不是“好看”，而是把 6 个维度压成一眼可读的形状：强项凸出、短板凹陷，配一个画像标签和一句建议，学生/教师立刻知道下一步。对比赛来说，它还是**艺术性最强、最容易截图传播**的一页；六轴都有公式，答辩时能逐条讲清“这个分数怎么来的”。

### 7.2 双视图

| 视图 | 落点 | 数据 | 权限 |
|---|---|---|---|
| 教师看学生 | `/students/[id]` 顶部新增“学习画像”卡 | `student_learning_profile(p_student_id)` | RPC 内 `can_view_student()`；只给本校、专业匹配的教师 |
| 学生看自己 | Flutter「我的」页新增“我的学习画像” | `student_learning_profile(null)` | 只返回 `auth.uid()` 自己的数据 |
| 班级平均（可选 P1） | 班级学情页 | `class_learning_profile(p_class_id)` 聚合 | 仅教师；MVP 不做，先把个人画像跑通 |

**刻意不做**：学生视图不显示班级排名/同学对比；教师视图默认也不显示“谁最差”的榜单。画像用于“下一步怎么教/怎么练”，不是给学生贴标签。

**教师教学画像（P2，先不做）**：同一套雷达骨架可以复用到教师——出题量、命题质量（审题通过率/CTT）、组卷量、考试使用、反馈处理、学生提升。先等学生画像跑通、口径稳定，再决定要不要做；不要在本轮同时开两个画像。

### 7.3 六轴定义与公式

所有练习口径只取 `practice_answers` 中 `grading='auto'` 且 `is_correct is not null` 的作答；日界用现有 `practice_day_start()`（北京时间）。窗口默认 90 天（勤奋度 28 天、进步力 14+14 天）。

| 轴 | key | 公式 | 样本门槛 | 说明 |
|---|---|---|---|---|
| 掌握力 | `mastery` | BKT 加权掌握度 ×100（权重 `1+least(attempts,3)`，与 `my_bkt_profile` 同口径） | 总作答 ≥5 | 复用 `_my_bkt_items(p_uid,365,600)`（0122 已参数化，教师视图可传学生 id） |
| 准确率 | `accuracy` | `correct/attempts×100`（客观题） | 作答 ≥20 | 分母不含主观自评题，避免把待批改的题算成错 |
| 勤奋度 | `effort` | `min(100, active_days_28/20×100)` | 作答 ≥10 | 28 天里活跃 20 天记满分（约每周 5 天）；不奖励“刷题量”，只奖励“持续来” |
| 进步力 | `growth` | `clamp(50 + (recent14 - prev14)×100, 0, 100)` | 两个窗口各 ≥10 | 没有前 14 天数据时给 50 并注明“新用户，暂无对比” |
| 知识面 | `breadth` | `100×(1-exp(-distinct_tags/5))` | 不同知识点标签 ≥3 | 2026-11-03 按线上数据校准：90 天内题目只挂 3 个课程节点（全班仅 1/40 达 ≥3 节点），同一批作答覆盖 7 个标签（本班 34/36 达 ≥3 标签）；5 个标签≈63、6 个≈70、10 个≈86；不用“已练/全库”做分母 |
| 稳定性 | `stability` | `100×clamp(1 - stddev(daily_accuracy)/0.35, 0, 1)` | 活跃 ≥5 天且作答 ≥20 | 按“每天正确率”的波动算；比“总正确率”更能区分“稳定 70 分”和“忽高忽低” |

**雷达图生成规则**：6 轴全部 `sufficient=true` 画完整雷达；恰好 5 轴有数据时画“半画像”（缺的轴标灰并写“数据不足”，不给强画像标签，只给“成长型”）；少于 5 轴不画雷达，显示“成长中”进度卡（还差多少题/多少天），并列出已有轴的数值。缺数据的轴在 `axes[].score=null`，附 `hint`。

**三个口径细节**：

- **BKT 用 365 天窗口**（模型需要历史），其余轴用 90 天；`window_days` 与每轴 `raw.window` 要写清，避免“为什么掌握力和正确率的时间范围不一样”的疑问。
- **稳定性分母 0.35 是初始值**，上线前用真实分布校准；如果整体偏低，调到 0.4–0.5，并在 `caveats` 里写明版本。
- **六轴是画像口径，不是把现有卡片数字直接搬过来**：准确率只算客观题、90 天窗口，与 `practice_dashboard` 的全量总正确率本来就会不同。卡片说明里必须写窗口与分母，否则用户会把它当 bug。

**为什么不用考试成绩单独做轴**：一次考试的难度、题量、状态波动太大，容易把画像变成“一次定生死”。考试成绩作为卡片下方的补充统计，不参与六轴。

**只有考试数据、没有练习数据的学生**：不画雷达，显示考试成绩摘要 + “再练几题生成画像”的引导；不要用一场考试硬凑六轴。

### 7.4 输出契约（LearningProfile）

```json
{
  "student": { "user_id": "uuid", "name": "...", "class_name": "...", "major_name": "..." },
  "window_days": 90,
  "axes": [
    {
      "key": "mastery",
      "label": "掌握力",
      "score": 78,
      "raw": { "mastery": 0.78, "attempts": 120, "weighted": 0.78 },
      "sample": 120,
      "sufficient": true,
      "hint": "BKT 加权掌握度"
    }
  ],
  "persona": {
    "key": "steady",
    "label": "稳健型",
    "reason": "掌握力 78、准确率 81、稳定性 74 均在 70 以上"
  },
  "summary": "你的强项是……；下一步建议……",
  "caveats": ["画像只反映最近 90 天的练习数据，不代表能力全貌", "稳定性样本 6 天，结论仅供参考"],
  "generated_at": "2026-11-03T12:00:00+08:00"
}
```

- `score` 为 0–100 整数；`null` 表示样本不足。
- `raw` 保留原始数值，供“画像说明”和可选的 AI 解读使用。
- **RPC 只回 `axes/raw/caveats`；`persona/summary` 由纯函数拼装**：Web 在 `lib/profile-persona.js`，Flutter 在 `utils/profile_persona.dart`，两端规则表逐条一致、测试互为清单（沿用 `accuracy.js` ↔ `accuracy_meta.dart` 的做法）。上面 JSON 是拼装后的完整对象。
- `persona` 与 `summary` 都由**规则/模板**生成，不调用大模型（学生端没有密钥，也不该为一句评语付费）。
- `caveats` 至少包含“数据窗口”和“样本不足”两类提示。

### 7.5 画像标签规则（规则表，非 AI）

按顺序命中，第一条为准；`reason` 必须带实际数值，不能只写“你很棒”。

| 标签 | key | 条件 |
|---|---|---|
| 稳健型 | `steady` | 掌握力 ≥75 且 准确率 ≥75 且 稳定性 ≥70 |
| 冲刺型 | `sprinter` | 进步力 ≥60 且 勤奋度 ≥70 |
| 探索型 | `explorer` | 知识面 ≥70 且 准确率 <70 |
| 勤奋型 | `diligent` | 勤奋度 ≥75 且 准确率 <65 |
| 均衡型 | `balanced` | 六轴最高与最低差 ≤15 |
| 成长型 | `growing` | 以上都不命中，但 5–6 轴有数据 |
| 新同学 | `newcomer` | 不足 5 轴有数据 |

> 标签只描述“最近的学习状态”，不是能力鉴定；文案统一用成长语气，禁止“学困/差生/没天赋”等词。**不推断人格、心理特征或学习风格类型**——六轴全部来自可观测的练习行为，避免把一次统计结果包装成“你是什么样的人”。

### 7.6 视觉与页面落点

**Web（教师视图，MVP）**

- 新增 `components/students/learning-profile-card.jsx`（客户端组件，`recharts` 的 `RadarChart`）。
- `app/(app)/students/[id]/page.jsx` 在现有 `my_student_detail` 之外并行取 `student_learning_profile`（`lib/students.js` 加 `loadStudentLearningProfile`），传给卡片。
- 卡片结构：头像 + 姓名 + 班级/专业 + 画像标签 chips → 雷达图（6 轴、25/50/75/100 环、渐变填充）→ 下方 3 个关键数字（练习天数/正确率/掌握力）+ 一句总结 → 可折叠的“画像说明”（公式、样本量、caveats）。

```text
┌─────────────────────────────────────────────┐
│ [头像] 张三  计算机应用 2 班  [稳健型] [知识面广] │
│                                             │
│                掌握力                        │
│                   ▲                          │
│          知识面  ╱ │ ╲  准确率               │
│                ╱   │   ╲                     │
│        稳定性 ●────┼────● 勤奋度              │
│                ╲   │   ╱                     │
│                   ▼                          │
│                进步力                        │
│                                             │
│ 练习 26 天 · 正确率 81% · 掌握力 78          │
│ “你的强项是…；下一步建议…”                  │
│ [画像说明 ▾]  数据窗口 90 天 · 样本 120      │
└─────────────────────────────────────────────┘
```
- 教师视图右上角标注“仅教师可见”；**不提供公开分享按钮**。
- 视觉沿用 M3：`Card` 圆角、主题色渐变、深浅色自动适配；不要照搬小红书的粉色模板，否则会像外挂页面。

**Flutter（学生视图，第二批）**

- `apis/learning_repository.dart` 新增 `studentLearningProfile()`；`entity/learning_profile.dart` freezed 模型。
- `pages/profile/widgets/learning_profile_card.dart`（单文件 ≤200 行，遵守架构检查），用 `fl_chart` 的 `RadarChart`。
- `profile_page.dart` 在“学习计划”上方加一节“我的学习画像”；barrel 导出。
- 学生视图只显示本人，不显示班级平均；可加“保存到本机”（现有 `share_plus`），但不做站内公开分享。
- 390×844 与 1280×800 两套画板都要过；Widget 测试覆盖“六轴齐全 / 数据不足 / 深色模式”。

### 7.7 复用与新增

- 复用：`practice_answers`、`practice_day_start()`、`_my_bkt_items`（0122；对 authenticated 已 revoke，只在新 RPC 内部调用）、`can_view_student`（0063）、`my_student_detail`（0110）、`components/ui/card`、`recharts`、`fl_chart`。
- 新增：`supabase/migrations/<下一个可用编号>_student_learning_profile.sql`（RPC，只回 axes/raw；无新表，数据量大再加快照表）、`components/students/learning-profile-card.jsx`、`lib/profile-persona.js`（标签规则 + 文案模板，Web）、`mianyang_quiz/lib/utils/profile_persona.dart`（逐条镜像，Flutter）、`scripts/test-profile-persona.mjs`、`app/dev-profile-radar/page.jsx`（免登录夹具，三套假数据：新同学/稳健型/冲刺型）。
- 可选（P1）：`lib/profile-narrative-prompt.js` + `student_profile_narratives` 缓存表（教师 BYOK，只给教师看；学生端仍用模板总结）。

**RPC 骨架（安全边界先写死）**：

```sql
create or replace function public.student_learning_profile(
  p_student_id uuid default null,
  p_days int default 90)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_target uuid := coalesce(p_student_id, v_uid);
begin
  if v_target <> v_uid and not public.can_view_student(v_target) then
    raise exception '你只能查看本校且专业匹配的学生' using errcode = '42501';
  end if;
  -- 1) _my_bkt_items(v_target, 365, 600) → mastery
  -- 2) practice_answers（grading='auto'，90 天）→ accuracy / effort / growth / breadth / stability
  -- 3) 返回 axes + raw + sample + sufficient + caveats；persona/summary 交给纯函数
  return jsonb_build_object(/* ... */);
end;
$$;
revoke execute on function public.student_learning_profile(uuid, int) from public, anon;
grant execute on function public.student_learning_profile(uuid, int) to authenticated;
```

### 7.8 测试

- SQL/RPC：用测试学生造已知作答，断言六轴数值；样本不足时 `score=null`；教师越权（外校/外专业）返回 42501；学生只能取自己。
- 纯函数：`lib/profile-persona.js` 的标签规则、文案模板、`max-min` 边界；`scripts/test-profile-persona.mjs`。
- 夹具页：`/dev-profile-radar` 三套假数据，检查雷达形状、空状态、深色模式、窄屏。
- Flutter：Widget 测试六轴/空状态/深色模式；`flutter analyze` + `dart run tool/check_architecture.dart`。
- 口径：六轴与现有 `my_bkt_profile`、`practice_dashboard`、`my_student_detail` 的数值对得上，避免同一指标两套算法。

### 7.9 工作量与比赛映射

- 工作量：RPC + Web 卡片 2–3 天；Flutter 2–3 天；测试与夹具 1 天；合计 **4–6 天**。
- 比赛映射：艺术性（最直观的一页）、智能性（数据驱动画像 + 可选 AI 解读）、算法原理（BKT/加权正确率/指数饱和/增长率/标准差）、数据处理（聚合口径、样本门槛）、解决问题（学生自我定位、教师快速分层）。
- **答辩时主动讲取舍**：雷达本身不调用大模型，零成本、零延迟、可离线；AI 只用在可选的“解读”上，且只给教师看。这比“什么都让大模型算”更能体现对 AI 边界的理解。

### 7.10 隐私与伦理边界

- 未成年人数据：不做公开分享、不做跨班排名、不做“最差学生”榜单；教师端也不默认展示全班对比。比赛/答辩可以截图演示，但产品内不提供公开分享入口。
- 文案成长导向：只描述状态与下一步，不做能力鉴定；`caveats` 必须显示。
- 数据最小化：RPC 只返回聚合分数与计数，不返回作答原文；教师视图由 `can_view_student` 把守。
- 可退出：学生端提供“隐藏学习画像”开关（只影响自己视图），避免被标签化的压力。
- 如果后续加 AI 解读：不发送姓名、不与同学比较、只引用轴值与样本量；学生端不直连大模型。

### 7.11 AI 解读（可选，P1）

- 输入：六轴 `score/raw/sample/persona` + `caveats`；不发送姓名、班级、学校。
- 输出：`{ headline, strengths[], growth[], actions[], caveats, confidence }`；每条必须引用轴 key 与数值。
- 校验：`strengths/growth` 必须含 `axis` 字段；`actions` ≤3；禁止“学困/差生/没天赋”等词；数值越界或引用不存在的轴判失败。
- 缓存：`student_profile_narratives`（`student_id + fingerprint` 唯一，definer-only，沿用 `class_ai_lesson_plans` 模式）；教师 BYOK，学生端只读模板总结。

---

## 8. P1-1：学情问数（自然语言 → 受控查询 → 图表）

### 8.1 解决什么问题

教师/管理者不会写查询，也不会在多个报表页之间找数据。“上周一班哪些知识点最弱？”“这次考试区分度最低的题是哪几道？”——一句话就该出图。

### 8.2 关键设计：不让模型写 SQL

采用**语义层 + 允许清单**：

- 预定义 6–8 个 intent，每个绑定一个现有只读 RPC 与参数 schema。
- 模型只输出 `{intent, params, chart}`；客户端校验后调用 RPC。
- 摘要文字由**模板**根据返回数据生成，不再调用第二次模型（避免编造）。

**MVP intent 清单**：

| intent | 参数 | 绑定 RPC |
|---|---|---|
| `weak_nodes` | class_id, days | `class_learning_report` |
| `practice_trend` | class_id, days | `class_learning_report` |
| `question_stats` | paper_id, scope, class_id | `paper_question_stats` |
| `question_quality` | paper_id | `paper_quality_diagnostics` |
| `leaderboard` | paper_id, scope, class_id | `paper_leaderboard` |
| `student_detail` | student_id | `my_student_detail`（教师权限内） |

### 8.3 输出契约（AnalyticsIntent）

```json
{
  "intent": "weak_nodes",
  "params": { "class_id": "uuid", "days": 7 },
  "chart": "bar",
  "title": "上周一班最弱的知识点"
}
```

### 8.4 校验闸门

- `intent` 必须在白名单；`params` 按每个 intent 的 schema 校验类型/范围。
- 权限：不在前端判断，交给绑定的 RPC 内部按现有 `can_view_class`/`can_view_student` 口径校验；越权由 RPC 返回“无权访问”，页面只显示该提示。
- 不认识的意图：返回 3 条推荐问题，不猜。
- 空数据：明确“暂无数据”，不生成摘要。
- 图表类型白名单：bar/line/pie/table。

### 8.5 复用与新增

- 复用：`lib/analytics.js` 的 `loadClassReport`/`loadPaperQuestionStats`/`loadPaperLeaderboard`、`lib/quality.js`、`lib/students.js`、`recharts`。
- 新增：`lib/analytics-intent.js`（intent 注册表 + prompt + 校验 + 模板摘要）、`components/analytics/ask-data.jsx`、`scripts/test-analytics-intent.mjs`。
- 模型：`callChat`，`maxTokens` 约 500，`temperature` 0.1。

### 8.6 测试

意图白名单、参数越界、越权、空数据、未知意图、图表类型非法、中文同义表达（“最弱/最差/掌握最差”）。

### 8.7 工作量与比赛映射

- 工作量：1–2 周。
- 比赛映射：数据处理（语义层）、智能性（意图识别）、安全（不写 SQL）、创新性。

---

## 9. P1-2：可解释决策卡 + 算法说明页

### 9.1 解决什么问题

系统里已有大量 AI/算法决策（推荐哪道题、怎么组卷、给多少分、为什么判相似），但依据散落在各页面。比赛评审要看的“算法原理理解”，最直接的证据就是**每个决策都能解释**。

### 9.2 设计

- 新增通用组件 `components/ai/decision-card.jsx`，固定字段：
  - 决策是什么
  - 输入（用了哪些数据）
  - 方法（LLM / 模拟退火 / BKT / FSRS / CTT / pg_trgm）
  - 关键因素（3–5 条，带数值）
  - 置信度 / 样本量
  - 不确定之处（caveats）
  - 可执行动作（换一题/重算/查看原数据）
- 接入点：
  - 组卷预览：现有 `report` 指标（目标分、难度分布、标签覆盖、曝光、相似度、硬约束违规）→ 决策卡。
  - AI 评分：现有 `units/confidence/caveats` → 决策卡。
  - 审题：规则问题 + AI 问题 + 查重三档 → 决策卡。
  - 学生端“为什么今天推这道题”：BKT 掌握度 + FSRS 到期 + 40/30/10 配额 + 当天已练过滤（数据来自 `my_bkt_profile`/`practice_plan`；可在 Flutter 端加一张卡，也可在 Web 教师端先做）。
- 新增 `/showcase/algorithms` 只读页（沿用 `app/(app)/showcase/*` 的只读展示模式）：用文字/公式/静态图讲清 LLM 提示缓存、JSON 校验、模拟退火、BKT、FSRS、CTT、pg_trgm、Beta 收缩。**不做动画**（教学动画已两次撤掉，不重开）。

### 9.3 复用与新增

- 复用：`components/showcase/architecture/*` 的展示壳、`lib/showcase-*` 的数据组织、现有 planner/report/audit 的数据结构。
- 新增：`components/ai/decision-card.jsx`、`app/(app)/showcase/algorithms/page.jsx`、`lib/algorithm-notes.js`（纯文案/公式数据）。
- 不需要模型调用；纯展示与数据整理。

### 9.4 工作量与比赛映射

- 工作量：约 1 周。
- 比赛映射：算法原理（直接讲）、艺术性（统一视觉）、答辩（可投屏）。

---

## 10. P2 备选（本轮不建议做主项）

| 功能 | 价值 | 为什么先不做 |
|---|---|---|
| 题库健康度报告（覆盖/难度/标签/重复/陈旧题 + AI 摘要） | 学校/市教科所视角好 | 更像管理报表，AI 含量低于 P0 |
| 多模态公式/表格结构化 | 导入能力更强 | 要改内容块 schema + Web/Flutter/PDF 三套渲染，成本高、风险大 |
| 编程题题型 + 代码评测 | 贴近“人工智能编程” | 需要代码编辑器、沙箱执行/测试用例；`AGENTS.md` 明确 AI 生成代码不能同源执行，Vercel Sandbox 成本与复杂度高 |
| 分层作业生成 | 教师实用 | 与 P0-1 组卷重叠，容易做成第二套组卷 |
| AI 生成内容检测 | 看似贴合原创性 | 不可靠，容易误判；查重 0.55 的教训已证明“低阈值直接判死”不可取 |
| 教学动画 / 站内视频播放 | 展示性强 | 2026-10-09 已两次撤掉，明确不再建 |

---

## 11. 与比赛评审维度的对应

| 评审维度 | 现有证据 | 本方案新增证据 |
|---|---|---|
| **创新性** | 多校共建题库、两级审批、BYOK、全链路闭环 | LLM 意图 → 模拟退火的混合架构；允许清单约束生成；逐题错因诊断；可解释决策卡；成长导向的学习画像 |
| **智能性** | 5 个 LLM 功能 + BKT/FSRS/CTT | 自然语言组卷、自动打标、变式题、错因诊断、学情问数、数据驱动画像（可选 AI 解读） |
| **可行性** | 线上真实用户、完整测试与 CI | 全部功能复用现有模块；无新基础设施；无站点 AI 成本 |
| **艺术性** | Material 3 界面、showcase 展示页 | 六轴雷达画像卡、决策卡、问数图表、算法说明页 |
| **算法原理** | 模拟退火、BKT、FSRS、CTT、pg_trgm、Beta 收缩 | 新增“LLM 与算法分工”的清晰边界；画像六轴公式（BKT/加权正确率/指数饱和/增长率/标准差）逐条可讲 |
| **数据处理逻辑** | 内容块 schema、候选特征、学情 payload | 意图 schema、标签树约束、证据子串校验、语义层、画像聚合与样本门槛 |
| **解决问题** | 出题/组卷/批改/讲评 | 降低组卷配置成本、提升标签质量、补充题源、定位错因、学生自我定位与教师分层 |

---

## 12. 答辩演示脚本（6–8 分钟）

| 时间 | 场景 | 讲什么 |
|---|---|---|
| 0:00–0:40 | 问题 | 中职教师出题/组卷/讲评的真实痛点；一句话介绍系统 |
| 0:40–1:50 | P0-1 一句话组卷 | 说一句话 → 展示“我理解成了”卡片 → 生成 → 配比报告；强调 LLM 只解析、模拟退火选题 |
| 1:50–2:40 | P0-2 自动打标 | 打开一道未打标题 → AI 推荐标签 → 采纳；讲标签树约束与多标签 |
| 2:40–3:40 | P0-3 变式题 | 生成一道变式 → 规则审计发现问题 → 查重 → 存草稿；强调永不自动发布 |
| 3:40–4:30 | P0-4 错因诊断 | 打开班级报告 → 逐题错因 → 证据引用 → 一键生成变式 |
| 4:30–5:30 | P0-5 学习画像 | 打开学生详情 → 六轴雷达 → 画像标签 → 折叠“画像说明”讲公式与样本量；强调成长导向、不做排名 |
| 5:30–6:10 | P1-2 决策卡 | 展示组卷/评分/审题三张决策卡；讲“依据、方法、置信度、不确定” |
| 6:10–7:00 | 学生端 | “为什么今天推这道题”：BKT + FSRS + 配额；讲确定性算法不烧钱 |
| 7:00–8:00 | 工程与边界 | BYOK 隐私、六条质量闸门、测试与 CI、哪些不做（动画/同源执行/AI 检测） |

---

## 13. 实施路线与分工

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| 阶段 1 | P0-1 + P0-2 | 两个 prompt/validator、两个 UI 入口、两个测试脚本 | 1.5–2 周 |
| 阶段 2 | P0-3 | 生成→归一化→审计→查重→草稿全链路 + 夹具页 | 1–2 周 |
| 阶段 3 | P0-4 + P0-5（Web） | 错因诊断 prompt/缓存/页签；画像 RPC + 雷达卡 + 夹具页 | 1.5–2.5 周 |
| 阶段 4 | P0-5（Flutter）+ P1-2 | 学生端画像卡；决策卡组件 + 算法说明页 | 1–1.5 周 |
| 阶段 5 | P1-1 + 联调答辩 | 问数 MVP（6 个 intent）+ 演示脚本、截图、回归、文档 | 1.5–2 周 |

> 合计约 **6.5–10 周**（一人全职、顺序执行口径）；若 Web/后端/测试并行，可压到 5–7 周。与现有教学/比赛任务并行时，按“阶段 1 → 2 → 3”保 P0，P1 可后置；答辩前至少完成 P0-1 + P0-2 + P0-5（Web）的演示闭环。

**分工建议**（沿用现有团队）：

- Web（赵文俊）：P0-1/P0-2/P0-3/P0-5（雷达卡）/P1-1 的页面与 prompt 接线。
- 后端（陈明霖）：P0-4 缓存表/RPC、P0-5 画像 RPC、P0-3 的 `ai_generated` 标记、P1-1 权限口径。
- Flutter（陈明霖）：P0-5 学生端画像卡；学生端“为什么推这道题”决策卡（可选）。
- 测试（AI）：每个 prompt/validator 的 Node 断言、画像规则测试、夹具页、回归。
- PM（金子轩）：演示脚本、指标口径、画像伦理口径、风险与比赛材料。

---

## 14. 风险与不做清单

### 风险与缓解

| 风险 | 缓解 |
|---|---|
| 模型输出漂移/结构不对 | JSON mode + schema + 3 次重试 + 允许清单 |
| 生成题答案错误 | 规则审计 + 查重 + 人工确认 + 只开客观题 |
| 错因诊断过度解读 | 固定分类 + 样本门槛 + caveats + 证据子串校验 |
| 成本/延迟 | BYOK、短提示、稳定 system 前缀、逐条而非批量、非流式可接受 |
| 教师不信任 | 决策卡 + “我理解成了”可编辑 + 永不自动写库 |
| 学生隐私 | 错因诊断匿名样本；问数走权限 RPC；不发送姓名 |
| 画像标签化未成年人 | 成长导向文案、无公开分享、无跨班排名、可隐藏；教师视图由 `can_view_student` 把守 |
| 画像样本不足导致误读 | 6 轴不全不画雷达，显示“成长中”；每轴带 sample/caveat |
| 六轴口径漂移 | RPC 单一真源；Web/Flutter 只渲染不重算；与现有 BKT/正确率口径对齐 |
| 比赛规则“AI 仅辅助” | 系统定位是教师工具；所有 AI 输出由教师确认；答辩主动讲边界 |

### 明确不做

- 不做科创作品展评/申报流程（用户已定：作品方向是人工智能编程，不是展评系统）。
- 不做教学动画、站内视频播放（已两次撤掉）。
- 不做 AI 生成代码的同源执行/在线沙箱。
- 不做学生端站点付费大模型。
- 不做 AI 生成内容检测（不可靠）。
- 不在本轮改内容块 schema（公式/表格留到 P2）。

---

## 15. 验证方式

- 每个 prompt/validator 一个 Node 断言脚本：`scripts/test-paper-intent.mjs`、`test-tag-suggest.mjs`、`test-variant.mjs`、`test-error-diagnosis.mjs`、`test-analytics-intent.mjs`、`test-profile-persona.mjs`，并纳入 `npm run test:*` 口径。
- 免登录夹具页：`/dev-paper-intent`、`/dev-variant`、`/dev-error-diagnosis`、`/dev-analytics-intent`、`/dev-profile-radar`（参照 `/dev-grading-suggest`、`/dev-question-audit`；生产 404 保护沿用现有做法）。
- 手工验收：教师账号 + 真实 DeepSeek 密钥，走一遍“一句话组卷 → 打标 → 变式 → 错因 → 问数”。
- 回归：`npm run build`、现有 `npm run test:*` 全绿；Flutter 若有改动走 `flutter analyze` + `flutter test` + `dart run tool/check_architecture.dart`。
- 口径校验：错因分类、难度口径、样本门槛与现有 CTT/BKT/报告口径对齐，避免同一指标两套说法。

### 15.1 可量化验收指标（建议写进答辩材料）

| 功能 | 指标 | 目标 |
|---|---|---|
| P0-1 一句话组卷 | 30 条真实教师口语样本的意图解析成功率（字段级） | ≥90%；越界字段 0 |
| P0-2 自动打标 | 50 道题的 AI 推荐与教师标注 Top-3 重合率 | ≥70%；跨科目标签 0 |
| P0-3 变式题 | 生成题通过规则审计的比例；人工抽检答案正确率 | 审计通过 ≥80%；抽检正确 ≥90% |
| P0-4 错因诊断 | evidence 能在输入样本中命中的比例；教师认可度 | 命中 100%（程序校验）；抽检认可 ≥80% |
| P0-5 学习画像 | 六轴与 `my_bkt_profile`/`practice_dashboard`/`my_student_detail` 数值一致率；样本不足时 `score=null`；标签规则单测 | 一致率 100%；不足样本不画雷达；规则用例全过 |
| P1-1 学情问数 | 20 条常见问法的 intent 命中率 | ≥85%；未知意图不乱猜 |
| P1-2 决策卡 | 组卷/评分/审题/画像四处均能看到“依据、方法、置信度、caveat” | 100% 覆盖 |

> 这些指标同时是测试脚本的断言口径：能写成断言的，不靠人眼（与现有测试口径一致）。

---

## 16. 交付物

本方案批准后，落到仓库 `docs/AI编程作品-功能扩展方案.md`（与本文件同内容，便于团队/评委查阅）；随后按第 13 节分批实施。

若只想先做比赛材料，建议按以下清单准备（不改代码也能交）：

1. **作品说明**：问题、方案、创新点、AI 与算法分工、数据流、边界（1–2 页）。
2. **功能清单**：现有 5 个 LLM 功能 + 6 个确定性算法 + 本方案 7 个新增功能，逐条一句话。
3. **算法说明页**：模拟退火、BKT、FSRS、CTT、pg_trgm、学习画像六轴公式、LLM 结构化输出与校验（可直接用 `/showcase/algorithms`）。
4. **演示脚本**：第 12 节 6–8 分钟版本，按“问题 → 五个功能 → 决策卡 → 学生端 → 工程边界”走。
5. **截图/录屏**：组卷理解卡、标签推荐、变式审计、错因诊断、学习画像雷达图、决策卡、学习路径。
6. **测试证据**：`npm run test:*` 输出、夹具页截图、构建通过记录。
7. **开源与可复现**：GitHub 仓库、线上地址、测试账号（比赛材料里的明文密码要按现有文档口径处理，不额外扩散）。

---

## 17. 实现状态（2026-11-03）

按第 13 节顺序已落地 P0-1～P0-5 与 P1-1/P1-2 的主体；本轮没有做展评、动画、同源代码执行。

| 功能 | 状态 | 主要落点 |
|---|---|---|
| P0-1 一句话组卷 | 已实现 | `lib/paper-intent-prompt.js`、`components/papers/paper-intent-panel.jsx`、`paper-ai-planner.jsx`、`/dev-paper-intent`、`npm run test:paper-intent` |
| P0-2 AI 自动打标 | 已实现（题目编辑器 + 导入预览批量/逐题） | `lib/tag-suggest-prompt.js`、`components/questions/tag-suggest.jsx`、`question-editor.jsx`、导入预览的逐题建议/采纳、`0129_import_item_tags.sql`、`npm run test:tag-suggest` |
| P0-3 AI 变式题 | 已实现（客观题 + `ai_generated` 持久化标记） | `lib/variant-prompt.js`、`components/questions/variant-dialog.jsx`、`0132_question_ai_generated.sql`、编辑器/审核详情的「AI 生成草稿」徽标、`/dev-variant`、`npm run test:variant` |
| P0-4 AI 错因诊断 | 已实现（按需生成） | `lib/error-diagnosis-prompt.js`、`components/classes/error-diagnosis-panel.jsx`、班级 AI 页、`/dev-error-diagnosis`、`npm run test:error-diagnosis` |
| P0-5 学习画像雷达图 | 已实现（Web + Flutter + 班均画像） | `supabase/migrations/0128_student_learning_profile.sql` + `0130_fix_student_learning_profile_caveats.sql` + `0131_fix_student_learning_profile_stability_sample.sql` + `0133_profile_breadth_by_tags.sql` + `0138_class_learning_profile.sql`、`lib/profile-persona.js`、`components/students/learning-profile-*`、`components/classes/class-learning-profile-card.jsx`、`/dev-profile-radar`、Flutter `entity/learning_profile.dart` + `utils/profile_persona.dart` + `pages/profile/widgets/learning_profile_*` |
| P1-1 学情问数 | 已实现（班级弱项/趋势 + 学生学情 + 试卷正确率/质量/排行） | `lib/analytics-intent.js`、`components/analytics/ask-data*.jsx`、班级学情页/试卷分析页/学生详情页、`/dev-analytics-intent`、`npm run test:analytics-intent` |
| P1-2 决策卡 + 算法说明 | 已实现（组卷预览、AI 评分、AI 审题、学生端「为什么推这道题」） | `components/ai/decision-card.jsx`、`paper-ai-plan-preview.jsx`、`ai-grade-suggest.jsx`、`question-audit-panel.jsx`、Flutter `practice_reason_card.dart`、`lib/algorithm-notes.js`、`/showcase/algorithms`、侧栏入口 |

**需要手动执行**：

- `0128_student_learning_profile.sql`（画像 RPC）。未执行前，网页端画像卡不渲染、Flutter 端显示“学习画像暂不可用”，其余功能不受影响。
- `0130_fix_student_learning_profile_caveats.sql`（**0128 的修复**）。0128 里 `v_caveats := v_caveats || '…'` 会被 PostgreSQL 解析成数组拼数组，报 `malformed array literal`；0130 用 `array_append` 重放函数。**已经执行过 0128 的库也要再跑这一条**，否则画像 RPC 仍然报错。
- `0131_fix_student_learning_profile_stability_sample.sql`（**口径修正**）。稳定性的 caveat 误用了 28 天活跃天数（`v_active_days`），应改为 90 天活跃天数（`v_stability_days`）；stability 轴的 `sample` 也改成活跃天数。已执行 0128/0130 的库再跑这一条即可。
- `0129_import_item_tags.sql`（导入预览逐题标签）。未执行前，导入预览的逐题标签建议能算/能看，但采纳会报错、入库仍用任务级标签；loader 会自动回退，不挡导入。
- `0132_question_ai_generated.sql`（AI 草稿标记）。未执行前，变式题仍能存草稿，只是不显示「AI 生成草稿」徽标；编辑器/审核详情用独立查询兜底，不会因缺列打不开。

**P0-4 缓存（0134 + 0135 已执行；0136 已执行）**：错因诊断结果存 `class_error_diagnoses`，一条记录 = 一个卷面版本 + 班级，`content={diagnosis,questions}`；表启用 RLS 且不建策略、authenticated 无表权限，读写只走 `class_error_diagnosis` / `save_class_error_diagnosis` 两个 definer RPC（内部 `can_view_class`）。**0135** 把指纹从 `_class_ai_data` 的 payload md5 换成廉价聚合指纹（卷面版本 + 班级人数 + 考试 attempts/answers 计数，实测 75ms）。**0136** 把三条 AI 保存路径的 stale 错误码从 `40001` 改成 `PT409`：PostgREST 14 会把 40001 当串行化冲突**无限重试**，表现为 75ms 的 raise 挂成 120 秒 504、数据库里不断重跑（官方文档确认，16 才修）；客户端同步改为判断 `PT409`。实测诊断 stale 1.2 秒、报告 stale 8 秒返回 409，不再挂 120 秒。

**学生端「为什么推这道题」（0137，已执行）**：`practice_session_items` 加 `reason_code / p_mastery / due_at / node_name` 四列；`start_practice_session` 把 `practice_plan` 已算出的推荐依据一起落库；新增 `practice_session_reasons(p_session_id)`（只允许会话本人读）。Flutter 练习页在题干上方显示可折叠解释卡（新题/到期复习/薄弱知识点/巩固题 + 掌握度 + 计划复习日期），取不到时整块不渲染，不挡练习。旧会话与顺序练习没有原因，不显示。事务内实测：`start_practice_session` 建 3 题 → `practice_session_reasons` 返回 3 条 `new_item / 0.5 / 办公应用`，已回滚无残留。

**班均画像（0138，已执行并验库）**：`class_learning_profile(p_class_id, p_days)` 先按学生算六轴再取班均，只回班均与每轴参与人数（每轴 <5 人时 `sufficient=false`、`score=null`），不返回个人值、不排名；权限走 `can_view_class`。班级页新增**按需**卡片（BKT 在本班约 2–3 秒，不占首屏 SSR）。教师账号 REST 实测 **2.5 秒**：1班何亚章 40 人 / 35 人有数据，掌握 57 / 准确 50 / 勤奋 24 / 进步 42 / 知识面 59 / 稳定 59，各轴样本 23–35，六轴均 `sufficient=true`。

**轻量指标（2026-11-05）**：新增 `scripts/eval-intents.mjs`（`npm run eval:intents`，需要 `DEEPSEEK_KEY`，不是 npm test 的一部分）。15 条组卷口语 + 20 条问数问法的实测：生产同款 3 次重试后 **15/15、20/20**；单次 **13/15（86.7%）、17/20（85%）**，单次失败主要是模型偶发非 JSON。为避免组卷 JSON 被截断，面板 `max_tokens` 从 1500 提到 3000；提示词补了「原话不是组卷请求时 clarify」。

**验证口径**：新增 6 个 Node 断言脚本共 84 项全过；Flutter 画像镜像测试 10 项全过；`flutter analyze` 0 error；架构检查仅剩 6 项既有基线（行数/跨模块 import），新增文件未被点名；网页端 `npm run build` 通过。验库确认 0129 的函数/列/授权已到位；验库同时发现 0128 的 caveats 拼接 bug（0130 修复）与稳定性 caveat 的 28/90 天口径混用（0131 修正）。0130 后真实调用 `student_learning_profile` 已能返回六轴（某学生：掌握 53 / 准确 42 / 勤奋 15 / 进步 41 / 稳定 77 / 知识面 null）；0131 后稳定性 sample 取 90 天活跃天数（该生为 5），不再误报“样本不足”。

**2026-11-03 教师账号实测（authenticated 链路）**：用教师账号登录后逐一调用 `student_learning_profile` / `my_student_detail` / `class_learning_report` / `class_exam_results` / `paper_question_stats` / `paper_quality_diagnostics` / `paper_leaderboard` 全部正常；`import_job_items.tag_ids`、`question_versions.ai_generated` 对 authenticated 可读；两个新函数传不存在的 uuid 时返回业务错误「草稿不存在」而不是权限/缺函数。由此发现知识面口径问题：90 天内题目只挂在 3 个课程节点上（733/841 道题集中在同一个），全班 40 人只有 1 人达到「≥3 个节点」；同一批作答覆盖 7 个知识点标签，本班 36 个有作答的学生里 34 人 ≥3 个标签。因此补 `0133_profile_breadth_by_tags.sql`：知识面改按 `version_tags` 计数（阈值仍 ≥3，公式分母 8→5），其余五轴与 0131 完全一致。该迁移执行后，本班知识面轴覆盖从 1/40 提升到 34/40。

**2026-11-03 真实模型联调**（DeepSeek，一次性，不保存密钥）：一句话组卷、自动打标、变式题、错因诊断、班级问数、试卷问数 6 个提示词都跑通。联调暴露并修掉两处：

- 一句话组卷原先对“没写大题结构”只回 clarify；现在会按常见结构给默认方案（如 90 分 = 单选 10×3 + 填空 5×4 + 主观 4×10），并在 assumptions 里写明可修改。
- 错因诊断的 evidence 校验原先只认严格子串，模型写成「选项“-1”，20 人」就会被丢掉；现在 `evidenceMatches()` 会抽出引号里的原文并容忍全角/半角括号，仍拒绝编造的证据。
