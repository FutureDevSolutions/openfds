import { describe, expect, test } from "bun:test"
import {
  TokenStreamHandler,
  createStreamHandler,
  type DataStore,
  type DeltaEvent,
} from "../../../../src/cli/cmd/tui/util/token-stream-handler"
import { TokenMonitor } from "../../../../src/cli/cmd/tui/util/token-monitor"

function makeStore(
  parts: Record<string, { type: string }>,
  messages: Record<string, { role: string }>,
): DataStore {
  return {
    part: { get: (key: string) => parts[key] },
    message: { get: (id: string) => messages[id] },
  }
}

function makeEvent(overrides?: Partial<DeltaEvent>): DeltaEvent {
  return {
    sessionID: "ses_1",
    messageID: "msg_1",
    partID: "part_1",
    delta: "hello world test",
    ...overrides,
  }
}

function makeHandler(
  overrides?: Partial<{
    sessionID: string
    store: DataStore
    onError: (err: Error, evt: DeltaEvent) => void
  }>,
) {
  const monitor = new TokenMonitor({ windowSec: 30 })
  const store =
    overrides?.store ??
    makeStore(
      { "msg_1:part_1": { type: "text" } },
      { msg_1: { role: "assistant" } },
    )
  const errors: Array<{ error: Error; event: DeltaEvent }> = []
  const handler = new TokenStreamHandler({
    sessionID: overrides?.sessionID ?? "ses_1",
    monitor,
    dataStore: store,
    onError:
      overrides?.onError ?? ((error, event) => errors.push({ error, event })),
  })
  return { handler, monitor, errors }
}

// ── Session filtering ───────────────────────────────────────────

describe("session filtering", () => {
  test("accepts events matching sessionID", () => {
    const { handler } = makeHandler({ sessionID: "ses_1" })
    expect(handler.handleDelta(makeEvent({ sessionID: "ses_1" }))).toBe(true)
  })

  test("rejects events with non-matching sessionID", () => {
    const { handler } = makeHandler({ sessionID: "ses_1" })
    expect(handler.handleDelta(makeEvent({ sessionID: "ses_2" }))).toBe(false)
  })

  test("filtered events increment eventsFiltered stat", () => {
    const { handler } = makeHandler({ sessionID: "ses_1" })
    handler.handleDelta(makeEvent({ sessionID: "other" }))
    handler.handleDelta(makeEvent({ sessionID: "other" }))
    const stats = handler.getStats()
    expect(stats.eventsReceived).toBe(2)
    expect(stats.eventsFiltered).toBe(2)
  })
})

// ── Part type filtering ─────────────────────────────────────────

describe("part type filtering", () => {
  test("accepts text parts", () => {
    const store = makeStore(
      { "msg_1:part_1": { type: "text" } },
      { msg_1: { role: "assistant" } },
    )
    const { handler } = makeHandler({ store })
    expect(handler.handleDelta(makeEvent())).toBe(true)
  })

  test("accepts reasoning parts", () => {
    const store = makeStore(
      { "msg_1:part_1": { type: "reasoning" } },
      { msg_1: { role: "assistant" } },
    )
    const { handler } = makeHandler({ store })
    expect(handler.handleDelta(makeEvent())).toBe(true)
  })

  test("rejects tool parts", () => {
    const store = makeStore(
      { "msg_1:part_1": { type: "tool" } },
      { msg_1: { role: "assistant" } },
    )
    const { handler } = makeHandler({ store })
    expect(handler.handleDelta(makeEvent())).toBe(false)
  })

  test("rejects file parts", () => {
    const store = makeStore(
      { "msg_1:part_1": { type: "file" } },
      { msg_1: { role: "assistant" } },
    )
    const { handler } = makeHandler({ store })
    expect(handler.handleDelta(makeEvent())).toBe(false)
  })

  test("rejects when part not found (race condition)", () => {
    const store = makeStore({}, { msg_1: { role: "assistant" } })
    const { handler } = makeHandler({ store })
    expect(handler.handleDelta(makeEvent())).toBe(false)
  })

  test("part lookup uses messageID:partID key", () => {
    let queriedKey = ""
    const store: DataStore = {
      part: {
        get: (key) => {
          queriedKey = key
          return { type: "text" }
        },
      },
      message: { get: () => ({ role: "assistant" }) },
    }
    const { handler } = makeHandler({ store })
    handler.handleDelta(
      makeEvent({ messageID: "msg_42", partID: "part_99" }),
    )
    expect(queriedKey).toBe("msg_42:part_99")
  })
})

