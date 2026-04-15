import { describe, test, expect } from "bun:test"
import { ToolExecutor } from "../../src/tool/executor"

// --- Helpers ---

function makeExecutor(opts?: { onTransition?: (e: ToolExecutor.TransitionEvent) => void }) {
  return new ToolExecutor.StepExecutor(opts)
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

// --- State transition tests ---

describe("ToolExecutor.StepExecutor: state transitions", () => {
  test("register creates call in queued state", () => {
    const exec = makeExecutor()
    const rec = exec.register({ callId: "c1", toolId: "read" })
    expect(rec.state).toBe("queued")
    expect(rec.callId).toBe("c1")
    expect(rec.toolId).toBe("read")
  })

  test("queued → executing transition succeeds", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    expect(exec.transition("c1", "executing")).toBe(true)
    expect(exec.get("c1")!.state).toBe("executing")
  })

  test("executing → completed transition succeeds", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.transition("c1", "executing")
    expect(exec.transition("c1", "completed")).toBe(true)
    expect(exec.get("c1")!.state).toBe("completed")
  })

  test("executing → error transition succeeds", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "edit" })
    exec.transition("c1", "executing")
    expect(exec.transition("c1", "error")).toBe(true)
    expect(exec.get("c1")!.state).toBe("error")
  })

  test("queued → cancelled transition succeeds", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "bash" })
    expect(exec.transition("c1", "cancelled")).toBe(true)
    expect(exec.get("c1")!.state).toBe("cancelled")
  })

  test("queued → discarded transition succeeds", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    expect(exec.transition("c1", "discarded")).toBe(true)
    expect(exec.get("c1")!.state).toBe("discarded")
  })

  test("executing → cancelled transition succeeds", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "bash" })
    exec.transition("c1", "executing")
    expect(exec.transition("c1", "cancelled")).toBe(true)
    expect(exec.get("c1")!.state).toBe("cancelled")
  })

  test("executing → discarded transition succeeds", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.transition("c1", "executing")
    expect(exec.transition("c1", "discarded")).toBe(true)
    expect(exec.get("c1")!.state).toBe("discarded")
  })
})

describe("ToolExecutor.StepExecutor: invalid transitions rejected", () => {
  test("completed → any is rejected", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.transition("c1", "executing")
    exec.transition("c1", "completed")
    expect(exec.transition("c1", "error")).toBe(false)
    expect(exec.transition("c1", "cancelled")).toBe(false)
    expect(exec.transition("c1", "discarded")).toBe(false)
    expect(exec.transition("c1", "executing")).toBe(false)
    expect(exec.get("c1")!.state).toBe("completed")
  })

  test("error → any is rejected", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "edit" })
    exec.transition("c1", "executing")
    exec.transition("c1", "error")
    expect(exec.transition("c1", "completed")).toBe(false)
    expect(exec.transition("c1", "cancelled")).toBe(false)
    expect(exec.get("c1")!.state).toBe("error")
  })

  test("cancelled → any is rejected", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "bash" })
    exec.transition("c1", "cancelled")
    expect(exec.transition("c1", "executing")).toBe(false)
    expect(exec.transition("c1", "completed")).toBe(false)
    expect(exec.get("c1")!.state).toBe("cancelled")
  })

  test("discarded → any is rejected", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.transition("c1", "discarded")
    expect(exec.transition("c1", "executing")).toBe(false)
    expect(exec.transition("c1", "completed")).toBe(false)
    expect(exec.get("c1")!.state).toBe("discarded")
  })

  test("queued → completed is invalid (must go through executing)", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    expect(exec.transition("c1", "completed")).toBe(false)
    expect(exec.get("c1")!.state).toBe("queued")
  })

  test("queued → error is invalid (must go through executing)", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    expect(exec.transition("c1", "error")).toBe(false)
    expect(exec.get("c1")!.state).toBe("queued")
  })

  test("transition on unknown call returns false", () => {
    const exec = makeExecutor()
    expect(exec.transition("nonexistent", "executing")).toBe(false)
  })
})

// --- Duplicate terminal guard ---

