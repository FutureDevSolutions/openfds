import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { provideInstance, tmpdir } from "../fixture/fixture"

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

const PROMPT_DIR = path.resolve(__dirname, "../../src/session/prompt")
const BUILD_PROMPT = fs.readFileSync(path.join(PROMPT_DIR, "openfds-build.txt"), "utf-8")
const PLAN_PROMPT = fs.readFileSync(path.join(PROMPT_DIR, "openfds-plan.txt"), "utf-8")

describe("session.system", () => {
  test("skills output is sorted by name and stable across calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await load(tmp.path, (svc) => svc.get("build"))
          const runSkills = Effect.gen(function* () {
            const svc = yield* SystemPrompt.Service
            return yield* svc.skills(build!)
          }).pipe(Effect.provide(SystemPrompt.defaultLayer))

          const first = await Effect.runPromise(runSkills)
          const second = await Effect.runPromise(runSkills)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})

// ── Build prompt enforcement language ───────────────────────────────

describe("openfds-build prompt policy enforcement", () => {
  test("contains mandatory MUST language", () => {
    expect(BUILD_PROMPT).toContain("MUST")
  })

  test("requires LSP self-correction cycle", () => {
    expect(BUILD_PROMPT).toContain("LSP")
    expect(BUILD_PROMPT).toContain("diagnostics")
    expect(BUILD_PROMPT).toContain("severity-1")
    expect(BUILD_PROMPT).toContain("fix them")
  })

  test("requires static gate (typecheck)", () => {
    expect(BUILD_PROMPT).toContain("Static gate")
    expect(BUILD_PROMPT).toContain("typecheck")
    expect(BUILD_PROMPT).toContain("zero new errors")
  })

  test("requires test gate", () => {
    expect(BUILD_PROMPT).toContain("Test gate")
    expect(BUILD_PROMPT).toContain("relevant tests")
  })

  test("requires explicit completion criteria", () => {
    expect(BUILD_PROMPT).toContain("NOT complete until")
    expect(BUILD_PROMPT).toContain("gates")
    expect(BUILD_PROMPT).toContain("green")
  })

  test("prohibits skipping gates", () => {
    expect(BUILD_PROMPT).toContain("do not skip")
  })

  test("requires explicit acknowledgment when gates cannot be run", () => {
    expect(BUILD_PROMPT).toContain("state that explicitly")
  })

  test("preserves existing framework context", () => {
    expect(BUILD_PROMPT).toContain("Next.js")
    expect(BUILD_PROMPT).toContain("TypeScript")
    expect(BUILD_PROMPT).toContain("Docker")
    expect(BUILD_PROMPT).toContain("framework-native")
  })
})

// ── Plan prompt enforcement language ────────────────────────────────

describe("openfds-plan prompt policy enforcement", () => {
  test("contains mandatory MUST language", () => {
    expect(PLAN_PROMPT).toContain("MUST")
  })

  test("requires LSP validation step in plans", () => {
    expect(PLAN_PROMPT).toContain("LSP")
    expect(PLAN_PROMPT).toContain("diagnostics")
    expect(PLAN_PROMPT).toContain("severity-1")
  })

  test("requires static gate step in plans", () => {
    expect(PLAN_PROMPT).toContain("Static gate")
    expect(PLAN_PROMPT).toContain("typecheck")
  })

  test("requires test gate step in plans", () => {
    expect(PLAN_PROMPT).toContain("Test gate")
    expect(PLAN_PROMPT).toContain("pass criteria")
  })

  test("requires Definition of Done section", () => {
    expect(PLAN_PROMPT).toContain("Definition of Done")
    expect(PLAN_PROMPT).toContain("gates")
  })

  test("prohibits omitting verification steps", () => {
    expect(PLAN_PROMPT).toContain("Do NOT produce plans that omit verification")
  })

  test("requires explicit explanation when verification is not applicable", () => {
    expect(PLAN_PROMPT).toContain("state this explicitly")
  })

  test("preserves existing framework/deployment context", () => {
    expect(PLAN_PROMPT).toContain("framework")
    expect(PLAN_PROMPT).toContain("Docker")
    expect(PLAN_PROMPT).toContain("deployment")
  })
})

// ── Cross-prompt consistency ────────────────────────────────────────

describe("build/plan prompt cross-consistency", () => {
  test("both prompts reference LSP diagnostics", () => {
    expect(BUILD_PROMPT).toContain("LSP")
    expect(PLAN_PROMPT).toContain("LSP")
  })

  test("both prompts use MUST enforcement", () => {
    expect(BUILD_PROMPT).toContain("MUST")
    expect(PLAN_PROMPT).toContain("MUST")
  })

  test("both prompts reference static gate (typecheck)", () => {
    expect(BUILD_PROMPT).toContain("typecheck")
    expect(PLAN_PROMPT).toContain("typecheck")
  })

  test("both prompts reference test gate", () => {
    expect(BUILD_PROMPT).toContain("Test gate")
    expect(PLAN_PROMPT).toContain("Test gate")
  })

  test("build prompt does not contradict plan prompt gate language", () => {
    // Both use numbered gate structure: LSP (1), Static (2), Test (3)
    const buildLSPIdx = BUILD_PROMPT.indexOf("LSP self-correction")
    const buildStaticIdx = BUILD_PROMPT.indexOf("Static gate")
    const buildTestIdx = BUILD_PROMPT.indexOf("Test gate")
    expect(buildLSPIdx).toBeLessThan(buildStaticIdx)
    expect(buildStaticIdx).toBeLessThan(buildTestIdx)

    const planLSPIdx = PLAN_PROMPT.indexOf("LSP validation")
    const planStaticIdx = PLAN_PROMPT.indexOf("Static gate")
    const planTestIdx = PLAN_PROMPT.indexOf("Test gate")
    expect(planLSPIdx).toBeLessThan(planStaticIdx)
    expect(planStaticIdx).toBeLessThan(planTestIdx)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Adversarial verification — 4 attack scenarios
// ═══════════════════════════════════════════════════════════════════

describe("ADVERSARIAL 1: ambiguous requests — no trivial-change escape hatch", () => {
  test("build prompt applies to 'every final answer' — no exception for trivial changes", () => {
    // The phrase "before every final answer" must be present and unconditional
    expect(BUILD_PROMPT).toContain("before every final answer")
    // Must NOT contain language that creates an exception for "simple" or "trivial" changes
    expect(BUILD_PROMPT).not.toMatch(/except\s+(for\s+)?(trivial|simple|minor)/i)
    expect(BUILD_PROMPT).not.toMatch(/skip.*(trivial|simple|minor)/i)
  })

  test("plan prompt requires verification in every plan — no exception clause", () => {
    expect(PLAN_PROMPT).toContain("every plan MUST include")
    expect(PLAN_PROMPT).not.toMatch(/except\s+(for\s+)?(trivial|simple|minor)/i)
  })
})

describe("ADVERSARIAL 2: multi-step tasks — no early 'done' without gates", () => {
  test("build prompt blocks premature completion explicitly", () => {
    expect(BUILD_PROMPT).toContain("NOT complete until")
    expect(BUILD_PROMPT).toContain("do not skip gates or declare success prematurely")
  })

  test("build prompt requires per-mutation LSP check, not just final", () => {
    // "after every file mutation" — not "at the end"
    expect(BUILD_PROMPT).toContain("after every file mutation")
  })

  test("build prompt requires fix-before-proceed discipline", () => {
    // Must fix errors before proceeding to next step
    expect(BUILD_PROMPT).toContain("fix them before proceeding")
  })
})

describe("ADVERSARIAL 3: prompt injection resistance", () => {
  test("build prompt uses 'Mandatory' framing that is hard to override", () => {
    expect(BUILD_PROMPT).toContain("Mandatory verification protocol")
  })

  test("plan prompt uses 'Mandatory' framing that is hard to override", () => {
    expect(PLAN_PROMPT).toContain("Mandatory verification checkpoints")
  })

  test("build-switch.txt does not override or contradict gate enforcement", () => {
    const switchContent = fs.readFileSync(path.join(PROMPT_DIR, "build-switch.txt"), "utf-8")
    // Build-switch must NOT contain gate-bypassing language
    expect(switchContent).not.toMatch(/skip.*gate/i)
    expect(switchContent).not.toMatch(/ignore.*verification/i)
    expect(switchContent).not.toMatch(/no.*need.*to.*check/i)
    // It should grant tool permissions, not revoke verification
    expect(switchContent).toContain("permitted to make file changes")
  })
})

describe("ADVERSARIAL 4: plan-to-build handoff — verification persists", () => {
  test("plan prompt requires plans to end with Definition of Done", () => {
    // This ensures the plan itself encodes the gates, so even if the build
    // agent reads the plan, the verification steps are in the plan text
    expect(PLAN_PROMPT).toContain("plan MUST end with")
    expect(PLAN_PROMPT).toContain("Definition of Done")
    expect(PLAN_PROMPT).toContain("exact gates that must be green")
  })

  test("plan prompt prohibits plans without verification steps", () => {
    expect(PLAN_PROMPT).toContain("Do NOT produce plans that omit verification steps")
  })

  test("build prompt gate protocol is unconditional — active regardless of plan presence", () => {
    // The build prompt's MUST language is not conditioned on "if a plan exists"
    expect(BUILD_PROMPT).not.toMatch(/if.*plan.*exists/i)
    // It's always active
    expect(BUILD_PROMPT).toContain("you MUST follow this before every final answer")
  })
})
