// 极简 Chrome DevTools Protocol 驱动（本机 E2E 用，零依赖：Node 24 自带 fetch 与 WebSocket）。
//
// 为什么不装 Playwright：本项目只需要"打开页面、点一下、填个字、截个图"这四个动作，
// 为此下一个 ~150MB 的浏览器包不划算；而且 Playwright 自带浏览器与开发机上真实的
// Chrome 不是同一个，字体/打印排版这类问题反而更容易漏。
//
// 用法（每次调用独立连接，Chrome 保持常开；状态留在 Chrome 里）：
//   node scripts/e2e-cdp.mjs open   http://localhost:3000/login
//   node scripts/e2e-cdp.mjs eval   "document.title"
//   node scripts/e2e-cdp.mjs click  "button[type=submit]"
//   node scripts/e2e-cdp.mjs fill   "input[name=email]" "a@b.com"
//   node scripts/e2e-cdp.mjs waitfor "text=组卷库"
//   node scripts/e2e-cdp.mjs shot   /tmp/step1.png
//
// 前置：Chrome 需以 --remote-debugging-port=9222 启动（见 scripts/e2e-chrome.ps1）。

const PORT = process.env.CDP_PORT ?? "9222"
const BASE = `http://127.0.0.1:${PORT}`

async function targetWs() {
  const list = await (await fetch(`${BASE}/json/list`)).json()
  const page = list.find((t) => t.type === "page")
  if (!page) throw new Error("没有找到可用的标签页（Chrome 是否带 --remote-debugging-port 启动？）")
  return page.webSocketDebuggerUrl
}

let __id = 0
function connect(ws, onEvent) {
  const pending = new Map()
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    } else if (msg.method && onEvent) {
      onEvent(msg)
    }
  })
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++__id
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
}

async function withPage(fn) {
  const ws = new WebSocket(await targetWs())
  await new Promise((res, rej) => {
    ws.addEventListener("open", res)
    ws.addEventListener("error", rej)
  })
  const send = connect(ws)
  await send("Page.enable")
  await send("Runtime.enable")
  try {
    return await fn(send)
  } finally {
    ws.close()
  }
}

// 求值并把结果转成可读文本。awaitPromise 让页面里的 Promise 能直接返回。
async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? "页面求值异常")
  }
  return r.result?.value
}

// React 受控输入不能直接赋 .value —— 那样只改了 DOM，React 的 onChange 不会触发，
// state 还是旧的。必须走原型上的原生 setter 再手动派发 input 事件。
const SET_VALUE = `
function setValue(el, value) {
  // 必须按元素类型取对应的原型 setter：拿 input 的 setter 去 call 一个 <select>
  // 会抛 "Illegal invocation"（内部槽不匹配）
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
              : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}`

const BY_TEXT = `
function byText(sel, text) {
  const els = [...document.querySelectorAll(sel)];
  return els.find(e => (e.textContent || '').includes(text)) || null;
}`

