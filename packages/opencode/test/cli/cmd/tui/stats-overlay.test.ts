import { describe, expect, test } from "bun:test"
import {
  StatsOverlay,
  composeGraphWithStats,
  formatWithSI,
} from "../../../../src/cli/cmd/tui/util/stats-overlay"

// ── SI prefix formatting ────────────────────────────────────────

describe("formatWithSI", () => {
  test("zero renders as 0.0", () => {
    expect(formatWithSI(0)).toBe("0.0")
  })

  test("values under 10 show 1 decimal", () => {
    expect(formatWithSI(0.5)).toBe("0.5")
    expect(formatWithSI(1)).toBe("1.0")
    expect(formatWithSI(5.3)).toBe("5.3")
    expect(formatWithSI(9.9)).toBe("9.9")
  })

  test("values 10-999 show 0 decimals", () => {
    expect(formatWithSI(10)).toBe("10")
    expect(formatWithSI(85)).toBe("85")
    expect(formatWithSI(120)).toBe("120")
    expect(formatWithSI(999)).toBe("999")
  })

  test("thousands use k suffix", () => {
    expect(formatWithSI(1000)).toBe("1.0k")
    expect(formatWithSI(1500)).toBe("1.5k")
    expect(formatWithSI(25000)).toBe("25.0k")
    expect(formatWithSI(999999)).toBe("1000.0k")
  })

  test("millions use M suffix", () => {
    expect(formatWithSI(1_000_000)).toBe("1.0M")
    expect(formatWithSI(3_500_000)).toBe("3.5M")
    expect(formatWithSI(999_999_999)).toBe("1000.0M")
  })

  test("billions use G suffix", () => {
    expect(formatWithSI(1_000_000_000)).toBe("1.0G")
    expect(formatWithSI(10_000_000_000)).toBe("10.0G")
    expect(formatWithSI(42_500_000_000)).toBe("42.5G")
  })

  test("negative values are prefixed with -", () => {
    expect(formatWithSI(-5)).toBe("-5.0")
    expect(formatWithSI(-1500)).toBe("-1.5k")
    expect(formatWithSI(-3_000_000)).toBe("-3.0M")
  })
})

// ── StatsOverlay ────────────────────────────────────────────────

