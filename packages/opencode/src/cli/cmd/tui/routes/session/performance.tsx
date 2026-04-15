import { createSignal, createEffect, onCleanup, Show } from "solid-js"
import { TokenMonitor, type MonitorSnapshot } from "../../util/token-monitor"
import { SparklineRenderer } from "../../util/sparkline-renderer"
import { GraphScaler } from "../../util/graph-scaler"
import { StatsOverlay, composeGraphWithStats } from "../../util/stats-overlay"
import { useTheme } from "@tui/context/theme"

export interface PerformancePanelProps {
  monitor: TokenMonitor
  width: number
  height?: number
  visible?: boolean
}

/**
 * Compute metrics column visibility and width from terminal width.
 * Pure function exported for testing.
 *
 * Layout math:
 *   width = clamp(round(total * 0.18), 24, 36)
 *   hidden when total < 120
 */
export function computeMetricsLayout(totalWidth: number): {
  visible: boolean
  width: number
} {
  const visible = totalWidth >= 120
  const width = visible
    ? Math.min(36, Math.max(24, Math.round(totalWidth * 0.18)))
    : 0
  return { visible, width }
}

/**
 * Derive sparkline string + stats label from a monitor snapshot.
 * Pure function exported for testing.
 */
export function computeGraphContent(
  snapshot: MonitorSnapshot | null,
  width: number,
  renderer: SparklineRenderer,
  scaler: GraphScaler,
  overlay: StatsOverlay,
): { graph: string; stats: string } {
  if (!snapshot || snapshot.sampleCount === 0) {
    return {
      graph: "\u2500".repeat(Math.max(0, width - 4)),
      stats: "-- t/s",
    }
  }

  const scaled = scaler.scale(snapshot.history, snapshot.peak, snapshot.avg)

  const graphWidth = Math.max(8, width - 12)
  const sparkResult = renderer.render(scaled.normalized, { width: graphWidth })

  const overlayResult = overlay.render(
    { current: snapshot.current, peak: snapshot.peak, avg: snapshot.avg },
    width - 2,
  )

  const composed = composeGraphWithStats(
    sparkResult.lines[0],
    overlayResult,
    width - 2,
  )

  return { graph: composed, stats: `${snapshot.current} t/s` }
}

export function PerformancePanel(props: PerformancePanelProps) {
  const { theme } = useTheme()
  const [snapshot, setSnapshot] = createSignal<MonitorSnapshot | null>(null)

  const renderer = new SparklineRenderer()
  const scaler = new GraphScaler({ strategy: "peak_30s" })

  // 1-second tick: flush accumulated tokens and capture snapshot
  createEffect(() => {
    const interval = setInterval(() => {
      props.monitor.tick()
      setSnapshot(props.monitor.snapshot())
    }, 1000)
    onCleanup(() => clearInterval(interval))
  })

  const graphLine = () => {
    const snap = snapshot()
    if (!snap || snap.sampleCount === 0) {
      return "\u2500".repeat(Math.max(0, props.width - 4))
    }
    const scaled = scaler.scale(snap.history, snap.peak, snap.avg)
    const graphWidth = Math.max(4, props.width - 2)
    const sparkResult = renderer.render(scaled.normalized, {
      width: graphWidth,
      mode: "block",
    })
    return sparkResult.lines[0]
  }

  const statsLine = () => {
    const snap = snapshot()
    if (!snap || snap.sampleCount === 0) {
      return { current: "-- t/s", peak: "-- t/s", avg: "-- t/s" }
    }
    return {
      current: `${formatStat(snap.current)} t/s`,
      peak: `${formatStat(snap.peak)} t/s`,
      avg: `${formatStat(snap.avg)} t/s`,
    }
  }

  return (
    <Show when={props.visible !== false}>
      <box flexDirection="column" flexShrink={0}>
        <text fg={theme.text}>
          <b>Performance</b>
        </text>
        <box>
          <text fg={theme.text}>{graphLine()}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>
            Now
          </text>
          <text fg={theme.text}>
            {statsLine().current}
          </text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>
            Max
          </text>
          <text fg={theme.text}>
            {statsLine().peak}
          </text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>
            Avg
          </text>
          <text fg={theme.text}>
            {statsLine().avg}
          </text>
        </box>
        <box justifyContent="flex-end">
          <text fg={theme.textMuted}>
            {snapshot()?.windowFilled
              ? "30s window"
              : `${snapshot()?.sampleCount ?? 0}s window`}
          </text>
        </box>
      </box>
    </Show>
  )
}

function formatStat(n: number): string {
  if (n < 1000) return n.toFixed(n < 10 && n > 0 ? 1 : 0)
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k"
  return (n / 1_000_000).toFixed(1) + "M"
}

/**
 * Create and return a TokenMonitor instance with helper methods.
 * The caller owns the monitor and passes it to PerformancePanel.
 */
export function createPerformanceMonitor() {
  const monitor = new TokenMonitor({ windowSec: 30 })
  return {
    monitor,
    push: (tokens: number) => monitor.push(tokens),
    reset: () => monitor.reset(),
  }
}
