/**
 * EDA 工具服务
 *
 * 对 @moonglass/eda-bridge 的服务化封装。
 * 骨架阶段仅暴露工具探测能力，Lint/仿真/综合待 Phase 4 接入。
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import { detectToolchain, locateTool } from '@moonglass/eda-bridge'
import type { ToolDetection, WaveformOpenResult } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'
import { projectWorkspaceDir } from '../core/paths'

export class EdaService implements MoonGlassService {
  readonly name = 'eda-service'

  start(): void {
    // 无常驻资源
  }

  stop(): void {
    // 无常驻资源
  }

  detectTools(): Promise<ToolDetection[]> {
    return detectToolchain()
  }

  async openWaveform(projectId: string, relPath: string): Promise<WaveformOpenResult> {
    const root = resolve(projectWorkspaceDir(projectId))
    const filePath = resolve(root, relPath)
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      return { ok: false, error: '波形路径超出项目工作区' }
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return { ok: false, error: `波形文件不存在: ${relPath}` }
    }
    if (!['.vcd', '.fst'].includes(extname(filePath).toLowerCase())) {
      return { ok: false, error: '仅支持打开 VCD/FST 波形文件' }
    }

    const viewer = await locateTool(
      process.platform === 'win32' ? ['gtkwave.exe', 'gtkwave'] : ['gtkwave']
    )
    if (!viewer) {
      return { ok: false, error: '未找到 GTKWave，请先安装并加入 PATH' }
    }

    try {
      const child = spawn(viewer, [filePath], {
        cwd: dirname(filePath),
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      })
      child.unref()
      return { ok: true, viewer }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
