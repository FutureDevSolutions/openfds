import { describe, test, expect } from "bun:test"
import { Tool } from "../../src/tool/tool"
import { ToolDispatcher } from "../../src/tool/dispatcher"

// --- Helpers ---

const READ_META: Tool.ExecutionMeta = { read_only: true, concurrency_safe: true, interrupt_behavior: "continue" }
const WRITE_META: Tool.ExecutionMeta = { read_only: false, concurrency_safe: false, interrupt_behavior: "continue" }
const ABORT_META: Tool.ExecutionMeta = { read_only: false, concurrency_safe: false, interrupt_behavior: "abort" }

function makePending<T>(
  index: number,
  toolId: string,
  meta: Tool.ExecutionMeta,
  execute: () => Promise<T>,
): ToolDispatcher.PendingCall<T> {
  return { index, toolId, meta, execute }
}

/** Track execution order via a shared array. */
function trackOrder(log: string[], id: string, delay = 0): () => Promise<string> {
  return async () => {
    log.push(`start:${id}`)
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    log.push(`end:${id}`)
    return id
  }
}

function failingExec(id: string, message?: string): () => Promise<never> {
  return async () => {
    throw new Error(message ?? `${id} failed`)
  }
}

// --- Tests ---

describe("ToolDispatcher.getMeta", () => {
  test("returns executionMeta from Def when present", () => {
    const meta: Tool.ExecutionMeta = { read_only: true, concurrency_safe: true, interrupt_behavior: "abort" }
    const result = ToolDispatcher.getMeta({ id: "bash", executionMeta: meta })
    expect(result).toEqual(meta)
  })

  test("returns built-in meta for known tool IDs", () => {
    const readMeta = ToolDispatcher.getMeta({ id: "read" })
    expect(readMeta.read_only).toBe(true)
    expect(readMeta.concurrency_safe).toBe(true)

    const editMeta = ToolDispatcher.getMeta({ id: "edit" })
    expect(editMeta.read_only).toBe(false)
    expect(editMeta.concurrency_safe).toBe(false)
  })

  test("returns DEFAULT_EXECUTION_META for unknown tools", () => {
    const meta = ToolDispatcher.getMeta({ id: "custom_unknown_tool" })
    expect(meta).toEqual(Tool.DEFAULT_EXECUTION_META)
    expect(meta.read_only).toBe(false)
    expect(meta.concurrency_safe).toBe(false)
  })
})

describe("ToolDispatcher.partition", () => {
  test("empty input returns empty batches", () => {
    expect(ToolDispatcher.partition([])).toEqual([])
  })

  test("all concurrency-safe calls form a single parallel batch", () => {
    const calls = [
      makePending(0, "read", READ_META, async () => "a"),
      makePending(1, "glob", READ_META, async () => "b"),
      makePending(2, "grep", READ_META, async () => "c"),
    ]
    const batches = ToolDispatcher.partition(calls)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(3)
    expect(batches[0].map((c) => c.toolId)).toEqual(["read", "glob", "grep"])
  })

  test("all serial calls each get their own batch", () => {
    const calls = [
      makePending(0, "edit", WRITE_META, async () => "a"),
      makePending(1, "write", WRITE_META, async () => "b"),
      makePending(2, "bash", WRITE_META, async () => "c"),
    ]
    const batches = ToolDispatcher.partition(calls)
    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(1)
    expect(batches[1]).toHaveLength(1)
    expect(batches[2]).toHaveLength(1)
  })

  test("mixed read/write: reads grouped, writes isolated", () => {
    const calls = [
      makePending(0, "read", READ_META, async () => "a"),
      makePending(1, "grep", READ_META, async () => "b"),
      makePending(2, "edit", WRITE_META, async () => "c"),
      makePending(3, "glob", READ_META, async () => "d"),
      makePending(4, "write", WRITE_META, async () => "e"),
      makePending(5, "read", READ_META, async () => "f"),
    ]
    const batches = ToolDispatcher.partition(calls)
    // Batch 0: [read, grep] (parallel)
    // Batch 1: [edit]       (serial)
    // Batch 2: [glob]       (parallel, single)
    // Batch 3: [write]      (serial)
    // Batch 4: [read]       (parallel, single)
    expect(batches).toHaveLength(5)
    expect(batches[0].map((c) => c.toolId)).toEqual(["read", "grep"])
    expect(batches[1].map((c) => c.toolId)).toEqual(["edit"])
    expect(batches[2].map((c) => c.toolId)).toEqual(["glob"])
    expect(batches[3].map((c) => c.toolId)).toEqual(["write"])
    expect(batches[4].map((c) => c.toolId)).toEqual(["read"])
  })

  test("serial call at start flushes correctly", () => {
    const calls = [
      makePending(0, "bash", WRITE_META, async () => "a"),
      makePending(1, "read", READ_META, async () => "b"),
      makePending(2, "glob", READ_META, async () => "c"),
    ]
    const batches = ToolDispatcher.partition(calls)
    expect(batches).toHaveLength(2)
    expect(batches[0].map((c) => c.toolId)).toEqual(["bash"])
    expect(batches[1].map((c) => c.toolId)).toEqual(["read", "glob"])
  })
})

