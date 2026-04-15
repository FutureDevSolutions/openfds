# Real-Time Performance Monitor (Tokens/Sec) for openfds TUI

## Executive Summary

This document defines a production-safe plan to add a **real-time Tokens/Sec monitor** to the openfds terminal UI.

The implementation is tailored to openfds’s actual stack:
- **TypeScript + Solid + OpenTUI** (`@opentui/core`, `@opentui/solid`)
- Not Bubble Tea, tview, blessed, or blessed-contrib

The design adds a dedicated right-side **Performance Metrics** column with:
- Current `t/s` indicator
- Rolling 30-second history graph
- Dynamic autoscaling against the active 30s peak
- Low-overhead, non-blocking sampling

---

## Findings from Current Codebase

## 1) TUI framework and layout constraints

Current session layout is in:
- `/Users/smusmanzia/Documents/FDS/openfds/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`

Layout is a row:
- Main conversation pane (`flexGrow=1`)
- Optional right sidebar (`width=42`)

This is the correct insertion point for a new **right-side metrics column**.

## 2) Live stream signal available to TUI

TUI already receives real-time message stream deltas through:
- `message.part.delta` event in sync/event pipeline
- Event wiring in `/packages/opencode/src/cli/cmd/tui/context/sync.tsx`

Delta payload includes:
- `sessionID`
- `messageID`
- `partID`
- `delta` (string fragment)

This allows near-real-time token throughput estimation without blocking.

## 3) Existing token math utility

Token estimation utility exists:
- `/packages/opencode/src/util/token.ts`
- `Token.estimate(text)` with `chars/4` heuristic

This is lightweight enough for high-frequency ingestion in TUI.

## 4) No existing sparkline widget in current TUI stack

There is no blessed-contrib line/sparkline widget in openfds TUI.
Graph rendering must be custom text rendering (recommended Unicode block sparkline).

---

## Proposed Architecture

## A) New monitor logic module

Add:
- `packages/opencode/src/cli/cmd/tui/util/token-monitor.ts`

Responsibility:
- Maintain a 30-slot circular buffer (1 slot = 1 second).
- Accept high-frequency token delta pushes from stream.
- Flush aggregated per-second sample on interval tick.
- Provide current/avg/peak/sparkline values for UI.

Key APIs:
- `push(n: number, ts?: number): void`
- `tick(ts?: number): void`
- `current(): number`
- `history(): number[]`
- `peak(): number`
- `avg(window?: number): number`
- `spark(width: number): string`

## B) New UI component

Add:
- `packages/opencode/src/cli/cmd/tui/routes/session/performance.tsx`

Responsibility:
- Render titled card: **Performance Metrics**
- Display:
  - `Current t/s`
  - `Peak (30s)`
  - Sparkline over 30-second rolling window
- Respect narrow terminal widths (hide or degrade gracefully)

## C) Session layout integration

