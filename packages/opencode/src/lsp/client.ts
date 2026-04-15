import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types"
import { Log } from "../util/log"
import { Process } from "../util/process"
import { LANGUAGE_EXTENSIONS } from "./language"
import z from "zod"
import type { LSPServer } from "./server"
import { NamedError } from "@opencode-ai/util/error"
import { withTimeout } from "../util/timeout"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"

const DIAGNOSTICS_DEBOUNCE_MS = 150
const DIAGNOSTICS_QUIET_MS = 400

export namespace LSPClient {
  const log = Log.create({ service: "lsp.client" })

  export type Info = NonNullable<Awaited<ReturnType<typeof create>>>

  export type Diagnostic = VSCodeDiagnostic

  /** Structured result from waitForDiagnostics. */
  export interface WaitResult {
    /** How the wait resolved. */
    status: "published" | "timed_out" | "quiet_timeout"
    /** Milliseconds the wait took. */
    duration_ms: number
    /** Diagnostic sequence number at resolution time. */
    seq: number
  }

  export const InitializeError = NamedError.create(
    "LSPInitializeError",
    z.object({
      serverID: z.string(),
    }),
  )

  export const Event = {
    Diagnostics: BusEvent.define(
      "lsp.client.diagnostics",
      z.object({
        serverID: z.string(),
        path: z.string(),
      }),
    ),
  }

