"""生成《职教高考联盟 · 系统与软件功能总结》的 DOCX 与 PDF。

为什么要有这个脚本：
    资料目录里那两份二进制交付物（.docx / .pdf）是从同一份内容渲染出来的，
    内容一改就得同步改两份，手工改必然漏。这里把内容写成**一份数据结构**，
    再用两个渲染器（python-docx 出 Word、PyMuPDF Story 出 PDF）分别落盘。

    文字内容与 docs/移动软件开发/四川省职业院校技能大赛（2026）.md 同源：
    事实（功能、页面数、测试组数、数据库函数数、画板尺寸）都对着仓库里的
    代码核对过；数字变了要改这里，也要去改那份 Markdown。

DOCX 走"打开旧文件 → 清空正文 → 重建"的路线：旧文件里的样式定义
（Segoe UI + 微软雅黑、正文 10.5pt、行距 1.45、标题 1 #4F46E5、表格头底色）
直接复用，不用重新描述一遍排版规则。

PDF 走 PyMuPDF 的 Story（HTML → PDF）：中文字体用 MuPDF 内置的
china-s（Droid Sans Fallback，5 万字形），够用且不依赖外部字体文件。

用法：
    python scripts/build-summary-doc.py
"""

from __future__ import annotations

import io
import os
import re
import sys
import tempfile
from pathlib import Path

import docx
import pymupdf
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Emu, Inches, Pt, RGBColor

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OUT_DIR = DOCS / "移动软件开发"
DOCX_PATH = OUT_DIR / "职教高考联盟_系统与软件功能总结.docx"
PDF_PATH = OUT_DIR / "职教高考联盟_系统与软件功能总结.pdf"

# 取图目录（截图的真实位置，文档里用相对路径引用）
SHOT_WEB = DOCS / "web网页效果图"
SHOT_WIN = DOCS / "windows软件效果图"
SHOT_AND = DOCS / "android软件效果图"

# ── 配色（与旧 DOCX 一致） ─────────────────────────────────────────────
BRAND = RGBColor(0x4F, 0x46, 0xE5)  # 主色：靛蓝
TEXT = RGBColor(0x1F, 0x23, 0x28)  # 正文
MUTED = RGBColor(0x5B, 0x63, 0x6E)  # 次要文字
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

HEX_BRAND = "#4f46e5"
HEX_TEXT = "#1f2328"
HEX_MUTED = "#5b636e"

FONT_LATIN = "Segoe UI"
FONT_EA = "微软雅黑"


# ── 内容（一处改，两处生效） ───────────────────────────────────────────
# 标题区
BRAND_LINE = "职教高考联盟  ·  MYQUIZ.CN"
TITLE = "系统与软件功能总结"
SUBTITLE = "多校共建 · 全市共享的中职题库系统"
META = (
    "网站端　教师与管理 · Next.js　　客户端　学生 · Flutter（Win + Android）"
    "　　后端　Supabase / PostgreSQL"
)

LEAD_LABEL = "一句话概括"
LEAD = (
    "职教高考联盟是一个「多校共建、全市共享」的中职题库系统：教师在网页端用 AI 把纸质卷变成数字题、"
    "经两级审核后组卷考试；学生在 Windows / Android 客户端刷题、考试、看学情；数据自动回流。"
    "出题 → 审题 → 组卷 → 考试 → 练习 → 讲评 → 再练，一个闭环。"
)

PAIN_TABLE = {
    "head": ("教育现场的痛点", "本系统的解法"),
    "rows": [
        (
            "优质题源散落各校、无法共享：好题锁在某个老师电脑或某个学校群里，换学校就归零，同一知识点全市反复造题。",
            "建设全市共享题库：一道题入库、全市可见可组卷；按「公共学科 / 专业大类 / 专业 / 课程」四层知识树组织，"
            "任意层级都能挂题，各校在同一棵树上共建，越用越厚。",
        ),
        (
            "质量参差、无人把关：错题错答案直接进学生练习册，口头教研形同虚设。",
            "两级审批（学科教研组长 → 市级专家）通过才入库；改版必须重新审批，历史版本全留痕——谁出的、谁审的、何时审的"
            "都可追溯；另有题目申诉与学生纠错闭环。",
        ),
        (
            "纸质卷 / Word 转成数字题是纯人力活：一套卷手录一天，还常错行、漏答案、断行。",
            "AI 整卷导入：上传 PDF / Word / 拍照扫描件，自动切页、识别题型与选项、抽取答案和解析、合并跨页被切断的题、"
            "卷内去重、与库内已有题查重，教师只做「校对 + 勾选」。",
        ),
        (
            "出题、组卷、考试、讲评各用一套工具：Word 排版、手动算分、Excel 排行、讲评靠投屏念。",
            "全链路闭环：题库 → 拖拽组卷（自动算分）→ 导出标准 PDF 卷（答案独立成页）→ 下发考试（客观题自动判分）+ "
            "手工评分板 → 排行榜 → 讲评大屏（一题一屏）→ 易错题 → 针对性练习。",
        ),
        (
            "学情数据靠手工统计、到不了学生手里：考完只有一张分数表，学生不知道自己差在哪。",
            "数据自动回流：班级报告、选项分布、易错题、四档排行榜（全班 · 全校 · 全市 · 全省）、AI 班级诊断报告；"
            "学生端同步看到自己的正确率、错题本、遗忘曲线。",
        ),
    ],
}

