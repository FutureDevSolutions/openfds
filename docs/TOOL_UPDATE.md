# TOOL_UPDATE

## Scope
- Baseline reviewed: `docs/CLAUDE_ANALYSIS.md`
- Reference Agent sources reviewed from `claude-code/`:
  - Tool dispatcher/runtime: `services/tools/toolOrchestration.ts`, `services/tools/StreamingToolExecutor.ts`
  - MCP: `services/mcp/client.ts`, `services/mcp/types.ts`, `services/mcp/officialRegistry.ts`, `services/mcp/claudeai.ts`, `tools/ListMcpResourcesTool/*`, `tools/ReadMcpResourceTool/*`
  - Long-running task architecture: `tasks/LocalShellTask/LocalShellTask.tsx`, `Task.ts`, task tools
- Current openfds surfaces reviewed in `packages/opencode/src`:
  - Tool/runtime: `session/prompt.ts`, `session/processor.ts`, `tool/registry.ts`, `tool/bash.ts`, `tool/task.ts`
  - MCP: `mcp/index.ts`, `config/config.ts`
  - LSP and context integration: `lsp/*`, `project/profile.ts`

## Comparative Findings

### 1) Multi-step tool chaining and dispatcher behavior
- Reference Agent has an explicit dispatcher that partitions tool calls into concurrency-safe batches and serial mutating batches, then deterministically applies context modifiers (`toolOrchestration.ts`).
- It also has a streaming executor state machine (`queued` -> `executing` -> `completed`/`yielded`) with sibling-cancel behavior and discard semantics for fallback retries (`StreamingToolExecutor.ts`).
- openfds currently relies on AI SDK tool execution inside `streamText(...)` and does not define a first-class orchestration policy for mixed read/write tool groups; execution ordering and cancellation semantics are less explicit (`session/prompt.ts`, `session/llm.ts`).

### 2) MCP capabilities and resources for web-stack workflows
- Reference Agent MCP stack supports broader transports (`stdio`, `sse`, `http`, `ws`, `sdk`, plus internal proxy/IDE modes) and richer server lifecycle states (`pending`, `needs-auth`, `failed`, etc.) (`services/mcp/types.ts`).
- It includes:
  - official registry awareness (`officialRegistry.ts`)
  - managed connector ingestion (`claudeai.ts`)
  - first-class MCP resource tools with reconnect/caching and binary persistence (`ListMcpResourcesTool`, `ReadMcpResourceTool`).
- openfds MCP is solid but narrower:
  - server types: `local` + `remote` only (`config/config.ts`)
  - resources/prompts exist in service APIs (`mcp/index.ts`) but are not exposed as model-facing tools by default.
- Evidence of useful connector classes in Reference Agent for web teams: Slack and Datadog are explicitly handled in built-in workflows (`skills/bundled/scheduleRemoteAgents.ts`, `commands/commit-push-pr.ts`).

### 3) Long-running/background task state machine
- Reference Agent has a durable task runtime for background shell jobs, status transitions, output files, stop/output tools, and stall watchdog logic for interactive prompts (`tasks/LocalShellTask/LocalShellTask.tsx`).
- openfds currently has:
  - per-session busy/idle runner (`session/run-state.ts`)
  - synchronous `bash` tool execution with timeout and abort (`tool/bash.ts`)
  - no durable task graph for background execution/output polling in the same style.

## Gap Analysis

| Feature in Reference Agent | Value to openfds | Implementation Difficulty (S/M/L) |
|---|---|---|
| Concurrency-aware tool batching (`partitionToolCalls` + serial/parallel policy) | Prevents race conditions when models emit mixed read/write tool calls; improves determinism in Next/Nest monorepos with many edits/searches | M |
| Streaming tool executor state machine (`queued/executing/completed/yielded`) with discard and sibling-cancel semantics | More reliable retries/recovery and cleaner UX during streaming/fallback events | M |
| Durable background task runtime for shell commands (task IDs, persisted output, stop/output retrieval) | Major DX improvement for long-running `next dev`, builds, tests, migrations; avoids blocking main agent loop | L |
| MCP transport/state richness (`pending`, wider transports, reconnect model) | Better reliability with enterprise and mixed local/remote connector topologies | M |
| First-class MCP resource tools (`list/read` + binary persistence) | Allows agent to consume connector resources directly (runbooks, docs, dashboards) instead of only callable tools | S |
| Official/managed connector discovery (registry + managed connectors) | Faster onboarding to high-value connectors; less manual MCP setup burden | M |
| Deferred-tool discovery (`ToolSearch`) with adaptive loading | Reduces prompt bloat and improves context-cache stability in large sessions | M |

## Top 2 Must-Have Integrations

### Must-Have 1: Deterministic Tool Dispatcher (Reliability First)
**Goal:** Make multi-tool execution deterministic and safe under streaming.

1. Add tool execution metadata to openfds tool definitions (`read_only`, `concurrency_safe`, `interrupt_behavior`) in `packages/opencode/src/tool/tool.ts`.
2. Introduce a dispatcher service (new module under `packages/opencode/src/session/` or `src/tool/`) that:
   - groups tool calls into concurrency-safe vs exclusive batches
   - preserves output ordering
   - queues context mutations and applies them deterministically after concurrent batches.
3. Route tool executions in `session/prompt.ts` through this dispatcher instead of directly trusting provider/tool runtime ordering.
4. Add sibling-cancel policy for shell failures during concurrent batches, with explicit synthetic cancellation messages.
5. Add integration tests for:
   - mixed `grep/read/edit/write` in one assistant turn
   - parallel-safe-only batches
   - cancellation/fallback behavior.

### Must-Have 2: Background Task State Machine for Shell Workloads
**Goal:** Support long-running tasks without blocking session progress.

1. Add a `TaskRuntime` service (new module) with typed states: `pending`, `running`, `completed`, `failed`, `killed`.
2. Extend `bash` tool to optionally run in background mode and return `task_id` + output path metadata.
3. Add task operations (list/get/output/stop) as dedicated tools or extend existing task APIs without overloading subagent `task`.
4. Persist output and state in `.openfds/` runtime storage and emit progress notifications via bus events.
5. Add stall-watchdog detection for interactive prompts (to guide user/model toward non-interactive flags).
6. Add end-to-end tests with long-running fixtures (`next dev`, `nest start --watch`, long test command).

## MCP Recommendations for NextJS/TypeScript Workflow
- Keep MCP core generic, but ship openfds templates/profiles for common web-team connectors.
- Priority connector classes:
  - source control/review (`GitHub`-style connectors)
  - incident/chat (`Slack`, `Datadog` classes, as already demonstrated in Reference workflows)
  - deployment/infra observability connectors where available in registry.
- Expose MCP resources as model tools in openfds so agent can ingest runbooks/config docs before writing code.

## Priority Roadmap
1. P0: Deterministic dispatcher + streaming cancellation semantics.
2. P0: Background task state machine + task output retrieval.
3. P1: MCP resource tools (list/read) with binary-safe persistence.
4. P1: MCP transport/state expansion and official connector discovery.
5. P2: Deferred tool discovery and prompt-surface optimization.
