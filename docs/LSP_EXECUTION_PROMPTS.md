# LSP Execution Prompts: Master Playbook for openfds

## Strategic Objective

This document turns [LSP_IMPROVEMENTS.md](/Users/smusmanzia/Documents/FDS/openfds/docs/LSP_IMPROVEMENTS.md) into a decision-complete execution system for Claude Code.  
It is designed for correctness-first implementation of openfds LSP hardening, with recursive self-correction and adversarial verification at every milestone.

Core intent:
- Prioritize correctness and determinism over speed.
- Enforce LSP-first development (diagnostic feedback is part of the build loop, not post-hoc QA).
- Preserve backward compatibility with current openfds tools, prompts, and runtime behavior.

---

## Zero-Defect Execution Protocol (Mandatory for Every Prompt)

Use this protocol for every Stage A and Stage B run:

1. `Understand`  
Read target modules and identify behavior contracts before editing.

2. `Implement (small slices)`  
Apply minimal changes in non-blocking TypeScript patterns.

3. `LSP self-vetting loop`  
Trigger/collect diagnostics, classify new regressions, fix, and re-check.

4. `Gate execution`  
Run Static Gate (A), Unit Gate (B), Integration/Scenario Gate (C).

5. `Adversarial attack`  
Stress malformed inputs, latency, cancellation, and scale edge cases.

6. `Evidence and docs`  
Capture command output summary and update docs (`README.md`, architecture docs, skills docs if present).

Hard rule:
- A task is not complete while new severity-1 diagnostics, failing tests, or nondeterministic outcomes remain.

---

## Repository Constraints and Command Baseline

Always execute verification from:
- `/Users/smusmanzia/Documents/FDS/openfds/packages/opencode`

Baseline commands:

```bash
cd /Users/smusmanzia/Documents/FDS/openfds/packages/opencode
bun typecheck
bun test --timeout 30000
```

Targeted test style:

```bash
cd /Users/smusmanzia/Documents/FDS/openfds/packages/opencode
bun test --timeout 30000 test/lsp/client.test.ts
bun test --timeout 30000 test/tool/edit.test.ts test/tool/write.test.ts
```

---

## Roadmap and Milestones

### Mandatory Core Track
1. M1: Diagnostic Snapshot/Delta Service
2. M2: `waitForDiagnostics` Contract Hardening
3. M3: LSP Status Telemetry Enrichment
4. M4: Mutation Tool Diagnostic Contract
5. M5: Hard Verification Gates in Session Loop
6. M6: Deterministic Tool-Result Integrity Guard
7. M7: Prompt/Policy Enforcement Upgrade

### Optional Extension Track
8. M8: Passive Async Diagnostic Registry (dedup + volume control)

---

## Prompt Library — Mandatory Core Track

Each section includes:
- Feature Objective
- Stage A prompt (implementation + self-correction)
- Stage B prompt (adversarial verification)
- Expected Deliverables

---

## M1 — Diagnostic Snapshot/Delta Service

### Feature Objective
Implement a shared diagnostic baseline/delta service so openfds can distinguish newly introduced LSP regressions from pre-existing issues.

### Stage A — Implementation & Self-Correction Prompt
```text
Implement a new diagnostic baseline/delta module for openfds LSP.

Context:
- Repo: /Users/smusmanzia/Documents/FDS/openfds
- Baseline spec: docs/LSP_IMPROVEMENTS.md (sections 3, 4.1, 5, 10)
- Likely touchpoints: packages/opencode/src/lsp/index.ts, packages/opencode/src/tool/{edit,write,apply_patch}.ts

Requirements:
1. Add a diagnostic service (suggested path: packages/opencode/src/lsp/diagnostic.ts) that supports:
   - snapshot(files, roots)
   - delta(before, after) with new/resolved error+warning counts
   - bounded same-root diagnostic selection for prompt surfacing
2. Keep implementation modular and non-blocking.
3. Preserve strict backward compatibility for existing tool output fields and tool semantics.
4. Integrate without breaking existing LSP diagnostics flow.

Non-negotiable guardrails:
- Correctness over execution speed.
- LSP-first self-vetting: run diagnostics after each integration point, fix regressions before finalizing.
- Robust error propagation: any diagnostic service failure returns actionable error context to the LLM-facing layer.
- Update documentation: README and docs/LSP_IMPROVEMENTS.md if interfaces/behavior wording changed; update skills docs if applicable.

Verification during implementation:
- From packages/opencode run:
  - bun typecheck
  - bun test --timeout 30000 test/lsp/index.test.ts test/lsp/client.test.ts
```

