export type ScaleStrategy =
  | "peak_30s"
  | "peak_padded"
  | "rolling_avg"
  | "fixed"
  | "hybrid"

export interface ScalerConfig {
  strategy?: ScaleStrategy
  fixedMax?: number
  hysteresisThreshold?: number
  smoothingFactor?: number
  scaleDownDelay?: number
  minScale?: number
  headroomFactor?: number
}

export interface ScaleResult {
  yMax: number
  normalized: readonly number[]
  scaleChanged: boolean
  utilizationPct: number
}

export class GraphScaler {
  private readonly config: Required<ScalerConfig>

  private currentScale: number = 1
  private targetScale: number = 1
  private lastPeak: number = 0
  private ticksSinceNewPeak: number = 0

  constructor(config?: ScalerConfig) {
    this.config = {
      strategy: config?.strategy ?? "peak_30s",
      fixedMax: config?.fixedMax ?? 100,
      hysteresisThreshold: config?.hysteresisThreshold ?? 0.15,
      smoothingFactor: config?.smoothingFactor ?? 0.3,
      scaleDownDelay: config?.scaleDownDelay ?? 5,
      minScale: config?.minScale ?? 1,
      headroomFactor: config?.headroomFactor ?? 1.2,
    }
  }

  scale(
    values: readonly number[],
    peak: number,
    avg: number,
  ): ScaleResult {
    const rawTarget = this.computeTargetScale(values, peak, avg)

    const { newTarget, changed } = this.applyHysteresis(rawTarget, peak)
    this.targetScale = newTarget

    this.currentScale = this.smoothScale(this.currentScale, this.targetScale)

    const yMax = Math.max(this.currentScale, this.config.minScale)

    const normalized = values.map((v) => Math.min(1, Math.max(0, v / yMax)))

    return {
      yMax,
      normalized: Object.freeze(normalized),
      scaleChanged: changed,
      utilizationPct: peak > 0 ? Math.round((peak / yMax) * 100) : 0,
    }
  }

  private computeTargetScale(
    _values: readonly number[],
    peak: number,
    avg: number,
  ): number {
    switch (this.config.strategy) {
      case "peak_30s":
        return peak || this.config.minScale

      case "peak_padded":
        return (peak || this.config.minScale) * this.config.headroomFactor

      case "rolling_avg":
        return Math.max(avg * 2, this.config.minScale)

      case "fixed":
        return this.config.fixedMax

      case "hybrid": {
        const peakComponent = peak * 0.7
        const avgComponent = avg * 2 * 0.3
        return Math.max(peakComponent + avgComponent, this.config.minScale)
      }

      default:
        return peak || this.config.minScale
    }
  }

  private applyHysteresis(
    rawTarget: number,
    currentPeak: number,
  ): { newTarget: number; changed: boolean } {
    const threshold = this.config.hysteresisThreshold
    const currentScale = this.currentScale

    if (currentPeak > this.lastPeak * (1 + threshold)) {
      this.lastPeak = currentPeak
      this.ticksSinceNewPeak = 0
      return { newTarget: rawTarget, changed: true }
    }

    if (currentPeak < this.lastPeak * (1 - threshold)) {
      this.ticksSinceNewPeak++

      if (this.ticksSinceNewPeak >= this.config.scaleDownDelay) {
        this.lastPeak = currentPeak
        this.ticksSinceNewPeak = 0
        return { newTarget: rawTarget, changed: true }
      }

      return { newTarget: currentScale, changed: false }
    }

    this.ticksSinceNewPeak = 0
    return { newTarget: currentScale, changed: false }
  }

  private smoothScale(current: number, target: number): number {
    const alpha = this.config.smoothingFactor
    return alpha * target + (1 - alpha) * current
  }

  reset(): void {
    this.currentScale = this.config.minScale
    this.targetScale = this.config.minScale
    this.lastPeak = 0
    this.ticksSinceNewPeak = 0
  }

  getCurrentMax(): number {
    return Math.max(this.currentScale, this.config.minScale)
  }

  forceScale(yMax: number): void {
    this.currentScale = yMax
    this.targetScale = yMax
    this.lastPeak = yMax
    this.ticksSinceNewPeak = 0
  }
}
