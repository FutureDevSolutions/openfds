import { describe, expect, test } from "bun:test"
import { DiagnosticService } from "../../src/lsp/diagnostic"
import type { LSPClient } from "../../src/lsp/client"

// ── Helpers ────────────────────────────────────────────────────────

function makeDiag(
  overrides: Partial<LSPClient.Diagnostic> & { message: string },
): LSPClient.Diagnostic {
  return {
    range: {
      start: { line: overrides.range?.start?.line ?? 0, character: overrides.range?.start?.character ?? 0 },
      end: { line: overrides.range?.end?.line ?? 0, character: overrides.range?.end?.character ?? 0 },
    },
    severity: overrides.severity ?? 1,
    message: overrides.message,
    source: overrides.source,
  } as LSPClient.Diagnostic
}

function makeError(line: number, msg: string): LSPClient.Diagnostic {
  return makeDiag({
    range: {
      start: { line, character: 0 },
      end: { line, character: 10 },
    },
    severity: 1,
    message: msg,
  })
}

function makeWarning(line: number, msg: string): LSPClient.Diagnostic {
  return makeDiag({
    range: {
      start: { line, character: 0 },
      end: { line, character: 10 },
    },
    severity: 2,
    message: msg,
  })
}

// ── Attack Scenario 1: Empty baseline vs populated current ────────

describe("DiagnosticService.delta — empty baseline vs populated", () => {
  test("all diagnostics in after are new when baseline is empty", () => {
    const before = DiagnosticService.snapshot({})
    const after = DiagnosticService.snapshot({
      "/src/a.ts": [makeError(1, "Type error"), makeWarning(2, "Unused var")],
      "/src/b.ts": [makeError(5, "Missing import")],
    })

    const d = DiagnosticService.delta(before, after)
    expect(d.new_errors).toBe(2)
    expect(d.new_warnings).toBe(1)
    expect(d.resolved_errors).toBe(0)
    expect(d.resolved_warnings).toBe(0)
    expect(d.per_file.size).toBe(2)
  })

  test("all diagnostics in before are resolved when after is empty", () => {
    const before = DiagnosticService.snapshot({
      "/src/a.ts": [makeError(1, "Type error"), makeWarning(2, "Unused var")],
    })
    const after = DiagnosticService.snapshot({})

    const d = DiagnosticService.delta(before, after)
    expect(d.new_errors).toBe(0)
    expect(d.new_warnings).toBe(0)
    expect(d.resolved_errors).toBe(1)
    expect(d.resolved_warnings).toBe(1)
  })

  test("both empty snapshots produce clean delta", () => {
    const before = DiagnosticService.snapshot({})
    const after = DiagnosticService.snapshot({})

    const d = DiagnosticService.delta(before, after)
    expect(d.new_errors).toBe(0)
    expect(d.new_warnings).toBe(0)
    expect(d.resolved_errors).toBe(0)
    expect(d.resolved_warnings).toBe(0)
    expect(d.per_file.size).toBe(0)
  })
})

// ── Attack Scenario 2: Large diagnostic sets with repeated entries ─

