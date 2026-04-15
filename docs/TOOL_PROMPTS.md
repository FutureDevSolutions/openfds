# TOOL_PROMPTS

## Purpose
This document is a sequential implementation backlog and prompt library for openfds, derived from:
- `docs/TOOL_UPDATE.md` (gap analysis and roadmap)
- `docs/CLAUDE_ANALYSIS.md` (reference-agent architecture findings)

Use each **Zero-Shot Implementation Prompt** as a one-command build prompt. After implementation, run the paired **Verification Prompt**.

## Backlog Order (Run Sequentially)
| Order | Priority | Feature |
|---|---|---|
| 1 | P0 | Concurrency-aware tool batching |
| 2 | P0 | Streaming tool executor state machine |
| 3 | P0 | Durable background task runtime |
| 4 | P1 | MCP resource tools (list/read + binary persistence) |
| 5 | P1 | MCP transport/state richness |
| 6 | P1 | Official/managed connector discovery |
| 7 | P2 | Deferred-tool discovery with adaptive loading |

---

## 1) Concurrency-Aware Tool Batching
**Feature Objective:** Add a deterministic dispatcher that batches concurrency-safe tools while serializing mutating tools, preventing race conditions in multi-tool turns.

### Zero-Shot Implementation Prompt
```text
Implement deterministic, concurrency-aware tool batching in openfds.

Context:
- Repo root: /Users/smusmanzia/Documents/FDS/openfds
- Core references:
  - docs/TOOL_UPDATE.md
  - docs/CLAUDE_ANALYSIS.md
  - packages/opencode/src/session/prompt.ts
  - packages/opencode/src/session/llm.ts
  - packages/opencode/src/session/processor.ts
  - packages/opencode/src/tool/tool.ts
  - packages/opencode/src/tool/registry.ts
  - packages/opencode/test/session/*
  - packages/opencode/test/tool/*

What to build:
1. Introduce explicit tool execution metadata in tool definitions (at minimum: read_only, concurrency_safe, interrupt_behavior).
2. Add a dispatcher module that:
   - partitions tool calls into concurrency-safe batches and serial batches,
   - executes concurrency-safe batches in parallel with bounded concurrency,
   - preserves user-visible output order by original tool call order,
   - applies context updates deterministically after each batch.
3. Integrate dispatcher into the session prompt/loop execution path without regressing existing tool APIs.
4. Keep backward compatibility for tools that do not yet provide metadata (safe defaults).

Non-negotiable constraints:
- Follow openfds modular architecture (no monolithic changes in prompt.ts).
- Maintain strict LSP compatibility (no regression to lsp.touchFile, diagnostics flow, or lsp tool behavior).
- Use asynchronous, non-blocking execution patterns only.
- Add robust error propagation so failed tools return actionable, structured feedback to the LLM (tool name, failure reason, recovery hint).
- Do not use root-level test execution; run checks from packages/opencode.

Testing requirements:
- Add focused tests for mixed read/write tool batches and ordering guarantees.
- Add tests for batch context update determinism.
- Run: bun typecheck
- Run targeted tests you add (or closest existing suites).

Deliverables:
- Code changes.
- New/updated tests.
- Short implementation summary + exact test commands/results.
```

### Verification Prompt
```text
Verify and stress-test the concurrency-aware dispatcher implementation in openfds.

Validation goals:
1. Prove that read-only/concurrency-safe tool calls can run concurrently.
2. Prove that mutating tools remain serialized.
3. Prove output ordering is deterministic and stable across repeated runs.
4. Prove tool failures propagate actionable errors back to LLM-facing flow.
5. Prove no LSP behavior regressions.

Actions:
- Execute package-level typecheck and relevant tests from packages/opencode.
- Add a stress test with at least 20 mixed tool calls and random delays to detect race conditions.
- Validate cancellation and interruption handling during mixed batches.
- Validate no deadlocks and no busy-loop polling.

Report format:
- Pass/fail per validation goal.
- Failing cases with root cause.
- Minimal patch to fix any discovered issue.
```

---

## 2) Streaming Tool Executor State Machine
**Feature Objective:** Implement a streaming tool execution state machine with explicit lifecycle states and safe fallback/cancellation semantics.

