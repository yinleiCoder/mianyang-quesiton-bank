"use client"

// AI 配置页：全站唯一填写密钥/模型的地方。
// 密钥仍只存本机 localStorage；本页不读数据库、不经过服务器。
import { DeepSeekSettingsPanel } from "@/components/import/deepseek-settings-panel"
import { DEEPSEEK_MODELS } from "@/lib/deepseek"
import { Card, CardContent } from "@/components/ui/card"

export function AiSettingsPage() {
  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-4">
          <h2 className="text-sm font-semibold">所有 AI 功能共用这一个密钥</h2>
          <p className="text-xs text-muted-foreground">
            整卷导入、班级 AI 分析、AI 审题、讲评教案、主观题辅助评分都从这里读取密钥；
            各功能页不再单独保存一份。
          </p>
          <DeepSeekSettingsPanel purpose="settings" />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-4">
          <h2 className="text-sm font-semibold">模型能力</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="py-1 pr-2 text-left font-medium">模型</th>
                  <th className="py-1 pr-2 text-left font-medium">图片</th>
                  <th className="py-1 text-left font-medium">适合</th>
                </tr>
              </thead>
              <tbody>
                {DEEPSEEK_MODELS.map((model) => (
                  <tr key={model.value} className="border-b align-top last:border-0">
                    <td className="py-1.5 pr-2 font-medium">{model.value}</td>
                    <td className="py-1.5 pr-2">
                      {model.vision ? "支持" : "不支持"}
                    </td>
                    <td className="py-1.5 text-muted-foreground">{model.hint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-amber-700">
            整卷导入需要支持图片的模型；分析/审题/教案/评分只发文字。共用一个模型时，
            若选了纯文本模型，含扫描件/拍照页的导入会失败。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-1 pt-4 text-xs text-muted-foreground">
          <h2 className="mb-1 text-sm font-semibold text-foreground">隐私与边界</h2>
          <p>密钥只保存在你这台电脑的浏览器里，请求从浏览器直达 DeepSeek，不经过本站服务器。</p>
          <p>换电脑或换浏览器要重新填写；公用电脑用完请点「清除」。</p>
          <p>费用按用量记在填密钥的 DeepSeek 账号上，站点不提供公共密钥、也不代付。</p>
        </CardContent>
      </Card>
    </div>
  )
}
