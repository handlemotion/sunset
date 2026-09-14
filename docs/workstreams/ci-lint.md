# Workstream: CI + lint + repo hygiene

Scope: `.github/workflows/`, `LICENSE`, `SECURITY.md`, `oxlint.json` (or
equivalent), root `package.json`, `pnpm-workspace.yaml`, `knip.json`.
Do not touch any `packages/**/src` or `apps/**/src` — read-only for import
analysis only.

## Context

The repo has format/typecheck/test/build but no lint and no CI. For a public
repo, both are the cheapest debt prevention available.

## Tasks

1. **Lint.** Add `oxlint` (fast, matches the org's tooling) with a strict
   baseline: no `any`, no `@ts-ignore`, no unused imports/vars, no
   `console.log` outside cli/test files. Wire `pnpm lint` at root and into
   `pnpm check`. Fix or explicitly allowlist every violation — no broad
   disables.

2. **CI.** `.github/workflows/ci.yml`: pnpm install (frozen lockfile),
   `pnpm check` on push/PR. Cache pnpm store. Node version from `.nvmrc`.

3. **knip.** Add `pnpm knip` (dev dep) configured for the monorepo to flag
   unused exports/deps; run once and clean what it finds, but keep it out of
   `pnpm check` (report-only script is fine).

4. **Repo hygiene.** `LICENSE` (pick MIT unless org standard differs — ask
   if unsure), `SECURITY.md` short, `package.json` `license`/`engines`
   fields, `.github/dependabot.yml` weekly for npm + actions.

## Acceptance

- `pnpm lint` green with zero disables; `pnpm check` includes lint.
- CI workflow file valid; can't verify remotely — dry-run locally if act is
  available, else careful review.
