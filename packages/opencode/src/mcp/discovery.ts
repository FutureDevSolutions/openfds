/**
 * MCP Connector Discovery
 *
 * Optional, fail-safe discovery of MCP connectors from:
 * 1. Official registry — a JSON endpoint listing known-good connectors
 * 2. Managed connector ingestion — connectors pushed by a provider/backend
 *
 * Design principles:
 * - Discovery is opt-in via config flag `experimental.mcp_discovery`
 * - User-configured connectors are NEVER overridden by discovered ones
 * - All failures degrade silently to an empty result set
 * - Each connector carries origin metadata for observability and ranking
 *
 * Config flags:
 *   experimental.mcp_discovery: boolean          — enable/disable discovery (default: false)
 *   experimental.mcp_registry_url: string        — override the registry endpoint
 *   experimental.mcp_managed_connectors: array   — inline managed connector definitions
 */

import z from "zod/v4"
import { Log } from "../util/log"
import { Config } from "../config/config"

const log = Log.create({ service: "mcp.discovery" })

const DEFAULT_REGISTRY_URL = "https://registry.opencode.ai/mcp/connectors.json"
const FETCH_TIMEOUT_MS = 10_000

export namespace McpDiscovery {
  /**
   * Origin of a connector definition:
   * - "manual": user-configured in opencode.json / project config
   * - "registry": discovered from the official registry endpoint
   * - "managed": injected by a provider/backend via managed config
   */
  export type ConnectorOrigin = "manual" | "registry" | "managed"

  /**
   * Quality/trust tier for ranking:
   * - "official": maintained by the project / registry
   * - "community": community-contributed via registry
   * - "custom": user or managed injections
   */
  export type ConnectorQuality = "official" | "community" | "custom"

  /**
   * A single registry entry describing a discoverable MCP connector.
   */
  export const RegistryEntry = z.object({
    /** Unique connector name (used as config key). */
    name: z.string(),
    /** Human-readable label. */
    label: z.string().optional(),
    /** What this connector does. */
    description: z.string().optional(),
    /** The MCP server config to install. */
    config: Config.Mcp,
    /** Connector category for grouping. */
    category: z.string().optional(),
    /** Quality tier. */
    quality: z.enum(["official", "community"]).optional(),
    /** Tags for filtering. */
    tags: z.string().array().optional(),
  })
  export type RegistryEntry = z.infer<typeof RegistryEntry>

  /**
   * The full registry response envelope.
   */
  export const RegistryResponse = z.object({
    version: z.number().int().min(1),
    connectors: RegistryEntry.array(),
  })
  export type RegistryResponse = z.infer<typeof RegistryResponse>

  /**
   * A managed connector definition provided by a provider/backend.
   * Same shape as RegistryEntry but with origin "managed".
   */
  export const ManagedEntry = z.object({
    name: z.string(),
    label: z.string().optional(),
    description: z.string().optional(),
    config: Config.Mcp,
    category: z.string().optional(),
    tags: z.string().array().optional(),
  })
  export type ManagedEntry = z.infer<typeof ManagedEntry>

  /**
   * A discovered connector with full metadata.
   */
  export interface DiscoveredConnector {
    /** Connector name (config key). */
    readonly name: string
    /** The MCP server configuration. */
    readonly config: Config.Mcp
    /** Where this connector was discovered from. */
    readonly origin: ConnectorOrigin
    /** Quality/trust tier. */
    readonly quality: ConnectorQuality
    /** Human-readable label. */
    readonly label?: string
    /** Description. */
    readonly description?: string
    /** Category for grouping. */
    readonly category?: string
    /** Tags. */
    readonly tags?: string[]
  }

  /**
   * Result of a discovery run.
   */
  export interface DiscoveryResult {
    /** Connectors that are new (not in manual config). */
    readonly discovered: DiscoveredConnector[]
    /** Connectors that were deduped (already in manual config). */
    readonly skipped: Array<{ name: string; origin: ConnectorOrigin; reason: string }>
    /** Errors encountered during discovery (informational, not fatal). */
    readonly errors: Array<{ source: string; message: string }>
  }

  /**
   * Fetch the official connector registry.
   * Returns an empty array on any failure (timeout, parse error, network error).
   */
  export async function fetchRegistry(options?: {
    url?: string
    timeoutMs?: number
    fetch?: typeof globalThis.fetch
  }): Promise<{ entries: RegistryEntry[]; error?: string }> {
    const url = options?.url ?? DEFAULT_REGISTRY_URL
    const timeout = options?.timeoutMs ?? FETCH_TIMEOUT_MS
    const fetchFn = options?.fetch ?? globalThis.fetch

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      let response: Response
      try {
        response = await fetchFn(url, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        })
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        const msg = `Registry returned HTTP ${response.status}`
        log.warn("registry fetch failed", { url, status: response.status })
        return { entries: [], error: msg }
      }

      const body = await response.json()
      const parsed = RegistryResponse.safeParse(body)
      if (!parsed.success) {
        const msg = "Invalid registry response format"
        log.warn("registry parse failed", { url, error: parsed.error.message })
        return { entries: [], error: msg }
      }

