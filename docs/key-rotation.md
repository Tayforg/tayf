# Key-rotation runbook (BL-5)

Every long-lived secret this system uses, where it lives, how to generate a
replacement, the order in which to rotate it so nothing breaks mid-rotation,
and how to prove the new value works while the old one is dead.

> **Scope and companion docs:** this covers rotation only. For what happens
> to data during a restore, see [`backup-posture.md`](backup-posture.md).
> For first-time provisioning (as opposed to rotating an existing value),
> see [`migration-guide.md`](migration-guide.md) sections 2–4, which this
> document cross-references rather than duplicates.

> **Never paste a real secret value into a shell command that lands in
> history, into this file, into a commit, or into a chat/ticket.** Every
> example below uses `$VAR` placeholders exactly as `migration-guide.md`'s
> own secret-handling preamble does — `read -rs VAR` into a shell variable,
> never a literal on the command line.

---

## Quick reference

| Secret | Lives in | Set today? | Rotation forces re-auth of |
| --- | --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env, GitHub Actions secret, Supabase Vault secret `service_role_key` | Yes | Everything — DB bypass, all Edge Functions, all pg_cron drains |
| `CRON_SECRET` | Vercel env, Supabase Edge Function secret (`cluster-consumer` only) | Yes | Vercel cron routes, `/api/revalidate` caller |
| `REVALIDATE_URL` | Supabase Edge Function secret (`cluster-consumer` only) | Yes | Nothing (not a credential; a destination URL) |
| `ADMIN_SESSION_SECRET` | Vercel env | Yes | Every logged-in admin browser |
| `RESEND_API_KEY` | Vercel env | **No** | Outbound mail (feature is fail-closed while unset) |
| `ANTHROPIC_API_KEY` | Vercel env, GitHub Actions secret | **No** | Headline-neutralization cron + audit's neutral-title check (both soft no-op while unset) |
| `SENTRY_AUTH_TOKEN` | Vercel env (build-time only) | Optional | Sourcemap upload on the next build only |
| Supabase management access token | Operator laptop only — never deployed anywhere | Operator-held | The operator's own CLI/API sessions |

---

## `SUPABASE_SERVICE_ROLE_KEY`

**Where it lives — three places an operator manages by hand, one the
platform manages automatically:**

1. **Vercel env** (`production`) — read by `src/lib/supabase/server.ts` for
   every server-rendered page and API route that talks to Postgres.
2. **GitHub Actions repository secret** — read by
   `.github/workflows/cluster-audit.yml` (daily 03:00 UTC audit +
   `workflow_dispatch`).
3. **Supabase Vault secret named `service_role_key`** — read at *run time*
   (not deploy time) by three of the six pg_cron jobs migration 038/043/045
   installed: `ingest-drain`, `cluster-drain`, and `image-drain`. Each job's
   SQL body does
   `Authorization: Bearer (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')`
   to call its Edge Function over `net.http_post` (`supabase/migrations/038_cron_schedules.sql`).
   **Correction to a claim you may see elsewhere:** `prune-nightly` (038),
   `reader-data-purge` (043), and `articles-vacuum` (045) do **not** read
   this secret — all three run as plain `select public.<fn>();` / `vacuum`
   entirely inside Postgres, with no outbound HTTP call and no Vault read.
   Only the three drains above consume it.
4. **Edge Function runtime (`ingest`, `cluster-consumer`, `image-consumer`)**
   — `supabase/functions/_shared/supabase.ts` reads
   `SUPABASE_SERVICE_ROLE_KEY` from `Deno.env`, but this copy is
   **auto-injected by the Supabase platform into every invocation** and is
   not something you push with `supabase secrets set`. It updates itself the
   moment you regenerate the key in the dashboard. Do not add it to
   `supabase/functions/.env.production` — it would just be an inert local
   copy that goes stale.

**Before you rotate — confirm which key system the project is on.** On
Supabase's legacy JWT-based projects, `service_role` and `anon` are both
JWTs signed by one shared project JWT secret: "rotating the service role
key" means regenerating that JWT secret, which **also invalidates
`NEXT_PUBLIC_SUPABASE_ANON_KEY`** (`src/lib/supabase/browser.ts`,
client-side) in the same instant. On projects migrated to Supabase's newer
decoupled API-key system, `sb_secret_*` keys are independently revocable and
the anon/publishable key is untouched. Check Dashboard → Project Settings →
API before you start; this is unverified from this worktree and materially
changes the blast radius and the order below.