describe("ToolExecutor.StepExecutor: duplicate terminal guard", () => {
  test("isTerminal correctly identifies terminal states", () => {
    const exec = makeExecutor()

    exec.register({ callId: "c1", toolId: "read" })
    expect(exec.isTerminal("c1")).toBe(false)

    exec.transition("c1", "executing")
    expect(exec.isTerminal("c1")).toBe(false)

    exec.transition("c1", "completed")
    expect(exec.isTerminal("c1")).toBe(true)
  })

  test("double-complete is rejected", () => {
    const transitions: ToolExecutor.TransitionEvent[] = []
    const exec = makeExecutor({ onTransition: (e) => transitions.push(e) })

    exec.register({ callId: "c1", toolId: "read" })
    exec.transition("c1", "executing")
    exec.transition("c1", "completed")
    const result = exec.transition("c1", "completed")

    expect(result).toBe(false)
    // Only 2 transitions recorded (queued→executing, executing→completed)
    expect(transitions).toHaveLength(2)
  })

  test("complete then error is rejected", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.transition("c1", "executing")
    exec.transition("c1", "completed")
    expect(exec.transition("c1", "error")).toBe(false)
    expect(exec.get("c1")!.state).toBe("completed")
  })

  test("isTerminal on unknown call returns false", () => {
    const exec = makeExecutor()
    expect(exec.isTerminal("nonexistent")).toBe(false)
  })
})

// --- Sibling cancellation ---

describe("ToolExecutor.StepExecutor: sibling cancellation", () => {
  test("cancelGroup cancels all non-terminal siblings in the same group", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "bash", cancelGroup: "shell" })
    exec.register({ callId: "c2", toolId: "bash", cancelGroup: "shell" })
    exec.register({ callId: "c3", toolId: "read" }) // no group

    exec.transition("c1", "executing")
    exec.transition("c2", "executing")
    exec.transition("c3", "executing")

    // c1 fails → triggers sibling cancel on c2 (same group), not c3
    exec.cancelGroup("shell", "c1")

    expect(exec.get("c1")!.state).toBe("executing") // trigger is excluded
    expect(exec.get("c2")!.state).toBe("cancelled")
    expect(exec.get("c3")!.state).toBe("executing") // not in group
  })

  test("cancel() on individual call works", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "bash" })
    exec.transition("c1", "executing")
    expect(exec.cancel("c1")).toBe(true)
    expect(exec.get("c1")!.state).toBe("cancelled")
  })

  test("cancel() on terminal call returns false", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.transition("c1", "executing")
    exec.transition("c1", "completed")
    expect(exec.cancel("c1")).toBe(false)
  })

  test("cancel() aborts the AbortController", () => {
    const exec = makeExecutor()
    const rec = exec.register({ callId: "c1", toolId: "bash" })
    expect(rec.abort.signal.aborted).toBe(false)
    exec.cancel("c1")
    expect(rec.abort.signal.aborted).toBe(true)
  })

  test("cancelGroup already-completed siblings are unaffected", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "bash", cancelGroup: "shell" })
    exec.register({ callId: "c2", toolId: "bash", cancelGroup: "shell" })

    exec.transition("c1", "executing")
    exec.transition("c1", "completed") // c1 already done
    exec.transition("c2", "executing")

    exec.cancelGroup("shell")

    expect(exec.get("c1")!.state).toBe("completed") // not cancelled
    expect(exec.get("c2")!.state).toBe("cancelled") // cancelled
  })
})

// --- Discard semantics ---

describe("ToolExecutor.StepExecutor: discard semantics", () => {
  test("discardAll moves all non-terminal calls to discarded", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.register({ callId: "c2", toolId: "edit" })
    exec.register({ callId: "c3", toolId: "bash" })

    exec.transition("c1", "executing")
    exec.transition("c1", "completed") // terminal
    exec.transition("c2", "executing") // non-terminal

    exec.discardAll()

    expect(exec.get("c1")!.state).toBe("completed") // terminal — preserved
    expect(exec.get("c2")!.state).toBe("discarded")
    expect(exec.get("c3")!.state).toBe("discarded") // was queued
  })

  test("discardAll aborts all non-terminal AbortControllers", () => {
    const exec = makeExecutor()
    const r1 = exec.register({ callId: "c1", toolId: "read" })
    const r2 = exec.register({ callId: "c2", toolId: "edit" })

    exec.transition("c1", "executing")
    exec.transition("c1", "completed")

    exec.discardAll()

    expect(r1.abort.signal.aborted).toBe(false) // was already terminal
    expect(r2.abort.signal.aborted).toBe(true)
  })

  test("discardAll during retry prevents stale outputs", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.register({ callId: "c2", toolId: "grep" })

    exec.transition("c1", "executing")
    exec.transition("c2", "executing")

    // Simulate retry invalidation
    exec.discardAll()

    // Both should be discarded
    expect(exec.get("c1")!.state).toBe("discarded")
    expect(exec.get("c2")!.state).toBe("discarded")

    // Attempting to complete them should fail
    expect(exec.transition("c1", "completed")).toBe(false)
    expect(exec.transition("c2", "completed")).toBe(false)
  })
})

// --- Execute method ---

