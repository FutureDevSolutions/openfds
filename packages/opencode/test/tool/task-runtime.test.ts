import { describe, test, expect, afterEach } from "bun:test"
import { TaskRuntime } from "../../src/tool/task-runtime"

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

let runtime: TaskRuntime.Runtime

afterEach(() => {
  runtime?.dispose()
})

// --- Lifecycle state transition tests ---

describe("TaskRuntime: lifecycle transitions", () => {
  test("create produces a task in pending state", () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo hello", cwd: "/tmp", sessionId: "s1" })
    const task = runtime.get(id)
    expect(task).toBeDefined()
    expect(task!.state).toBe("pending")
    expect(task!.command).toBe("echo hello")
  })

  test("pending → running transition succeeds", () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo hello", cwd: "/tmp", sessionId: "s1" })
    expect(runtime.transition(id, "running")).toBe(true)
    expect(runtime.get(id)!.state).toBe("running")
  })

  test("running → completed transition succeeds", () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo hello", cwd: "/tmp", sessionId: "s1" })
    runtime.transition(id, "running")
    expect(runtime.transition(id, "completed")).toBe(true)
    expect(runtime.get(id)!.state).toBe("completed")
  })

  test("running → failed transition succeeds", () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "bad cmd", cwd: "/tmp", sessionId: "s1" })
    runtime.transition(id, "running")
    expect(runtime.transition(id, "failed")).toBe(true)
    expect(runtime.get(id)!.state).toBe("failed")
  })

  test("running → killed transition succeeds", () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "sleep 999", cwd: "/tmp", sessionId: "s1" })
    runtime.transition(id, "running")
    expect(runtime.transition(id, "killed")).toBe(true)
    expect(runtime.get(id)!.state).toBe("killed")
  })

  test("pending → killed transition succeeds", () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo", cwd: "/tmp", sessionId: "s1" })
    expect(runtime.transition(id, "killed")).toBe(true)
    expect(runtime.get(id)!.state).toBe("killed")
  })

  test("terminal states reject further transitions", () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo", cwd: "/tmp", sessionId: "s1" })
    runtime.transition(id, "running")
    runtime.transition(id, "completed")

    expect(runtime.transition(id, "failed")).toBe(false)
    expect(runtime.transition(id, "killed")).toBe(false)
    expect(runtime.transition(id, "running")).toBe(false)
    expect(runtime.get(id)!.state).toBe("completed")
  })

  test("invalid transitions are rejected", () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo", cwd: "/tmp", sessionId: "s1" })

    expect(runtime.transition(id, "completed")).toBe(false) // pending → completed invalid
    expect(runtime.transition(id, "failed")).toBe(false) // pending → failed invalid
    expect(runtime.get(id)!.state).toBe("pending")
  })

  test("timestamps are set correctly", () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo", cwd: "/tmp", sessionId: "s1" })
    const task = runtime.get(id)!

    expect(task.time.created).toBeGreaterThan(0)
    expect(task.time.started).toBeUndefined()
    expect(task.time.ended).toBeUndefined()

    runtime.transition(id, "running")
    expect(task.time.started).toBeGreaterThan(0)

    runtime.transition(id, "completed")
    expect(task.time.ended).toBeGreaterThan(0)
    expect(task.time.ended!).toBeGreaterThanOrEqual(task.time.started!)
  })
})

// --- Background execution tests ---

describe("TaskRuntime: background execution", () => {
  test("start executes and completes successfully", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo hello", cwd: "/tmp", sessionId: "s1" })

    const result = await runtime.start(id, async ({ appendOutput, complete }) => {
      appendOutput("hello\n")
      complete(0)
    })

    expect(result.state).toBe("completed")
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe("hello\n")
  })

  test("start handles non-zero exit code as failure", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "bad cmd", cwd: "/tmp", sessionId: "s1" })

    const result = await runtime.start(id, async ({ appendOutput, complete }) => {
      appendOutput("error: command not found\n")
      complete(127)
    })

    expect(result.state).toBe("failed")
    expect(result.exitCode).toBe(127)
    expect(result.error).toContain("exited with code 127")
  })

  test("start handles explicit failure", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo", cwd: "/tmp", sessionId: "s1" })

    const result = await runtime.start(id, async ({ fail }) => {
      fail("spawn error: ENOENT", null)
    })

    expect(result.state).toBe("failed")
    expect(result.error).toBe("spawn error: ENOENT")
  })

  test("start handles thrown exceptions", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo", cwd: "/tmp", sessionId: "s1" })

    const result = await runtime.start(id, async () => {
      throw new Error("unexpected crash")
    })

    expect(result.state).toBe("failed")
    expect(result.error).toBe("unexpected crash")
  })

  test("incremental output via appendOutput", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo 1 2 3", cwd: "/tmp", sessionId: "s1" })

    await runtime.start(id, async ({ appendOutput, complete }) => {
      appendOutput("line1\n")
      appendOutput("line2\n")
      appendOutput("line3\n")
      complete(0)
    })

    expect(runtime.get(id)!.output).toBe("line1\nline2\nline3\n")
  })

  test("start on unknown task throws", async () => {
    runtime = new TaskRuntime.Runtime()
    await expect(
      runtime.start("nonexistent", async () => {}),
    ).rejects.toThrow("unknown task")
  })
})

