/**
 * Adversarial tests for waitForDiagnostics.
 *
 * Attack scenarios:
 *  1. High-latency diagnostics publication
 *  2. Diagnostics published for non-target files first
 *  3. Duplicate/out-of-order publish events
 *  4. No publish event (quiet timeout path)
 *  5. Burst updates after first publish (debounce/settle race)
 */
import { describe, expect, test, beforeEach } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { LSPClient } from "../../src/lsp/client"
import type { LSPServer } from "../../src/lsp/server"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

function spawnDiagnosticServer() {
  const { spawn } = require("child_process")
  const serverPath = path.join(__dirname, "../fixture/lsp/diagnostic-fake-server.js")
  return {
    process: spawn(process.execPath, [serverPath], {
      stdio: "pipe",
    }),
  }
}

/**
 * Run an async function within an Instance.provide context so that
 * Bus.subscribe / Bus.publish (called inside waitForDiagnostics and
 * the publishDiagnostics handler) can resolve InstanceState.
 */
async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({
    directory: process.cwd(),
    fn,
  })
}

async function createClient() {
  const handle = spawnDiagnosticServer()
  return LSPClient.create({
    serverID: "diag-test",
    server: handle as unknown as LSPServer.Handle,
    root: process.cwd(),
  })
}

function triggerPublish(
  client: LSPClient.Info,
  opts: { uri: string; diagnostics?: any[]; delayMs?: number },
) {
  return client.connection.sendNotification("test/publishDiagnostics", {
    uri: opts.uri,
    diagnostics: opts.diagnostics ?? [],
    delayMs: opts.delayMs ?? 0,
  })
}

function triggerBurst(
  client: LSPClient.Info,
  opts: { uri: string; count: number; intervalMs: number; diagnostics?: any[] },
) {
  return client.connection.sendNotification("test/publishBurst", {
    uri: opts.uri,
    count: opts.count,
    intervalMs: opts.intervalMs,
    diagnostics: opts.diagnostics ?? [],
  })
}

function makeFileUri(name: string): string {
  return pathToFileURL(path.join(process.cwd(), name)).href
}

function filePath(name: string): string {
  return path.join(process.cwd(), name)
}

function makeDiag(line: number, msg: string, severity = 1) {
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: 10 },
    },
    severity,
    message: msg,
  }
}