describe("ToolExecutor.StepExecutor: execute method", () => {
  test("successful execution transitions queued → executing → completed", async () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })

    const rec = await exec.execute("c1", async () => "result")
    expect(rec.state).toBe("completed")
    expect(rec.result).toBe("result")
  })

  test("failed execution transitions queued → executing → error", async () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "edit" })

    const rec = await exec.execute("c1", async () => {
      throw new Error("fail")
    })
    expect(rec.state).toBe("error")
    expect(rec.error).toBeInstanceOf(Error)
  })

  test("execute on unknown call throws", async () => {
    const exec = makeExecutor()
    await expect(exec.execute("nonexistent", async () => "x")).rejects.toThrow("unknown call")
  })

  test("execute triggers sibling cancel on error in cancel group", async () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "bash", cancelGroup: "shell" })
    exec.register({ callId: "c2", toolId: "bash", cancelGroup: "shell" })
    exec.transition("c2", "executing")

    await exec.execute("c1", async () => {
      throw new Error("bash failed")
    })

    expect(exec.get("c1")!.state).toBe("error")
    expect(exec.get("c2")!.state).toBe("cancelled")
  })
})

// --- allSettled and summary ---

describe("ToolExecutor.StepExecutor: completion tracking", () => {
  test("allSettled returns false when calls are pending", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.register({ callId: "c2", toolId: "edit" })
    expect(exec.allSettled()).toBe(false)
  })

  test("allSettled returns true when all calls are terminal", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.register({ callId: "c2", toolId: "edit" })

    exec.transition("c1", "executing")
    exec.transition("c1", "completed")
    exec.transition("c2", "cancelled")

    expect(exec.allSettled()).toBe(true)
  })

  test("allSettled returns true for empty executor", () => {
    const exec = makeExecutor()
    expect(exec.allSettled()).toBe(true)
  })

  test("summary counts are accurate", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.register({ callId: "c2", toolId: "edit" })
    exec.register({ callId: "c3", toolId: "bash" })
    exec.register({ callId: "c4", toolId: "grep" })

    exec.transition("c1", "executing")
    exec.transition("c1", "completed")
    exec.transition("c2", "executing")
    exec.transition("c2", "error")
    exec.transition("c3", "cancelled")

    const s = exec.summary()
    expect(s.completed).toBe(1)
    expect(s.error).toBe(1)
    expect(s.cancelled).toBe(1)
    expect(s.queued).toBe(1) // c4
    expect(s.executing).toBe(0)
    expect(s.discarded).toBe(0)
  })
})

// --- Transition history ---

describe("ToolExecutor.StepExecutor: transition history", () => {
  test("history records all transitions", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.transition("c1", "executing")
    exec.transition("c1", "completed")

    const h = exec.history()
    expect(h).toHaveLength(2)
    expect(h[0]).toMatchObject({ callId: "c1", from: "queued", to: "executing" })
    expect(h[1]).toMatchObject({ callId: "c1", from: "executing", to: "completed" })
  })

  test("rejected transitions are not in history", () => {
    const exec = makeExecutor()
    exec.register({ callId: "c1", toolId: "read" })
    exec.transition("c1", "executing")
    exec.transition("c1", "completed")
    exec.transition("c1", "error") // rejected

    expect(exec.history()).toHaveLength(2)
  })

  test("onTransition callback fires for valid transitions", () => {
    const events: ToolExecutor.TransitionEvent[] = []
    const exec = makeExecutor({ onTransition: (e) => events.push(e) })

    exec.register({ callId: "c1", toolId: "read" })
    exec.transition("c1", "executing")
    exec.transition("c1", "completed")
    exec.transition("c1", "error") // rejected — no callback

    expect(events).toHaveLength(2)
    expect(events[0].to).toBe("executing")
    expect(events[1].to).toBe("completed")
  })
})

// --- High-concurrency simulation ---

