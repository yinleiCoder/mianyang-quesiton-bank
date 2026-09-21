"use client"

// 复习资料的管理与浏览。
//
// 与 classes-manager 同形：筛选走 URL（服务端重查，口径只有服务端一处），
// 写操作走 RPC 成功后 router.refresh() —— 不在这里维护一份本地副本，
// 资料的权威副本在服务端（RLS 也在服务端，前端筛过的结果不算数）。
import { useState } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { cn } from "cn"
import { createClient } from "@/lib/supabase/client"
import { nodePathOf } from "@/lib/subject-nodes"
import {
  MATERIAL_KINDS,
  materialQueryString,
  parseMaterialFilters,
} from "@/lib/materials"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { EmptyState } from "@/components/empty-state"
import { TreePicker } from "@/components/admin/tree-picker"
import { MaterialCard } from "@/components/materials/material-card"
import { MaterialUploadDialog } from "@/components/materials/material-upload-dialog"
import { Loader2Icon, UploadIcon } from "lucide-react"

export function MaterialsManager({ rows, total, page, pageSize, nodes, caller }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const filters = parseMaterialFilters(Object.fromEntries(searchParams.entries()))

  const [uploading, setUploading] = useState(false)
  const [picking, setPicking] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [busy, setBusy] = useState(false)
  // 关键词是受控输入，先落在本地，按回车或点「筛选」才写进 URL ——
  // 每敲一个字就发一次请求既费流量又会让列表乱跳（bank_filter_sheet 的草稿模式同款取舍）
  const [kw, setKw] = useState(filters.kw)

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  function apply(next, nextPage = 1) {
    const qs = materialQueryString({ ...filters, ...next }, nextPage)
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  async function togglePublish(material) {
    setBusy(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.rpc("set_review_material_published", {
        p_id: material.id,
        p_published: !material.is_published,
      })
      if (error) throw error
      toast.success(material.is_published ? "已下架，学生看不到了" : "已重新上架")
      router.refresh()
    } catch (err) {
      console.error("上下架失败", err)
      toast.error(err?.message || "操作失败，请稍后重试")
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    const material = deleting
    if (!material) return
    setBusy(true)
    try {
      // **走服务端路由而不是直接调 RPC**：RPC 只删库里的行，OSS 上的对象得由服务端
      // 拿密钥去删。客户端只传 id，object_key 全程不出服务端（见 app/api/materials/delete/route.js）。
      const res = await fetch("/api/materials/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: material.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || "删除失败")
      toast.success(
        data.cleanupFailed ? "资料已删除（文件清理未完成，不影响使用）" : "资料已删除"
      )
      setDeleting(null)
      router.refresh()
    } catch (err) {
      console.error("删除资料失败", err)
      toast.error(err?.message || "删除失败，请稍后重试")
    } finally {
      setBusy(false)
    }
  }

  const hasFilters = Boolean(filters.kw || filters.node || filters.kind || filters.mine)

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex flex-col gap-1.5 sm:flex-1">
          <Label htmlFor="material-kw">关键词</Label>
          <Input
            id="material-kw"
            value={kw}
            placeholder="搜标题或简介"
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && apply({ kw })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>学科 / 专业大类</Label>
          <Button
            type="button"
            variant="outline"
            className="w-48 justify-between"
            onClick={() => setPicking(true)}
          >
            <span className={cn("truncate", !filters.node && "text-muted-foreground")}>
              {filters.node ? nodePathOf(nodes, filters.node) : "全部学科"}
            </span>
            <span className="shrink-0 text-muted-foreground">选择</span>
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="material-kind">类型</Label>
          <Select
            value={filters.kind || "all"}
            onValueChange={(v) => apply({ kind: v === "all" ? "" : v })}
          >
            <SelectTrigger id="material-kind" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              {MATERIAL_KINDS.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-2">
          <Button onClick={() => apply({ kw })}>筛选</Button>
          {hasFilters && (
            <Button
              variant="ghost"
              onClick={() => {
                setKw("")
                router.push(pathname)
              }}
            >
              清除
            </Button>
          )}
        </div>

        {caller.isTeacher && (
          <Button className="sm:ml-auto" onClick={() => setUploading(true)}>
            <UploadIcon className="size-4" /> 上传资料
          </Button>
        )}
      </div>

      {/* 只看我上传的：教师关心"我传了什么、被下载了多少次" */}
      {caller.isTeacher && (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={filters.mine}
            onChange={(e) => apply({ mine: e.target.checked })}
          />
          只看我上传的
        </label>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={UploadIcon}
          title={hasFilters ? "没有符合条件的资料" : "还没有复习资料"}
          description={
            hasFilters
              ? "换个关键词或清掉筛选再看看。"
              : caller.isTeacher
                ? "点右上角「上传资料」，PDF / Office / 图片 / 音视频都可以。"
                : "等老师上传后这里就会出现。"
          }
        />
      ) : (
        <>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>共 {total} 份资料</span>
            {busy && <Loader2Icon className="size-4 animate-spin" />}
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((m) => (
              <MaterialCard
                key={m.id}
                material={m}
                nodes={nodes}
                // 作者本人或管理员才能改；RLS 与 RPC 里也各判一次，这里只是别把按钮画给人看
                canManage={caller.isAdmin || m.creator_id === caller.userId}
                onDelete={setDeleting}
                onTogglePublish={togglePublish}
              />
            ))}
          </div>
        </>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            disabled={page <= 1}
            onClick={() => apply({}, page - 1)}
          >
            上一页
          </Button>
          <Badge variant="secondary">
            第 {page} / {totalPages} 页
          </Badge>
          <Button
            variant="outline"
            disabled={page >= totalPages}
            onClick={() => apply({}, page + 1)}
          >
            下一页
          </Button>
        </div>
      )}

      <MaterialUploadDialog
        open={uploading}
        onOpenChange={setUploading}
        nodes={nodes}
        onUploaded={() => router.refresh()}
      />

      <TreePicker
        open={picking}
        onOpenChange={setPicking}
        nodes={nodes}
        title="按学科 / 专业大类筛选"
        hint="选父级会带上它下面的全部资料。"
        onSelect={(picked) => {
          setPicking(false)
          apply({ node: picked.id })
        }}
      />

      {/* 约定：条件挂载，不是常挂载再传 open */}
      {deleting && (
        <AlertDialog open onOpenChange={(v) => !v && setDeleting(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除《{deleting.title}》？</AlertDialogTitle>
              <AlertDialogDescription>
                资料会从服务器上彻底删除，学生端立刻看不到，且**无法恢复**。
                如果只是想暂时收起，用「下架」。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
              <AlertDialogAction disabled={busy} onClick={confirmDelete}>
                确认删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}