TEACHER_BULLETS = [
    (
        "出题",
        "6 种题型（单选 / 多选 / 判断 / 填空 / 主观 / 综合复合题），结构化编辑，支持图片、音频、视频与文档附件。",
    ),
    (
        "AI 整卷导入",
        "浏览器内直接解析 PDF（含扫描件），多标签页自动排队、断点可续，逐页进度与费用估算可见；解析结果先校对、"
        "勾选，确认后才生成草稿。生成草稿后还有审题预检：答案键、重复选项、“以上都不对”、否定式题干、标签与科目、"
        "查重三档、难度是否与标注相符——规则检查不需要密钥；配了密钥还可让 AI 按规范性、科学性、区分度、难度、标签、"
        "语言六维复审，只给建议，绝不自动改题或退回。密钥只存在教师本机浏览器，请求从浏览器直达大模型，站点不保存、"
        "也不替用户付钱。",
    ),
    (
        "我的题目",
        "草稿 → 提交 → 审核中 → 已入库 / 已退回；支持改版、撤回、上下线申请，每一步都有记录。",
    ),
    (
        "智能组卷与一句话组卷",
        "拖拽排序；按题 / 按空 / 按小问三种分值口径；自动算分与健康检查（题目已下线、题库有新版本）；一键导出 PDF、"
        "打印、讲评大屏。智能组卷按题型、知识点、难度配比、分值口径、曝光与相似度在浏览器本地求解（贪心 + 模拟退火），"
        "可预览换题后再应用；不调用大模型、不产生费用，服务端只返回不含题干与答案的紧凑特征。"
        "另可一句话组卷：“给我出一套 90 分、避开最近 30 天的卷子”先转成结构化约束，再交给本地优化器求解；"
        "信息不足时回问而不是猜。",
    ),
    (
        "考试与阅卷",
        "下发班级；综合题按「小问 - 空」逐点给分的人工评分板；填空题、综合题与简答题由教师阅卷，客观题交卷自动判分，"
        "阅卷完成出分与排名；主观题可请求 AI 评分建议（按评分点给分与依据，只填建议、不自动落库）。"
        "「阅卷队列」把待批卷子汇成一条队列，认领后才轮到自己，别人已认领当场提示冲突。",
    ),
    (
        "学情",
        "排行榜、试题分析（选项分布、逐空正确率）、班级学情报告；一句话问学情（“这个班哪个知识点最差”）只映射到"
        "白名单意图与只读接口，模型不写 SQL、不碰数据。AI 班级诊断按班成文（成绩分布、题型难度、学生分层、错误归因、"
        "SOLO 层次、时间管理、行动建议），报告直接使用学生真名（仅本班教师与本校授权管理者可见）。"
        "另有试题质量诊断（CTT）：难度、区分度、上下 27% 干扰项、A–D 质量分档，样本不足时明确不给结论；"
        "AI 报告之后可一键生成 45 分钟讲评教案（目标、关键题、时间线、板书、分层、作业、出口票），无密钥时模板兜底，"
        "报告或学情变化会提示教案过期。成绩榜跨版本合并：发布新版不迁移、不重算旧场次，每人取最新一次官方成绩。",
    ),
    (
        "变式题与标签推荐",
        "AI 变式题按“换数据 / 换情境 / 换问法 / 组合知识点”四维度，从一道原题生成同题型同知识点的变式草稿，只出草稿"
        "不自动发布；AI 标签推荐从候选标签里挑出最贴题的 1–5 个（附置信度与理由），人工点选后才入库。",
    ),
    (
        "错因诊断",
        "把学生的失分归到八类固定错因（概念混淆、审题偏差、计算、单位、知识缺口、蒙猜、时间压力、其他），"
        "证据必须是原卷原文的子串；样本不足 5 条就不下结论。",
    ),
    (
        "资料中心",
        "整本教材、整套卷子（单份最大 2 GB），学生端可直接在应用内打开。",
    ),
    (
        "AI 配置",
        "全站 AI（导入、班级诊断、审题、教案、评分、变式、标签推荐、错因诊断、组卷意图、学情意图）共用一个密钥与模型；"
        "密钥只存在教师本机浏览器 localStorage，不上传、不写库、不跨设备。没配密钥时规则审题、智能组卷、模板教案照常可用。",
    ),
]

ADMIN_TEXT = (
    "市管理、学校管理、班级管理、科目树维护、知识点管理、用户与任命、审批记录、审计日志、意见反馈——十个后台页面，"
    "学校与权限都能自助维护。"
)

