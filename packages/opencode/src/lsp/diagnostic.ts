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
}