describe("StatsOverlay", () => {
  const data = { current: 85, peak: 120, avg: 62 }

  // ── Placement: inline ───────────────────────────────────────

  describe("inline placement", () => {
    test("standard format shows current and peak", () => {
      const o = new StatsOverlay({ placement: "inline" })
      const r = o.render(data, 50)
      // " 85 ▲120"
      expect(r.placement).toBe("inline")
      expect(r.inlineSuffix).toBe(" 85 \u25B2120")
    })

    test("compact format shows current only", () => {
      const o = new StatsOverlay({ placement: "inline", compactWidth: 30 })
      // width=25 < 30 → compact
      const r = o.render(data, 25)
      expect(r.inlineSuffix).toBe(" 85")
    })

    test("statsWidth matches suffix length", () => {
      const o = new StatsOverlay({ placement: "inline" })
      const r = o.render(data, 50)
      expect(r.statsWidth).toBe(r.inlineSuffix!.length)
    })

    test("large values use SI formatting in suffix", () => {
      const o = new StatsOverlay({ placement: "inline" })
      const r = o.render({ current: 1500, peak: 25000, avg: 800 }, 50)
      expect(r.inlineSuffix).toBe(" 1.5k \u25B225.0k")
    })
  })

  // ── Placement: top_right ────────────────────────────────────

  describe("top_right placement", () => {
    test("symbol labels with all stats", () => {
      const o = new StatsOverlay({ placement: "top_right", labelStyle: "symbol" })
      const r = o.render(data, 50)
      expect(r.placement).toBe("top_right")
      // peak first, then current, then avg, then unit
      expect(r.topRightLabel).toBe("\u25B2120 \u25C685 \u250062 t/s")
    })

    test("text labels non-compact", () => {
      const o = new StatsOverlay({ placement: "top_right", labelStyle: "text" })
      const r = o.render(data, 50)
      expect(r.topRightLabel).toBe("max: 120 cur: 85 avg: 62 t/s")
    })

    test("text labels compact omits unit", () => {
      const o = new StatsOverlay({
        placement: "top_right",
        labelStyle: "text",
        compactWidth: 30,
      })
      // width=25 < 30 → compact
      const r = o.render(data, 25)
      expect(r.topRightLabel).toBe("max:120 cur:85 avg:62")
    })

    test("no labels shows bare numbers", () => {
      const o = new StatsOverlay({ placement: "top_right", labelStyle: "none" })
      const r = o.render(data, 50)
      expect(r.topRightLabel).toBe("120 85 62 t/s")
    })

    test("statsWidth matches label length", () => {
      const o = new StatsOverlay({ placement: "top_right" })
      const r = o.render(data, 50)
      expect(r.statsWidth).toBe(r.topRightLabel!.length)
    })

    test("custom unit is appended", () => {
      const o = new StatsOverlay({ placement: "top_right" })
      const r = o.render({ ...data, unit: "req/s" }, 50)
      expect(r.topRightLabel).toEndWith("req/s")
    })

    test("compact mode omits unit", () => {
      const o = new StatsOverlay({ placement: "top_right", compactWidth: 60 })
      const r = o.render(data, 50)
      expect(r.topRightLabel).not.toContain("t/s")
    })
  })

  // ── Placement: below ────────────────────────────────────────

  describe("below placement", () => {
    test("non-compact uses double-space separators", () => {
      const o = new StatsOverlay({ placement: "below" })
      const r = o.render(data, 50)
      expect(r.placement).toBe("below")
      expect(r.belowLine).toBe("\u25C6 85 t/s  \u25B2 120  \u2500 62")
    })

    test("compact uses single-space separators", () => {
      const o = new StatsOverlay({ placement: "below", compactWidth: 30 })
      const r = o.render(data, 25)
      expect(r.belowLine).toBe("\u25C6 85 t/s \u25B2 120 \u2500 62")
    })

    test("statsWidth matches line length", () => {
      const o = new StatsOverlay({ placement: "below" })
      const r = o.render(data, 50)
      expect(r.statsWidth).toBe(r.belowLine!.length)
    })

    test("below includes unit only on current stat", () => {
      const o = new StatsOverlay({ placement: "below" })
      const r = o.render(data, 50)
      // "t/s" appears once, right after current
      const matches = r.belowLine!.match(/t\/s/g)
      expect(matches).toHaveLength(1)
    })
  })

  // ── Placement: minimal ──────────────────────────────────────

  describe("minimal placement", () => {
    test("shows only current value", () => {
      const o = new StatsOverlay({ placement: "minimal" })
      const r = o.render(data, 50)
      expect(r.placement).toBe("minimal")
      expect(r.minimalLabel).toBe("85")
    })

    test("statsWidth matches label length", () => {
      const o = new StatsOverlay({ placement: "minimal" })
      const r = o.render(data, 50)
      expect(r.statsWidth).toBe(r.minimalLabel!.length)
    })

    test("large current uses SI prefix", () => {
      const o = new StatsOverlay({ placement: "minimal" })
      const r = o.render({ current: 5_500_000, peak: 0, avg: 0 }, 50)
      expect(r.minimalLabel).toBe("5.5M")
    })
  })

  // ── Auto-placement ──────────────────────────────────────────

  describe("auto-placement", () => {
    test("default inline stays inline for width >= 20", () => {
      const o = new StatsOverlay() // placement defaults to 'inline'
      const r = o.render(data, 40)
      expect(r.placement).toBe("inline")
    })

    test("default inline downgrades to minimal for width < 20", () => {
      const o = new StatsOverlay()
      const r = o.render(data, 15)
      expect(r.placement).toBe("minimal")
      expect(r.minimalLabel).toBeDefined()
    })

    test("explicit top_right is never overridden", () => {
      const o = new StatsOverlay({ placement: "top_right" })
      const r = o.render(data, 10)
      expect(r.placement).toBe("top_right")
    })

    test("explicit below is never overridden", () => {
      const o = new StatsOverlay({ placement: "below" })
      const r = o.render(data, 10)
      expect(r.placement).toBe("below")
    })

    test("explicit minimal is never overridden", () => {
      const o = new StatsOverlay({ placement: "minimal" })
      const r = o.render(data, 100)
      expect(r.placement).toBe("minimal")
    })
  })

  // ── Show/hide flags ─────────────────────────────────────────

  describe("show/hide flags", () => {
    test("hiding peak omits it from top_right", () => {
      const o = new StatsOverlay({ placement: "top_right", showPeak: false })
      const r = o.render(data, 50)
      expect(r.topRightLabel).not.toContain("\u25B2")
    })

    test("hiding current omits it from top_right", () => {
      const o = new StatsOverlay({ placement: "top_right", showCurrent: false })
      const r = o.render(data, 50)
      expect(r.topRightLabel).not.toContain("\u25C6")
    })

    test("hiding avg omits it from top_right", () => {
      const o = new StatsOverlay({ placement: "top_right", showAvg: false })
      const r = o.render(data, 50)
      expect(r.topRightLabel).not.toContain("\u2500")
    })

    test("hiding all stats produces empty top_right", () => {
      const o = new StatsOverlay({
        placement: "top_right",
        showCurrent: false,
        showPeak: false,
        showAvg: false,
      })
      const r = o.render(data, 50)
      // No parts, but unit appended: " t/s"
      expect(r.topRightLabel).toBe(" t/s")
    })

    test("hiding peak and avg in below shows only current", () => {
      const o = new StatsOverlay({
        placement: "below",
        showPeak: false,
        showAvg: false,
      })
      const r = o.render(data, 50)
      expect(r.belowLine).toBe("\u25C6 85 t/s")
    })
  })

  // ── computeRequiredWidth ────────────────────────────────────

  describe("computeRequiredWidth", () => {
    test("all stats enabled estimates total width", () => {
      const o = new StatsOverlay()
      const w = o.computeRequiredWidth(data)
      // 8+8+8 + 3+1 = 28
      expect(w).toBe(28)
    })

    test("fewer stats reduces width", () => {
      const o = new StatsOverlay({ showAvg: false })
      const w = o.computeRequiredWidth(data)
      // 8+8 + 3+1 = 20
      expect(w).toBe(20)
    })

    test("custom unit affects width", () => {
      const o = new StatsOverlay()
      const w = o.computeRequiredWidth(data, "req/s")
      // 8+8+8 + 5+1 = 30
      expect(w).toBe(30)
    })

    test("no stats shows only unit width", () => {
      const o = new StatsOverlay({
        showCurrent: false,
        showPeak: false,
        showAvg: false,
      })
      const w = o.computeRequiredWidth(data)
      // 0 + 3+1 = 4
      expect(w).toBe(4)
    })
  })

  // ── Symbol rendering ────────────────────────────────────────

  test("symbol labels render correct Unicode characters", () => {
    const o = new StatsOverlay({ placement: "top_right", labelStyle: "symbol" })
    const r = o.render(data, 50)
    expect(r.topRightLabel).toContain("▲") // U+25B2
    expect(r.topRightLabel).toContain("◆") // U+25C6
    expect(r.topRightLabel).toContain("─") // U+2500
  })

  // ── Performance ─────────────────────────────────────────────

  test("render completes in < 10μs", () => {
    const o = new StatsOverlay()

    // Warm up
    for (let i = 0; i < 100; i++) {
      o.render(data, 50)
    }

    const iterations = 5000
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      o.render(data, 50)
    }
    const elapsed = performance.now() - start
    const avgMicroseconds = (elapsed / iterations) * 1000
    expect(avgMicroseconds).toBeLessThan(10)
  })
})