// --- Output retrieval tests ---

describe("TaskRuntime: output retrieval", () => {
  test("getOutput returns incremental content", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo", cwd: "/tmp", sessionId: "s1" })

    await runtime.start(id, async ({ appendOutput, complete }) => {
      appendOutput("chunk1")
      appendOutput("chunk2")
      appendOutput("chunk3")
      complete(0)
    })

    const slice1 = runtime.getOutput(id, 6)!
    expect(slice1.content).toBe("chunk1")
    expect(slice1.hasMore).toBe(true)

    const slice2 = runtime.getOutput(id, 6)!
    expect(slice2.content).toBe("chunk2")
    expect(slice2.hasMore).toBe(true)

    const slice3 = runtime.getOutput(id)!
    expect(slice3.content).toBe("chunk3")
    expect(slice3.hasMore).toBe(false)
    expect(slice3.isComplete).toBe(true)
  })

  test("peekOutput returns full output without advancing offset", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo", cwd: "/tmp", sessionId: "s1" })

    await runtime.start(id, async ({ appendOutput, complete }) => {
      appendOutput("full output")
      complete(0)
    })

    expect(runtime.peekOutput(id)).toBe("full output")
    expect(runtime.peekOutput(id)).toBe("full output") // still same

    const slice = runtime.getOutput(id)!
    expect(slice.content).toBe("full output") // first read gets everything
  })

  test("getOutput on unknown task returns undefined", () => {
    runtime = new TaskRuntime.Runtime()
    expect(runtime.getOutput("nonexistent")).toBeUndefined()
  })

  test("output buffer rotation when exceeding max size", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "big output", cwd: "/tmp", sessionId: "s1" })

    await runtime.start(id, async ({ appendOutput, complete }) => {
      // Append more than MAX_OUTPUT_BUFFER chars
      for (let i = 0; i < 110; i++) {
        appendOutput("x".repeat(10_000) + "\n")
      }
      complete(0)
    })

    const output = runtime.peekOutput(id)!
    // Should be truncated to around MAX_OUTPUT_BUFFER
    expect(output.length).toBeLessThanOrEqual(1_100_000)
    expect(output).toContain("(output truncated)")
  })
})

// --- Stop/cancel tests ---

describe("TaskRuntime: stop and cancel", () => {
  test("stop transitions running task to killed", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "sleep 999", cwd: "/tmp", sessionId: "s1" })

    // Start in background
    const p = runtime.start(id, async ({ signal }) => {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (signal.aborted) {
            clearInterval(check)
            resolve()
          }
        }, 10)
      })
    })

    await delay(20) // Let it start
    expect(runtime.stop(id)).toBe(true)
    await p

    expect(runtime.get(id)!.state).toBe("killed")
    expect(runtime.get(id)!.abort.signal.aborted).toBe(true)
  })

  test("stop on terminal task returns false", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo", cwd: "/tmp", sessionId: "s1" })

    await runtime.start(id, async ({ complete }) => {
      complete(0)
    })

    expect(runtime.stop(id)).toBe(false)
  })

  test("stopAll kills all running tasks", async () => {
    runtime = new TaskRuntime.Runtime()
    const ids = Array.from({ length: 5 }, (_, i) =>
      runtime.create({ command: `sleep ${i}`, cwd: "/tmp", sessionId: "s1" }),
    )

    // Start all tasks
    const promises = ids.map((id) =>
      runtime.start(id, async ({ signal }) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          const handler = () => resolve()
          signal.addEventListener("abort", handler, { once: true })
        })
      }),
    )

    await delay(20)
    runtime.stopAll()
    await Promise.allSettled(promises)

    for (const id of ids) {
      expect(runtime.get(id)!.state).toBe("killed")
    }
  })

  test("stop on pending task kills immediately", () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo", cwd: "/tmp", sessionId: "s1" })
    expect(runtime.stop(id)).toBe(true)
    expect(runtime.get(id)!.state).toBe("killed")
  })
})