### Stage B — Adversarial Verification Prompt
```text
Adversarially verify the new diagnostic snapshot/delta service.

Attack scenarios:
1. Empty diagnostics baseline vs populated current diagnostics.
2. Large diagnostic sets (hundreds) with repeated entries.
3. Multiple roots and cross-root spillover suppression.
4. Malformed diagnostic objects (missing severity/range fields).
5. Rapid successive snapshots to detect stale-state bugs.

Required commands (packages/opencode):
- bun typecheck
- bun test --timeout 30000 test/lsp/index.test.ts test/lsp/client.test.ts
- bun test --timeout 30000 test/tool/edit.test.ts test/tool/write.test.ts test/tool/apply_patch.test.ts

Pass criteria:
- Delta output is deterministic and correct across repeated runs.
- No new regressions in existing LSP/tool tests.
- Failures include actionable, structured diagnostics for agent self-correction.
```

### Expected Deliverables
- New diagnostic service with typed API.
- Integration points wired where needed.
- New/updated tests validating baseline/delta correctness.
- Documentation updates reflecting the new diagnostic model.

---

## M2 — `waitForDiagnostics` Contract Hardening

### Feature Objective
Harden `waitForDiagnostics` so first diagnostics are surfaced reliably, with deterministic timeout fallback under latency and event races.

### Stage A — Implementation & Self-Correction Prompt
```text
Harden openfds waitForDiagnostics behavior in packages/opencode/src/lsp/client.ts.

Requirements:
1. Resolve on first publish for the target file OR a quiet-period fallback.
2. Add anti-stale protections (sequence/time checks or equivalent).
3. Return/propagate structured wait status metadata where useful.
4. Keep semantics backward compatible for callers already using touchFile(..., true).

Guardrails:
- Correctness > speed.
- Non-blocking TypeScript (no blocking waits or busy loops).
- LSP-first self-vetting: verify diagnostics arrive on first edit pass.
- Robust error propagation with recoverable hints.
- Update docs if observable behavior changes.

Verification during implementation (packages/opencode):
- bun typecheck
- bun test --timeout 30000 test/lsp/client.test.ts test/lsp/lifecycle.test.ts
```

### Stage B — Adversarial Verification Prompt
```text
Adversarially test waitForDiagnostics under hostile conditions.

Attack scenarios:
1. High-latency diagnostics publication.
2. Diagnostics published for non-target files first.
3. Duplicate/out-of-order publish events.
4. No publish event (quiet timeout path).
5. Burst updates after first publish (debounce/settle race).

Commands (packages/opencode):
- bun typecheck
- bun test --timeout 30000 test/lsp/client.test.ts test/lsp/lifecycle.test.ts test/lsp/index.test.ts

Pass criteria:
- First-pass edits receive usable diagnostics deterministically.
- Timeout path is bounded and does not deadlock.
- Repeated runs produce stable outcomes.
```

### Expected Deliverables
- Hardened `waitForDiagnostics` logic.
- Added regression tests for latency/race conditions.
- No behavior regressions in existing lifecycle tests.

---

## M3 — LSP Status Telemetry Enrichment

### Feature Objective
Expand LSP health/status reporting so agent decisions are based on explicit server health and diagnostic activity state.

### Stage A — Implementation & Self-Correction Prompt
```text
Enhance LSP status telemetry in openfds.

Context:
- packages/opencode/src/lsp/index.ts
- packages/opencode/src/lsp/client.ts
- packages/opencode/src/lsp/server.ts

Requirements:
1. Extend status payload with health metadata (spawn/request/diagnostic timing/sequence context).
2. Preserve compatibility with current status consumers.
3. Avoid breaking API contracts; if adding fields, keep existing fields stable.

Guardrails:
- Correctness over speed.
- LSP-first: validate telemetry against real diagnostic/touch flows.
- Non-blocking implementation.
- Structured error propagation for unhealthy/error states.
- Update docs/README where status contract is described.

Verification during implementation:
- bun typecheck
- bun test --timeout 30000 test/lsp/index.test.ts test/lsp/client.test.ts
```

