/**
 * Durable background task runtime for shell workloads.
 *
 * Tracks long-running shell tasks without blocking the agent loop.
 * Each task has a typed lifecycle: pending → running → completed | failed | killed.
 *
 * Features:
 * - Background execution with incremental output retrieval
 * - Stall detection for interactive prompts
 * - Bounded output buffer with rotation
 * - Deterministic cleanup on session termination
 * - Structured error payloads for LLM consumption
 */

export namespace TaskRuntime {
  export type State = "pending" | "running" | "completed" | "failed" | "killed"

  const TERMINAL: ReadonlySet<State> = new Set(["completed", "failed", "killed"])

  const TRANSITIONS: Record<State, ReadonlySet<State>> = {
    pending: new Set(["running", "killed"]),
    running: new Set(["completed", "failed", "killed"]),
    completed: new Set(),
    failed: new Set(),
    killed: new Set(),
  }

  /** Default stall detection timeout (seconds without new output). */
  const DEFAULT_STALL_TIMEOUT_MS = 30_000

  /** Maximum output buffer size (characters). */
  const MAX_OUTPUT_BUFFER = 1_024_000 // ~1MB

  /** Common interactive prompt patterns. */
  const STALL_PATTERNS = [
    /\?\s*\(y\/n\)/i,
    /\[y\/N\]/i,
    /\[Y\/n\]/i,
    /password[:\s]/i,
    /passphrase[:\s]/i,
    /Enter .*:/i,
    /Press any key/i,
    /Are you sure/i,
    /Continue\?/i,
    /\(yes\/no\)/i,
  ]

  export interface TaskInfo {
    readonly id: string
    readonly command: string
    readonly cwd: string
    readonly sessionId: string
    state: State
    exitCode: number | null
    /** Full output buffer. */
    output: string
    /** Byte offset for incremental reads. */
    readOffset: number
    /** Timestamps for lifecycle events. */
    time: {
      created: number
      started?: number
      ended?: number
    }
    /** Last time new output was appended. */
    lastOutputAt: number
    /** Whether a stall was detected. */
    stallDetected: boolean
    /** Stall detection message for the agent. */
    stallMessage?: string
    /** Error message if failed. */
    error?: string
    /** Abort controller for cancellation. */
    abort: AbortController
  }

  /** Structured error payload for LLM consumption. */
  export interface TaskError {
    taskId: string
    command: string
    state: State
    exitCode: number | null
    error: string
    stderrSummary: string
    recoveryHint: string
  }

  /** Result from output retrieval. */
  export interface OutputSlice {
    content: string
    offset: number
    total: number
    hasMore: boolean
    isComplete: boolean
  }

  /** Event emitted on state transition. */
  export interface TaskEvent {
    readonly taskId: string
    readonly from: State
    readonly to: State
    readonly timestamp: number
  }

  /**
   * Runtime instance — manages all background tasks for a session.
   */
  export class Runtime {
    private readonly tasks = new Map<string, TaskInfo>()
    private readonly stallTimers = new Map<string, ReturnType<typeof setInterval>>()
    private readonly events: TaskEvent[] = []
    private readonly onEvent?: (event: TaskEvent) => void
    private idCounter = 0

    constructor(options?: { onEvent?: (event: TaskEvent) => void }) {
      this.onEvent = options?.onEvent
    }

    /** Create a new background task in pending state. Returns the task ID. */
    create(input: { command: string; cwd: string; sessionId: string }): string {
      const id = `bg_${++this.idCounter}_${Date.now()}`
      const task: TaskInfo = {
        id,
        command: input.command,
        cwd: input.cwd,
        sessionId: input.sessionId,
        state: "pending",
        exitCode: null,
        output: "",
        readOffset: 0,
        time: { created: Date.now() },
        lastOutputAt: Date.now(),
        stallDetected: false,
        abort: new AbortController(),
      }
      this.tasks.set(id, task)
      return id
    }