### Zero-Shot Implementation Prompt
```text
Implement a streaming tool executor state machine for openfds that supports queued/executing/completed/yielded behavior and robust cancellation.

Context:
- Repo root: /Users/smusmanzia/Documents/FDS/openfds
- Read first:
  - docs/TOOL_UPDATE.md
  - docs/CLAUDE_ANALYSIS.md
- Core files:
  - packages/opencode/src/session/llm.ts
  - packages/opencode/src/session/processor.ts
  - packages/opencode/src/session/prompt.ts
  - packages/opencode/src/session/run-state.ts
  - packages/opencode/src/tool/bash.ts
  - packages/opencode/test/session/*

What to build:
1. Add a dedicated streaming executor service/module that tracks per-tool state transitions.
2. Ensure it can accept tool calls while model output is still streaming.
3. Add cancellation semantics:
   - sibling cancellation policy for configured tool classes (especially shell),
   - discard semantics when stream fallback/retry invalidates in-flight work.
4. Prevent orphaned results and duplicate tool-result writes.
5. Preserve compatibility with existing SessionProcessor tool-part updates.

Non-negotiable constraints:
- Follow openfds modular architecture.
- Maintain strict LSP compatibility.
- Use asynchronous, non-blocking patterns (no blocking waits in event path).
- Enforce robust error propagation with actionable tool failure context.

Testing requirements:
- State transition tests (normal, error, cancel, discard).
- Regression tests for tool-input/tool-call/tool-result event handling.
- Typecheck + targeted test runs from packages/opencode.

Deliverables:
- New streaming executor module integration.
- Tests demonstrating state-machine correctness.
- Summary of race-condition protections added.
```

### Verification Prompt
```text
Verify and stress-test the streaming tool executor state machine.

Validation goals:
1. Every tool call reaches a valid terminal state.
2. No duplicate terminal events or duplicate tool-result messages.
3. Fallback/discard path never leaks stale tool outputs into the active turn.
4. Cancellation is deterministic under concurrent execution.
5. LSP diagnostics/event flow remains intact.

Actions:
- Run targeted session processor and prompt tests.
- Add a high-concurrency simulation with forced failures and forced retries.
- Validate memory/resource cleanup for aborted tasks.
- Confirm no starvation when a long-running tool coexists with short tools.

Report:
- Transition matrix coverage.
- Any failures and corrective patch.
- Final confidence assessment with concrete evidence.
```

---

## 3) Durable Background Task Runtime
**Feature Objective:** Add durable background task execution for long-running shell workflows with task IDs, status tracking, output retrieval, and stop controls.

### Zero-Shot Implementation Prompt
```text
Implement a durable background task runtime for openfds shell workloads.

Context:
- Repo root: /Users/smusmanzia/Documents/FDS/openfds
- Primary files:
  - packages/opencode/src/tool/bash.ts
  - packages/opencode/src/tool/task.ts
  - packages/opencode/src/session/run-state.ts
  - packages/opencode/src/session/prompt.ts
  - packages/opencode/src/bus/*
  - packages/opencode/src/config/*
  - packages/opencode/test/tool/bash.test.ts
  - packages/opencode/test/tool/task.test.ts

What to build:
1. Add a TaskRuntime service with typed states: pending/running/completed/failed/killed.
2. Extend shell execution to support background mode with returned task_id and output metadata.
3. Add task operations for list/get/output/stop (new tools or carefully extended existing task capabilities).
4. Persist runtime state/output under openfds runtime storage (not ephemeral in-memory only).
5. Add stall detection for likely interactive prompts and surface actionable remediation to the agent.

Non-negotiable constraints:
- Follow openfds modular architecture.
- Maintain strict LSP compatibility (background tasks must not break edit/read/lsp cycles).
- Use asynchronous, non-blocking patterns for task IO and lifecycle.
- Ensure robust error propagation to LLM with actionable failure context (exit code, timeout, stderr summary, next action).

Safety guardrails:
- No destructive default behavior.
- Respect existing permission model.
- Ensure cleanup on session termination/interruption.

Testing requirements:
- Unit tests for lifecycle transitions.
- Integration tests for background start/output polling/stop.
- Timeout and cancellation tests.
- Run from packages/opencode: bun typecheck + targeted tests.

Deliverables:
- TaskRuntime implementation and tool integration.
- Tests and command outputs.
- Migration/compat notes if task tool schema changed.
```

### Verification Prompt
```text
Verify and stress-test the durable background task runtime.

Validation goals:
1. Background tasks survive long-running execution and report accurate status.
2. Output retrieval is incremental, bounded, and non-blocking.
3. Stop/cancel always transitions to terminal state cleanly.
4. Stall watchdog correctly flags interactive prompts without false-positive floods.
5. No regression in foreground shell or LSP flows.

Actions:
- Run lifecycle tests and long-run simulation (e.g., sleep/build/watch style task).
- Kill tasks at random points and validate cleanup.
- Force command failures and verify actionable LLM-facing error payloads.
- Validate persistence/reload behavior if session restarts.

Report:
- Evidence by scenario.
- Identified edge cases + patch if needed.
- Final operational limits and recommendations.
```

