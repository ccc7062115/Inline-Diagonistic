# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Artifacts

### Diagnostic Lens (`artifacts/diagnostic-lens/`)
A VS Code extension that adds inline pill-shaped diagnostic indicators.
- **Entry**: `src/extension.ts`
- **Output**: `out/extension.js` (compiled), `diagnostic-lens-0.1.0.vsix` (installable package)
- **Build**: `pnpm run compile` (inside `artifacts/diagnostic-lens/`)
- **Package**: `pnpm exec vsce package --no-dependencies --allow-missing-repository`
- **Config namespace**: `diagnosticLens.*`

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
