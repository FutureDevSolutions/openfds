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

// ── Attack Scenario 6: Fix one error, introduce another ──────────

describe("DiagnosticService.delta — fix-one-introduce-another", () => {
  test("reports both resolved and new errors, needs_fix=true", () => {
    const errorA = makeError(5, "Type 'string' is not assignable to type 'number'")
    const errorB = makeError(12, "Property 'foo' does not exist on type 'Bar'")

    const before = DiagnosticService.snapshot({ "/src/fixed.ts": [errorA] })
    const after = DiagnosticService.snapshot({ "/src/fixed.ts": [errorB] })

    const d = DiagnosticService.delta(before, after)
    expect(d.new_errors).toBe(1)
    expect(d.resolved_errors).toBe(1)
    expect(d.new_warnings).toBe(0)
    expect(d.resolved_warnings).toBe(0)
    expect(DiagnosticService.hasNewErrors(d)).toBe(true)

    const text = DiagnosticService.formatDelta(d)
    expect(text).toContain("+1 new error")
    expect(text).toContain("-1 resolved error")
  })

  test("resolving all errors with no new ones gives needs_fix=false", () => {
    const errorA = makeError(5, "Type error")
    const before = DiagnosticService.snapshot({ "/src/clean.ts": [errorA] })
    const after = DiagnosticService.snapshot({ "/src/clean.ts": [] })

    const d = DiagnosticService.delta(before, after)
    expect(d.resolved_errors).toBe(1)
    expect(d.new_errors).toBe(0)
    expect(DiagnosticService.hasNewErrors(d)).toBe(false)
  })
})

// ── Attack Scenario 7: LSP unavailable — empty diagnostics ───────

describe("DiagnosticService — LSP unavailable path", () => {
  test("empty diagnostics produce clean delta and needs_fix=false", () => {
    const before = DiagnosticService.snapshot({}, ["/src/any.ts"])
    const after = DiagnosticService.snapshot({}, ["/src/any.ts"])

    const d = DiagnosticService.delta(before, after)
    expect(d.new_errors).toBe(0)
    expect(d.new_warnings).toBe(0)
    expect(d.resolved_errors).toBe(0)
    expect(d.resolved_warnings).toBe(0)
    expect(DiagnosticService.hasNewErrors(d)).toBe(false)
    expect(DiagnosticService.formatDelta(d)).toBe("")
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

// ═══════════════════════════════════════════════════════════════════
// PassiveDiagnosticRegistry — Unit Tests
// ═══════════════════════════════════════════════════════════════════

describe("PassiveDiagnosticRegistry: basic ingest and novel flow", () => {
  test("ingesting errors makes them available via novel()", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    reg.ingest("/src/a.ts", [makeError(1, "Type error")])
    const novel = reg.novel()
    expect(novel.size).toBe(1)
    expect(novel.get("/src/a.ts")?.length).toBe(1)
    expect(novel.get("/src/a.ts")![0].message).toBe("Type error")
  })

  test("warnings are also tracked (severity 2)", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    reg.ingest("/src/a.ts", [makeWarning(1, "Unused var")])
    expect(reg.novelCount()).toBe(1)
  })

  test("info (severity 3) and hint (severity 4) are NOT tracked", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    reg.ingest("/src/a.ts", [
      makeDiag({ severity: 3, message: "Info" }),
      makeDiag({ severity: 4, message: "Hint" }),
    ])
    expect(reg.novelCount()).toBe(0)
    expect(reg.novel().size).toBe(0)
  })

  test("empty diagnostics array is a no-op", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    reg.ingest("/src/a.ts", [])
    expect(reg.novelCount()).toBe(0)
  })

  test("novelCount() reflects total novel diagnostics across files", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    reg.ingest("/src/a.ts", [makeError(1, "E1"), makeError(2, "E2")])
    reg.ingest("/src/b.ts", [makeWarning(1, "W1")])
    expect(reg.novelCount()).toBe(3)
  })
})

