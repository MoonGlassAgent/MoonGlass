/**
 * 服务生命周期管理器
 *
 * 所有主进程服务实现 MoonGlassService 接口并注册到 LifecycleManager，
 * 由应用入口统一 start / stop，保证启动顺序与退出清理。
 */

export interface MoonGlassService {
  readonly name: string
  /** 服务启动（可声明依赖顺序，由注册顺序保证） */
  start(): Promise<void> | void
  /** 服务停止，释放资源 */
  stop(): Promise<void> | void
}

export class LifecycleManager {
  private services: MoonGlassService[] = []
  private started = false

  register(service: MoonGlassService): this {
    if (this.started) {
      throw new Error(`[lifecycle] 无法在启动后注册服务: ${service.name}`)
    }
    this.services.push(service)
    return this
  }

  get<T extends MoonGlassService>(name: string): T | undefined {
    return this.services.find((s) => s.name === name) as T | undefined
  }

  async startAll(): Promise<void> {
    for (const service of this.services) {
      await service.start()
      console.log(`[lifecycle] started: ${service.name}`)
    }
    this.started = true
  }

  async stopAll(): Promise<void> {
    for (const service of [...this.services].reverse()) {
      try {
        await service.stop()
        console.log(`[lifecycle] stopped: ${service.name}`)
      } catch (err) {
        console.error(`[lifecycle] stop failed: ${service.name}`, err)
      }
    }
    this.started = false
  }
}