**How to generate:** Supabase Dashboard → Project Settings → API →
Service role key → Generate new key (legacy) or the API Keys panel → create
a new secret key and revoke the old one (new system, if available). The
value is reveal-once — copy it immediately into `$SR_NEW` (per the
`read -rs` pattern), never into a file.

**Rotation order (regeneration is instantaneous and global — have every
tool below open and authenticated *before* you click regenerate, so the gap
is seconds, not minutes):**

1. Regenerate the key in the Supabase Dashboard. Copy the new value into
   `$SR_NEW` immediately (reveal-once).
2. **Update the Vault secret first** — this is the path the three drains
   hit every 1–3 minutes, so it is the most time-sensitive:
   ```sql
   select vault.update_secret(
     (select id from vault.secrets where name = 'service_role_key'),
     '<paste $SR_NEW>'
   );
   ```
   `vault.update_secret`'s exact signature can vary by Postgres/Vault
   extension version — if this errors, confirm the current signature with
   `\df vault.update_secret` before falling back to delete-and-recreate.
3. **Update the Vercel env var and redeploy** — same
   "does nothing until redeploy" rule as every other Vercel secret in
   `migration-guide.md`:
   ```bash
   vercel env rm SUPABASE_SERVICE_ROLE_KEY production
   vercel env add SUPABASE_SERVICE_ROLE_KEY production
   vercel --prod
   ```
4. **Update the GitHub Actions secret** (lowest urgency — only consumed
   once a day or on manual dispatch):
   ```bash
   gh secret set SUPABASE_SERVICE_ROLE_KEY --repo <org>/<repo>
   ```
5. **If the project is on the legacy JWT system,** also update
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Vercel (steps 3's `vercel env` pair,
   substituting the var name) and redeploy again — `NEXT_PUBLIC_` vars are
   baked into the client bundle at build time, so a plain env change without
   a rebuild leaves every existing page shipped to browsers calling
   Supabase with a now-dead anon key.
6. Edge Functions need no manual step (see point 4 above) — confirm this
   held rather than assuming it (see verification below).

**Verify the new value works and the old one is dead:**

```bash
# New $SR works against an Edge Function directly (matches the pattern in
# migration-guide.md section 2):
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $SR_NEW" \
  "https://$PROJECT_REF.functions.supabase.co/cluster-consumer"
# Expect: 200

# Old value is dead:
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $SR_OLD" \
  "https://$PROJECT_REF.functions.supabase.co/cluster-consumer"
# Expect: 401
```

```sql
-- The three Vault-dependent drains recovered (run a few minutes after
-- step 2 above):
select jobname, status, start_time
from cron.job_run_details
where jobname in ('ingest-drain', 'cluster-drain', 'image-drain')
order by start_time desc
limit 10;
-- Expect: status = 'succeeded' for runs after the Vault update landed.
```

```bash
# GitHub Actions secret took: trigger the workflow by hand rather than
# waiting for 03:00 UTC.
gh workflow run cluster-audit.yml --repo <org>/<repo>
# Then check the run is green, not failing on a Supabase auth error.
```

**Blast radius if leaked:** the highest in this list. `service_role`
bypasses every RLS policy — full read/write on every table, including
`newsletter_subscribers` (reader emails) and `corrections` (submitter
contact info), the ability to invoke every Edge Function's privileged
operations, and (via the Vault copy) the same access the pg_cron drains
themselves have. Treat a leak of any one of the three managed copies as a
leak of all of them and rotate immediately.

---

## `CRON_SECRET`

**Where it lives:**

1. **Vercel env** (`production`) — the shared `requireCronBearer` gate
   (`src/lib/api/bearer.ts`) reads it for `/api/cron/headline`,
   `/api/cron/digest`, `/api/metrics`, the authenticated tier of
   `/api/health`, and `/api/revalidate`.
2. **Supabase Edge Function secret, `cluster-consumer` only** — after a
   drain, `triggerRevalidation()` (`supabase/functions/cluster-consumer/index.ts`)
   reads `Deno.env.get("CRON_SECRET")` and sends it as the bearer to
   `REVALIDATE_URL` (i.e. `/api/revalidate`) so readers see fresh clusters
   before the `cluster-feed` cacheLife TTL expires. `ingest` and
   `image-consumer` do not read this var at all.

