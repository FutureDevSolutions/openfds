import { Token } from "@/util/token"
import { TokenMonitor } from "./token-monitor"

export interface DeltaEvent {
  sessionID: string
  messageID: string
  partID: string
  delta: string
}

export interface PartInfo {
  type: string
}

export interface MessageInfo {
  role: string
}

export interface DataStore {
  part: { get(key: string): PartInfo | undefined }
  message: { get(id: string): MessageInfo | undefined }
}

export interface StreamHandlerConfig {
  sessionID: string
  monitor: TokenMonitor
  dataStore: DataStore
  onError?: (error: Error, event: DeltaEvent) => void
}

export class TokenStreamHandler {
  private readonly config: StreamHandlerConfig
  private pendingTokens: number = 0
  private tickInterval: ReturnType<typeof setInterval> | null = null
  private isActive: boolean = false

  private stats = {
    eventsReceived: 0,
    eventsFiltered: 0,
    tokensAccumulated: 0,
    ticksProcessed: 0,
  }

  constructor(config: StreamHandlerConfig) {
    this.config = config
  }

  start(): void {
    if (this.isActive) return

    this.isActive = true
    this.tickInterval = setInterval(() => this.tick(), 1000)
  }

  stop(): void {
    if (!this.isActive) return

    this.isActive = false
    if (this.tickInterval) {
      clearInterval(this.tickInterval)
      this.tickInterval = null
    }

    if (this.pendingTokens > 0) {
      this.config.monitor.push(this.pendingTokens)
      this.config.monitor.tick()
      this.pendingTokens = 0
    }
  }

  handleDelta(event: DeltaEvent): boolean {
    this.stats.eventsReceived++

    if (event.sessionID !== this.config.sessionID) {
      this.stats.eventsFiltered++
      return false
    }

    const partKey = `${event.messageID}:${event.partID}`
    const part = this.config.dataStore.part.get(partKey)
    if (!part || (part.type !== "text" && part.type !== "reasoning")) {
      this.stats.eventsFiltered++
      return false
    }

    const message = this.config.dataStore.message.get(event.messageID)
    if (!message || message.role !== "assistant") {
      this.stats.eventsFiltered++
      return false
    }

    if (typeof event.delta !== "string") {
      this.config.onError?.(
        new Error(`Invalid delta type: ${typeof event.delta}`),
        event,
      )
      return false
    }

    try {
      const tokens = Token.estimate(event.delta)
      this.pendingTokens += tokens
      this.stats.tokensAccumulated += tokens
      return true
    } catch (err) {
      this.config.onError?.(err as Error, event)
      return false
    }
  }

  private tick(): void {
    this.stats.ticksProcessed++

    this.config.monitor.push(this.pendingTokens)
    this.config.monitor.tick()
    this.pendingTokens = 0
  }

  reset(): void {
    this.pendingTokens = 0
    this.config.monitor.reset()
    this.stats = {
      eventsReceived: 0,
      eventsFiltered: 0,
      tokensAccumulated: 0,
      ticksProcessed: 0,
    }
  }

  getStats(): typeof this.stats {
    return { ...this.stats }
  }

  isRunning(): boolean {
    return this.isActive
  }
}

export function createStreamHandler(
  config: Omit<StreamHandlerConfig, "dataStore">,
  dataStore: DataStore,
  eventBus: {
    on(event: string, handler: (evt: DeltaEvent) => void): void
    off(event: string, handler: (evt: DeltaEvent) => void): void
  },
): { handler: TokenStreamHandler; cleanup: () => void } {
  const handler = new TokenStreamHandler({ ...config, dataStore })

  const deltaHandler = (evt: DeltaEvent) => handler.handleDelta(evt)

  eventBus.on("message.part.delta", deltaHandler)
  handler.start()

  const cleanup = () => {
    eventBus.off("message.part.delta", deltaHandler)
    handler.stop()
  }

  return { handler, cleanup }
}
