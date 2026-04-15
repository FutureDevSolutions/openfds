import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"

const Parameters = z.object({
  query: z
    .string()
    .describe(
      'Find and activate deferred tools by name or keyword. Use "select:name1,name2" to activate specific tools by exact name, or use keywords to search descriptions.',
    ),
  max_results: z.number().int().min(1).max(20).default(5).describe("Maximum number of results to return (default: 5)"),
})

const DESCRIPTION = `Search for and activate deferred tools that are not in the current active tool set.

Some tools are deferred to keep the baseline tool set minimal for performance. Use this tool to discover and activate them when needed.

Query formats:
- "select:name1,name2" — activate specific tools by exact name (case-insensitive)
- "websearch fetch" — keyword search across tool names and descriptions
- "+lsp hover" — require "lsp" in the tool name, rank by remaining keywords

Once activated, the tools become available for the remainder of the session.`

/**
 * Per-session set of activated deferred tool IDs.
 * Shared across all ToolSearch instances within a session via the module scope.
 * The prompt path reads this to include activated deferred tools.
 */
const activatedSets = new Map<string, Set<string>>()

export namespace ToolSearchState {
  export function getActivated(sessionID: string): Set<string> {
    let set = activatedSets.get(sessionID)
    if (!set) {
      set = new Set()
      activatedSets.set(sessionID, set)
    }
    return set
  }

  export function activate(sessionID: string, toolIds: string[]): void {
    const set = getActivated(sessionID)
    for (const id of toolIds) set.add(id)
  }

  export function isActivated(sessionID: string, toolId: string): boolean {
    return activatedSets.get(sessionID)?.has(toolId) ?? false
  }

  /** Clear session state (for testing). */
  export function clear(sessionID?: string): void {
    if (sessionID) {
      activatedSets.delete(sessionID)
    } else {
      activatedSets.clear()
    }
  }

  /** Catalog entry for a deferred tool — set by the prompt path each loop iteration. */
  export interface DeferredEntry {
    id: string
    description: string
  }

  const catalogMap = new Map<string, DeferredEntry[]>()

  /** Set the deferred tool catalog for a session. Called from prompt.ts. */
  export function setCatalog(sessionID: string, entries: DeferredEntry[]): void {
    catalogMap.set(sessionID, entries)
  }

  /** Get the deferred tool catalog for a session. */
  export function getCatalog(sessionID: string): DeferredEntry[] {
    return catalogMap.get(sessionID) ?? []
  }
}

type Meta = Record<string, any>

export const ToolSearchTool = Tool.define(
  "tool_search",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const catalog = ToolSearchState.getCatalog(ctx.sessionID)

        if (catalog.length === 0) {
          return {
            title: "Tool search",
            metadata: { count: 0 } as Meta,
            output: "No deferred tools are available. All tools are already in the active set.",
          }
        }

        const query = params.query.trim()
        const maxResults = params.max_results

        // Parse query format
        let matched: ToolSearchState.DeferredEntry[]

        if (query.startsWith("select:")) {
          // Exact selection by name
          const names = query
            .slice(7)
            .split(",")
            .map((n) => n.trim().toLowerCase())
            .filter(Boolean)
          matched = catalog.filter((t) => names.includes(t.id.toLowerCase()))

          if (matched.length === 0) {
            const available = catalog.map((t) => t.id).join(", ")
            return {
              title: "Tool search",
              metadata: { count: 0, query } as Meta,
              output: `No deferred tools match the names: ${names.join(", ")}.\nAvailable deferred tools: ${available}`,
            }
          }
        } else {
          // Keyword search
          let requiredPrefix: string | undefined
          let keywords: string[]

          if (query.startsWith("+")) {
            const parts = query.slice(1).trim().split(/\s+/)
            requiredPrefix = parts[0]?.toLowerCase()
            keywords = parts.slice(1).map((k) => k.toLowerCase())
          } else {
            keywords = query
              .toLowerCase()
              .split(/\s+/)
              .filter(Boolean)
          }

          // Score each deferred tool
          const scored = catalog
            .map((entry) => {
              const idLower = entry.id.toLowerCase()
              const descLower = (entry.description ?? "").toLowerCase()

              // Required prefix filter
              if (requiredPrefix && !idLower.includes(requiredPrefix)) {
                return { entry, score: -1 }
              }

              let score = 0
              for (const kw of keywords) {
                if (idLower === kw) score += 10
                else if (idLower.includes(kw)) score += 5
                else if (descLower.includes(kw)) score += 2
              }

              // If no keywords matched at all, give base score for prefix-only match
              if (score === 0 && requiredPrefix && idLower.includes(requiredPrefix)) {
                score = 3
              }

              return { entry, score }
            })
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults)

          matched = scored.map((s) => s.entry)

          if (matched.length === 0) {
            const available = catalog.map((t) => t.id).join(", ")
            return {
              title: "Tool search",
              metadata: { count: 0, query } as Meta,
              output: `No deferred tools match "${query}".\nAvailable deferred tools: ${available}`,
            }
          }
        }

        // Activate matched tools
        const activatedIds = matched.map((t) => t.id)
        ToolSearchState.activate(ctx.sessionID, activatedIds)

        // Build result
        const lines = matched.map((entry) => {
          const desc = entry.description.split("\n")[0] ?? "No description"
          return `- **${entry.id}** [ACTIVATED]\n  ${desc}`
        })

        return {
          title: `Found ${matched.length} deferred tool(s)`,
          metadata: {
            count: matched.length,
            activated: activatedIds,
            query,
          } as Meta,
          output: [
            `Found and activated ${matched.length} deferred tool(s):`,
            "",
            ...lines,
            "",
            "These tools are now available for use in this session. They will be included in subsequent tool calls.",
          ].join("\n"),
        }
      }),
  }),
)
