# Tayf — agent instructions

Turkish news-bias analyzer: Next.js 16 App Router + Supabase (Postgres, pgmq, pg_cron, Deno 2 Edge Functions), deployed on Vercel.

## Commands

- `npm run dev` — Next dev server
- `npm run typecheck` — `tsc --noEmit` (strict, noUnusedLocals, noUncheckedIndexedAccess)
- `npm run lint` — eslint
- `npm test` — vitest (node env; run one file with `npx vitest run <path-substring>`, never a literal `[id]` path)
- `npm run build` — `next build`
- every function: `cd supabase/functions/<fn> && deno check --no-lock index.ts` — type-check an Edge Function (CI loops over every `supabase/functions/*/index.ts`; `deno.lock` is never created or committed)

## Conventions

- Tailwind 4: literal class strings only, no computed class names.
- Shared contracts between Deno and Next live in `supabase/functions/_shared/cluster/` and are re-exported from `src/lib/bias/config.ts`; migrations that mirror them are parity-tested in `tests/migrations/`.
- Migrations are plain SQL in `supabase/migrations/NNN_name.sql`; SECURITY DEFINER functions set `search_path = ''`, revoke from anon/authenticated/public, grant to service_role.
- Migrations never grant table or sequence privileges to `anon`/`authenticated` (117 revoked them all and closed the default ACLs). Data the browser or edge middleware needs goes through one of the seven allowlisted anon `SECURITY DEFINER` RPCs: the four of migration 116 (`saved_clusters`, `merged_cluster_map`, `source_slugs`, `source_slug_exists`) plus `saved_clusters_v2` of migration 124, `saved_clusters_v3` of migration 158 and `saved_clusters_v4` of migration 192; enforced by `tests/guards/anon-surface.test.ts`. A new anon RPC also needs its full identity in `ops_health_report()` row 17 (a `create or replace` that copies the newest definition (currently `195_ops_cron_route_low_cadence.sql`), as 158 and 192 did), or the `anon_surface` check fails.
- Edge Functions run with `verify_jwt=false`; always deploy with `--no-verify-jwt` (see `docs/migration-guide.md`).
- Turkish UI copy. Keep tests small and behaviour-focused; no render tests of server components.

## Docs

- `docs/migration-guide.md` — operator runbook (migrations, secrets, cron, deploy order)
- `docs/architecture.md`, `docs/api.md`, `docs/adr/`