const commands = {
  async open(send, url) {
    await send("Page.navigate", { url })
    // 轮询 readyState 而不是等 Page.loadEventFired：每次调用都是新连接，
    // 挂事件回调的时机很可能晚于页面已经加载完的瞬间，会永远等不到。
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if ((await evaluate(send, "document.readyState")) === "complete") {
        return `已打开 ${url}`
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`打开超时：${url}`)
  },

  async eval(send, expr) {
    const v = await evaluate(send, expr)
    return typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)
  },

  // 选择器支持 "text=xxx"（在可点击元素里按文字找）。用 el.click() 而不是派发
  // Input.dispatchMouseEvent：React 的事件委托挂在根节点上，原生 click() 冒泡上去
  // 一样能触发 onClick，省掉算坐标的麻烦。
  async click(send, sel) {
    const r = await evaluate(
      send,
      `(() => { ${BY_TEXT}
        const s = ${JSON.stringify(sel)};
        const el = s.startsWith('text=')
          ? byText('button, a, [role=tab], [role=option], summary, label', s.slice(5))
          : document.querySelector(s);
        if (!el) return 'NOT_FOUND';
        el.scrollIntoView({ block: 'center' });
        el.click();
        return 'OK:' + (el.textContent || el.tagName).trim().slice(0, 40);
      })()`
    )
    if (r === "NOT_FOUND") throw new Error(`找不到元素：${sel}`)
    return r
  },

  async fill(send, sel, value) {
    const r = await evaluate(
      send,
      `(() => { ${SET_VALUE}
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return 'NOT_FOUND';
        el.focus();
        setValue(el, ${JSON.stringify(value)});
        return 'OK';
      })()`
    )
    if (r === "NOT_FOUND") throw new Error(`找不到输入框：${sel}`)
    return `已填写 ${sel}`
  },

  // 原生 select：改 value 后派发 change（React 的 onChange 监听的是 change）
  async select(send, sel, value) {
    const r = await evaluate(
      send,
      `(() => { ${SET_VALUE}
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return 'NOT_FOUND';
        const opt = [...el.options].find(o => o.value === ${JSON.stringify(value)} || (o.textContent||'').includes(${JSON.stringify(value)}));
        if (!opt) return 'NO_OPTION:' + [...el.options].map(o => o.value).slice(0, 8).join('|');
        setValue(el, opt.value);
        return 'OK:' + opt.textContent.trim();
      })()`
    )
    if (r === "NOT_FOUND") throw new Error(`找不到 select：${sel}`)
    if (String(r).startsWith("NO_OPTION")) throw new Error(`没有匹配的选项。可选：${r.slice(10)}`)
    return `已选择 ${r}`
  },

  async waitfor(send, sel, timeoutMs = 20000) {
    const deadline = Date.now() + Number(timeoutMs)
    const expr = sel.startsWith("text=")
      ? `!!([...document.querySelectorAll('button, a, h1, h2, h3, p, span, div')].find(e => (e.textContent||'').includes(${JSON.stringify(sel.slice(5))})))`
      : `!!document.querySelector(${JSON.stringify(sel)})`
    while (Date.now() < deadline) {
      if (await evaluate(send, expr)) return `出现：${sel}`
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`等待超时：${sel}`)
  },

  async wait(_, ms) {
    await new Promise((r) => setTimeout(r, Number(ms)))
    return `等待 ${ms}ms`
  },

  async shot(send, file) {
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })
    const fs = await import("node:fs")
    fs.writeFileSync(file, Buffer.from(data, "base64"))
    return `截图已保存 ${file}`
  },

  // 通用逃生口：任何没封装的 CDP 方法都能直接用（如 Network.clearBrowserCookies 换账号）
  async cdp(send, method, paramsJson = "{}") {
    const r = await send(method, JSON.parse(paramsJson))
    return JSON.stringify(r).slice(0, 400)
  },

  // 给 <input type="file"> 塞文件。**不能用 el.files = ...**：那需要构造 File 对象，
  // 而 CDP 的 DOM.setFileInputFiles 是真·浏览器行为，React 的 onChange 会照常触发。
  async file(send, sel, ...paths) {
    await send("DOM.enable")
    const { root } = await send("DOM.getDocument", { depth: -1 })
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: sel })
    if (!nodeId) throw new Error(`找不到文件输入框：${sel}`)
    await send("DOM.setFileInputFiles", { nodeId, files: paths })
    return `已选择文件 ${paths.join(", ")}`
  },

  // 设置 localStorage（密钥之类的本机配置），随后需要 reload 才被读到
  async store(send, key, value) {
    await evaluate(send, `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); 'ok'`)
    return `已写入 localStorage.${key}`
  },

  // 退出登录：Supabase 的会话在 HttpOnly cookie 里，eval 读不到也删不掉，
  // 只能从浏览器层面清 cookie（清完再回 /login 就是未登录态）
  async logout(send) {
    await send("Network.enable")
    await send("Network.clearBrowserCookies")
    await send("Page.navigate", { url: "http://localhost:3000/login" })
    await new Promise((r) => setTimeout(r, 1500))
    return "已清除会话 cookie"
  },

  // 页面文字快照：比截图更适合"断言页面到底显示了什么"
  async text(send, sel = "body") {
    const v = await evaluate(
      send,
      `(() => { const el = document.querySelector(${JSON.stringify(sel)});
        return el ? el.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 4000) : 'NOT_FOUND'; })()`
    )
    return v
  },
}

const [cmd, ...args] = process.argv.slice(2)
if (!commands[cmd]) {
  console.error(`未知命令：${cmd}\n可用：${Object.keys(commands).join(", ")}`)
  process.exit(2)
}

try {
  const out = await withPage((send) => commands[cmd](send, ...args))
  if (out !== undefined) console.log(out)
} catch (err) {
  console.error("FAIL:", err.message)
  process.exit(1)
}
