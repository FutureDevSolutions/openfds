import { describe, expect, test } from "bun:test"
import { GraphScaler } from "../../../../src/cli/cmd/tui/util/graph-scaler"

describe("GraphScaler", () => {
  // ── Strategy: peak_30s ──────────────────────────────────────────

  test("peak_30s uses peak as raw target", () => {
    const s = new GraphScaler({ strategy: "peak_30s", smoothingFactor: 1 })
    const r = s.scale([50, 100], 100, 75)
    // rawTarget=100, hysteresis: 100>0 → scale up, smooth(1,100)=100
    expect(r.yMax).toBe(100)
    expect(r.scaleChanged).toBe(true)
  })

  test("peak_30s falls back to minScale when peak is 0", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
      minScale: 5,
    })
    // peak=0 → rawTarget = 0 || 5 = 5
    // hysteresis: 0 > 0*1.15=0? No (not strictly >). 0 < 0*0.85=0? No.
    // Within band → newTarget=currentScale=1
    // smooth(1, 1) = 1, yMax = max(1, 5) = 5
    const r = s.scale([0], 0, 0)
    expect(r.yMax).toBe(5)
  })

  // ── Strategy: peak_padded ───────────────────────────────────────

  test("peak_padded adds headroom factor", () => {
    const s = new GraphScaler({
      strategy: "peak_padded",
      smoothingFactor: 1,
      headroomFactor: 1.2,
    })
    const r = s.scale([80, 100], 100, 90)
    // rawTarget = 100 * 1.2 = 120
    expect(r.yMax).toBe(120)
  })

  test("peak_padded custom headroom factor", () => {
    const s = new GraphScaler({
      strategy: "peak_padded",
      smoothingFactor: 1,
      headroomFactor: 1.5,
    })
    const r = s.scale([200], 200, 200)
    expect(r.yMax).toBe(300)
  })

  // ── Strategy: rolling_avg ───────────────────────────────────────

  test("rolling_avg scales to 2x average", () => {
    const s = new GraphScaler({ strategy: "rolling_avg", smoothingFactor: 1 })
    const r = s.scale([40, 60], 60, 50)
    // rawTarget = max(50*2, 1) = 100
    expect(r.yMax).toBe(100)
  })

  test("rolling_avg respects minScale when avg is tiny", () => {
    const s = new GraphScaler({
      strategy: "rolling_avg",
      smoothingFactor: 1,
      minScale: 10,
    })
    // avg=2 → 2*2=4, max(4, 10)=10 as rawTarget
    // hysteresis: peak=3 > 0*1.15=0 → scale up, newTarget=10
    // smooth(1, 10) = 10, yMax = max(10, 10) = 10
    const r = s.scale([1, 2, 3], 3, 2)
    expect(r.yMax).toBe(10)
  })

  // ── Strategy: fixed ─────────────────────────────────────────────

  test("fixed strategy uses fixedMax", () => {
    const s = new GraphScaler({
      strategy: "fixed",
      fixedMax: 200,
      smoothingFactor: 1,
    })
    const r = s.scale([50, 100], 100, 75)
    // rawTarget = 200, hysteresis: 100 > 0 → scale up, newTarget=200
    expect(r.yMax).toBe(200)
  })

  test("fixed strategy ignores actual data range", () => {
    const s = new GraphScaler({
      strategy: "fixed",
      fixedMax: 100,
      smoothingFactor: 1,
    })
    // Even with peak of 5000, rawTarget stays 100
    const r = s.scale([5000], 5000, 5000)
    // hysteresis: 5000 > 0 → scale up, newTarget=100
    expect(r.yMax).toBe(100)
  })

  // ── Strategy: hybrid ────────────────────────────────────────────

  test("hybrid blends 70% peak + 30% of 2x average", () => {
    const s = new GraphScaler({ strategy: "hybrid", smoothingFactor: 1 })
    // peak=100, avg=50
    // peakComponent = 100 * 0.7 = 70
    // avgComponent = 50 * 2 * 0.3 = 30
    // rawTarget = max(70 + 30, 1) = 100
    const r = s.scale([50, 100], 100, 50)
    expect(r.yMax).toBe(100)
  })

  test("hybrid with high average gives more headroom than peak alone", () => {
    const s = new GraphScaler({ strategy: "hybrid", smoothingFactor: 1 })
    // peak=100, avg=80
    // peakComponent = 100 * 0.7 = 70
    // avgComponent = 80 * 2 * 0.3 = 48
    // rawTarget = 118
    const r = s.scale([60, 80, 100], 100, 80)
    expect(r.yMax).toBe(118)
  })

  test("hybrid respects minScale", () => {
    const s = new GraphScaler({
      strategy: "hybrid",
      smoothingFactor: 1,
      minScale: 50,
    })
    // peak=0, avg=0 → peakComponent=0, avgComponent=0
    // rawTarget = max(0, 50) = 50
    // hysteresis: 0 > 0? No → within band → newTarget=currentScale=1
    // yMax = max(1, 50) = 50
    const r = s.scale([0], 0, 0)
    expect(r.yMax).toBe(50)
  })

  // ── Normalization ───────────────────────────────────────────────

  test("values are normalized to 0-1 range", () => {
    const s = new GraphScaler({
      strategy: "fixed",
      fixedMax: 100,
      smoothingFactor: 1,
    })
    const r = s.scale([0, 25, 50, 75, 100], 100, 50)
    expect([...r.normalized]).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  test("values above yMax are clamped to 1", () => {
    const s = new GraphScaler({
      strategy: "fixed",
      fixedMax: 50,
      smoothingFactor: 1,
    })
    const r = s.scale([100], 100, 100)
    expect(r.normalized[0]).toBe(1)
  })

  test("negative values are clamped to 0", () => {
    const s = new GraphScaler({
      strategy: "fixed",
      fixedMax: 100,
      smoothingFactor: 1,
    })
    const r = s.scale([-10, 50], 50, 20)
    expect(r.normalized[0]).toBe(0)
    expect(r.normalized[1]).toBe(0.5)
  })

  test("empty values array produces empty normalized array", () => {
    const s = new GraphScaler({
      strategy: "fixed",
      fixedMax: 100,
      smoothingFactor: 1,
    })
    const r = s.scale([], 0, 0)
    expect([...r.normalized]).toEqual([])
  })

  test("normalized array is frozen", () => {
    const s = new GraphScaler({
      strategy: "fixed",
      fixedMax: 100,
      smoothingFactor: 1,
    })
    const r = s.scale([50], 50, 50)
    expect(() => {
      ;(r.normalized as number[])[0] = 999
    }).toThrow()
  })

  // ── Utilization ─────────────────────────────────────────────────

  test("utilizationPct reflects peak as percentage of yMax", () => {
    const s = new GraphScaler({
      strategy: "fixed",
      fixedMax: 200,
      smoothingFactor: 1,
    })
    const r = s.scale([50, 100], 100, 75)
    // peak=100, yMax=200 → 100/200*100 = 50
    expect(r.utilizationPct).toBe(50)
  })

  test("utilizationPct is 0 when peak is 0", () => {
    const s = new GraphScaler({
      strategy: "fixed",
      fixedMax: 100,
      smoothingFactor: 1,
    })
    const r = s.scale([0], 0, 0)
    expect(r.utilizationPct).toBe(0)
  })

  test("utilizationPct can exceed 100 when peak > yMax", () => {
    const s = new GraphScaler({
      strategy: "fixed",
      fixedMax: 50,
      smoothingFactor: 1,
    })
    const r = s.scale([100], 100, 100)
    // peak=100, yMax=50 → 200%
    expect(r.utilizationPct).toBe(200)
  })

  // ── Hysteresis: within-band ─────────────────────────────────────

  test("no rescale when peak varies by less than 15%", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
      hysteresisThreshold: 0.15,
    })

    // Establish baseline: peak=100, lastPeak set to 100
    s.scale([100], 100, 100)

    // Peak changes by 10% up — within 15% threshold
    const r2 = s.scale([110], 110, 110)
    expect(r2.scaleChanged).toBe(false)

    // Peak changes by 10% down from original — within threshold
    const r3 = s.scale([90], 90, 90)
    expect(r3.scaleChanged).toBe(false)
  })

  test("within-band holds currentScale steady", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
    })

    const r1 = s.scale([100], 100, 100)
    const scale1 = r1.yMax // 100

    // 5% change — within band
    const r2 = s.scale([105], 105, 105)
    expect(r2.yMax).toBe(scale1) // Scale unchanged
    expect(r2.scaleChanged).toBe(false)
  })

  // ── Hysteresis: immediate scale-up ──────────────────────────────

  test("immediate scale-up when peak exceeds threshold", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
      hysteresisThreshold: 0.15,
    })

    // Establish baseline
    s.scale([100], 100, 100)

    // Peak jumps 20% — above 15% threshold
    const r = s.scale([120], 120, 120)
    expect(r.scaleChanged).toBe(true)
    expect(r.yMax).toBe(120) // Immediate scale-up (smoothing=1)
  })

  test("scale-up is immediate with < 1 tick latency", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
    })

    // First call establishes scale
    s.scale([50], 50, 50)

    // Spike to 200 — immediate scale-up in one tick
    const r = s.scale([200], 200, 200)
    expect(r.scaleChanged).toBe(true)
    expect(r.yMax).toBe(200)
  })

  // ── Hysteresis: delayed scale-down ──────────────────────────────

  test("scale-down waits for scaleDownDelay ticks", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
      scaleDownDelay: 5,
    })

    // Establish at 100
    s.scale([100], 100, 100)

    // Drop to 50 — below 85% threshold
    // Ticks 1-4: scale should NOT change
    for (let i = 0; i < 4; i++) {
      const r = s.scale([50], 50, 50)
      expect(r.scaleChanged).toBe(false)
      expect(r.yMax).toBe(100) // Held at old scale
    }

    // Tick 5: delay met, scale-down fires
    const r5 = s.scale([50], 50, 50)
    expect(r5.scaleChanged).toBe(true)
    expect(r5.yMax).toBe(50)
  })

  test("scale-down delay resets if peak returns to band", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
      scaleDownDelay: 5,
    })

    // Establish at 100
    s.scale([100], 100, 100)

    // 3 ticks below threshold
    for (let i = 0; i < 3; i++) {
      s.scale([50], 50, 50)
    }

    // Return to within-band — resets ticksSinceNewPeak
    s.scale([95], 95, 95)

    // Drop again — counter restarts from 0
    for (let i = 0; i < 4; i++) {
      const r = s.scale([50], 50, 50)
      expect(r.scaleChanged).toBe(false)
    }

    // 5th tick after reset — now fires
    const r = s.scale([50], 50, 50)
    expect(r.scaleChanged).toBe(true)
  })

  // ── Exponential smoothing ───────────────────────────────────────

  test("smoothing closes 30% of gap per tick with default alpha", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 0.3,
    })

    // First tick: currentScale starts at 1, target jumps to 100
    // smooth(1, 100) = 0.3*100 + 0.7*1 = 30.7
    const r = s.scale([100], 100, 100)
    expect(r.yMax).toBeCloseTo(30.7, 5)
  })

  test("smoothingFactor=1.0 produces instant jumps", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
    })
    const r = s.scale([100], 100, 100)
    expect(r.yMax).toBe(100)
  })

  test("smoothingFactor=0 holds current scale forever", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 0,
    })
    // smooth(1, target) = 0*target + 1*1 = 1
    const r = s.scale([100], 100, 100)
    expect(r.yMax).toBe(1)
  })

  test("smoothing limits scale jump each tick", () => {
    const alpha = 0.3
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: alpha,
    })

    // Tick 1: jump from 1 to target 100
    const r1 = s.scale([100], 100, 100)
    const gap1 = 100 - 1
    const expectedChange1 = alpha * gap1
    // yMax = 1 + expectedChange1 = 1 + 29.7 = 30.7
    expect(r1.yMax).toBeCloseTo(1 + expectedChange1, 5)

    // After tick 1, hysteresis within-band returns currentScale,
    // so the scale stabilizes at 30.7 on subsequent ticks
    const r2 = s.scale([100], 100, 100)
    expect(r2.yMax).toBeCloseTo(r1.yMax, 5)
  })

  // ── Scale ranges ────────────────────────────────────────────────

  test("handles small values (1-10 t/s)", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
    })
    const r = s.scale([1, 3, 5, 8, 10], 10, 5.4)
    expect(r.yMax).toBe(10)
    expect(r.normalized[0]).toBeCloseTo(0.1, 5)
    expect(r.normalized[4]).toBe(1)
  })

  test("handles large values (1000-10000 t/s)", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
    })
    const r = s.scale([1000, 5000, 10000], 10000, 5333)
    expect(r.yMax).toBe(10000)
    expect(r.normalized[0]).toBeCloseTo(0.1, 5)
    expect(r.normalized[2]).toBe(1)
  })

  // ── minScale ────────────────────────────────────────────────────

  test("minScale prevents yMax from going below threshold", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
      minScale: 10,
    })
    // peak=3 → rawTarget=3
    // hysteresis: 3 > 0 → scale up, newTarget=3
    // smooth(1, 3) = 3, yMax = max(3, 10) = 10
    const r = s.scale([1, 2, 3], 3, 2)
    expect(r.yMax).toBe(10)
  })

  test("minScale default is 1", () => {
    const s = new GraphScaler({ strategy: "peak_30s", smoothingFactor: 1 })
    expect(s.getCurrentMax()).toBe(1)
  })

  // ── reset ───────────────────────────────────────────────────────

  test("reset returns scaler to initial state", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
      minScale: 1,
    })

    // Build up state
    s.scale([100], 100, 100)
    s.scale([200], 200, 200)

    s.reset()

    expect(s.getCurrentMax()).toBe(1)

    // After reset, first scale call behaves like fresh instance
    const r = s.scale([50], 50, 50)
    expect(r.scaleChanged).toBe(true) // 50 > 0*1.15 → new peak
    expect(r.yMax).toBe(50)
  })

  test("reset uses configured minScale", () => {
    const s = new GraphScaler({ minScale: 25 })
    s.scale([100], 100, 100)
    s.reset()
    expect(s.getCurrentMax()).toBe(25)
  })

  // ── forceScale ──────────────────────────────────────────────────

  test("forceScale bypasses hysteresis and smoothing", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 0.3,
    })

    s.forceScale(500)
    expect(s.getCurrentMax()).toBe(500)

    // Next call within band of 500 → no change
    const r = s.scale([480], 480, 480)
    expect(r.scaleChanged).toBe(false)
    expect(r.yMax).toBe(500)
  })

  test("forceScale sets lastPeak so hysteresis tracks from there", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
    })

    s.forceScale(100)

    // Peak jumps above 15% of forced scale → triggers scale-up
    const r = s.scale([120], 120, 120)
    expect(r.scaleChanged).toBe(true)
    expect(r.yMax).toBe(120)
  })

  // ── getCurrentMax ───────────────────────────────────────────────

  test("getCurrentMax returns current yMax without processing", () => {
    const s = new GraphScaler({
      strategy: "fixed",
      fixedMax: 100,
      smoothingFactor: 1,
    })
    // Before any scale call, currentScale=1, yMax=max(1,1)=1
    expect(s.getCurrentMax()).toBe(1)

    s.scale([50], 50, 50)
    // After scale: currentScale=100
    expect(s.getCurrentMax()).toBe(100)
  })

  // ── First call from zero ────────────────────────────────────────

  test("first call with any positive peak triggers scale-up", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
    })
    // lastPeak=0, peak=1 → 1 > 0*1.15=0 → scale-up
    const r = s.scale([1], 1, 1)
    expect(r.scaleChanged).toBe(true)
    expect(r.yMax).toBe(1)
  })

  test("first call with peak=0 stays within band", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
    })
    // peak=0, lastPeak=0 → 0 > 0? No → 0 < 0? No → within band
    const r = s.scale([0], 0, 0)
    expect(r.scaleChanged).toBe(false)
    expect(r.yMax).toBe(1) // minScale
  })

  // ── Integration: multi-tick sequences ───────────────────────────

  test("sustained spike then decay sequence", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
      scaleDownDelay: 3,
    })

    // Ramp up: each jump >15% from last
    const r1 = s.scale([100], 100, 100)
    expect(r1.yMax).toBe(100)

    const r2 = s.scale([200], 200, 200)
    expect(r2.scaleChanged).toBe(true)
    expect(r2.yMax).toBe(200)

    // Drop to 50 — below 200*0.85=170
    // 3 ticks delay
    s.scale([50], 50, 50) // tick 1
    s.scale([50], 50, 50) // tick 2
    const r5 = s.scale([50], 50, 50) // tick 3 → fires
    expect(r5.scaleChanged).toBe(true)
    expect(r5.yMax).toBe(50)
  })

  test("oscillating peaks within band hold scale steady", () => {
    const s = new GraphScaler({
      strategy: "peak_30s",
      smoothingFactor: 1,
    })

    s.scale([100], 100, 100)

    // Oscillate between 90 and 110 (within ±15%)
    const results = []
    for (let i = 0; i < 10; i++) {
      const peak = i % 2 === 0 ? 90 : 110
      results.push(s.scale([peak], peak, peak))
    }

    // None should trigger a scale change
    for (const r of results) {
      expect(r.scaleChanged).toBe(false)
      expect(r.yMax).toBe(100)
    }
  })

  // ── Performance ─────────────────────────────────────────────────

  test("scale completes in < 50μs for 30 values", () => {
    const s = new GraphScaler({ strategy: "peak_30s", smoothingFactor: 0.3 })
    const values = Array.from({ length: 30 }, (_, i) => i * 10)

    // Warm up
    for (let i = 0; i < 100; i++) {
      s.scale(values, 290, 145)
    }

    const iterations = 1000
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      s.scale(values, 290, 145)
    }
    const elapsed = performance.now() - start
    const avgMicroseconds = (elapsed / iterations) * 1000

    expect(avgMicroseconds).toBeLessThan(50)
  })

  test("all strategies meet performance target", () => {
    const strategies = [
      "peak_30s",
      "peak_padded",
      "rolling_avg",
      "fixed",
      "hybrid",
    ] as const
    const values = Array.from({ length: 30 }, (_, i) => i * 10)

    for (const strategy of strategies) {
      const s = new GraphScaler({ strategy, smoothingFactor: 1 })

      // Warm up
      for (let i = 0; i < 50; i++) {
        s.scale(values, 290, 145)
      }

      const iterations = 500
      const start = performance.now()
      for (let i = 0; i < iterations; i++) {
        s.scale(values, 290, 145)
      }
      const elapsed = performance.now() - start
      const avgMicroseconds = (elapsed / iterations) * 1000
      expect(avgMicroseconds).toBeLessThan(50)
    }
  })
})
