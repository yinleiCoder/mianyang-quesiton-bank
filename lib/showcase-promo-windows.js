import { chapter } from "./showcase-promo-chapter.js"

// Windows 学生端：按真实使用流程排列；图片在 public/showcase/promo/windows/。
export const WINDOWS_CHAPTERS = [
  chapter(
    "auth", "登录 / 注册",
    "一个账号，学生与教师共用",
    "手机号或邮箱登录；教师注册后由学校审核身份。",
    ["手机号 / 邮箱登录", "教师身份审核", "忘记密码可自助重置"],
    ["showcase/promo/windows/login.png", "showcase/promo/windows/register.png"],
    180, "violet"
  ),
  chapter(
    "bank", "题库",
    "全市共享题库，按知识点筛选",
    "题型、难度、知识点与错误率标签一起看。",
    ["题型 / 难度 / 知识点", "错误率标签辅助选题", "分页浏览完整题库"],
    ["showcase/promo/windows/bank.png"],
    150, "sky"
  ),
  chapter(
    "practice-setup", "开始练习",
    "四种练习方式，按需选择",
    "题库 / 错题本 / 收藏三种来源；题量、打乱选项、音效可调。",
    ["即时 / 批量 / 顺序练习", "题库 / 错题本 / 收藏", "题量与选项乱序可调"],
    ["showcase/promo/windows/practice-setup.png"],
    150, "amber"
  ),
  chapter(
    "practice", "练习页",
    "选完立刻判分，解析同步出现",
    "客观题自动判分，错题自动进错题本。",
    ["即时对错反馈", "正确答案与解析", "错题自动归档"],
    ["showcase/promo/windows/practice.png"],
    150, "emerald"
  ),
  chapter(
    "exams", "考试",
    "参加考试，按考试时间作答",
    "已入库试卷自助开考；草稿存本机，断网不丢。",
    ["已入库试卷自助开考", "按考试时间作答", "草稿存本机"],
    ["showcase/promo/windows/exams.png"],
    120, "sky"
  ),
  chapter(
    "exam", "考试页",
    "交卷即出分，成绩随时回看",
    "客观题自动判分；交卷后出分与排名。",
    ["自动判分", "出分与排名", "考试记录可回看"],
    ["showcase/promo/windows/exam.png"],
    150, "violet"
  ),
  chapter(
    "wrong-book", "错题本",
    "错题自动归档，收藏随时复习",
    "错题、收藏、练习记录三个页签；从错题本直接开练。",
    ["错题 / 收藏 / 记录", "按知识点复盘", "从错题本直接再练"],
    ["showcase/promo/windows/wrong-book.png"],
    120, "rose"
  ),
  chapter(
    "leaderboard", "排行榜",
    "班级 / 学校 / 全市 / 全省排行",
    "实名排行；整卷每题的选项分布也能看。",
    ["四档排行榜", "实名可见", "每题选项分布"],
    ["showcase/promo/windows/leaderboard.png"],
    120, "amber"
  ),
  chapter(
    "ai", "AI 答疑",
    "做题时直接问 AI",
    "Windows 端无需手机验证码，不用切出软件。",
    ["随手提问", "不切出软件", "教师自带密钥"],
    ["showcase/promo/windows/ai.png"],
    120, "rose"
  ),
  chapter(
    "profile", "我的",
    "学情、资料、版本一目了然",
    "个人资料、学校、当前版本与检查更新。",
    ["个人资料与学校", "当前版本与更新", "学习记录与设置"],
    ["showcase/promo/windows/profile.png"],
    120, "slate"
  ),
]
