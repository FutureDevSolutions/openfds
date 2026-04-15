import { Tool } from "./tool"

/**
 * Built-in execution metadata registry.
 * Maps tool IDs to their concurrency characteristics.
 * Tools with `executionMeta` on their Def override these defaults.
 */
const BUILTIN_META: Record<string, Tool.ExecutionMeta> = {
  // Read-only, concurrency-safe tools
  read: { read_only: true, concurrency_safe: true, interrupt_behavior: "continue" },
  glob: { read_only: true, concurrency_safe: true, interrupt_behavior: "continue" },
  grep: { read_only: true, concurrency_safe: true, interrupt_behavior: "continue" },
  lsp: { read_only: true, concurrency_safe: true, interrupt_behavior: "continue" },
  codesearch: { read_only: true, concurrency_safe: true, interrupt_behavior: "continue" },
  websearch: { read_only: true, concurrency_safe: true, interrupt_behavior: "continue" },
  webfetch: { read_only: true, concurrency_safe: true, interrupt_behavior: "continue" },

  // Mutating tools — must run serially
  edit: { read_only: false, concurrency_safe: false, interrupt_behavior: "continue" },
  write: { read_only: false, concurrency_safe: false, interrupt_behavior: "continue" },
  apply_patch: { read_only: false, concurrency_safe: false, interrupt_behavior: "continue" },
  bash: { read_only: false, concurrency_safe: false, interrupt_behavior: "continue" },
  multiedit: { read_only: false, concurrency_safe: false, interrupt_behavior: "continue" },

  // Interactive/control tools — serial
  task: { read_only: false, concurrency_safe: false, interrupt_behavior: "continue" },
  skill: { read_only: false, concurrency_safe: false, interrupt_behavior: "continue" },
  question: { read_only: false, concurrency_safe: false, interrupt_behavior: "abort" },
  todowrite: { read_only: false, concurrency_safe: false, interrupt_behavior: "continue" },
  plan_exit: { read_only: false, concurrency_safe: false, interrupt_behavior: "abort" },
  invalid: { read_only: true, concurrency_safe: true, interrupt_behavior: "continue" },

  // MCP resource tools — read-only, concurrency-safe
  list_mcp_resources: { read_only: true, concurrency_safe: true, interrupt_behavior: "continue" },
  read_mcp_resource: { read_only: true, concurrency_safe: true, interrupt_behavior: "continue" },

  // Discovery tool — read-only (activates tools in memory, no external mutation)
  tool_search: { read_only: true, concurrency_safe: true, interrupt_behavior: "continue" },
}

export namespace ToolDispatcher {
  /** Resolve execution metadata for a tool, checking Def first, then built-in registry, then defaults. */
  export function getMeta(toolDef: Pick<Tool.Def, "id" | "executionMeta">): Tool.ExecutionMeta {
    if (toolDef.executionMeta) return toolDef.executionMeta
    return BUILTIN_META[toolDef.id] ?? Tool.DEFAULT_EXECUTION_META
  }

  /** A pending tool call waiting to be dispatched. */
  export interface PendingCall<T = unknown> {
    /** Position in the original tool call list — used to restore output order. */
    readonly index: number
    readonly toolId: string
    readonly meta: Tool.ExecutionMeta
    readonly execute: () => Promise<T>
  }

  /** The outcome of a single dispatched tool call. */
  export type CallResult<T = unknown> =
    | { readonly status: "ok"; readonly index: number; readonly toolId: string; readonly value: T }
    | {
        readonly status: "error"
        readonly index: number
        readonly toolId: string
        readonly error: unknown
        readonly recoveryHint: string
      }
    | {
        readonly status: "cancelled"
        readonly index: number
        readonly toolId: string
        readonly reason: string
      }
    | {
        readonly status: "discarded"
        readonly index: number
        readonly toolId: string
        readonly reason: string
      }

  /** Default bounded concurrency for parallel batches. */
  const DEFAULT_CONCURRENCY = 10

  /**
   * Partition a list of pending calls into ordered batches.
   *
   * Consecutive concurrency-safe calls form a single parallel batch.
   * Each non-concurrent call becomes its own serial batch (size 1).
   * Order is preserved: batches execute sequentially, calls within a parallel batch run concurrently.
   */
  export function partition<T>(calls: PendingCall<T>[]): PendingCall<T>[][] {
    if (calls.length === 0) return []

    const batches: PendingCall<T>[][] = []
    let currentParallel: PendingCall<T>[] = []

    for (const call of calls) {
      if (call.meta.concurrency_safe) {
        currentParallel.push(call)
      } else {
        // Flush any accumulated parallel batch
        if (currentParallel.length > 0) {
          batches.push(currentParallel)
          currentParallel = []
        }
        // Serial call gets its own batch
        batches.push([call])
      }
    }
    // Flush trailing parallel batch
    if (currentParallel.length > 0) {
      batches.push(currentParallel)
    }

    return batches
  }