// ── Role filtering ──────────────────────────────────────────────

describe("role filtering", () => {
  test("accepts assistant messages", () => {
    const store = makeStore(
      { "msg_1:part_1": { type: "text" } },
      { msg_1: { role: "assistant" } },
    )
    const { handler } = makeHandler({ store })
    expect(handler.handleDelta(makeEvent())).toBe(true)
  })

  test("rejects user messages", () => {
    const store = makeStore(
      { "msg_1:part_1": { type: "text" } },
      { msg_1: { role: "user" } },
    )
    const { handler } = makeHandler({ store })
    expect(handler.handleDelta(makeEvent())).toBe(false)
  })

  test("rejects system messages", () => {
    const store = makeStore(
      { "msg_1:part_1": { type: "text" } },
      { msg_1: { role: "system" } },
    )
    const { handler } = makeHandler({ store })
    expect(handler.handleDelta(makeEvent())).toBe(false)
  })

  test("rejects when message not found", () => {
    const store = makeStore({ "msg_1:part_1": { type: "text" } }, {})
    const { handler } = makeHandler({ store })
    expect(handler.handleDelta(makeEvent())).toBe(false)
  })
})

// ── Token accumulation ──────────────────────────────────────────

describe("token accumulation", () => {
  test("tokens accumulate between ticks", () => {
    const { handler, monitor } = makeHandler()
    // "hello world test" = 16 chars / 4 = 4 tokens
    handler.handleDelta(makeEvent({ delta: "hello world test" }))
    handler.handleDelta(makeEvent({ delta: "more text!" })) // 10/4 = 3 (rounded)

    // Manually tick to flush
    monitor.push(0) // noop to allow manual tick
    // The handler hasn't ticked yet, so pendingTokens are internal
    const stats = handler.getStats()
    expect(stats.tokensAccumulated).toBe(7) // 4 + 3
  })

  test("stats track total accumulated tokens", () => {
    const { handler } = makeHandler()
    handler.handleDelta(makeEvent({ delta: "1234" })) // 1 token
    handler.handleDelta(makeEvent({ delta: "12345678" })) // 2 tokens
    expect(handler.getStats().tokensAccumulated).toBe(3)
  })

  test("empty delta produces 0 tokens", () => {
    const { handler } = makeHandler()
    handler.handleDelta(makeEvent({ delta: "" }))
    expect(handler.getStats().tokensAccumulated).toBe(0)
  })
})

// ── stop() flushes pending ──────────────────────────────────────

describe("stop", () => {
  test("flushes remaining pending tokens to monitor", () => {
    const { handler, monitor } = makeHandler()
    handler.start()

    handler.handleDelta(makeEvent({ delta: "hello world test" })) // 4 tokens
    handler.stop()

    const snap = monitor.snapshot()
    expect(snap.sampleCount).toBe(1)
    expect(snap.current).toBe(4)
  })

  test("is idempotent", () => {
    const { handler, monitor } = makeHandler()
    handler.start()
    handler.handleDelta(makeEvent({ delta: "hello world test" }))
    handler.stop()
    handler.stop() // second stop should be safe
    expect(monitor.snapshot().sampleCount).toBe(1)
  })

  test("marks handler as not running", () => {
    const { handler } = makeHandler()
    handler.start()
    expect(handler.isRunning()).toBe(true)
    handler.stop()
    expect(handler.isRunning()).toBe(false)
  })

  test("no flush when no pending tokens", () => {
    const { handler, monitor } = makeHandler()
    handler.start()
    handler.stop()
    expect(monitor.snapshot().sampleCount).toBe(0)
  })
})

// ── start ───────────────────────────────────────────────────────

