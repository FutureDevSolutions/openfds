import { describe, expect, test } from "bun:test"
import { TokenMonitor } from "../../../../src/cli/cmd/tui/util/token-monitor"

describe("TokenMonitor", () => {
  test("starts empty", () => {
    const mon = new TokenMonitor()
    expect(mon.isEmpty()).toBe(true)
    const snap = mon.snapshot()
    expect(snap.current).toBe(0)
    expect(snap.peak).toBe(0)
    expect(snap.avg).toBe(0)
    expect(snap.history).toEqual([])
    expect(snap.sampleCount).toBe(0)
    expect(snap.windowFilled).toBe(false)
  })

  test("push accumulates tokens between ticks", () => {
    const mon = new TokenMonitor()
    mon.push(10)
    mon.push(20)
    mon.push(5)
    mon.tick()
    const snap = mon.snapshot()
    expect(snap.current).toBe(35)
    expect(snap.sampleCount).toBe(1)
  })

  test("tick flushes pending tokens and resets accumulator", () => {
    const mon = new TokenMonitor()
    mon.push(42)
    mon.tick()
    mon.tick() // second tick with no pushes
    const snap = mon.snapshot()
    expect(snap.current).toBe(0) // most recent is 0
    expect(snap.history).toEqual([42, 0])
    expect(snap.sampleCount).toBe(2)
  })

  test("snapshot returns history ordered oldest to newest", () => {
    const mon = new TokenMonitor({ windowSec: 5 })
    for (let i = 1; i <= 5; i++) {
      mon.push(i * 10)
      mon.tick()
    }
    const snap = mon.snapshot()
    expect([...snap.history]).toEqual([10, 20, 30, 40, 50])
    expect(snap.current).toBe(50)
  })

  test("circular buffer wraps correctly", () => {
    const mon = new TokenMonitor({ windowSec: 3 })
    // Fill buffer: [10, 20, 30]
    mon.push(10); mon.tick()
    mon.push(20); mon.tick()
    mon.push(30); mon.tick()
    expect(mon.snapshot().windowFilled).toBe(true)

    // Overwrite oldest (10): buffer becomes [40, 20, 30] with writeIdx=1
    mon.push(40); mon.tick()
    const snap = mon.snapshot()
    expect([...snap.history]).toEqual([20, 30, 40])
    expect(snap.current).toBe(40)
    expect(snap.sampleCount).toBe(4)
  })

  test("peak tracks maximum in window", () => {
    const mon = new TokenMonitor({ windowSec: 5 })
    mon.push(5); mon.tick()
    mon.push(100); mon.tick()
    mon.push(3); mon.tick()
    expect(mon.snapshot().peak).toBe(100)
  })

  test("peak recomputes when evicted", () => {
    const mon = new TokenMonitor({ windowSec: 3 })
    mon.push(100); mon.tick() // idx 0
    mon.push(50); mon.tick()  // idx 1
    mon.push(30); mon.tick()  // idx 2, filled=true
    expect(mon.snapshot().peak).toBe(100)

    // Evict idx 0 (the peak)
    mon.push(20); mon.tick()  // overwrites idx 0
    expect(mon.snapshot().peak).toBe(50)

    // Evict idx 1 (the new peak)
    mon.push(10); mon.tick()  // overwrites idx 1
    expect(mon.snapshot().peak).toBe(30)
  })

  test("average is computed correctly", () => {
    const mon = new TokenMonitor({ windowSec: 5 })
    mon.push(10); mon.tick()
    mon.push(20); mon.tick()
    mon.push(30); mon.tick()
    // avg = (10 + 20 + 30) / 3 = 20
    expect(mon.snapshot().avg).toBe(20)
  })

  test("average rounds to 1 decimal", () => {
    const mon = new TokenMonitor({ windowSec: 3 })
    mon.push(1); mon.tick()
    mon.push(2); mon.tick()
    // avg = 1.5
    expect(mon.snapshot().avg).toBe(1.5)

    mon.push(3); mon.tick()
    // avg = (1 + 2 + 3) / 3 = 2.0
    expect(mon.snapshot().avg).toBe(2)
  })

  test("windowFilled is false until buffer cycles", () => {
    const mon = new TokenMonitor({ windowSec: 3 })
    mon.push(1); mon.tick()
    expect(mon.snapshot().windowFilled).toBe(false)
    mon.push(2); mon.tick()
    expect(mon.snapshot().windowFilled).toBe(false)
    mon.push(3); mon.tick()
    expect(mon.snapshot().windowFilled).toBe(true)
  })

  test("reset clears all state", () => {
    const mon = new TokenMonitor({ windowSec: 5 })
    mon.push(50); mon.tick()
    mon.push(100); mon.tick()
    mon.push(25)

    mon.reset()

    expect(mon.isEmpty()).toBe(true)
    const snap = mon.snapshot()
    expect(snap.current).toBe(0)
    expect(snap.peak).toBe(0)
    expect(snap.avg).toBe(0)
    expect(snap.history).toEqual([])
    expect(snap.sampleCount).toBe(0)
    expect(snap.windowFilled).toBe(false)
  })

  test("reset allows reuse without reallocation", () => {
    const mon = new TokenMonitor({ windowSec: 5 })
    mon.push(10); mon.tick()
    mon.push(20); mon.tick()

    mon.reset()

    mon.push(99); mon.tick()
    const snap = mon.snapshot()
    expect(snap.current).toBe(99)
    expect(snap.peak).toBe(99)
    expect(snap.sampleCount).toBe(1)
    expect(snap.windowFilled).toBe(false)
  })

  test("history snapshot is frozen", () => {
    const mon = new TokenMonitor({ windowSec: 5 })
    mon.push(10); mon.tick()
    const snap = mon.snapshot()
    expect(() => {
      ;(snap.history as number[])[0] = 999
    }).toThrow()
  })

  test("buffer memory remains constant after 100+ ticks", () => {
    const mon = new TokenMonitor({ windowSec: 10 })
    for (let i = 0; i < 150; i++) {
      mon.push(i)
      mon.tick()
    }
    const snap = mon.snapshot()
    expect(snap.history.length).toBe(10) // window size, not 150
    expect(snap.sampleCount).toBe(150)
    expect(snap.windowFilled).toBe(true)
  })

  test("default window size is 30", () => {
    const mon = new TokenMonitor()
    for (let i = 0; i < 30; i++) {
      mon.push(i + 1)
      mon.tick()
    }
    expect(mon.snapshot().history.length).toBe(30)
    expect(mon.snapshot().windowFilled).toBe(true)
  })

  test("push with zero tokens", () => {
    const mon = new TokenMonitor({ windowSec: 5 })
    mon.push(0)
    mon.tick()
    expect(mon.snapshot().current).toBe(0)
    expect(mon.snapshot().sampleCount).toBe(1)
    expect(mon.isEmpty()).toBe(false)
  })

  test("multiple full cycles maintain correctness", () => {
    const mon = new TokenMonitor({ windowSec: 3 })
    // 3 full cycles = 9 ticks
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90]
    for (const v of values) {
      mon.push(v)
      mon.tick()
    }
    const snap = mon.snapshot()
    expect([...snap.history]).toEqual([70, 80, 90])
    expect(snap.peak).toBe(90)
    expect(snap.current).toBe(90)
    expect(snap.sampleCount).toBe(9)
  })

  test("peak updates when new sample equals current peak", () => {
    const mon = new TokenMonitor({ windowSec: 5 })
    mon.push(50); mon.tick()
    mon.push(50); mon.tick()
    expect(mon.snapshot().peak).toBe(50)
  })

  test("consecutive empty ticks produce zero-filled history", () => {
    const mon = new TokenMonitor({ windowSec: 5 })
    mon.tick()
    mon.tick()
    mon.tick()
    const snap = mon.snapshot()
    expect([...snap.history]).toEqual([0, 0, 0])
    expect(snap.avg).toBe(0)
    expect(snap.peak).toBe(0)
    expect(snap.current).toBe(0)
    expect(snap.sampleCount).toBe(3)
  })

  test("very large values are stored accurately", () => {
    const mon = new TokenMonitor({ windowSec: 5 })
    mon.push(Number.MAX_SAFE_INTEGER)
    mon.tick()
    expect(mon.snapshot().current).toBe(Number.MAX_SAFE_INTEGER)
    expect(mon.snapshot().peak).toBe(Number.MAX_SAFE_INTEGER)
  })

  test("single-sample partial window gives avg equal to that sample", () => {
    const mon = new TokenMonitor({ windowSec: 10 })
    mon.push(42)
    mon.tick()
    expect(mon.snapshot().avg).toBe(42)
    expect(mon.snapshot().history.length).toBe(1)
  })

  test("high frequency push performance", () => {
    const mon = new TokenMonitor()
    const iterations = 1_000_000
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      mon.push(1)
    }
    const elapsed = performance.now() - start
    // Should complete 1M pushes in well under 1 second
    expect(elapsed).toBeLessThan(1000)
    mon.tick()
    expect(mon.snapshot().current).toBe(iterations)
  })
})
