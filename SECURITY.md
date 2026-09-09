# Security

## Reporting

Report vulnerabilities privately through GitHub's security advisory form on this repository (Security → Report a vulnerability). Do not open a public issue. We aim to acknowledge within 3 days.

## Scope

- `www.tayfhaber.com` (Next.js app on Vercel)
- Supabase Edge Functions under `supabase/functions/`
- Public API routes under `src/app/api/`

## Secrets

Never commit `.env*` files or Supabase service-role keys. Local config lives in `.env.local` (see `.env.example`); production values live in Vercel and Supabase secrets. Cron and revalidation routes are gated by `CRON_SECRET`; pg_cron jobs read their bearer from Supabase Vault.
