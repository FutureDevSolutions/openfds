# Performance Graph Implementation Playbook

## Master Implementation Guide for openfds TUI Real-Time Performance Monitor

This document contains **production-grade, copy-paste implementation prompts** for building the Tokens/Sec performance graph. Each prompt is self-contained, sequential, and instructs a coding agent to build specific components with senior-engineer quality standards.

---

## Table of Contents

1. [Prompt 1: Data Backbone — Thread-Safe Circular Buffer](#prompt-1-data-backbone--thread-safe-circular-buffer)
2. [Prompt 2: High-Resolution Rendering — Braille & Block Sparklines](#prompt-2-high-resolution-rendering--braille--block-sparklines)
3. [Prompt 3: Adaptive Scaling — Dynamic Y-Axis Engine](#prompt-3-adaptive-scaling--dynamic-y-axis-engine)
4. [Prompt 4: Statistics Overlay — Max/Avg Integration](#prompt-4-statistics-overlay--maxavg-integration)
5. [Prompt 5: Session Integration — Layout Wiring](#prompt-5-session-integration--layout-wiring)
6. [Prompt 6: Stream Handler — Delta Event Pipeline](#prompt-6-stream-handler--delta-event-pipeline)
7. [Prompt 7: Verification Suite — Tests & Mock Validation](#prompt-7-verification-suite--tests--mock-validation)

---

## Quality Guardrails (Apply to ALL Prompts)

Every implementation MUST satisfy these constraints:

### Performance Budget
- **CPU Ceiling**: Graph rendering MUST consume < 1% of total CPU cycles
- **Measurement**: Use `performance.now()` guards around render loops
- **Violation Response**: If render exceeds 0.5ms per frame, emit warning and degrade to low-fidelity mode

### Idempotency Requirements
- **Reset Contract**: `monitor.reset()` MUST return state to exact initial conditions
- **Clear Semantics**: Clearing between agent tasks zeroes all buffers without memory reallocation
- **State Isolation**: Each session gets independent monitor instance; no shared mutable state

### Terminal Compatibility
- **Detection**: Probe `$TERM`, `$COLORTERM`, and attempt Braille render test on init
- **Fallback Chain**: Braille → Block Characters → ASCII (`#-_`)
- **Graceful Degradation**: Never crash on unsupported terminal; always produce readable output

---

## Prompt 1: Data Backbone — Thread-Safe Circular Buffer

### Objective
Implement a **zero-allocation, lock-free circular buffer** for storing 30 seconds of token throughput samples.

### Target File
```
packages/opencode/src/cli/cmd/tui/util/token-monitor.ts
```

### Implementation Specification

```typescript
/**
 * PROMPT: Implement TokenMonitor with the following exact specification.
 * 
 * ARCHITECTURE CONSTRAINTS:
 * 1. Pre-allocate fixed Float64Array(30) — NO dynamic arrays, NO push/shift
 * 2. Use write pointer arithmetic: writeIdx = (writeIdx + 1) % WINDOW_SIZE
 * 3. Track sample count separately for partial-window edge cases
 * 4. All numeric operations use integer math where possible
 * 
 * THREAD-SAFETY MODEL:
 * - Single-writer (interval tick), multiple-reader (UI render)
 * - Use atomic-style patterns: write new value, THEN increment pointer
 * - Readers see consistent snapshot even mid-write
 * 
 * MEMORY CONSTRAINTS:
 * - Total heap footprint < 1KB including all metadata
 * - Zero allocations after construction (no closures capturing arrays)
 * - Buffer reuse on reset — never reallocate
 */

export interface TokenMonitorConfig {
  windowSec?: number      // Default: 30
  tickIntervalMs?: number // Default: 1000
}

export interface MonitorSnapshot {
  current: number         // Most recent sample
  peak: number           // Max in window
  avg: number            // Mean of filled slots
  history: readonly number[] // Immutable view of buffer (oldest→newest)
  sampleCount: number    // Total samples ever recorded
  windowFilled: boolean  // True when buffer has cycled at least once
}

export class TokenMonitor {
  // Pre-allocated buffer — NEVER reallocate
  private readonly buffer: Float64Array
  private readonly windowSize: number
  
  // Atomic-safe pointers
  private writeIdx: number = 0
  private filled: boolean = false
  private totalSamples: number = 0
  
  // Accumulator for high-frequency pushes between ticks
  private pendingTokens: number = 0
  
  // Cached peak for O(1) access (recompute on eviction)
  private cachedPeak: number = 0
  private peakIdx: number = -1
  
  constructor(config?: TokenMonitorConfig) {
    this.windowSize = config?.windowSec ?? 30
    this.buffer = new Float64Array(this.windowSize)
  }

  /**
   * Accumulate tokens from stream delta.
   * Called at HIGH FREQUENCY (per delta event).
   * MUST be O(1) with zero allocations.
   */
  push(tokenCount: number): void {
    this.pendingTokens += tokenCount
  }

  /**
   * Flush accumulated tokens as single sample.
   * Called at LOW FREQUENCY (once per second).
   * Handles circular write and peak cache invalidation.
   */
  tick(): void {
    const sample = this.pendingTokens
    this.pendingTokens = 0
    
    // Check if we're evicting the current peak
    const evictedIdx = this.writeIdx
    if (this.filled && evictedIdx === this.peakIdx) {
      // Must recompute peak after write
      this.peakIdx = -1
    }
    
    // Atomic-style write: value first, then pointer
    this.buffer[this.writeIdx] = sample
    this.writeIdx = (this.writeIdx + 1) % this.windowSize
    this.totalSamples++
    
    if (this.writeIdx === 0) {
      this.filled = true
    }
    
    // Update peak cache
    if (sample >= this.cachedPeak) {
      this.cachedPeak = sample
      this.peakIdx = evictedIdx
    } else if (this.peakIdx === -1) {
      // Recompute peak (evicted old peak)
      this.recomputePeak()
    }
  }

  /**
   * O(n) peak recomputation — only called when peak evicted.
   * Amortized O(1) over window lifetime.
   */
  private recomputePeak(): void {
    let max = 0
    let maxIdx = 0
    const count = this.filled ? this.windowSize : this.writeIdx
    for (let i = 0; i < count; i++) {
      if (this.buffer[i] > max) {
        max = this.buffer[i]
        maxIdx = i
      }
    }
    this.cachedPeak = max
    this.peakIdx = maxIdx
  }

  /**
   * Get immutable snapshot for UI render.
   * Returns history ordered oldest→newest.
   */
  snapshot(): MonitorSnapshot {
    const count = this.filled ? this.windowSize : this.writeIdx
    
    // Build ordered history without allocation (reuse pattern)
    const history: number[] = new Array(count)
    for (let i = 0; i < count; i++) {
      const idx = this.filled 
        ? (this.writeIdx + i) % this.windowSize 
        : i
      history[i] = this.buffer[idx]
    }
    
    // Compute average
    let sum = 0
    for (let i = 0; i < count; i++) {
      sum += history[i]
    }
    const avg = count > 0 ? sum / count : 0
    
    return {
      current: count > 0 ? history[count - 1] : 0,
      peak: this.cachedPeak,
      avg: Math.round(avg * 10) / 10, // 1 decimal precision
      history: Object.freeze(history),
      sampleCount: this.totalSamples,
      windowFilled: this.filled
    }
  }

  /**
   * Reset to initial state — ZERO allocations.
   * Reuses existing buffer.
   */
  reset(): void {
    this.buffer.fill(0)
    this.writeIdx = 0
    this.filled = false
    this.totalSamples = 0
    this.pendingTokens = 0
    this.cachedPeak = 0
    this.peakIdx = -1
  }
  
  /**
   * Check if monitor has any data.
   */
  isEmpty(): boolean {
    return this.totalSamples === 0
  }
}
```

### Acceptance Criteria
- [ ] `push()` executes in < 50 nanoseconds (benchmark with 10M iterations)
- [ ] `tick()` executes in < 1 microsecond for normal case
- [ ] `snapshot()` allocates exactly one array per call (for history)
- [ ] After 100+ ticks, buffer memory remains constant
- [ ] `reset()` returns `isEmpty() === true` and `snapshot().sampleCount === 0`

### Test Command
```bash
cd /Users/smusmanzia/Documents/FDS/openfds/packages/opencode
bun test --timeout 30000 test/cli/cmd/tui/token-monitor.test.ts
```

---

## Prompt 2: High-Resolution Rendering — Braille & Block Sparklines

### Objective
Implement a **dual-mode sparkline renderer** that uses Braille patterns for high-resolution terminals and falls back to block characters for compatibility.

### Target File
```
packages/opencode/src/cli/cmd/tui/util/sparkline-renderer.ts
```

### Implementation Specification

```typescript
/**
 * PROMPT: Implement SparklineRenderer with exact rendering fidelity.
 * 
 * BRAILLE RENDERING (HIGH-FIDELITY MODE):
 * - Each Braille cell is 2 columns × 4 rows of dots
 * - Unicode range: U+2800 to U+28FF (256 patterns)
 * - Effective resolution: 2× horizontal, 4× vertical vs block chars
 * - Pattern: dots numbered 1-8, value = sum of 2^(dot-1) + 0x2800
 *   ┌───┐
 *   │1 4│  dot1=0x01, dot4=0x08
 *   │2 5│  dot2=0x02, dot5=0x10
 *   │3 6│  dot3=0x04, dot6=0x20
 *   │7 8│  dot7=0x40, dot8=0x80
 *   └───┘
 * 
 * BLOCK RENDERING (FALLBACK MODE):
 * - Characters: ▁▂▃▄▅▆▇█ (U+2581 to U+2588)
 * - 8 vertical levels per character
 * - Fallback: space for 0, █ for max
 * 
 * ASCII RENDERING (MINIMAL MODE):
 * - Characters: _.-:=+#█
 * - 8 levels using ASCII-safe characters
 * 
 * TERMINAL DETECTION:
 * - Check $TERM for 'xterm-256color', 'screen-256color', 'tmux-256color'
 * - Check $COLORTERM for 'truecolor', '24bit'
 * - Attempt to render test Braille char and verify cursor advance
 * - Cache detection result for session lifetime
 */

export type RenderMode = 'braille' | 'block' | 'ascii'

export interface SparklineConfig {
  width: number              // Character width of output
  height?: number            // For multi-row Braille (default: 1)
  mode?: RenderMode          // Force mode (default: auto-detect)
  showBaseline?: boolean     // Render baseline for empty values
}

export interface RenderResult {
  lines: string[]            // Rendered lines (bottom to top for multi-row)
  mode: RenderMode           // Actual mode used
  resolution: {              // Effective data points displayed
    horizontal: number
    vertical: number
  }
}

// Block character lookup (8 levels)
const BLOCK_CHARS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// ASCII fallback (8 levels)
const ASCII_CHARS = [' ', '_', '.', '-', ':', '=', '+', '#', '█']

/**
 * Braille dot pattern encoder.
 * Encodes a 2×4 boolean grid into single Unicode Braille character.
 */
function encodeBraille(dots: boolean[][]): string {
  // dots[row][col] where row 0-3, col 0-1
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
  
  /**
   * Detect optimal render mode for current terminal.
   * Result is cached after first call.
   */
  detectMode(): RenderMode {
    if (this.detectedMode !== null) {
      return this.detectedMode
    }
    
    // Check environment variables
    const term = process.env.TERM ?? ''
    const colorterm = process.env.COLORTERM ?? ''
    const lang = process.env.LANG ?? ''
    
    // Modern terminals with Unicode support
    const hasUnicode = 
      lang.toLowerCase().includes('utf') ||
      term.includes('xterm') ||
      term.includes('screen') ||
      term.includes('tmux') ||
      term.includes('alacritty') ||
      term.includes('kitty') ||
      term.includes('iterm')
    
    // Braille support heuristic
    const hasBraille = hasUnicode && (
      colorterm === 'truecolor' ||
      colorterm === '24bit' ||
      term.includes('256color') ||
      term.includes('kitty') ||
      term.includes('alacritty')
    )
    
    if (hasBraille) {
      this.detectedMode = 'braille'
    } else if (hasUnicode) {
      this.detectedMode = 'block'
    } else {
      this.detectedMode = 'ascii'
    }
    
    return this.detectedMode
  }
  
  /**
   * Force a specific render mode (for testing or user preference).
   */
  setMode(mode: RenderMode): void {
    this.detectedMode = mode
  }
  
  /**
   * Render normalized values (0-1 range) as sparkline.
   * 
   * @param values - Array of values normalized to 0-1 range
   * @param config - Rendering configuration
   * @returns Rendered sparkline with metadata
   * 
   * PERFORMANCE: Must complete in < 100μs for 30 values
   */
  render(values: readonly number[], config: SparklineConfig): RenderResult {
    const mode = config.mode ?? this.detectMode()
    const width = config.width
    const height = config.height ?? 1
    
    // Resample values to fit width
    const resampled = this.resample(values, 
      mode === 'braille' ? width * 2 : width
    )
    
    switch (mode) {
      case 'braille':
        return this.renderBraille(resampled, width, height)
      case 'block':
        return this.renderBlock(resampled, width, config.showBaseline)
      case 'ascii':
        return this.renderAscii(resampled, width, config.showBaseline)
    }
  }
  
  /**
   * Resample values to target count using linear interpolation.
   */
  private resample(values: readonly number[], targetCount: number): number[] {
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
  
  /**
   * High-resolution Braille rendering.
   * Each character encodes 2 horizontal × 4 vertical data points.
   */
  private renderBraille(
    values: number[], 
    width: number, 
    height: number
  ): RenderResult {
    const verticalLevels = height * 4
    const lines: string[] = new Array(height).fill('')
    
    // Process pairs of values for each Braille character
    for (let col = 0; col < width; col++) {
      const v1 = values[col * 2] ?? 0
      const v2 = values[col * 2 + 1] ?? 0
      
      // Convert to dot counts (0 to verticalLevels)
      const dots1 = Math.round(v1 * verticalLevels)
      const dots2 = Math.round(v2 * verticalLevels)
      
      // Build dot grid for each row of Braille characters
      for (let row = 0; row < height; row++) {
        const baseLevel = (height - 1 - row) * 4
        const grid: boolean[][] = [
          [false, false],
          [false, false],
          [false, false],
          [false, false]
        ]
        
        // Fill dots from bottom up
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
      mode: 'braille',
      resolution: {
        horizontal: width * 2,
        vertical: height * 4
      }
    }
  }
  
  /**
   * Block character rendering (8 vertical levels).
   */
  private renderBlock(
    values: number[], 
    width: number,
    showBaseline?: boolean
  ): RenderResult {
    let line = ''
    
    for (let i = 0; i < width; i++) {
      const v = values[i] ?? 0
      const level = Math.round(v * 8)
      const char = BLOCK_CHARS[Math.min(level, 8)]
      line += (char === ' ' && showBaseline) ? '▁' : char
    }
    
    return {
      lines: [line],
      mode: 'block',
      resolution: {
        horizontal: width,
        vertical: 8
      }
    }
  }
  
  /**
   * ASCII-safe rendering (8 levels).
   */
  private renderAscii(
    values: number[], 
    width: number,
    showBaseline?: boolean
  ): RenderResult {
    let line = ''
    
    for (let i = 0; i < width; i++) {
      const v = values[i] ?? 0
      const level = Math.round(v * 8)
      const char = ASCII_CHARS[Math.min(level, 8)]
      line += (char === ' ' && showBaseline) ? '_' : char
    }
    
    return {
      lines: [line],
      mode: 'ascii',
      resolution: {
        horizontal: width,
        vertical: 8
      }
    }
  }
  
  /**
   * Clear cached mode detection (for testing).
   */
  resetDetection(): void {
    this.detectedMode = null
  }
}

// Singleton instance for shared use
export const sparklineRenderer = new SparklineRenderer()
```

### Acceptance Criteria
- [ ] Braille mode produces 2× horizontal resolution vs block mode
- [ ] Block mode renders all 8 levels correctly (▁ through █)
- [ ] ASCII fallback works on `TERM=dumb` terminals
- [ ] Mode detection caches result (single detection per session)
- [ ] `render()` completes in < 100μs for 30 data points
- [ ] Resampling handles empty arrays without throwing

### Test Command
```bash
cd /Users/smusmanzia/Documents/FDS/openfds/packages/opencode
bun test --timeout 30000 test/cli/cmd/tui/sparkline-renderer.test.ts
```

---

## Prompt 3: Adaptive Scaling — Dynamic Y-Axis Engine

### Objective
Implement **intelligent Y-axis scaling** that adapts to data patterns while maintaining visual stability and readability.

### Target File
```
packages/opencode/src/cli/cmd/tui/util/graph-scaler.ts
```

### Implementation Specification

```typescript
/**
 * PROMPT: Implement GraphScaler with professional-grade scaling behavior.
 * 
 * SCALING PHILOSOPHY:
 * 1. NEVER let the graph appear flat when there's variance in data
 * 2. NEVER let the graph appear chaotic due to over-sensitive scaling
 * 3. SMOOTHLY transition scale changes to avoid jarring visual jumps
 * 4. PRESERVE visibility of both peaks and valleys
 * 
 * SCALE STRATEGIES:
 * - PEAK_30S: Scale to max value in 30-second window (default)
 * - PEAK_PADDED: Scale to 120% of peak for headroom
 * - ROLLING_AVERAGE: Scale to 2× rolling average (smooths spikes)
 * - FIXED: User-specified fixed scale
 * - HYBRID: Blend of peak and average for stability
 * 
 * HYSTERESIS (Anti-Jitter):
 * - Don't rescale unless new peak differs by > 15% from current
 * - Implement exponential smoothing on scale factor changes
 * - Allow immediate scale-up (see new peak), delayed scale-down
 */

export type ScaleStrategy = 'peak_30s' | 'peak_padded' | 'rolling_avg' | 'fixed' | 'hybrid'

export interface ScalerConfig {
  strategy?: ScaleStrategy     // Default: 'peak_30s'
  fixedMax?: number           // For 'fixed' strategy
  hysteresisThreshold?: number // Default: 0.15 (15%)
  smoothingFactor?: number    // Default: 0.3 (exponential smoothing alpha)
  scaleDownDelay?: number     // Default: 5 (seconds before scale-down)
  minScale?: number           // Default: 1 (prevent divide-by-zero)
  headroomFactor?: number     // Default: 1.2 (for peak_padded)
}

export interface ScaleResult {
  yMax: number                 // Current Y-axis maximum
  normalized: readonly number[] // Values scaled to 0-1 range
  scaleChanged: boolean        // True if yMax changed this tick
  utilizationPct: number       // How much of scale is used (peak/yMax)
}

export class GraphScaler {
  private readonly config: Required<ScalerConfig>
  
  // State for hysteresis and smoothing
  private currentScale: number = 1
  private targetScale: number = 1
  private lastPeak: number = 0
  private ticksSinceNewPeak: number = 0
  
  constructor(config?: ScalerConfig) {
    this.config = {
      strategy: config?.strategy ?? 'peak_30s',
      fixedMax: config?.fixedMax ?? 100,
      hysteresisThreshold: config?.hysteresisThreshold ?? 0.15,
      smoothingFactor: config?.smoothingFactor ?? 0.3,
      scaleDownDelay: config?.scaleDownDelay ?? 5,
      minScale: config?.minScale ?? 1,
      headroomFactor: config?.headroomFactor ?? 1.2
    }
  }
  
  /**
   * Compute scaled values with adaptive Y-axis.
   * 
   * @param values - Raw throughput values (tokens/sec)
   * @param peak - Current window peak (from monitor)
   * @param avg - Current window average (from monitor)
   * @returns Normalized values and scale metadata
   * 
   * PERFORMANCE: Must complete in < 50μs for 30 values
   */
  scale(
    values: readonly number[], 
    peak: number, 
    avg: number
  ): ScaleResult {
    // Compute target scale based on strategy
    const rawTarget = this.computeTargetScale(values, peak, avg)
    
    // Apply hysteresis to prevent jitter
    const { newTarget, changed } = this.applyHysteresis(rawTarget, peak)
    this.targetScale = newTarget
    
    // Smooth transition to new scale
    this.currentScale = this.smoothScale(this.currentScale, this.targetScale)
    
    // Ensure minimum scale
    const yMax = Math.max(this.currentScale, this.config.minScale)
    
    // Normalize values
    const normalized = values.map(v => 
      Math.min(1, Math.max(0, v / yMax))
    )
    
    return {
      yMax,
      normalized: Object.freeze(normalized),
      scaleChanged: changed,
      utilizationPct: peak > 0 ? Math.round((peak / yMax) * 100) : 0
    }
  }
  
  /**
   * Compute raw target scale based on strategy.
   */
  private computeTargetScale(
    values: readonly number[], 
    peak: number, 
    avg: number
  ): number {
    switch (this.config.strategy) {
      case 'peak_30s':
        return peak || this.config.minScale
        
      case 'peak_padded':
        return (peak || this.config.minScale) * this.config.headroomFactor
        
      case 'rolling_avg':
        // 2× average gives headroom for spikes
        return Math.max(avg * 2, this.config.minScale)
        
      case 'fixed':
        return this.config.fixedMax
        
      case 'hybrid':
        // Blend: 70% peak, 30% average×2
        const peakComponent = peak * 0.7
        const avgComponent = avg * 2 * 0.3
        return Math.max(peakComponent + avgComponent, this.config.minScale)
        
      default:
        return peak || this.config.minScale
    }
  }
  
  /**
   * Apply hysteresis to prevent scale jitter.
   * - Immediate scale-up when new peak exceeds threshold
   * - Delayed scale-down after sustained lower values
   */
  private applyHysteresis(
    rawTarget: number, 
    currentPeak: number
  ): { newTarget: number; changed: boolean } {
    const threshold = this.config.hysteresisThreshold
    const currentScale = this.currentScale
    
    // Check if we have a new significant peak
    if (currentPeak > this.lastPeak * (1 + threshold)) {
      // New peak detected — immediate scale-up
      this.lastPeak = currentPeak
      this.ticksSinceNewPeak = 0
      return { newTarget: rawTarget, changed: true }
    }
    
    // Check if peak dropped significantly
    if (currentPeak < this.lastPeak * (1 - threshold)) {
      this.ticksSinceNewPeak++
      
      // Only scale down after delay
      if (this.ticksSinceNewPeak >= this.config.scaleDownDelay) {
        this.lastPeak = currentPeak
        this.ticksSinceNewPeak = 0
        return { newTarget: rawTarget, changed: true }
      }
      
      // Keep current scale during delay
      return { newTarget: currentScale, changed: false }
    }
    
    // Within hysteresis band — no change
    this.ticksSinceNewPeak = 0
    return { newTarget: currentScale, changed: false }
  }
  
  /**
   * Exponential smoothing for scale transitions.
   * Prevents jarring visual jumps when scale changes.
   */
  private smoothScale(current: number, target: number): number {
    const alpha = this.config.smoothingFactor
    // EMA: new = alpha * target + (1 - alpha) * current
    return alpha * target + (1 - alpha) * current
  }
  
  /**
   * Reset scaler state (for new session/task).
   */
  reset(): void {
    this.currentScale = this.config.minScale
    this.targetScale = this.config.minScale
    this.lastPeak = 0
    this.ticksSinceNewPeak = 0
  }
  
  /**
   * Get current Y-axis maximum without processing.
   */
  getCurrentMax(): number {
    return Math.max(this.currentScale, this.config.minScale)
  }
  
  /**
   * Force immediate scale update (bypass hysteresis).
   * Use sparingly — for explicit user rescale requests.
   */
  forceScale(yMax: number): void {
    this.currentScale = yMax
    this.targetScale = yMax
    this.lastPeak = yMax
    this.ticksSinceNewPeak = 0
  }
}
```

### Acceptance Criteria
- [ ] Graph remains readable for values ranging from 1 to 10,000 t/s
- [ ] Scale-up is immediate when new peak detected (< 1 tick latency)
- [ ] Scale-down waits 5 seconds to confirm trend (anti-jitter)
- [ ] Hysteresis prevents rescaling for < 15% variance
- [ ] Smooth transitions: scale never jumps more than 30% per tick
- [ ] Hybrid mode balances spikes vs. average visibility
- [ ] `reset()` returns scaler to initial state

### Test Command
```bash
cd /Users/smusmanzia/Documents/FDS/openfds/packages/opencode
bun test --timeout 30000 test/cli/cmd/tui/graph-scaler.test.ts
```

---

## Prompt 4: Statistics Overlay — Max/Avg Integration

### Objective
Implement **non-occluding statistics overlays** that display Max/Avg values without obscuring the trend line.

### Target File
```
packages/opencode/src/cli/cmd/tui/util/stats-overlay.ts
```

### Implementation Specification

```typescript
/**
 * PROMPT: Implement StatsOverlay with professional visual integration.
 * 
 * OVERLAY PHILOSOPHY:
 * 1. Statistics INFORM the graph, they don't REPLACE it
 * 2. Numbers must be readable without covering data
 * 3. Visual hierarchy: graph primary, stats secondary
 * 4. Compact mode for narrow terminals
 * 
 * PLACEMENT STRATEGIES:
 * - TOP_RIGHT: Stats in upper-right corner (default for wide terminals)
 * - INLINE: Stats as right-aligned suffix after sparkline
 * - BELOW: Stats on dedicated line below graph
 * - MINIMAL: Current value only, others on hover/request
 * 
 * FORMATTING:
 * - Use SI prefixes for large numbers (1.2k, 3.5M)
 * - Fixed decimal precision for consistency
 * - Visual indicators: ▲ for peak, ◆ for current, ─ for avg
 */

export type OverlayPlacement = 'top_right' | 'inline' | 'below' | 'minimal'

export interface OverlayConfig {
  placement?: OverlayPlacement  // Default: auto-select based on width
  showCurrent?: boolean         // Default: true
  showPeak?: boolean           // Default: true
  showAvg?: boolean            // Default: true
  compactWidth?: number        // Below this, use compact mode (default: 30)
  labelStyle?: 'symbol' | 'text' | 'none'  // Default: 'symbol'
}

export interface OverlayData {
  current: number
  peak: number
  avg: number
  unit?: string  // Default: 't/s'
}

export interface OverlayResult {
  // For 'top_right' placement
  topRightLabel?: string
  
  // For 'inline' placement
  inlineSuffix?: string
  
  // For 'below' placement
  belowLine?: string
  
  // For 'minimal' placement
  minimalLabel?: string
  
  // Computed layout info
  statsWidth: number
  placement: OverlayPlacement
}

// SI prefix formatting
function formatWithSI(n: number): string {
  if (n < 0) return '-' + formatWithSI(-n)
  if (n < 1000) return n.toFixed(n < 10 ? 1 : 0)
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k'
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  return (n / 1_000_000_000).toFixed(1) + 'G'
}

// Symbol labels
const SYMBOLS = {
  current: '◆',
  peak: '▲',
  avg: '─'
} as const

// Text labels
const LABELS = {
  current: 'cur',
  peak: 'max',
  avg: 'avg'
} as const

export class StatsOverlay {
  private readonly config: Required<OverlayConfig>
  
  constructor(config?: OverlayConfig) {
    this.config = {
      placement: config?.placement ?? 'inline',
      showCurrent: config?.showCurrent ?? true,
      showPeak: config?.showPeak ?? true,
      showAvg: config?.showAvg ?? true,
      compactWidth: config?.compactWidth ?? 30,
      labelStyle: config?.labelStyle ?? 'symbol'
    }
  }
  
  /**
   * Generate overlay content for given statistics.
   * 
   * @param data - Statistics to display
   * @param availableWidth - Total character width available
   * @returns Overlay content and layout info
   * 
   * PERFORMANCE: Must complete in < 10μs
   */
  render(data: OverlayData, availableWidth: number): OverlayResult {
    const placement = this.autoPlacement(availableWidth)
    const unit = data.unit ?? 't/s'
    const isCompact = availableWidth < this.config.compactWidth
    
    switch (placement) {
      case 'top_right':
        return this.renderTopRight(data, unit, isCompact)
      case 'inline':
        return this.renderInline(data, unit, isCompact)
      case 'below':
        return this.renderBelow(data, unit, isCompact)
      case 'minimal':
        return this.renderMinimal(data, unit)
    }
  }
  
  /**
   * Auto-select placement based on available width.
   */
  private autoPlacement(width: number): OverlayPlacement {
    if (this.config.placement !== 'inline') {
      return this.config.placement
    }
    
    // Auto-select based on width
    if (width < 20) return 'minimal'
    if (width < 40) return 'inline'
    return 'inline'  // Default to inline for consistency
  }
  
  /**
   * Render stats in top-right corner format.
   * Example: "▲120 ◆85 ─62 t/s"
   */
  private renderTopRight(
    data: OverlayData, 
    unit: string, 
    compact: boolean
  ): OverlayResult {
    const parts: string[] = []
    
    if (this.config.showPeak) {
      parts.push(this.formatStat('peak', data.peak, compact))
    }
    if (this.config.showCurrent) {
      parts.push(this.formatStat('current', data.current, compact))
    }
    if (this.config.showAvg) {
      parts.push(this.formatStat('avg', data.avg, compact))
    }
    
    const label = parts.join(' ') + (compact ? '' : ` ${unit}`)
    
    return {
      topRightLabel: label,
      statsWidth: label.length,
      placement: 'top_right'
    }
  }
  
  /**
   * Render stats as inline suffix.
   * Example: " [85 ▲120]"
   */
  private renderInline(
    data: OverlayData, 
    unit: string, 
    compact: boolean
  ): OverlayResult {
    if (compact) {
      // Ultra-compact: just current value
      const suffix = ` ${formatWithSI(data.current)}`
      return {
        inlineSuffix: suffix,
        statsWidth: suffix.length,
        placement: 'inline'
      }
    }
    
    // Standard: current + peak
    const current = formatWithSI(data.current)
    const peak = formatWithSI(data.peak)
    const suffix = ` ${current} ${SYMBOLS.peak}${peak}`
    
    return {
      inlineSuffix: suffix,
      statsWidth: suffix.length,
      placement: 'inline'
    }
  }
  
  /**
   * Render stats on dedicated line below graph.
   * Example: "◆ 85 t/s  ▲ 120 (max)  ─ 62 (avg)"
   */
  private renderBelow(
    data: OverlayData, 
    unit: string, 
    compact: boolean
  ): OverlayResult {
    const parts: string[] = []
    
    if (this.config.showCurrent) {
      parts.push(`${SYMBOLS.current} ${formatWithSI(data.current)} ${unit}`)
    }
    if (this.config.showPeak) {
      parts.push(`${SYMBOLS.peak} ${formatWithSI(data.peak)}`)
    }
    if (this.config.showAvg) {
      parts.push(`${SYMBOLS.avg} ${formatWithSI(data.avg)}`)
    }
    
    const line = parts.join(compact ? ' ' : '  ')
    
    return {
      belowLine: line,
      statsWidth: line.length,
      placement: 'below'
    }
  }
  
  /**
   * Render minimal (current only).
   * Example: "85"
   */
  private renderMinimal(data: OverlayData, unit: string): OverlayResult {
    const label = formatWithSI(data.current)
    
    return {
      minimalLabel: label,
      statsWidth: label.length,
      placement: 'minimal'
    }
  }
  
  /**
   * Format individual statistic with label.
   */
  private formatStat(
    type: 'current' | 'peak' | 'avg', 
    value: number, 
    compact: boolean
  ): string {
    const formatted = formatWithSI(value)
    
    switch (this.config.labelStyle) {
      case 'symbol':
        return `${SYMBOLS[type]}${formatted}`
      case 'text':
        return compact ? `${LABELS[type]}:${formatted}` : `${LABELS[type]}: ${formatted}`
      case 'none':
        return formatted
    }
  }
  
  /**
   * Compute required width for full stats display.
   */
  computeRequiredWidth(data: OverlayData, unit: string = 't/s'): number {
    // Estimate: each stat ~8 chars, unit ~4 chars, separators ~3 chars
    let width = 0
    if (this.config.showCurrent) width += 8
    if (this.config.showPeak) width += 8
    if (this.config.showAvg) width += 8
    width += unit.length + 1
    return width
  }
}

/**
 * Compose sparkline with overlay.
 * Handles non-occlusion by reserving space for stats.
 */
export function composeGraphWithStats(
  sparkline: string,
  overlay: OverlayResult,
  totalWidth: number
): string {
  const graphWidth = totalWidth - overlay.statsWidth - 1
  
  switch (overlay.placement) {
    case 'inline':
      // Truncate sparkline to make room for suffix
      const truncated = sparkline.slice(0, Math.max(0, graphWidth))
      return truncated + (overlay.inlineSuffix ?? '')
      
    case 'minimal':
      const minTrunc = sparkline.slice(0, Math.max(0, graphWidth))
      return minTrunc + ' ' + (overlay.minimalLabel ?? '')
      
    default:
      return sparkline
  }
}
```

### Acceptance Criteria
- [ ] Stats never visually overlap with graph data points
- [ ] SI prefix formatting handles 0 to 10B+ range correctly
- [ ] Compact mode activates below 30 character width
- [ ] Symbol labels (▲◆─) render on Unicode terminals
- [ ] `computeRequiredWidth()` accurately predicts space needs
- [ ] `composeGraphWithStats()` truncates graph, not stats

### Test Command
```bash
cd /Users/smusmanzia/Documents/FDS/openfds/packages/opencode
bun test --timeout 30000 test/cli/cmd/tui/stats-overlay.test.ts
```

---

## Prompt 5: Session Integration — Layout Wiring

### Objective
Integrate the performance monitor into the **session layout** with proper column management and responsive behavior.

### Target Files
```
packages/opencode/src/cli/cmd/tui/routes/session/performance.tsx (NEW)
packages/opencode/src/cli/cmd/tui/routes/session/index.tsx (MODIFY)
```

### Implementation Specification

#### Part A: Performance Panel Component

```tsx
/**
 * PROMPT: Create PerformancePanel component with exact integration spec.
 * 
 * FILE: packages/opencode/src/cli/cmd/tui/routes/session/performance.tsx
 * 
 * COMPONENT REQUIREMENTS:
 * 1. Self-contained panel with title bar
 * 2. Reactive updates at 1Hz (not faster)
 * 3. Graceful hide/show based on terminal width
 * 4. Zero impact on existing session functionality
 * 
 * SOLID.JS PATTERNS:
 * - Use createSignal for reactive state
 * - Use createEffect for side effects (timer)
 * - Use onCleanup for interval cleanup
 * - Minimize signal updates to 1/second
 */

import { createSignal, createEffect, onCleanup, Show } from 'solid-js'
import { Box, Text } from '@opentui/solid'
import { TokenMonitor, MonitorSnapshot } from '../../util/token-monitor'
import { SparklineRenderer } from '../../util/sparkline-renderer'
import { GraphScaler } from '../../util/graph-scaler'
import { StatsOverlay, composeGraphWithStats } from '../../util/stats-overlay'

export interface PerformancePanelProps {
  monitor: TokenMonitor
  width: number
  height?: number
  visible?: boolean
}

export function PerformancePanel(props: PerformancePanelProps) {
  // Reactive state — updates once per second via tick
  const [snapshot, setSnapshot] = createSignal<MonitorSnapshot | null>(null)
  
  // Rendering utilities (singletons)
  const renderer = new SparklineRenderer()
  const scaler = new GraphScaler({ strategy: 'peak_30s' })
  const overlay = new StatsOverlay({ placement: 'inline' })
  
  // 1-second tick interval
  createEffect(() => {
    const interval = setInterval(() => {
      props.monitor.tick()
      setSnapshot(props.monitor.snapshot())
    }, 1000)
    
    onCleanup(() => clearInterval(interval))
  })
  
  // Compute derived values
  const graphContent = () => {
    const snap = snapshot()
    if (!snap || snap.sampleCount === 0) {
      return { graph: '─'.repeat(props.width - 4), stats: '-- t/s' }
    }
    
    // Scale values
    const scaled = scaler.scale(snap.history, snap.peak, snap.avg)
    
    // Render sparkline
    const graphWidth = Math.max(8, props.width - 12) // Reserve space for stats
    const sparkResult = renderer.render(scaled.normalized, { width: graphWidth })
    
    // Generate overlay
    const overlayResult = overlay.render(
      { current: snap.current, peak: snap.peak, avg: snap.avg },
      props.width - 2  // Account for borders
    )
    
    // Compose
    const composed = composeGraphWithStats(
      sparkResult.lines[0],
      overlayResult,
      props.width - 2
    )
    
    return {
      graph: composed,
      stats: `${snap.current} t/s`
    }
  }
  
  return (
    <Show when={props.visible !== false}>
      <Box 
        flexDirection="column" 
        borderStyle="round" 
        width={props.width}
        height={props.height ?? 5}
        paddingX={1}
      >
        {/* Title */}
        <Text bold color="cyan">Performance</Text>
        
        {/* Sparkline Graph */}
        <Box>
          <Text>{graphContent().graph}</Text>
        </Box>
        
        {/* Current Rate */}
        <Box justifyContent="flex-end">
          <Text dimColor>
            {snapshot()?.windowFilled ? '30s' : `${snapshot()?.sampleCount ?? 0}s`}
          </Text>
        </Box>
      </Box>
    </Show>
  )
}

/**
 * Hook to create and manage monitor instance.
 * Returns monitor for external push() calls.
 */
export function createPerformanceMonitor() {
  const monitor = new TokenMonitor({ windowSec: 30 })
  
  return {
    monitor,
    push: (tokens: number) => monitor.push(tokens),
    reset: () => monitor.reset()
  }
}
```

#### Part B: Session Layout Integration

```tsx
/**
 * PROMPT: Modify session/index.tsx with exact integration pattern.
 * 
 * FILE: packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
 * 
 * CHANGES REQUIRED:
 * 1. Add performance monitor state
 * 2. Wire delta events to monitor.push()
 * 3. Add performance column to layout
 * 4. Implement width-based visibility
 * 
 * LAYOUT MATH:
 * - metricsWidth = clamp(Math.round(totalWidth * 0.18), 24, 36)
 * - Hide metrics when totalWidth < 120
 * - Main content gets remaining space
 * - Existing sidebar width (42) unchanged
 */

// ADD TO IMPORTS:
import { PerformancePanel, createPerformanceMonitor } from './performance'
import { Token } from '../../../../util/token'

// ADD INSIDE COMPONENT:

// Performance monitoring state
const perf = createPerformanceMonitor()
let pendingTokens = 0

// Stream handler — push token deltas
createEffect(() => {
  const handler = (evt: MessagePartDeltaEvent) => {
    // Filter to current session
    if (evt.properties.sessionID !== route.sessionID) return
    
    // Get part info
    const part = sync.data.part.get(`${evt.properties.messageID}:${evt.properties.partID}`)
    if (!part) return
    
    // Only count assistant text/reasoning
    if (part.type !== 'text' && part.type !== 'reasoning') return
    
    const message = sync.data.message.get(evt.properties.messageID)
    if (!message || message.role !== 'assistant') return
    
    // Accumulate tokens
    pendingTokens += Token.estimate(evt.properties.delta)
  }
  
  event.on('message.part.delta', handler)
  onCleanup(() => event.off('message.part.delta', handler))
})

// Flush pending tokens to monitor every second
createEffect(() => {
  const interval = setInterval(() => {
    if (pendingTokens > 0) {
      perf.push(pendingTokens)
      pendingTokens = 0
    }
  }, 1000)
  
  onCleanup(() => clearInterval(interval))
})

// Compute panel visibility and width
const metricsLayout = () => {
  const total = useTerminalWidth() // Assume this exists
  const minWidth = 120
  const visible = total >= minWidth
  const width = visible 
    ? Math.min(36, Math.max(24, Math.round(total * 0.18)))
    : 0
  return { visible, width }
}

// MODIFY LAYOUT JSX:
// Change from:
//   <Box flexDirection="row">
//     <MainContent flexGrow={1} />
//     <Sidebar width={42} />
//   </Box>
// To:
//   <Box flexDirection="row">
//     <MainContent flexGrow={1} />
//     <Show when={metricsLayout().visible}>
//       <PerformancePanel 
//         monitor={perf.monitor}
//         width={metricsLayout().width}
//       />
//     </Show>
//     <Sidebar width={42} />
//   </Box>
```

### Acceptance Criteria
- [ ] Performance panel renders in dedicated column
- [ ] Panel width responds to terminal resize (18% of total, 24-36 range)
- [ ] Panel hides completely when terminal < 120 columns
- [ ] Graph updates exactly once per second (not more)
- [ ] Existing sidebar and prompt behavior unchanged
- [ ] Token deltas correctly filtered by session/role/type
- [ ] No memory leaks (intervals cleaned up on unmount)

### Test Commands
```bash
cd /Users/smusmanzia/Documents/FDS/openfds/packages/opencode
bun typecheck
bun test --timeout 30000 test/cli/cmd/tui/performance.test.ts
```

---

## Prompt 6: Stream Handler — Delta Event Pipeline

### Objective
Implement **precise token counting** from the message stream with correct filtering and accumulation.

### Target File
```
packages/opencode/src/cli/cmd/tui/util/token-stream-handler.ts
```

### Implementation Specification

```typescript
/**
 * PROMPT: Implement TokenStreamHandler with exact filtering semantics.
 * 
 * FILTERING REQUIREMENTS:
 * 1. Only count assistant-generated content (role === 'assistant')
 * 2. Only count text and reasoning parts (type === 'text' | 'reasoning')
 * 3. Only count deltas for the CURRENT session (match route.sessionID)
 * 4. Ignore tool calls, system messages, user echoes
 * 
 * ACCUMULATION MODEL:
 * - High-frequency: push() called per delta event
 * - Low-frequency: tick() called once per second
 * - Between ticks, tokens accumulate in pending buffer
 * - On tick, pending flushed to circular buffer as single sample
 * 
 * ERROR HANDLING:
 * - Invalid delta strings: skip with warning, don't throw
 * - Missing part/message: skip silently (race condition normal)
 * - Invalid sessionID: skip (different session)
 */

import { Token } from '../../../../util/token'
import { TokenMonitor } from './token-monitor'

export interface DeltaEvent {
  sessionID: string
  messageID: string
  partID: string
  delta: string
}

export interface PartInfo {
  type: string
}

export interface MessageInfo {
  role: string
}

export interface DataStore {
  part: { get(key: string): PartInfo | undefined }
  message: { get(id: string): MessageInfo | undefined }
}

export interface StreamHandlerConfig {
  sessionID: string
  monitor: TokenMonitor
  dataStore: DataStore
  onError?: (error: Error, event: DeltaEvent) => void
}

export class TokenStreamHandler {
  private readonly config: StreamHandlerConfig
  private pendingTokens: number = 0
  private tickInterval: ReturnType<typeof setInterval> | null = null
  private isActive: boolean = false
  
  // Statistics for debugging
  private stats = {
    eventsReceived: 0,
    eventsFiltered: 0,
    tokensAccumulated: 0,
    ticksProcessed: 0
  }
  
  constructor(config: StreamHandlerConfig) {
    this.config = config
  }
  
  /**
   * Start the handler — begins tick interval.
   */
  start(): void {
    if (this.isActive) return
    
    this.isActive = true
    this.tickInterval = setInterval(() => this.tick(), 1000)
  }
  
  /**
   * Stop the handler — clears interval, flushes pending.
   */
  stop(): void {
    if (!this.isActive) return
    
    this.isActive = false
    if (this.tickInterval) {
      clearInterval(this.tickInterval)
      this.tickInterval = null
    }
    
    // Final flush
    if (this.pendingTokens > 0) {
      this.config.monitor.push(this.pendingTokens)
      this.config.monitor.tick()
      this.pendingTokens = 0
    }
  }
  
  /**
   * Handle incoming delta event.
   * Called at HIGH FREQUENCY — must be O(1).
   * 
   * @returns true if event was counted, false if filtered
   */
  handleDelta(event: DeltaEvent): boolean {
    this.stats.eventsReceived++
    
    // Filter 1: Session match
    if (event.sessionID !== this.config.sessionID) {
      this.stats.eventsFiltered++
      return false
    }
    
    // Filter 2: Part type
    const partKey = `${event.messageID}:${event.partID}`
    const part = this.config.dataStore.part.get(partKey)
    if (!part || (part.type !== 'text' && part.type !== 'reasoning')) {
      this.stats.eventsFiltered++
      return false
    }
    
    // Filter 3: Message role
    const message = this.config.dataStore.message.get(event.messageID)
    if (!message || message.role !== 'assistant') {
      this.stats.eventsFiltered++
      return false
    }
    
    // Validate delta
    if (typeof event.delta !== 'string') {
      this.config.onError?.(
        new Error(`Invalid delta type: ${typeof event.delta}`),
        event
      )
      return false
    }
    
    // Estimate and accumulate tokens
    try {
      const tokens = Token.estimate(event.delta)
      this.pendingTokens += tokens
      this.stats.tokensAccumulated += tokens
      return true
    } catch (err) {
      this.config.onError?.(err as Error, event)
      return false
    }
  }
  
  /**
   * Flush pending tokens to monitor.
   * Called at LOW FREQUENCY (1Hz) by interval.
   */
  private tick(): void {
    this.stats.ticksProcessed++
    
    // Push accumulated sample
    this.config.monitor.push(this.pendingTokens)
    this.config.monitor.tick()
    this.pendingTokens = 0
  }
  
  /**
   * Reset handler state (for new task).
   */
  reset(): void {
    this.pendingTokens = 0
    this.config.monitor.reset()
    this.stats = {
      eventsReceived: 0,
      eventsFiltered: 0,
      tokensAccumulated: 0,
      ticksProcessed: 0
    }
  }
  
  /**
   * Get debug statistics.
   */
  getStats(): typeof this.stats {
    return { ...this.stats }
  }
  
  /**
   * Check if handler is running.
   */
  isRunning(): boolean {
    return this.isActive
  }
}

/**
 * Factory function for creating handler with event wiring.
 * Returns cleanup function.
 */
export function createStreamHandler(
  config: Omit<StreamHandlerConfig, 'dataStore'>,
  dataStore: DataStore,
  eventBus: {
    on(event: string, handler: (evt: DeltaEvent) => void): void
    off(event: string, handler: (evt: DeltaEvent) => void): void
  }
): { handler: TokenStreamHandler; cleanup: () => void } {
  const handler = new TokenStreamHandler({ ...config, dataStore })
  
  const deltaHandler = (evt: DeltaEvent) => handler.handleDelta(evt)
  
  // Wire up events
  eventBus.on('message.part.delta', deltaHandler)
  handler.start()
  
  const cleanup = () => {
    eventBus.off('message.part.delta', deltaHandler)
    handler.stop()
  }
  
  return { handler, cleanup }
}
```

### Acceptance Criteria
- [ ] `handleDelta()` executes in < 1μs for filtered events
- [ ] Session filtering rejects non-matching sessionIDs
- [ ] Part type filtering only accepts 'text' and 'reasoning'
- [ ] Role filtering only accepts 'assistant' messages
- [ ] Pending tokens correctly accumulate between ticks
- [ ] `stop()` flushes remaining pending tokens
- [ ] `reset()` clears both pending and monitor state
- [ ] Statistics accurately track filter/accept ratios

### Test Command
```bash
cd /Users/smusmanzia/Documents/FDS/openfds/packages/opencode
bun test --timeout 30000 test/cli/cmd/tui/token-stream-handler.test.ts
```

---

## Prompt 7: Verification Suite — Tests & Mock Validation

### Objective
Implement **comprehensive test coverage** and a mock injection system for visual validation.

### Target Files
```
packages/opencode/test/cli/cmd/tui/token-monitor.test.ts (NEW)
packages/opencode/test/cli/cmd/tui/sparkline-renderer.test.ts (NEW)
packages/opencode/test/cli/cmd/tui/graph-scaler.test.ts (NEW)
packages/opencode/src/cli/cmd/tui/util/mock-stream.ts (NEW - dev only)
```

### Implementation Specification

#### Part A: TokenMonitor Tests

```typescript
/**
 * PROMPT: Create comprehensive test suite for TokenMonitor.
 * 
 * FILE: packages/opencode/test/cli/cmd/tui/token-monitor.test.ts
 * 
 * TEST CATEGORIES:
 * 1. Circular buffer mechanics
 * 2. Push/tick accumulation
 * 3. Peak tracking and cache invalidation
 * 4. Snapshot generation
 * 5. Reset behavior
 * 6. Edge cases (empty, overflow, precision)
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { TokenMonitor } from '../../../../src/cli/cmd/tui/util/token-monitor'

describe('TokenMonitor', () => {
  let monitor: TokenMonitor
  
  beforeEach(() => {
    monitor = new TokenMonitor({ windowSec: 5 }) // Smaller window for faster tests
  })
  
  describe('circular buffer', () => {
    it('should maintain fixed window size after rollover', () => {
      // Push 10 samples into 5-slot buffer
      for (let i = 0; i < 10; i++) {
        monitor.push(i * 10)
        monitor.tick()
      }
      
      const snap = monitor.snapshot()
      expect(snap.history.length).toBe(5)
      // Should contain last 5 values: 50, 60, 70, 80, 90
      expect(snap.history).toEqual([50, 60, 70, 80, 90])
    })
    
    it('should report windowFilled correctly', () => {
      expect(monitor.snapshot().windowFilled).toBe(false)
      
      for (let i = 0; i < 4; i++) {
        monitor.push(10)
        monitor.tick()
      }
      expect(monitor.snapshot().windowFilled).toBe(false)
      
      monitor.push(10)
      monitor.tick()
      expect(monitor.snapshot().windowFilled).toBe(true)
    })
  })
  
  describe('push/tick accumulation', () => {
    it('should accumulate multiple pushes into single tick sample', () => {
      monitor.push(10)
      monitor.push(20)
      monitor.push(30)
      monitor.tick()
      
      expect(monitor.snapshot().current).toBe(60)
    })
    
    it('should reset pending on tick', () => {
      monitor.push(100)
      monitor.tick()
      monitor.tick() // Empty tick
      
      const snap = monitor.snapshot()
      expect(snap.current).toBe(0) // Most recent is empty tick
      expect(snap.history).toEqual([100, 0])
    })
  })
  
  describe('peak tracking', () => {
    it('should track peak across window', () => {
      monitor.push(10)
      monitor.tick()
      monitor.push(50) // Peak
      monitor.tick()
      monitor.push(20)
      monitor.tick()
      
      expect(monitor.snapshot().peak).toBe(50)
    })
    
    it('should update peak when old peak evicted', () => {
      // Fill buffer with peak at start
      monitor.push(100) // Will be evicted first
      monitor.tick()
      
      for (let i = 0; i < 4; i++) {
        monitor.push(20)
        monitor.tick()
      }
      
      // Peak should still be 100
      expect(monitor.snapshot().peak).toBe(100)
      
      // One more tick evicts the 100
      monitor.push(30)
      monitor.tick()
      
      // New peak should be 30
      expect(monitor.snapshot().peak).toBe(30)
    })
  })
  
  describe('average calculation', () => {
    it('should calculate correct average', () => {
      // Push 10, 20, 30
      monitor.push(10)
      monitor.tick()
      monitor.push(20)
      monitor.tick()
      monitor.push(30)
      monitor.tick()
      
      // Average = (10 + 20 + 30) / 3 = 20
      expect(monitor.snapshot().avg).toBe(20)
    })
    
    it('should handle partial window average', () => {
      monitor.push(100)
      monitor.tick()
      
      expect(monitor.snapshot().avg).toBe(100)
    })
  })
  
  describe('reset', () => {
    it('should restore initial state', () => {
      // Accumulate state
      for (let i = 0; i < 10; i++) {
        monitor.push(i * 10)
        monitor.tick()
      }
      
      monitor.reset()
      
      expect(monitor.isEmpty()).toBe(true)
      expect(monitor.snapshot().sampleCount).toBe(0)
      expect(monitor.snapshot().windowFilled).toBe(false)
      expect(monitor.snapshot().peak).toBe(0)
    })
  })
  
  describe('edge cases', () => {
    it('should handle zero pushes', () => {
      monitor.tick()
      monitor.tick()
      monitor.tick()
      
      const snap = monitor.snapshot()
      expect(snap.history).toEqual([0, 0, 0])
      expect(snap.avg).toBe(0)
      expect(snap.peak).toBe(0)
    })
    
    it('should handle very large values', () => {
      monitor.push(Number.MAX_SAFE_INTEGER)
      monitor.tick()
      
      expect(monitor.snapshot().current).toBe(Number.MAX_SAFE_INTEGER)
    })
  })
})
```

#### Part B: SparklineRenderer Tests

```typescript
/**
 * PROMPT: Create test suite for SparklineRenderer.
 * 
 * FILE: packages/opencode/test/cli/cmd/tui/sparkline-renderer.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { SparklineRenderer } from '../../../../src/cli/cmd/tui/util/sparkline-renderer'

describe('SparklineRenderer', () => {
  let renderer: SparklineRenderer
  const originalEnv = { ...process.env }
  
  beforeEach(() => {
    renderer = new SparklineRenderer()
    renderer.resetDetection()
  })
  
  afterEach(() => {
    process.env = { ...originalEnv }
  })
  
  describe('mode detection', () => {
    it('should detect braille for modern terminals', () => {
      process.env.TERM = 'xterm-256color'
      process.env.COLORTERM = 'truecolor'
      process.env.LANG = 'en_US.UTF-8'
      
      expect(renderer.detectMode()).toBe('braille')
    })
    
    it('should fallback to block for basic unicode', () => {
      process.env.TERM = 'xterm'
      process.env.COLORTERM = ''
      process.env.LANG = 'en_US.UTF-8'
      
      expect(renderer.detectMode()).toBe('block')
    })
    
    it('should fallback to ascii for dumb terminals', () => {
      process.env.TERM = 'dumb'
      process.env.COLORTERM = ''
      process.env.LANG = 'C'
      
      expect(renderer.detectMode()).toBe('ascii')
    })
  })
  
  describe('block rendering', () => {
    beforeEach(() => {
      renderer.setMode('block')
    })
    
    it('should render 8 distinct levels', () => {
      const values = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]
      const result = renderer.render(values, { width: 9 })
      
      expect(result.lines[0]).toBe(' ▁▂▃▄▅▆▇█')
    })
    
    it('should handle empty values', () => {
      const result = renderer.render([], { width: 5 })
      
      expect(result.lines[0]).toBe('     ')
    })
  })
  
  describe('resampling', () => {
    beforeEach(() => {
      renderer.setMode('block')
    })
    
    it('should downsample correctly', () => {
      // 10 values into 5 chars
      const values = [0, 0.2, 0.4, 0.6, 0.8, 1, 0.8, 0.6, 0.4, 0.2]
      const result = renderer.render(values, { width: 5 })
      
      expect(result.lines[0].length).toBe(5)
    })
    
    it('should upsample correctly', () => {
      // 3 values into 6 chars
      const values = [0, 0.5, 1]
      const result = renderer.render(values, { width: 6 })
      
      expect(result.lines[0].length).toBe(6)
    })
  })
  
  describe('performance', () => {
    it('should render 30 values in under 100μs', () => {
      renderer.setMode('block')
      const values = new Array(30).fill(0).map(() => Math.random())
      
      const start = performance.now()
      for (let i = 0; i < 100; i++) {
        renderer.render(values, { width: 30 })
      }
      const elapsed = performance.now() - start
      
      expect(elapsed / 100).toBeLessThan(0.1) // < 100μs per render
    })
  })
})
```

#### Part C: Mock Stream Generator

```typescript
/**
 * PROMPT: Create mock stream for visual validation.
 * 
 * FILE: packages/opencode/src/cli/cmd/tui/util/mock-stream.ts
 * 
 * PURPOSE:
 * - Generate known waveforms for visual testing
 * - Verify graph behavior over 30+ second windows
 * - Test autoscaling with various patterns
 */

export type WaveformType = 
  | 'sine'           // Smooth sine wave
  | 'sawtooth'       // Linear ramp up, instant drop
  | 'square'         // Alternating high/low
  | 'burst'          // Periodic spikes
  | 'ramp_up'        // Steady increase
  | 'ramp_down'      // Steady decrease
  | 'random'         // Random values
  | 'constant'       // Flat line

export interface MockStreamConfig {
  waveform: WaveformType
  minValue: number        // Minimum tokens/sec
  maxValue: number        // Maximum tokens/sec
  periodSec?: number      // For periodic waveforms (default: 10)
  burstProbability?: number // For 'burst' type (default: 0.1)
}

export class MockStream {
  private readonly config: MockStreamConfig
  private startTime: number = 0
  private isRunning: boolean = false
  private emitCallback: ((tokens: number) => void) | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  
  constructor(config: MockStreamConfig) {
    this.config = {
      periodSec: 10,
      burstProbability: 0.1,
      ...config
    }
  }
  
  /**
   * Start emitting mock token values.
   * @param callback - Called with token count each "second"
   * @param intervalMs - Emission interval (default: 1000ms, use lower for fast testing)
   */
  start(callback: (tokens: number) => void, intervalMs: number = 1000): void {
    if (this.isRunning) return
    
    this.isRunning = true
    this.startTime = Date.now()
    this.emitCallback = callback
    
    this.interval = setInterval(() => {
      const elapsed = (Date.now() - this.startTime) / 1000
      const value = this.computeValue(elapsed)
      this.emitCallback?.(Math.round(value))
    }, intervalMs)
  }
  
  /**
   * Stop emission.
   */
  stop(): void {
    if (!this.isRunning) return
    
    this.isRunning = false
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }
  
  /**
   * Compute value for given elapsed time.
   */
  private computeValue(elapsed: number): number {
    const { minValue, maxValue, periodSec, burstProbability } = this.config
    const range = maxValue - minValue
    const phase = (elapsed % periodSec!) / periodSec!
    
    switch (this.config.waveform) {
      case 'sine':
        // Smooth sine wave
        const sine = (Math.sin(phase * 2 * Math.PI) + 1) / 2
        return minValue + range * sine
        
      case 'sawtooth':
        // Linear ramp up
        return minValue + range * phase
        
      case 'square':
        // Alternating high/low
        return phase < 0.5 ? maxValue : minValue
        
      case 'burst':
        // Random spikes
        if (Math.random() < burstProbability!) {
          return maxValue
        }
        return minValue + Math.random() * range * 0.2
        
      case 'ramp_up':
        // Steady increase over period, then hold
        const rampUp = Math.min(1, elapsed / periodSec!)
        return minValue + range * rampUp
        
      case 'ramp_down':
        // Steady decrease
        const rampDown = Math.max(0, 1 - elapsed / periodSec!)
        return minValue + range * rampDown
        
      case 'random':
        return minValue + Math.random() * range
        
      case 'constant':
        return (minValue + maxValue) / 2
        
      default:
        return minValue
    }
  }
  
  /**
   * Generate array of values for testing (no timing).
   */
  generateSamples(count: number): number[] {
    const samples: number[] = []
    for (let i = 0; i < count; i++) {
      samples.push(Math.round(this.computeValue(i)))
    }
    return samples
  }
}

/**
 * Visual validation helper — run in dev mode.
 * 
 * Usage:
 *   import { runVisualValidation } from './mock-stream'
 *   runVisualValidation('sine', 40)
 */
export async function runVisualValidation(
  waveform: WaveformType, 
  durationSec: number
): Promise<void> {
  const { TokenMonitor } = await import('./token-monitor')
  const { SparklineRenderer } = await import('./sparkline-renderer')
  const { GraphScaler } = await import('./graph-scaler')
  
  const monitor = new TokenMonitor({ windowSec: 30 })
  const renderer = new SparklineRenderer()
  const scaler = new GraphScaler({ strategy: 'peak_30s' })
  
  const mock = new MockStream({
    waveform,
    minValue: 10,
    maxValue: 150
  })
  
  console.log(`\n📊 Visual Validation: ${waveform} wave (${durationSec}s)\n`)
  
  let tick = 0
  mock.start((tokens) => {
    monitor.push(tokens)
    monitor.tick()
    tick++
    
    const snap = monitor.snapshot()
    const scaled = scaler.scale(snap.history, snap.peak, snap.avg)
    const result = renderer.render(scaled.normalized, { width: 40 })
    
    // Clear line and print
    process.stdout.write(`\r[${tick.toString().padStart(3)}s] ${result.lines[0]} | cur:${snap.current.toString().padStart(3)} peak:${snap.peak.toString().padStart(3)} avg:${snap.avg.toFixed(0).padStart(3)}`)
    
    if (tick >= durationSec) {
      mock.stop()
      console.log('\n\n✅ Validation complete')
      process.exit(0)
    }
  }, 100) // 10x speed for quick visual check
}
```

### Acceptance Criteria
- [ ] All TokenMonitor tests pass with 100% coverage
- [ ] SparklineRenderer tests verify all 3 render modes
- [ ] Mock stream produces predictable waveforms
- [ ] Performance tests validate < 1ms per render cycle
- [ ] Visual validation produces recognizable sine/sawtooth patterns
- [ ] Tests complete in < 5 seconds total

### Test Command
```bash
cd /Users/smusmanzia/Documents/FDS/openfds/packages/opencode

# Run all graph-related tests
bun test --timeout 30000 \
  test/cli/cmd/tui/token-monitor.test.ts \
  test/cli/cmd/tui/sparkline-renderer.test.ts \
  test/cli/cmd/tui/graph-scaler.test.ts \
  test/cli/cmd/tui/stats-overlay.test.ts \
  test/cli/cmd/tui/token-stream-handler.test.ts

# Visual validation (dev only)
bun run --watch src/cli/cmd/tui/util/mock-stream.ts -- sine 40
```

---

## Execution Checklist

### Phase 1: Core Engine (Prompts 1-4)
- [ ] Implement TokenMonitor (Prompt 1)
- [ ] Implement SparklineRenderer (Prompt 2)
- [ ] Implement GraphScaler (Prompt 3)
- [ ] Implement StatsOverlay (Prompt 4)
- [ ] Run unit tests for each module
- [ ] Verify < 1ms total render time

### Phase 2: Integration (Prompts 5-6)
- [ ] Create PerformancePanel component (Prompt 5A)
- [ ] Modify session layout (Prompt 5B)
- [ ] Implement TokenStreamHandler (Prompt 6)
- [ ] Wire delta events to monitor
- [ ] Verify 1Hz update rate

### Phase 3: Validation (Prompt 7)
- [ ] Create comprehensive test suite
- [ ] Create mock stream generator
- [ ] Run visual validation with known waveforms
- [ ] Verify 30-second window behavior
- [ ] Confirm no regressions in existing TUI

### Quality Gates
- [ ] `bun typecheck` passes
- [ ] All new tests pass
- [ ] Existing tests unaffected
- [ ] Manual visual inspection matches expected patterns
- [ ] Performance profiling shows < 1% CPU usage

---

## Appendix: File Structure

```
packages/opencode/
├── src/cli/cmd/tui/
│   ├── util/
│   │   ├── token-monitor.ts       # Prompt 1
│   │   ├── sparkline-renderer.ts  # Prompt 2
│   │   ├── graph-scaler.ts        # Prompt 3
│   │   ├── stats-overlay.ts       # Prompt 4
│   │   ├── token-stream-handler.ts # Prompt 6
│   │   └── mock-stream.ts         # Prompt 7 (dev)
│   └── routes/session/
│       ├── index.tsx              # Modified (Prompt 5B)
│       └── performance.tsx        # New (Prompt 5A)
└── test/cli/cmd/tui/
    ├── token-monitor.test.ts      # Prompt 7
    ├── sparkline-renderer.test.ts # Prompt 7
    ├── graph-scaler.test.ts       # Prompt 7
    ├── stats-overlay.test.ts      # Prompt 7
    └── token-stream-handler.test.ts # Prompt 7
```