describe("start", () => {
  test("marks handler as running", () => {
    const { handler } = makeHandler()
    expect(handler.isRunning()).toBe(false)
    handler.start()
    expect(handler.isRunning()).toBe(true)
    handler.stop() // cleanup
  })

  test("is idempotent", () => {
    const { handler } = makeHandler()
    handler.start()
    handler.start() // second start should be safe
    expect(handler.isRunning()).toBe(true)
    handler.stop()
  })
})

// ── reset ───────────────────────────────────────────────────────

describe("reset", () => {
  test("clears pending tokens", () => {
    const { handler, monitor } = makeHandler()
    handler.handleDelta(makeEvent({ delta: "hello world test" }))
    handler.reset()

    // After reset, a stop shouldn't flush old tokens
    handler.start()
    handler.stop()
    expect(monitor.snapshot().sampleCount).toBe(0)
  })

  test("clears monitor state", () => {
    const { handler, monitor } = makeHandler()
    handler.start()
    handler.handleDelta(makeEvent({ delta: "hello world test" }))
    handler.stop() // flushes to monitor

    handler.reset()
    expect(monitor.isEmpty()).toBe(true)
    expect(monitor.snapshot().sampleCount).toBe(0)
  })

  test("clears statistics", () => {
    const { handler } = makeHandler()
    handler.handleDelta(makeEvent())
    handler.handleDelta(makeEvent({ sessionID: "other" }))

    handler.reset()
    const stats = handler.getStats()
    expect(stats.eventsReceived).toBe(0)
    expect(stats.eventsFiltered).toBe(0)
    expect(stats.tokensAccumulated).toBe(0)
    expect(stats.ticksProcessed).toBe(0)
  })
})

// ── Statistics ──────────────────────────────────────────────────

describe("statistics", () => {
  test("eventsReceived counts all events", () => {
    const { handler } = makeHandler()
    handler.handleDelta(makeEvent()) // accepted
    handler.handleDelta(makeEvent({ sessionID: "other" })) // filtered
    handler.handleDelta(makeEvent()) // accepted
    expect(handler.getStats().eventsReceived).toBe(3)
  })

  test("eventsFiltered counts rejected events", () => {
    const { handler } = makeHandler()
    handler.handleDelta(makeEvent({ sessionID: "other" }))
    handler.handleDelta(makeEvent({ sessionID: "other" }))
    handler.handleDelta(makeEvent()) // accepted
    expect(handler.getStats().eventsFiltered).toBe(2)
  })

  test("getStats returns a copy", () => {
    const { handler } = makeHandler()
    const stats1 = handler.getStats()
    handler.handleDelta(makeEvent())
    const stats2 = handler.getStats()
    expect(stats1.eventsReceived).toBe(0)
    expect(stats2.eventsReceived).toBe(1)
  })

  test("filter ratio is accurate", () => {
    const store = makeStore(
      { "msg_1:part_1": { type: "text" } },
      { msg_1: { role: "assistant" } },
    )
    const { handler } = makeHandler({ store })

    // 3 accepted
    handler.handleDelta(makeEvent())
    handler.handleDelta(makeEvent())
    handler.handleDelta(makeEvent())

    // 2 filtered (wrong session)
    handler.handleDelta(makeEvent({ sessionID: "other" }))
    handler.handleDelta(makeEvent({ sessionID: "other" }))

    const stats = handler.getStats()
    expect(stats.eventsReceived).toBe(5)
    expect(stats.eventsFiltered).toBe(2)
    expect(stats.eventsReceived - stats.eventsFiltered).toBe(3)
  })
})

// ── Error handling ──────────────────────────────────────────────

