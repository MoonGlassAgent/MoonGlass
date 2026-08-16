import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const output = mkdtempSync(join(tmpdir(), 'moonglass-sram-'))
const script = join(process.cwd(), 'resources', 'moonglass', 'ip-library', 'memory', 'sram_macro_generator', 'scripts', 'generate_sram_views.py')
const result = spawnSync('python', [
  script, '--macro-name', 'RFSP288X80M4LL', '--wrapper-name', 'SRAMS288X80_CPU',
  '--depth', '288', '--width', '80', '--output-dir', output
], { encoding: 'utf-8' })
if (result.status !== 0) throw new Error(result.stderr || result.stdout)

let failures = 0
const check = (name, condition) => {
  console.log(`${condition ? '✓' : '✗'} ${name}`)
  if (!condition) failures += 1
}
const paths = {
  behavioral: join(output, 'RFSP288X80M4LL_behavioral.v'),
  blackbox: join(output, 'RFSP288X80M4LL_blackbox.v'),
  wrapper: join(output, 'SRAMS288X80_CPU.v'),
  manifest: join(output, 'RFSP288X80M4LL.json')
}
const behavior = readFileSync(paths.behavioral, 'utf-8')
const blackbox = readFileSync(paths.blackbox, 'utf-8')
const wrapper = readFileSync(paths.wrapper, 'utf-8')
const manifest = JSON.parse(readFileSync(paths.manifest, 'utf-8'))

check('生成四类交付物', Object.values(paths).every(existsSync))
check('行为模型使用真实宏名', behavior.includes('module RFSP288X80M4LL'))
check('行为模型限制 288 个有效地址', behavior.includes('if (A < 288)'))
check('行为模型使用低有效 CEN/WEN', behavior.includes('if (!CEN)') && behavior.includes('if (!WEN)'))
check('blackbox 不含存储阵列', blackbox.includes('(* blackbox *)') && !blackbox.includes(' mem ['))
check('wrapper 正确转换 ce/we 极性', wrapper.includes('wire we_n = ~we;') && wrapper.includes('wire ce_n = ~ce;'))
check('wrapper 实例化真实 SRAM', wrapper.includes('RFSP288X80M4LL U_RFSP288X80M4LL'))
check('manifest 地址宽度为 9', manifest.addressWidth === 9)
check('manifest 明确缺少签核视图', manifest.missingSignoffViews.join(',') === 'liberty,lef,gds')

console.log(failures === 0 ? '\n✅ SRAM 生成器冒烟全部通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
