export interface TokenMonitorConfig {
  windowSec?: number
  tickIntervalMs?: number
}

export interface MonitorSnapshot {
  current: number
  peak: number
  avg: number
  history: readonly number[]
  sampleCount: number
  windowFilled: boolean
}

export class TokenMonitor {
  private readonly buffer: Float64Array
  private readonly windowSize: number

  private writeIdx: number = 0
  private filled: boolean = false
  private totalSamples: number = 0

  private pendingTokens: number = 0

  private cachedPeak: number = 0
  private peakIdx: number = -1

  constructor(config?: TokenMonitorConfig) {
    this.windowSize = config?.windowSec ?? 30
    this.buffer = new Float64Array(this.windowSize)
  }

  push(tokenCount: number): void {
    this.pendingTokens += tokenCount
  }

  tick(): void {
    const sample = this.pendingTokens
    this.pendingTokens = 0

    const evictedIdx = this.writeIdx
    if (this.filled && evictedIdx === this.peakIdx) {
      this.peakIdx = -1
    }

    this.buffer[this.writeIdx] = sample
    this.writeIdx = (this.writeIdx + 1) % this.windowSize
    this.totalSamples++

    if (this.writeIdx === 0) {
      this.filled = true
    }

    if (sample >= this.cachedPeak) {
      this.cachedPeak = sample
      this.peakIdx = evictedIdx
    } else if (this.peakIdx === -1) {
      this.recomputePeak()
    }
  }

  private recomputePeak(): void {
    let max = 0
    let maxIdx = 0
    const count = this.filled ? this.windowSize : this.writeIdx
    for (let i = 0; i < count; i++) {
      if (this.buffer[i] > max) {
        max = this.buffer[i]
        maxIdx = i
      }
    }
    this.cachedPeak = max
    this.peakIdx = maxIdx
  }

  snapshot(): MonitorSnapshot {
    const count = this.filled ? this.windowSize : this.writeIdx

    const history: number[] = new Array(count)
    for (let i = 0; i < count; i++) {
      const idx = this.filled
        ? (this.writeIdx + i) % this.windowSize
        : i
      history[i] = this.buffer[idx]
    }

    let sum = 0
    for (let i = 0; i < count; i++) {
      sum += history[i]
    }
    const avg = count > 0 ? sum / count : 0

    return {
      current: count > 0 ? history[count - 1] : 0,
      peak: this.cachedPeak,
      avg: Math.round(avg * 10) / 10,
      history: Object.freeze(history),
      sampleCount: this.totalSamples,
      windowFilled: this.filled,
    }
  }

  reset(): void {
    this.buffer.fill(0)
    this.writeIdx = 0
    this.filled = false
    this.totalSamples = 0
    this.pendingTokens = 0
    this.cachedPeak = 0
    this.peakIdx = -1
  }

  isEmpty(): boolean {
    return this.totalSamples === 0
  }
}