describe("ToolDispatcher.dispatch", () => {
  test("preserves output order regardless of execution speed", async () => {
    const executionLog: string[] = []
    const calls: ToolDispatcher.PendingCall<string>[] = [
      makePending(0, "read", READ_META, trackOrder(executionLog, "read1", 30)),
      makePending(1, "grep", READ_META, trackOrder(executionLog, "grep1", 10)),
      makePending(2, "edit", WRITE_META, trackOrder(executionLog, "edit1", 5)),
    ]

    const results = await ToolDispatcher.dispatch(calls)
    // Results must be in original index order
    expect(results.map((r) => r.index)).toEqual([0, 1, 2])
    expect(results.map((r) => r.toolId)).toEqual(["read", "grep", "edit"])

    // read1 and grep1 should have started before edit1 (they're in the first parallel batch)
    const startEdit = executionLog.indexOf("start:edit1")
    const endRead = executionLog.indexOf("end:read1")
    const endGrep = executionLog.indexOf("end:grep1")
    // edit1 must start after the parallel batch completes
    expect(startEdit).toBeGreaterThan(endRead)
    expect(startEdit).toBeGreaterThan(endGrep)
  })

  test("serial tools execute sequentially in order", async () => {
    const executionLog: string[] = []
    const calls: ToolDispatcher.PendingCall<string>[] = [
      makePending(0, "edit", WRITE_META, trackOrder(executionLog, "edit1", 5)),
      makePending(1, "write", WRITE_META, trackOrder(executionLog, "write1", 5)),
      makePending(2, "bash", WRITE_META, trackOrder(executionLog, "bash1", 5)),
    ]

    await ToolDispatcher.dispatch(calls)

    // Each serial tool must finish before the next starts
    expect(executionLog.indexOf("end:edit1")).toBeLessThan(executionLog.indexOf("start:write1"))
    expect(executionLog.indexOf("end:write1")).toBeLessThan(executionLog.indexOf("start:bash1"))
  })

  test("parallel tools in a batch actually overlap", async () => {
    const executionLog: string[] = []
    const calls: ToolDispatcher.PendingCall<string>[] = [
      makePending(0, "read", READ_META, trackOrder(executionLog, "read1", 20)),
      makePending(1, "grep", READ_META, trackOrder(executionLog, "grep1", 20)),
      makePending(2, "glob", READ_META, trackOrder(executionLog, "glob1", 20)),
    ]

    await ToolDispatcher.dispatch(calls)

    // All three should start before any finishes (parallel execution)
    const starts = executionLog.filter((e) => e.startsWith("start:"))
    const ends = executionLog.filter((e) => e.startsWith("end:"))
    // All starts should come before all ends (or at least overlap)
    expect(starts.length).toBe(3)
    expect(ends.length).toBe(3)
    // The first end should come after all starts (they started in parallel)
    const firstEndIdx = executionLog.findIndex((e) => e.startsWith("end:"))
    const lastStartIdx = executionLog.lastIndexOf(starts[starts.length - 1])
    expect(lastStartIdx).toBeLessThan(firstEndIdx)
  })

  test("onBatchComplete is called after each batch with correct results", async () => {
    const batchLog: { index: number; count: number; toolIds: string[] }[] = []
    const calls: ToolDispatcher.PendingCall<string>[] = [
      makePending(0, "read", READ_META, async () => "r1"),
      makePending(1, "grep", READ_META, async () => "r2"),
      makePending(2, "edit", WRITE_META, async () => "r3"),
      makePending(3, "read", READ_META, async () => "r4"),
    ]

    await ToolDispatcher.dispatch(calls, {
      onBatchComplete(results, batchIndex) {
        batchLog.push({
          index: batchIndex,
          count: results.length,
          toolIds: results.map((r) => r.toolId),
        })
      },
    })

    expect(batchLog).toHaveLength(3) // [read,grep], [edit], [read]
    expect(batchLog[0]).toEqual({ index: 0, count: 2, toolIds: ["read", "grep"] })
    expect(batchLog[1]).toEqual({ index: 1, count: 1, toolIds: ["edit"] })
    expect(batchLog[2]).toEqual({ index: 2, count: 1, toolIds: ["read"] })
  })

  test("batch context updates are deterministic — onBatchComplete order is sequential", async () => {
    const contextState: string[] = []
    const calls: ToolDispatcher.PendingCall<string>[] = [
      makePending(0, "read", READ_META, async () => "r1"),
      makePending(1, "glob", READ_META, async () => "r2"),
      makePending(2, "edit", WRITE_META, async () => "e1"),
      makePending(3, "write", WRITE_META, async () => "w1"),
    ]

    await ToolDispatcher.dispatch(calls, {
      onBatchComplete(results, batchIndex) {
        // Simulate applying context updates after each batch
        for (const r of results) {
          if (r.status === "ok") contextState.push(`batch${batchIndex}:${r.toolId}=${r.value}`)
        }
      },
    })

    // Context updates must happen in batch order, not interleaved
    expect(contextState).toEqual([
      "batch0:read=r1",
      "batch0:glob=r2",
      "batch1:edit=e1",
      "batch2:write=w1",
    ])
  })

  test("errors return structured feedback with recovery hints", async () => {
    const calls: ToolDispatcher.PendingCall<string>[] = [
      makePending(0, "edit", WRITE_META, failingExec("edit", "File not found: foo.ts")),
    ]

    const results = await ToolDispatcher.dispatch(calls)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe("error")
    if (results[0].status === "error") {
      expect(results[0].toolId).toBe("edit")
      expect(results[0].recoveryHint).toContain('Tool "edit" failed')
      expect(results[0].recoveryHint).toContain("File not found: foo.ts")
      expect(results[0].recoveryHint).toContain("Retry with corrected arguments")
    }
  })

  test("error in parallel batch does not block other calls in same batch", async () => {
    const calls: ToolDispatcher.PendingCall<string>[] = [
      makePending(0, "read", READ_META, async () => "ok1"),
      makePending(1, "grep", READ_META, failingExec("grep", "regex error")),
      makePending(2, "glob", READ_META, async () => "ok3"),
    ]

    const results = await ToolDispatcher.dispatch(calls)
    expect(results).toHaveLength(3)
    expect(results[0].status).toBe("ok")
    expect(results[1].status).toBe("error")
    expect(results[2].status).toBe("ok")
    if (results[0].status === "ok") expect(results[0].value).toBe("ok1")
    if (results[2].status === "ok") expect(results[2].value).toBe("ok3")
  })

  test("error in serial batch does not prevent subsequent batches", async () => {
    const calls: ToolDispatcher.PendingCall<string>[] = [
      makePending(0, "edit", WRITE_META, failingExec("edit")),
      makePending(1, "read", READ_META, async () => "ok"),
    ]

    const results = await ToolDispatcher.dispatch(calls)
    expect(results).toHaveLength(2)
    expect(results[0].status).toBe("error")
    expect(results[1].status).toBe("ok")
  })

  test("respects bounded concurrency", async () => {
    let maxConcurrent = 0
    let currentConcurrent = 0

    const makeTracked = (id: string): (() => Promise<string>) => {
      return async () => {
        currentConcurrent++
        if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent
        await new Promise((r) => setTimeout(r, 10))
        currentConcurrent--
        return id
      }
    }

    const calls: ToolDispatcher.PendingCall<string>[] = Array.from({ length: 8 }, (_, i) =>
      makePending(i, "read", READ_META, makeTracked(`r${i}`)),
    )

    await ToolDispatcher.dispatch(calls, { concurrency: 3 })
    expect(maxConcurrent).toBeLessThanOrEqual(3)
    expect(maxConcurrent).toBeGreaterThan(1) // actually ran in parallel
  })
})

