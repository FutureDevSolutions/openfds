import z from "zod"
import * as path from "path"
import { Effect } from "effect"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { FileTime } from "../file/time"
import { AppFileSystem } from "../filesystem"
import { Instance } from "../project/instance"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import { DiagnosticService } from "../lsp/diagnostic"

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service
    const filetime = yield* FileTime.Service
    const bus = yield* Bus.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        content: z.string().describe("The content to write to the file"),
        filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
      }),
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(Instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)

          const exists = yield* fs.existsSafe(filepath)
          const contentOld = exists ? yield* fs.readFileString(filepath) : ""
          if (exists) yield* filetime.assert(ctx.sessionID, filepath)

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(Instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          yield* fs.writeWithDirs(filepath, params.content)
          yield* format.file(filepath)
          yield* bus.publish(File.Event.Edited, { file: filepath })
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })
          yield* filetime.read(ctx.sessionID, filepath)

          // Capture baseline diagnostics before LSP re-analysis
          const baselineDiags = yield* lsp.diagnostics()
          const baselineSnapshot = DiagnosticService.snapshot(baselineDiags, [filepath])

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, true)
          const diagnostics = yield* lsp.diagnostics()
          const status = yield* lsp.status()

          // Compute delta against baseline
          const afterSnapshot = DiagnosticService.snapshot(diagnostics, [filepath])
          const diagDelta = DiagnosticService.delta(baselineSnapshot, afterSnapshot)
          const deltaText = DiagnosticService.formatDelta(diagDelta)
          if (deltaText) {
            output += `\n\n${deltaText}`
          }
          if (DiagnosticService.hasNewErrors(diagDelta)) {
            output += `\nNew errors introduced — fix required.`
          }

          const selected = LSP.Diagnostic.select({
            file: AppFileSystem.normalizePath(filepath),
            diagnostics,
            status,
            spill: 2,
          })
          if (selected.current) {
            output += `\n\nLSP errors detected in this file, please fix:\n${selected.current}`
          }
          if (selected.related.length > 0) {
            output += `\n\nLSP errors detected in related files:\n${selected.related.map((item) => item.block).join("\n")}`
          }

          const needs_fix = DiagnosticService.hasNewErrors(diagDelta)
          return {
            title: path.relative(Instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
              delta: {
                new_errors: diagDelta.new_errors,
                new_warnings: diagDelta.new_warnings,
                resolved_errors: diagDelta.resolved_errors,
                resolved_warnings: diagDelta.resolved_warnings,
              },
              needs_fix,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