---

## 4) MCP Resource Tools (List/Read + Binary Persistence)
**Feature Objective:** Expose MCP resources to the model with first-class list/read tools and safe handling of binary payloads.

### Zero-Shot Implementation Prompt
```text
Implement first-class MCP resource tools in openfds: list resources and read resource.

Context:
- Repo root: /Users/smusmanzia/Documents/FDS/openfds
- Core files:
  - packages/opencode/src/mcp/index.ts
  - packages/opencode/src/tool/registry.ts
  - packages/opencode/src/session/prompt.ts
  - packages/opencode/src/tool/*
  - packages/opencode/test/mcp/*

What to build:
1. Add tool(s) for listing MCP resources across servers (with optional server filter).
2. Add tool for reading a specific MCP resource URI.
3. Persist binary blobs safely to disk and return a compact reference instead of injecting large base64 payloads.
4. Ensure tool output is structured and truncated safely for LLM context budgets.
5. Integrate tools into registry and permission system.

Non-negotiable constraints:
- Follow openfds modular architecture.
- Maintain strict LSP compatibility.
- Use asynchronous, non-blocking MCP operations.
- Robust error propagation with actionable messages (server unavailable, unsupported resources, URI not found, auth needed).

Testing requirements:
- Tests for connected/disconnected servers.
- Tests for text and binary resource responses.
- Tests for truncation/persistence metadata.
- Run from packages/opencode: bun typecheck + targeted MCP/tool tests.

Deliverables:
- New MCP resource tools + integration.
- Tests and clear usage examples.
```

### Verification Prompt
```text
Verify and stress-test MCP resource tools (list/read).

Validation goals:
1. Correct resource discovery per server/all servers.
2. Reliable read behavior across text and binary resources.
3. Safe binary persistence and no raw blob explosion in LLM context.
4. Robust handling of auth/timeout/disconnect errors.
5. No regressions to existing MCP tool execution.

Actions:
- Execute MCP test suites and add fixture-based stress tests for large resources.
- Simulate reconnect and stale client scenarios.
- Confirm metadata includes enough detail for self-correction by the LLM.

Report:
- Scenario matrix with outcomes.
- Remaining risk and suggested follow-up hardening.
```

---

## 5) MCP Transport/State Richness
**Feature Objective:** Expand MCP connection model with richer transport and lifecycle states to improve reliability in complex environments.

### Zero-Shot Implementation Prompt
```text
Expand MCP transport/state richness in openfds to improve reliability and diagnostics.

Context:
- Repo root: /Users/smusmanzia/Documents/FDS/openfds
- Primary files:
  - packages/opencode/src/config/config.ts
  - packages/opencode/src/mcp/index.ts
  - packages/opencode/src/server/instance/experimental.ts
  - packages/opencode/test/mcp/*

What to build:
1. Extend MCP status model to include richer lifecycle states where appropriate (e.g., pending, reconnecting) while preserving backward compatibility.
2. Improve reconnect/backoff behavior and status reporting consistency.
3. Add structured health metadata surfaced to tools/session context (server id, root/url, last success/failure, last diagnostics/error).
4. Tighten timeout and cancellation handling for remote MCP calls.

Non-negotiable constraints:
- Follow openfds modular architecture.
- Maintain strict LSP compatibility.
- Use asynchronous, non-blocking networking and state transitions.
- Ensure robust error propagation so LLM receives actionable feedback (what failed, why, what to do next).

Safety/compatibility guardrails:
- Keep existing local/remote config valid.
- Do not break current OAuth flow.

Testing requirements:
- Add lifecycle tests for connect/fail/reconnect.
- Add timeout/backoff tests.
- Run from packages/opencode: bun typecheck + MCP tests.

Deliverables:
- MCP state/health enhancements with tests.
- Backward-compatibility notes.
```

### Verification Prompt
```text
Verify and stress-test enhanced MCP transport/state behavior.

Validation goals:
1. State transitions are correct under normal and failure paths.
2. Reconnect logic is bounded and does not thrash.
3. Error metadata is actionable for LLM remediation loops.
4. Existing MCP configs still function.
5. LSP and session loop remain stable under MCP churn.

Actions:
- Run MCP lifecycle tests with fault injection (timeouts, auth errors, disconnects).
- Validate status output and metadata under each scenario.
- Confirm no busy waits and no leaked pending operations.

Report:
- Transition evidence, failures, and fixes.
- Final readiness and remaining technical debt.
```

---

## 6) Official/Managed Connector Discovery
**Feature Objective:** Add discovery and prioritization of official/managed MCP connectors to reduce setup friction and improve connector quality.

