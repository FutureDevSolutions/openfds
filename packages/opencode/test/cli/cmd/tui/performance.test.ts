import { describe, expect, test } from "bun:test"
import {
  createPerformanceMonitor,
  computeMetricsLayout,
  computeGraphContent,
} from "../../../../src/cli/cmd/tui/routes/session/performance"
import { TokenMonitor } from "../../../../src/cli/cmd/tui/util/token-monitor"
import { SparklineRenderer } from "../../../../src/cli/cmd/tui/util/sparkline-renderer"
import { GraphScaler } from "../../../../src/cli/cmd/tui/util/graph-scaler"
import { StatsOverlay } from "../../../../src/cli/cmd/tui/util/stats-overlay"

// ── createPerformanceMonitor ────────────────────────────────────

describe("createPerformanceMonitor", () => {
  test("returns monitor, push, and reset", () => {
    const perf = createPerformanceMonitor()
    expect(perf.monitor).toBeInstanceOf(TokenMonitor)
    expect(typeof perf.push).toBe("function")
    expect(typeof perf.reset).toBe("function")
  })

  test("push accumulates tokens on the monitor", () => {
    const perf = createPerformanceMonitor()
    perf.push(10)
    perf.push(20)
    perf.monitor.tick()
    const snap = perf.monitor.snapshot()
    expect(snap.current).toBe(30)
    expect(snap.sampleCount).toBe(1)
  })

  test("reset clears accumulated state", () => {
    const perf = createPerformanceMonitor()
    perf.push(100)
    perf.monitor.tick()
    perf.reset()
    expect(perf.monitor.isEmpty()).toBe(true)
    expect(perf.monitor.snapshot().sampleCount).toBe(0)
  })

  test("monitor has 30-second window", () => {
    const perf = createPerformanceMonitor()
    for (let i = 0; i < 30; i++) {
      perf.push(i + 1)
      perf.monitor.tick()
    }
    const snap = perf.monitor.snapshot()
    expect(snap.history.length).toBe(30)
    expect(snap.windowFilled).toBe(true)
  })
})

// ── computeMetricsLayout ────────────────────────────────────────

describe("computeMetricsLayout", () => {
  test("hidden when terminal width < 120", () => {
    expect(computeMetricsLayout(80).visible).toBe(false)
    expect(computeMetricsLayout(100).visible).toBe(false)
    expect(computeMetricsLayout(119).visible).toBe(false)
  })

  test("hidden layout returns width 0", () => {
    expect(computeMetricsLayout(80).width).toBe(0)
    expect(computeMetricsLayout(119).width).toBe(0)
  })

  test("visible at exactly 120 columns", () => {
    const layout = computeMetricsLayout(120)
    expect(layout.visible).toBe(true)
    expect(layout.width).toBeGreaterThanOrEqual(24)
  })

  test("width is 18% of total, clamped 24-36", () => {
    // 120 * 0.18 = 21.6 → round = 22 → clamped to 24 (minimum)
    expect(computeMetricsLayout(120).width).toBe(24)

    // 150 * 0.18 = 27 → clamped stays 27
    expect(computeMetricsLayout(150).width).toBe(27)

    // 180 * 0.18 = 32.4 → round = 32
    expect(computeMetricsLayout(180).width).toBe(32)

    // 200 * 0.18 = 36 → exactly 36
    expect(computeMetricsLayout(200).width).toBe(36)

    // 250 * 0.18 = 45 → clamped to 36 (maximum)
    expect(computeMetricsLayout(250).width).toBe(36)
  })

  test("minimum width is 24", () => {
    // Any visible width must be >= 24
    for (let w = 120; w <= 140; w++) {
      const layout = computeMetricsLayout(w)
      expect(layout.width).toBeGreaterThanOrEqual(24)
    }
  })

  test("maximum width is 36", () => {
    for (let w = 200; w <= 400; w += 50) {
      const layout = computeMetricsLayout(w)
      expect(layout.width).toBeLessThanOrEqual(36)
    }
  })
})

// ── computeGraphContent ─────────────────────────────────────────

describe("computeGraphContent", () => {
  const renderer = new SparklineRenderer()
  const scaler = new GraphScaler({ strategy: "peak_30s", smoothingFactor: 1 })
  const overlay = new StatsOverlay({ placement: "inline" })

  test("null snapshot produces placeholder line", () => {
    const result = computeGraphContent(null, 30, renderer, scaler, overlay)
    expect(result.stats).toBe("-- t/s")
    // Placeholder is width-4 horizontal line characters
    expect(result.graph).toBe("\u2500".repeat(26))
  })

  test("empty snapshot (sampleCount=0) produces placeholder", () => {
    const mon = new TokenMonitor()
    const snap = mon.snapshot()
    expect(snap.sampleCount).toBe(0)

    const result = computeGraphContent(snap, 30, renderer, scaler, overlay)
    expect(result.stats).toBe("-- t/s")
    expect(result.graph.length).toBe(26)
  })

  test("active snapshot produces graph and stats", () => {
    // Fresh scaler for this test to avoid stale state
    const freshScaler = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
    })
    const mon = new TokenMonitor({ windowSec: 5 })
    mon.push(50)
    mon.tick()
    mon.push(100)
    mon.tick()
    const snap = mon.snapshot()

    const result = computeGraphContent(
      snap,
      30,
      renderer,
      freshScaler,
      overlay,
    )
    expect(result.stats).toBe("100 t/s")
    expect(result.graph.length).toBeGreaterThan(0)
  })

  test("stats reflect current value", () => {
    const freshScaler = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
    })
    const mon = new TokenMonitor({ windowSec: 5 })
    mon.push(42)
    mon.tick()
    const snap = mon.snapshot()

    const result = computeGraphContent(
      snap,
      30,
      renderer,
      freshScaler,
      overlay,
    )
    expect(result.stats).toBe("42 t/s")
  })

  test("graph width adapts to panel width", () => {
    const freshScaler = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
    })
    const mon = new TokenMonitor({ windowSec: 5 })
    mon.push(100)
    mon.tick()
    const snap = mon.snapshot()

    const narrow = computeGraphContent(
      snap,
      24,
      renderer,
      freshScaler,
      overlay,
    )
    const wide = computeGraphContent(
      snap,
      36,
      renderer,
      freshScaler,
      overlay,
    )
    // Wider panel produces longer graph content
    expect(wide.graph.length).toBeGreaterThanOrEqual(narrow.graph.length)
  })

  test("placeholder width never negative for small widths", () => {
    const result = computeGraphContent(null, 2, renderer, scaler, overlay)
    // width - 4 = -2 → clamped to 0
    expect(result.graph.length).toBe(0)
  })
})

