"use client"

// 入场动画的统一入口（gsap）。全站要加动画的地方都从这里走，不各写各的 tween。
//
// 三条规矩（改这个文件之前先读）：
//   1. **不做 prefers-reduced-motion 降级**。这里原来有一条"系统关了动画就一个都不做"，
//      2026-10-08 按用户要求删掉了：他要的就是动画本身带来的生动感，认为"少动"才是损失。
//      这不是漏写，别再"好心"加回来——要恢复，先跟产品确认。
//   2. **只做"进场"**（淡入 + 轻微上移），不做循环/无限动画：这是教师的备课台，
//      不是展示页；一直在动的东西会抢走注意力。（循环动效用在明确要吸睛的地方，
//      比如审批流程图上"当前待办"那个节点，那是刻意的例外。）
//   3. **首帧不能闪**：用 useLayoutEffect（同构写法见下）在绘制前把初始态设好，
//      否则内容会先亮一下再被动画拉走 —— 那一下比不做动画还难看。
//   4. 时长 0.45s、power2.out：稳重，不弹跳。
//
// 用法：
//   <Reveal>…</Reveal>                 整块淡入
//   <Reveal stagger={0.06}>…</Reveal>  子元素依次入场（直接子节点才会被 stagger 到）
import { useEffect, useLayoutEffect, useRef } from "react"
import gsap from "gsap"

// 服务端渲染时 useLayoutEffect 会被 React 警告；这个同构写法是标准解法
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

export function Reveal({ children, className, delay = 0, y = 10, stagger = 0, duration = 0.45 }) {
  const ref = useRef(null)

  useIsoLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const targets = stagger ? Array.from(el.children) : el
    if (!targets || (Array.isArray(targets) && targets.length === 0)) return
    const tween = gsap.from(targets, {
      opacity: 0,
      y,
      duration,
      delay,
      stagger,
      ease: "power2.out",
      // 明确清掉内联样式，别让动画结束后残留 transform（会影响 sticky/定位子元素）
      clearProps: "opacity,transform",
    })
    return () => tween.kill()
  }, [delay, y, stagger, duration])

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}

/**
 * 数字滚动：成绩/统计块用。
 * **countUp 结束时必须落到精确值**（`snap`）：浮点累加会让"共 6 人"显示成 5.999，
 * 这类数字是给人对账用的，宁可不动画也不能差一点。
 */
export function CountUp({ value, decimals = 0, duration = 0.8, className }) {
  const ref = useRef(null)

  useIsoLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const end = Number(value)
    if (!Number.isFinite(end)) {
      el.textContent = String(value ?? "")
      return
    }
    const proxy = { n: 0 }
    const tween = gsap.to(proxy, {
      n: end,
      duration,
      ease: "power2.out",
      onUpdate: () => {
        el.textContent = proxy.n.toFixed(decimals)
      },
      onComplete: () => {
        el.textContent = end.toFixed(decimals)
      },
    })
    return () => tween.kill()
  }, [value, decimals, duration])

  return <span ref={ref} className={className}>{Number.isFinite(Number(value)) ? Number(value).toFixed(decimals) : ""}</span>
}
