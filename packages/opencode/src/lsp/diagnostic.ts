import path from "path"
import type { LSPClient } from "./client"
import { LSP } from "./index"
import { AppFileSystem } from "../filesystem"

/**
 * Diagnostic baseline/delta service for mutation tools.
 *
 * Provides snapshot capture, before/after delta computation, and bounded
 * diagnostic selection for prompt surfacing. All functions are pure and
 * operate on data returned by `LSP.Service.diagnostics()` and
 * `LSP.Service.status()`.
 */
export namespace DiagnosticService {
  // ── Types ──────────────────────────────────────────────────────────

  /** A frozen diagnostic snapshot keyed by normalized file path. */
  export interface Snapshot {
    /** Diagnostics per file, keyed by normalized absolute path. */
    readonly files: ReadonlyMap<string, readonly LSPClient.Diagnostic[]>
    /** Epoch-ms when the snapshot was taken. */
    readonly timestamp: number
  }

  /** Result of comparing two snapshots. */
  export interface Delta {
    new_errors: number
    new_warnings: number
    resolved_errors: number
    resolved_warnings: number
    /** Per-file breakdown (only files with changes). */
    per_file: ReadonlyMap<string, FileDelta>
  }

  export interface FileDelta {
    new_errors: number
    new_warnings: number
    resolved_errors: number
    resolved_warnings: number
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /** Severity constants from LSP spec. */
  const Severity = {
    Error: 1,
    Warning: 2,
  } as const

  /**
   * Build a stable string key for dedup-comparing two diagnostics.
   * Uses range + severity + message so that identical diagnostics on the
   * same line are counted only once.
   */
  function diagnosticKey(d: LSPClient.Diagnostic): string {
    const r = d.range
    return `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}|${d.severity ?? 1}|${d.message}`
  }

