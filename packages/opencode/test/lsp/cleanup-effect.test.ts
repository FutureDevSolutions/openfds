import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import path from "path"
import { setTimeout as sleep } from "node:timers/promises"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "../../src/filesystem"
import { LSP } from "../../src/lsp"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(LSP.defaultLayer, CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer))
const server = path.join(import.meta.dir, "../fixture/lsp/fake-lsp-server.js")

describe("LSP cleanup", () => {
  it.live("shuts down clients when their root is deleted", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const mark = path.join(path.dirname(dir), `${path.basename(dir)}.exit`)
        const file = path.join(dir, "test.ts")

        yield* Effect.addFinalizer(() => fs.remove(mark, { force: true }).pipe(Effect.ignore))
        yield* fs.writeWithDirs(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            lsp: {
              typescript: { disabled: true },
              fake: {
                command: [process.execPath, server, mark],
                extensions: [".ts"],
              },
            },
          }),
        )
        yield* fs.writeWithDirs(file, "export {}\n")
        yield* LSP.Service.use((svc) => svc.touchFile(file))
        expect(yield* LSP.Service.use((svc) => svc.status())).toHaveLength(1)

        const done = yield* Deferred.make<void>()
        const off = Bus.subscribe(LSP.Event.Updated, () => {
          Deferred.doneUnsafe(done, Effect.void)
        })
        yield* Effect.addFinalizer(() => Effect.sync(off))

        yield* fs.remove(dir, { recursive: true, force: true })
        yield* Deferred.await(done).pipe(Effect.timeout("2 seconds"))

        const stopped = yield* Effect.promise(async () => {
          for (const _ of Array.from({ length: 20 })) {
            if (await fs.exists(mark)) return true
            await sleep(50)
          }
          return false
        })

        expect(stopped).toBe(true)
        expect(yield* LSP.Service.use((svc) => svc.status())).toHaveLength(0)
      }),
    ),
  )
})
