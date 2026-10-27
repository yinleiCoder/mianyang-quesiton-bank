import { redirect } from "next/navigation"

// /showcase 没有独立内容：直接落到架构图，避免用户点到 404。
export default function ShowcaseIndexPage() {
  redirect("/showcase/architecture")
}