// --- Stall detection tests ---

describe("TaskRuntime: stall detection", () => {
  test("interactive prompt pattern is detected", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "npm init", cwd: "/tmp", sessionId: "s1" })

    await runtime.start(id, async ({ appendOutput, complete }) => {
      appendOutput("package name? (y/n) ")
      await delay(10)
      complete(0)
    })

    const task = runtime.get(id)!
    expect(task.stallDetected).toBe(true)
    expect(task.stallMessage).toContain("interactive input")
  })

  test("password prompt pattern is detected", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "ssh user@host", cwd: "/tmp", sessionId: "s1" })

    await runtime.start(id, async ({ appendOutput, complete }) => {
      appendOutput("Password: ")
      await delay(10)
      complete(0)
    })

    const task = runtime.get(id)!
    expect(task.stallDetected).toBe(true)
    expect(task.stallMessage).toContain("interactive input")
  })

  test("normal output does not trigger stall detection", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "echo hello", cwd: "/tmp", sessionId: "s1" })

    await runtime.start(id, async ({ appendOutput, complete }) => {
      appendOutput("Building...\nDone!\n")
      complete(0)
    })

    expect(runtime.get(id)!.stallDetected).toBe(false)
  })
})

// --- Error payloads ---

describe("TaskRuntime: error payloads", () => {
  test("buildError returns structured error for failed task", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "npm run build", cwd: "/tmp", sessionId: "s1" })

    await runtime.start(id, async ({ appendOutput, complete }) => {
      appendOutput("Error: Cannot find module 'foo'\n")
      appendOutput("at Object.<anonymous> (index.js:1:1)\n")
      complete(1)
    })

    const error = runtime.buildError(id)!
    expect(error.taskId).toBe(id)
    expect(error.command).toBe("npm run build")
    expect(error.state).toBe("failed")
    expect(error.exitCode).toBe(1)
    expect(error.stderrSummary).toContain("Cannot find module")
    expect(error.recoveryHint).toContain("exited with code 1")
  })

  test("buildError returns stall-specific hint", async () => {
    runtime = new TaskRuntime.Runtime()
    const id = runtime.create({ command: "npm init", cwd: "/tmp", sessionId: "s1" })

    await runtime.start(id, async ({ appendOutput, fail }) => {
      appendOutput("Continue? (y/n) ")
      fail("Task stalled waiting for input")
    })

    const error = runtime.buildError(id)!
    expect(error.recoveryHint).toContain("interactive input")
  })

  test("buildError on unknown task returns undefined", () => {
    runtime = new TaskRuntime.Runtime()
    expect(runtime.buildError("nonexistent")).toBeUndefined()
  })
})

// --- List and summary ---

describe("TaskRuntime: list and summary", () => {
  test("list returns all tasks", () => {
    runtime = new TaskRuntime.Runtime()
    runtime.create({ command: "echo 1", cwd: "/tmp", sessionId: "s1" })
    runtime.create({ command: "echo 2", cwd: "/tmp", sessionId: "s1" })
    runtime.create({ command: "echo 3", cwd: "/tmp", sessionId: "s2" })

    expect(runtime.list()).toHaveLength(3)
    expect(runtime.list("s1")).toHaveLength(2)
    expect(runtime.list("s2")).toHaveLength(1)
  })

  test("summary counts are accurate", async () => {
    runtime = new TaskRuntime.Runtime()

    const id1 = runtime.create({ command: "echo 1", cwd: "/tmp", sessionId: "s1" })
    const id2 = runtime.create({ command: "echo 2", cwd: "/tmp", sessionId: "s1" })
    const id3 = runtime.create({ command: "echo 3", cwd: "/tmp", sessionId: "s1" })
    const id4 = runtime.create({ command: "echo 4", cwd: "/tmp", sessionId: "s1" })

    await runtime.start(id1, async ({ complete }) => complete(0))
    await runtime.start(id2, async ({ complete }) => complete(1))
    runtime.stop(id3)
    // id4 stays pending

    const s = runtime.summary()
    expect(s.completed).toBe(1)
    expect(s.failed).toBe(1)
    expect(s.killed).toBe(1)
    expect(s.pending).toBe(1)
    expect(s.running).toBe(0)
  })
})

// --- Event history ---

describe("TaskRuntime: event history", () => {
  test("events record all transitions", async () => {
    const events: TaskRuntime.TaskEvent[] = []
    runtime = new TaskRuntime.Runtime({ onEvent: (e) => events.push(e) })

    const id = runtime.create({ command: "echo", cwd: "/tmp", sessionId: "s1" })
    await runtime.start(id, async ({ complete }) => complete(0))

    expect(events).toHaveLength(2) // pending→running, running→completed
    expect(events[0]).toMatchObject({ from: "pending", to: "running" })
    expect(events[1]).toMatchObject({ from: "running", to: "completed" })
  })
})

