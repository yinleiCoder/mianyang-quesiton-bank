import { chapter } from "./showcase-promo-chapter.js"

// 网页教师端：按「出题 → 审批 → 组卷 → 讲评」的真实流程排列。
// 图片在 public/showcase/promo/web/；url 只用于浏览器框里的地址栏。
export const WEB_CHAPTERS = [
  chapter(
    "dashboard", "工作台",
    "教师工作台：题库、组卷、审批一屏",
    "全市共享题库、我的题目、待办与平台规模。",
    ["全市题库 / 我的题目", "待我审核 / 快速出题", "平台规模与学校贡献"],
    ["showcase/promo/web/dashboard.png"],
    120, "sky", "myquiz.cn/dashboard"
  ),
  chapter(
    "bank", "题库 / 我的题目",
    "全市共享题库，草稿 / 审核 / 已发布",
    "在共享题库里挑题，也能管理自己的题目状态。",
    ["题型 / 难度 / 知识点筛选", "草稿 / 待审 / 已发布", "改版重新走审批"],
    ["showcase/promo/web/bank.png", "showcase/promo/web/my-questions.png"],
    180, "violet", "myquiz.cn/bank"
  ),
  chapter(
    "ai-import", "AI 智能解析",
    "AI 整卷导入：PDF / Word 一次搬进题库",
    "自动切页、识别题型与选项、抽取答案与解析；浏览器直连大模型。",
    ["PDF / Word / 图片", "自动切页 / 识别题型", "密钥不入库，结果先校对"],
    ["showcase/promo/web/ai-import.png"],
    150, "rose", "myquiz.cn/questions/import"
  ),
  chapter(
    "editor", "出题 / 编辑",
    "六种题型，结构校验后再提交",
    "题干、选项、答案、解析、知识点与难度一次配齐。",
    ["单选 / 多选 / 判断 / 填空", "主观题 / 综合题", "保存草稿或提交审核"],
    ["showcase/promo/web/editor.png"],
    150, "amber", "myquiz.cn/questions/new"
  ),
  chapter(
    "approvals", "两级审批",
    "教研组长初审 → 市级专家终审",
    "审批与转派统一收口；退回必须写意见。",
    ["组长流转、专家入库", "退回回到作者并全链重审", "审批记录可追溯"],
    ["showcase/promo/web/approvals.png"],
    120, "violet", "myquiz.cn/review"
  ),
  chapter(
    "papers", "组卷库",
    "拖拽组卷，自动算分",
    "从题库挑题组成标准卷，设定每题分值、总分与考试时长。",
    ["按题 / 按空 / 按小问计分", "协同组卷，分段不覆盖", "入库后全市共享"],
    ["showcase/promo/web/papers.png"],
    150, "emerald", "myquiz.cn/papers"
  ),
  chapter(
    "paper-detail", "试卷详情",
    "正卷 / 答案分离，导出标准 PDF",
    "试卷结构、分值、答案页与打印入口在一处。",
    ["导出 PDF / 直接打印", "答案单独成页", "讲评大屏入口"],
    ["showcase/promo/web/paper-detail.png"],
    120, "sky", "myquiz.cn/papers/…"
  ),
  chapter(
    "leaderboard", "成绩排行",
    "班级 / 学校 / 全市 / 全省排行",
    "每题选项分布、易错题与 AI 班级诊断。",
    ["四档排行榜", "每题选项分布", "AI 班级诊断报告"],
    ["showcase/promo/web/leaderboard.png"],
    120, "amber", "myquiz.cn/papers/…/board"
  ),
  chapter(
    "ai-analytics", "AI 学情分析",
    "AI 班级诊断：一页看懂薄弱点",
    "按班生成分析报告；学生用编号匿名，喂给模型的数据里没有姓名。",
    ["班级报告 / 易错题", "选项分布 / 掌握度", "匿名数据，密钥不入库"],
    ["showcase/promo/web/ai-analytics.png"],
    150, "rose", "myquiz.cn/classes/…/ai/…"
  ),
  chapter(
    "lecture", "讲评模式",
    "一题一屏，投屏讲易错题",
    "答案默认隐藏；按正确率给答题卡上色。",
    ["一题一屏", "答案默认隐藏", "按正确率上色"],
    ["showcase/promo/web/lecture.png", "showcase/promo/web/lecture-2.png"],
    180, "emerald", "myquiz.cn/lecture/paper/…"
  ),
  chapter(
    "reports", "题目反馈",
    "学生纠错 → 作者处理",
    "题目反馈与申诉统一收口；处理必须写说明。",
    ["学生纠错 / 教师申诉", "作者或管理员处理", "受理即下线，整改恢复"],
    ["showcase/promo/web/reports.png"],
    120, "rose", "myquiz.cn/questions/reports"
  ),
  chapter(
    "materials", "复习资料",
    "教材 / 试卷 / 资料，一份资料全校可用",
    "上传后学生端直接打开，下载可重复使用。",
    ["单份最大 2GB", "学生端直接打开", "下载复用"],
    ["showcase/promo/web/materials.png"],
    120, "sky", "myquiz.cn/materials"
  ),
]