WEB_HIGHLIGHTS = [
    "① AI 而不花钱：教师自备密钥、请求从浏览器直达大模型，站点零密钥成本、零调用费用。智能组卷完全在浏览器本地计算，连模型都不调用。",
    "② 可协作：市级专家按「大题内题号区间 + 目标分」把一份卷分给多人，段级乐观锁，多人同时编辑不互相覆盖。",
    "③ 能直接印：中文自动折行、行首禁则、正卷不含答案，输出的 PDF 与网页版式同源。",
    "④ 权限在数据库：前端拿不到越权数据，绕不过去。",
    "⑤ AI 贯穿教学全流程：审题、组卷、阅卷、讲评教案与学生学习路径共用一套数据；模型只给建议，最终决定始终由教师做。",
    "⑥ 有展示页：软件宣传展示、架构流程图、架构动画、AI 算法说明、科学抽题算法动画五个只读页，学生和教师都看得见；"
    "动画里的数字用与生产环境同一份公式现算，不是编的。",
]

CLIENT_BULLETS = [
    (
        "练习",
        "即时练习（边做边出对错与解析）、整卷练习、顺序练习（讲练用，不计统计）、背题模式（只翻卡不答题）。",
    ),
    (
        "科学抽题",
        "新题 → 到期复习 → 补位 → 今日已练，按 FSRS-6 记忆模型调度（目标保持率 90%、最长 180 天），"
        "并用 BKT 估计掌握度：新题保底 40%、到期复习 30%、已掌握题最多 10%；当天练过的题不再发；"
        "池子空了明确提示「今天练完了」。（旧版 1 / 2 / 4 / 7 / 15 / 30 天阶梯只作历史。）"
        "首页把科学抽题、FSRS、BKT、遗忘曲线做成四张卡片，排在当月完整热力图与连续打卡区域下方。",
    ),
    (
        "AI 学习路径",
        "按 BKT 掌握度画出薄弱知识点与推荐理由（新题 / 到期复习 / 薄弱知识点 / 信息量大 / 巩固），"
        "可直接从「专项练题」或「到期复习」一键开始。",
    ),
    (
        "学习画像",
        "首页给每个学生画一张六轴雷达图——掌握度、正确率、投入度、成长性、广度、稳定性——并据此给出学习人格标签"
        "（稳健型 / 冲刺型 / 探索型 / 勤勉型 / 均衡型 / 成长型 / 新同学）。纯规则、不调用大模型，"
        "网页端与客户端用同一份镜像实现，两端看到的画像一模一样。",
    ),
    (
        "考试",
        "按卷面时长作答、草稿本机保存断网不丢；客观题自动判分，填空 / 综合 / 简答题由教师阅卷，判完出分与排名；"
        "可看选项分布与自己位次；记录永久可回看。",
    ),
    (
        "成长",
        "错题本、收藏、遗忘曲线、每日趋势、学习热力图、每日打卡与目标；「我的 → 学习计划」可设置每日目标题数，"
        "并说明 FSRS / BKT / 遗忘曲线的抽题原理。",
    ),
    (
        "资料",
        "PDF / 图片应用内阅读，Office 等交给系统程序；保存到本地在两端各自合理（Windows 写下载目录 / Android 走系统分享）。",
    ),
    ("AI 答疑", "做题中随时唤起，机房电脑也能用，不依赖手机。"),
    (
        "更新",
        "启动读版本清单检查更新，下载走国内云存储；APK 在桶里另存 .bin 副本，由浏览器取回后改名存盘"
        "（云厂商不允许 .apk 从默认域名分发），下载页印出 SHA-256 供用户核对。",
    ),
]

CLIENT_HIGHLIGHTS = [
    "① 双端同源：一套代码出 Windows + Android，手机竖屏 390×844 与桌面 1280×720 两套适配。",
    "② 判分一致：客户端本地判分只做「抢先显示」，服务端结果权威覆盖，二者由测试锁定同一结果。",
    "③ 离线友好：断网草稿、资料缓存复用、GB 级文件流式下载。",
    "④ 隐私硬红线：崩溃上报显式关闭截图、视图层级、调试面包屑与身份信息（未成年学生数据）。",
]

