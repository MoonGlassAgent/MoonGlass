/**
 * IP 模板库页（骨架）
 *
 * 骨架阶段展示内置 IP 分类结构（静态常量），
 * 后续改为读取 resources/moonglass/ip-library 目录树 + 向量检索。
 */

const IP_CATEGORIES = [
  { id: 'interface', name: '总线接口', items: ['AXI4 Master', 'AXI4 Slave', 'AXI4-Lite Bridge', 'APB Slave'] },
  { id: 'memory', name: '存储相关', items: ['异步 FIFO', '同步 FIFO', 'DDR BIST 控制器', 'PSRAM 控制器'] },
  { id: 'clock', name: '时钟相关', items: ['时钟门控单元', '无毛刺时钟切换', '小数分频器'] },
  { id: 'arbiter', name: '仲裁器', items: ['轮询仲裁器', '优先级仲裁器'] },
  { id: 'utility', name: '工具模块', items: ['按键消抖', '边沿检测', '脉冲展宽'] }
] as const

export function IpLibraryPage(): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-1 text-xl font-bold text-zinc-900">IP 模板库</h1>
      <p className="mb-6 text-sm text-zinc-500">
        内置常用 IP 模板（骨架阶段为目录占位，模板内容待 Phase 5 导入）
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {IP_CATEGORIES.map((cat) => (
          <div key={cat.id} className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-3 font-semibold text-zinc-800">{cat.name}</h2>
            <ul className="space-y-1.5">
              {cat.items.map((item) => (
                <li
                  key={item}
                  className="flex items-center justify-between rounded bg-zinc-100 px-3 py-1.5 text-sm text-zinc-600"
                >
                  <span>{item}</span>
                  <span className="text-xs text-zinc-400">待导入</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
