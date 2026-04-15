import { describe, expect, test } from "bun:test"
import { MockStream } from "../../../../src/cli/cmd/tui/util/mock-stream"

describe("MockStream", () => {
  // ── Waveform generation ─────────────────────────────────────────

  describe("sine waveform", () => {
    test("produces values within min-max range", () => {
      const mock = new MockStream({
        waveform: "sine",
        minValue: 10,
        maxValue: 100,
      })
      const samples = mock.generateSamples(100)
      for (const s of samples) {
        expect(s).toBeGreaterThanOrEqual(10)
        expect(s).toBeLessThanOrEqual(100)
      }
    })

    test("is periodic — repeats after periodSec samples", () => {
      const mock = new MockStream({
        waveform: "sine",
        minValue: 0,
        maxValue: 100,
        periodSec: 10,
      })
      // Value at t=0 should match t=10 (one full period)
      const v0 = mock.computeValue(0)
      const v10 = mock.computeValue(10)
      expect(v0).toBeCloseTo(v10, 5)
    })

    test("peaks at quarter period, troughs at three-quarter", () => {
      const mock = new MockStream({
        waveform: "sine",
        minValue: 0,
        maxValue: 100,
        periodSec: 10,
      })
      // sine peaks at phase=0.25 → t=2.5
      const peak = mock.computeValue(2.5)
      expect(peak).toBeCloseTo(100, 0)
      // trough at phase=0.75 → t=7.5
      const trough = mock.computeValue(7.5)
      expect(trough).toBeCloseTo(0, 0)
    })
  })

  describe("sawtooth waveform", () => {
    test("ramps from min to max linearly", () => {
      const mock = new MockStream({
        waveform: "sawtooth",
        minValue: 0,
        maxValue: 100,
        periodSec: 10,
      })
      expect(mock.computeValue(0)).toBeCloseTo(0, 0)
      expect(mock.computeValue(5)).toBeCloseTo(50, 0)
      expect(mock.computeValue(9.9)).toBeCloseTo(99, 0)
    })

    test("wraps back to min after period", () => {
      const mock = new MockStream({
        waveform: "sawtooth",
        minValue: 0,
        maxValue: 100,
        periodSec: 10,
      })
      // t=10 wraps to phase=0
      expect(mock.computeValue(10)).toBeCloseTo(0, 0)
      expect(mock.computeValue(15)).toBeCloseTo(50, 0)
    })
  })

  describe("square waveform", () => {
    test("alternates between max and min", () => {
      const mock = new MockStream({
        waveform: "square",
        minValue: 10,
        maxValue: 90,
        periodSec: 10,
      })
      // First half: max
      expect(mock.computeValue(0)).toBe(90)
      expect(mock.computeValue(4)).toBe(90)
      // Second half: min
      expect(mock.computeValue(5)).toBe(10)
      expect(mock.computeValue(9)).toBe(10)
    })
  })

  describe("constant waveform", () => {
    test("returns midpoint of min and max", () => {
      const mock = new MockStream({
        waveform: "constant",
        minValue: 20,
        maxValue: 80,
      })
      const samples = mock.generateSamples(10)
      for (const s of samples) {
        expect(s).toBe(50) // (20+80)/2
      }
    })
  })

  describe("ramp_up waveform", () => {
    test("increases from min to max over period", () => {
      const mock = new MockStream({
        waveform: "ramp_up",
        minValue: 0,
        maxValue: 100,
        periodSec: 10,
      })
      expect(mock.computeValue(0)).toBeCloseTo(0, 0)
      expect(mock.computeValue(5)).toBeCloseTo(50, 0)
      expect(mock.computeValue(10)).toBeCloseTo(100, 0)
    })

    test("holds at max after period", () => {
      const mock = new MockStream({
        waveform: "ramp_up",
        minValue: 0,
        maxValue: 100,
        periodSec: 10,
      })
      expect(mock.computeValue(20)).toBeCloseTo(100, 0)
    })
  })

  describe("ramp_down waveform", () => {
    test("decreases from max to min over period", () => {
      const mock = new MockStream({
        waveform: "ramp_down",
        minValue: 0,
        maxValue: 100,
        periodSec: 10,
      })
      expect(mock.computeValue(0)).toBeCloseTo(100, 0)
      expect(mock.computeValue(5)).toBeCloseTo(50, 0)
      expect(mock.computeValue(10)).toBeCloseTo(0, 0)
    })

    test("holds at min after period", () => {
      const mock = new MockStream({
        waveform: "ramp_down",
        minValue: 0,
        maxValue: 100,
        periodSec: 10,
      })
      expect(mock.computeValue(20)).toBeCloseTo(0, 0)
    })
  })

  describe("random waveform", () => {
    test("values stay within range", () => {
      const mock = new MockStream({
        waveform: "random",
        minValue: 10,
        maxValue: 50,
      })
      const samples = mock.generateSamples(100)
      for (const s of samples) {
        expect(s).toBeGreaterThanOrEqual(10)
        expect(s).toBeLessThanOrEqual(50)
      }
    })
  })

  describe("burst waveform", () => {
    test("mostly low values with occasional spikes", () => {
      const mock = new MockStream({
        waveform: "burst",
        minValue: 0,
        maxValue: 100,
        burstProbability: 0.1,
      })
      const samples = mock.generateSamples(1000)
      const highValues = samples.filter((s) => s > 50)
      // With 10% burst probability, expect roughly ~100 high values
      // but allow wide margin for randomness
      expect(highValues.length).toBeLessThan(500)
      expect(samples.some((s) => s >= 90)).toBe(true) // At least one burst
    })
  })

  // ── generateSamples ─────────────────────────────────────────────

  describe("generateSamples", () => {
    test("returns correct number of samples", () => {
      const mock = new MockStream({
        waveform: "constant",
        minValue: 10,
        maxValue: 50,
      })
      expect(mock.generateSamples(5).length).toBe(5)
      expect(mock.generateSamples(30).length).toBe(30)
      expect(mock.generateSamples(0).length).toBe(0)
    })

    test("returns rounded integers", () => {
      const mock = new MockStream({
        waveform: "sine",
        minValue: 0,
        maxValue: 100,
      })
      const samples = mock.generateSamples(20)
      for (const s of samples) {
        expect(Number.isInteger(s)).toBe(true)
      }
    })
  })

  // ── start/stop lifecycle ────────────────────────────────────────

  describe("lifecycle", () => {
    test("start marks as running", () => {
      const mock = new MockStream({
        waveform: "constant",
        minValue: 50,
        maxValue: 50,
      })
      expect(mock.isRunning()).toBe(false)
      mock.start(() => {})
      expect(mock.isRunning()).toBe(true)
      mock.stop()
    })

    test("stop marks as not running", () => {
      const mock = new MockStream({
        waveform: "constant",
        minValue: 50,
        maxValue: 50,
      })
      mock.start(() => {})
      mock.stop()
      expect(mock.isRunning()).toBe(false)
    })

    test("start is idempotent", () => {
      const mock = new MockStream({
        waveform: "constant",
        minValue: 50,
        maxValue: 50,
      })
      mock.start(() => {})
      mock.start(() => {}) // Should not throw or create duplicate intervals
      expect(mock.isRunning()).toBe(true)
      mock.stop()
    })

    test("stop is idempotent", () => {
      const mock = new MockStream({
        waveform: "constant",
        minValue: 50,
        maxValue: 50,
      })
      mock.start(() => {})
      mock.stop()
      mock.stop() // Should not throw
      expect(mock.isRunning()).toBe(false)
    })
  })

  // ── Integration with TokenMonitor ───────────────────────────────

  describe("integration", () => {
    test("sine wave produces recognizable pattern in monitor", () => {
      const { TokenMonitor } = require(
        "../../../../src/cli/cmd/tui/util/token-monitor",
      )
      const monitor = new TokenMonitor({ windowSec: 20 })
      const mock = new MockStream({
        waveform: "sine",
        minValue: 0,
        maxValue: 100,
        periodSec: 20,
      })

      // Generate one full period
      const samples = mock.generateSamples(20)
      for (const s of samples) {
        monitor.push(s)
        monitor.tick()
      }

      const snap = monitor.snapshot()
      expect(snap.sampleCount).toBe(20)
      expect(snap.peak).toBeGreaterThan(80) // Near max
      // Average of sine over full period ≈ midpoint
      expect(snap.avg).toBeGreaterThan(30)
      expect(snap.avg).toBeLessThan(70)
    })

    test("sawtooth produces linearly increasing history", () => {
      const { TokenMonitor } = require(
        "../../../../src/cli/cmd/tui/util/token-monitor",
      )
      const monitor = new TokenMonitor({ windowSec: 10 })
      const mock = new MockStream({
        waveform: "sawtooth",
        minValue: 0,
        maxValue: 100,
        periodSec: 10,
      })

      const samples = mock.generateSamples(10)
      for (const s of samples) {
        monitor.push(s)
        monitor.tick()
      }

      const snap = monitor.snapshot()
      // History should be roughly monotonically increasing
      for (let i = 1; i < snap.history.length; i++) {
        expect(snap.history[i]).toBeGreaterThanOrEqual(snap.history[i - 1])
      }
    })
  })

  // ── Performance ─────────────────────────────────────────────────

  test("generateSamples(30) completes quickly", () => {
    const mock = new MockStream({
      waveform: "sine",
      minValue: 0,
      maxValue: 100,
    })

    // Warm up
    for (let i = 0; i < 100; i++) mock.generateSamples(30)

    const iterations = 1000
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      mock.generateSamples(30)
    }
    const elapsed = performance.now() - start
    const avgMs = elapsed / iterations
    expect(avgMs).toBeLessThan(1) // < 1ms per call
  })
})