describe("DiagnosticService.delta — large sets with duplicates", () => {
  test("handles hundreds of diagnostics deterministically", () => {
    const diags: LSPClient.Diagnostic[] = []
    for (let i = 0; i < 500; i++) {
      diags.push(makeError(i, `Error ${i}`))
    }

    const before = DiagnosticService.snapshot({ "/src/big.ts": diags.slice(0, 250) })
    const after = DiagnosticService.snapshot({ "/src/big.ts": diags.slice(200, 500) })

    const d = DiagnosticService.delta(before, after)
    // 200-249 overlap (50 diags), 0-199 resolved (200 diags), 250-499 new (250 diags)
    expect(d.new_errors).toBe(250)
    expect(d.resolved_errors).toBe(200)
    expect(d.new_warnings).toBe(0)
    expect(d.resolved_warnings).toBe(0)
  })

  test("exact duplicate diagnostics in same file are deduped in keys", () => {
    const dup = makeError(10, "Duplicate error")
    const before = DiagnosticService.snapshot({ "/src/dup.ts": [dup, dup, dup] })
    const after = DiagnosticService.snapshot({ "/src/dup.ts": [dup] })

    // Since diagnosticKey produces the same key, before has 1 unique key, after has 1 unique key
    const d = DiagnosticService.delta(before, after)
    expect(d.new_errors).toBe(0)
    expect(d.resolved_errors).toBe(0)
  })

  test("determinism: repeated delta calls produce identical results", () => {
    const diags: LSPClient.Diagnostic[] = []
    for (let i = 0; i < 100; i++) {
      diags.push(i % 2 === 0 ? makeError(i, `E${i}`) : makeWarning(i, `W${i}`))
    }

    const before = DiagnosticService.snapshot({ "/src/det.ts": diags.slice(0, 50) })
    const after = DiagnosticService.snapshot({ "/src/det.ts": diags.slice(25, 100) })

    const results = Array.from({ length: 10 }, () => DiagnosticService.delta(before, after))

    for (const r of results) {
      expect(r.new_errors).toBe(results[0].new_errors)
      expect(r.new_warnings).toBe(results[0].new_warnings)
      expect(r.resolved_errors).toBe(results[0].resolved_errors)
      expect(r.resolved_warnings).toBe(results[0].resolved_warnings)
    }
  })
})

// ── Attack Scenario 3: Multiple roots and cross-root suppression ──

describe("DiagnosticService.snapshot — root filtering", () => {
  test("filters diagnostics to specified roots", () => {
    const diags: Record<string, LSPClient.Diagnostic[]> = {
      "/workspace/project-a/src/a.ts": [makeError(1, "Error A")],
      "/workspace/project-b/src/b.ts": [makeError(1, "Error B")],
      "/workspace/project-c/src/c.ts": [makeWarning(1, "Warning C")],
    }

    const snap = DiagnosticService.snapshot(diags, undefined, ["/workspace/project-a"])
    expect(snap.files.size).toBe(1)
    expect(snap.files.has("/workspace/project-a/src/a.ts")).toBe(true)
    expect(snap.files.has("/workspace/project-b/src/b.ts")).toBe(false)
  })

  test("filters to specific files AND roots", () => {
    const diags: Record<string, LSPClient.Diagnostic[]> = {
      "/workspace/project-a/src/a.ts": [makeError(1, "Error A")],
      "/workspace/project-a/src/z.ts": [makeError(1, "Error Z")],
      "/workspace/project-b/src/b.ts": [makeError(1, "Error B")],
    }

    const snap = DiagnosticService.snapshot(
      diags,
      ["/workspace/project-a/src/a.ts"],
      ["/workspace/project-a"],
    )
    // Both a.ts (by file match) and z.ts (by root match) should be included
    expect(snap.files.size).toBe(2)
    expect(snap.files.has("/workspace/project-a/src/a.ts")).toBe(true)
    expect(snap.files.has("/workspace/project-a/src/z.ts")).toBe(true)
    expect(snap.files.has("/workspace/project-b/src/b.ts")).toBe(false)
  })

  test("cross-root spillover is suppressed in delta", () => {
    const beforeDiags: Record<string, LSPClient.Diagnostic[]> = {
      "/workspace/project-a/src/a.ts": [makeError(1, "Error A")],
      "/workspace/project-b/src/b.ts": [makeError(1, "Error B before")],
    }
    const afterDiags: Record<string, LSPClient.Diagnostic[]> = {
      "/workspace/project-a/src/a.ts": [makeError(1, "Error A"), makeError(2, "New error A")],
      "/workspace/project-b/src/b.ts": [makeError(1, "Error B after")],
    }

    // Only scope to project-a
    const before = DiagnosticService.snapshot(beforeDiags, undefined, ["/workspace/project-a"])
    const after = DiagnosticService.snapshot(afterDiags, undefined, ["/workspace/project-a"])

    const d = DiagnosticService.delta(before, after)
    // Should only see project-a changes, not project-b
    expect(d.new_errors).toBe(1)
    expect(d.resolved_errors).toBe(0)
    expect(d.per_file.has("/workspace/project-b/src/b.ts")).toBe(false)
  })

  test("unfiltered snapshot captures everything", () => {
    const diags: Record<string, LSPClient.Diagnostic[]> = {
      "/a.ts": [makeError(1, "E1")],
      "/b.ts": [makeError(2, "E2")],
      "/c.ts": [makeWarning(3, "W3")],
    }

    const snap = DiagnosticService.snapshot(diags)
    expect(snap.files.size).toBe(3)
  })
})

