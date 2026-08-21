import { extractFileReference, isFileReference } from '../src/shared/file-reference.ts'

const checks = [
  ['Windows 正斜杠绝对路径', 'Successfully wrote 18773 bytes to D:/Projects/rtl_lib/peri_ips/MoonGlass_DMA/rtl/sdma330_sequencer.v', 'D:/Projects/rtl_lib/peri_ips/MoonGlass_DMA/rtl/sdma330_sequencer.v'],
  ['Windows 反斜杠绝对路径与行列', String.raw`已写入 D:\Projects\芯片 项目\rtl\top.sv:42:7`, String.raw`D:\Projects\芯片 项目\rtl\top.sv:42:7`],
  ['项目相对路径', '更新 rtl/core/dma_top.v:19', 'rtl/core/dma_top.v:19']
]

for (const [name, input, expected] of checks) {
  const actual = extractFileReference(input)
  if (actual !== expected || !isFileReference(actual ?? '')) throw new Error(`${name}失败：${actual}`)
  console.log(`✓ ${name}`)
}

console.log('\n✅ 文件引用识别冒烟全部通过')