# 截图（真实运行界面）：(文件, 说明, 是否竖版)
#
# ⚠ 每一组必须**方向一致**：Story 的表格不会跨页断行，一组里混着竖版与横版图时，
# 它按第一行算列宽，后面几行就被挤到版心右侧的窄条里（实测过一次，很难看）。
# 所以网页端 / Windows 端 / Android 端各占一张表。
GALLERY = [
    (
        "网页端 · 教师与管理端",
        [
            (SHOT_WEB / "工作图.png", "工作台：待办、公告与常用入口的聚合页", False),
            (SHOT_WEB / "AI智能解析题库资料.png", "AI 智能解析：上传 PDF / Word 后逐页识别", False),
            (SHOT_WEB / "审批邮件箱.png", "审批收件箱：两级审批的入口", False),
            (SHOT_WEB / "试卷详情.png", "试卷详情：成绩、阅卷与试题分析", False),
            (SHOT_WEB / "AI分析学情.png", "AI 分析学情：班级诊断报告", False),
            (SHOT_WEB / "软件架构流程图.png", "软件架构与人员层级管理结构流程图", False),
        ],
    ),
    (
        "客户端 · Windows 端（机房电脑，1280×720 窗口）",
        [
            (SHOT_WIN / "登录.png", "登录：手机号与邮箱两种账号", False),
            (SHOT_WIN / "开始练习.png", "开始练习：选择科目与练习方式", False),
            (SHOT_WIN / "练习页.png", "练习页：答题、即时反馈与解析", False),
            (SHOT_WIN / "考试页.png", "考试页：右侧常驻答题卡", False),
            (SHOT_WIN / "错题本.png", "错题本：自动收录与重做", False),
            (SHOT_WIN / "排行榜.png", "排行榜：四档榜单与自己的位次", False),
        ],
    ),
    (
        "客户端 · Android 端（手机竖屏 390×844）",
        [
            (SHOT_AND / "首页.jpg", "首页：打卡、当月热力图与抽题原理", True),
            (SHOT_AND / "答题页面.jpg", "答题页面：六种题型作答", True),
            (SHOT_AND / "答题卡.jpg", "答题卡：快速跳转与交卷", True),
            (SHOT_AND / "成绩排行.jpg", "成绩排行：班级 / 学校 / 市 / 省", True),
            (SHOT_AND / "错题本.jpg", "错题本", True),
            (SHOT_AND / "艾宾浩斯遗忘曲线.jpg", "遗忘曲线：科学复习节奏可视化", True),
        ],
    ),
]

TECH_TABLE = {
    "head": ("维度", "做法"),
    "rows": [
        (
            "安全边界在数据库",
            "客户端与浏览器对表只有读权限，所有写操作走数据库函数 + 行级安全规则；越权测试直接打接口验证。",
        ),
        (
            "打开更快",
            "登录状态本地验签，不必每页回一次服务器；首页首字节从 3.3 秒降到约 0.02 秒（流式渲染 + 骨架屏）。",
        ),
        (
            "AI 在浏览器里跑",
            "PDF 解析、题目识别、审题复审、教案与评分建议全在前端完成，密钥不出教师电脑，站点不承担调用费用；"
            "智能组卷完全在本地计算。",
        ),
        (
            "质量靠自动化守住",
            "客户端 81 个测试文件 + 5 个端到端场景 + 自研架构检查脚本；网页端 19 组断言"
            "（PDF 导出 37 项、手机号 45+ 项，另有 CTT / 智能组卷 / 审题 / 教案 / 评分 / 变式 / 标签推荐 / 错因诊断 / "
            "学习画像 / 组卷意图 / 学情意图 / 展示页算法）；150 个数据库迁移文件按序可重放。",
        ),
        (
            "教育测量闭环",
            "同一份作答数据同时用于 CTT 题目诊断（难度 / 区分度 / 干扰项）、BKT 掌握度估计与 FSRS-6 复习排期；"
            "口径在 SQL、纯函数与两端文案之间对齐。",
        ),
        (
            "多渠道分发与自愈",
            "双平台 CI 自动出包、校验正式签名、镜像到国内云存储；APK 另存 .bin 副本、由浏览器改名存盘；发布页印 SHA-256。",
        ),
        (
            "可观测",
            "客户端崩溃上报（符号化堆栈、版本健康度）+ 网页端 Sentry（Node / Edge / 浏览器，未配 DSN 不初始化）"
            "+ 数据库审计日志 + 用户反馈。",
        ),
        (
            "设计到交付是短链",
            "美工只用三件工具：Figma 出原型与设计系统，Photoshop 处理位图，蓝湖挂载设计稿与切图做标注交付——"
            "切图按 @2x/@3x、只用 PNG / JPG（网页端 PDF 导出不认 WebP），开发按标注 1:1 还原。",
        ),
    ],
}

SELLING = [
    "1　一套系统顶三套：题库管理 + 组卷考试 + 学生刷题 App，不必再拼 Word、Excel 与外部刷题软件。",
    "2　AI 把存量卷子一次搬进数字世界：「一套卷录一天」变成「十几分钟校对一遍」，学校已有的题源立刻可用。",
    "3　越用越厚、越用越准：多校共建 + 两级审核 + 查重防撞题，题量与质量同时滚雪球。",
    "4　学生真的愿意用：客观题即时判分与解析、排行榜、错题本、遗忘曲线、AI 学习路径、电脑与手机都能练。",
    "5　学校零门槛：一所学校可自建自用，多校加入自动形成联盟；云托管、免运维。",
    "6　数据安全可控：答案与正卷分离、AI 密钥不入库、操作全程审计、报告只在本班教师端生成——能过学校与教研部门的合规审查。",
]

SCALE_TABLE = {
    "head": ("已入库题目", "学校", "学生", "教师", "市区", "正式试卷", "已交卷人数"),
    "rows": [
        ("792 道", "10 所", "166 人", "6 人", "2 个", "1 份（59 题 / 90 分钟 / 满分 200）", "34 人"),
    ],
}
SCALE_NOTE = "数据截至 2026 年 10 月，来自生产环境统计快照。"