// ── composeGraphWithStats ───────────────────────────────────────

describe("composeGraphWithStats", () => {
  test("inline: truncates graph to make room for stats", () => {
    const sparkline = "▁▂▃▄▅▆▇█▁▂▃▄▅▆▇█"
    const overlay = {
      inlineSuffix: " 85 \u25B2120",
      statsWidth: 8,
      placement: "inline" as const,
    }
    // totalWidth=20, graphWidth=20-8-1=11
    const result = composeGraphWithStats(sparkline, overlay, 20)
    expect(result).toBe("▁▂▃▄▅▆▇█▁▂▃ 85 \u25B2120")
  })

  test("inline: short sparkline is not padded", () => {
    const sparkline = "▁▂▃"
    const overlay = {
      inlineSuffix: " 85",
      statsWidth: 3,
      placement: "inline" as const,
    }
    // graphWidth = 20-3-1=16, sparkline is 3 chars → no truncation
    const result = composeGraphWithStats(sparkline, overlay, 20)
    expect(result).toBe("▁▂▃ 85")
  })

  test("inline: stats are never truncated", () => {
    const sparkline = "▁▂▃▄▅▆▇█▁▂▃▄▅▆▇█"
    const suffix = " 85 \u25B2120"
    const overlay = {
      inlineSuffix: suffix,
      statsWidth: suffix.length,
      placement: "inline" as const,
    }
    const result = composeGraphWithStats(sparkline, overlay, 15)
    // Stats suffix is always fully present
    expect(result).toEndWith(suffix)
  })

  test("inline: zero graphWidth produces stats only", () => {
    const sparkline = "▁▂▃▄▅▆▇█"
    const suffix = " 85 \u25B2120"
    const overlay = {
      inlineSuffix: suffix,
      statsWidth: suffix.length,
      placement: "inline" as const,
    }
    // totalWidth small enough that graphWidth <= 0
    const result = composeGraphWithStats(sparkline, overlay, suffix.length)
    // graphWidth = suffix.length - suffix.length - 1 = -1 → max(0,-1)=0
    expect(result).toBe(suffix)
  })

  test("minimal: inserts space between graph and label", () => {
    const sparkline = "▁▂▃▄▅▆▇█"
    const overlay = {
      minimalLabel: "85",
      statsWidth: 2,
      placement: "minimal" as const,
    }
    // graphWidth = 12-2-1 = 9, sparkline is 8 → no truncation
    const result = composeGraphWithStats(sparkline, overlay, 12)
    expect(result).toBe("▁▂▃▄▅▆▇█ 85")
  })

  test("minimal: total length matches totalWidth", () => {
    const sparkline = "▁▂▃▄▅▆▇█▁▂▃▄▅▆▇█"
    const label = "1.5k"
    const overlay = {
      minimalLabel: label,
      statsWidth: label.length,
      placement: "minimal" as const,
    }
    const totalWidth = 20
    const result = composeGraphWithStats(sparkline, overlay, totalWidth)
    // graphWidth=20-4-1=15, truncated to 15 + " " + "1.5k" = 15+1+4=20
    expect(result.length).toBe(totalWidth)
  })

  test("top_right: returns sparkline unchanged", () => {
    const sparkline = "▁▂▃▄▅▆▇█"
    const overlay = {
      topRightLabel: "\u25B2120 \u25C685",
      statsWidth: 8,
      placement: "top_right" as const,
    }
    expect(composeGraphWithStats(sparkline, overlay, 30)).toBe(sparkline)
  })

  test("below: returns sparkline unchanged", () => {
    const sparkline = "▁▂▃▄▅▆▇█"
    const overlay = {
      belowLine: "\u25C6 85 t/s  \u25B2 120",
      statsWidth: 15,
      placement: "below" as const,
    }
    expect(composeGraphWithStats(sparkline, overlay, 30)).toBe(sparkline)
  })
})