describe("error handling", () => {
  test("invalid delta type calls onError", () => {
    const { handler, errors } = makeHandler()
    // Force a non-string delta
    const event = makeEvent() as any
    event.delta = 42
    handler.handleDelta(event)
    expect(errors.length).toBe(1)
    expect(errors[0].error.message).toContain("Invalid delta type")
  })

  test("invalid delta does not throw", () => {
    const { handler } = makeHandler()
    const event = makeEvent() as any
    event.delta = null
    expect(() => handler.handleDelta(event)).not.toThrow()
  })

  test("missing onError callback does not throw", () => {
    const monitor = new TokenMonitor()
    const store = makeStore(
      { "msg_1:part_1": { type: "text" } },
      { msg_1: { role: "assistant" } },
    )
    const handler = new TokenStreamHandler({
      sessionID: "ses_1",
      monitor,
      dataStore: store,
      // No onError
    })
    const event = makeEvent() as any
    event.delta = 42
    expect(() => handler.handleDelta(event)).not.toThrow()
  })
})

// ── createStreamHandler factory ─────────────────────────────────

describe("createStreamHandler", () => {
  test("returns handler and cleanup function", () => {
    const monitor = new TokenMonitor()
    const store = makeStore({}, {})
    const bus = {
      on: () => {},
      off: () => {},
    }
    const { handler, cleanup } = createStreamHandler(
      { sessionID: "ses_1", monitor },
      store,
      bus,
    )
    expect(handler).toBeInstanceOf(TokenStreamHandler)
    expect(typeof cleanup).toBe("function")
    expect(handler.isRunning()).toBe(true)
    cleanup()
    expect(handler.isRunning()).toBe(false)
  })

  test("wires event bus on creation", () => {
    const monitor = new TokenMonitor()
    const store = makeStore({}, {})
    let wiredEvent = ""
    const bus = {
      on: (event: string) => {
        wiredEvent = event
      },
      off: () => {},
    }
    const { cleanup } = createStreamHandler(
      { sessionID: "ses_1", monitor },
      store,
      bus,
    )
    expect(wiredEvent).toBe("message.part.delta")
    cleanup()
  })

  test("cleanup unwires event bus", () => {
    const monitor = new TokenMonitor()
    const store = makeStore({}, {})
    let unwiredEvent = ""
    const bus = {
      on: () => {},
      off: (event: string) => {
        unwiredEvent = event
      },
    }
    const { cleanup } = createStreamHandler(
      { sessionID: "ses_1", monitor },
      store,
      bus,
    )
    cleanup()
    expect(unwiredEvent).toBe("message.part.delta")
  })

  test("handler receives events via bus", () => {
    const monitor = new TokenMonitor()
    const store = makeStore(
      { "msg_1:part_1": { type: "text" } },
      { msg_1: { role: "assistant" } },
    )
    let registeredHandler: ((evt: DeltaEvent) => void) | null = null
    const bus = {
      on: (_event: string, handler: (evt: DeltaEvent) => void) => {
        registeredHandler = handler
      },
      off: () => {},
    }
    const { handler, cleanup } = createStreamHandler(
      { sessionID: "ses_1", monitor },
      store,
      bus,
    )

    // Simulate event delivery via captured handler
    registeredHandler!(makeEvent({ delta: "hello world test" }))
    expect(handler.getStats().eventsReceived).toBe(1)
    expect(handler.getStats().tokensAccumulated).toBe(4)
    cleanup()
  })
})

// ── Performance ─────────────────────────────────────────────────

describe("performance", () => {
  test("handleDelta executes in < 1μs for filtered events", () => {
    const { handler } = makeHandler({ sessionID: "ses_1" })
    const event = makeEvent({ sessionID: "other" }) // will be filtered at first check

    // Warm up
    for (let i = 0; i < 1000; i++) {
      handler.handleDelta(event)
    }

    const iterations = 100_000
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      handler.handleDelta(event)
    }
    const elapsed = performance.now() - start
    const avgMicroseconds = (elapsed / iterations) * 1000
    expect(avgMicroseconds).toBeLessThan(1)
  })

  test("handleDelta executes quickly for accepted events", () => {
    const { handler } = makeHandler()
    const event = makeEvent()

    // Warm up
    for (let i = 0; i < 1000; i++) {
      handler.handleDelta(event)
    }

    const iterations = 50_000
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      handler.handleDelta(event)
    }
    const elapsed = performance.now() - start
    const avgMicroseconds = (elapsed / iterations) * 1000
    // Accepted events do more work but should still be fast
    expect(avgMicroseconds).toBeLessThan(5)
  })
})