  function inRoot(file: string, root: string): boolean {
    if (file === root) return true
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    return file.startsWith(prefix)
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Capture a diagnostic snapshot.
   *
   * @param diagnostics - Full diagnostics map from `LSP.Service.diagnostics()`.
   * @param files       - Optional list of absolute file paths to include.
   *                      When omitted the entire diagnostics map is captured.
   * @param roots       - Optional list of LSP root paths. When provided,
   *                      any file under a matching root is included even if
   *                      it is not in `files`.
   */
  export function snapshot(
    diagnostics: Record<string, LSPClient.Diagnostic[]>,
    files?: readonly string[],
    roots?: readonly string[],
  ): Snapshot {
    const map = new Map<string, readonly LSPClient.Diagnostic[]>()
    const fileSet = files ? new Set(files.map((f) => AppFileSystem.normalizePath(f))) : undefined

    for (const [rawPath, diags] of Object.entries(diagnostics)) {
      const normalized = AppFileSystem.normalizePath(rawPath)

      // If files/roots filters are active, check membership
      if (fileSet || roots) {
        let include = false
        if (fileSet?.has(normalized)) include = true
        if (!include && roots) {
          for (const root of roots) {
            if (inRoot(normalized, root)) {
              include = true
              break
            }
          }
        }
        if (!include) continue
      }

      // Freeze a copy so snapshots are immutable
      map.set(normalized, [...diags])
    }

    return { files: map, timestamp: Date.now() }
  }

  /**
   * Compute the delta between a *before* and *after* snapshot.
   *
   * "New" means a diagnostic key present in `after` but absent in `before`.
   * "Resolved" means present in `before` but absent in `after`.
   */
  export function delta(before: Snapshot, after: Snapshot): Delta {
    let new_errors = 0
    let new_warnings = 0
    let resolved_errors = 0
    let resolved_warnings = 0
    const per_file = new Map<string, FileDelta>()

    // Collect the union of all file paths from both snapshots
    const allFiles = new Set<string>([...before.files.keys(), ...after.files.keys()])

    for (const file of allFiles) {
      const beforeDiags = before.files.get(file) ?? []
      const afterDiags = after.files.get(file) ?? []

      const beforeKeys = new Set(beforeDiags.map(diagnosticKey))
      const afterKeys = new Set(afterDiags.map(diagnosticKey))

      // Build lookup maps for severity
      const beforeBySeverity = new Map<string, number>()
      for (const d of beforeDiags) {
        beforeBySeverity.set(diagnosticKey(d), d.severity ?? 1)
      }
      const afterBySeverity = new Map<string, number>()
      for (const d of afterDiags) {
        afterBySeverity.set(diagnosticKey(d), d.severity ?? 1)
      }

      let fne = 0
      let fnw = 0
      let fre = 0
      let frw = 0

      // New diagnostics: in after but not in before
      for (const [key, sev] of afterBySeverity) {
        if (!beforeKeys.has(key)) {
          if (sev === Severity.Error) {
            fne++
            new_errors++
          } else if (sev === Severity.Warning) {
            fnw++
            new_warnings++
          }
        }
      }

      // Resolved diagnostics: in before but not in after
      for (const [key, sev] of beforeBySeverity) {
        if (!afterKeys.has(key)) {
          if (sev === Severity.Error) {
            fre++
            resolved_errors++
          } else if (sev === Severity.Warning) {
            frw++
            resolved_warnings++
          }
        }
      }

      if (fne || fnw || fre || frw) {
        per_file.set(file, {
          new_errors: fne,
          new_warnings: fnw,
          resolved_errors: fre,
          resolved_warnings: frw,
        })
      }
    }

    return { new_errors, new_warnings, resolved_errors, resolved_warnings, per_file }
  }

  /**
   * Select diagnostics for prompt surfacing — the target file's errors
   * plus bounded same-root spillover.
   *
   * This is a convenience wrapper that composes `snapshot` filtering with
   * the existing `LSP.Diagnostic.select` logic.
   *
   * @param file        - Absolute path of the primary file.
   * @param diagnostics - Full diagnostics map from `LSP.Service.diagnostics()`.
   * @param status      - LSP status array from `LSP.Service.status()`.
   * @param spill       - Max number of related files to include (default 2).
   */
  export function selectForPrompt(input: {
    file: string
    diagnostics: Record<string, LSPClient.Diagnostic[]>
    status: LSP.Status[]
    spill?: number
  }): { current: string; related: { file: string; block: string }[] } {
    return LSP.Diagnostic.select({
      file: AppFileSystem.normalizePath(input.file),
      diagnostics: input.diagnostics,
      status: input.status,
      spill: input.spill ?? 2,
    })
  }

  /**
   * Format a delta summary for inclusion in tool output.
   * Returns empty string when the delta is clean.
   */
  export function formatDelta(d: Delta): string {
    const parts: string[] = []
    if (d.new_errors > 0) parts.push(`+${d.new_errors} new error${d.new_errors === 1 ? "" : "s"}`)
    if (d.new_warnings > 0) parts.push(`+${d.new_warnings} new warning${d.new_warnings === 1 ? "" : "s"}`)
    if (d.resolved_errors > 0) parts.push(`-${d.resolved_errors} resolved error${d.resolved_errors === 1 ? "" : "s"}`)
    if (d.resolved_warnings > 0)
      parts.push(`-${d.resolved_warnings} resolved warning${d.resolved_warnings === 1 ? "" : "s"}`)
    if (parts.length === 0) return ""
    return `Diagnostic delta: ${parts.join(", ")}`
  }

  /**
   * Whether a delta introduces new severity-1 errors on the changed files.
   */
  export function hasNewErrors(d: Delta): boolean {
    return d.new_errors > 0
  }

  // ── Passive Diagnostic Registry ─────────────────────────────────

  /** Default volume limits for the passive registry. */
  const DEFAULT_PER_FILE_CAP = 25
  const DEFAULT_TOTAL_CAP = 100

  /** Severity constants — only errors and warnings are tracked. */
  const ACTIONABLE_SEVERITIES = new Set([1, 2])

  /**
   * Passive async diagnostic registry.
   *
   * Ingests diagnostics from `publishDiagnostics` notifications, deduplicates
   * within-turn and cross-turn, enforces volume caps, and surfaces only novel
   * actionable diagnostics to prompt context.
   *
   * Lifecycle:
   * - `ingest()` — feed raw diagnostics from a publish notification.
   * - `novel()` — retrieve diagnostics new since the last `drain()`.
   * - `drain()` — mark current novel diagnostics as seen (end of turn).
   * - `reset()` — clear all state (session change / cleanup).
   *
   * The registry is a plain object with no side effects — it does NOT
   * subscribe to the Bus automatically. The caller is responsible for
   * wiring `ingest()` to the appropriate Bus subscription.
   */
  export class PassiveDiagnosticRegistry {
    /** All known diagnostic keys ever seen (for cross-turn dedup). */
    private readonly seen = new Set<string>()
    /** Diagnostics ingested in the current turn but not yet drained. */
    private readonly currentTurn = new Map<string, LSPClient.Diagnostic[]>()
    /** Per-file diagnostic count in the current turn (for cap enforcement). */
    private readonly fileCount = new Map<string, number>()
    /** Total diagnostics ingested in the current turn. */
    private totalCount = 0
    /** Cumulative ingest count (for stats). */
    private ingestCount = 0
    /** Cumulative dedup count (for stats). */
    private dedupCount = 0
    /** Cumulative cap-drop count (for stats). */
    private capDropCount = 0

    private readonly perFileCap: number
    private readonly totalCap: number

    constructor(options?: { perFileCap?: number; totalCap?: number }) {
      this.perFileCap = options?.perFileCap ?? DEFAULT_PER_FILE_CAP
      this.totalCap = options?.totalCap ?? DEFAULT_TOTAL_CAP
    }

    /**
     * Ingest diagnostics from a `publishDiagnostics` notification.
     *
     * @param file  - Normalized absolute file path.
     * @param diags - Raw diagnostics array from the LSP notification.
     */
    ingest(file: string, diags: readonly LSPClient.Diagnostic[]): void {
      for (const d of diags) {
        // Only track actionable severities
        const sev = d.severity ?? 1
        if (!ACTIONABLE_SEVERITIES.has(sev)) continue

        this.ingestCount++
        const key = `${file}|${diagnosticKey(d)}`

        // Cross-turn dedup: skip if already seen in any previous turn
        if (this.seen.has(key)) {
          this.dedupCount++
          continue
        }

        // Within-turn dedup: check current turn entries for this file
        const existing = this.currentTurn.get(file)
        if (existing?.some((e) => diagnosticKey(e) === diagnosticKey(d))) {
          this.dedupCount++
          continue
        }

        // Per-file cap
        const fc = this.fileCount.get(file) ?? 0
        if (fc >= this.perFileCap) {
          this.capDropCount++
          continue
        }

        // Total cap
        if (this.totalCount >= this.totalCap) {
          this.capDropCount++
          continue
        }

        // Accept the diagnostic
        if (!existing) {
          this.currentTurn.set(file, [d])
        } else {
          existing.push(d)
        }
        this.fileCount.set(file, fc + 1)
        this.totalCount++
      }
    }

    /**
     * Retrieve novel diagnostics from the current turn.
     * These are diagnostics that were ingested since the last `drain()` and
     * passed all dedup and cap filters.
     *
     * @returns Map of file path → diagnostics array. Only files with novel
     *          diagnostics are included.
     */
    novel(): ReadonlyMap<string, readonly LSPClient.Diagnostic[]> {
      return this.currentTurn
    }

    /** Count of novel diagnostics in the current turn. */
    novelCount(): number {
      return this.totalCount
    }

    /**
     * Drain the current turn: mark all current novel diagnostics as seen
     * and clear the turn buffer. Call this at the end of each agent turn.
     */
    drain(): void {
      for (const [file, diags] of this.currentTurn) {
        for (const d of diags) {
          this.seen.add(`${file}|${diagnosticKey(d)}`)
        }
      }
      this.currentTurn.clear()
      this.fileCount.clear()
      this.totalCount = 0
    }

    /**
     * Reset all state. Call this on session change or cleanup to prevent
     * stale cross-turn dedup from suppressing new diagnostics.
     */
    reset(): void {
      this.seen.clear()
      this.currentTurn.clear()
      this.fileCount.clear()
      this.totalCount = 0
      this.ingestCount = 0
      this.dedupCount = 0
      this.capDropCount = 0
    }

    /** Registry statistics for observability. */
    stats(): {
      ingested: number
      deduped: number
      capDropped: number
      seenKeys: number
      currentNovel: number
    } {
      return {
        ingested: this.ingestCount,
        deduped: this.dedupCount,
        capDropped: this.capDropCount,
        seenKeys: this.seen.size,
        currentNovel: this.totalCount,
      }
    }
  }
}