// ── Attack Scenario 4: Malformed diagnostic objects ───────────────

describe("DiagnosticService — malformed diagnostics", () => {
  test("missing severity defaults to error (severity=1)", () => {
    const noSeverity = {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      message: "Missing severity field",
    } as LSPClient.Diagnostic

    const before = DiagnosticService.snapshot({})
    const after = DiagnosticService.snapshot({ "/src/x.ts": [noSeverity] })

    const d = DiagnosticService.delta(before, after)
    // undefined severity defaults to 1 (Error) via `d.severity ?? 1`
    expect(d.new_errors).toBe(1)
    expect(d.new_warnings).toBe(0)
  })

  test("info/hint severity diagnostics are not counted as errors or warnings", () => {
    const info = makeDiag({ severity: 3, message: "Info diagnostic" })
    const hint = makeDiag({ severity: 4, message: "Hint diagnostic" })

    const before = DiagnosticService.snapshot({})
    const after = DiagnosticService.snapshot({ "/src/x.ts": [info, hint] })

    const d = DiagnosticService.delta(before, after)
    expect(d.new_errors).toBe(0)
    expect(d.new_warnings).toBe(0)
    expect(d.per_file.size).toBe(0) // info/hint changes are not tracked
  })

  test("diagnostic with zero-length range still works", () => {
    const zeroRange = makeDiag({
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      severity: 1,
      message: "Zero-range error",
    })

    const before = DiagnosticService.snapshot({})
    const after = DiagnosticService.snapshot({ "/src/x.ts": [zeroRange] })

    const d = DiagnosticService.delta(before, after)
    expect(d.new_errors).toBe(1)
  })

  test("empty diagnostics array for a file is handled gracefully", () => {
    const before = DiagnosticService.snapshot({ "/src/x.ts": [] })
    const after = DiagnosticService.snapshot({ "/src/x.ts": [] })

    const d = DiagnosticService.delta(before, after)
    expect(d.new_errors).toBe(0)
    expect(d.per_file.size).toBe(0)
  })
})

// ── Attack Scenario 5: Rapid successive snapshots ─────────────────

describe("DiagnosticService — rapid successive snapshots", () => {
  test("snapshots have monotonically increasing timestamps", () => {
    const diags = { "/src/a.ts": [makeError(1, "E1")] }
    const snaps: DiagnosticService.Snapshot[] = []

    for (let i = 0; i < 20; i++) {
      snaps.push(DiagnosticService.snapshot(diags))
    }

    for (let i = 1; i < snaps.length; i++) {
      expect(snaps[i].timestamp).toBeGreaterThanOrEqual(snaps[i - 1].timestamp)
    }
  })

  test("snapshots are immutable — mutating input doesn't affect snapshot", () => {
    const inputDiags: Record<string, LSPClient.Diagnostic[]> = {
      "/src/a.ts": [makeError(1, "Original")],
    }

    const snap = DiagnosticService.snapshot(inputDiags)
    expect(snap.files.get("/src/a.ts")?.length).toBe(1)

    // Mutate the input after snapshot
    inputDiags["/src/a.ts"].push(makeError(2, "Sneaky addition"))

    // Snapshot should still have original data (we copy in snapshot)
    expect(snap.files.get("/src/a.ts")?.length).toBe(1)
  })

  test("different snapshot inputs produce independent deltas", () => {
    const snap1 = DiagnosticService.snapshot({ "/src/a.ts": [makeError(1, "E1")] })
    const snap2 = DiagnosticService.snapshot({ "/src/a.ts": [makeError(1, "E1"), makeError(2, "E2")] })
    const snap3 = DiagnosticService.snapshot({ "/src/a.ts": [makeError(2, "E2"), makeError(3, "E3")] })

    const d12 = DiagnosticService.delta(snap1, snap2)
    const d23 = DiagnosticService.delta(snap2, snap3)
    const d13 = DiagnosticService.delta(snap1, snap3)

    // snap1→snap2: +1 new error (E2)
    expect(d12.new_errors).toBe(1)
    expect(d12.resolved_errors).toBe(0)

    // snap2→snap3: +1 new (E3), -1 resolved (E1)
    expect(d23.new_errors).toBe(1)
    expect(d23.resolved_errors).toBe(1)

    // snap1→snap3: +2 new (E2, E3), -1 resolved (E1)
    expect(d13.new_errors).toBe(2)
    expect(d13.resolved_errors).toBe(1)
  })
})

