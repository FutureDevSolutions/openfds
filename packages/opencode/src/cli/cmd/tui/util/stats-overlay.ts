export type OverlayPlacement = "top_right" | "inline" | "below" | "minimal"

export interface OverlayConfig {
  placement?: OverlayPlacement
  showCurrent?: boolean
  showPeak?: boolean
  showAvg?: boolean
  compactWidth?: number
  labelStyle?: "symbol" | "text" | "none"
}

export interface OverlayData {
  current: number
  peak: number
  avg: number
  unit?: string
}

export interface OverlayResult {
  topRightLabel?: string
  inlineSuffix?: string
  belowLine?: string
  minimalLabel?: string
  statsWidth: number
  placement: OverlayPlacement
}

export function formatWithSI(n: number): string {
  if (n < 0) return "-" + formatWithSI(-n)
  if (n < 1000) return n.toFixed(n < 10 ? 1 : 0)
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k"
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1) + "M"
  return (n / 1_000_000_000).toFixed(1) + "G"
}

const SYMBOLS = {
  current: "\u25C6",
  peak: "\u25B2",
  avg: "\u2500",
} as const

const LABELS = {
  current: "cur",
  peak: "max",
  avg: "avg",
} as const

export class StatsOverlay {
  private readonly config: Required<OverlayConfig>

  constructor(config?: OverlayConfig) {
    this.config = {
      placement: config?.placement ?? "inline",
      showCurrent: config?.showCurrent ?? true,
      showPeak: config?.showPeak ?? true,
      showAvg: config?.showAvg ?? true,
      compactWidth: config?.compactWidth ?? 30,
      labelStyle: config?.labelStyle ?? "symbol",
    }
  }

  render(data: OverlayData, availableWidth: number): OverlayResult {
    const placement = this.autoPlacement(availableWidth)
    const unit = data.unit ?? "t/s"
    const isCompact = availableWidth < this.config.compactWidth

    switch (placement) {
      case "top_right":
        return this.renderTopRight(data, unit, isCompact)
      case "inline":
        return this.renderInline(data, unit, isCompact)
      case "below":
        return this.renderBelow(data, unit, isCompact)
      case "minimal":
        return this.renderMinimal(data, unit)
    }
  }

  private autoPlacement(width: number): OverlayPlacement {
    if (this.config.placement !== "inline") {
      return this.config.placement
    }

    if (width < 20) return "minimal"
    if (width < 40) return "inline"
    return "inline"
  }

  private renderTopRight(
    data: OverlayData,
    unit: string,
    compact: boolean,
  ): OverlayResult {
    const parts: string[] = []

    if (this.config.showPeak) {
      parts.push(this.formatStat("peak", data.peak, compact))
    }
    if (this.config.showCurrent) {
      parts.push(this.formatStat("current", data.current, compact))
    }
    if (this.config.showAvg) {
      parts.push(this.formatStat("avg", data.avg, compact))
    }

    const label = parts.join(" ") + (compact ? "" : ` ${unit}`)

    return {
      topRightLabel: label,
      statsWidth: label.length,
      placement: "top_right",
    }
  }

  private renderInline(
    data: OverlayData,
    unit: string,
    compact: boolean,
  ): OverlayResult {
    if (compact) {
      const suffix = ` ${formatWithSI(data.current)}`
      return {
        inlineSuffix: suffix,
        statsWidth: suffix.length,
        placement: "inline",
      }
    }

    const current = formatWithSI(data.current)
    const peak = formatWithSI(data.peak)
    const suffix = ` ${current} \u25B2${peak}`

    return {
      inlineSuffix: suffix,
      statsWidth: suffix.length,
      placement: "inline",
    }
  }

  private renderBelow(
    data: OverlayData,
    unit: string,
    compact: boolean,
  ): OverlayResult {
    const parts: string[] = []

    if (this.config.showCurrent) {
      parts.push(`\u25C6 ${formatWithSI(data.current)} ${unit}`)
    }
    if (this.config.showPeak) {
      parts.push(`\u25B2 ${formatWithSI(data.peak)}`)
    }
    if (this.config.showAvg) {
      parts.push(`\u2500 ${formatWithSI(data.avg)}`)
    }

    const line = parts.join(compact ? " " : "  ")

    return {
      belowLine: line,
      statsWidth: line.length,
      placement: "below",
    }
  }

  private renderMinimal(data: OverlayData, _unit: string): OverlayResult {
    const label = formatWithSI(data.current)

    return {
      minimalLabel: label,
      statsWidth: label.length,
      placement: "minimal",
    }
  }

  private formatStat(
    type: "current" | "peak" | "avg",
    value: number,
    compact: boolean,
  ): string {
    const formatted = formatWithSI(value)

    switch (this.config.labelStyle) {
      case "symbol":
        return `${SYMBOLS[type]}${formatted}`
      case "text":
        return compact
          ? `${LABELS[type]}:${formatted}`
          : `${LABELS[type]}: ${formatted}`
      case "none":
        return formatted
    }
  }

  computeRequiredWidth(data: OverlayData, unit: string = "t/s"): number {
    let width = 0
    if (this.config.showCurrent) width += 8
    if (this.config.showPeak) width += 8
    if (this.config.showAvg) width += 8
    width += unit.length + 1
    return width
  }
}

export function composeGraphWithStats(
  sparkline: string,
  overlay: OverlayResult,
  totalWidth: number,
): string {
  const graphWidth = totalWidth - overlay.statsWidth - 1

  switch (overlay.placement) {
    case "inline": {
      const truncated = sparkline.slice(0, Math.max(0, graphWidth))
      return truncated + (overlay.inlineSuffix ?? "")
    }

    case "minimal": {
      const minTrunc = sparkline.slice(0, Math.max(0, graphWidth))
      return minTrunc + " " + (overlay.minimalLabel ?? "")
    }

    default:
      return sparkline
  }
}