**Do not confuse this with `WORKER_CRON_SECRET`.** `supabase/functions/_shared/auth.ts`
accepts either `SUPABASE_SERVICE_ROLE_KEY` or an operator-set
`WORKER_CRON_SECRET` as a valid inbound bearer for the Edge Functions
themselves, and `migration-guide.md`'s Edge Function deploy section
mentions `WORKER_CRON_SECRET` in passing. In this deployment that second
path is unused — migration 038's actual `net.http_post` calls authenticate
with the `service_role_key` Vault secret (see above), not
`WORKER_CRON_SECRET`, and no `WORKER_CRON_SECRET` value is pushed via
`supabase secrets set` anywhere in the current `.env.production` template.
`CRON_SECRET` is a third, unrelated secret that only gates the
Vercel-side routes and the one outbound revalidation call.

**How to generate:** 32+ random characters, same convention
`migration-guide.md` already uses for this var — `openssl rand -base64 32`.

**Rotation order:**

1. Generate the new value into `$CRON_SECRET_NEW`.
2. **Update the Edge Function secret first.** A stale value here only makes
   `triggerRevalidation()` log a swallowed 401 warning and skip one
   revalidation POST per drain (best-effort by design, per the code
   comment) — never a hard failure — so it is safe to update before the
   Vercel side:
   ```bash
   supabase secrets set CRON_SECRET="$CRON_SECRET_NEW" --project-ref "$PROJECT_REF"
   ```
   Takes effect on the function's next cold start; if you need it
   immediately, redeploy `cluster-consumer` to force one.
3. **Update Vercel and redeploy** (required — same rule as every Vercel
   secret in this repo):
   ```bash
   vercel env rm CRON_SECRET production
   vercel env add CRON_SECRET production
   vercel --prod
   ```
4. Do steps 2–3 in the same maintenance window. A gap between them only
   degrades cache freshness (readers see slightly stale pages until the
   TTL rolls) — it does not break `/api/cron/headline`, `/api/cron/digest`,
   or `/api/metrics`, which only ever read the Vercel-side copy.

**Verify:**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $CRON_SECRET_NEW" \
  "https://<your-tayf-domain>/api/cron/headline"
# Expect: 200

curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $CRON_SECRET_OLD" \
  "https://<your-tayf-domain>/api/cron/headline"
# Expect: 401
```

Confirm the revalidation path: wait for the next `cluster-drain` tick
(every minute) and check Supabase Edge Function logs for `cluster-consumer`
— absence of `[cluster-consumer] revalidation POST returned 401` confirms
both copies now match.

**Blast radius if leaked:** ability to read `/api/metrics` (operational
counts, no reader PII) and the authenticated `/api/health` breakdown; ability
to trigger `/api/cron/headline` on demand (spends LLM budget) and
`/api/cron/digest` on demand (emails the entire confirmed subscriber list);
ability to call `/api/revalidate`, but only for the fixed tag allowlist
(`clusters`, `clusters-politics`, `cluster-detail:<uuid>`), so the worst
case there is forced cache invalidation, not data modification.

---

## `REVALIDATE_URL`

Not a credential — a destination URL (`https://www.tayfhaber.com/api/revalidate`).
Lives only as a Supabase Edge Function secret for `cluster-consumer`,
alongside `CRON_SECRET` above. "Rotate" this whenever the production domain
changes:

```bash
supabase secrets set REVALIDATE_URL="https://<new-domain>/api/revalidate" --project-ref "$PROJECT_REF"
```

No Vercel-side counterpart, no redeploy of the Next.js app needed. Verify by
checking Edge Function logs for `cluster-consumer` after the next drain tick
— no `REVALIDATE_URL/CRON_SECRET unset` or non-2xx warning means it took.

---

## Admin session secret — `ADMIN_SESSION_SECRET`

**Where it lives:** Vercel env only (and `.env.local` for local dev). Read
by `src/lib/admin/session.ts`'s `getSessionSecret()`, which HMAC-SHA256
signs a `{expiresAt}` payload into the `admin_session` cookie. No Edge
Function, GitHub Actions, or Vault copy exists — this is a single-copy
secret.

Note the related-but-distinct `ADMIN_PASSWORD` (also Vercel env, same
file): that is the literal login password compared in
`checkAdminPassword()`. Rotating `ADMIN_PASSWORD` changes what you type at
`/admin/login`; rotating `ADMIN_SESSION_SECRET` changes what signs the
cookie you get *after* typing it. They rotate independently and this
runbook covers the session secret only.

**How to generate:** `openssl rand -base64 32` (the repo's own
`.env.local.example` documents this convention; `getSessionSecret()`
enforces a 16-character minimum).

