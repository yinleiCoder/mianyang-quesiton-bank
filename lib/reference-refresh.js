"use client"

// 参考数据（科目树 / 学校 / 标签 / 班级）写成功后的"喊服务端一声"——
// 具体机制与为什么必须喊，见 lib/reference-data.js 头注；服务端那一半在 lib/actions/reference.js。
//
// 不 await、失败静默，是因为：
//   · 每个写入方本来就会用浏览器端直查刷新**自己这一页**，等这一声回来只会拖慢对话框关闭；
//   · 它保的是**别的页面**（出题、题库、班级）的即时性，真喊丢了也只是退回 5 分钟 TTL，
//     不该让一次已经写成功的操作弹成错误。
import { refreshReference } from "@/lib/actions/reference"

export function refreshReferenceQuietly(resource) {
  refreshReference(resource).catch(() => {})
}
