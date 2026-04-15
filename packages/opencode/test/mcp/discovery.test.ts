import { describe, test, expect } from "bun:test"
import { McpDiscovery } from "../../src/mcp/discovery"

// --- Helpers ---

function makeRegistryEntry(
  name: string,
  overrides?: Partial<McpDiscovery.RegistryEntry>,
): McpDiscovery.RegistryEntry {
  return {
    name,
    label: `${name} connector`,
    description: `Description for ${name}`,
    config: { type: "remote", url: `https://${name}.example.com/mcp` },
    quality: "official",
    category: "general",
    tags: [name],
    ...overrides,
  }
}

function makeManagedEntry(
  name: string,
  overrides?: Partial<McpDiscovery.ManagedEntry>,
): McpDiscovery.ManagedEntry {
  return {
    name,
    label: `Managed ${name}`,
    description: `Managed connector for ${name}`,
    config: { type: "remote", url: `https://managed-${name}.example.com/mcp` },
    category: "managed",
    tags: [name],
    ...overrides,
  }
}

function makeRegistryResponse(entries: McpDiscovery.RegistryEntry[]): McpDiscovery.RegistryResponse {
  return { version: 1, connectors: entries }
}

function mockFetchOk(body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })) as any
}

function mockFetchError(status: number): typeof globalThis.fetch {
  return (async () => new Response("error", { status })) as any
}

function mockFetchTimeout(): typeof globalThis.fetch {
  return (async (_url: string, opts?: { signal?: AbortSignal }) => {
    return new Promise<Response>((_, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })
  }) as any
}

function mockFetchNetworkError(): typeof globalThis.fetch {
  return (async () => {
    throw new Error("Network error: DNS resolution failed")
  }) as any
}

// --- fetchRegistry tests ---

describe("McpDiscovery.fetchRegistry", () => {
  test("returns entries on successful fetch", async () => {
    const entries = [makeRegistryEntry("github"), makeRegistryEntry("slack")]
    const result = await McpDiscovery.fetchRegistry({
      fetch: mockFetchOk(makeRegistryResponse(entries)),
    })
    expect(result.entries).toHaveLength(2)
    expect(result.error).toBeUndefined()
    expect(result.entries[0].name).toBe("github")
    expect(result.entries[1].name).toBe("slack")
  })

  test("returns empty on HTTP error", async () => {
    const result = await McpDiscovery.fetchRegistry({
      fetch: mockFetchError(500),
    })
    expect(result.entries).toHaveLength(0)
    expect(result.error).toContain("HTTP 500")
  })

  test("returns empty on 404", async () => {
    const result = await McpDiscovery.fetchRegistry({
      fetch: mockFetchError(404),
    })
    expect(result.entries).toHaveLength(0)
    expect(result.error).toContain("HTTP 404")
  })

  test("returns empty on timeout", async () => {
    const result = await McpDiscovery.fetchRegistry({
      fetch: mockFetchTimeout(),
      timeoutMs: 50,
    })
    expect(result.entries).toHaveLength(0)
    expect(result.error).toContain("timed out")
  })

  test("returns empty on network error", async () => {
    const result = await McpDiscovery.fetchRegistry({
      fetch: mockFetchNetworkError(),
    })
    expect(result.entries).toHaveLength(0)
    expect(result.error).toContain("DNS resolution failed")
  })

  test("returns empty on invalid JSON", async () => {
    const result = await McpDiscovery.fetchRegistry({
      fetch: (async () =>
        new Response("not json {{{", { status: 200 })) as any,
    })
    expect(result.entries).toHaveLength(0)
    expect(result.error).toBeDefined()
  })

  test("returns empty on valid JSON but wrong schema", async () => {
    const result = await McpDiscovery.fetchRegistry({
      fetch: mockFetchOk({ wrong: "schema" }),
    })
    expect(result.entries).toHaveLength(0)
    expect(result.error).toContain("Invalid registry response format")
  })

  test("returns empty on missing version", async () => {
    const result = await McpDiscovery.fetchRegistry({
      fetch: mockFetchOk({ connectors: [] }),
    })
    expect(result.entries).toHaveLength(0)
    expect(result.error).toBeDefined()
  })

  test("accepts empty connectors array", async () => {
    const result = await McpDiscovery.fetchRegistry({
      fetch: mockFetchOk({ version: 1, connectors: [] }),
    })
    expect(result.entries).toHaveLength(0)
    expect(result.error).toBeUndefined()
  })

  test("uses custom URL", async () => {
    let requestedUrl = ""
    const result = await McpDiscovery.fetchRegistry({
      url: "https://custom.registry.example.com/connectors.json",
      fetch: (async (url: string) => {
        requestedUrl = url
        return new Response(JSON.stringify(makeRegistryResponse([])), { status: 200 })
      }) as any,
    })
    expect(requestedUrl).toBe("https://custom.registry.example.com/connectors.json")
    expect(result.entries).toHaveLength(0)
  })

  test("handles local config type connectors", async () => {
    const entries = [
      makeRegistryEntry("local-tool", {
        config: { type: "local", command: ["npx", "my-mcp-server"] },
      }),
    ]
    const result = await McpDiscovery.fetchRegistry({
      fetch: mockFetchOk(makeRegistryResponse(entries)),
    })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].config.type).toBe("local")
  })
})