// ── Integration: full pipeline ──────────────────────────────────

describe("integration: monitor → scaler → renderer → overlay", () => {
  test("end-to-end with realistic token stream", () => {
    const perf = createPerformanceMonitor()
    const renderer = new SparklineRenderer()
    const scaler = new GraphScaler({ strategy: "peak_30s", smoothingFactor: 1 })
    const overlay = new StatsOverlay({ placement: "inline" })

    // Simulate 10 seconds of streaming at varying rates
    const rates = [50, 80, 120, 200, 180, 150, 90, 60, 100, 130]
    for (const rate of rates) {
      perf.push(rate)
      perf.monitor.tick()
    }

    const snap = perf.monitor.snapshot()
    expect(snap.sampleCount).toBe(10)
    expect(snap.history.length).toBe(10)

    const content = computeGraphContent(snap, 30, renderer, scaler, overlay)
    expect(content.graph.length).toBeGreaterThan(0)
    expect(content.stats).toBe("130 t/s")
  })

  test("after reset, placeholder is restored", () => {
    const perf = createPerformanceMonitor()
    const renderer = new SparklineRenderer()
    const scaler = new GraphScaler({ strategy: "peak_30s", smoothingFactor: 1 })
    const overlay = new StatsOverlay({ placement: "inline" })

    perf.push(100)
    perf.monitor.tick()
    perf.reset()

    const snap = perf.monitor.snapshot()
    const content = computeGraphContent(snap, 30, renderer, scaler, overlay)
    expect(content.stats).toBe("-- t/s")
  })

  test("layout visibility gates panel rendering", () => {
    const narrow = computeMetricsLayout(100)
    expect(narrow.visible).toBe(false)

    const wide = computeMetricsLayout(160)
    expect(wide.visible).toBe(true)

    // When visible, width is usable for graphContent
    const perf = createPerformanceMonitor()
    perf.push(50)
    perf.monitor.tick()

    const renderer = new SparklineRenderer()
    const scaler = new GraphScaler({ strategy: "peak_30s", smoothingFactor: 1 })
    const overlay = new StatsOverlay({ placement: "inline" })
    const snap = perf.monitor.snapshot()

    const content = computeGraphContent(
      snap,
      wide.width,
      renderer,
      scaler,
      overlay,
    )
    expect(content.graph.length).toBeGreaterThan(0)
    expect(content.stats).toBe("50 t/s")
  })
})

// ── Token estimation ────────────────────────────────────────────

describe("Token.estimate integration", () => {
  // Token.estimate is imported indirectly via the session index,
  // but we test the pipeline: estimate → push → monitor → graph
  test("string deltas accumulate via push", () => {
    const perf = createPerformanceMonitor()
    // Simulate what the event handler does:
    // Token.estimate("hello world") ≈ 11/4 = 3 tokens
    const delta = "hello world"
    const estimate = Math.max(0, Math.round(delta.length / 4))
    perf.push(estimate)
    perf.monitor.tick()
    expect(perf.monitor.snapshot().current).toBe(estimate)
  })
})

// ── Performance ─────────────────────────────────────────────────

describe("performance", () => {
  test("computeMetricsLayout is fast (< 1μs)", () => {
    // Warm up
    for (let i = 0; i < 100; i++) computeMetricsLayout(160)

    const iterations = 10000
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      computeMetricsLayout(160)
    }
    const elapsed = performance.now() - start
    const avgMicroseconds = (elapsed / iterations) * 1000
    expect(avgMicroseconds).toBeLessThan(1)
  })

  test("computeGraphContent completes quickly", () => {
    const renderer = new SparklineRenderer()
    const scaler = new GraphScaler({ strategy: "peak_30s", smoothingFactor: 1 })
    const overlay = new StatsOverlay({ placement: "inline" })

    const mon = new TokenMonitor({ windowSec: 30 })
    for (let i = 0; i < 30; i++) {
      mon.push((i + 1) * 10)
      mon.tick()
    }
    const snap = mon.snapshot()

    // Warm up
    for (let i = 0; i < 50; i++) {
      computeGraphContent(snap, 30, renderer, scaler, overlay)
    }

    const iterations = 500
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      computeGraphContent(snap, 30, renderer, scaler, overlay)
    }
    const elapsed = performance.now() - start
    const avgMicroseconds = (elapsed / iterations) * 1000
    // Full pipeline should complete in < 200μs
    expect(avgMicroseconds).toBeLessThan(200)
  })
})