**Rotation steps:**

```bash
vercel env rm ADMIN_SESSION_SECRET production
vercel env add ADMIN_SESSION_SECRET production
vercel --prod
```

Redeploy is required — Vercel bakes env vars into the deployed function
config, it does not read the dashboard's stored value live per-request.

**Rotating this logs every admin out, on purpose.** Every existing
`admin_session` cookie fails HMAC verification the instant the new secret
is live, because the signature was computed with the old key. There is
exactly one admin today, so this is a non-event as long as you can
immediately re-authenticate with `ADMIN_PASSWORD` afterward — confirm you
still have that before you rotate.

**Verify:**

- Old session dead: in a browser that was logged into `/admin` before the
  rotation, reload any `/admin/*` page — expect a redirect to
  `/admin/login` (proves `requireAdminSession()` rejected the
  old-signature cookie).
- New session works: log in fresh at `/admin/login` with `ADMIN_PASSWORD`
  — expect it to land on the admin panel (proves the new secret both
  signs and verifies correctly). No SQL check applies; the session is
  stateless by design.

**Blast radius if leaked:** an attacker who obtains `ADMIN_SESSION_SECRET`
can *mint* a validly-signed `admin_session` cookie for any `expiresAt`
within the 7-day window without ever knowing `ADMIN_PASSWORD` or touching
`/admin/login` — full `/admin` access (source management, corrections
review, admin actions) with no login event to notice. Treat this as
equally severe as a leaked `ADMIN_PASSWORD`, not a lesser one.

---

## `RESEND_API_KEY` — not set in production today