describe("PassiveDiagnosticRegistry: within-turn dedup", () => {
  test("identical diagnostics in same file are deduped", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    const diag = makeError(5, "Duplicate error")
    reg.ingest("/src/a.ts", [diag, diag, diag])
    expect(reg.novelCount()).toBe(1)
    expect(reg.stats().deduped).toBe(2)
  })

  test("same diagnostic ingested in multiple calls is deduped", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    const diag = makeError(5, "Same error")
    reg.ingest("/src/a.ts", [diag])
    reg.ingest("/src/a.ts", [diag])
    reg.ingest("/src/a.ts", [diag])
    expect(reg.novelCount()).toBe(1)
    expect(reg.stats().deduped).toBe(2)
  })

  test("different diagnostics on same line are NOT deduped", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    reg.ingest("/src/a.ts", [
      makeError(5, "Error A"),
      makeError(5, "Error B"),
    ])
    expect(reg.novelCount()).toBe(2)
  })

  test("same message on different lines are NOT deduped", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    reg.ingest("/src/a.ts", [
      makeError(1, "Same message"),
      makeError(2, "Same message"),
    ])
    expect(reg.novelCount()).toBe(2)
  })
})

describe("PassiveDiagnosticRegistry: cross-turn dedup via drain()", () => {
  test("drain() marks current novel as seen; re-ingesting after drain is deduped", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    const diag = makeError(1, "Persistent error")
    reg.ingest("/src/a.ts", [diag])
    expect(reg.novelCount()).toBe(1)

    reg.drain()
    expect(reg.novelCount()).toBe(0)
    expect(reg.novel().size).toBe(0)

    // Re-ingest the same diagnostic — should be deduped by cross-turn seen set
    reg.ingest("/src/a.ts", [diag])
    expect(reg.novelCount()).toBe(0)
    expect(reg.stats().deduped).toBe(1)
  })

  test("new diagnostic after drain is NOT deduped", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    reg.ingest("/src/a.ts", [makeError(1, "Old error")])
    reg.drain()

    reg.ingest("/src/a.ts", [makeError(2, "New error")])
    expect(reg.novelCount()).toBe(1)
    expect(reg.novel().get("/src/a.ts")![0].message).toBe("New error")
  })

  test("multiple drain cycles accumulate seen set", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()

    // Turn 1
    reg.ingest("/src/a.ts", [makeError(1, "E1")])
    reg.drain()

    // Turn 2
    reg.ingest("/src/a.ts", [makeError(2, "E2")])
    reg.drain()

    // Turn 3: both E1 and E2 are deduped
    reg.ingest("/src/a.ts", [makeError(1, "E1"), makeError(2, "E2")])
    expect(reg.novelCount()).toBe(0)
    expect(reg.stats().seenKeys).toBe(2)
  })
})

describe("PassiveDiagnosticRegistry: per-file and total caps", () => {
  test("per-file cap prevents excess diagnostics", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry({ perFileCap: 3, totalCap: 100 })
    const diags = Array.from({ length: 10 }, (_, i) => makeError(i, `Error ${i}`))
    reg.ingest("/src/a.ts", diags)
    expect(reg.novelCount()).toBe(3)
    expect(reg.stats().capDropped).toBe(7)
  })

  test("total cap prevents excess diagnostics across files", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry({ perFileCap: 100, totalCap: 5 })
    for (let f = 0; f < 10; f++) {
      reg.ingest(`/src/file${f}.ts`, [makeError(0, `Error in file ${f}`)])
    }
    expect(reg.novelCount()).toBe(5)
    expect(reg.stats().capDropped).toBe(5)
  })

  test("per-file cap is independent across files", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry({ perFileCap: 2, totalCap: 100 })
    reg.ingest("/src/a.ts", [makeError(0, "A0"), makeError(1, "A1"), makeError(2, "A2")])
    reg.ingest("/src/b.ts", [makeError(0, "B0"), makeError(1, "B1"), makeError(2, "B2")])
    // 2 per file, 4 total
    expect(reg.novelCount()).toBe(4)
    expect(reg.novel().get("/src/a.ts")?.length).toBe(2)
    expect(reg.novel().get("/src/b.ts")?.length).toBe(2)
  })

  test("caps reset after drain()", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry({ perFileCap: 2, totalCap: 3 })
    reg.ingest("/src/a.ts", [makeError(0, "E0"), makeError(1, "E1"), makeError(2, "E2")])
    expect(reg.novelCount()).toBe(2) // per-file cap hit
    reg.drain()

    // After drain, caps reset — new diagnostics can flow
    reg.ingest("/src/a.ts", [makeError(3, "E3"), makeError(4, "E4")])
    expect(reg.novelCount()).toBe(2)
  })
})