### Stage B — Adversarial Verification Prompt
```text
Adversarially verify LSP status telemetry quality.

Attack scenarios:
1. Spawn failure and retry behavior.
2. Partial server availability (some healthy, some failed).
3. Diagnostic inactivity while server appears connected.
4. Rapid open/change cycles with status polling.
5. Large workspace where multiple servers spawn.

Commands:
- bun typecheck
- bun test --timeout 30000 test/lsp/index.test.ts test/lsp/lifecycle.test.ts

Pass criteria:
- Status remains backward compatible and reliably indicates health.
- Error metadata is actionable and non-ambiguous.
```

### Expected Deliverables
- Extended status schema and implementation.
- Tests proving health/error telemetry correctness.
- Updated docs for new status fields.

---

## M4 — Mutation Tool Diagnostic Contract

### Feature Objective
Make `edit`, `write`, and `apply_patch` return deterministic, scoped, delta-aware diagnostic feedback for self-correction.

### Stage A — Implementation & Self-Correction Prompt
```text
Implement a strict mutation-tool diagnostic contract for openfds tools:
- edit
- write
- apply_patch

Requirements:
1. For each tool run, return:
   - current-file diagnostics block
   - bounded same-root spillover
   - delta summary vs pre-edit baseline
   - needs_fix=true when new severity-1 issues are introduced
2. Keep outputs backward compatible (do not break existing metadata consumers).
3. Ensure behavior is consistent across all three mutation tools.

Guardrails:
- Correctness > speed.
- LSP-first development and self-correction loop mandatory.
- Non-blocking logic.
- Robust error propagation to LLM-visible output.
- Update README/docs for new mutation-tool diagnostic guarantees.

Verification during implementation:
- bun typecheck
- bun test --timeout 30000 test/tool/edit.test.ts test/tool/write.test.ts test/tool/apply_patch.test.ts
```

### Stage B — Adversarial Verification Prompt
```text
Attack the mutation-tool diagnostic contract with difficult edge cases.

Attack scenarios:
1. Multi-file apply_patch with mixed roots.
2. Edits that fix one error but introduce another in same file.
3. Large file edits where diagnostics volume is high.
4. LSP unavailable/unhealthy paths.
5. Rapid repeated edits to same file (stale baseline risk).

Commands:
- bun typecheck
- bun test --timeout 30000 test/tool/edit.test.ts test/tool/write.test.ts test/tool/apply_patch.test.ts
- bun test --timeout 30000 test/lsp/index.test.ts test/lsp/client.test.ts

Pass criteria:
- `needs_fix` and delta summary are accurate.
- No unrelated diagnostics flood output.
- Existing tool tests remain green.
```

### Expected Deliverables
- Unified diagnostic output behavior for all mutation tools.
- New tests for delta, scope, and `needs_fix` semantics.
- Documentation update for mutation-tool contract.

---

## M5 — Hard Verification Gates in Session Loop

### Feature Objective
Enforce Gate A (Static), Gate B (Unit), Gate C (Integration) in the session loop with recursive retry logic.

### Stage A — Implementation & Self-Correction Prompt
```text
Implement mandatory hard verification gates in the openfds session loop.

Context:
- packages/opencode/src/session/prompt.ts
- related run-state/processor modules
- docs/LSP_IMPROVEMENTS.md sections 3, 5, 7, 10

Requirements:
1. Add gate execution model:
   - Gate A: static analysis
   - Gate B: unit tests
   - Gate C: integration/smoke validation
2. Add recursive debug loop:
   - classify failure
   - patch minimal root cause
   - rerun gates from A
   - bounded retry count with explicit blocker output
3. Ensure no regression to existing conversation/tool flow semantics.

Guardrails:
- Correctness over speed.
- LSP-first enforcement before gate completion.
- Non-blocking orchestration for tool execution and gate checks.
- Strong error propagation and user-visible gate evidence.
- Update docs with gate policy and observable behavior changes.

Verification during implementation:
- bun typecheck
- bun test --timeout 30000 test/session/prompt.test.ts test/session/prompt-effect.test.ts test/session/processor-effect.test.ts
```

### Stage B — Adversarial Verification Prompt
```text
Adversarially verify hard gate enforcement and recursive retry behavior.

Attack scenarios:
1. Gate A failure then fix, confirm reruns A->B->C correctly.
2. Gate B flaky test simulation and deterministic retry policy.
3. Gate C integration failure with actionable blocker surfacing.
4. Retry-limit exhaustion path.
5. Mid-loop interruption/cancellation.

Commands:
- bun typecheck
- bun test --timeout 30000 test/session/prompt.test.ts test/session/prompt-effect.test.ts test/session/processor-effect.test.ts test/session/retry.test.ts

Pass criteria:
- Gates are mandatory and ordered.
- Retry loop is bounded and deterministic.
- Failure reporting remains actionable.
```