// --- Stress tests ---

describe("TaskRuntime: stress scenarios", () => {
  test("20 concurrent background tasks all reach terminal state", async () => {
    runtime = new TaskRuntime.Runtime()
    const ids: string[] = []

    for (let i = 0; i < 20; i++) {
      ids.push(runtime.create({ command: `task_${i}`, cwd: "/tmp", sessionId: "s1" }))
    }

    const promises = ids.map((id, i) =>
      runtime.start(id, async ({ appendOutput, complete, fail }) => {
        await delay(Math.random() * 30 + 1)
        appendOutput(`output for ${i}\n`)
        if (i % 5 === 0) {
          fail(`Forced failure for task ${i}`)
        } else {
          complete(0)
        }
      }),
    )

    await Promise.all(promises)

    const s = runtime.summary()
    expect(s.completed + s.failed + s.killed).toBe(20)
    expect(s.running).toBe(0)
    expect(s.pending).toBe(0)
  })

  test("random stop during concurrent execution", async () => {
    runtime = new TaskRuntime.Runtime()
    const ids: string[] = []

    for (let i = 0; i < 10; i++) {
      ids.push(runtime.create({ command: `long_${i}`, cwd: "/tmp", sessionId: "s1" }))
    }

    const promises = ids.map((id) =>
      runtime.start(id, async ({ signal, appendOutput, complete }) => {
        for (let j = 0; j < 10; j++) {
          if (signal.aborted) return
          appendOutput(`chunk_${j}\n`)
          await delay(5)
        }
        if (!signal.aborted) complete(0)
      }),
    )

    // Kill random tasks after a short delay
    await delay(15)
    for (let i = 0; i < 5; i++) {
      runtime.stop(ids[i * 2]) // Kill even-indexed tasks
    }

    await Promise.allSettled(promises)

    for (const id of ids) {
      const task = runtime.get(id)!
      expect(["completed", "failed", "killed"]).toContain(task.state)
    }
  })

  test("long-running task coexists with short tasks without starvation", async () => {
    runtime = new TaskRuntime.Runtime()
    const completionOrder: string[] = []

    // Long task
    const longId = runtime.create({ command: "long", cwd: "/tmp", sessionId: "s1" })
    const longP = runtime.start(longId, async ({ appendOutput, complete }) => {
      await delay(100)
      appendOutput("long done\n")
      completionOrder.push("long")
      complete(0)
    })

    // Short tasks
    const shortIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = runtime.create({ command: `short_${i}`, cwd: "/tmp", sessionId: "s1" })
      shortIds.push(id)
      runtime.start(id, async ({ appendOutput, complete }) => {
        await delay(10)
        appendOutput(`short_${i} done\n`)
        completionOrder.push(`short_${i}`)
        complete(0)
      })
    }

    await longP
    await delay(20)

    // Short tasks should have completed before the long one
    const longIdx = completionOrder.indexOf("long")
    for (let i = 0; i < 5; i++) {
      const shortIdx = completionOrder.indexOf(`short_${i}`)
      expect(shortIdx).toBeLessThan(longIdx)
    }
  })
})

// --- Transition matrix ---

describe("TaskRuntime: transition matrix coverage", () => {
  const ALL_STATES: TaskRuntime.State[] = ["pending", "running", "completed", "failed", "killed"]
  const VALID: [TaskRuntime.State, TaskRuntime.State][] = [
    ["pending", "running"],
    ["pending", "killed"],
    ["running", "completed"],
    ["running", "failed"],
    ["running", "killed"],
  ]

  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const isValid = VALID.some(([f, t]) => f === from && t === to)
      test(`${from} → ${to}: ${isValid ? "valid" : "rejected"}`, () => {
        runtime = new TaskRuntime.Runtime()
        const id = runtime.create({ command: "test", cwd: "/tmp", sessionId: "s1" })

        // Move to 'from' state
        if (from === "running") {
          runtime.transition(id, "running")
        } else if (from === "completed") {
          runtime.transition(id, "running")
          runtime.transition(id, "completed")
        } else if (from === "failed") {
          runtime.transition(id, "running")
          runtime.transition(id, "failed")
        } else if (from === "killed") {
          runtime.transition(id, "killed")
        }

        const result = runtime.transition(id, to)
        expect(result).toBe(isValid)
      })
    }
  }
})