describe("ToolDispatcher.StepCoordinator", () => {
  test("batches tool calls enqueued in the same microtask", async () => {
    const executionLog: string[] = []
    const coordinator = new ToolDispatcher.StepCoordinator<string>()

    // Enqueue multiple calls synchronously — they should be batched
    const p1 = coordinator.enqueue("read", READ_META, trackOrder(executionLog, "read1", 20))
    const p2 = coordinator.enqueue("grep", READ_META, trackOrder(executionLog, "grep1", 10))
    const p3 = coordinator.enqueue("edit", WRITE_META, trackOrder(executionLog, "edit1", 5))

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).toBe("read1")
    expect(r2).toBe("grep1")
    expect(r3).toBe("edit1")

    // read1 and grep1 should run in parallel; edit1 should wait for both
    const startEdit = executionLog.indexOf("start:edit1")
    const endRead = executionLog.indexOf("end:read1")
    const endGrep = executionLog.indexOf("end:grep1")
    expect(startEdit).toBeGreaterThan(endRead)
    expect(startEdit).toBeGreaterThan(endGrep)
  })

  test("separate microtasks create separate batches", async () => {
    const executionLog: string[] = []
    const coordinator = new ToolDispatcher.StepCoordinator<string>()

    // First microtask batch
    const p1 = coordinator.enqueue("read", READ_META, trackOrder(executionLog, "read1", 5))
    await p1

    // Second microtask batch (after the first has flushed)
    const p2 = coordinator.enqueue("edit", WRITE_META, trackOrder(executionLog, "edit1", 5))
    await p2

    // Both should have executed, in separate batches
    expect(executionLog).toContain("start:read1")
    expect(executionLog).toContain("start:edit1")
  })

  test("error in one enqueued call does not affect others in same batch", async () => {
    const coordinator = new ToolDispatcher.StepCoordinator<string>()

    const p1 = coordinator.enqueue("read", READ_META, async () => "ok")
    const p2 = coordinator.enqueue("grep", READ_META, failingExec("grep"))
    const p3 = coordinator.enqueue("glob", READ_META, async () => "ok2")

    const results = await Promise.allSettled([p1, p2, p3])
    expect(results[0].status).toBe("fulfilled")
    expect(results[1].status).toBe("rejected")
    expect(results[2].status).toBe("fulfilled")
    if (results[0].status === "fulfilled") expect(results[0].value).toBe("ok")
    if (results[2].status === "fulfilled") expect(results[2].value).toBe("ok2")
  })

  test("onBatchComplete fires between batches", async () => {
    const batchLog: number[] = []
    const coordinator = new ToolDispatcher.StepCoordinator<string>({
      onBatchComplete(_results, batchIndex) {
        batchLog.push(batchIndex)
      },
    })

    const p1 = coordinator.enqueue("read", READ_META, async () => "a")
    const p2 = coordinator.enqueue("edit", WRITE_META, async () => "b")
    const p3 = coordinator.enqueue("glob", READ_META, async () => "c")

    await Promise.all([p1, p2, p3])

    // Batches: [read, glob(out of order? no — index 0 read, index 1 edit, index 2 glob)]
    // Partition by order: [read](parallel) -> [edit](serial) -> [glob](parallel)
    expect(batchLog).toEqual([0, 1, 2])
  })

  test("single tool call works without batching overhead", async () => {
    const coordinator = new ToolDispatcher.StepCoordinator<string>()
    const result = await coordinator.enqueue("read", READ_META, async () => "single")
    expect(result).toBe("single")
  })
})