  /**
   * Execute a single batch of tool calls.
   *
   * For batches with >1 call, execution is parallel with bounded concurrency.
   * Results are always returned sorted by original `index`.
   */
  async function executeBatch<T>(
    batch: PendingCall<T>[],
    concurrency: number,
  ): Promise<CallResult<T>[]> {
    const results: CallResult<T>[] = []

    if (batch.length === 1) {
      const call = batch[0]
      try {
        const value = await call.execute()
        results.push({ status: "ok", index: call.index, toolId: call.toolId, value })
      } catch (error) {
        results.push({
          status: "error",
          index: call.index,
          toolId: call.toolId,
          error,
          recoveryHint: formatRecoveryHint(call.toolId, error),
        })
      }
      return results
    }

    // Parallel execution with bounded concurrency.
    // Track whether an abort-behavior tool has failed, which cancels remaining queued calls.
    const executing = new Set<Promise<void>>()
    const queue = [...batch]
    let aborted = false
    let abortReason = ""

    while (queue.length > 0 || executing.size > 0) {
      // Drain queued calls that were superseded by an abort
      while (aborted && queue.length > 0) {
        const cancelled = queue.shift()!
        results.push({
          status: "cancelled",
          index: cancelled.index,
          toolId: cancelled.toolId,
          reason: abortReason,
        })
      }

      while (queue.length > 0 && executing.size < concurrency) {
        const call = queue.shift()!
        const p = (async () => {
          try {
            const value = await call.execute()
            results.push({ status: "ok", index: call.index, toolId: call.toolId, value })
          } catch (error) {
            results.push({
              status: "error",
              index: call.index,
              toolId: call.toolId,
              error,
              recoveryHint: formatRecoveryHint(call.toolId, error),
            })
            // If this tool has abort interrupt behavior, cancel remaining queued calls
            if (call.meta.interrupt_behavior === "abort") {
              aborted = true
              abortReason = `Sibling tool "${call.toolId}" failed: ${error instanceof Error ? error.message : String(error)}`
            }
          }
        })()
        const tracked = p.then(() => {
          executing.delete(tracked)
        })
        executing.add(tracked)
      }
      if (executing.size > 0) {
        await Promise.race(executing)
      }
    }

    // Restore original order
    results.sort((a, b) => a.index - b.index)
    return results
  }

  /**
   * Dispatch a list of tool calls through batched execution.
   *
   * 1. Partitions calls into batches (parallel-safe grouped, serial isolated).
   * 2. Executes batches sequentially; within each batch, parallel calls run concurrently.
   * 3. Calls `onBatchComplete` after each batch for deterministic context updates.
   * 4. Returns all results sorted by original call order.
   */
  export async function dispatch<T>(
    calls: PendingCall<T>[],
    options?: {
      concurrency?: number
      onBatchComplete?: (batchResults: CallResult<T>[], batchIndex: number) => void | Promise<void>
    },
  ): Promise<CallResult<T>[]> {
    const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY
    const batches = partition(calls)
    const allResults: CallResult<T>[] = []

    for (let i = 0; i < batches.length; i++) {
      const batchResults = await executeBatch(batches[i], concurrency)
      allResults.push(...batchResults)
      if (options?.onBatchComplete) {
        await options.onBatchComplete(batchResults, i)
      }
    }

    // Final sort to guarantee output order matches original call order
    allResults.sort((a, b) => a.index - b.index)

    // Completeness guard: every input call must have exactly one result
    if (allResults.length !== calls.length) {
      throw new Error(
        `ToolDispatcher: result count (${allResults.length}) does not match input count (${calls.length}). ` +
          `This indicates a dropped tool-call outcome.`,
      )
    }

    return allResults
  }

  /** Format a structured recovery hint for the LLM from a tool error. */
  function formatRecoveryHint(toolId: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return `Tool "${toolId}" failed: ${message}. Retry with corrected arguments or use an alternative approach.`
  }

  /**
   * Queued entry inside a StepCoordinator.
   * Wraps a pending tool call with a resolve/reject pair so the original
   * caller's promise settles after dispatched execution.
   */
  interface QueuedEntry<T> {
    pending: PendingCall<T>
    resolve: (value: T) => void
    reject: (error: unknown) => void
  }