### Expected Deliverables
- Session-level gate runner and retry policy.
- Gate evidence model in outputs/metadata.
- Tests for sequencing, retries, and failure handling.

---

## M6 — Deterministic Tool-Result Integrity Guard

### Feature Objective
Guarantee that tool-call outcomes are complete and deterministic under concurrency, cancellation, and fallback paths.

### Stage A — Implementation & Self-Correction Prompt
```text
Implement deterministic tool-result integrity guards in openfds dispatch/execution flow.

Context:
- packages/opencode/src/tool/dispatcher.ts
- packages/opencode/src/session/prompt.ts
- packages/opencode/src/tool/tool.ts

Requirements:
1. Ensure all tool calls have terminal outcomes (success/error/cancelled) with no dropped states.
2. Preserve deterministic ordering in user-visible tool outputs.
3. Add explicit guard paths for cancel/fallback/interruption scenarios.
4. Keep compatibility with current tool execution APIs and message shape.

Guardrails:
- Correctness > speed.
- LSP compatibility must remain intact.
- Non-blocking execution model.
- Actionable error propagation for failed/discarded tool calls.
- Update docs if integrity/ordering behavior becomes stricter.

Verification during implementation:
- bun typecheck
- bun test --timeout 30000 test/tool/dispatcher.test.ts test/tool/executor.test.ts test/session/snapshot-tool-race.test.ts
```

### Stage B — Adversarial Verification Prompt
```text
Adversarially verify tool-result integrity under concurrency and failures.

Attack scenarios:
1. Mixed parallel + serial calls with random delays.
2. Mid-batch cancellation.
3. Sibling error propagation.
4. Fallback/discard path with in-flight work.
5. Repeated stress runs for order stability.

Commands:
- bun typecheck
- bun test --timeout 30000 test/tool/dispatcher.test.ts test/tool/executor.test.ts test/session/snapshot-tool-race.test.ts

Pass criteria:
- No missing terminal outcomes.
- Stable ordering across repeated runs.
- Clear recovery hints for all failure paths.
```

### Expected Deliverables
- Integrity guard logic in dispatch/execution layer.
- Stress tests proving deterministic outcomes.
- No regressions in existing race/executor tests.

---

## M7 — Prompt/Policy Enforcement Upgrade

### Feature Objective
Upgrade openfds build/plan policy prompts from advisory language to enforceable verification behavior.

### Stage A — Implementation & Self-Correction Prompt
```text
Upgrade openfds prompt/policy text so verification and LSP self-correction are mandatory.

Context:
- packages/opencode/src/session/prompt/openfds-build.txt
- packages/opencode/src/session/prompt/openfds-plan.txt
- packages/opencode/src/session/system.ts

Requirements:
1. Enforce gate-first completion language in build and plan prompts.
2. Require explicit LSP self-correction cycle before final answer.
3. Preserve compatibility with existing system prompt composition.
4. Keep prompt changes concise and non-contradictory with existing instructions.

Guardrails:
- Correctness over speed.
- LSP-first enforcement language must be explicit.
- No regressions in prompt rendering/path logic.
- Update docs/README to reflect stricter behavior expectations.

Verification during implementation:
- bun typecheck
- bun test --timeout 30000 test/session/system.test.ts test/session/prompt.test.ts test/session/prompt-effect.test.ts
```

### Stage B — Adversarial Verification Prompt
```text
Adversarially verify prompt/policy enforcement quality.

Attack scenarios:
1. Ambiguous user requests that encourage skipping verification.
2. Multi-step tasks with early “done” temptation.
3. Prompt injection attempts to bypass gate/LSP policy.
4. Plan-to-build handoff where checks are often skipped.

Commands:
- bun typecheck
- bun test --timeout 30000 test/session/system.test.ts test/session/prompt.test.ts test/session/prompt-effect.test.ts

Pass criteria:
- Prompt outputs consistently enforce gate and LSP policy.
- No contradictory system-reminder behavior.
```

### Expected Deliverables
- Updated build/plan prompt policies.
- Tests confirming enforcement in session behavior.
- Docs updated for new policy expectations.

---

## Prompt Library — Optional Extension Track