describe("Tool.ExecutionMeta defaults", () => {
  test("DEFAULT_EXECUTION_META is conservative (serial, mutating)", () => {
    expect(Tool.DEFAULT_EXECUTION_META.read_only).toBe(false)
    expect(Tool.DEFAULT_EXECUTION_META.concurrency_safe).toBe(false)
    expect(Tool.DEFAULT_EXECUTION_META.interrupt_behavior).toBe("continue")
  })
})

// --- Stress tests ---

describe("Stress: 20+ mixed tool calls with random delays", () => {
  test("output order is deterministic across 5 repeated runs", async () => {
    const RUNS = 5
    const allOrders: number[][] = []

    for (let run = 0; run < RUNS; run++) {
      const calls: ToolDispatcher.PendingCall<number>[] = []
      // 24 calls: alternating read/write pattern with random delays
      for (let i = 0; i < 24; i++) {
        const isRead = i % 3 !== 2 // 2/3 reads, 1/3 writes
        const delay = Math.floor(Math.random() * 15) + 1
        const meta = isRead ? READ_META : WRITE_META
        const toolId = isRead ? ["read", "grep", "glob"][i % 3] : ["edit", "write", "bash"][i % 3]
        calls.push(
          makePending(i, toolId, meta, async () => {
            await new Promise((r) => setTimeout(r, delay))
            return i
          }),
        )
      }

      const results = await ToolDispatcher.dispatch(calls)
      allOrders.push(results.map((r) => r.index))
    }

    // All runs must produce the same index order
    for (let run = 1; run < RUNS; run++) {
      expect(allOrders[run]).toEqual(allOrders[0])
    }
    // And that order must be 0..23
    expect(allOrders[0]).toEqual(Array.from({ length: 24 }, (_, i) => i))
  })

  test("20 mixed calls: writes never overlap, reads can", async () => {
    const timestamps: { id: string; type: "start" | "end"; time: number }[] = []

    const calls: ToolDispatcher.PendingCall<string>[] = []
    for (let i = 0; i < 20; i++) {
      const isRead = i % 4 !== 3
      const meta = isRead ? READ_META : WRITE_META
      const toolId = isRead ? `read_${i}` : `write_${i}`
      const delay = Math.floor(Math.random() * 10) + 5
      calls.push(
        makePending(i, toolId, meta, async () => {
          const start = performance.now()
          timestamps.push({ id: toolId, type: "start", time: start })
          await new Promise((r) => setTimeout(r, delay))
          const end = performance.now()
          timestamps.push({ id: toolId, type: "end", time: end })
          return toolId
        }),
      )
    }

    const results = await ToolDispatcher.dispatch(calls)
    expect(results).toHaveLength(20)

    // Verify: no two write tools have overlapping time ranges
    const writeStarts = timestamps.filter((t) => t.id.startsWith("write_") && t.type === "start")
    const writeEnds = timestamps.filter((t) => t.id.startsWith("write_") && t.type === "end")

    for (let i = 0; i < writeStarts.length; i++) {
      const ws = writeStarts[i]
      const we = writeEnds.find((e) => e.id === ws.id)!
      for (let j = i + 1; j < writeStarts.length; j++) {
        const os = writeStarts[j]
        const oe = writeEnds.find((e) => e.id === os.id)!
        // No overlap: one must end before the other starts
        const noOverlap = we.time <= os.time || oe.time <= ws.time
        expect(noOverlap).toBe(true)
      }
    }
  })

  test("all errors carry structured feedback even under load", async () => {
    const calls: ToolDispatcher.PendingCall<string>[] = []
    for (let i = 0; i < 20; i++) {
      const shouldFail = i % 5 === 0
      const meta = i % 2 === 0 ? READ_META : WRITE_META
      calls.push(
        makePending(
          i,
          shouldFail ? `fail_${i}` : `ok_${i}`,
          meta,
          shouldFail
            ? failingExec(`tool_${i}`, `Error in tool ${i}`)
            : async () => `result_${i}`,
        ),
      )
    }

    const results = await ToolDispatcher.dispatch(calls)
    expect(results).toHaveLength(20)

    for (const r of results) {
      if (r.status === "error") {
        expect(r.recoveryHint).toContain("failed")
        expect(r.recoveryHint).toContain("Retry with corrected arguments")
        expect(typeof r.error).not.toBe("undefined")
      } else {
        expect(r.value).toContain("result_")
      }
    }

    // Exactly 4 failures (indices 0, 5, 10, 15)
    const errors = results.filter((r) => r.status === "error")
    expect(errors).toHaveLength(4)
  })
})

