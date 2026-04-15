# openfds Zero-Defect Reliability Protocol

## Objective

Define a mandatory execution standard for openfds where correctness and verification always win over speed. This protocol is derived from deep extraction of `claude-code` reliability logic, then adapted to openfds architecture (`packages/opencode`).

---

## 1) Extracted "Quality DNA" from `claude-code`

### 1.1 Multi-pass validation and recovery loops

Observed in `claude-code/query.ts`:
- The main query loop is a real state machine with explicit transition reasons (`collapse_drain_retry`, `reactive_compact_retry`, `max_output_tokens_recovery`, `stop_hook_blocking`, etc.).
- Recoverable API failures are withheld first, then retried through deterministic recovery stages before surfacing.
- Tool-stream fallback discards stale in-flight state and retries with fresh executor state to avoid inconsistent continuation.

Reliability value:
- Prevents false terminal failures.
- Avoids infinite retry spirals with explicit guards.
- Keeps failure behavior predictable and inspectable.

### 1.2 Deterministic tool integrity

Observed in `claude-code/query.ts` and `services/tools/StreamingToolExecutor.ts`:
- Every emitted `tool_use` is paired with a `tool_result`, including synthetic error blocks on abort/fallback.
- Fallback/abort paths produce tombstones or synthetic results to preserve protocol consistency.
- Parallel tool execution preserves deterministic output ordering.

Reliability value:
- Eliminates broken assistant trajectories.
- Prevents protocol corruption when interruptions happen mid-step.

### 1.3 LSP diagnostic ingestion as a continuous feedback channel

Observed in:
- `claude-code/services/lsp/passiveFeedback.ts`
- `claude-code/services/lsp/LSPDiagnosticRegistry.ts`
- `claude-code/services/diagnosticTracking.ts`
- `claude-code/tools/FileEditTool/*` and `FileWriteTool/*`

Key behaviors:
- Passive `publishDiagnostics` handlers register async diagnostics centrally.
- Registry performs cross-turn dedup + volume limits.
- File edits capture baseline diagnostics before mutation and diff against post-edit diagnostics.
- Changed-file diagnostics are explicitly surfaced back into the agent loop.

Reliability value:
- Converts diagnostics into actionable self-correction signals instead of noisy logs.
- Prevents repeated duplicate warnings from drowning useful signal.

### 1.4 Recursive debugging logic

Observed in:
- `claude-code/query.ts`
- `claude-code/services/tools/toolExecution.ts`

Key behaviors:
- Structured input-validation and tool-validation failures return explicit correction hints.
- Retry transitions are bounded and reasoned (not blind retries).
- Loop exits are explicit and categorized (`completed`, `model_error`, `prompt_too_long`, etc.).

Reliability value:
- Agent can inspect its own failure shape and adapt.
- Fewer opaque failures and fewer unproductive retries.

### 1.5 Test-driven synthesis enforcement status

Observed in prompts/tooling (`constants/prompts.ts`, `tools/AgentTool/prompt.ts`, skills):
- Strong guidance to run tests exists.
- Dedicated test-runner patterns exist.
- Hard kernel-level requirement "code change must include test evidence" is not strictly enforced in the query state machine.

Conclusion:
- Reference agent is strong on recovery + diagnostics.
- Test enforcement is guidance-driven, not hard-gated.

---

## 2) Current openfds Baseline (relevant to quality)

Strengths already present:
- Mutation tools (`edit`, `write`, `apply_patch`) call `lsp.touchFile(..., true)` and return diagnostics (`packages/opencode/src/tool/*`).
- LSP status already exposes health/error metadata (`packages/opencode/src/lsp/index.ts`).
- Framework profile context exists (`packages/opencode/src/project/profile.ts`) and is injected into system prompt (`packages/opencode/src/session/system.ts`).
- Parallel/serial tool metadata + dispatch scaffolding exists (`packages/opencode/src/tool/dispatcher.ts`).

Current gaps:
- No mandatory verification state machine in `SessionPrompt.run` (`packages/opencode/src/session/prompt.ts`).
- No baseline-vs-delta diagnostic model; tool outputs can include pre-existing issues mixed with new regressions.
- No hard gates requiring static analysis, unit tests, and integration checks before success.
- No strict "every tool call must produce final normalized result" contract at the coordinator level.
- Prompts mention diagnostics, but enforcement is soft.