  export async function create(input: { serverID: string; server: LSPServer.Handle; root: string }) {
    const l = log.clone().tag("serverID", input.serverID)
    l.info("starting client")

    const spawnedAt = Date.now()

    const connection = createMessageConnection(
      new StreamMessageReader(input.server.process.stdout as any),
      new StreamMessageWriter(input.server.process.stdin as any),
    )

    const diagnostics = new Map<string, Diagnostic[]>()
    let lastDiagnosticsAt: number | undefined
    let lastRequestError: string | undefined
    let lastTouchResult: WaitResult | undefined
    /** Monotonically increasing per-file diagnostic sequence counter for anti-stale detection. */
    const diagnosticSeq = new Map<string, number>()
    let globalSeq = 0
    connection.onNotification("textDocument/publishDiagnostics", (params) => {
      const filePath = Filesystem.normalizePath(fileURLToPath(params.uri))
      globalSeq++
      diagnosticSeq.set(filePath, globalSeq)
      l.info("textDocument/publishDiagnostics", {
        path: filePath,
        count: params.diagnostics.length,
        seq: globalSeq,
      })
      diagnostics.set(filePath, params.diagnostics)
      lastDiagnosticsAt = Date.now()
      Bus.publish(Event.Diagnostics, { path: filePath, serverID: input.serverID })
    })
    connection.onRequest("window/workDoneProgress/create", (params) => {
      l.info("window/workDoneProgress/create", params)
      return null
    })
    connection.onRequest("workspace/configuration", async () => {
      // Return server initialization options
      return [input.server.initialization ?? {}]
    })
    connection.onRequest("client/registerCapability", async () => {})
    connection.onRequest("client/unregisterCapability", async () => {})
    connection.onRequest("workspace/workspaceFolders", async () => [
      {
        name: "workspace",
        uri: pathToFileURL(input.root).href,
      },
    ])
    connection.listen()

    l.info("sending initialize")
    await withTimeout(
      connection.sendRequest("initialize", {
        rootUri: pathToFileURL(input.root).href,
        processId: input.server.process.pid,
        workspaceFolders: [
          {
            name: "workspace",
            uri: pathToFileURL(input.root).href,
          },
        ],
        initializationOptions: {
          ...input.server.initialization,
        },
        capabilities: {
          window: {
            workDoneProgress: true,
          },
          workspace: {
            configuration: true,
            didChangeWatchedFiles: {
              dynamicRegistration: true,
            },
          },
          textDocument: {
            synchronization: {
              didOpen: true,
              didChange: true,
            },
            publishDiagnostics: {
              versionSupport: true,
            },
          },
        },
      }),
      45_000,
    ).catch((err) => {
      l.error("initialize error", { error: err })
      throw new InitializeError(
        { serverID: input.serverID },
        {
          cause: err,
        },
      )
    })

    await connection.sendNotification("initialized", {})

    if (input.server.initialization) {
      await connection.sendNotification("workspace/didChangeConfiguration", {
        settings: input.server.initialization,
      })
    }

    // Wrap connection.sendRequest to capture request errors for health telemetry.
    const originalSendRequest = connection.sendRequest.bind(connection) as (...args: unknown[]) => Promise<unknown>
    ;(connection as any).sendRequest = (...args: unknown[]) => {
      const promise = originalSendRequest(...args)
      return promise.then(
        (result: unknown) => {
          lastRequestError = undefined
          return result
        },
        (err: unknown) => {
          lastRequestError = err instanceof Error ? err.message : String(err)
          throw err
        },
      )
    }

    const files: {
      [path: string]: number
    } = {}

    const result = {
      root: input.root,
      get serverID() {
        return input.serverID
      },
      get connection() {
        return connection
      },
      notify: {
        async open(input: { path: string }) {
          input.path = path.isAbsolute(input.path) ? input.path : path.resolve(Instance.directory, input.path)
          const text = await Filesystem.readText(input.path)
          const extension = path.extname(input.path)
          const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"

          const version = files[input.path]
          if (version !== undefined) {
            log.info("workspace/didChangeWatchedFiles", input)
            await connection.sendNotification("workspace/didChangeWatchedFiles", {
              changes: [
                {
                  uri: pathToFileURL(input.path).href,
                  type: 2, // Changed
                },
              ],
            })

            const next = version + 1
            files[input.path] = next
            log.info("textDocument/didChange", {
              path: input.path,
              version: next,
            })
            await connection.sendNotification("textDocument/didChange", {
              textDocument: {
                uri: pathToFileURL(input.path).href,
                version: next,
              },
              contentChanges: [{ text }],
            })
            return
          }

          log.info("workspace/didChangeWatchedFiles", input)
          await connection.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [
              {
                uri: pathToFileURL(input.path).href,
                type: 1, // Created
              },
            ],
          })

          log.info("textDocument/didOpen", input)
          diagnostics.delete(input.path)
          await connection.sendNotification("textDocument/didOpen", {
            textDocument: {
              uri: pathToFileURL(input.path).href,
              languageId,
              version: 0,
              text,
            },
          })
          files[input.path] = 0
          return
        },
      },
      get diagnostics() {
        return diagnostics
      },
      get spawnedAt() {
        return spawnedAt
      },
      get lastDiagnosticsAt() {
        return lastDiagnosticsAt
      },
      get lastRequestError() {
        return lastRequestError
      },
      get lastTouchResult() {
        return lastTouchResult
      },
      get diagnosticsSequence() {
        return globalSeq
      },
      async waitForDiagnostics(input: { path: string }): Promise<WaitResult> {
        const normalizedPath = Filesystem.normalizePath(
          path.isAbsolute(input.path) ? input.path : path.resolve(Instance.directory, input.path),
        )
        const startTime = Date.now()
        const seqAtStart = diagnosticSeq.get(normalizedPath) ?? 0
        log.info("waiting for diagnostics", { path: normalizedPath, seqAtStart })
        let unsub: (() => void) | undefined
        let debounceTimer: ReturnType<typeof setTimeout> | undefined
        let quietTimer: ReturnType<typeof setTimeout> | undefined
        let resolvedStatus: WaitResult["status"] = "timed_out"

        return await withTimeout(
          new Promise<WaitResult>((resolve) => {
            const done = (status: WaitResult["status"]) => {
              resolvedStatus = status
              if (debounceTimer) clearTimeout(debounceTimer)
              if (quietTimer) clearTimeout(quietTimer)
              unsub?.()
              resolve({
                status,
                duration_ms: Date.now() - startTime,
                seq: diagnosticSeq.get(normalizedPath) ?? seqAtStart,
              })
            }

            quietTimer = setTimeout(() => {
              log.info("diagnostics quiet timeout", { path: normalizedPath })
              done("quiet_timeout")
            }, DIAGNOSTICS_QUIET_MS)

            unsub = Bus.subscribe(Event.Diagnostics, (event) => {
              if (event.properties.path === normalizedPath && event.properties.serverID === result.serverID) {
                const currentSeq = diagnosticSeq.get(normalizedPath) ?? 0
                // Anti-stale: only accept diagnostics published after the wait began
                if (currentSeq <= seqAtStart) {
                  log.info("ignoring stale diagnostic", {
                    path: normalizedPath,
                    currentSeq,
                    seqAtStart,
                  })
                  return
                }
                // Debounce to allow LSP to send follow-up diagnostics (e.g., semantic after syntax)
                if (debounceTimer) clearTimeout(debounceTimer)
                debounceTimer = setTimeout(() => {
                  log.info("got diagnostics", { path: normalizedPath, seq: currentSeq })
                  done("published")
                }, DIAGNOSTICS_DEBOUNCE_MS)
              }
            })
          }),
          3000,
        )
          .catch(
            () =>
              ({
                status: "timed_out",
                duration_ms: Date.now() - startTime,
                seq: diagnosticSeq.get(normalizedPath) ?? seqAtStart,
              }) as WaitResult,
          )
          .finally(() => {
            if (debounceTimer) clearTimeout(debounceTimer)
            if (quietTimer) clearTimeout(quietTimer)
            unsub?.()
          })
          .then((waitResult) => {
            lastTouchResult = waitResult
            return waitResult
          })
      },
      async shutdown() {
        l.info("shutting down")
        connection.end()
        connection.dispose()
        await Process.stop(input.server.process)
        l.info("shutdown")
      },
    }

    l.info("initialized")

    return result
  }
}
