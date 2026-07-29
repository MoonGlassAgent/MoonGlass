/**
 * EDA 工具服务
 *
 * 对 @moonglass/eda-bridge 的服务化封装。
 * 骨架阶段仅暴露工具探测能力，Lint/仿真/综合待 Phase 4 接入。
 */

import { detectToolchain } from '@moonglass/eda-bridge'
import type { ToolDetection } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'

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
}
