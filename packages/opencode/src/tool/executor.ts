/**
 * Streaming tool executor state machine.
 *
 * Tracks per-tool-call state transitions during a streaming LLM step:
 *   queued → executing → completed | error | cancelled | discarded
 *
 * Provides:
 * - Sibling-cancel: when a tool in a cancel-group fails, other in-flight
 *   siblings in the same group are cancelled.
 * - Discard semantics: when a stream retry/fallback invalidates in-flight
 *   work, all non-terminal calls are moved to `discarded`.
 * - Duplicate-terminal guard: once a call reaches a terminal state
 *   (completed/error/cancelled/discarded), further state writes are rejected.
 * - Deterministic completion tracking per step.
 */

export namespace ToolExecutor {
  /** Valid states for a tool call in the streaming executor. */
  export type State = "queued" | "executing" | "completed" | "error" | "cancelled" | "discarded"

  /** Terminal states — no further transitions allowed. */
  const TERMINAL: ReadonlySet<State> = new Set(["completed", "error", "cancelled", "discarded"])

  /** Valid transition map. */
  const TRANSITIONS: Record<State, ReadonlySet<State>> = {
    queued: new Set(["executing", "cancelled", "discarded"]),
    executing: new Set(["completed", "error", "cancelled", "discarded"]),
    completed: new Set(), // terminal
    error: new Set(), // terminal
    cancelled: new Set(), // terminal
    discarded: new Set(), // terminal
  }

  /** Cancel-group policies. Tools in the same group trigger sibling cancellation on failure. */
  export type CancelPolicy = "none" | "shell" | "custom"

  export interface CallOptions {
    /** Tool call ID (from AI SDK). */
    readonly callId: string
    /** Tool name/id. */
    readonly toolId: string
    /** Cancel group — tools in the same group are sibling-cancelled on failure. */
    readonly cancelGroup?: string
    /** The execute function. Returns a result or throws. */
    readonly execute: () => Promise<unknown>
  }

  export interface CallRecord {
    readonly callId: string
    readonly toolId: string
    readonly cancelGroup?: string
    state: State
    result?: unknown
    error?: unknown
    /** Timestamp of the last state transition. */
    updatedAt: number
    /** AbortController for cancelling in-flight execution. */
    readonly abort: AbortController
  }

  /** Event emitted on state transition. */
  export interface TransitionEvent {
    readonly callId: string
    readonly toolId: string
    readonly from: State
    readonly to: State
    readonly timestamp: number
  }

  /**
   * Per-step executor instance.
   * Create one per LLM step to track all tool calls within that step.
   */
  export class StepExecutor {
    private readonly calls = new Map<string, CallRecord>()
    private readonly transitions: TransitionEvent[] = []
    private readonly onTransition?: (event: TransitionEvent) => void

    constructor(options?: { onTransition?: (event: TransitionEvent) => void }) {
      this.onTransition = options?.onTransition
    }

    /** Register a tool call. Starts in `queued` state. */
    register(opts: Omit<CallOptions, "execute">): CallRecord {
      if (this.calls.has(opts.callId)) {
        return this.calls.get(opts.callId)!
      }
      const record: CallRecord = {
        callId: opts.callId,
        toolId: opts.toolId,
        cancelGroup: opts.cancelGroup,
        state: "queued",
        updatedAt: Date.now(),
        abort: new AbortController(),
      }
      this.calls.set(opts.callId, record)
      return record
    }

    /**
     * Transition a call to a new state.
     * Returns true if the transition was valid, false if rejected (duplicate terminal, invalid transition).
     */
    transition(callId: string, to: State): boolean {
      const record = this.calls.get(callId)
      if (!record) return false
      if (TERMINAL.has(record.state)) return false
      if (!TRANSITIONS[record.state].has(to)) return false

      const event: TransitionEvent = {
        callId,
        toolId: record.toolId,
        from: record.state,
        to,
        timestamp: Date.now(),
      }
      record.state = to
      record.updatedAt = event.timestamp
      this.transitions.push(event)
      this.onTransition?.(event)
      return true
    }

    /**
     * Execute a registered tool call.
     * Transitions: queued → executing → completed/error.
     * On error, triggers sibling-cancel for tools in the same cancel group.
     */
    async execute(callId: string, executeFn: () => Promise<unknown>): Promise<CallRecord> {
      const record = this.calls.get(callId)
      if (!record) throw new Error(`ToolExecutor: unknown call ${callId}`)

      if (!this.transition(callId, "executing")) {
        return record
      }

      try {
        const result = await executeFn()
        record.result = result
        this.transition(callId, "completed")
      } catch (err) {
        record.error = err
        if (!this.transition(callId, "error")) {
          // Already in a terminal state (e.g. cancelled during execution)
          return record
        }
        // Sibling cancellation
        if (record.cancelGroup) {
          this.cancelGroup(record.cancelGroup, callId)
        }
      }

      return record
    }

    /** Cancel all non-terminal calls in a cancel group, excluding the trigger call. */
    cancelGroup(group: string, excludeCallId?: string): void {
      for (const [id, rec] of this.calls) {
        if (id === excludeCallId) continue
        if (rec.cancelGroup !== group) continue
        if (TERMINAL.has(rec.state)) continue
        rec.abort.abort()
        this.transition(id, "cancelled")
      }
    }

    /** Cancel a single call if it's not in a terminal state. */
    cancel(callId: string): boolean {
      const record = this.calls.get(callId)
      if (!record) return false
      if (TERMINAL.has(record.state)) return false
      record.abort.abort()
      return this.transition(callId, "cancelled")
    }

    /**
     * Discard all non-terminal calls.
     * Used when a stream retry/fallback invalidates in-flight work.
     */
    discardAll(): void {
      for (const [id, rec] of this.calls) {
        if (TERMINAL.has(rec.state)) continue
        rec.abort.abort()
        this.transition(id, "discarded")
      }
    }

    /** Get the current record for a call. */
    get(callId: string): CallRecord | undefined {
      return this.calls.get(callId)
    }

    /** Get all call records. */
    all(): ReadonlyMap<string, CallRecord> {
      return this.calls
    }

    /** Check if a call is in a terminal state. */
    isTerminal(callId: string): boolean {
      const record = this.calls.get(callId)
      return record ? TERMINAL.has(record.state) : false
    }

    /** Check if all registered calls have reached a terminal state. */
    allSettled(): boolean {
      for (const rec of this.calls.values()) {
        if (!TERMINAL.has(rec.state)) return false
      }
      return true
    }

    /** Get transition history for debugging/testing. */
    history(): readonly TransitionEvent[] {
      return this.transitions
    }

    /** Get counts by state. */
    summary(): Record<State, number> {
      const counts: Record<State, number> = {
        queued: 0,
        executing: 0,
        completed: 0,
        error: 0,
        cancelled: 0,
        discarded: 0,
      }
      for (const rec of this.calls.values()) {
        counts[rec.state]++
      }
      return counts
    }

    /** Number of registered calls. */
    get size(): number {
      return this.calls.size
    }
  }
}