HOWTO = [
    "1　建库　学校管理员开通学校、班级与科目树；教研组长把本校存量的 PDF / Word 试卷批量导入，专家审核入库。",
    "2　用起来　教师按知识点组卷 → 下发班级 → 学生在 Windows 或 Android 端考试 / 练习 → 教师看报告与排行 → 讲评课投屏讲易错题。",
    "3　连成联盟　多所学校加入同一题库，题目与学情按权限互相可见，逐步形成市级优质题池。",
]

ENTRY = [
    "网站　https://myquiz.cn　（教师与管理端；客户端安装包在网站「下载」页）",
    "源码　github.com/yinleiCoder/mianyang-quesiton-bank",
    "　　　github.com/yinleiCoder/mianyang-quiz",
]


# ── DOCX 渲染 ──────────────────────────────────────────────────────────
def _set_ea_font(run):
    """给 run 补上东亚字体，否则 Word 里中文会掉回默认宋体。"""
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), FONT_LATIN)
    rfonts.set(qn("w:hAnsi"), FONT_LATIN)
    rfonts.set(qn("w:eastAsia"), FONT_EA)


def _run(paragraph, text, *, size=10.5, bold=False, color=TEXT):
    r = paragraph.add_run(text)
    r.font.name = FONT_LATIN
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.color.rgb = color
    _set_ea_font(r)
    return r


def _clear_body(document):
    body = document.element.body
    for child in list(body.iterchildren()):
        if child.tag != qn("w:sectPr"):
            body.remove(child)


def _shade(cell, hex_fill):
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    cell._tc.get_or_add_tcPr().append(shd)


def _para(doc, text="", *, size=10.5, bold=False, color=TEXT, align=None, space_after=4):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(space_after)
    if text:
        _run(p, text, size=size, bold=bold, color=color)
    return p


def _heading(doc, text, level):
    p = doc.add_paragraph(style=f"Heading {level}")
    size = 15 if level == 1 else 12
    _run(p, text, size=size, bold=True, color=BRAND)
    return p


def _lead_bullet(doc, label, body):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(4)
    _run(p, "· ", bold=True, color=BRAND)
    _run(p, f"{label}　", bold=True)
    _run(p, body)
    return p


def _table(doc, head, rows, widths=None):
    t = doc.add_table(rows=1, cols=len(head))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, text in enumerate(head):
        cell = t.rows[0].cells[i]
        _shade(cell, "4F46E5")
        p = cell.paragraphs[0]
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(2)
        _run(p, text, size=9, bold=True, color=WHITE)
    for row in rows:
        cells = t.add_row().cells
        for i, text in enumerate(row):
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(2)
            _run(p, text, size=9)
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = w
    return t


def _image_para(doc, path, portrait):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run()
    _set_ea_font(run)
    if portrait:
        run.add_picture(str(path), height=Inches(2.9))
    else:
        run.add_picture(str(path), width=Inches(3.0))
    return p


def build_docx():
    doc = docx.Document(str(DOCX_PATH))
    _clear_body(doc)

    # 标题区
    _para(doc, BRAND_LINE, size=9.5, bold=True, color=MUTED, space_after=2)
    _para(doc, TITLE, size=27, bold=True, color=TEXT, space_after=2)
    _para(doc, SUBTITLE, size=12.5, color=MUTED, space_after=2)
    _para(doc, META, size=8.5, color=MUTED, space_after=10)

    _para(doc, LEAD_LABEL, size=10.5, bold=True, color=BRAND, space_after=2)
    _para(doc, LEAD, space_after=8)

    # 一、核心问题
    _heading(doc, "一、解决的核心问题", 1)
    _para(doc, "中职学生「没有好题可练」，根子不在学生，而在题源的生产与流转方式。五个真实痛点，对应五个解法。")
    _table(doc, PAIN_TABLE["head"], PAIN_TABLE["rows"], widths=[Inches(2.6), Inches(3.9)])
    _para(doc, "", space_after=6)

    # 二、网站
    _heading(doc, "二、系统（网站 · 教师与管理端）的功能特点", 1)
    _heading(doc, "教师日常", 2)
    for label, body in TEACHER_BULLETS:
        _lead_bullet(doc, label, body)
    _heading(doc, "管理端（十个后台页）", 2)
    _para(doc, ADMIN_TEXT)
    _heading(doc, "亮点", 2)
    for text in WEB_HIGHLIGHTS:
        _para(doc, text)

    # 三、客户端
    _heading(doc, "三、软件（学生端 · Flutter，Windows + Android）的功能特点", 1)
    for label, body in CLIENT_BULLETS:
        _lead_bullet(doc, label, body)
    _heading(doc, "亮点", 2)
    for text in CLIENT_HIGHLIGHTS:
        _para(doc, text)

    # 四、界面一览
    _heading(doc, "四、界面一览（真实运行截图）", 1)
    _para(doc, "以下全部是线上真实运行的界面，不是设计稿。一套后端、两个前端：网页端（教师 / 管理端，Next.js）"
               "与 Flutter 客户端（学生端，Windows + Android）。")
    for group, items in GALLERY:
        _heading(doc, group, 2)
        t = doc.add_table(rows=0, cols=2)
        t.style = "Table Grid"
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        for i in range(0, len(items), 2):
            cells = t.add_row().cells
            for j in range(2):
                cell = cells[j]
                idx = i + j
                p = cell.paragraphs[0]
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                p.paragraph_format.space_after = Pt(2)
                if idx >= len(items):
                    continue
                path, caption, portrait = items[idx]
                _image_para(cell, path, portrait)
                cp = cell.add_paragraph()
                cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
                cp.paragraph_format.space_after = Pt(4)
                _run(cp, caption, size=8, color=MUTED)
        _para(doc, "", space_after=6)

    # 五、技术与工程亮点
    _heading(doc, "五、技术与工程亮点", 1)
    _table(doc, TECH_TABLE["head"], TECH_TABLE["rows"], widths=[Inches(1.7), Inches(4.8)])

    # 六、差异化卖点
    _heading(doc, "六、差异化卖点", 1)
    for text in SELLING:
        _para(doc, text)

    # 七、当前线上规模
    _heading(doc, "七、当前线上规模", 1)
    _table(doc, SCALE_TABLE["head"], SCALE_TABLE["rows"])
    _para(doc, SCALE_NOTE)

    # 八、从零开始怎么用
    _heading(doc, "八、从零开始怎么用", 1)
    for text in HOWTO:
        _para(doc, text)
    _para(doc, "", space_after=4)
    _para(doc, "线上入口", size=10.5, bold=True, color=BRAND, space_after=2)
    for text in ENTRY:
        _para(doc, text)

    doc.save(str(DOCX_PATH))
    return DOCX_PATH