// ── formatDelta and hasNewErrors ──────────────────────────────────

describe("DiagnosticService.formatDelta", () => {
  test("returns empty string for clean delta", () => {
    const d: DiagnosticService.Delta = {
      new_errors: 0,
      new_warnings: 0,
      resolved_errors: 0,
      resolved_warnings: 0,
      per_file: new Map(),
    }
    expect(DiagnosticService.formatDelta(d)).toBe("")
  })

  test("formats mixed delta correctly", () => {
    const d: DiagnosticService.Delta = {
      new_errors: 2,
      new_warnings: 1,
      resolved_errors: 3,
      resolved_warnings: 0,
      per_file: new Map(),
    }
    const text = DiagnosticService.formatDelta(d)
    expect(text).toContain("+2 new errors")
    expect(text).toContain("+1 new warning")
    expect(text).toContain("-3 resolved errors")
    expect(text).not.toContain("resolved warning")
  })

  test("singular forms for count=1", () => {
    const d: DiagnosticService.Delta = {
      new_errors: 1,
      new_warnings: 0,
      resolved_errors: 0,
      resolved_warnings: 1,
      per_file: new Map(),
    }
    const text = DiagnosticService.formatDelta(d)
    expect(text).toContain("+1 new error")
    expect(text).not.toContain("errors")
    expect(text).toContain("-1 resolved warning")
    expect(text).not.toContain("warnings")
  })
})

describe("DiagnosticService.hasNewErrors", () => {
  test("true when new_errors > 0", () => {
    expect(
      DiagnosticService.hasNewErrors({
        new_errors: 1,
        new_warnings: 0,
        resolved_errors: 0,
        resolved_warnings: 0,
        per_file: new Map(),
      }),
    ).toBe(true)
  })

  test("false when only warnings introduced", () => {
    expect(
      DiagnosticService.hasNewErrors({
        new_errors: 0,
        new_warnings: 5,
        resolved_errors: 0,
        resolved_warnings: 0,
        per_file: new Map(),
      }),
    ).toBe(false)
  })
})

// ── selectForPrompt ───────────────────────────────────────────────

describe("DiagnosticService.selectForPrompt", () => {
  test("returns current-file diagnostics", () => {
    const diagnostics: Record<string, LSPClient.Diagnostic[]> = {
      "/src/a.ts": [makeError(1, "Error in a")],
    }
    const status: any[] = [
      {
        id: "ts",
        name: "typescript",
        root: ".",
        root_absolute: "/src",
        healthy: true,
        status: "connected",
      },
    ]

    const result = DiagnosticService.selectForPrompt({
      file: "/src/a.ts",
      diagnostics,
      status,
    })
    expect(result.current).toContain("Error in a")
  })

  test("returns empty current for file with no errors", () => {
    const diagnostics: Record<string, LSPClient.Diagnostic[]> = {
      "/src/a.ts": [makeWarning(1, "Warning only")],
    }
    const status: any[] = []

    const result = DiagnosticService.selectForPrompt({
      file: "/src/a.ts",
      diagnostics,
      status,
    })
    // report() only includes severity=1, so warnings are not shown
    expect(result.current).toBe("")
  })
})
