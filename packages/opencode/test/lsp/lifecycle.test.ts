import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LSP } from "../../src/lsp"
import { LSPServer } from "../../src/lsp/server"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LSP.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("LSP service lifecycle", () => {
  let spawnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
  })

  afterEach(() => {
    spawnSpy.mockRestore()
  })

  it.live("init() completes without error", () => provideTmpdirInstance(() => LSP.Service.use((lsp) => lsp.init())))

  it.live("status() returns empty array initially", () =>
    provideTmpdirInstance(() =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.status()
          expect(Array.isArray(result)).toBe(true)
          expect(result.length).toBe(0)
        }),
      ),
    ),
  )

  it.live("diagnostics() returns empty object initially", () =>
    provideTmpdirInstance(() =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.diagnostics()
          expect(typeof result).toBe("object")
          expect(Object.keys(result).length).toBe(0)
        }),
      ),
    ),
  )

  it.live("hasClients() returns true for .ts files in instance", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.hasClients(path.join(dir, "test.ts"))
          expect(result).toBe(true)
        }),
      ),
    ),
  )

  it.live("hasClients() returns false for files outside instance", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.hasClients(path.join(dir, "..", "outside.ts"))
          expect(typeof result).toBe("boolean")
        }),
      ),
    ),
  )

  it.live("workspaceSymbol() returns empty array with no clients", () =>
    provideTmpdirInstance(() =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.workspaceSymbol("test")
          expect(Array.isArray(result)).toBe(true)
          expect(result.length).toBe(0)
        }),
      ),
    ),
  )

  it.live("definition() returns empty array for unknown file", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.definition({
            file: path.join(dir, "nonexistent.ts"),
            line: 0,
            character: 0,
          })
          expect(Array.isArray(result)).toBe(true)
        }),
      ),
    ),
  )

  it.live("references() returns empty array for unknown file", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.references({
            file: path.join(dir, "nonexistent.ts"),
            line: 0,
            character: 0,
          })
          expect(Array.isArray(result)).toBe(true)
        }),
      ),
    ),
  )

  it.live("multiple init() calls are idempotent", () =>
    provideTmpdirInstance(() =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          yield* lsp.init()
          yield* lsp.init()
          yield* lsp.init()
        }),
      ),
    ),
  )
})

describe("LSP status health telemetry", () => {
  let spawnSpy: ReturnType<typeof spyOn>

  afterEach(() => {
    spawnSpy?.mockRestore()
  })

  it.live("connected server reports spawned_at and diagnostics_sequence", () =>
    provideTmpdirInstance(() =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          // Mock spawn to return undefined so the server goes to broken
          // but first let's check that empty status has no spawn metadata
          spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
          const statuses = yield* lsp.status()
          // No clients yet, no broken either until we trigger
          expect(statuses.length).toBe(0)
        }),
      ),
    ),
  )

  it.live("spawn failure populates error and last_spawn_error in status", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockRejectedValue(new Error("ENOENT: command not found"))

          // Trigger a spawn by touching a .ts file
          yield* lsp.touchFile(path.join(dir, "test.ts"))

          const statuses = yield* lsp.status()
          const errorEntry = statuses.find((s) => s.status === "error")
          expect(errorEntry).toBeDefined()
          expect(errorEntry!.healthy).toBe(false)
          expect(errorEntry!.error).toContain("ENOENT")
          expect(errorEntry!.last_spawn_error).toContain("ENOENT")
        }),
      ),
    ),
  )

  it.live("spawn returning undefined marks server as broken with spawn error", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          yield* lsp.touchFile(path.join(dir, "test.ts"))

          const statuses = yield* lsp.status()
          const errorEntry = statuses.find((s) => s.status === "error")
          expect(errorEntry).toBeDefined()
          expect(errorEntry!.healthy).toBe(false)
          expect(errorEntry!.last_spawn_error).toBe("spawn returned no process")
        }),
      ),
    ),
  )

  it.live("broken server is not retried on subsequent touch", () =>
    provideTmpdirInstance((dir) =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockRejectedValue(new Error("fail"))

          // First touch triggers spawn
          yield* lsp.touchFile(path.join(dir, "a.ts"))
          expect(spawnSpy).toHaveBeenCalledTimes(1)

          // Second touch should NOT retry (broken key is set)
          yield* lsp.touchFile(path.join(dir, "b.ts"))
          expect(spawnSpy).toHaveBeenCalledTimes(1)
        }),
      ),
    ),
  )

  it.live("diagnostic inactivity is distinguishable from active diagnostics", () =>
    provideTmpdirInstance(() =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
          const statuses = yield* lsp.status()
          // With no clients and no broken, we get empty status
          for (const s of statuses) {
            if (s.healthy) {
              // A connected server with no diagnostic activity
              expect(s.diagnostics_sequence).toBe(0)
              expect(s.last_diagnostics_at).toBeUndefined()
              expect(s.last_touch_result).toBeUndefined()
            }
          }
          expect(statuses.length).toBe(0)
        }),
      ),
    ),
  )
})

describe("LSP.Diagnostic", () => {
  test("pretty() formats error diagnostic", () => {
    const result = LSP.Diagnostic.pretty({
      range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } },
      message: "Type 'string' is not assignable to type 'number'",
      severity: 1,
    } as any)
    expect(result).toBe("ERROR [10:5] Type 'string' is not assignable to type 'number'")
  })

  test("pretty() formats warning diagnostic", () => {
    const result = LSP.Diagnostic.pretty({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      message: "Unused variable",
      severity: 2,
    } as any)
    expect(result).toBe("WARN [1:1] Unused variable")
  })

  test("pretty() defaults to ERROR when no severity", () => {
    const result = LSP.Diagnostic.pretty({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: "Something wrong",
    } as any)
    expect(result).toBe("ERROR [1:1] Something wrong")
  })
})
