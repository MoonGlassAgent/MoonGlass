/**
 * Node ESM 解析钩子：把 '@shared/types' 别名映射到源码实体，
 * 供冒烟脚本在纯 Node（无 electron-vite 别名环境）下 import 主进程模块。
 * 用法：import { register } from 'node:module'; register('./ts-alias-hooks.mjs', import.meta.url)
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const ALIASES = {
  '@shared/types': join(process.cwd(), 'src', 'shared', 'types', 'index.ts'),
  '@shared/agent-interaction': join(process.cwd(), 'src', 'shared', 'agent-interaction.ts'),
  '@shared/verification-guidance': join(process.cwd(), 'src', 'shared', 'verification-guidance.ts'),
  '@moonglass/eda-bridge': join(process.cwd(), 'packages', 'eda-bridge', 'src', 'index.ts'),
  '@moonglass/prompts': join(process.cwd(), 'packages', 'prompts', 'src', 'index.ts'),
  '@moonglass/rtl-engine': join(process.cwd(), 'packages', 'rtl-engine', 'src', 'index.ts')
}

export async function resolve(specifier, context, next) {
  if (ALIASES[specifier]) {
    return next(pathToFileURL(ALIASES[specifier]).href, context)
  }
  try {
    return await next(specifier, context)
  } catch (err) {
    // TS 源码里的无扩展名相对导入（electron-vite 容忍，Node 不容忍）补 .ts 重试
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z0-9]+$/i.test(specifier)) {
      return next(`${specifier}.ts`, context)
    }
    throw err
  }
}
