import z from "zod"
import path from "path"
import { Effect } from "effect"
import { Tool } from "./tool"
import { MCP } from "../mcp"
import { AppFileSystem } from "../filesystem"
import { Global } from "../global"
import { ToolID } from "./schema"

const BLOB_DIR = path.join(Global.Path.data, "mcp-blobs")

const ListParameters = z.object({
  server: z
    .string()
    .optional()
    .describe("Optional MCP server name to filter resources. Omit to list resources from all connected servers."),
})

const LIST_DESCRIPTION = `List available MCP resources across connected servers.

Returns a structured listing of resources exposed by MCP servers, including their URIs, descriptions, and MIME types. Use this to discover what resources are available before reading them.

Each resource entry includes:
- server: the MCP server that provides it
- name: human-readable resource name
- uri: the URI to pass to the read_mcp_resource tool
- description: what the resource contains (if provided)
- mimeType: content type (if known)`

type Meta = Record<string, any>

export const ListMcpResourcesTool = Tool.define(
  "list_mcp_resources",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    return {
      description: LIST_DESCRIPTION,
      parameters: ListParameters,
      execute: (params: z.infer<typeof ListParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "list_mcp_resources",
            patterns: [params.server ?? "*"],
            always: ["*"],
            metadata: { server: params.server },
          })

          const statuses = yield* mcp.status()
          const connectedServers = Object.entries(statuses)
            .filter(([, s]) => s.status === "connected")
            .map(([name]) => name)

          if (connectedServers.length === 0) {
            return {
              title: "List MCP resources",
              metadata: { count: 0 } as Meta,
              output: "No MCP servers are currently connected. Check your MCP server configuration.",
            }
          }

          if (params.server && !connectedServers.includes(params.server)) {
            const status = statuses[params.server]
            if (!status) {
              return {
                title: "List MCP resources",
                metadata: { count: 0, error: "server_not_found" } as Meta,
                output: `MCP server "${params.server}" is not configured. Available servers: ${connectedServers.join(", ")}`,
              }
            }
            return {
              title: "List MCP resources",
              metadata: { count: 0, error: "server_disconnected", serverStatus: status.status } as Meta,
              output: `MCP server "${params.server}" is not connected (status: ${status.status}). ${
                status.status === "needs_auth"
                  ? "Authentication is required — the user must complete the OAuth flow."
                  : status.status === "failed" && "error" in status
                    ? `Error: ${status.error}`
                    : "Try reconnecting the server."
              }`,
            }
          }

          const allResources = yield* mcp.resources()
          const entries = Object.values(allResources).filter(
            (r) => !params.server || r.client === params.server,
          )

          if (entries.length === 0) {
            const scope = params.server ? `server "${params.server}"` : "any connected server"
            return {
              title: "List MCP resources",
              metadata: { count: 0 } as Meta,
              output: `No resources found on ${scope}. The server may not expose any resources, or resources may require authentication.`,
            }
          }

          const lines = entries.map((r) => {
            const parts = [`- **${r.name}**`]
            parts.push(`  URI: ${r.uri}`)
            parts.push(`  Server: ${r.client}`)
            if (r.description) parts.push(`  Description: ${r.description}`)
            if (r.mimeType) parts.push(`  Type: ${r.mimeType}`)
            return parts.join("\n")
          })

          return {
            title: `Listed ${entries.length} MCP resource(s)`,
            metadata: {
              count: entries.length,
              servers: [...new Set(entries.map((r) => r.client))],
            } as Meta,
            output: `Found ${entries.length} resource(s):\n\n${lines.join("\n\n")}`,
          }
        }),
    }
  }),
)

const ReadParameters = z.object({
  server: z.string().describe("The MCP server name that provides the resource."),
  uri: z.string().describe("The resource URI to read (as returned by list_mcp_resources)."),
})

const READ_DESCRIPTION = `Read a specific MCP resource by URI from a connected server.

Returns the resource content. Text resources are returned inline (truncated if large). Binary resources (images, PDFs, etc.) are persisted to disk and a file path reference is returned instead of the raw content.

Use list_mcp_resources first to discover available resource URIs.`

export const ReadMcpResourceTool = Tool.define(
  "read_mcp_resource",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const fs = yield* AppFileSystem.Service

    return {
      description: READ_DESCRIPTION,
      parameters: ReadParameters,
      execute: (params: z.infer<typeof ReadParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "read_mcp_resource",
            patterns: [params.uri],
            always: ["*"],
            metadata: { server: params.server, uri: params.uri },
          })

          const statuses = yield* mcp.status()
          const serverStatus = statuses[params.server]

          if (!serverStatus) {
            return {
              title: "Read MCP resource",
              metadata: { error: "server_not_found" } as Meta,
              output: `MCP server "${params.server}" is not configured. Use list_mcp_resources to see available servers.`,
            }
          }
          if (serverStatus.status !== "connected") {
            return {
              title: "Read MCP resource",
              metadata: { error: "server_disconnected", serverStatus: serverStatus.status } as Meta,
              output: `MCP server "${params.server}" is not connected (status: ${serverStatus.status}). ${
                serverStatus.status === "needs_auth"
                  ? "Authentication is required."
                  : serverStatus.status === "failed" && "error" in serverStatus
                    ? `Error: ${serverStatus.error}`
                    : "Try reconnecting the server."
              }`,
            }
          }

          const result = yield* mcp.readResource(params.server, params.uri)

          if (!result || !result.contents || result.contents.length === 0) {
            return {
              title: "Read MCP resource",
              metadata: { error: "not_found", uri: params.uri } as Meta,
              output: `Resource not found or empty: "${params.uri}" on server "${params.server}". Verify the URI with list_mcp_resources.`,
            }
          }

          const textParts: string[] = []
          const blobPaths: string[] = []

          for (const content of result.contents) {
            const mime = content.mimeType ?? "application/octet-stream"

            if ("text" in content && content.text != null) {
              textParts.push(content.text)
            } else if ("blob" in content && content.blob != null) {
              // Persist binary blob to disk — never inject raw base64 into LLM context
              const ext = extensionFromMime(mime)
              const filename = `${ToolID.ascending()}${ext}`
              const filepath = path.join(BLOB_DIR, filename)

              yield* fs.ensureDir(BLOB_DIR).pipe(Effect.orDie)
              const buf = Buffer.from(content.blob, "base64")
              yield* Effect.tryPromise({
                try: () => Bun.write(filepath, buf),
                catch: (e) => new Error(`Failed to persist blob: ${e}`),
              }).pipe(Effect.orDie)

              blobPaths.push(filepath)

              textParts.push(
                `[Binary content saved to: ${filepath}]\n  MIME: ${mime}\n  Size: ${buf.length} bytes\n  Use the Read tool to inspect this file if needed.`,
              )
            }
          }

          const output = textParts.join("\n\n")

          return {
            title: `Read resource: ${params.uri}`,
            metadata: {
              uri: params.uri,
              server: params.server,
              contentCount: result.contents.length,
              ...(blobPaths.length > 0 && { blobPaths }),
            } as Meta,
            output,
          }
        }),
    }
  }),
)

function extensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "application/json": ".json",
    "text/plain": ".txt",
    "text/html": ".html",
    "text/csv": ".csv",
    "application/xml": ".xml",
    "application/zip": ".zip",
  }
  return map[mime] ?? ".bin"
}
