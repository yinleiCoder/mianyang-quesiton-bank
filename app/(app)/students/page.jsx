// 学生名册：一条路由，三种口径（系统管理员=全部 / 学校管理员=本校 / 教师=本校本专业）。
// 「谁的视角」由服务端的 ctx 决定，不再开第二套页面 —— /admin/* 只是侧栏分组，不是权限边界。
// 真正的筛选发生在 SQL 里（can_view_student 逐行过滤，见 0063）：本页拿不到越权数据
// 不是因为这里筛过。
//
// 与「用户与任命」互斥且互补：那边只列非学生身份。
import Link from "next/link"
import { requireUser } from "@/lib/auth"
import { createClient } from "@/lib/supabase/server"
import {
  hasStudentFilters,
  loadMyClassOptions,
  loadStudentRoster,
  parseStudentFilters,
  studentQueryString,
} from "@/lib/students"
import { loadSchools } from "@/lib/reference-data"
import { AccessDenied } from "@/components/access-denied"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { StudentsManager } from "@/components/students/students-manager"
import { ChevronLeftIcon, ChevronRightIcon, GraduationCapIcon } from "lucide-react"

export const metadata = { title: "学生" }

const PAGE_SIZE = 50

export default async function StudentsPage({ searchParams }) {
  const ctx = await requireUser()
  // 待审核教师（teacher_pending）不在此列：还没被认定为教师，不该看到学生名册。
  if (!(ctx.isAdmin || ctx.isSchoolAdmin || ctx.isTeacher)) {
    return <AccessDenied title="仅教师及以上可访问" description="学生账号请使用客户端刷题。" />
  }
  if (ctx.isSchoolAdmin && !ctx.isAdmin && !ctx.profile?.school_id) {
    return <AccessDenied title="档案异常" description="你的档案未绑定学校，请先联系系统管理员绑定。" />
  }

  const supabase = await createClient()
  const { classId, onlyUnassigned, kw, page } = parseStudentFilters((await searchParams) ?? {})

  const [classRes, schools] = await Promise.all([
    loadMyClassOptions(supabase),
    ctx.isAdmin ? loadSchools() : Promise.resolve([]),
  ])
  const classes = classRes.classes ?? []

  // 教师没被指定任教专业时 can_view_student 恒为 false（SQL 里学生专业必须落在教师专业子树内）。
  // 这是设计使然，但页面必须说清楚，否则会被当成故障。只对"纯粹的教师"提示 ——
  // 管理员不靠专业限定范围。
  const isPlainTeacher = ctx.isTeacher && !ctx.isAdmin && !ctx.isSchoolAdmin
  if (isPlainTeacher && classes.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader title="我的学生" description="按班级查看本专业学生的练习与考试情况。" />
        <EmptyState
          icon={GraduationCapIcon}
          title="还没有可查看的学生"
          description="两种可能：学校管理员还没有在「本校用户与任命」里为你指定任教专业，或本校还没有建立班级（管理台 → 班级管理）。联系学校管理员处理后再回来看看。"
        />
      </div>
    )
  }

  const { rows, total, error } = await loadStudentRoster(supabase, {
    classId: classId || null,
    onlyUnassigned,
    keyword: kw,
    page,
    pageSize: PAGE_SIZE,
  })
  // 装载失败要抛出交给错误边界，而不是渲染成空列表 —— 空列表会被读成"这个班没人"。
  if (error) throw error

  const filterValue = { classId, onlyUnassigned, kw }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hrefFor = (p) => {
    const qs = studentQueryString(filterValue, p)
    return qs ? `/students?${qs}` : "/students"
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={ctx.isAdmin ? "学生名册" : ctx.isSchoolAdmin ? "本校学生" : "我的学生"}
        description={
          ctx.isAdmin
            ? "全部学校的学生，可按班级筛选。进入单个学生可查看练习历史、错题与考试成绩；班级由各校学校管理员建立（管理台 → 班级管理）。"
            : ctx.isSchoolAdmin
              ? "本校学生，可按班级筛选与批量归班，进入单个学生可查看练习历史、错题与考试成绩。"
              : "你任教专业下的学生，可按班级筛选，进入单个学生可查看练习历史、错题与考试成绩。"
        }
      />

      <StudentsManager
        rows={rows ?? []}
        classes={classes}
        schools={schools}
        filters={filterValue}
        caller={{
          isAdmin: ctx.isAdmin,
          isSchoolAdmin: ctx.isSchoolAdmin,
          schoolId: ctx.profile?.school_id ?? null,
        }}
        hasFilters={hasStudentFilters(filterValue)}
        total={total}
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-1">
          <PagerLink href={page > 1 ? hrefFor(page - 1) : null}>
            <ChevronLeftIcon className="size-4" /> 上一页
          </PagerLink>
          <span className="px-2 text-sm text-muted-foreground">
            第 {page} / {totalPages} 页
          </span>
          <PagerLink href={page < totalPages ? hrefFor(page + 1) : null}>
            下一页 <ChevronRightIcon className="size-4" />
          </PagerLink>
        </div>
      )}
    </div>
  )
}

function PagerLink({ href, children }) {
  const cls = "inline-flex h-9 items-center gap-1.5 rounded-lg border border-input px-3 text-sm"
  if (!href) {
    return <span className={`${cls} text-muted-foreground/60`}>{children}</span>
  }
  return (
    <Link href={href} className={`${cls} bg-background hover:bg-accent`}>
      {children}
    </Link>
  )
}