---

## 3) Zero-Defect Workflow (Mandatory)

All build-mode tasks must follow this flow. No shortcut is allowed except explicit user override.

1. Scope & Profile
- Detect framework/runtime via `ProjectProfile.detect()`.
- Build a file-impact set from target files + `priority_files`.

2. Baseline Capture
- Capture initial LSP diagnostics for impacted files and same-root neighbors.
- Record baseline command status for static/unit/integration gates as `unknown`.

3. Plan with Verifiable Acceptance Criteria
- Define expected behavior changes and required test evidence per behavior.
- Define exact commands for static/unit/integration validation.

4. Implement
- Apply minimal edits.
- For each mutation, run immediate LSP touch + settle.

5. LSP Delta Gate
- Compute diagnostic delta: `new_errors`, `new_warnings`, `resolved_errors`.
- If `new_errors > 0` on changed files, auto-enter fix loop (do not finalize).

6. Static Analysis Gate (Hard Gate A)
- Run framework-appropriate static checks.
- Must pass with zero errors.

7. Unit Gate (Hard Gate B)
- Run nearest affected unit tests first, then required package-level suite.
- Must pass with zero failures.

8. Integration Gate (Hard Gate C)
- Run one real end-to-end runtime verification aligned to framework/deployment mode.
- Must pass with explicit evidence.

9. Recursive Debug Loop
- On any gate failure: classify failure, patch smallest root cause, rerun from Gate A.
- Enforce bounded retries with explicit fail reason if limit exceeded.

10. Deterministic Finalization
- Emit final response only when all hard gates are green.
- Include gate evidence summary and residual risk declaration (if any).

---

## 4) Diagnostic-Driven Development: LSP Improvements for openfds

### 4.1 Add Diagnostic Snapshot/Delta service

Add a new service (suggested: `packages/opencode/src/lsp/diagnostic.ts`):
- `snapshot(files, roots)` -> normalized diagnostics map
- `delta(before, after)` -> `{ new_errors, new_warnings, resolved_errors, resolved_warnings }`
- `selectForPrompt(file, root, spill)` -> current file + bounded same-root spillover

### 4.2 Strengthen `waitForDiagnostics` contract

In `packages/opencode/src/lsp/client.ts`:
- Resolve on first publish for the touched file OR short quiet timeout fallback.
- Track per-file diagnostic sequence/time to avoid stale resolution.
- Return a small structured status (`published`, `timed_out`, `duration_ms`) for observability.

### 4.3 Extend LSP status telemetry ✓ IMPLEMENTED

In `packages/opencode/src/lsp/index.ts` status output:
- All existing fields preserved (`id`, `name`, `root`, `root_absolute`, `healthy`, `status`, `last_diagnostics_at`, `error`).
- New optional fields added:
  - `spawned_at: number` — epoch ms when the server process was spawned.
  - `last_spawn_error: string` — most recent spawn/init error, retained even after recovery.
  - `last_request_error: string` — most recent LSP request error (cleared on success).
  - `diagnostics_sequence: number` — monotonically increasing diagnostic sequence counter.
  - `last_touch_result: { status, duration_ms, seq }` — structured result from the most recent `waitForDiagnostics` cycle.
- Connected servers report all five new fields.
- Broken/error servers report `last_spawn_error` alongside existing `error` field.
- Client tracks `lastRequestError` via a sendRequest interceptor that clears on success and captures on failure.
- Client records `lastTouchResult` after every `waitForDiagnostics` completion.

### 4.4 Enforce mutation-tool diagnostic protocol ✓ IMPLEMENTED

All three mutation tools (`edit.ts`, `write.ts`, `apply_patch.ts`) now follow a strict diagnostic contract:

**Output contract (text):**
- Current-file diagnostics block via `LSP.Diagnostic.select`.
- Bounded same-root spillover (max 2 related files).
- Delta summary text ("Diagnostic delta: +N new errors, -N resolved errors, ...").
- Explicit "New errors introduced — fix required." when `needs_fix` is true.

**Metadata contract (structured):**
- `diagnostics: Record<string, Diagnostic[]>` — full diagnostics map.
- `delta: { new_errors, new_warnings, resolved_errors, resolved_warnings }` — numeric delta.
- `needs_fix: boolean` — `true` when new severity-1 diagnostics are introduced.
- All existing metadata fields preserved (backward compatible).