# ── PDF 渲染（PyMuPDF Story） ───────────────────────────────────────────
def _esc(text):
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )


def _img_size(path, portrait):
    """按图片原始宽高比决定插图尺寸：竖版限高，横版限宽。

    竖版高度定在 2.35in 是算过的：三行竖版图 + 三行图注 + 小标题，
    要能塞进 A4 的一个版心（上下各 62pt 边距后约 9.9in）。
    再高一点这张表就会跨页断开，而 Story 跨页断表时表头会被画在
    上一段的图片上面（实测过一次，图被一条靛蓝色横带压住）。
    """
    if portrait:
        return "height: 2.35in;"
    return "width: 2.95in;"


def _pick_cjk_fonts():
    """找一款可用的中文字体（等线优先），返回 (archive键, 路径) 两组。

    为什么不用 MuPDF 内置的 china-s：那款会把 5 万字形整包嵌进 PDF。
    等线（DengXian）是 Windows 自带、与产品界面同款的字体，机器上基本都有。

    这里返回的是**整份**字体；真正嵌进 PDF 的是它的子集（见 _subset_fonts），
    Story 会把 @font-face 给的字体整个写进 PDF，不切一刀就是 16MB。
    """
    win = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    candidates = [("doc-regular.ttf", win / "Deng.ttf"), ("doc-bold.ttf", win / "Dengb.ttf")]
    if all(p.is_file() for _, p in candidates):
        return candidates
    return None


def _subset_fonts(charset):
    """用仓库自带的 subset-font（harfbuzz）把字体切成本次文档用到的那些字。

    走 Node 是因为 subset-font 是本仓 node_modules 里的依赖，不另装东西。
    切完产物只有一百来 KB，PDF 从 23MB 回到几 MB。

    产物落在临时目录（调用方负责随 Story 用完一起释放），不往仓库里写。
    """
    import subprocess

    script = ROOT / "scripts" / "subset-doc-font.mjs"
    if not script.is_file():
        return None
    tmpdir = tempfile.mkdtemp(prefix="summary-font-")
    charset_file = Path(tmpdir) / "charset.txt"
    charset_file.write_text("".join(sorted(charset)), encoding="utf-8")
    try:
        proc = subprocess.run(
            ["node", str(script), str(charset_file), tmpdir],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=str(ROOT),
        )
    except FileNotFoundError:
        print("  没找到 node，跳过字体子集（PDF 会偏大）")
        return None
    if proc.returncode != 0:
        print("  字体子集失败，用整份字体：")
        print((proc.stderr or "").strip()[:400])
        return None
    for line in (proc.stdout or "").splitlines():
        if "KB" in line:
            print(" ", line.strip())
    return Path(tmpdir)


