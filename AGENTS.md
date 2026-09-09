# Tayf — agent instructions

Turkish news-bias analyzer: Next.js 16 App Router + Supabase (Postgres, pgmq, pg_cron, Deno 2 Edge Functions), deployed on Vercel.

## Commands

- `npm run dev` — Next dev server
- `npm run typecheck` — `tsc --noEmit` (strict, noUnusedLocals, noUncheckedIndexedAccess)
- `npm run lint` — eslint
- `npm test` — vitest (node env; run one file with `npx vitest run <path-substring>`, never a literal `[id]` path)
- `npm run build` — `next build`
- `cd supabase/functions/<fn> && deno check index.ts` — type-check an Edge Function (ingest, cluster-consumer, image-consumer)

## Conventions

- Tailwind 4: literal class strings only, no computed class names.
- Shared contracts between Deno and Next live in `supabase/functions/_shared/cluster/` and are re-exported from `src/lib/bias/config.ts`; migrations that mirror them are parity-tested in `tests/migrations/`.
- Migrations are plain SQL in `supabase/migrations/NNN_name.sql`; SECURITY DEFINER functions set `search_path = ''`, revoke from anon/authenticated/public, grant to service_role.
- Edge Functions run with `verify_jwt=false`; always deploy with `--no-verify-jwt` (see `docs/migration-guide.md`).
- Turkish UI copy. Keep tests small and behaviour-focused; no render tests of server components.

## Docs

- `docs/migration-guide.md` — operator runbook (migrations, secrets, cron, deploy order)
- `docs/architecture.md`, `docs/api.md`, `docs/adr/`
