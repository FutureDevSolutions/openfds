export const BUILTIN_SKILLS = [
  {
    name: "nextjs-app-router",
    description: "Build and refactor Next.js App Router features with server/client boundaries and route conventions.",
    location: "builtin://nextjs-app-router/SKILL.md",
    content: `## When to use
- Implementing Next.js App Router pages, layouts, route handlers, and metadata.

## Checklist
- Keep server components as default; move client hooks behind "use client".
- Use route handlers for HTTP interfaces under app/api.
- Keep data loading close to server components and avoid client-only fetch unless needed.
- Keep config updates aligned with next.config and tsconfig.`,
  },
  {
    name: "nextjs-server-actions",
    description: "Implement robust Next.js Server Actions with validation and safe mutation flows.",
    location: "builtin://nextjs-server-actions/SKILL.md",
    content: `## When to use
- Creating or updating forms and mutations with Next.js Server Actions.

## Checklist
- Validate inputs at the action boundary.
- Keep side effects in server code paths only.
- Return actionable errors for UI surfaces.
- Revalidate paths/tags where stale data can occur.`,
  },
  {
    name: "nestjs-module-scaffold",
    description: "Scaffold NestJS modules, controllers, services, DTOs, and provider wiring.",
    location: "builtin://nestjs-module-scaffold/SKILL.md",
    content: `## When to use
- Adding a new NestJS domain module or expanding one.

## Checklist
- Keep DTOs explicit and validated.
- Keep business logic in services, thin controllers.
- Wire providers in module metadata and export only required dependencies.
- Preserve existing folder and naming conventions.`,
  },
  {
    name: "nestjs-auth-rbac",
    description: "Apply NestJS auth/guard patterns with role-based checks and policy boundaries.",
    location: "builtin://nestjs-auth-rbac/SKILL.md",
    content: `## When to use
- Adding authentication, authorization, or RBAC changes in NestJS.

## Checklist
- Keep guards and decorators consistent with existing auth stack.
- Enforce authorization in route boundaries and sensitive service operations.
- Keep token/session handling out of controllers when possible.
- Cover role escalation and denied-path behavior.`,
  },
  {
    name: "astro-islands-content",
    description: "Build Astro pages and islands with adapter-aware runtime decisions.",
    location: "builtin://astro-islands-content/SKILL.md",
    content: `## When to use
- Implementing Astro pages, content collections, and client islands.

## Checklist
- Keep rendering mode explicit (static/server) per route needs.
- Use islands for client interactivity only where required.
- Keep adapter/runtime assumptions aligned with astro.config.
- Validate TypeScript and Astro diagnostics after edits.`,
  },
  {
    name: "docker-web-stack",
    description: "Generate production-grade Dockerfiles and compose snippets for Next/Astro/Nest/Node stacks.",
    location: "builtin://docker-web-stack/SKILL.md",
    content: `## When to use
- Dockerizing app services for local dev or production.

## Checklist
- Prefer multi-stage builds and minimal runtime images.
- Run as non-root in runtime stages.
- Include healthchecks and explicit runtime env wiring.
- Keep framework-specific build outputs in runtime images only.`,
  },
  {
    name: "yaml-deployments",
    description: "Create and refine deployment YAML (compose/k8s/workflows) with safe defaults.",
    location: "builtin://yaml-deployments/SKILL.md",
    content: `## When to use
- Editing docker-compose, Kubernetes, CI workflow YAML.

## Checklist
- Keep environment values explicit and documented.
- Add health and readiness probes/checks where applicable.
- Avoid implicit defaults that vary by platform.
- Validate schema and key casing consistency.`,
  },
] as const