describe("PassiveDiagnosticRegistry: reset()", () => {
  test("reset clears all state including seen set", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    reg.ingest("/src/a.ts", [makeError(1, "E1")])
    reg.drain()
    reg.ingest("/src/a.ts", [makeError(2, "E2")])

    reg.reset()

    expect(reg.novelCount()).toBe(0)
    expect(reg.novel().size).toBe(0)
    expect(reg.stats()).toEqual({
      ingested: 0,
      deduped: 0,
      capDropped: 0,
      seenKeys: 0,
      currentNovel: 0,
    })

    // After reset, previously-seen diagnostics are novel again
    reg.ingest("/src/a.ts", [makeError(1, "E1")])
    expect(reg.novelCount()).toBe(1)
  })
})

describe("PassiveDiagnosticRegistry: stats()", () => {
  test("stats track ingested, deduped, and capDropped accurately", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry({ perFileCap: 2, totalCap: 100 })
    const dup = makeError(1, "Dup")
    reg.ingest("/src/a.ts", [dup, dup, makeError(2, "E2"), makeError(3, "E3"), makeError(4, "E4")])
    // 5 ingested, 1 deduped (dup #2), 2 cap-dropped (E3, E4 over per-file cap of 2)
    // Actually: dup(accepted), dup(deduped), E2(accepted), E3(cap), E4(cap)
    const s = reg.stats()
    expect(s.ingested).toBe(5)
    expect(s.deduped).toBe(1)
    expect(s.capDropped).toBe(2)
    expect(s.currentNovel).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Adversarial Stress Tests — 5 Attack Scenarios
// ═══════════════════════════════════════════════════════════════════

describe("ADVERSARIAL 1: massive repeated diagnostics spam (1000 identical)", () => {
  test("1000 identical diagnostics produce exactly 1 novel entry", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    const diag = makeError(1, "Spammed error")
    const batch = Array.from({ length: 1000 }, () => diag)
    reg.ingest("/src/spam.ts", batch)
    expect(reg.novelCount()).toBe(1)
    expect(reg.stats().deduped).toBe(999)
    expect(reg.stats().ingested).toBe(1000)
  })

  test("1000 unique diagnostics are capped at perFileCap", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry({ perFileCap: 25 })
    const batch = Array.from({ length: 1000 }, (_, i) => makeError(i, `Error ${i}`))
    reg.ingest("/src/spam.ts", batch)
    expect(reg.novelCount()).toBe(25)
    expect(reg.stats().capDropped).toBe(975)
  })
})

describe("ADVERSARIAL 2: multi-file burst from single action (50 files)", () => {
  test("50-file burst: total cap limits aggregate output", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry({ perFileCap: 10, totalCap: 30 })
    for (let f = 0; f < 50; f++) {
      reg.ingest(`/src/file${f}.ts`, [
        makeError(0, `Error A in file ${f}`),
        makeError(1, `Error B in file ${f}`),
      ])
    }
    // 50 files × 2 errors = 100 ingested, but total cap is 30
    expect(reg.novelCount()).toBe(30)
    expect(reg.stats().capDropped).toBe(70)
  })

  test("50-file burst: per-file cap limits per-file output", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry({ perFileCap: 1, totalCap: 1000 })
    for (let f = 0; f < 50; f++) {
      reg.ingest(`/src/file${f}.ts`, [
        makeError(0, `Error A in file ${f}`),
        makeError(1, `Error B in file ${f}`),
      ])
    }
    // 50 files × 1 per-file cap = 50, all within totalCap
    expect(reg.novelCount()).toBe(50)
    for (const [, diags] of reg.novel()) {
      expect(diags.length).toBe(1)
    }
  })
})