    /** Transition a task to a new state. Returns true if valid. */
    transition(taskId: string, to: State): boolean {
      const task = this.tasks.get(taskId)
      if (!task) return false
      if (TERMINAL.has(task.state)) return false
      if (!TRANSITIONS[task.state].has(to)) return false

      const event: TaskEvent = {
        taskId,
        from: task.state,
        to,
        timestamp: Date.now(),
      }
      task.state = to

      if (to === "running") task.time.started = event.timestamp
      if (TERMINAL.has(to)) {
        task.time.ended = event.timestamp
        this.stopStallDetection(taskId)
      }

      this.events.push(event)
      this.onEvent?.(event)
      return true
    }

    /**
     * Start a background task.
     * Provides an execute callback that receives appendOutput/complete/fail hooks.
     */
    async start(
      taskId: string,
      execute: (hooks: {
        appendOutput: (chunk: string) => void
        complete: (exitCode: number) => void
        fail: (error: string, exitCode?: number | null) => void
        signal: AbortSignal
      }) => Promise<void>,
    ): Promise<TaskInfo> {
      const task = this.tasks.get(taskId)
      if (!task) throw new Error(`TaskRuntime: unknown task ${taskId}`)

      if (!this.transition(taskId, "running")) {
        return task
      }

      this.startStallDetection(taskId)

      const appendOutput = (chunk: string) => {
        if (TERMINAL.has(task.state)) return
        task.output += chunk
        task.lastOutputAt = Date.now()
        // Rotate buffer if too large
        if (task.output.length > MAX_OUTPUT_BUFFER) {
          const keep = Math.floor(MAX_OUTPUT_BUFFER * 0.75)
          task.output = "...(output truncated)...\n" + task.output.slice(-keep)
        }
        // Check for stall patterns in recent output
        this.checkStallPatterns(taskId)
      }

      const complete = (exitCode: number) => {
        task.exitCode = exitCode
        if (exitCode === 0) {
          this.transition(taskId, "completed")
        } else {
          task.error = `Command exited with code ${exitCode}`
          this.transition(taskId, "failed")
        }
      }

      const fail = (error: string, exitCode?: number | null) => {
        task.error = error
        task.exitCode = exitCode ?? null
        this.transition(taskId, "failed")
      }

      try {
        await execute({
          appendOutput,
          complete,
          fail,
          signal: task.abort.signal,
        })
      } catch (err) {
        if (!TERMINAL.has(task.state)) {
          task.error = err instanceof Error ? err.message : String(err)
          this.transition(taskId, "failed")
        }
      }

      return task
    }

    /** Get task info. */
    get(taskId: string): TaskInfo | undefined {
      return this.tasks.get(taskId)
    }

    /** List all tasks, optionally filtered by session. */
    list(sessionId?: string): TaskInfo[] {
      const all = Array.from(this.tasks.values())
      return sessionId ? all.filter((t) => t.sessionId === sessionId) : all
    }

    /**
     * Get incremental output from a task.
     * Returns content from the current read offset, then advances the offset.
     */
    getOutput(taskId: string, maxChars?: number): OutputSlice | undefined {
      const task = this.tasks.get(taskId)
      if (!task) return undefined

      const limit = maxChars ?? MAX_OUTPUT_BUFFER
      const available = task.output.length - task.readOffset
      const content = task.output.slice(task.readOffset, task.readOffset + limit)
      task.readOffset += content.length

      return {
        content,
        offset: task.readOffset,
        total: task.output.length,
        hasMore: task.readOffset < task.output.length,
        isComplete: TERMINAL.has(task.state),
      }
    }

    /** Get full output without advancing the read offset. */
    peekOutput(taskId: string): string | undefined {
      return this.tasks.get(taskId)?.output
    }

    /** Stop/kill a running task. */
    stop(taskId: string): boolean {
      const task = this.tasks.get(taskId)
      if (!task) return false
      if (TERMINAL.has(task.state)) return false
      task.abort.abort()
      return this.transition(taskId, "killed")
    }