def _export_pdf_via_word(docx_path, pdf_path):
    """用本机 Word 把 DOCX 导出成 PDF。

    为什么不用 PyMuPDF 自带的渲染：它不认 Word 的样式表（表格头底色、字体、
    行距全得用 HTML 再描述一遍），而且 Story 排版有个坑——**带底色的表格首行
    会在每一页上重复画一遍**，实测每页中间都横着一条靛蓝色带。
    Word 导出是所见即所得：DOCX 什么样，PDF 就什么样。

    没装 Word 就返回 False，由调用方退回 HTML 渲染那条路。
    """
    import subprocess
    import tempfile

    ps = r"""
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $doc = $word.Documents.Open($args[0], $false, $true, $false)
    $doc.ExportAsFixedFormat($args[1], 17)
    $doc.Close(0)
} finally {
    $word.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
"""
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "word2pdf.ps1"
        script.write_text(ps, encoding="utf-8-sig")
        cmd = [
            "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(script), str(docx_path), str(pdf_path),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  encoding="utf-8", errors="replace")
        except FileNotFoundError:
            print("  没找到 powershell，跳过 Word 导出")
            return False
        if proc.returncode != 0:
            print("  Word 导出失败：")
            print((proc.stderr or proc.stdout or "").strip()[:500])
            return False
    return pdf_path.is_file()


def build_pdf():
    """优先用 Word 导出；没有 Word 才退回 PyMuPDF 的 HTML 渲染。"""
    if _export_pdf_via_word(DOCX_PATH, PDF_PATH):
        return PDF_PATH
    return _build_pdf_fallback()


def _build_pdf_fallback():
    archive = pymupdf.Archive()
    html = []
    a = html.append

    # 中文字体通过 @font-face 挂进 Story 的 archive（最终嵌进 PDF 的是子集）。
    fonts = _pick_cjk_fonts()
    css_font = "sans-serif"
    if fonts:
        a("<html><head><style>")
        a("@font-face { font-family: DocFont; src: url(doc-regular.ttf); }")
        a("@font-face { font-family: DocFont; font-weight: bold; src: url(doc-bold.ttf); }")
        a("body { font-family: DocFont; }")
        a("</style></head><body>")
        css_font = "DocFont"
    else:
        a("<html><body>")

    def ff():
        return f"font-family: {css_font}; "

    a(f'<p style="{ff()}font-size: 9.5pt; color: {HEX_MUTED};"><b>{_esc(BRAND_LINE)}</b></p>')
    a(f'<h1 style="{ff()}font-size: 26pt; color: {HEX_TEXT}; margin-bottom: 2pt;">{_esc(TITLE)}</h1>')
    a(f'<p style="{ff()}font-size: 12.5pt; color: {HEX_MUTED};">{_esc(SUBTITLE)}</p>')
    a(f'<p style="{ff()}font-size: 8.5pt; color: {HEX_MUTED}; margin-bottom: 14pt;">{_esc(META)}</p>')
    a(f'<p style="{ff()}font-size: 10.5pt; color: {HEX_BRAND};"><b>{_esc(LEAD_LABEL)}</b></p>')
    a(f'<p style="{ff()}font-size: 10.5pt; color: {HEX_TEXT}; margin-bottom: 14pt;">{_esc(LEAD)}</p>')

    def h1(text):
        a(f'<h1 style="{ff()}font-size: 15pt; color: {HEX_BRAND}; '
          f'margin-top: 10pt; margin-bottom: 6pt;">{_esc(text)}</h1>')

    def h2(text):
        a(f'<h2 style="{ff()}font-size: 12pt; color: {HEX_BRAND}; '
          f'margin-top: 8pt; margin-bottom: 4pt;">{_esc(text)}</h2>')

    def p(text, color=HEX_TEXT, size=10.5, after=6):
        a(f'<p style="{ff()}font-size: {size}pt; color: {color}; '
          f'margin-bottom: {after}pt; line-height: 1.45;">{text}</p>')

    def bullet(label, body):
        p(f'<b style="color: {HEX_BRAND};">·</b> <b>{_esc(label)}</b>　{_esc(body)}')

    def table(head, rows, widths=None):
        """widths 是每列的百分比，用来免得第一列被挤成一字一行。

        表头**不上底色**：PyMuPDF 的 Story 会把「带底色的表格首行」在每一页上
        重画一遍（每页中间横一条靛蓝色带）。改成同色边框 + 同色字就没有底色可画。
        """
        a(f"<table style='width: 100%; border-collapse: collapse; {ff()}font-size: 9pt;'>")
        if widths:
            a("<colgroup>")
            for w in widths:
                a(f'<col style="width: {w}%;">')
            a("</colgroup>")
        a("<tr>")
        for h in head:
            a(f'<td style="border: 1pt solid {HEX_BRAND}; color: {HEX_BRAND}; '
              f"padding: 3pt; text-align: left;\"><b>{_esc(h)}</b></td>")
        a("</tr>")
        for row in rows:
            a("<tr>")
            for cell in row:
                a(f'<td style="border: 0.5pt solid #cccccc; padding: 3pt; vertical-align: top;">{_esc(cell)}</td>')
            a("</tr>")
        a("</table>")
        a('<p style="font-size: 6pt; margin-bottom: 0;"> </p>')

    h1("一、解决的核心问题")
    p("中职学生「没有好题可练」，根子不在学生，而在题源的生产与流转方式。五个真实痛点，对应五个解法。")
    table(PAIN_TABLE["head"], PAIN_TABLE["rows"], widths=[38, 62])

    h1("二、系统（网站 · 教师与管理端）的功能特点")
    h2("教师日常")
    for label, body in TEACHER_BULLETS:
        bullet(label, body)
    h2("管理端（十个后台页）")
    p(_esc(ADMIN_TEXT))
    h2("亮点")
    for text in WEB_HIGHLIGHTS:
        p(_esc(text))

    h1("三、软件（学生端 · Flutter，Windows + Android）的功能特点")
    for label, body in CLIENT_BULLETS:
        bullet(label, body)
    h2("亮点")
    for text in CLIENT_HIGHLIGHTS:
        p(_esc(text))

    h1("四、界面一览（真实运行截图）")
    p(_esc("以下全部是线上真实运行的界面，不是设计稿。一套后端、两个前端：网页端（教师 / 管理端，Next.js）"
           "与 Flutter 客户端（学生端，Windows + Android）。"))
    for gi, (group, items) in enumerate(GALLERY):
        # 第一组之后另起一页：Story 的表格不跨页断行，标题若留在上一页页尾就成了孤儿。
        if gi:
            a('<p style="page-break-before: always; font-size: 1pt; margin-bottom: 0;"> </p>')
        h2(group)
        a("<table style='width: 100%; border-collapse: collapse;'>")
        a("<colgroup><col style='width: 50%;'><col style='width: 50%;'></colgroup>")
        for i in range(0, len(items), 2):
            a("<tr>")
            for j in range(2):
                idx = i + j
                a("<td style='text-align: center; vertical-align: top; padding: 4pt;'>")
                if idx < len(items):
                    path, caption, portrait = items[idx]
                    key = f"shot{gi}_{idx}.png"
                    archive.add(str(path), key)
                    a(f'<img src="{key}" style="{_img_size(path, portrait)}">')
                    a(f'<p style="{ff()}font-size: 8pt; color: {HEX_MUTED}; '
                      f"text-align: center;\">{_esc(caption)}</p>")
                a("</td>")
            a("</tr>")
        a("</table>")
        a('<p style="font-size: 6pt; margin-bottom: 0;"> </p>')

    # 这张表有 8 行，放不下时 Story 会把表头的底色画在**上一个元素的位置上**
    # （实测：那页的截图中间横着一条靛蓝色带）。先让它另起一页，避开这个坑。
    a('<p style="page-break-before: always; font-size: 1pt; margin-bottom: 0;"> </p>')
    h1("五、技术与工程亮点")
    table(TECH_TABLE["head"], TECH_TABLE["rows"], widths=[22, 78])

    h1("六、差异化卖点")
    for text in SELLING:
        p(_esc(text))

    h1("七、当前线上规模")
    table(SCALE_TABLE["head"], SCALE_TABLE["rows"])
    p(_esc(SCALE_NOTE), size=9)

    h1("八、从零开始怎么用")
    for text in HOWTO:
        p(_esc(text))
    p("<b>线上入口</b>", color=HEX_BRAND, after=2)
    for text in ENTRY:
        p(_esc(text))

    a("</body></html>")
    html_text = "".join(html)
    # 留一份 HTML 源码在临时目录里：Story 的排版问题（串行、错位）只能对着源码查。
    # 不落在 docs/ 下——那是 Obsidian 仓库，不该混进构建中间产物。
    (Path(tempfile.gettempdir()) / "_summary-preview.html").write_text(html_text, encoding="utf-8")

    # 字体子集：等线整份 16MB，按这次文档真正用到的字切一刀才是能发出去的体积。
    # 子集落在临时目录里，用完随临时目录一起消失，不往仓库里留中间产物。
    font_dir = None
    if fonts:
        charset = set(re.sub(r"<[^>]+>", "", html_text))
        charset.update(chr(c) for c in range(0x20, 0x7F))
        font_dir = _subset_fonts(charset)
        for key, original in fonts:
            path = (font_dir / key) if font_dir else None
            if path is None or not path.is_file():
                path = original
            archive.add(str(path), key)

    story = pymupdf.Story(html=html_text, archive=archive)
    buf = io.BytesIO()
    writer = pymupdf.DocumentWriter(buf)
    mediabox = pymupdf.paper_rect("a4")
    where = mediabox + (62, 62, -62, -62)
    more = 1
    while more:
        device = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(device)
        writer.end_page()
    writer.close()

    # DocumentWriter 写出来的图是**未压缩的原始 RGB**（12 张截图能到 49MB），
    # 字体也是整份嵌入。这里重存一遍：deflate 压掉图，garbage 收拾掉重复对象。
    doc = pymupdf.open(stream=buf.getvalue(), filetype="pdf")
    doc.save(str(PDF_PATH), deflate=True, garbage=4)
    doc.close()
    return PDF_PATH


def main():
    missing = [p for _, items in GALLERY for p, _, _ in items if not p.is_file()]
    if missing:
        print("缺少截图：")
        for p in missing:
            print("  ", p)
        sys.exit(1)
    d = build_docx()
    print("DOCX:", d, f"{d.stat().st_size / 1024:.0f} KB")
    p = build_pdf()
    print("PDF: ", p, f"{p.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