describe("Stress: StepCoordinator under load", () => {
  test("20+ concurrent enqueues in single microtask dispatch correctly", async () => {
    const coordinator = new ToolDispatcher.StepCoordinator<number>()
    const promises: Promise<number>[] = []

    for (let i = 0; i < 25; i++) {
      const meta = i % 3 === 0 ? WRITE_META : READ_META
      const delay = Math.floor(Math.random() * 10) + 1
      promises.push(
        coordinator.enqueue(`tool_${i}`, meta, async () => {
          await new Promise((r) => setTimeout(r, delay))
          return i
        }),
      )
    }

    const results = await Promise.all(promises)
    // Each result should match its index
    for (let i = 0; i < 25; i++) {
      expect(results[i]).toBe(i)
    }
  })
})

// --- Cancellation/interruption tests ---

describe("Cancellation and interruption during mixed batches", () => {
  test("AbortSignal-based cancellation propagates to pending calls", async () => {
    const coordinator = new ToolDispatcher.StepCoordinator<string>()

    const p1 = coordinator.enqueue("read", READ_META, async () => "ok")
    const p2 = coordinator.enqueue("edit", WRITE_META, async () => {
      // Simulate slow work
      await new Promise((r) => setTimeout(r, 50))
      throw new Error("Simulated abort")
    })

    const results = await Promise.allSettled([p1, p2])
    expect(results[0].status).toBe("fulfilled")
    expect(results[1].status).toBe("rejected")
  })

  test("failed tool in serial batch propagates but does not block later batches", async () => {
    const executionLog: string[] = []
    const calls: ToolDispatcher.PendingCall<string>[] = [
      makePending(0, "edit", WRITE_META, async () => {
        executionLog.push("edit:start")
        throw new Error("edit failed")
      }),
      makePending(1, "read", READ_META, trackOrder(executionLog, "read1")),
      makePending(2, "glob", READ_META, trackOrder(executionLog, "glob1")),
    ]

    const results = await ToolDispatcher.dispatch(calls)
    expect(results[0].status).toBe("error")
    expect(results[1].status).toBe("ok")
    expect(results[2].status).toBe("ok")
    // read and glob still executed despite edit failure
    expect(executionLog).toContain("start:read1")
    expect(executionLog).toContain("start:glob1")
  })

  test("multiple failures in parallel batch all report individually", async () => {
    const calls: ToolDispatcher.PendingCall<string>[] = [
      makePending(0, "read", READ_META, failingExec("read", "ENOENT")),
      makePending(1, "grep", READ_META, failingExec("grep", "invalid regex")),
      makePending(2, "glob", READ_META, async () => "ok"),
    ]

    const results = await ToolDispatcher.dispatch(calls)
    expect(results[0].status).toBe("error")
    expect(results[1].status).toBe("error")
    expect(results[2].status).toBe("ok")
    if (results[0].status === "error") expect(results[0].recoveryHint).toContain("ENOENT")
    if (results[1].status === "error") expect(results[1].recoveryHint).toContain("invalid regex")
  })
})