**Implementation details:**
- Pre-edit baseline captured via `DiagnosticService.snapshot()` before `lsp.touchFile()`.
- Post-edit snapshot captured after `lsp.touchFile(file, true)` settles.
- Delta computed via `DiagnosticService.delta(before, after)` with per-diagnostic dedup.
- `apply_patch` handles multi-file patches: baseline/delta covers all affected files.
- Normalize function aligned to `AppFileSystem.normalizePath` across all three tools.

### 4.5 Add passive diagnostic queue (optional but recommended)

Borrow from reference design:
- Central registry for async `publishDiagnostics`.
- Cross-turn dedup and volume limiting.
- Inject only novel diagnostics into prompt context.

---

## 5) Hard Verification Gates (Minimum Required)

## Gate A: Static Analysis
- Purpose: block compile/type/lint regressions.
- Inputs: changed file set + framework profile.
- Pass criteria: zero static errors.
- Fail action: return to recursive debug loop.

## Gate B: Unit Pass
- Purpose: validate local behavior changes.
- Inputs: nearest tests + package suite policy.
- Pass criteria: all selected tests pass.
- Fail action: isolate failing behavior, patch, rerun Gate A then Gate B.

## Gate C: Integration Pass
- Purpose: validate runtime behavior in real execution mode.
- Inputs: framework/deployment mode from `ProjectProfile`.
- Pass criteria: runtime scenario succeeds (build/start/request/smoke).
- Fail action: patch runtime/config mismatch, rerun Gate A/B/C.

Recommended additional gates:
- LSP Clean Gate: no newly introduced severity-1 diagnostics in changed files.
- Contract Gate: expected outputs/artifacts exist and match user contract.

---

## 6) Framework-Aware Gate Command Policy

Command selection must be framework-aware and explicit in logs.

Next.js:
- Static: typecheck + Next lint/build checks.
- Unit: route/component/server-action affected tests.
- Integration: app build + route/API smoke.

Astro:
- Static: Astro check + TS check.
- Unit: content/component tests.
- Integration: adapter-specific build/run smoke (static vs node).

NestJS/Node/TypeScript:
- Static: TS compile/lint.
- Unit: service/controller/module tests.
- Integration: boot app + health/API smoke.

Docker/YAML tasks:
- Add container validation in Gate C (Docker build, compose/k8s schema checks where applicable).

---

## 7) Recursive Debugging Standard

Each failure must be classified before retry:
- `input_validation`
- `tool_runtime`
- `permission`
- `lsp_regression`
- `static_gate_failure`
- `unit_gate_failure`
- `integration_gate_failure`

For each retry:
- Record `reason`, `changed_files`, `expected_fix`, `retry_count`.
- Apply minimal patch.
- Rerun gates from Gate A.
- Stop after bounded retries and emit explicit unresolved blocker.

---

## 8) Deterministic Output Standard

openfds must enforce:
- Stable tool result ordering for parallel batches.
- No dropped tool call outcomes.
- Structured failure hints returned to the model for all tool errors.
- Final responses must include gate summary (A/B/C + LSP delta status).

Suggested implementation points:
- `packages/opencode/src/tool/dispatcher.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/tool/tool.ts`

---

## 9) Implementation Roadmap (Prioritized)

Phase 1 (mandatory):
1. Add diagnostic snapshot/delta service.
2. Wire LSP delta checks into `edit`, `write`, `apply_patch`.
3. Add hard gate runner to `SessionPrompt.run` with fail-fast recursion.

Phase 2 (mandatory):
4. Add explicit gate evidence model on assistant messages/metadata.
5. Add deterministic "no missing tool result" guard in dispatch path.
6. Upgrade prompts (`openfds-build`, `openfds-plan`) from advisory to gate language.

Phase 3 (recommended):
7. Add passive LSP diagnostic registry with dedup + limits.
8. Add framework-specific integration recipes and container verification adapters.

---

## 10) Definition of Done for "Senior Staff Engineer" Mode

A task is complete only if:
- LSP delta is clean for changed files (no newly introduced severity-1 diagnostics).
- Hard Gate A/B/C are all passed and recorded.
- Output is deterministic (no missing tool outcomes, clear evidence trail).
- Any residual risk is explicitly declared.

If any condition is unmet, the task remains in recursive debug mode.