## M8 — Passive Async Diagnostic Registry (Optional)

### Feature Objective
Add async passive diagnostic ingestion with dedup and volume limits for higher signal quality in long sessions.

### Stage A — Implementation & Self-Correction Prompt
```text
Implement optional passive LSP diagnostic registry for openfds.

Requirements:
1. Capture async diagnostics (publish notifications) into a registry.
2. Deduplicate within-turn and cross-turn.
3. Enforce per-file and total diagnostic volume caps.
4. Surface only novel, actionable diagnostics to prompt context.
5. Keep backward compatibility and avoid flooding outputs.

Guardrails:
- Correctness > speed.
- LSP-first design.
- Non-blocking event handling.
- Actionable error reporting.
- Update docs if enabling registry changes diagnostic surfacing behavior.

Verification:
- bun typecheck
- bun test --timeout 30000 test/lsp/index.test.ts test/lsp/client.test.ts test/session/prompt.test.ts
```

### Stage B — Adversarial Verification Prompt
```text
Adversarially verify passive diagnostic registry behavior.

Attack scenarios:
1. Massive repeated diagnostics spam.
2. Multi-file bursts from single action.
3. Cross-turn duplicate suppression correctness.
4. Mixed healthy/unhealthy server streams.
5. Registry cleanup/reset correctness after session changes.

Commands:
- bun typecheck
- bun test --timeout 30000 test/lsp/index.test.ts test/lsp/client.test.ts test/session/prompt.test.ts

Pass criteria:
- Novel diagnostics are surfaced once.
- Volume limits cap noise without hiding critical errors.
- No memory growth or stale-state leakage.
```

### Expected Deliverables
- Async diagnostic registry module.
- Dedup/limit tests.
- Stable diagnostic signal quality under stress.

---

## Deliverables Checklist (Program-Level)

- [ ] `docs/LSP_EXECUTION_PROMPTS.md` completed and versioned.
- [ ] M1–M7 prompts executed with evidence.
- [ ] Optional M8 executed or explicitly deferred.
- [ ] New/updated tests for each completed milestone.
- [ ] No new severity-1 diagnostics in changed files.
- [ ] Gate A/B/C evidence captured for all mandatory milestones.
- [ ] Docs updated (`README.md`, `docs/LSP_IMPROVEMENTS.md`, and related docs as needed).

---

## Verification Test Matrix

| Milestone | Static Gate (A) | Unit Gate (B) | Integration/Scenario Gate (C) | Adversarial Focus | Pass Criteria |
|---|---|---|---|---|---|
| M1 | `bun typecheck` | LSP/index+client tests | tool integration tests | malformed + large diagnostics | deterministic delta + no regressions |
| M2 | `bun typecheck` | LSP client/lifecycle tests | touch/edit first-pass validation | latency + out-of-order events | no deadlock/stale wait failures |
| M3 | `bun typecheck` | LSP status tests | spawn/health scenario checks | partial outages | actionable health telemetry |
| M4 | `bun typecheck` | edit/write/apply_patch tests | multi-file patch scenarios | regression + scope control | correct `needs_fix` + bounded spill |
| M5 | `bun typecheck` | session prompt/processor tests | gate sequencing simulation | retry exhaustion/interruption | mandatory ordered gates |
| M6 | `bun typecheck` | dispatcher/executor tests | snapshot race scenarios | cancel/fallback concurrency | no missing terminal tool outcomes |
| M7 | `bun typecheck` | system/prompt tests | policy behavior scenarios | bypass/prompt injection attempts | enforcement language is effective |
| M8 (opt) | `bun typecheck` | LSP + prompt tests | multi-turn session replay | burst spam + dedup limits | high-signal, low-noise diagnostics |

---

## Completion Criteria

A milestone is complete only when:
1. Stage A implementation passes self-correction loop.
2. Stage B adversarial verification passes.
3. Gate A/B/C are green.
4. Documentation changes are committed.
5. No unresolved blocker remains.

Program completion requires all mandatory milestones (M1–M7) complete.

---

## Assumptions and Compatibility Defaults

- Backward compatibility is strict for existing tool IDs, core session flow, and existing output shapes unless explicitly versioned.
- Repository test runner is `bun test`; do not introduce unrelated frameworks for this plan.
- If no production SKILL.md exists for updated behavior, document capability changes in README + docs instead.
- Optional milestone M8 can be deferred, but deferral must be documented with risk notes.
