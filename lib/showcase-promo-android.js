import { chapter } from "./showcase-promo-chapter.js"

// Android 学生端：图片在 public/showcase/promo/android/（已缩到 600px 宽）。
export const ANDROID_CHAPTERS = [
  chapter(
    "auth", "登录 / 注册 / 找回密码",
    "一个账号，手机与电脑通用",
    "手机号或邮箱登录；忘记密码可自助重置。",
    ["手机号 / 邮箱登录", "教师身份审核", "找回密码"],
    [
      "showcase/promo/android/login.jpg",
      "showcase/promo/android/register.jpg",
      "showcase/promo/android/forgot-password.jpg",
    ],
    150, "violet"
  ),
  chapter(
    "home", "首页",
    "打卡、目标、热力图一屏掌握",
    "科学抽题 + 遗忘曲线；今天该练什么一目了然。",
    ["连续打卡与今日目标", "学习热力图", "练习 / 考试 / 资料 / AI 四个入口"],
    ["showcase/promo/android/home.jpg"],
    120, "sky"
  ),
  chapter(
    "bank", "题库",
    "全市共享题库，按条件筛选",
    "题干关键词、题型、难度、科目、知识点。",
    ["关键词搜索", "多条件筛选", "题目卡片"],
    ["showcase/promo/android/bank.jpg"],
    120, "emerald"
  ),
  chapter(
    "question-detail", "题目详情",
    "题干、选项、标签完整呈现",
    "收藏与纠错入口就在手边。",
    ["题干与选项", "标签与收藏", "纠错反馈"],
    ["showcase/promo/android/question-detail.jpg"],
    120, "sky"
  ),
  chapter(
    "practice-setup", "开始练习",
    "三种来源、四种练习方式",
    "题库 / 错题本 / 收藏；即时 / 批量 / 顺序。",
    ["三种题目来源", "四种练习方式", "筛选与题量"],
    ["showcase/promo/android/practice-setup.jpg"],
    120, "amber"
  ),
  chapter(
    "answer", "答题页面",
    "选完立即判分，解析同步出现",
    "答错也能马上看到正确答案与解析。",
    ["即时判分", "正确答案与解析", "错题自动归档"],
    [
      "showcase/promo/android/practice.jpg",
      "showcase/promo/android/answer.jpg",
      "showcase/promo/android/answer-feedback.jpg",
    ],
    150, "emerald"
  ),
  chapter(
    "answer-sheet", "答题卡",
    "已答 / 未答一屏总览",
    "随时跳题，交卷前检查一遍。",
    ["答题进度", "已答 / 未答", "随时跳题"],
    ["showcase/promo/android/answer-sheet.jpg"],
    120, "sky"
  ),
  chapter(
    "review", "练习复盘",
    "正确率、用时、逐题回顾",
    "错题直接再练，形成闭环。",
    ["正确率与用时", "逐题回顾", "错题再练"],
    ["showcase/promo/android/review.jpg"],
    120, "amber"
  ),
  chapter(
    "exam", "考试",
    "已入库试卷自助开考",
    "按考试时间作答；草稿存本机。",
    ["自助开考", "按时间作答", "草稿存本机"],
    ["showcase/promo/android/exam.jpg"],
    120, "violet"
  ),
  chapter(
    "leaderboard", "成绩排行",
    "班级 / 学校 / 全市 / 全省",
    "实名排行，整卷每题选项分布。",
    ["四档排行", "实名可见", "选项分布"],
    [
      "showcase/promo/android/leaderboard.jpg",
      "showcase/promo/android/leaderboard-2.jpg",
    ],
    150, "amber"
  ),
  chapter(
    "wrong-book", "错题本",
    "错题自动归档，收藏随时复习",
    "按知识点复盘，从错题本直接开练。",
    ["错题 / 收藏", "按知识点复盘", "直接再练"],
    ["showcase/promo/android/wrong-book.jpg"],
    120, "rose"
  ),
  chapter(
    "forgetting-curve", "遗忘曲线",
    "按 1 / 2 / 4 / 7 / 15 / 30 天安排复习",
    "自己的保持率 vs 艾宾浩斯理论曲线。",
    ["遗忘曲线", "科学复习间隔", "掌握度"],
    ["showcase/promo/android/forgetting-curve.jpg"],
    120, "emerald"
  ),
  chapter(
    "materials", "复习资料",
    "教材、试卷、资料随时下载",
    "下载后可重复使用。",
    ["教材 / 试卷 / 资料", "下载复用", "单份最大 2GB"],
    ["showcase/promo/android/materials.jpg"],
    120, "sky"
  ),
  chapter(
    "ai", "AI 答疑",
    "做题时直接问 AI",
    "不用切出软件；教师自带密钥。",
    ["随手提问", "不切出软件", "教师自带密钥"],
    ["showcase/promo/android/ai.jpg"],
    120, "rose"
  ),
  chapter(
    "profile", "我的",
    "资料、版本、学习记录",
    "当前版本与检查更新。",
    ["个人资料", "当前版本", "学习记录"],
    ["showcase/promo/android/profile.jpg"],
    120, "slate"
  ),
]