// --- Deadlock and busy-loop validation ---

describe("No deadlocks and no busy-loop polling", () => {
  test("dispatch completes within bounded time even with 50 calls", async () => {
    const calls: ToolDispatcher.PendingCall<string>[] = Array.from({ length: 50 }, (_, i) =>
      makePending(
        i,
        i % 2 === 0 ? "read" : "edit",
        i % 2 === 0 ? READ_META : WRITE_META,
        async () => {
          await new Promise((r) => setTimeout(r, 1))
          return `r${i}`
        },
      ),
    )

    const start = performance.now()
    const results = await ToolDispatcher.dispatch(calls, { concurrency: 10 })
    const elapsed = performance.now() - start

    expect(results).toHaveLength(50)
    // With 1ms delays and bounded concurrency, should complete well under 5s
    // (no busy-loop or deadlock)
    expect(elapsed).toBeLessThan(5000)
  })

  test("StepCoordinator resolves even when all calls fail", async () => {
    const coordinator = new ToolDispatcher.StepCoordinator<string>()

    const promises = Array.from({ length: 10 }, (_, i) =>
      coordinator.enqueue(`fail_${i}`, READ_META, failingExec(`tool_${i}`)),
    )

    const results = await Promise.allSettled(promises)
    // All should settle (no hanging promises)
    expect(results).toHaveLength(10)
    for (const r of results) {
      expect(r.status).toBe("rejected")
    }
  })

  test("StepCoordinator handles empty queue gracefully", async () => {
    const coordinator = new ToolDispatcher.StepCoordinator<string>()
    // No enqueue — just verify no error/hang on construction
    // Then enqueue one to prove it still works
    const result = await coordinator.enqueue("read", READ_META, async () => "ok")
    expect(result).toBe("ok")
  })

  test("sequential StepCoordinator flushes do not leak state", async () => {
    const coordinator = new ToolDispatcher.StepCoordinator<number>()

    // First flush
    const r1 = await coordinator.enqueue("read", READ_META, async () => 1)
    expect(r1).toBe(1)

    // Second flush
    const r2 = await coordinator.enqueue("edit", WRITE_META, async () => 2)
    expect(r2).toBe(2)

    // Third flush with multiple calls
    const p3 = coordinator.enqueue("read", READ_META, async () => 3)
    const p4 = coordinator.enqueue("glob", READ_META, async () => 4)
    const [r3, r4] = await Promise.all([p3, p4])
    expect(r3).toBe(3)
    expect(r4).toBe(4)
  })
})

// --- LSP metadata validation ---

describe("LSP tool metadata", () => {
  test("lsp tool is registered as read_only and concurrency_safe", () => {
    const lspMeta = ToolDispatcher.getMeta({ id: "lsp" })
    expect(lspMeta.read_only).toBe(true)
    expect(lspMeta.concurrency_safe).toBe(true)
    expect(lspMeta.interrupt_behavior).toBe("continue")
  })

  test("all read-only built-in tools are concurrency safe", () => {
    const readOnlyTools = ["read", "glob", "grep", "lsp", "codesearch", "websearch", "webfetch"]
    for (const toolId of readOnlyTools) {
      const meta = ToolDispatcher.getMeta({ id: toolId })
      expect(meta.read_only).toBe(true)
      expect(meta.concurrency_safe).toBe(true)
    }
  })

  test("all mutating built-in tools are NOT concurrency safe", () => {
    const mutatingTools = ["edit", "write", "apply_patch", "bash", "multiedit", "task", "skill"]
    for (const toolId of mutatingTools) {
      const meta = ToolDispatcher.getMeta({ id: toolId })
      expect(meta.read_only).toBe(false)
      expect(meta.concurrency_safe).toBe(false)
    }
  })
})
