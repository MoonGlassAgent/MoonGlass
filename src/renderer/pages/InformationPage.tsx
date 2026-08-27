import { useState } from 'react'
import { Check, Copy, ExternalLink, Mail, ShieldCheck } from 'lucide-react'
import { APP_INFO } from '@shared/app-info'
import logoUrl from '../assets/logo.png'
import wechatContactUrl from '../assets/wechat-commercial-contact.jpg'

const FLOW = [
  ['1', '需求-规格定义', '通过 Agent 梳理需求、规格和需求-规格追踪矩阵。'],
  ['2', '架构设计', '形成模块划分、接口、时钟复位、寄存器和微架构设计。'],
  ['3', 'RTL 开发', '生成并评审 RTL，运行 Lint、CDC 与可综合性检查。'],
  ['4', '验证完备', '以 Verification Intent 组织风险场景、时间与边界交互，执行 Simulation/Formal/Static，分类 Coverage Hole 并完成独立证据审查。'],
  ['5', '质量检查', '执行清单、交叉 Review、变更审查与发布门禁。'],
  ['6', '综合实现', '调用综合与 STA 工具，评估面积、时序和实现风险。']
] as const

export function InformationPage(): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const copyEmail = async (): Promise<void> => {
    await navigator.clipboard.writeText(APP_INFO.contactEmail)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="h-full overflow-y-auto bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white px-8 py-6">
        <div className="flex items-center gap-4">
          <img src={logoUrl} alt="MoonGlass" className="size-16 rounded-lg" />
          <div>
            <h1 className="text-2xl font-bold text-zinc-900">{APP_INFO.name}</h1>
            <p className="mt-1 text-sm text-zinc-500">版本 {APP_INFO.version} · 芯片开发全流程 AI 工作台</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-8 py-7">
        <section>
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck size={19} className="text-emerald-600" />
            <h2 className="text-lg font-semibold text-zinc-900">授权信息</h2>
          </div>
          <div className="grid gap-4 border-y border-zinc-200 bg-white px-5 py-5 md:grid-cols-2">
            <div>
              <div className="text-sm font-semibold text-zinc-800">Source Available</div>
              <p className="mt-2 text-sm leading-6 text-zinc-600">
                MoonGlass 源代码公开，但不是 OSI 定义的 Open Source 软件。个人学习、实验、非商业教育和许可证涵盖的非商业组织用途可免费使用。
              </p>
              <a
                href={APP_INFO.licenseUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800"
              >
                查看 {APP_INFO.licenseName}<ExternalLink size={14} />
              </a>
            </div>
            <div className="border-t border-zinc-200 pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
              <div className="text-sm font-semibold text-zinc-800">商用须书面授权</div>
              <p className="mt-2 text-sm leading-6 text-zinc-600">
                企业内部商业研发、客户交付、收费服务、流片、量产及其他预期商业应用，使用前须取得单独的书面商用许可。公开价格仅供参考，正式合同确定授权边界。
              </p>
              <p className="mt-3 text-xs leading-5 text-zinc-500">
                用户合法输入的规格、RTL、验证资产与设计输出归用户或其权利人所有；嵌入的 MoonGlass 代码、模板及第三方组件仍受各自许可证约束。
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-lg font-semibold text-zinc-900">快速使用手册</h2>
          <div className="grid gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 md:grid-cols-2 lg:grid-cols-3">
            {FLOW.map(([number, title, description]) => (
              <div key={number} className="min-h-32 bg-white p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">{number}</span>
                  <h3 className="text-sm font-semibold text-zinc-800">{title}</h3>
                </div>
                <p className="text-sm leading-6 text-zinc-600">{description}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 border-l-2 border-emerald-500 bg-emerald-50 px-4 py-3 text-sm leading-6 text-zinc-700">
            首次使用先在“设置”中配置模型服务并检测 EDA 工具链，再新建项目并指定项目目录。主会话负责推进，平行会话可独立选择模型进行 Review；项目文件、波形和 RTL Design Browser 均从工作区进入。
          </div>
        </section>

        <section className="grid gap-7 border-t border-zinc-200 pt-7 md:grid-cols-[1fr_220px]">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">作者与支持</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              授权咨询、定制开发、安全问题和产品建议可通过邮件联系。请勿发送 API Key、客户机密或受限制芯片设计数据。
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 text-sm font-medium text-zinc-800"><Mail size={16} />{APP_INFO.contactEmail}</span>
              <button
                type="button"
                onClick={() => void copyEmail()}
                className="inline-flex size-8 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-100"
                title="复制邮箱"
                aria-label="复制邮箱"
              >
                {copied ? <Check size={15} className="text-emerald-600" /> : <Copy size={15} />}
              </button>
            </div>
            <div className="mt-5 text-xs leading-5 text-zinc-500">
              隐私提示：项目与会话默认保存在本机；调用外部 LLM 时，所选上下文可能发送至对应服务商。第三方模型、EDA 工具、IP 和 PDK 适用其各自条款。
            </div>
          </div>
          <figure className="text-center">
            <img src={wechatContactUrl} alt="微信商务授权咨询二维码" className="mx-auto w-44 border border-zinc-200 bg-white p-2" />
            <figcaption className="mt-2 text-xs text-zinc-500">微信商务授权咨询</figcaption>
          </figure>
        </section>
      </main>
    </div>
  )
}
