export type RenderMode = "braille" | "block" | "ascii"

export interface SparklineConfig {
  width: number
  height?: number
  mode?: RenderMode
  showBaseline?: boolean
}

export interface RenderResult {
  lines: string[]
  mode: RenderMode
  resolution: {
    horizontal: number
    vertical: number
  }
}

const BLOCK_CHARS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

const ASCII_CHARS = [" ", "_", ".", "-", ":", "=", "+", "#", "█"]

function encodeBraille(dots: boolean[][]): string {
  let code = 0x2800
  if (dots[0]?.[0]) code |= 0x01
  if (dots[1]?.[0]) code |= 0x02
  if (dots[2]?.[0]) code |= 0x04
  if (dots[0]?.[1]) code |= 0x08
  if (dots[1]?.[1]) code |= 0x10
  if (dots[2]?.[1]) code |= 0x20
  if (dots[3]?.[0]) code |= 0x40
  if (dots[3]?.[1]) code |= 0x80
  return String.fromCharCode(code)
}

export class SparklineRenderer {
  private detectedMode: RenderMode | null = null

  detectMode(): RenderMode {
    if (this.detectedMode !== null) {
      return this.detectedMode
    }

    const term = process.env.TERM ?? ""
    const colorterm = process.env.COLORTERM ?? ""
    const lang = process.env.LANG ?? ""

    const hasUnicode =
      lang.toLowerCase().includes("utf") ||
      term.includes("xterm") ||
      term.includes("screen") ||
      term.includes("tmux") ||
      term.includes("alacritty") ||
      term.includes("kitty") ||
      term.includes("iterm")

    const hasBraille =
      hasUnicode &&
      (colorterm === "truecolor" ||
        colorterm === "24bit" ||
        term.includes("256color") ||
        term.includes("kitty") ||
        term.includes("alacritty"))

    if (hasBraille) {
      this.detectedMode = "braille"
    } else if (hasUnicode) {
      this.detectedMode = "block"
    } else {
      this.detectedMode = "ascii"
    }

    return this.detectedMode
  }

  setMode(mode: RenderMode): void {
    this.detectedMode = mode
  }

  render(values: readonly number[], config: SparklineConfig): RenderResult {
    const mode = config.mode ?? this.detectMode()
    const width = config.width
    const height = config.height ?? 1

    const resampled = this.resample(
      values,
      mode === "braille" ? width * 2 : width,
    )

    switch (mode) {
      case "braille":
        return this.renderBraille(resampled, width, height)
      case "block":
        return this.renderBlock(resampled, width, config.showBaseline)
      case "ascii":
        return this.renderAscii(resampled, width, config.showBaseline)
    }
  }

  private resample(
    values: readonly number[],
    targetCount: number,
  ): number[] {
    if (values.length === 0) {
      return new Array(targetCount).fill(0)
    }
    if (values.length === targetCount) {
      return [...values]
    }

    const result = new Array(targetCount)
    const ratio = (values.length - 1) / (targetCount - 1 || 1)

    for (let i = 0; i < targetCount; i++) {
      const srcIdx = i * ratio
      const lo = Math.floor(srcIdx)
      const hi = Math.min(lo + 1, values.length - 1)
      const t = srcIdx - lo
      result[i] = values[lo] * (1 - t) + values[hi] * t
    }

    return result
  }

  private renderBraille(
    values: number[],
    width: number,
    height: number,
  ): RenderResult {
    const verticalLevels = height * 4
    const lines: string[] = new Array(height).fill("")

    for (let col = 0; col < width; col++) {
      const v1 = values[col * 2] ?? 0
      const v2 = values[col * 2 + 1] ?? 0

      const dots1 = Math.round(v1 * verticalLevels)
      const dots2 = Math.round(v2 * verticalLevels)

      for (let row = 0; row < height; row++) {
        const baseLevel = (height - 1 - row) * 4
        const grid: boolean[][] = [
          [false, false],
          [false, false],
          [false, false],
          [false, false],
        ]

        for (let dot = 0; dot < 4; dot++) {
          const level = baseLevel + (3 - dot)
          grid[dot][0] = dots1 > level
          grid[dot][1] = dots2 > level
        }

        lines[row] += encodeBraille(grid)
      }
    }

    return {
      lines,
      mode: "braille",
      resolution: {
        horizontal: width * 2,
        vertical: height * 4,
      },
    }
  }

  private renderBlock(
    values: number[],
    width: number,
    showBaseline?: boolean,
  ): RenderResult {
    let line = ""

    for (let i = 0; i < width; i++) {
      const v = values[i] ?? 0
      const level = Math.round(v * 8)
      const char = BLOCK_CHARS[Math.min(level, 8)]
      line += char === " " && showBaseline ? "▁" : char
    }

    return {
      lines: [line],
      mode: "block",
      resolution: {
        horizontal: width,
        vertical: 8,
      },
    }
  }

  private renderAscii(
    values: number[],
    width: number,
    showBaseline?: boolean,
  ): RenderResult {
    let line = ""

    for (let i = 0; i < width; i++) {
      const v = values[i] ?? 0
      const level = Math.round(v * 8)
      const char = ASCII_CHARS[Math.min(level, 8)]
      line += char === " " && showBaseline ? "_" : char
    }

    return {
      lines: [line],
      mode: "ascii",
      resolution: {
        horizontal: width,
        vertical: 8,
      },
    }
  }

  resetDetection(): void {
    this.detectedMode = null
  }
}

export const sparklineRenderer = new SparklineRenderer()