    /** Kill all non-terminal tasks (e.g., on session termination). */
    stopAll(): void {
      for (const [id, task] of this.tasks) {
        if (!TERMINAL.has(task.state)) {
          task.abort.abort()
          this.transition(id, "killed")
        }
      }
    }

    /** Check if a task is in a terminal state. */
    isTerminal(taskId: string): boolean {
      const task = this.tasks.get(taskId)
      return task ? TERMINAL.has(task.state) : false
    }

    /** Build a structured error payload for the LLM. */
    buildError(taskId: string): TaskError | undefined {
      const task = this.tasks.get(taskId)
      if (!task) return undefined

      const lastLines = task.output.split("\n").slice(-20).join("\n")

      return {
        taskId: task.id,
        command: task.command,
        state: task.state,
        exitCode: task.exitCode,
        error: task.error ?? "Unknown error",
        stderrSummary: lastLines.slice(-2000),
        recoveryHint: this.buildRecoveryHint(task),
      }
    }

    /** Get event history for debugging. */
    history(): readonly TaskEvent[] {
      return this.events
    }

    /** Get counts by state. */
    summary(): Record<State, number> {
      const counts: Record<State, number> = {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        killed: 0,
      }
      for (const task of this.tasks.values()) {
        counts[task.state]++
      }
      return counts
    }

    get size(): number {
      return this.tasks.size
    }

    /** Cleanup resources. */
    dispose(): void {
      this.stopAll()
      for (const timer of this.stallTimers.values()) {
        clearInterval(timer)
      }
      this.stallTimers.clear()
    }

    // --- Private helpers ---

    private startStallDetection(taskId: string) {
      const timer = setInterval(() => {
        const task = this.tasks.get(taskId)
        if (!task || TERMINAL.has(task.state)) {
          this.stopStallDetection(taskId)
          return
        }
        const elapsed = Date.now() - task.lastOutputAt
        if (elapsed >= DEFAULT_STALL_TIMEOUT_MS && !task.stallDetected) {
          task.stallDetected = true
          task.stallMessage = this.buildStallMessage(task)
        }
      }, 5000) // Check every 5s
      this.stallTimers.set(taskId, timer)
    }

    private stopStallDetection(taskId: string) {
      const timer = this.stallTimers.get(taskId)
      if (timer) {
        clearInterval(timer)
        this.stallTimers.delete(taskId)
      }
    }

    private checkStallPatterns(taskId: string) {
      const task = this.tasks.get(taskId)
      if (!task || task.stallDetected) return

      // Check last 500 chars of output for interactive prompt patterns
      const tail = task.output.slice(-500)
      for (const pattern of STALL_PATTERNS) {
        if (pattern.test(tail)) {
          task.stallDetected = true
          task.stallMessage = `Task "${task.id}" appears to be waiting for interactive input. Last output matches pattern: ${pattern.source}. Consider using non-interactive flags (e.g., --yes, -y, --non-interactive) or providing input via stdin.`
          return
        }
      }
    }

    private buildStallMessage(task: TaskInfo): string {
      const elapsed = Math.round((Date.now() - task.lastOutputAt) / 1000)
      return `Task "${task.id}" has not produced output for ${elapsed}s. It may be stalled or waiting for interactive input. Consider stopping it with the stop command or adding non-interactive flags.`
    }

    private buildRecoveryHint(task: TaskInfo): string {
      if (task.stallDetected) {
        return "The command appears to be waiting for interactive input. Retry with non-interactive flags (--yes, -y, --non-interactive) or pipe input."
      }
      if (task.exitCode !== null && task.exitCode !== 0) {
        return `Command exited with code ${task.exitCode}. Check the output for error details and retry with corrected arguments.`
      }
      if (task.state === "killed") {
        return "Task was manually stopped. Restart with the same or modified command if needed."
      }
      return "Check the task output for details and retry with corrected arguments."
    }
  }
}