**Where it goes when you add it:** Vercel env, `production`. Read directly
by `isMailConfigured()` in `src/lib/email/resend.ts`, which gates the
footer newsletter form, `POST /api/newsletter`, and `GET /api/cron/digest`
fail-closed while unset (see `migration-guide.md`'s "Weekly digest
newsletter (040)" section — this document does not duplicate that
feature's go-live checklist, only where the key lives for future rotation).

**How to generate:** create a Resend account (or use the existing one),
verify the sending domain behind `NEWSLETTER_FROM` (default
`Tayf <bulten@tayfhaber.com>`) under Resend → Domains, then Resend →
API Keys → Create. Scope it to **sending only** if Resend's key-scoping
supports it — this app never needs the broader account-management
permissions a full-access key would grant.

**Setting it for the first time / rotating it later:**

```bash
vercel env add RESEND_API_KEY production   # or: rm then add, to rotate
vercel --prod
```

Redeploy is mandatory: `isMailConfigured()` is evaluated at prerender for
the footer, so the form and the API/cron behavior do not flip until the new
build ships (already documented in `migration-guide.md`'s go-live
checklist, referenced here rather than repeated).

**Verify:** use `migration-guide.md`'s existing GO-LIVE checklist steps 2–7
(footer visible, `POST /api/newsletter` returns 200, confirm mail arrives,
digest cron reports `sent >= 1`). That checklist already is the
new-value-works / old-value-is-dead proof for this secret; nothing to add
here beyond pointing at it.

**Blast radius if leaked:** ability to send arbitrary transactional email
as the verified `tayfhaber.com` sending domain (spam/phishing reputation
risk against the domain), plus whatever Resend account-level access the
key's scope grants — another reason to use a sending-only scoped key if
available.

---

## `ANTHROPIC_API_KEY` — not set in production today

**Where it goes — two places, not one:**

1. **Vercel env**, `production` — `src/app/api/cron/headline/route.ts`
   reads it directly; while unset the route soft no-ops with
   `{"skipped":true,"reason":"LLM API key not set",...}` on every tick
   (verified in this worktree's route.ts) rather than erroring.
2. **GitHub Actions repository secret** — `.github/workflows/cluster-audit.yml`
   also reads `secrets.ANTHROPIC_API_KEY` for the daily audit's zero-output
   alarm (the neutral-title check in `scripts/lib/audit/zero-output.mjs`);
   until this secret exists there too, that specific check stays a no-op
   (job still passes) per the workflow's own comment.

**How to generate:** Anthropic Console → API Keys → Create Key.

**Setting/rotating:**

```bash
# Vercel side — required for the cron to do anything:
vercel env add ANTHROPIC_API_KEY production   # or rm/add to rotate
vercel --prod

# GitHub Actions side — independent, no redeploy needed, takes effect on
# the next workflow run:
gh secret set ANTHROPIC_API_KEY --repo <org>/<repo>
```

**Verify:**

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-tayf-domain>/api/cron/headline"
```

Before the key is set: expect the soft-no-op body above. After setting +
redeploying: expect `{"success":true,"rewrote":<n>,...}` with no `skipped`
field, per the response shape documented in `migration-guide.md` section 4.
For the GitHub Actions side, `gh workflow run cluster-audit.yml` and check
the neutral-title check no longer prints "skipped" in the job log.

**Blast radius if leaked:** arbitrary Anthropic API usage billed to this
account (cost risk with no built-in spend ceiling in this codebase today —
size any budget alarm before turning this on), plus whatever else the key's
scope reaches within the Anthropic account.

---

## `SENTRY_AUTH_TOKEN` — optional, build-time only

**Where it lives:** Vercel env only. `next.config.ts` passes
`process.env.SENTRY_AUTH_TOKEN` into `withSentryConfig`'s `authToken`
option, used exclusively to upload sourcemaps during `next build`. It is
never read at runtime by the deployed app — a missing or wrong value only
degrades Sentry's stack-trace readability, it does not affect the running
site.

**How to generate:** Sentry → Organization Settings → Auth Tokens →
Create New Token, scoped at minimum to `project:releases` for this
project.

**Rotation:**

```bash
vercel env rm SENTRY_AUTH_TOKEN production
vercel env add SENTRY_AUTH_TOKEN production
```

No separate "redeploy" step — the next build (`vercel --prod`, or the next
push-triggered build) picks it up naturally since it is only consumed at
build time.

**Verify:** trigger a build and check the build log for a successful
sourcemap upload (no auth error from the Sentry webpack plugin). Confirm
the old token is dead in Sentry's own Auth Tokens list (revoke it there
explicitly — Vercel removing the env var does not revoke the token at
Sentry's end).

**Blast radius if leaked:** ability to upload/manage releases and
sourcemaps in the Sentry org under this token's scope; a broadly-scoped
token could expose more of the org depending on how it was created — this
is one more reason to scope narrowly at creation time.

---

## Supabase management access token — operator laptop only

**Where it lives: nowhere but the operator's own machine.** This is the
personal-access-token used with `supabase login` (for the CLI) and as the
`Authorization: Bearer $SUPABASE_ACCESS_TOKEN` header against
`https://api.supabase.com/v1/...` (the management API, used for ad-hoc SQL
checks like the ones in this repo's own audit/production-check scripts). It
must never be pasted into a Vercel env var, a GitHub Actions secret, a
Vault secret, or any server-side config — there is no deployed code path
that should ever hold this token.

**How to generate:** Supabase Dashboard → Account (top-right avatar) →
Access Tokens → Generate New Token. **These tokens are account-scoped, not
project-scoped** — a token generated this way can reach every project in
every org the account belongs to. That is the single largest blast-radius
fact in this document; treat generation itself as a sensitive action, not
just storage.

**Rotation steps:** there is nothing server-side to update — only:

1. Generate the new token in the Dashboard, copy it into
   `$SUPABASE_ACCESS_TOKEN` in your shell (or wherever your shell profile
   exports it for `supabase login`).
2. Re-run `supabase login` (or just re-export the variable if your setup
   reads it directly rather than through the CLI's stored credential).
3. **Revoke the old token in the Dashboard immediately** — token
   generation does not automatically expire prior tokens.

**Verify:**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects"
# Expect: 200, with the tayf project present in the body if you drop -o /dev/null.

curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_OLD" \
  "https://api.supabase.com/v1/projects"
# Expect: 401, confirming the revoke in step 3 took.
```

**Known gap, dated 2026-09-10:** the management API's backups endpoint
(`GET /v1/projects/{ref}/database/backups`) returned `401` for the operator
token in use that day even though the token otherwise worked against
`/v1/projects`. This was not root-caused in this pass — it may be a
token-scope limitation specific to that endpoint rather than an expired
token. Re-test with a freshly generated token before relying on that
endpoint for anything; until then, backup retention must be confirmed by
hand in the Dashboard (see [`backup-posture.md`](backup-posture.md)).

**Blast radius if leaked:** the most powerful credential in this entire
document — full account-level access across every Supabase project and org
the account belongs to: project settings, billing, project deletion, and
the ability to read `SUPABASE_SERVICE_ROLE_KEY` straight out of
Settings → API for any project, plus manage that project's Vault secrets.
This is why it is laptop-only and never deployed.
