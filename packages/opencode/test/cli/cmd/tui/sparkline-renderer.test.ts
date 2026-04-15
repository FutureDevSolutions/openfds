import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  SparklineRenderer,
  sparklineRenderer,
} from "../../../../src/cli/cmd/tui/util/sparkline-renderer"

describe("SparklineRenderer", () => {
  // ── Environment-based mode detection ────────────────────────────

  describe("mode detection from environment", () => {
    let savedTerm: string | undefined
    let savedColorterm: string | undefined
    let savedLang: string | undefined

    beforeEach(() => {
      savedTerm = process.env.TERM
      savedColorterm = process.env.COLORTERM
      savedLang = process.env.LANG
    })

    afterEach(() => {
      if (savedTerm !== undefined) process.env.TERM = savedTerm
      else delete process.env.TERM
      if (savedColorterm !== undefined) process.env.COLORTERM = savedColorterm
      else delete process.env.COLORTERM
      if (savedLang !== undefined) process.env.LANG = savedLang
      else delete process.env.LANG
    })

    test("detects braille for xterm-256color with truecolor", () => {
      process.env.TERM = "xterm-256color"
      process.env.COLORTERM = "truecolor"
      process.env.LANG = "en_US.UTF-8"
      const r = new SparklineRenderer()
      expect(r.detectMode()).toBe("braille")
    })

    test("detects braille for kitty terminal", () => {
      process.env.TERM = "xterm-kitty"
      process.env.COLORTERM = ""
      process.env.LANG = "en_US.UTF-8"
      const r = new SparklineRenderer()
      expect(r.detectMode()).toBe("braille")
    })

    test("detects braille for alacritty terminal", () => {
      process.env.TERM = "alacritty"
      process.env.COLORTERM = ""
      process.env.LANG = "en_US.UTF-8"
      const r = new SparklineRenderer()
      expect(r.detectMode()).toBe("braille")
    })

    test("falls back to block for basic xterm with UTF-8", () => {
      process.env.TERM = "xterm"
      process.env.COLORTERM = ""
      process.env.LANG = "en_US.UTF-8"
      const r = new SparklineRenderer()
      expect(r.detectMode()).toBe("block")
    })

    test("falls back to ascii for dumb terminal", () => {
      process.env.TERM = "dumb"
      process.env.COLORTERM = ""
      process.env.LANG = "C"
      const r = new SparklineRenderer()
      expect(r.detectMode()).toBe("ascii")
    })

    test("24bit COLORTERM triggers braille with unicode LANG", () => {
      process.env.TERM = "screen"
      process.env.COLORTERM = "24bit"
      process.env.LANG = "en_US.UTF-8"
      const r = new SparklineRenderer()
      expect(r.detectMode()).toBe("braille")
    })
  })

  // ── Braille encoding ────────────────────────────────────────────

  test("braille: all-zero values produce blank braille characters", () => {
    const r = new SparklineRenderer()
    const result = r.render([0, 0, 0, 0], { width: 2, mode: "braille" })
    // 0x2800 = blank braille
    expect(result.lines[0]).toBe("\u2800\u2800")
  })

  test("braille: all-max values produce full braille characters", () => {
    const r = new SparklineRenderer()
    const result = r.render([1, 1, 1, 1], { width: 2, mode: "braille" })
    // 0x28FF = all 8 dots
    expect(result.lines[0]).toBe("\u28FF\u28FF")
  })

  test("braille: left column only", () => {
    const r = new SparklineRenderer()
    // width=1 → 2 data points, [1.0, 0.0]
    const result = r.render([1, 0], { width: 1, mode: "braille" })
    // Left column all on: dots 1,2,3,7 → 0x01|0x02|0x04|0x40 = 0x47
    expect(result.lines[0]).toBe(String.fromCharCode(0x2847))
  })

  test("braille: right column only", () => {
    const r = new SparklineRenderer()
    const result = r.render([0, 1], { width: 1, mode: "braille" })
    // Right column all on: dots 4,5,6,8 → 0x08|0x10|0x20|0x80 = 0xB8
    expect(result.lines[0]).toBe(String.fromCharCode(0x28B8))
  })

  test("braille: half-height values light bottom dots", () => {
    const r = new SparklineRenderer()
    // 0.5 * 4 = 2 dots from bottom
    const result = r.render([0.5, 0.5], { width: 1, mode: "braille" })
    // dots > level: dot0(level3)=F, dot1(level2)=F, dot2(level1)=T, dot3(level0)=T
    // Left: 0x04|0x40, Right: 0x20|0x80 → 0x04|0x20|0x40|0x80 = 0xE4
    expect(result.lines[0]).toBe(String.fromCharCode(0x28E4))
  })

  test("braille: 2x horizontal resolution vs block", () => {
    const r = new SparklineRenderer()
    const values = [0, 0.25, 0.5, 0.75, 1.0]

    const brailleResult = r.render(values, { width: 5, mode: "braille" })
    const blockResult = r.render(values, { width: 5, mode: "block" })

    expect(brailleResult.resolution.horizontal).toBe(10)
    expect(blockResult.resolution.horizontal).toBe(5)
    expect(brailleResult.resolution.horizontal).toBe(
      blockResult.resolution.horizontal * 2,
    )
  })

  test("braille: multi-row produces correct number of lines", () => {
    const r = new SparklineRenderer()
    const result = r.render([0.5, 1.0], { width: 1, height: 2, mode: "braille" })
    expect(result.lines.length).toBe(2)
    expect(result.resolution.vertical).toBe(8)
  })

  test("braille: multi-row top row empty for half values", () => {
    const r = new SparklineRenderer()
    // height=2, verticalLevels=8, v=0.5 → dots=4
    // row 0 (top): baseLevel=4, levels 7,6,5,4 → 4>7=F,4>6=F,4>5=F,4>4=F → blank
    // row 1 (bottom): baseLevel=0, levels 3,2,1,0 → 4>3=T,4>2=T,4>1=T,4>0=T → full
    const result = r.render([0.5, 0.5], {
      width: 1,
      height: 2,
      mode: "braille",
    })
    expect(result.lines[0]).toBe("\u2800") // top row blank
    expect(result.lines[1]).toBe("\u28FF") // bottom row full
  })

  // ── Block rendering ─────────────────────────────────────────────

  test("block: renders all 8 levels correctly", () => {
    const r = new SparklineRenderer()
    // Feed exact level boundary values: 0/8, 1/8, 2/8, ..., 8/8
    const values = [0, 1 / 8, 2 / 8, 3 / 8, 4 / 8, 5 / 8, 6 / 8, 7 / 8, 1]
    const result = r.render(values, { width: 9, mode: "block" })
    expect(result.lines[0]).toBe(" ▁▂▃▄▅▆▇█")
    expect(result.mode).toBe("block")
  })

  test("block: single line output", () => {
    const r = new SparklineRenderer()
    const result = r.render([0.5], { width: 1, mode: "block" })
    expect(result.lines.length).toBe(1)
  })

  test("block: resolution is width × 8", () => {
    const r = new SparklineRenderer()
    const result = r.render([0.5], { width: 10, mode: "block" })
    expect(result.resolution).toEqual({ horizontal: 10, vertical: 8 })
  })

  test("block: showBaseline replaces space with ▁", () => {
    const r = new SparklineRenderer()
    const result = r.render([0, 0, 0], {
      width: 3,
      mode: "block",
      showBaseline: true,
    })
    expect(result.lines[0]).toBe("▁▁▁")
  })

  test("block: showBaseline does not affect non-zero values", () => {
    const r = new SparklineRenderer()
    const result = r.render([0, 0.5, 1], {
      width: 3,
      mode: "block",
      showBaseline: true,
    })
    expect(result.lines[0]).toBe("▁▄█")
  })

  // ── ASCII rendering ─────────────────────────────────────────────

  test("ascii: renders all 8 levels correctly", () => {
    const r = new SparklineRenderer()
    const values = [0, 1 / 8, 2 / 8, 3 / 8, 4 / 8, 5 / 8, 6 / 8, 7 / 8, 1]
    const result = r.render(values, { width: 9, mode: "ascii" })
    expect(result.lines[0]).toBe(" _.-:=+#█")
    expect(result.mode).toBe("ascii")
  })

  test("ascii: showBaseline replaces space with underscore", () => {
    const r = new SparklineRenderer()
    const result = r.render([0, 0, 0], {
      width: 3,
      mode: "ascii",
      showBaseline: true,
    })
    expect(result.lines[0]).toBe("___")
  })

  test("ascii: resolution matches block mode", () => {
    const r = new SparklineRenderer()
    const result = r.render([0.5], { width: 10, mode: "ascii" })
    expect(result.resolution).toEqual({ horizontal: 10, vertical: 8 })
  })

  // ── Mode detection ──────────────────────────────────────────────

  test("detectMode caches result after first call", () => {
    const r = new SparklineRenderer()
    const mode1 = r.detectMode()
    const mode2 = r.detectMode()
    expect(mode1).toBe(mode2)
  })

  test("setMode overrides detection", () => {
    const r = new SparklineRenderer()
    r.setMode("ascii")
    expect(r.detectMode()).toBe("ascii")
  })

  test("resetDetection clears cached mode", () => {
    const r = new SparklineRenderer()
    r.setMode("ascii")
    expect(r.detectMode()).toBe("ascii")
    r.resetDetection()
    // After reset, detectMode re-evaluates from env
    const fresh = r.detectMode()
    expect(["braille", "block", "ascii"]).toContain(fresh)
  })

  test("render uses forced mode from config", () => {
    const r = new SparklineRenderer()
    r.setMode("braille")
    // Config mode overrides instance mode
    const result = r.render([0.5], { width: 1, mode: "block" })
    expect(result.mode).toBe("block")
  })

  test("render falls back to detected mode when config.mode is omitted", () => {
    const r = new SparklineRenderer()
    r.setMode("ascii")
    const result = r.render([0.5], { width: 1 })
    expect(result.mode).toBe("ascii")
  })

  // ── Resampling ──────────────────────────────────────────────────

  test("empty values array produces zeros without throwing", () => {
    const r = new SparklineRenderer()
    const result = r.render([], { width: 5, mode: "block" })
    expect(result.lines[0]).toBe("     ")
    expect(result.lines[0].length).toBe(5)
  })

  test("resampling upscales fewer values to fill width", () => {
    const r = new SparklineRenderer()
    // 2 values → 5 chars in block mode: interpolates [0, 0.25, 0.5, 0.75, 1]
    const result = r.render([0, 1], { width: 5, mode: "block" })
    // levels: 0→' ', 2→'▂', 4→'▄', 6→'▆', 8→'█'
    expect(result.lines[0]).toBe(" ▂▄▆█")
  })

  test("resampling downscales more values to fit width", () => {
    const r = new SparklineRenderer()
    // 10 values → 5 chars in block mode
    const values = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0]
    const result = r.render(values, { width: 5, mode: "block" })
    expect(result.lines[0].length).toBe(5)
  })

  test("single value resampled to fill width", () => {
    const r = new SparklineRenderer()
    const result = r.render([1], { width: 3, mode: "block" })
    expect(result.lines[0]).toBe("███")
  })

  test("exact-match values are not resampled", () => {
    const r = new SparklineRenderer()
    // 5 values for width=5 in block mode → no resampling
    const result = r.render([0, 0.25, 0.5, 0.75, 1], {
      width: 5,
      mode: "block",
    })
    expect(result.lines[0]).toBe(" ▂▄▆█")
  })

  // ── Edge cases ──────────────────────────────────────────────────

  test("width=1 renders single character", () => {
    const r = new SparklineRenderer()
    const block = r.render([1], { width: 1, mode: "block" })
    expect(block.lines[0].length).toBe(1)
    expect(block.lines[0]).toBe("█")

    const braille = r.render([1, 1], { width: 1, mode: "braille" })
    expect(braille.lines[0].length).toBe(1)
  })

  test("values clamped above 1.0 still render max character", () => {
    const r = new SparklineRenderer()
    // 1.5 * 8 = 12, Math.min(12, 8) = 8 → '█'
    const result = r.render([1.5], { width: 1, mode: "block" })
    expect(result.lines[0]).toBe("█")
  })

  test("render result includes correct mode", () => {
    const r = new SparklineRenderer()
    expect(r.render([0.5], { width: 1, mode: "braille" }).mode).toBe("braille")
    expect(r.render([0.5], { width: 1, mode: "block" }).mode).toBe("block")
    expect(r.render([0.5], { width: 1, mode: "ascii" }).mode).toBe("ascii")
  })

  // ── Singleton ───────────────────────────────────────────────────

  test("sparklineRenderer singleton is a SparklineRenderer", () => {
    expect(sparklineRenderer).toBeInstanceOf(SparklineRenderer)
  })

  // ── Performance ─────────────────────────────────────────────────

  test("render completes in < 100μs for 30 data points", () => {
    const r = new SparklineRenderer()
    r.setMode("braille")
    const values = Array.from({ length: 30 }, (_, i) => i / 29)

    // Warm up
    for (let i = 0; i < 100; i++) {
      r.render(values, { width: 15, mode: "braille" })
    }

    const iterations = 1000
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      r.render(values, { width: 15, mode: "braille" })
    }
    const elapsed = performance.now() - start
    const avgMicroseconds = (elapsed / iterations) * 1000

    // Should average well under 100μs per call
    expect(avgMicroseconds).toBeLessThan(100)
  })

  test("render performance for all three modes", () => {
    const r = new SparklineRenderer()
    const values = Array.from({ length: 30 }, (_, i) => i / 29)
    const modes = ["braille", "block", "ascii"] as const

    for (const mode of modes) {
      // Warm up
      for (let i = 0; i < 50; i++) {
        r.render(values, { width: 15, mode })
      }

      const iterations = 500
      const start = performance.now()
      for (let i = 0; i < iterations; i++) {
        r.render(values, { width: 15, mode })
      }
      const elapsed = performance.now() - start
      const avgMicroseconds = (elapsed / iterations) * 1000
      expect(avgMicroseconds).toBeLessThan(100)
    }
  })
})
