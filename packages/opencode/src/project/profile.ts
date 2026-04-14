import path from "path"
import z from "zod"
import { Context, Effect, Layer } from "effect"
import { Instance } from "./instance"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@/filesystem"

export namespace ProjectProfile {
  export const DEFAULT_IGNORE_GLOBS = [
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    ".turbo",
    ".vercel",
    "out",
    "storybook-static",
  ] as const

  const Framework = z.enum(["nextjs", "reactjs", "astrojs", "nestjs", "nodejs", "typescript"])

  export const Info = z.object({
    frameworks: z.array(Framework),
    priority_files: z.array(z.string()),
    ignore_globs: z.array(z.string()),
    preferred_lsp_servers: z.array(z.string()),
  })
  export type Info = z.infer<typeof Info>

  type State = {
    info: Info
  }

  export interface Interface {
    readonly detect: () => Effect.Effect<Info>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectProfile") {}

  const PRIORITY_PATTERNS = [
    "package.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.app.json",
    "jsconfig.json",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "astro.config.mjs",
    "astro.config.js",
    "astro.config.ts",
    "nest-cli.json",
    "pnpm-workspace.yaml",
    "turbo.json",
    "Dockerfile",
    "Dockerfile.dev",
    "Dockerfile.prod",
    "docker-compose.yml",
    "docker-compose.yaml",
  ] as const

  function uniq(items: string[]) {
    return Array.from(new Set(items))
  }

  function up(start: string, stop: string) {
    const dirs = [start]
    let dir = start
    while (dir !== stop) {
      const parent = path.dirname(dir)
      if (parent === dir) break
      dirs.push(parent)
      dir = parent
    }
    return dirs
  }

  const hasAny = Effect.fnUntraced(function* (fs: AppFileSystem.Interface, root: string, names: readonly string[]) {
    for (const name of names) {
      if (yield* fs.existsSafe(path.join(root, name))) return true
    }
    return false
  })

  const readPkg = Effect.fnUntraced(function* (fs: AppFileSystem.Interface, root: string) {
    const file = path.join(root, "package.json")
    const exists = yield* fs.existsSafe(file)
    if (!exists) return undefined
    const parsed = yield* fs.readJson(file).pipe(Effect.orElseSucceed(() => ({})))
    if (!parsed || typeof parsed !== "object") return undefined
    const data = parsed as Record<string, unknown>
    const deps = {
      ...((data.dependencies as Record<string, string> | undefined) ?? {}),
      ...((data.devDependencies as Record<string, string> | undefined) ?? {}),
      ...((data.peerDependencies as Record<string, string> | undefined) ?? {}),
      ...((data.optionalDependencies as Record<string, string> | undefined) ?? {}),
    }
    return {
      file,
      deps: Object.keys(deps),
    }
  })

  const profile = Effect.fn("ProjectProfile.profile")(function* (fs: AppFileSystem.Interface) {
    const dir = Instance.directory
    const root = Instance.worktree
    const dirs = up(dir, root)
    const frames = new Set<z.infer<typeof Framework>>()

    for (const item of dirs) {
      const pkg = yield* readPkg(fs, item)
      if (!pkg) continue
      const deps = new Set(pkg.deps)
      if (deps.has("next")) frames.add("nextjs")
      if (deps.has("react")) frames.add("reactjs")
      if (deps.has("astro")) frames.add("astrojs")
      if (deps.has("@nestjs/core")) frames.add("nestjs")
      if (deps.has("typescript")) frames.add("typescript")
      frames.add("nodejs")
    }

    if (yield* hasAny(fs, dir, ["next.config.js", "next.config.mjs", "next.config.ts"])) frames.add("nextjs")
    if (yield* hasAny(fs, dir, ["astro.config.mjs", "astro.config.js", "astro.config.ts"])) frames.add("astrojs")
    if (yield* fs.existsSafe(path.join(dir, "nest-cli.json"))) frames.add("nestjs")
    if (yield* hasAny(fs, dir, ["tsconfig.json", "tsconfig.base.json", "tsconfig.app.json", "jsconfig.json"])) {
      frames.add("typescript")
    }

    const priority: string[] = []
    for (const item of dirs) {
      for (const name of PRIORITY_PATTERNS) {
        const file = path.join(item, name)
        if (yield* fs.existsSafe(file)) priority.push(path.relative(root, file))
      }

      const wf = path.join(item, ".github", "workflows")
      if (yield* fs.isDir(wf)) {
        const nodes = yield* fs.readDirectoryEntries(wf).pipe(Effect.orElseSucceed(() => []))
        for (const node of nodes) {
          if (node.type !== "file") continue
          if (!node.name.endsWith(".yml") && !node.name.endsWith(".yaml")) continue
          priority.push(path.relative(root, path.join(wf, node.name)))
        }
      }
    }

    const lsp = new Set<string>()
    if (frames.has("typescript") || frames.has("nextjs") || frames.has("nestjs") || frames.has("reactjs")) {
      lsp.add("typescript")
    }
    if (frames.has("astrojs")) {
      lsp.add("astro")
      lsp.add("typescript")
    }
    if (priority.some((item) => item.endsWith(".yml") || item.endsWith(".yaml"))) lsp.add("yaml-ls")
    if (priority.some((item) => item.toLowerCase().includes("docker"))) lsp.add("dockerfile")
    lsp.add("bash")

    return Info.parse({
      frameworks: Array.from(frames),
      priority_files: uniq(priority),
      ignore_globs: [...DEFAULT_IGNORE_GLOBS],
      preferred_lsp_servers: Array.from(lsp),
    })
  })

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const state = yield* InstanceState.make<State>(
        Effect.fn("ProjectProfile.state")(function* () {
          return {
            info: yield* profile(fs),
          }
        }),
      )

      const detect = Effect.fn("ProjectProfile.detect")(function* () {
        return (yield* InstanceState.get(state)).info
      })

      return Service.of({
        detect,
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))
}