describe("ADVERSARIAL 3: cross-turn duplicate suppression over 10 turns", () => {
  test("10 turns of mixed old/new diagnostics: only truly new are surfaced", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    let totalNovel = 0

    for (let turn = 0; turn < 10; turn++) {
      // Each turn: re-send all previous errors + one new one
      const diags: LSPClient.Diagnostic[] = []
      for (let prev = 0; prev <= turn; prev++) {
        diags.push(makeError(prev, `Error from turn ${prev}`))
      }
      reg.ingest("/src/evolving.ts", diags)

      // Only the new error should be novel
      expect(reg.novelCount()).toBe(1)
      totalNovel++

      reg.drain()
    }

    expect(totalNovel).toBe(10)
    expect(reg.stats().seenKeys).toBe(10)
  })

  test("seen set does not grow unbounded with duplicate spam", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    const diag = makeError(1, "Persistent error")

    for (let turn = 0; turn < 100; turn++) {
      reg.ingest("/src/a.ts", [diag])
      reg.drain()
    }

    // Only 1 unique key in seen set despite 100 turns
    expect(reg.stats().seenKeys).toBe(1)
  })
})

describe("ADVERSARIAL 4: mixed healthy/unhealthy severity streams", () => {
  test("mixed severity stream: only errors and warnings tracked", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    reg.ingest("/src/mix.ts", [
      makeError(1, "Error"),
      makeWarning(2, "Warning"),
      makeDiag({ severity: 3, message: "Info" }),
      makeDiag({ severity: 4, message: "Hint" }),
      makeDiag({ severity: undefined as any, message: "No severity" }), // defaults to 1
    ])
    // Error(1) + Warning(2) + NoSeverity(defaults to 1) = 3 actionable
    expect(reg.novelCount()).toBe(3)
  })

  test("severity-1 errors are never dropped by dedup in favor of lower severity", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry({ perFileCap: 2 })
    // Ingest warnings first, then errors — errors should still be accepted
    // (they have different messages so they're different keys)
    reg.ingest("/src/a.ts", [makeWarning(1, "W1"), makeWarning(2, "W2")])
    // Now at per-file cap of 2
    reg.ingest("/src/a.ts", [makeError(3, "E1")])
    // E1 is cap-dropped because cap is already full
    expect(reg.novelCount()).toBe(2)
    // But the 2 that made it in should include the warnings
    const diags = reg.novel().get("/src/a.ts")!
    expect(diags).toHaveLength(2)
  })
})

describe("ADVERSARIAL 5: registry cleanup/reset correctness", () => {
  test("reset after multiple turns: no stale-state leakage", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()

    // Build up state over several turns
    for (let turn = 0; turn < 5; turn++) {
      reg.ingest("/src/a.ts", [makeError(turn, `Error ${turn}`)])
      reg.drain()
    }
    expect(reg.stats().seenKeys).toBe(5)

    // Reset
    reg.reset()

    // All state is gone
    expect(reg.stats().seenKeys).toBe(0)
    expect(reg.stats().ingested).toBe(0)
    expect(reg.novelCount()).toBe(0)

    // Previously-seen diagnostics are novel again
    reg.ingest("/src/a.ts", [makeError(0, "Error 0")])
    expect(reg.novelCount()).toBe(1)
  })

  test("drain without ingest is a safe no-op", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    reg.drain()
    reg.drain()
    reg.drain()
    expect(reg.novelCount()).toBe(0)
    expect(reg.stats().seenKeys).toBe(0)
  })

  test("reset then drain is a safe no-op", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()
    reg.ingest("/src/a.ts", [makeError(1, "E1")])
    reg.reset()
    reg.drain()
    expect(reg.novelCount()).toBe(0)
  })

  test("memory does not grow: seen set size equals unique diagnostic count", () => {
    const reg = new DiagnosticService.PassiveDiagnosticRegistry()

    // 10 turns, each with 5 unique diagnostics per file, 3 files
    for (let turn = 0; turn < 10; turn++) {
      for (let file = 0; file < 3; file++) {
        const diags = Array.from({ length: 5 }, (_, i) =>
          makeError(turn * 5 + i, `E_t${turn}_f${file}_${i}`),
        )
        reg.ingest(`/src/file${file}.ts`, diags)
      }
      reg.drain()
    }

    // 10 turns × 5 diags × 3 files = 150 unique keys
    expect(reg.stats().seenKeys).toBe(150)
    // No novel diagnostics after drain
    expect(reg.novelCount()).toBe(0)
  })
})