  /**
   * Per-prompt coordinator that batches concurrent tool calls from the AI SDK.
   *
   * Usage:
   *   const coord = new StepCoordinator()
   *   // For each tool registered with the AI SDK:
   *   tools[id].execute = (args, opts) => coord.enqueue(id, meta, () => actualExecute(args, opts))
   *
   * When the AI SDK invokes multiple tool execute functions in the same microtask
   * (which it does for all tool calls within a single model step), the coordinator
   * collects them and dispatches through batched execution once the microtask drains.
   */
  /** Error subclass for cancelled tool calls — distinguishable from runtime errors. */
  export class CancelledError extends Error {
    override readonly name = "CancelledError"
    constructor(
      message: string,
      public readonly toolId: string,
    ) {
      super(message)
    }
  }

  /** Error subclass for discarded tool calls — distinguishable from runtime errors. */
  export class DiscardedError extends Error {
    override readonly name = "DiscardedError"
    constructor(
      message: string,
      public readonly toolId: string,
    ) {
      super(message)
    }
  }

  export class StepCoordinator<T = unknown> {
    private queue: QueuedEntry<T>[] = []
    private counter = 0
    private flushing = false
    private flushScheduled = false
    private _discarded = false
    private readonly concurrency: number
    private readonly onBatchComplete?: (batchResults: CallResult<T>[], batchIndex: number) => void | Promise<void>

    constructor(options?: {
      concurrency?: number
      onBatchComplete?: (batchResults: CallResult<T>[], batchIndex: number) => void | Promise<void>
    }) {
      this.concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY
      this.onBatchComplete = options?.onBatchComplete
    }

    /**
     * Enqueue a tool call for batched execution.
     * Returns a promise that resolves with the tool's result after dispatch.
     */
    enqueue(toolId: string, meta: Tool.ExecutionMeta, execute: () => Promise<T>): Promise<T> {
      if (this._discarded) {
        return Promise.reject(new DiscardedError("Coordinator has been discarded", toolId))
      }
      return new Promise<T>((resolve, reject) => {
        const index = this.counter++
        this.queue.push({
          pending: { index, toolId, meta, execute },
          resolve,
          reject,
        })
        this.scheduleFlush()
      })
    }

    /**
     * Discard all pending (not yet dispatched) entries.
     * Rejects their promises with a DiscardedError.
     * Entries already in-flight during a flush are unaffected (they'll resolve/reject normally).
     */
    discardAll(): void {
      this._discarded = true
      const pending = this.queue.splice(0)
      for (const entry of pending) {
        entry.reject(new DiscardedError("Tool call discarded due to stream retry/fallback", entry.pending.toolId))
      }
    }

    /** Whether this coordinator has been discarded. */
    get discarded(): boolean {
      return this._discarded
    }

    private scheduleFlush() {
      if (this.flushScheduled) return
      this.flushScheduled = true
      // Use queueMicrotask to batch all synchronously-enqueued calls
      queueMicrotask(() => this.flush())
    }

    private async flush() {
      this.flushScheduled = false

      // Guard against re-entrant flush
      if (this.flushing) return
      this.flushing = true

      // Drain the queue — take a snapshot so new enqueues during dispatch
      // are handled in a subsequent flush
      const entries = this.queue.splice(0)
      if (entries.length === 0) {
        this.flushing = false
        return
      }

      try {
        const calls = entries.map((e) => e.pending)
        const results = await dispatch(calls, {
          concurrency: this.concurrency,
          onBatchComplete: this.onBatchComplete,
        })

        // Map results back to their original promise handles
        const entryByIndex = new Map(entries.map((e) => [e.pending.index, e]))
        for (const result of results) {
          const entry = entryByIndex.get(result.index)
          if (!entry) continue
          if (result.status === "ok") {
            entry.resolve(result.value)
          } else if (result.status === "cancelled") {
            entry.reject(new CancelledError(result.reason, result.toolId))
          } else if (result.status === "discarded") {
            entry.reject(new DiscardedError(result.reason, result.toolId))
          } else {
            entry.reject(result.error)
          }
        }
      } catch (err) {
        // If dispatch itself fails catastrophically, reject all pending
        for (const entry of entries) {
          entry.reject(err)
        }
      } finally {
        this.flushing = false
        // If more calls arrived during dispatch, flush again
        if (this.queue.length > 0 && !this._discarded) {
          this.scheduleFlush()
        }
      }
    }
  }
}