      log.info("registry fetched", { url, count: parsed.data.connectors.length, version: parsed.data.version })
      return { entries: parsed.data.connectors }
    } catch (err: any) {
      const msg = err?.name === "AbortError" ? `Registry fetch timed out after ${timeout}ms` : (err?.message ?? String(err))
      log.warn("registry fetch error", { url, error: msg })
      return { entries: [], error: msg }
    }
  }

  /**
   * Parse managed connector entries from config.
   * Invalid entries are skipped with warnings.
   */
  export function parseManagedEntries(raw: unknown[]): { entries: ManagedEntry[]; errors: string[] } {
    const entries: ManagedEntry[] = []
    const errors: string[] = []

    for (let i = 0; i < raw.length; i++) {
      const parsed = ManagedEntry.safeParse(raw[i])
      if (parsed.success) {
        entries.push(parsed.data)
      } else {
        const msg = `Managed connector [${i}]: ${parsed.error.message}`
        log.warn("invalid managed connector", { index: i })
        errors.push(msg)
      }
    }

    return { entries, errors }
  }

  /**
   * Deduplicate discovered connectors against user-configured connectors.
   *
   * Rules:
   * 1. Manual config always wins — discovered connectors with the same name are skipped.
   * 2. Among discovered connectors, managed connectors take priority over registry connectors.
   * 3. Duplicate names within the same source are resolved by first-seen.
   */
  export function deduplicate(
    manualNames: Set<string>,
    registryEntries: RegistryEntry[],
    managedEntries: ManagedEntry[],
  ): DiscoveryResult {
    const discovered: DiscoveredConnector[] = []
    const skipped: DiscoveryResult["skipped"] = []
    const errors: DiscoveryResult["errors"] = []
    const seen = new Set<string>()

    // Managed connectors first (higher priority among discovered)
    for (const entry of managedEntries) {
      if (manualNames.has(entry.name)) {
        skipped.push({ name: entry.name, origin: "managed", reason: "overridden by manual config" })
        continue
      }
      if (seen.has(entry.name)) {
        skipped.push({ name: entry.name, origin: "managed", reason: "duplicate managed entry" })
        continue
      }
      seen.add(entry.name)
      discovered.push({
        name: entry.name,
        config: entry.config,
        origin: "managed",
        quality: "custom",
        label: entry.label,
        description: entry.description,
        category: entry.category,
        tags: entry.tags,
      })
    }

    // Registry connectors second (lower priority)
    for (const entry of registryEntries) {
      if (manualNames.has(entry.name)) {
        skipped.push({ name: entry.name, origin: "registry", reason: "overridden by manual config" })
        continue
      }
      if (seen.has(entry.name)) {
        skipped.push({ name: entry.name, origin: "registry", reason: "overridden by managed connector" })
        continue
      }
      seen.add(entry.name)
      discovered.push({
        name: entry.name,
        config: entry.config,
        origin: "registry",
        quality: entry.quality ?? "community",
        label: entry.label,
        description: entry.description,
        category: entry.category,
        tags: entry.tags,
      })
    }

    return { discovered, skipped, errors }
  }

  /**
   * Run the full discovery flow.
   *
   * 1. Fetch from the official registry (if enabled).
   * 2. Parse managed connectors from config.
   * 3. Deduplicate against manual config.
   * 4. Return the result with full metadata.
   *
   * This function never throws — all errors are captured in the result.
   */
  export async function discover(options: {
    /** Names of user-configured MCP servers. */
    manualNames: Set<string>
    /** Whether registry discovery is enabled. */
    registryEnabled: boolean
    /** Override registry URL. */
    registryUrl?: string
    /** Raw managed connector config entries. */
    managedConnectors?: unknown[]
    /** Fetch function override for testing. */
    fetch?: typeof globalThis.fetch
    /** Timeout override for testing. */
    timeoutMs?: number
  }): Promise<DiscoveryResult> {
    const errors: DiscoveryResult["errors"] = []

    // 1. Fetch registry
    let registryEntries: RegistryEntry[] = []
    if (options.registryEnabled) {
      const result = await fetchRegistry({
        url: options.registryUrl,
        timeoutMs: options.timeoutMs,
        fetch: options.fetch,
      })
      registryEntries = result.entries
      if (result.error) {
        errors.push({ source: "registry", message: result.error })
      }
    }

    // 2. Parse managed connectors
    let managedEntries: ManagedEntry[] = []
    if (options.managedConnectors && options.managedConnectors.length > 0) {
      const result = parseManagedEntries(options.managedConnectors)
      managedEntries = result.entries
      for (const err of result.errors) {
        errors.push({ source: "managed", message: err })
      }
    }

    // 3. Deduplicate
    const deduped = deduplicate(options.manualNames, registryEntries, managedEntries)

    return {
      discovered: deduped.discovered,
      skipped: [...deduped.skipped, ...errors.map((e) => ({ name: "", origin: "registry" as const, reason: e.message }))],
      errors: [...deduped.errors, ...errors],
    }
  }
}
