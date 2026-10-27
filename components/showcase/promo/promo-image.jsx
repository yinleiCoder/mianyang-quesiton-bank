// 宣传动画里的图片：用 delayRender 等图片真正加载完，但不走 Remotion <Img>
// 内部的 image.decode() —— 后者在部分浏览器会对已加载的截图抛 EncodingError 警告。
import { useEffect, useRef, useState } from "react"
import { continueRender, delayRender, staticFile } from "remotion"

export function PromoImg({ src, style }) {
  const [handle] = useState(() => delayRender(`promo image ${src}`))
  const imgRef = useRef(null)
  const doneRef = useRef(false)

  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const done = () => {
      if (doneRef.current) return
      doneRef.current = true
      continueRender(handle)
    }
    if (img.complete && img.naturalWidth > 0) {
      done()
      return
    }
    img.addEventListener("load", done)
    img.addEventListener("error", done)
    return () => {
      img.removeEventListener("load", done)
      img.removeEventListener("error", done)
      done()
    }
  }, [handle])

  return <img ref={imgRef} src={staticFile(src)} alt="" style={style} />
}