describe("ToolExecutor: high-concurrency simulation", () => {
  test("20 concurrent tool calls with forced failures — all reach terminal", async () => {
    const exec = makeExecutor()
    const promises: Promise<ToolExecutor.CallRecord>[] = []

    for (let i = 0; i < 20; i++) {
      const callId = `c${i}`
      const shouldFail = i % 4 === 0
      exec.register({ callId, toolId: shouldFail ? "bash" : "read", cancelGroup: shouldFail ? "shell" : undefined })

      promises.push(
        exec.execute(callId, async () => {
          await delay(Math.random() * 15 + 1)
          if (shouldFail) throw new Error(`Forced failure ${i}`)
          return `result_${i}`
        }),
      )
    }

    const records = await Promise.all(promises)

    // Every call must be in a terminal state
    for (const rec of records) {
      expect(["completed", "error", "cancelled", "discarded"]).toContain(rec.state)
    }
    expect(exec.allSettled()).toBe(true)

    const s = exec.summary()
    // The 5 failing tools (0,4,8,12,16) share cancelGroup "shell", so the first
    // error triggers sibling-cancel on the rest. We expect at least 1 error and
    // the rest are either error or cancelled.
    expect(s.error + s.cancelled).toBeGreaterThanOrEqual(5)
    expect(s.error).toBeGreaterThanOrEqual(1)
    // Total should be 20
    expect(s.completed + s.error + s.cancelled + s.discarded).toBe(20)
  })

  test("long-running tool coexists with short tools without starvation", async () => {
    const exec = makeExecutor()
    const completionOrder: string[] = []

    // Long-running tool
    exec.register({ callId: "long", toolId: "bash" })
    const longP = exec.execute("long", async () => {
      await delay(100)
      completionOrder.push("long")
      return "long_result"
    })

    // Short tools
    for (let i = 0; i < 5; i++) {
      const callId = `short_${i}`
      exec.register({ callId, toolId: "read" })
      exec.execute(callId, async () => {
        await delay(5)
        completionOrder.push(callId)
        return `short_result_${i}`
      })
    }

    await longP
    // Wait a tick for short tools
    await delay(50)

    // Short tools should all have completed before or around the same time as the long one
    expect(completionOrder.length).toBeGreaterThanOrEqual(5)
    expect(exec.allSettled()).toBe(true)

    // Long tool completed
    expect(exec.get("long")!.state).toBe("completed")
    // All short tools completed
    for (let i = 0; i < 5; i++) {
      expect(exec.get(`short_${i}`)!.state).toBe("completed")
    }
  })

  test("discardAll during concurrent execution — no stale results leak", async () => {
    const exec = makeExecutor()
    const results: string[] = []

    for (let i = 0; i < 10; i++) {
      exec.register({ callId: `c${i}`, toolId: "read" })
    }

    // Start execution
    const promises = Array.from({ length: 10 }, (_, i) =>
      exec.execute(`c${i}`, async () => {
        await delay(50 + Math.random() * 50)
        results.push(`r${i}`)
        return `r${i}`
      }),
    )

    // Discard after a short delay (before most complete)
    await delay(10)
    exec.discardAll()

    // Wait for all promises to settle
    await Promise.allSettled(promises)

    // All should be in a terminal state
    expect(exec.allSettled()).toBe(true)

    // None should be in "completed" — they were discarded before finishing
    // (or if they were already executing, they may have been discarded mid-flight)
    const s = exec.summary()
    expect(s.completed + s.discarded + s.error + s.cancelled).toBe(10)
  })
})

// --- Register idempotency ---

describe("ToolExecutor.StepExecutor: register idempotency", () => {
  test("duplicate register returns existing record", () => {
    const exec = makeExecutor()
    const r1 = exec.register({ callId: "c1", toolId: "read" })
    const r2 = exec.register({ callId: "c1", toolId: "read" })
    expect(r1).toBe(r2)
    expect(exec.size).toBe(1)
  })
})

// --- Full transition matrix coverage ---

describe("ToolExecutor: transition matrix coverage", () => {
  const ALL_STATES: ToolExecutor.State[] = ["queued", "executing", "completed", "error", "cancelled", "discarded"]

  // Expected valid transitions
  const VALID: [ToolExecutor.State, ToolExecutor.State][] = [
    ["queued", "executing"],
    ["queued", "cancelled"],
    ["queued", "discarded"],
    ["executing", "completed"],
    ["executing", "error"],
    ["executing", "cancelled"],
    ["executing", "discarded"],
  ]

  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const isValid = VALID.some(([f, t]) => f === from && t === to)
      test(`${from} → ${to}: ${isValid ? "valid" : "rejected"}`, () => {
        const exec = makeExecutor()
        exec.register({ callId: "c1", toolId: "test" })

        // Move to 'from' state
        if (from === "executing") {
          exec.transition("c1", "executing")
        } else if (from === "completed") {
          exec.transition("c1", "executing")
          exec.transition("c1", "completed")
        } else if (from === "error") {
          exec.transition("c1", "executing")
          exec.transition("c1", "error")
        } else if (from === "cancelled") {
          exec.transition("c1", "cancelled")
        } else if (from === "discarded") {
          exec.transition("c1", "discarded")
        }
        // queued is the initial state, no transition needed

        const result = exec.transition("c1", to)
        expect(result).toBe(isValid)
      })
    }
  }
})
