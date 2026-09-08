/**
 * Yosys 对参数化模块派生 $paramod 名称：
 *   $paramod$02d05ad3...\frac_divider_core
 *   $paramod\frac_divider_gate\DIV_INT_W=s32'000...10100
 * 显示时还原为基础模块名（完整名称放 tooltip）。
 */
export function displayModuleName(name: string): string {
  if (!name.startsWith('$paramod')) return name
  const firstSep = name.indexOf('\\')
  if (firstSep < 0) return name
  const rest = name.slice(firstSep + 1)
  const secondSep = rest.indexOf('\\')
  return secondSep < 0 ? rest : rest.slice(0, secondSep)
}