Modify:
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`

Change from 2-column right side (main + sidebar) to 3-column capable layout:
- Main content
- Performance column (new, ~15–20% width)
- Existing sidebar (42 cols)

Recommended width policy:
- `metricsWidth = clamp(round(totalWidth * 0.18), 24, 36)`
- Hide metrics panel when terminal width too small (e.g. `<120`)
- Keep sidebar behavior unchanged

---

## Sampling Math and Refresh Strategy

## Requirements

- Sampling interval: **1s**
- History window: **30s**
- UI refresh loop: independent (OpenTUI already targets up to 60 FPS)
- Zero conflict between sampling and render

## Approach

1. On each `message.part.delta`:
- Filter to current session
- Ensure part is assistant-generated text/reasoning
- Convert delta string to estimated tokens via `Token.estimate(delta)`
- Accumulate to `pendingTokens` (number only, no rerender)

2. On `setInterval(1000ms)`:
- `sample = pendingTokens`
- `pendingTokens = 0`
- push `sample` into circular buffer
- trigger reactive state update once per second

This avoids high-frequency rerenders while preserving accurate 1s throughput signal.

## Dynamic Y-axis autoscaling

For each rendered graph:
- `yMax = max(historyWindow)` (fallback to `1` to avoid divide-by-zero)
- Normalize each sample: `normalized = sample / yMax`
- Map to Unicode levels: `▁▂▃▄▅▆▇█`

This auto-adapts graph amplitude to current 30-second peak.

---

## Stream Handler Push Instructions (How Data Enters Monitor)

Use existing TUI event stream in session route:
- Register `event.on("message.part.delta", ...)`

Push logic:
1. Ignore events where `event.sessionID !== route.sessionID`
2. Resolve part by `messageID + partID` from `sync.data.part`
3. Accept only `part.type === "text"` or `"reasoning"`
4. Resolve message and ensure `message.role === "assistant"`
5. `monitor.push(Token.estimate(event.delta))`

This keeps monitor updates local to active session and avoids counting unrelated deltas.

---

## Roadmap (Execution Plan)

## Phase 1 — Core monitor engine

Deliver:
- `token-monitor.ts` circular buffer + sparkline renderer
- deterministic behavior with explicit timestamp-based ticking

Acceptance:
- Circular rollover works after >30 samples
- peak/current/avg values correct
- sparkline rendering stable

## Phase 2 — Session UI component

Deliver:
- `performance.tsx` card component
- `Current t/s` numeric indicator
- 30s sparkline graph

Acceptance:
- Graph updates once per second
- Panel width remains within target band (15–20% effective)
- Panel does not break existing prompt/footer layout

## Phase 3 — Wiring into session layout

Deliver:
- Integrate panel into `session/index.tsx`
- Compute widths with sidebar-aware layout math
- Add optional toggle command (`session.metrics.toggle`) and KV flag

Acceptance:
- Sidebar behavior remains unchanged
- Panel hides gracefully in narrow terminals
- No regressions in navigation, prompt submission, scroll behavior

## Phase 4 — Mock stream and verification

Deliver:
- Mock injection mode (dev-only) to feed known token/sec pattern
- Verification tests + manual validation steps

Acceptance:
- Graph visually matches known synthetic waveform over 30s decay
- No measurable impact on stream responsiveness

---

## Quality and Performance Constraints

## Non-blocking guarantee

- Event handler does O(1) numeric accumulation only.
- UI state update only once per second.
- No synchronous heavy parsing per delta.

## Zero-overhead intent

Expected per-delta work:
- couple of comparisons + one `Token.estimate()` + one numeric add

This is negligible relative to stream IO and rendering.

## Backward compatibility

- No changes required to provider/session protocol for v1.
- Existing sidebar/prompt behavior preserved.
- Feature can be toggled and/or hidden by width threshold.

---

## Verification Plan

## Unit Tests (deterministic)

Add tests for monitor engine:
- `packages/opencode/test/cli/cmd/tui/token-monitor.test.ts`

Cases:
1. 30-second rolling window truncation
2. Aggregate multi-delta pushes into 1-second sample
3. Zero-fill on idle seconds
4. Autoscale behavior (`yMax` tracking)
5. Sparkline character mapping bounds

Command:

```bash
cd /Users/smusmanzia/Documents/FDS/openfds/packages/opencode
bun test --timeout 30000 test/cli/cmd/tui/token-monitor.test.ts
```

## Integration/behavior checks

1. Session route render does not regress with new column
2. Sidebar toggle still works
3. Prompt + scroll behavior unchanged

Suggested command set:

```bash
cd /Users/smusmanzia/Documents/FDS/openfds/packages/opencode
bun typecheck
bun test --timeout 30000 test/session/prompt.test.ts test/cli/cmd/tui/prompt-part.test.ts
```

## Mock stream validation (visual accuracy)

Use a mock pattern for 35–40 seconds:
- Example waveform: `2,4,8,12,16,12,8,4,2,...`
- Confirm graph shows:
  - rise/fall shape
  - correct decay as old samples roll out after 30s
  - autoscaling adapts when peak changes

---

## Suggested Implementation Snippet (High-Level)

```ts
// session/index.tsx (high-level flow)
const mon = createTokenMonitor({ windowSec: 30 })
let pending = 0

event.on("message.part.delta", (evt) => {
  if (evt.properties.sessionID !== route.sessionID) return
  if (!isAssistantTextOrReasoning(evt.properties.messageID, evt.properties.partID)) return
  pending += Token.estimate(evt.properties.delta)
})

const timer = setInterval(() => {
  mon.push(pending)
  pending = 0
  setPerfState(mon.snapshot()) // one reactive update per second
}, 1000)
```

---

## Deliverables

1. **Modified TUI layout code**
- session route now supports right-side performance column

2. **Token monitor logic/class**
- circular buffer, rolling 30s stats, sparkline rendering

3. **Stream push instructions**
- `message.part.delta` integration and filter/push logic

4. **Verification artifacts**
- monitor unit tests
- mock-stream validation notes

---

## Risks and Mitigations

1. **Token estimate mismatch vs provider accounting**
- Mitigation: document as real-time estimate; optional future enhancement can publish exact token deltas from server processor.

2. **Terminal width pressure**
- Mitigation: hide panel below threshold and keep sidebar behavior priority.

3. **Over-rendering**
- Mitigation: update UI on 1s ticks only, not on every delta event.

---

## Final Recommendation

Implement this in two layers:
- Reusable `TokenMonitor` engine first
- Then session layout + performance panel integration

This sequencing gives deterministic correctness, low rendering overhead, and easy testability while staying fully compatible with the current openfds TUI architecture.