describe("waitForDiagnostics — adversarial", () => {
  beforeEach(async () => {
    await Log.init({ print: false })
  })

  // ── Attack 1: High-latency publication ─────────────────────────

  test("resolves 'published' when diagnostics arrive after delay (within timeout)", async () => {
    await withInstance(async () => {
      const client = await createClient()
      try {
        const targetUri = makeFileUri("slow-target.ts")
        const target = filePath("slow-target.ts")

        // Start waiting, then trigger a delayed publish (200ms)
        const waitPromise = client.waitForDiagnostics({ path: target })
        await triggerPublish(client, {
          uri: targetUri,
          diagnostics: [makeDiag(1, "Slow error")],
          delayMs: 200,
        })

        const result = await waitPromise
        expect(result.status).toBe("published")
        expect(result.duration_ms).toBeGreaterThan(0)
        expect(result.seq).toBeGreaterThan(0)
      } finally {
        await client.shutdown()
      }
    })
  })

  test("WaitResult has accurate duration_ms", async () => {
    await withInstance(async () => {
      const client = await createClient()
      try {
        const targetUri = makeFileUri("timing.ts")
        const target = filePath("timing.ts")

        const waitPromise = client.waitForDiagnostics({ path: target })
        await triggerPublish(client, {
          uri: targetUri,
          diagnostics: [makeDiag(1, "Timing check")],
          delayMs: 100,
        })

        const result = await waitPromise
        expect(result.duration_ms).toBeLessThan(3000)
        expect(result.status).toBe("published")
      } finally {
        await client.shutdown()
      }
    })
  })

  // ── Attack 2: Non-target file diagnostics first ────────────────

  test("ignores diagnostics for non-target files", async () => {
    await withInstance(async () => {
      const client = await createClient()
      try {
        const targetUri = makeFileUri("target.ts")
        const target = filePath("target.ts")
        const decoyUri = makeFileUri("decoy.ts")

        const waitPromise = client.waitForDiagnostics({ path: target })

        // Publish for decoy immediately
        await triggerPublish(client, {
          uri: decoyUri,
          diagnostics: [makeDiag(1, "Decoy error")],
        })

        // Then publish for real target
        await triggerPublish(client, {
          uri: targetUri,
          diagnostics: [makeDiag(1, "Real error")],
          delayMs: 150,
        })

        const result = await waitPromise
        expect(result.status).toBe("published")
        expect(result.seq).toBeGreaterThan(0)
      } finally {
        await client.shutdown()
      }
    })
  })

  test("decoy-only diagnostics do not prevent quiet timeout", async () => {
    await withInstance(async () => {
      const client = await createClient()
      try {
        const target = filePath("lonely-target.ts")
        const decoyUri = makeFileUri("noise.ts")

        const waitPromise = client.waitForDiagnostics({ path: target })

        // Only publish for decoy
        await triggerPublish(client, {
          uri: decoyUri,
          diagnostics: [makeDiag(1, "Noise error")],
        })

        const result = await waitPromise
        expect(result.status).toBe("quiet_timeout")
      } finally {
        await client.shutdown()
      }
    })
  })

  // ── Attack 3: Duplicate/out-of-order publish events ────────────

  test("duplicate publishes produce correct final seq", async () => {
    await withInstance(async () => {
      const client = await createClient()
      try {
        const targetUri = makeFileUri("dup.ts")
        const target = filePath("dup.ts")

        const waitPromise = client.waitForDiagnostics({ path: target })

        // Publish same file 3 times rapidly
        await triggerPublish(client, {
          uri: targetUri,
          diagnostics: [makeDiag(1, "First")],
        })
        await triggerPublish(client, {
          uri: targetUri,
          diagnostics: [makeDiag(1, "First"), makeDiag(2, "Second")],
        })
        await triggerPublish(client, {
          uri: targetUri,
          diagnostics: [makeDiag(1, "First"), makeDiag(2, "Second"), makeDiag(3, "Third")],
        })

        const result = await waitPromise
        expect(result.status).toBe("published")
        expect(result.seq).toBeGreaterThanOrEqual(3)
        // Final diagnostics should reflect last publish
        expect(client.diagnostics.get(target)?.length).toBe(3)
      } finally {
        await client.shutdown()
      }
    })
  })

  test("stale diagnostics from before wait-start are ignored", async () => {
    await withInstance(async () => {
      const client = await createClient()
      try {
        const targetUri = makeFileUri("stale-check.ts")
        const target = filePath("stale-check.ts")

        // Publish BEFORE the wait begins to seed a seq
        await triggerPublish(client, {
          uri: targetUri,
          diagnostics: [makeDiag(1, "Pre-existing")],
        })

        // Allow the notification to propagate
        await new Promise((r) => setTimeout(r, 100))

        const seqBefore = client.diagnosticsSequence

        // Now start waiting — should NOT immediately resolve from prior publish
        const waitPromise = client.waitForDiagnostics({ path: target })

        // Publish fresh diagnostics after a delay
        await triggerPublish(client, {
          uri: targetUri,
          diagnostics: [makeDiag(1, "Fresh error")],
          delayMs: 200,
        })

        const result = await waitPromise
        expect(result.status).toBe("published")
        expect(result.seq).toBeGreaterThan(seqBefore)
      } finally {
        await client.shutdown()
      }
    })
  })

  // ── Attack 4: No publish event (quiet timeout path) ────────────

  test("quiet timeout fires when no diagnostics arrive at all", async () => {
    await withInstance(async () => {
      const client = await createClient()
      try {
        const target = filePath("silent.ts")

        const start = Date.now()
        const result = await client.waitForDiagnostics({ path: target })
        const elapsed = Date.now() - start

        expect(result.status).toBe("quiet_timeout")
        // Should resolve around DIAGNOSTICS_QUIET_MS (~400ms)
        expect(elapsed).toBeGreaterThanOrEqual(350)
        expect(elapsed).toBeLessThan(2000)
      } finally {
        await client.shutdown()
      }
    })
  })

  test("quiet timeout does not deadlock — sequential waits all resolve", async () => {
    await withInstance(async () => {
      const client = await createClient()
      try {
        const target = filePath("no-deadlock.ts")

        for (let i = 0; i < 3; i++) {
          const result = await client.waitForDiagnostics({ path: target })
          expect(["quiet_timeout", "timed_out"]).toContain(result.status)
        }
      } finally {
        await client.shutdown()
      }
    })
  })

  test("quiet timeout returns seq=0 for never-seen files", async () => {
    await withInstance(async () => {
      const client = await createClient()
      try {
        const target = filePath("brand-new.ts")

        const result = await client.waitForDiagnostics({ path: target })
        expect(result.status).toBe("quiet_timeout")
        expect(result.seq).toBe(0)
      } finally {
        await client.shutdown()
      }
    })
  })

  // ── Attack 5: Burst updates after first publish ────────────────

  test("burst of publishes resolves to 'published' with debounce settle", async () => {
    await withInstance(async () => {
      const client = await createClient()
      try {
        const targetUri = makeFileUri("burst.ts")
        const target = filePath("burst.ts")

        const waitPromise = client.waitForDiagnostics({ path: target })

        // Fire 5 publishes at 30ms intervals — debounce (150ms) should settle after the last
        await triggerBurst(client, {
          uri: targetUri,
          count: 5,
          intervalMs: 30,
          diagnostics: [makeDiag(1, "Burst diagnostic")],
        })

        const result = await waitPromise
        expect(result.status).toBe("published")
        expect(result.seq).toBeGreaterThanOrEqual(1)
      } finally {
        await client.shutdown()
      }
    })
  })

  test("burst followed by second-phase publish (two-phase LSP) settles correctly", async () => {
    await withInstance(async () => {
      const client = await createClient()
      try {
        const targetUri = makeFileUri("burst-settle.ts")
        const target = filePath("burst-settle.ts")

        const waitPromise = client.waitForDiagnostics({ path: target })

        // Phase 1: syntax errors (3 rapid publishes)
        await triggerBurst(client, {
          uri: targetUri,
          count: 3,
          intervalMs: 20,
          diagnostics: [makeDiag(1, "Syntax error")],
        })

        // Phase 2: semantic errors after a gap (arrives within debounce of phase 1)
        await triggerPublish(client, {
          uri: targetUri,
          diagnostics: [makeDiag(1, "Syntax error"), makeDiag(5, "Semantic error")],
          delayMs: 100,
        })

        const result = await waitPromise
        expect(result.status).toBe("published")
        const finalDiags = client.diagnostics.get(target)
        expect(finalDiags).toBeDefined()
        expect(finalDiags!.length).toBeGreaterThanOrEqual(1)
      } finally {
        await client.shutdown()
      }
    })
  })

  // ── Stability / determinism ────────────────────────────────────

  test("repeated runs produce stable outcomes", async () => {
    const results: LSPClient.WaitResult[] = []

    for (let i = 0; i < 3; i++) {
      await withInstance(async () => {
        const client = await createClient()
        try {
          const targetUri = makeFileUri(`determinism-${i}.ts`)
          const target = filePath(`determinism-${i}.ts`)

          const waitPromise = client.waitForDiagnostics({ path: target })
          await triggerPublish(client, {
            uri: targetUri,
            diagnostics: [makeDiag(1, "Determinism error")],
            delayMs: 50,
          })

          results.push(await waitPromise)
        } finally {
          await client.shutdown()
        }
      })
    }

    for (const r of results) {
      expect(r.status).toBe("published")
      expect(r.seq).toBeGreaterThan(0)
    }
  })

  test("diagnosticsSequence counter is monotonically increasing", async () => {
    await withInstance(async () => {
      const client = await createClient()
      try {
        const targetUri = makeFileUri("mono.ts")
        const seqs: number[] = []

        for (let i = 0; i < 5; i++) {
          await triggerPublish(client, {
            uri: targetUri,
            diagnostics: [makeDiag(i, `Error ${i}`)],
          })
          await new Promise((r) => setTimeout(r, 50))
          seqs.push(client.diagnosticsSequence)
        }

        for (let i = 1; i < seqs.length; i++) {
          expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
        }
      } finally {
        await client.shutdown()
      }
    })
  })
})