// --- parseManagedEntries tests ---

describe("McpDiscovery.parseManagedEntries", () => {
  test("parses valid entries", () => {
    const raw = [makeManagedEntry("github"), makeManagedEntry("slack")]
    const result = McpDiscovery.parseManagedEntries(raw)
    expect(result.entries).toHaveLength(2)
    expect(result.errors).toHaveLength(0)
  })

  test("skips invalid entries with errors", () => {
    const raw = [
      makeManagedEntry("github"),
      { invalid: "entry" },
      makeManagedEntry("slack"),
      "not an object",
    ]
    const result = McpDiscovery.parseManagedEntries(raw)
    expect(result.entries).toHaveLength(2)
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toContain("Managed connector [1]")
    expect(result.errors[1]).toContain("Managed connector [3]")
  })

  test("handles empty array", () => {
    const result = McpDiscovery.parseManagedEntries([])
    expect(result.entries).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  test("rejects entry without name", () => {
    const result = McpDiscovery.parseManagedEntries([
      { config: { type: "remote", url: "https://example.com" } },
    ])
    expect(result.entries).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
  })

  test("rejects entry without valid config", () => {
    const result = McpDiscovery.parseManagedEntries([
      { name: "bad", config: { type: "invalid_type" } },
    ])
    expect(result.entries).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
  })
})

// --- deduplicate tests ---

describe("McpDiscovery.deduplicate", () => {
  test("manual config always wins over registry", () => {
    const manualNames = new Set(["github"])
    const registry = [makeRegistryEntry("github"), makeRegistryEntry("slack")]
    const managed: McpDiscovery.ManagedEntry[] = []

    const result = McpDiscovery.deduplicate(manualNames, registry, managed)
    expect(result.discovered).toHaveLength(1)
    expect(result.discovered[0].name).toBe("slack")
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].name).toBe("github")
    expect(result.skipped[0].reason).toContain("manual config")
  })

  test("manual config always wins over managed", () => {
    const manualNames = new Set(["github"])
    const registry: McpDiscovery.RegistryEntry[] = []
    const managed = [makeManagedEntry("github"), makeManagedEntry("slack")]

    const result = McpDiscovery.deduplicate(manualNames, registry, managed)
    expect(result.discovered).toHaveLength(1)
    expect(result.discovered[0].name).toBe("slack")
    expect(result.discovered[0].origin).toBe("managed")
    expect(result.skipped[0].name).toBe("github")
    expect(result.skipped[0].reason).toContain("manual config")
  })

  test("managed takes priority over registry for same name", () => {
    const manualNames = new Set<string>()
    const registry = [makeRegistryEntry("github")]
    const managed = [makeManagedEntry("github")]

    const result = McpDiscovery.deduplicate(manualNames, registry, managed)
    expect(result.discovered).toHaveLength(1)
    expect(result.discovered[0].origin).toBe("managed")
    expect(result.discovered[0].quality).toBe("custom")
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].origin).toBe("registry")
    expect(result.skipped[0].reason).toContain("managed connector")
  })

  test("duplicate managed entries — first wins", () => {
    const manualNames = new Set<string>()
    const registry: McpDiscovery.RegistryEntry[] = []
    const managed = [
      makeManagedEntry("github", { label: "First" }),
      makeManagedEntry("github", { label: "Second" }),
    ]

    const result = McpDiscovery.deduplicate(manualNames, registry, managed)
    expect(result.discovered).toHaveLength(1)
    expect(result.discovered[0].label).toBe("First")
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toContain("duplicate managed")
  })

  test("empty inputs produce empty results", () => {
    const result = McpDiscovery.deduplicate(new Set(), [], [])
    expect(result.discovered).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  test("all connectors deduped produces zero discovered", () => {
    const manualNames = new Set(["a", "b", "c"])
    const registry = [makeRegistryEntry("a"), makeRegistryEntry("b")]
    const managed = [makeManagedEntry("c")]

    const result = McpDiscovery.deduplicate(manualNames, registry, managed)
    expect(result.discovered).toHaveLength(0)
    expect(result.skipped).toHaveLength(3)
  })

  test("metadata fields are preserved on discovered connectors", () => {
    const manualNames = new Set<string>()
    const registry = [
      makeRegistryEntry("github", {
        label: "GitHub",
        description: "GitHub connector",
        category: "source-control",
        quality: "official",
        tags: ["git", "github"],
      }),
    ]

    const result = McpDiscovery.deduplicate(manualNames, registry, [])
    expect(result.discovered).toHaveLength(1)
    const c = result.discovered[0]
    expect(c.label).toBe("GitHub")
    expect(c.description).toBe("GitHub connector")
    expect(c.category).toBe("source-control")
    expect(c.quality).toBe("official")
    expect(c.origin).toBe("registry")
    expect(c.tags).toEqual(["git", "github"])
  })

  test("registry entries without quality default to community", () => {
    const manualNames = new Set<string>()
    const registry = [makeRegistryEntry("tool", { quality: undefined })]

    const result = McpDiscovery.deduplicate(manualNames, registry, [])
    expect(result.discovered[0].quality).toBe("community")
  })
})

