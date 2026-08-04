/**
 * IP 模板库服务冒烟脚本
 *
 * 验证：
 *   1. 内置 IP 库能索引到 axi_lite_timer；
 *   2. 用户本地目录可按自定义名称与类型导入；
 *   3. 统一 index.json 会落盘，供 Agent/流程看板读取。
 *
 * 运行：pnpm smoke:ip-library
 */
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { IpLibraryService } = await import('../src/main/services/IpLibraryService.ts')

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const dataDir = await mkdtemp(join(tmpdir(), 'moonglass-ip-lib-data-'))
const externalRoot = await mkdtemp(join(tmpdir(), 'moonglass-user-ip-lib-'))
const builtinRoot = join(process.cwd(), 'resources', 'moonglass', 'ip-library')

mkdirSync(join(externalRoot, 'pulse_sync', 'rtl'), { recursive: true })
mkdirSync(join(externalRoot, 'pulse_sync', 'docs'), { recursive: true })
writeFileSync(join(externalRoot, 'pulse_sync', 'metadata.json'), JSON.stringify({
  name: '脉冲同步器',
  topModule: 'pulse_sync',
  summary: '用户自定义 IP 库中的双触发器脉冲同步样例。'
}, null, 2))
writeFileSync(join(externalRoot, 'pulse_sync', 'docs', 'README.md'), '# 脉冲同步器\n')
writeFileSync(join(externalRoot, 'pulse_sync', 'rtl', 'pulse_sync.sv'), `module pulse_sync (
  input  wire src_clk,
  input  wire dst_clk,
  input  wire pulse_i,
  output wire pulse_o
);
  reg src_toggle;
  reg dst_meta;
  reg dst_sync;
  reg dst_sync_d;
  always @(posedge src_clk) begin
    if (pulse_i) src_toggle <= ~src_toggle;
  end
  always @(posedge dst_clk) begin
    dst_meta <= src_toggle;
    dst_sync <= dst_meta;
    dst_sync_d <= dst_sync;
  end
  assign pulse_o = dst_sync ^ dst_sync_d;
endmodule
`)

const service = new IpLibraryService(dataDir, builtinRoot)
await service.start()

const initial = await service.list()
const builtinUtility = initial.find((library) => library.id === 'builtin-utility')
check('内置工具模块库就绪', builtinUtility?.status === 'ready', builtinUtility?.status)
check('内置库索引到 AXI-Lite Timer', builtinUtility?.ips.some((ip) => ip.name === 'AXI-Lite Timer') === true)

const imported = await service.addLocal({
  path: externalRoot,
  name: '公司 CDC IP',
  type: '跨时钟域'
})
check('用户 IP 库导入成功', imported.status === 'ready', imported.status)
check('用户自定义名称生效', imported.name === '公司 CDC IP')
check('用户自定义类型生效', imported.type === '跨时钟域')
check('用户库索引到脉冲同步器', imported.ips.some((ip) => ip.topModule === 'pulse_sync') === true)

const index = JSON.parse(readFileSync(service.getIndexPath(), 'utf-8'))
check('统一索引已落盘', Array.isArray(index.libraries) && index.libraries.length >= 1)
check('统一索引包含用户类型', JSON.stringify(index).includes('跨时钟域'))

await service.stop()

console.log('')
console.log(failures === 0 ? '✅ IP 模板库服务冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