### Zero-Shot Implementation Prompt
```text
Implement official/managed MCP connector discovery in openfds.

Context:
- Repo root: /Users/smusmanzia/Documents/FDS/openfds
- Core files:
  - packages/opencode/src/mcp/index.ts
  - packages/opencode/src/config/config.ts
  - packages/opencode/src/tool/registry.ts
  - packages/opencode/test/mcp/*
- Reference behavior source: docs/CLAUDE_ANALYSIS.md and docs/TOOL_UPDATE.md.

What to build:
1. Add optional discovery flow for official connector registry metadata.
2. Support managed connector ingestion metadata path (design for openfds-compatible provider/backend; avoid hard-coupling to a single SaaS vendor).
3. Deduplicate discovered connectors against manually configured connectors.
4. Expose origin/quality metadata (manual vs discovered vs managed) for observability and ranking.

Non-negotiable constraints:
- Follow openfds modular architecture.
- Maintain strict LSP compatibility.
- Use asynchronous, non-blocking fetch/discovery.
- Robust error propagation with actionable fallback paths (registry unavailable, auth missing, invalid metadata).

Safety guardrails:
- Discovery must be optional and fail-safe.
- No silent override of user-configured connectors.

Testing requirements:
- Dedup tests.
- Offline/timeout tests.
- Metadata parsing validation tests.
- Run from packages/opencode: bun typecheck + targeted MCP tests.

Deliverables:
- Discovery module integration + tests.
- Docs comments for config flags and behavior.
```

### Verification Prompt
```text
Verify and stress-test official/managed connector discovery.

Validation goals:
1. Discovery is optional and non-breaking.
2. Dedup logic consistently favors explicit user config.
3. Metadata quality/origin is accurately surfaced.
4. Failures degrade gracefully with actionable feedback.
5. No impact on core tool/LSP stability.

Actions:
- Run discovery tests in online/offline/fault-injected modes.
- Simulate conflicting connector definitions.
- Confirm deterministic ranking and merge results.

Report:
- Scenario outcomes and unresolved edge cases.
- Fixes applied for any failure found.
```

---

## 7) Deferred-Tool Discovery with Adaptive Loading
**Feature Objective:** Reduce prompt/tool-surface bloat by deferring rarely used tools and loading them via a deterministic discovery mechanism.

### Zero-Shot Implementation Prompt
```text
Implement deferred-tool discovery with adaptive loading in openfds.

Context:
- Repo root: /Users/smusmanzia/Documents/FDS/openfds
- Main files:
  - packages/opencode/src/tool/registry.ts
  - packages/opencode/src/session/prompt.ts
  - packages/opencode/src/session/system.ts
  - packages/opencode/src/session/llm.ts
  - packages/opencode/test/tool/registry.test.ts
  - packages/opencode/test/session/*

What to build:
1. Add deferred-tool metadata in registry for non-core tools.
2. Implement a ToolSearch-like mechanism that finds deferred tools by name/keywords and allows explicit activation.
3. Keep baseline active tool set minimal for prompt stability/cache efficiency.
4. Ensure deterministic tool set expansion and permission checks when deferred tools are loaded.

Non-negotiable constraints:
- Follow openfds modular architecture.
- Maintain strict LSP compatibility (lsp tool must remain available where required by openfds policy).
- Use asynchronous, non-blocking discovery/loading.
- Robust error propagation: if a deferred tool load fails, provide actionable LLM-visible guidance.

Safety/quality guardrails:
- Never hide required core safety tools.
- Preserve deterministic ordering for tool definitions.

Testing requirements:
- Registry tests for deferred/active sets.
- Session tests proving deferred tool activation works in-loop.
- Typecheck + targeted tests from packages/opencode.

Deliverables:
- Deferred loading support + discovery tool.
- Tests + brief performance comparison (tool count/context impact before vs after).
```

### Verification Prompt
```text
Verify and stress-test deferred-tool discovery and adaptive loading.

Validation goals:
1. Baseline tool surface is reduced without breaking existing flows.
2. Deferred tools are discoverable and activatable deterministically.
3. Permission and ordering behavior stays correct post-activation.
4. Failure to load deferred tools is actionable for LLM self-correction.
5. LSP and core coding workflows remain unaffected.

Actions:
- Run registry/session tests and add discovery stress tests with ambiguous queries.
- Measure prompt/tool payload size before and after.
- Validate cache-stability characteristics over repeated runs.

Report:
- Metrics and outcomes.
- Any regressions and corrective patch.
```

---

## Execution Notes
- Run prompts in backlog order.
- After each feature, run its verification prompt before moving to the next.
- Execute checks from `packages/opencode` (not repo root), e.g.:
  - `bun typecheck`
  - `bun test test/<target>.test.ts`