// --- discover (full flow) tests ---

describe("McpDiscovery.discover", () => {
  test("full flow: registry + managed + dedup", async () => {
    const result = await McpDiscovery.discover({
      manualNames: new Set(["existing-server"]),
      registryEnabled: true,
      managedConnectors: [makeManagedEntry("managed-tool")],
      fetch: mockFetchOk(
        makeRegistryResponse([
          makeRegistryEntry("existing-server"), // should be deduped
          makeRegistryEntry("new-registry-tool"),
        ]),
      ),
    })

    expect(result.discovered).toHaveLength(2)
    expect(result.discovered.map((c) => c.name).sort()).toEqual(["managed-tool", "new-registry-tool"])
    expect(result.skipped.some((s) => s.name === "existing-server")).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test("discovery disabled — no registry fetch", async () => {
    let fetchCalled = false
    const result = await McpDiscovery.discover({
      manualNames: new Set(),
      registryEnabled: false,
      fetch: (async () => {
        fetchCalled = true
        return new Response("", { status: 200 })
      }) as any,
    })

    expect(fetchCalled).toBe(false)
    expect(result.discovered).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  test("registry failure is captured in errors, not thrown", async () => {
    const result = await McpDiscovery.discover({
      manualNames: new Set(),
      registryEnabled: true,
      fetch: mockFetchNetworkError(),
    })

    expect(result.discovered).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].source).toBe("registry")
    expect(result.errors[0].message).toContain("DNS resolution")
  })

  test("managed connector parse errors are captured", async () => {
    const result = await McpDiscovery.discover({
      manualNames: new Set(),
      registryEnabled: false,
      managedConnectors: [
        makeManagedEntry("valid"),
        { broken: true },
      ],
    })

    expect(result.discovered).toHaveLength(1)
    expect(result.discovered[0].name).toBe("valid")
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].source).toBe("managed")
  })

  test("no managed connectors and no registry — empty result", async () => {
    const result = await McpDiscovery.discover({
      manualNames: new Set(),
      registryEnabled: false,
    })

    expect(result.discovered).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  test("timeout on registry does not affect managed connectors", async () => {
    const result = await McpDiscovery.discover({
      manualNames: new Set(),
      registryEnabled: true,
      timeoutMs: 50,
      fetch: mockFetchTimeout(),
      managedConnectors: [makeManagedEntry("managed-ok")],
    })

    expect(result.discovered).toHaveLength(1)
    expect(result.discovered[0].name).toBe("managed-ok")
    expect(result.errors.some((e) => e.message.includes("timed out"))).toBe(true)
  })

  test("custom registry URL is passed through", async () => {
    let capturedUrl = ""
    await McpDiscovery.discover({
      manualNames: new Set(),
      registryEnabled: true,
      registryUrl: "https://custom.example.com/reg.json",
      fetch: (async (url: string) => {
        capturedUrl = url
        return new Response(JSON.stringify(makeRegistryResponse([])), { status: 200 })
      }) as any,
    })

    expect(capturedUrl).toBe("https://custom.example.com/reg.json")
  })
})

// --- Stress / edge-case tests ---

describe("McpDiscovery: stress scenarios", () => {
  test("100 registry entries deduped against 50 manual names", async () => {
    const manualNames = new Set(Array.from({ length: 50 }, (_, i) => `server-${i}`))
    const registry = Array.from({ length: 100 }, (_, i) => makeRegistryEntry(`server-${i}`))

    const result = McpDiscovery.deduplicate(manualNames, registry, [])
    expect(result.discovered).toHaveLength(50) // server-50 through server-99
    expect(result.skipped).toHaveLength(50) // server-0 through server-49
  })

  test("100 managed + 100 registry + 50 overlap — deterministic", async () => {
    const manualNames = new Set<string>()
    const managed = Array.from({ length: 100 }, (_, i) => makeManagedEntry(`tool-${i}`))
    const registry = Array.from({ length: 100 }, (_, i) => makeRegistryEntry(`tool-${i + 50}`))

    const result = McpDiscovery.deduplicate(manualNames, registry, managed)
    // Managed: tool-0 to tool-99 (100 unique)
    // Registry: tool-50 to tool-149, but tool-50 to tool-99 overlap with managed
    expect(result.discovered).toHaveLength(150) // 100 managed + 50 new from registry
    expect(result.skipped).toHaveLength(50) // tool-50 to tool-99 from registry

    // All managed connectors should be in discovered
    const managedInResult = result.discovered.filter((c) => c.origin === "managed")
    expect(managedInResult).toHaveLength(100)

    // Only non-overlapping registry connectors
    const registryInResult = result.discovered.filter((c) => c.origin === "registry")
    expect(registryInResult).toHaveLength(50)
  })

  test("repeated discover calls produce consistent results", async () => {
    const manualNames = new Set(["github"])
    const registry = [makeRegistryEntry("github"), makeRegistryEntry("slack"), makeRegistryEntry("datadog")]
    const managed = [makeManagedEntry("slack")]

    const results = []
    for (let i = 0; i < 5; i++) {
      results.push(McpDiscovery.deduplicate(manualNames, registry, managed))
    }

    // All runs should produce identical results
    for (let i = 1; i < results.length; i++) {
      expect(results[i].discovered.map((c) => c.name)).toEqual(results[0].discovered.map((c) => c.name))
      expect(results[i].skipped.length).toBe(results[0].skipped.length)
    }
  })
})

// --- ConnectorOrigin and metadata validation ---

describe("McpDiscovery: origin and quality metadata", () => {
  test("registry entries get origin=registry", () => {
    const result = McpDiscovery.deduplicate(new Set(), [makeRegistryEntry("a")], [])
    expect(result.discovered[0].origin).toBe("registry")
  })

  test("managed entries get origin=managed, quality=custom", () => {
    const result = McpDiscovery.deduplicate(new Set(), [], [makeManagedEntry("a")])
    expect(result.discovered[0].origin).toBe("managed")
    expect(result.discovered[0].quality).toBe("custom")
  })

  test("registry official quality is preserved", () => {
    const result = McpDiscovery.deduplicate(
      new Set(),
      [makeRegistryEntry("a", { quality: "official" })],
      [],
    )
    expect(result.discovered[0].quality).toBe("official")
  })

  test("registry community quality is preserved", () => {
    const result = McpDiscovery.deduplicate(
      new Set(),
      [makeRegistryEntry("a", { quality: "community" })],
      [],
    )
    expect(result.discovered[0].quality).toBe("community")
  })
})

// --- RegistryResponse schema validation ---

describe("McpDiscovery: schema validation", () => {
  test("RegistryResponse validates correct input", () => {
    const input = {
      version: 1,
      connectors: [
        {
          name: "test",
          config: { type: "remote", url: "https://example.com" },
        },
      ],
    }
    const result = McpDiscovery.RegistryResponse.safeParse(input)
    expect(result.success).toBe(true)
  })

  test("RegistryResponse rejects missing version", () => {
    const input = { connectors: [] }
    const result = McpDiscovery.RegistryResponse.safeParse(input)
    expect(result.success).toBe(false)
  })

  test("RegistryResponse rejects non-integer version", () => {
    const input = { version: 1.5, connectors: [] }
    const result = McpDiscovery.RegistryResponse.safeParse(input)
    expect(result.success).toBe(false)
  })

  test("RegistryResponse rejects version 0", () => {
    const input = { version: 0, connectors: [] }
    const result = McpDiscovery.RegistryResponse.safeParse(input)
    expect(result.success).toBe(false)
  })

  test("RegistryEntry validates local config type", () => {
    const input = {
      name: "test",
      config: { type: "local", command: ["npx", "server"] },
    }
    const result = McpDiscovery.RegistryEntry.safeParse(input)
    expect(result.success).toBe(true)
  })

  test("RegistryEntry rejects invalid config type", () => {
    const input = {
      name: "test",
      config: { type: "invalid" },
    }
    const result = McpDiscovery.RegistryEntry.safeParse(input)
    expect(result.success).toBe(false)
  })

  test("ManagedEntry validates minimal input", () => {
    const input = {
      name: "test",
      config: { type: "remote", url: "https://example.com" },
    }
    const result = McpDiscovery.ManagedEntry.safeParse(input)
    expect(result.success).toBe(true)
  })
})
