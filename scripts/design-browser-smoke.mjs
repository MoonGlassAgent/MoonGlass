import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { elaborateDesign } = await import('../packages/design-browser-engine/src/index.ts')

const root = mkdtempSync(join(tmpdir(), 'moonglass-design-browser-'))
const child = join(root, 'child.v')
const top = join(root, 'top.v')
const output = join(root, 'top.json')
writeFileSync(child, `module child(input wire i_a, output wire o_y); assign o_y = ~i_a; endmodule\n`)
writeFileSync(top, `module top(input wire i_data, output wire o_data);
  wire w_mid;
  child u_child(.i_a(i_data), .o_y(w_mid));
  assign o_data = w_mid;
endmodule\n`)

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const database = await elaborateDesign({
  rtlFiles: [child, top],
  topModule: 'top',
  outputJson: output
})
const topModule = database.modules.find((module) => module.name === 'top')
const inputTrace = topModule?.traces.find((trace) => trace.net === 'i_data')

check('Yosys design JSON 已生成', existsSync(output))
check('解析两个 RTL 模块', database.modules.length === 2, String(database.modules.length))
check('层次树包含 u_child', database.hierarchy.children.some((node) => node.name === 'u_child'))
check('顶层端口已解析', topModule?.ports.length === 2)
check('顶层网络已解析', (topModule?.nets.length ?? 0) >= 3)
check('input driver 可追踪', inputTrace?.drivers.some((item) => item.kind === 'port') === true)

console.log('')
console.log(failures === 0 ? '✅ RTL Design Browser 冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
