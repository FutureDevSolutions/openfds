export type WaveformType =
  | "sine"
  | "sawtooth"
  | "square"
  | "burst"
  | "ramp_up"
  | "ramp_down"
  | "random"
  | "constant"

export interface MockStreamConfig {
  waveform: WaveformType
  minValue: number
  maxValue: number
  periodSec?: number
  burstProbability?: number
}

export class MockStream {
  private readonly config: Required<MockStreamConfig>
  private startTime: number = 0
  private running: boolean = false
  private emitCallback: ((tokens: number) => void) | null = null
  private interval: ReturnType<typeof setInterval> | null = null

  constructor(config: MockStreamConfig) {
    this.config = {
      periodSec: config.periodSec ?? 10,
      burstProbability: config.burstProbability ?? 0.1,
      waveform: config.waveform,
      minValue: config.minValue,
      maxValue: config.maxValue,
    }
  }

  start(
    callback: (tokens: number) => void,
    intervalMs: number = 1000,
  ): void {
    if (this.running) return

    this.running = true
    this.startTime = Date.now()
    this.emitCallback = callback

    this.interval = setInterval(() => {
      const elapsed = (Date.now() - this.startTime) / 1000
      const value = this.computeValue(elapsed)
      this.emitCallback?.(Math.round(value))
    }, intervalMs)
  }

  stop(): void {
    if (!this.running) return

    this.running = false
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  isRunning(): boolean {
    return this.running
  }

  computeValue(elapsed: number): number {
    const { minValue, maxValue, periodSec, burstProbability } = this.config
    const range = maxValue - minValue
    const phase = (elapsed % periodSec) / periodSec

    switch (this.config.waveform) {
      case "sine": {
        const sine = (Math.sin(phase * 2 * Math.PI) + 1) / 2
        return minValue + range * sine
      }

      case "sawtooth":
        return minValue + range * phase

      case "square":
        return phase < 0.5 ? maxValue : minValue

      case "burst":
        if (Math.random() < burstProbability) {
          return maxValue
        }
        return minValue + Math.random() * range * 0.2

      case "ramp_up": {
        const up = Math.min(1, elapsed / periodSec)
        return minValue + range * up
      }

      case "ramp_down": {
        const down = Math.max(0, 1 - elapsed / periodSec)
        return minValue + range * down
      }

      case "random":
        return minValue + Math.random() * range

      case "constant":
        return (minValue + maxValue) / 2

      default:
        return minValue
    }
  }

  generateSamples(count: number): number[] {
    const samples: number[] = []
    for (let i = 0; i < count; i++) {
      samples.push(Math.round(this.computeValue(i)))
    }
    return samples
  }
}

export async function runVisualValidation(
  waveform: WaveformType,
  durationSec: number,
): Promise<void> {
  const { TokenMonitor } = await import("./token-monitor")
  const { SparklineRenderer } = await import("./sparkline-renderer")
  const { GraphScaler } = await import("./graph-scaler")

  const monitor = new TokenMonitor({ windowSec: 30 })
  const renderer = new SparklineRenderer()
  const scaler = new GraphScaler({ strategy: "peak_30s" })

  const mock = new MockStream({
    waveform,
    minValue: 10,
    maxValue: 150,
  })

  console.log(
    `\n Visual Validation: ${waveform} wave (${durationSec}s)\n`,
  )

  let tick = 0
  mock.start(
    (tokens) => {
      monitor.push(tokens)
      monitor.tick()
      tick++

      const snap = monitor.snapshot()
      const scaled = scaler.scale(snap.history, snap.peak, snap.avg)
      const result = renderer.render(scaled.normalized, { width: 40 })

      process.stdout.write(
        `\r[${tick.toString().padStart(3)}s] ${result.lines[0]} | cur:${snap.current.toString().padStart(3)} peak:${snap.peak.toString().padStart(3)} avg:${snap.avg.toFixed(0).padStart(3)}`,
      )

      if (tick >= durationSec) {
        mock.stop()
        console.log("\n\n Validation complete")
        process.exit(0)
      }
    },
    100,
  )
}
