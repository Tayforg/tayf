# Worker-stream migration guide

Transitioning a deployed tayf instance from the legacy worker pattern (the per-worker `scripts/{rss,cluster,image,headline}-worker.mjs` processes orchestrated under tmux) to the new Vercel-cron + Supabase-Edge-Functions + pgmq stream system.

Architectural overview lives in [`adr/001-worker-stream-system.md`](adr/001-worker-stream-system.md). Read it first if you need the *why*. This document is the *how*: an ordered checklist for a one-operator deployment.

> **Scope:** production Supabase project + production Vercel project. Local dev parity instructions are at the end. The user owns the merge of `refactor/worker-stream-system` to `main`; nothing in this guide does that.

> **Ordering invariant (read once, obey throughout):** the Supabase migrations in step 1 MUST land before the Vercel deploy in step 4 — even an unrelated Vercel redeploy during a partially-applied migration window will regress `/api/health` (which now reads the `worker_metrics` view shipped in migration 024). Keep a freeze on Vercel deploys until step 1 is verified.

---

## Secret-handling preamble (apply before any step below)

The service-role key is the master database credential. Pasting it into a curl invocation drops it into your shell history (`~/.bash_history` / `~/.zsh_history`). Throughout this guide, load it once into a shell variable instead and reference it as `$SR`:

```bash
# Reads stdin without echo, leaves nothing on disk:
read -rs SR
# Paste the service-role key, press Enter. $SR now holds the secret for this
# shell only. Open new terminals re-read it with the same command.
export SR
```

Every curl example below assumes `$SR` is set. The Supabase project ref is similarly held in `$PROJECT_REF`:

```bash
read -r PROJECT_REF       # paste e.g. abcd1234efgh5678
export PROJECT_REF
```

---

## 0. Pre-flight

Confirm you have:

- Supabase CLI installed locally, **version `1.180.x` minimum** (older releases miss `--project-ref` on `functions deploy`; newer-than-1.220 has not been smoke-tested against this guide). Check with `supabase --version`; if you need to pin, `brew install supabase/tap/supabase@1.180` or `npm install -g supabase@1.180`.
- `supabase login` completed against the org that owns the tayf project.
- The Supabase project ref handy (held in `$PROJECT_REF` per the preamble above). You can read it from the dashboard URL (`https://supabase.com/dashboard/project/<PROJECT_REF>`) or from `supabase/config.toml`.
- The service-role key for that project (Supabase Dashboard → Project Settings → API), loaded into `$SR` per the preamble above.
- Vercel CLI installed: `vercel --version`.
- The current main branch is healthy: `npm run build` passes, `npm test` passes.
- A maintenance window. Article ingestion stops for the few minutes between turning off the legacy worker and the new cron schedule firing. Cluster + image-backfill have visibility-timeout-driven re-delivery so partial-state hand-off is safe, but the gap is real.

Take a database snapshot before starting (Supabase Dashboard → Database → Backups → Create snapshot) — standard pre-migration hygiene. Every migration in this set is non-destructive: migration 026 deletes nothing. It only installs a permissive format CHECK that accepts the dual content_hash regime (old sha256, 64-hex; new sha1, 40-hex), and it adds the constraint `NOT VALID` so it does not even take a validate lock on the existing rows.

If `supabase link` has not been run on this machine yet, link now so subsequent commands resolve the project without the `--project-ref` flag:

```bash
supabase link --project-ref "$PROJECT_REF"
```

If you cannot or do not want to link, every `supabase` command below also accepts `--project-ref "$PROJECT_REF"` explicitly.

---

## 1. Apply migrations 024, 025, 026, 027, 028 in order

These migrate the database side of the new system: pgmq install, the article-insert triggers that enqueue work, the content-hash unification, the SECURITY DEFINER `cluster_link_atomic` RPC that serializes cluster_articles writes under a per-cluster advisory lock, and the clean-drop of the never-wired `worker_checkpoint` table.

```bash
# From the repo root.
supabase db push
```

`supabase db push` applies all pending migrations from `supabase/migrations/` in lexical order and records them in the `_supabase_migrations` ledger. There is no first-class CLI flag for applying one migration file at a time. If you need a one-at-a-time apply (recommended on a first production run so you can stop on red), use `psql` directly and then manually reconcile the ledger afterwards:

```bash
# Optional one-at-a-time apply. Skips the migrations ledger — the next
# `supabase db push` will try to re-apply unless you insert the ledger rows
# yourself.
psql "$DATABASE_URL" -f supabase/migrations/024_pgmq_setup.sql
psql "$DATABASE_URL" -f supabase/migrations/025_worker_triggers.sql
psql "$DATABASE_URL" -f supabase/migrations/026_unify_content_hash_v2.sql
psql "$DATABASE_URL" -f supabase/migrations/027_cluster_link_atomic.sql
psql "$DATABASE_URL" -f supabase/migrations/028_drop_worker_checkpoint.sql

# Then reconcile the ledger so the CLI does not retry:
psql "$DATABASE_URL" -c "
  insert into supabase_migrations.schema_migrations (version) values
    ('20240000000024'), ('20240000000025'), ('20240000000026'),
    ('20240000000027'), ('20240000000028')
  on conflict do nothing;
"
```

Replace the version strings with whatever timestamps the actual migration filenames carry — the CLI uses the leading numeric prefix as the version key. If you went the `supabase db push` route, skip the `psql` block above entirely.

**Verification:**

```sql
-- All three should return rows.
select extname, extversion from pg_extension where extname = 'pgmq';
select queue_name from pgmq.list_queues() order by queue_name;
-- Expect: cluster_work, image_backfill
select tgname from pg_trigger where tgrelid = 'articles'::regclass
  and tgname in ('articles_cluster_enqueue', 'articles_image_enqueue');
-- Expect: both
select conname from pg_constraint where conrelid = 'articles'::regclass
  and conname ilike '%content_hash%';
-- Expect a permissive CHECK accepting lowercase 40-hex (sha1) OR 64-hex
-- (sha256) OR null — the dual-regime constraint, added NOT VALID.

-- And the worker_metrics view that /api/health depends on:
select count(*) from worker_metrics;
-- Expect: a small integer, not "relation does not exist".
```

If any of these return nothing or 404, STOP. Do not proceed to step 4 — `/api/health` will 503 the new Vercel deploy.

Migration 026 is idempotent (`DROP CONSTRAINT IF EXISTS` before the ADD) and non-destructive; re-running it is safe.

### 1a. Expose the `pgmq` schema to PostgREST

The pg_cron drains in step 3 invoke the Edge Functions, but operators (and the curl smoke at the end of step 2) also need to reach `pgmq.read` / `pgmq.metrics_all` via the project's REST API. PostgREST only routes requests for schemas listed under **Exposed schemas**.

- **Hosted Supabase (production).** In the Supabase Dashboard, open **Project Settings → API → Exposed schemas** and add `pgmq` to the comma-separated list (the existing entries are `public` and `graphql_public`). Click **Save**. PostgREST hot-reloads within a few seconds; no Edge Function or pg_cron restart is required.
- **Local `supabase start`.** This branch already includes the equivalent change in `supabase/config.toml` (`[api].schemas = ["public", "graphql_public", "pgmq"]`). A fresh `supabase start` will pick it up; if you already have the local stack running, restart it with `supabase stop && supabase start`.

If you skip this step, the smoke curl at the end of step 2 returns the PostgREST `PGRST202` error ("Could not find the function pgmq.read in the schema cache") and the `worker_metrics` view continues to work (it lives in `public`) — the symptom is operator-tooling-shaped, not user-facing-shaped, but it WILL hide queue-depth problems during the cutover.

---

## 2. Deploy the Supabase Edge Functions

Three Deno-runtime functions need to ship: `ingest`, `cluster-consumer`, `image-consumer`. Production runs all three with `verify_jwt=false` (confirmed via the management API on 2026-09-06): the pg_cron drains send `WORKER_CRON_SECRET`, which is not a JWT, so the edge gateway must not verify JWTs — the handlers do their own constant-time bearer check in `supabase/functions/_shared/auth.ts`. Always pass `--no-verify-jwt`; the CLI defaults to `verify_jwt=true` when the flag is omitted and `config.toml` sets nothing, and a deploy without it silently turns the gateway check on and stalls every drain with 401s.

```bash
supabase functions deploy ingest --project-ref <ref> --no-verify-jwt
supabase functions deploy cluster-consumer --project-ref <ref> --no-verify-jwt
supabase functions deploy image-consumer --project-ref <ref> --no-verify-jwt
```

If `supabase link` was skipped in step 0, append `--project-ref "$PROJECT_REF"` to each.

**Set the Edge Function environment.** Create `supabase/functions/.env.production` locally — this file is excluded by `.gitignore` (the pattern is `supabase/functions/.env*`; if you forked before that line landed, add it now and verify with `git check-ignore -v -- supabase/functions/.env.production`). Contents:

```dotenv
SUPABASE_URL=https://<PROJECT_REF>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SUPABASE_ANON_KEY=<anon-key>
# Optional: Sentry DSN (Deno-side SDK; populated when observability lands).
SENTRY_DSN=https://...@sentry.io/...
# Lets cluster-consumer push a targeted Next.js cache revalidation once per
# drain instead of waiting on cacheLife TTLs. CRON_SECRET here MUST be the
# same value set on Vercel in step 4 below — it's the bearer /api/revalidate
# checks. Omit either var and the consumer just skips the POST (logged,
# never fails the drain).
REVALIDATE_URL=https://www.tayfhaber.com/api/revalidate
CRON_SECRET=<same value as the Vercel CRON_SECRET in step 4>
```

Then push to Supabase:

```bash
supabase secrets set --env-file supabase/functions/.env.production
```

If your shop's policy is "never write production secrets under the repo tree", point `--env-file` at a path outside the repo (e.g. `~/.tayf-secrets/functions.env`) — the CLI does not care where the file lives.

**Verification.** Each command should return 200 with an empty-batch JSON body (assuming no work in the queue yet). The `$SR` variable from the preamble carries the secret; do not paste it inline.

```bash
curl -sS -X POST -H "Authorization: Bearer $SR" \
  "https://$PROJECT_REF.functions.supabase.co/cluster-consumer"

curl -sS -X POST -H "Authorization: Bearer $SR" \
  "https://$PROJECT_REF.functions.supabase.co/image-consumer"

curl -sS -X POST -H "Authorization: Bearer $SR" \
  "https://$PROJECT_REF.functions.supabase.co/ingest"
```

A 401 means the bearer check rejected the request — re-check that `SUPABASE_SERVICE_ROLE_KEY` in the Edge Function secrets matches the key in `$SR`. A 401 from the gateway itself (before the handler logs anything) means a deploy re-enabled JWT verification — redeploy with `--no-verify-jwt`.

**Smoke-test that `pgmq` is reachable via PostgREST.** This confirms step 1a took effect — if the schema is not exposed, the response below is `PGRST202` and operator tooling that reads queue depth will silently fail.

```bash
# $SUPA_URL is your project's REST endpoint, e.g.
# https://$PROJECT_REF.supabase.co
export SUPA_URL="https://$PROJECT_REF.supabase.co"

curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SR" \
  -H "Content-Profile: pgmq" \
  -d '{"queue_name":"cluster_work","vt":1,"qty":1}' \
  "$SUPA_URL/rest/v1/rpc/read"
```

Expected: an empty JSON array `[]` (no messages currently waiting past the visibility timeout) or a one-element array with a `cluster_work` message. Any response whose body contains `"code":"PGRST202"` means **step 1a was not applied** — go back and add `pgmq` to the Dashboard's Exposed schemas list, then re-run this curl. A 401 means `$SR` is wrong; a 404 on the URL itself means PostgREST isn't running on the project (unrelated to this change).

---

## 3. Schedule pg_cron drains for the consumers

pg_cron + pg_net live in Supabase but are NOT installed by the portable migrations (they're project-scoped extensions whose grants differ between Supabase Free and Pro; local Postgres via `supabase start` has neither). Both extensions are pre-installed on Supabase Pro; on Free, enable them under Database → Extensions first.

As of migration 038, the schedule itself is applied as a migration instead of hand-run SQL in the Dashboard — the migration is idempotent (safe to re-run after editing a schedule or job body) and is a no-op with a NOTICE on any database missing pg_cron or pg_net. Two Supabase Vault secrets must exist **before** you apply it — create them once via the Supabase Dashboard → SQL Editor. Neither value is ever written into a migration file or into git; the job bodies read them from `vault.decrypted_secrets` at run time:

```sql
-- Run in Supabase Dashboard → SQL Editor, once per project, before applying 038.
select vault.create_secret('<paste service-role key here>', 'service_role_key');
select vault.create_secret('https://<PROJECT_REF>.supabase.co/functions/v1', 'functions_base_url');
```

Then apply the migration:

```bash
supabase db push
# ...or the one-at-a-time psql pattern from step 1 above:
psql "$DATABASE_URL" -f supabase/migrations/038_cron_schedules.sql
```

`038_cron_schedules.sql` schedules `ingest-drain` (`*/3 * * * *`), `cluster-drain` (`* * * * *`), and `image-drain` (`*/5 * * * *`) — same names, schedules, and `net.http_post` shape as before — plus a fourth job, `prune-nightly` (`10 4 * * *`, i.e. 04:10 UTC), that calls the two retention functions from migration 037 (`select public.prune_singleton_clusters(); select public.trim_pgmq_archives();`). Each of the three drain job bodies reads the `service_role_key` and `functions_base_url` Vault secrets at run time, so no project URL or token is baked into the migration file. `prune-nightly` only calls the two 037 functions and needs neither secret. If either secret is missing when pg_cron **is** installed, the migration raises an exception at apply time rather than scheduling a job that 401s or 404s forever.

If you need to change a schedule or a job's body later, edit `038_cron_schedules.sql` and re-apply it — it unschedules each of the four jobs by name before rescheduling, so there's no duplicate-jobname error from pg_cron.

**Verification:**

```sql
-- All four rows should appear; `active = true`.
select jobname, schedule, active from cron.job
  where jobname in ('cluster-drain', 'image-drain', 'ingest-drain', 'prune-nightly');

-- After ~3 minutes, this should show recent runs with `status = 'succeeded'`
-- for the three drains; prune-nightly won't have a run until 04:10 UTC.
select jobname, status, return_message, start_time
  from cron.job_run_details
  where jobname in ('cluster-drain', 'image-drain', 'ingest-drain', 'prune-nightly')
  order by start_time desc limit 10;
```

If you ever need to remove a schedule by hand rather than re-applying 038 (for example while debugging):

```sql
SELECT cron.unschedule('cluster-drain');
SELECT cron.unschedule('image-drain');
SELECT cron.unschedule('ingest-drain');
SELECT cron.unschedule('prune-nightly');
```

---

## 4. Configure Vercel: env vars + redeploy

> **Ordering reminder:** confirm step 1's verification block returned `worker_metrics` with no error before redeploying. `/api/health` reads that view; a missing view turns the new health endpoint into a 503 and Vercel's readiness check can roll back the deploy.

Set the secrets and redeploy. The only Vercel cron after this refactor is `/api/cron/headline`; ingestion, clustering, and image backfill all run on the Supabase side now.

```bash
# Required — without this the /api/cron/headline route returns 401/503
# (FAIL-CLOSED).
vercel env add CRON_SECRET production
# Paste a freshly-generated 32+ char random string when prompted.

# Required — the headline route reads this directly. There is no OpenAI
# or Google integration; the route calls Anthropic's API and short-
# circuits to `{ skipped: true }` when the key is missing. Set it.
vercel env add ANTHROPIC_API_KEY production

vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add SUPABASE_SERVICE_ROLE_KEY production

# Optional — Sentry DSN.
vercel env add SENTRY_DSN production

# Optional — LLM provider overrides for /api/cron/headline. Both fall back
# to the hardcoded vendor defaults baked into the route, so leaving them
# unset keeps the current behaviour. Set them only when swapping providers
# or pinning a different model snapshot without a code change.
vercel env add LLM_API_URL production
vercel env add LLM_MODEL production
```

### Headline-route LLM env vars

The `/api/cron/headline` route reads two optional environment variables to
locate the upstream LLM. The defaults are baked into the route as a
backward-compat fallback, so existing deployments keep working with no
config; set the vars only when you need to override.

| Env var       | Default                                       | Notes                                                                 |
| ------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| `LLM_API_URL` | `https://api.anthropic.com/v1/messages`       | POST endpoint for the messages-shaped completion call.                |
| `LLM_MODEL`   | `claude-haiku-4-5-20251001`                   | Model identifier sent in the request body's `model` field.            |

The route still calls `process.env.ANTHROPIC_API_KEY` for the bearer-style
`x-api-key` header and short-circuits to `{ skipped: true }` when it is
missing; swapping providers without also swapping the auth header shape
will require a small code change in `rewriteClusterHeadline`.

Trigger a deploy:

```bash
vercel --prod
```

After this deploy, Vercel's Cron Jobs page should list **only** `/api/cron/headline` (every 5 minutes). The legacy `/api/cron/ingest`, `/api/cron/cluster`, and `/api/cron/backfill-images` routes were removed in the worker-stream refactor commit set; if you see them in the dashboard, an older deploy is still being served — wait for the new build to propagate or roll forward manually.

**Verification.** `$SR` is the Supabase service-role key from the preamble; the Vercel `CRON_SECRET` is a separate value. Hold the cron secret in `$CRON_SECRET` for the same shell-history reason:

```bash
read -rs CRON_SECRET
export CRON_SECRET

# Should return 401 because no auth header is sent.
curl -sS -o /dev/null -w "%{http_code}\n" \
  "https://<your-tayf-domain>/api/cron/headline"
# Expect: 401

# Should return 200 with a small JSON status payload.
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-tayf-domain>/api/cron/headline"
```

**Trigger the cron's first tick manually** rather than waiting for the */5
schedule to fire. Vercel only attaches a cron once a deploy is promoted to
production AND the first natural tick lands, so a mis-configured env-var on
a fresh deploy is silent until ~5 minutes after rollout — exactly when an
operator has already moved on. The CLI shortcut:

```bash
vercel cron trigger /api/cron/headline
```

Older Vercel CLI versions (< 35) do not expose the `cron trigger` subcommand;
fall back to invoking the route directly with the bearer header (the same
call Vercel's scheduler makes internally):

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-tayf-domain>/api/cron/headline"
```

Either form must return HTTP 200 with a body of the shape

```json
{ "success": true, "rewrote": 0, "skipped": 0, "errored": 0, "timestamp": "..." }
```

(the numeric counters depend on how many clusters were waiting; `success`,
`rewrote`, `skipped`, `errored`, and `timestamp` are always present). A 503
with body `{"error":"CRON_SECRET is not configured"}` means the env-var step
above did not propagate — see the troubleshooting note below before
declaring the deploy healthy.

Within ~15 minutes of the deploy, `/api/health` should report `clustering.lag_minutes < 15`. If it doesn't, see "Troubleshooting" below.

---

## 5. Drain the legacy tmux worker

Once the new stream has been live for at least one full cycle (≥ 15 minutes — enough for cluster-drain, image-drain, ingest-drain, and headline cron to each tick three times) and `/api/health` is green, kill the legacy worker:

```bash
# On whichever host runs the long-running worker.
tmux kill-session -t tayf-app

# If tmux isn't running, but the workers are loose as bare `node`:
pkill -f 'scripts/.*-worker.mjs'
```

Verify no `node scripts/*-worker.mjs` processes remain:

```bash
pgrep -af 'scripts/.*-worker.mjs' || echo "all clean"
```

The new system now owns ingestion, clustering, and image backfill. The legacy per-worker scripts can stay un-run forever; the source files themselves are deleted in a follow-up commit on `main` after Phase 3 QA signs off.

---

## 6. Confirm `vercel.ts` reflects the cutover

`vercel.ts` after this refactor should declare a single cron entry:

```ts
crons: [
  { path: "/api/cron/headline", schedule: "*/5 * * * *" },
]
```

If you see legacy `/api/cron/cluster`, `/api/cron/ingest`, or `/api/cron/backfill-images` entries in `vercel.ts`, the refactor was not fully merged — open `vercel.ts` and remove them, then `vercel --prod` again. The Vercel Cron Jobs dashboard should then list only `/api/cron/headline`.

(If you are following this guide on a branch where the legacy entries are intentionally retained as a soft-cutover safety net, the cutover is done when you remove them and redeploy. Coordinate with the QA owner before doing so.)

---

## 7. Smoke-test the end-to-end stream

Trigger a manual ingest and watch the work flow through:

```bash
# 1. Manually invoke ingest (or wait for the next ingest-drain tick).
curl -sS -X POST -H "Authorization: Bearer $SR" \
  "https://$PROJECT_REF.functions.supabase.co/ingest"

# 2. Watch cluster_work depth shrink as pg_cron drains it.
psql "$DATABASE_URL" -c \
  "select queue_name, queue_length from pgmq.metrics_all() where queue_name in ('cluster_work', 'image_backfill');"

# 3. Confirm fresh clusters land.
psql "$DATABASE_URL" -c \
  "select count(*) from clusters where created_at > now() - interval '15 minutes';"
```

If any step lags, jump to the next section.

---

## Troubleshooting

### `/api/health` reports `clustering` stale

1. Is the pg_cron job running?

   ```sql
   select status, return_message, start_time
     from cron.job_run_details where jobname = 'cluster-drain'
     order by start_time desc limit 5;
   ```

   - `status = 'failed'` with `return_message` showing an HTTP 401 → the `service_role_key` Vault secret is empty or wrong. Update it (`select vault.update_secret(id, '<key>') from vault.secrets where name = 'service_role_key'`) and re-apply 038.
   - `status = 'failed'` with a 404 → the `functions_base_url` Vault secret is wrong; it must end in `/functions/v1`.
   - `status = 'failed'` with HTTP 500 → bug in the consumer. Check Edge Function logs in the Supabase Dashboard.

2. Is `cluster_work` accumulating without being drained?

   ```sql
   select queue_length, oldest_msg_age_sec from pgmq.metrics('cluster_work');
   ```

   If `queue_length` is growing but `cluster-drain` is `succeeded`, the consumer is processing too slowly — bump the cron frequency to every 30 seconds (`*/30 * * * * *` requires pg_cron 1.6+; on older versions, schedule two jobs offset by 30 s).

### `image_backfill` queue is stuck

The most common cause is SSRF blocks consuming the visibility timeout without making progress. Check:

```sql
select * from pgmq.read('image_backfill', 60, 5);
-- Inspect the messages' read_ct. Anything with read_ct > 3 is poison
-- and the consumer should be deleting it — if it's not, that's a bug
-- in image-consumer.
```

### `/api/cron/headline` returns 503 `CRON_SECRET is not configured`

The route is FAIL-CLOSED on a missing or empty `CRON_SECRET` — every
invocation (manual curl, `vercel cron trigger`, or the scheduled */5 tick)
will 503 until the env-var lands. Cause is almost always one of:

- `vercel env add CRON_SECRET production` was run but **no redeploy** has
  happened since — env-vars only attach at build time, so re-run
  `vercel --prod` and re-test against the new deployment URL.
- The env-var was set on a different environment (Preview / Development)
  rather than Production. Confirm with
  `vercel env ls | grep CRON_SECRET` — the row tagged `production` must
  exist.
- The value pasted was empty (just pressing Enter at the prompt sets the
  empty string, which the route treats as unset). Re-add it with
  `vercel env rm CRON_SECRET production && vercel env add CRON_SECRET production`
  and paste a fresh 32+ char random string.

A boot-time warning lands in the Vercel build / function logs when the
route module is initialised in production without `CRON_SECRET` set
(`[headline-cron] CRON_SECRET is not set; route will fail-closed with 503
on every invocation`). Grep the build log or the function's runtime log
for that line to confirm which deployment is the broken one.

### Edge Function cold-start spikes

The first invocation after a long idle (Supabase scales these to zero after ~15 minutes) adds 200–500 ms latency. The `* * * * *` schedule on cluster-drain keeps the function warm; if you raise the schedule interval, expect more cold starts.

### Migration 026 failed mid-run

The migration uses a single transaction, is idempotent (per its header comment), and is non-destructive — it adds one permissive `NOT VALID` CHECK and deletes nothing. Re-run it. The `NOT VALID` clause means the ADD does not scan existing rows, so a stray non-hex row cannot fail the ADD; the constraint is enforced only on new writes. If a later INSERT/UPDATE is rejected, inspect and patch the offending value (it must be lowercase hex of length 40 or 64, or null).

---

## Local-dev parity (optional)

For developers running tayf against a local Supabase via `supabase start`:

```bash
supabase start
supabase db reset                         # applies all migrations
supabase functions serve                  # runs all Edge Functions locally on :54321

# In another terminal, drain manually instead of pg_cron. $LOCAL_SR is the
# local service-role key printed by `supabase status`; load it with
# `read -rs LOCAL_SR && export LOCAL_SR` so it does not appear in history.
watch -n 60 'curl -sS -X POST -H "Authorization: Bearer $LOCAL_SR" http://127.0.0.1:54321/functions/v1/cluster-consumer'
watch -n 300 'curl -sS -X POST -H "Authorization: Bearer $LOCAL_SR" http://127.0.0.1:54321/functions/v1/image-consumer'
watch -n 180 'curl -sS -X POST -H "Authorization: Bearer $LOCAL_SR" http://127.0.0.1:54321/functions/v1/ingest'
```

Set `SUPABASE_LOCAL_URL=postgres://...` in your shell to enable the live tier of `tests/migrations/024-026.test.ts`. The local DB URL is fixed by the Supabase CLI defaults:

```bash
export SUPABASE_LOCAL_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
npm test
```

If you prefer to derive the URL from the running stack, parse `supabase status` text output (there is no JSON mode):

```bash
export SUPABASE_LOCAL_URL="$(supabase status | awk -F': *' '/DB URL/ {print $2}')"
npm test
```

---

## Roll-back

Fastest path first: if the breakage is in the Vercel deploy, `vercel rollback <prior-prod-deployment-url>` (or Dashboard → Deployments → ⋯ → Promote to Production) restores the previous production deployment instantly, no rebuild. The git-revert path below is the durable fix once the fire is out.

If the new system misbehaves and you need to revert to the legacy per-worker scripts:

1. Pause the pg_cron jobs (don't delete them — pausing is reversible). `prune-nightly` can stay active during this rollback — it never calls the Edge Functions, only the 037 retention functions — so it's fine to leave out of this list:

   ```sql
   update cron.job set active = false where jobname in ('cluster-drain', 'image-drain', 'ingest-drain');
   ```

2. Revert the Edge Function deployments to the prior bundle. The Supabase CLI does not expose a first-class "redeploy previous version" flag, so the procedure is:

   ```bash
   # PRIOR_SHA is the merge base of refactor/worker-stream-system on main
   # (or any earlier commit that was previously deployed). Per-function:
   git checkout $PRIOR_SHA -- supabase/functions/ingest/
   supabase functions deploy ingest --project-ref $PROJECT_REF
   git checkout $PRIOR_SHA -- supabase/functions/cluster-consumer/
   supabase functions deploy cluster-consumer --project-ref $PROJECT_REF
   git checkout $PRIOR_SHA -- supabase/functions/image-consumer/
   supabase functions deploy image-consumer --project-ref $PROJECT_REF
   # Restore the working tree once the redeploys succeed.
   git checkout HEAD -- supabase/functions/
   ```

   If `$PRIOR_SHA` predates this refactor (i.e. the Edge Functions did not exist), deploy a no-op stub instead (a `Deno.serve` that returns 200 to the bearer-authed health probe) so the pg_cron pokes do not generate 404s while you decide whether to keep the queues idle or fully decommission them.

3. The legacy per-worker scripts (`scripts/rss-worker.mjs` etc.) are **deleted** from this branch (commit 7d84ece). If you need them back, revert the refactor commit set in git before redeploying Vercel — there is no way to restart them from the post-refactor working tree alone.

4. Migration 026's CHECK constraint stays in place. It is permissive and dual-regime by design — it accepts both the legacy worker's 40-char sha1 hashes and the old 64-char sha256 hashes — so it never needs reverting and there is no deleted data to restore (026 deletes nothing). Migrations 024, 025, 027, and 028 also stay; the new triggers and the `cluster_link_atomic` RPC do no harm with the queues paused and no Edge Function dialling the RPC.

5. Steps 1a and 4 need no reversal. `pgmq` can stay in PostgREST's Exposed schemas — the REST surface is bearer-gated (service-role only, per migration 024's grants) and a later roll-forward needs the schema exposed again anyway. `CRON_SECRET` can likewise stay set on Vercel: rolling back the Edge Functions (step 2 above) does not restore the legacy `/api/cron/*` routes, so the variable sits unused by anything except `/api/cron/headline`.

A *destructive* rollback (drop the queues + remove the triggers + drop `cluster_link_atomic`) is intentionally not pre-prepared because the user's instruction was *forward-only*: every recovery from a bad worker-stream deployment should resolve forward, not backward. If a destructive rollback is genuinely required, hand-write a migration that drops `cluster_link_atomic`, the two `enqueue_*` trigger functions and their triggers, the `worker_metrics` view, and the pgmq queues (`select pgmq.drop_queue('cluster_work'); select pgmq.drop_queue('image_backfill');`).

---

## Before merging: redeploy cluster-consumer, then apply 032

The bias-zone contract (`supabase/functions/_shared/cluster/blindspot.ts`) unified the four blindspot/surprise definitions that had drifted apart in production. Landing it requires both a function redeploy and a DB step. Merging to `main` deploys the Next app immediately, and the `/blindspots` page's `.eq("is_blindspot", true)` prefilter means production's `is_blindspot` values matter the moment that deploy lands — so do these two steps **before** merging, in this order:

```bash
# 1. Redeploy cluster-consumer FIRST. Only this function imports the
#    contract module (grep over ingest/, image-consumer/, _shared/ finds no
#    other importer) — it is bundled into the function at deploy time, not
#    loaded at runtime from the repo, so a DB-only apply does NOT change
#    what a running function does.
supabase functions deploy cluster-consumer --project-ref "$PROJECT_REF"

# 2. Apply migration 032 (idempotent — recompute_blindspot_flags() only
#    touches rows whose is_blindspot / blindspot_side actually change).
#    Running this after the redeploy means it also backfills any clusters
#    the new consumer already wrote under the new rule.
supabase db push
# ...or the one-at-a-time psql pattern from step 1 above:
psql "$DATABASE_URL" -f supabase/migrations/032_blindspot_contract_recompute.sql
```

**Why the order matters:** the pg_cron `cluster-drain` job fires every minute (see AGENTS.md), so if 032 ran first, the still-deployed old consumer would keep writing old-rule flags between the DB step and the redeploy, and the backfill would already be done — no second pass would ever correct them. Redeploying first means every row the consumer writes from that point on already follows the contract, and 032's backfill catches everything else in one pass. Any future edit to `BIAS_TO_ZONE`, `BLINDSPOT`, or `SURPRISE` in that file needs the same two-step treatment: a function redeploy, then a new migration (mirroring 032) to recompute stored data. `tests/migrations/zone-parity.test.ts` catches drift between the SQL copies and the contract module, but it cannot catch a stale deploy — that's an operator step, not a CI one.

**Verification:**

```sql
select public.recompute_blindspot_flags();
-- Expect: 0. If it returns non-zero here, 032 hasn't actually finished
-- backfilling everything — re-run once more and confirm 0.
```

---

## After merging: apply 033

`033_corrections.sql` adds the `corrections` table backing `POST /api/corrections` (the `/metodoloji#duzeltme` form). Apply it after this merge lands: `supabase db push` or `psql "$DATABASE_URL" -f supabase/migrations/033_corrections.sql`. No function redeploy needed — the route reads/writes via `createServerClient()` directly.

---

## Source kinds (034): apply first, redeploy second, recompute third

`034_source_kind.sql` adds `sources.kind` (`outlet | aggregator | wire | niche`, default `'outlet'`), backfills it on the 38 seeded aggregator/wire/niche sources by slug, recreates `trends_daily_bias_counts` filtered to `s.kind in ('outlet', 'wire')`, and ships `public.recompute_bias_distribution(p_since)` — a re-runnable function that re-derives `clusters.bias_distribution` from voting members only. Only `outlet` and `wire` sources vote in `bias_distribution`, blindspot/surprise detection, and the trends view; `aggregator` and `niche` sources remain cluster members (they still count toward `article_count` / "N kaynak") but never move a vote. The contract lives in `supabase/functions/_shared/cluster/source-kind.ts`; `tests/migrations/zone-parity.test.ts` fails the build if the migration's CHECK list, voting filters, or seed parity drift from it.

**The order is REVERSED relative to 032.** 032 was safe to redeploy the function first because it only *added* a function — nothing already deployed depended on a column that didn't exist yet. This migration is different: the new `cluster-consumer` build selects `sources.kind` in its source lookup (`getSourceLookup`), so if that build reaches production before the column exists, every drain invocation 500s on an undefined-column error the moment it tries to read sources. So here the migration goes first, and the function redeploy follows it:

1. **Apply the migration first:**

   ```bash
   supabase db push
   # ...or the one-at-a-time psql pattern from step 1 above:
   psql "$DATABASE_URL" -f supabase/migrations/034_source_kind.sql
   ```

2. **Redeploy `cluster-consumer` second**, now that the column it selects exists:

   ```bash
   supabase functions deploy cluster-consumer --project-ref "$PROJECT_REF" --no-verify-jwt
   ```

3. **Re-run both recompute functions third.** Between step 1 and step 2, the still-deployed *old* consumer kept writing all-sources distributions (it has no notion of `kind` yet) for every cluster it touched — so the migration's own one-time backfill (which ran as part of step 1, before the redeploy) is now stale for that window. Re-run and confirm both return 0 on a second call:

   ```sql
   select public.recompute_bias_distribution(now() - interval '48 hours');
   select public.recompute_blindspot_flags();
   -- Expect: 0 the second time you run this pair. If either returns
   -- non-zero on the first call here, that's expected — it's catching the
   -- old consumer's writes from the step 1 → step 2 window. Re-run once
   -- more and confirm both settle at 0.
   ```

Clusters last touched more than 48h before you run step 3 keep their pre-034 (all-sources) `bias_distribution` **by design** — the 48h window matches 031/032's convention and keeps the recompute cheap. A full rebuild is available for an off-peak run:

```sql
select public.recompute_bias_distribution('1970-01-01');
select public.recompute_blindspot_flags();
```

`supabase/seed_sources.sql` now carries a `kind` column for every seeded row, so a fresh environment (`supabase db reset`, or a new project seeded from scratch) gets the correct source kinds without needing this migration's slug-keyed UPDATE at all — the seed file is the source of truth for new installs, 034's VALUES list is the backfill for the existing production database.

---

## MinHash signature (036): apply first, redeploy second

`036_minhash_signature.sql` adds two nullable columns to `articles`: `minhash_sig` (`bigint[]`, the k=64 MinHash over 4-gram shingles) and `minhash_version` (`smallint`, must match `MINHASH_VERSION` in `supabase/functions/_shared/cluster/fingerprint.ts`). No backfill — the consumer fills both lazily via `persistEnrichment` as it (re)processes each article; rows nobody has reprocessed yet just keep recomputing their signature on every cold start until they are, exactly as today.

Same order and reason as 034 — the new `cluster-consumer` build selects and writes these columns, so deploying it before the migration lands turns every drain into an undefined-column 500:

1. **Apply the migration first:** `supabase db push` (or `psql "$DATABASE_URL" -f supabase/migrations/036_minhash_signature.sql`).
2. **Redeploy `cluster-consumer` second:** `supabase functions deploy cluster-consumer --project-ref "$PROJECT_REF" --no-verify-jwt`.

No recompute step is needed afterward — unlike 034, nothing here changes what an already-stored row means, so there is nothing stale to backfill.

Whenever the MinHash's hash parameters change (`baseHash32`, coefficient seeds, `k`, or the shingle `n`), bump `MINHASH_VERSION` in `fingerprint.ts` — stored rows carrying the old version stop being reused and are recomputed on their next pass, the same lazy path a never-processed row takes today.

## Quality telemetry (039): apply before this branch reaches Vercel, then redeploy `ingest`

`039_quality_telemetry.sql` adds two new tables and one additive column, backing the daily cluster-quality audit and per-cycle ingest health:

- `public.cluster_quality_snapshots` — one row per `node scripts/audit-clusters.mjs --json --persist` run. `GET /api/metrics` reads the latest row for `clusters.quality`.
- `public.ingest_cycles` — one row per `ingest` Edge Function cycle, written best-effort (errors logged and swallowed, never fail the cycle) at cycle end on both the success and the failure path. `GET /api/metrics` sums `row_errors` over rows finished in the last hour for `ingest.rowErrorsLastHour`.
- `articles.canonical_url` — nullable, additive column populated from the normaliser's existing `canonicalizeUrl()` helper.

Both tables follow the 030/032/033 pattern: RLS enabled, no policies, explicit revoke from `anon`/`authenticated` — every reader/writer is `service_role`.

> **This migration also gates the Vercel deploy, not just `ingest`.** `GET /api/metrics` (`src/app/api/metrics/route.ts`) queries both new tables unconditionally. Per the ordering invariant at the top of this document, merging/deploying this branch to Vercel before 039 is applied leaves `/api/metrics` reading tables that don't exist yet. The route treats a missing-relation error (PostgREST `PGRST205` / Postgres `42P01`) on *just those two queries* as "no data yet" rather than a hard failure, so `/api/metrics` keeps serving its pre-existing fields during the gap — but `clusters.quality` and `ingest.rowErrorsLastHour` won't populate until 039 lands, so apply it first regardless.

**Apply the migration before redeploying `ingest` (and before deploying this branch's Vercel changes), in this order** (same reasoning as migration 034 — the deployed function/route must never select or write a column/table that doesn't exist yet):

1. **Apply the migration first:**

   ```bash
   supabase db push
   # ...or the one-at-a-time psql pattern from step 1 above:
   psql "$DATABASE_URL" -f supabase/migrations/039_quality_telemetry.sql
   ```

2. **Redeploy `ingest` second.** The updated function writes `canonical_url` in every `articles` upsert and inserts into `ingest_cycles` at the end of each cycle. If the function reached production before the migration, the `canonical_url` key in the upsert payload would make PostgREST reject the whole batch (`column "canonical_url" of relation "articles" does not exist"`) — the per-row fallback in `runCycleBody` would then fail every row too, so ingestion would silently stop inserting until the migration lands. The `ingest_cycles` insert itself is safe either way (it is wrapped in a try/catch and only logs on failure), but there is no reason to take the `canonical_url` risk — apply the migration first.

   ```bash
   supabase functions deploy ingest --project-ref "$PROJECT_REF"
   ```

**Two new GitHub Actions repository secrets** are needed for `.github/workflows/cluster-audit.yml` (the scheduled `node scripts/audit-clusters.mjs --json --persist` run that writes into `cluster_quality_snapshots`): `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Add them at **Settings → Secrets and variables → Actions → New repository secret**: `SUPABASE_URL` = `https://$PROJECT_REF.supabase.co` (the same value as `NEXT_PUBLIC_SUPABASE_URL` in `.env.local` — note `$PROJECT_REF` above is the bare project ref, not a URL, so it needs the `https://` / `.supabase.co` wrapping) and `SUPABASE_SERVICE_ROLE_KEY` = the value held in `$SR` above — the workflow needs the service-role key specifically (not the anon key) since both new tables revoke all PostgREST access from `anon`/`authenticated`.

## Weekly digest newsletter (040): apply migration, set env vars, redeploy

Double-opt-in newsletter signup plus a Saturday-morning digest cron. Three new routes (`POST /api/newsletter`, `GET /api/newsletter/confirm`, `GET /api/newsletter/unsubscribe`), one new cron (`GET /api/cron/digest`, see `vercel.ts`), and one migration (`040_newsletter_tokens.sql`). No function redeploy needed — every route reads/writes via `createServerClient()` directly, same as `033_corrections.sql`.

**1. Apply the migration:**

```bash
supabase db push
# ...or the one-at-a-time psql pattern from step 1 above:
psql "$DATABASE_URL" -f supabase/migrations/040_newsletter_tokens.sql
```

`040` adds `confirm_token`, `unsubscribe_token`, `confirmed_at`, and `last_sent_at` to `newsletter_subscribers`, backfills tokens for any pre-existing rows with `gen_random_uuid()::text`, and installs a trigger that keeps the legacy `confirmed` boolean in lockstep with `confirmed_at` (`confirmed_at is not null <=> confirmed`) regardless of which column a future write path sets. RLS from `030_newsletter_rls.sql` already denies anon/authenticated on this table — the new columns inherit that; only `service_role` touches them.

**Verification:**

```sql
-- Both should exist and be empty (or near-empty) immediately after the
-- migration, before any cron/workflow run has landed a row yet.
select count(*) from public.cluster_quality_snapshots;
select count(*) from public.ingest_cycles;
-- articles.canonical_url exists and is null for every pre-existing row:
select count(*) from public.articles where canonical_url is not null;
```

After the next `ingest-drain` cron tick, `select count(*) from public.ingest_cycles;` should be non-zero and `canonical_url is not null` should hold for every article inserted since the redeploy.

select confirm_token, unsubscribe_token, confirmed, confirmed_at
  from newsletter_subscribers limit 5;
-- Expect: both tokens non-null on every row (including pre-existing ones),
-- and confirmed = (confirmed_at is not null) for each row.
```

**2. Set the new Vercel env vars:**

```bash
# Required for outbound mail (confirm links + the weekly digest). This key
# gates the whole feature fail-closed, not just outbound mail: while it is
# unset, isMailConfigured() (src/lib/email/resend.ts) makes the footer hide
# the newsletter form entirely (src/components/layout/footer.tsx), POST
# /api/newsletter returns 503 "Newsletter is not configured" before any row
# is inserted, and GET /api/cron/digest returns
# {"skipped":true,"reason":"RESEND_API_KEY not set","sent":0} without
# running a single Supabase query. Nothing is ever shown, accepted, or
# billed for a promise this deployment can't keep.
vercel env add RESEND_API_KEY production

# Optional — defaults to "Tayf <bulten@tayfhaber.com>" if unset.
vercel env add NEWSLETTER_FROM production

# Usually already set from earlier in this guide (it resolves og:image /
# canonical links too). The confirm/unsubscribe/digest emails build their
# links from this — set it to the real production origin, not localhost.
vercel env add NEXT_PUBLIC_SITE_URL production
```

| Env var               | Default (if unset)                    | Notes                                                                                  |
| ---------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`       | *(none — feature fail-closed)*         | `isMailConfigured()` in `src/lib/email/resend.ts` is the single source of truth. Unset = the footer form is not rendered, `POST /api/newsletter` returns 503 with no row inserted, and `GET /api/cron/digest` returns `{skipped:true, reason:"RESEND_API_KEY not set", sent:0}` with no Supabase query. `sendEmail`/`sendBatch` keep their own `{skipped:true}` soft no-op as a second line of defense for any caller that still reaches them. |
| `NEWSLETTER_FROM`      | `Tayf <bulten@tayfhaber.com>`          | Must be a domain verified in the Resend dashboard, or sends will bounce even with a valid key. |
| `NEXT_PUBLIC_SITE_URL` | `https://<VERCEL_PROJECT_PRODUCTION_URL>` or `http://localhost:3000` | Shared with `metadataBase` (see `src/lib/site-url.ts`); confirm/unsubscribe/digest links are built from it. |

**3. Redeploy — this step is not optional.** `RESEND_API_KEY` gates the footer at prerender time (`isMailConfigured()` runs when the server component renders), so **setting the key in Vercel does nothing to production until the app is redeployed.** Pasting the value into the dashboard alone leaves the footer form hidden, `POST /api/newsletter` still returning 503, and the digest cron still short-circuiting — indefinitely, with no error to signal why.

```bash
vercel --prod
```

After this deploy, Vercel's Cron Jobs page should list `/api/cron/headline` (every 5 minutes) **and** `/api/cron/digest` (`0 6 * * 6` — Saturday 06:00 UTC / 09:00 TRT).

**GO-LIVE checklist.** Work through this in order, every time `RESEND_API_KEY` changes state (added, rotated, or removed) in production. `$CRON_SECRET` is the same one gating `/api/cron/headline` above.

1. **Redeploy after the env var change.** `vercel --prod` — see the note above; skipping this step is the most common way this checklist silently fails.
2. **Form visible.** `curl -sS "https://<your-tayf-domain>/" | grep -c 'Haftalık bülten'` returns `1` (with the key unset, it must return `0` — no empty bordered block, the whole wrapper is gone).
3. **POST returns 200.**
   ```bash
   curl -sS -i -X POST -H "Content-Type: application/json" \
     -d '{"email":"you@example.com"}' \
     "https://<your-tayf-domain>/api/newsletter"
   ```
   Expect `HTTP/2 200` and `{"success":true}` (with the key unset, expect `503` and a body containing `"Newsletter is not configured"`, and no row inserted).
4. **Exactly one row.** In Supabase SQL: `select count(*) from newsletter_subscribers where email = 'you@example.com';` — expect `1`.
5. **Confirmation mail received.** A "Tayf bültenine kaydını onayla" email arrives in the inbox used above within a few seconds.
6. **Confirm link sets `confirmed_at`.** Click the link; it must redirect to `/?bulten=onaylandi` (not `/?bulten=gecersiz` — a mismatch there usually means `NEXT_PUBLIC_SITE_URL` doesn't match the domain you're testing against, so the link points at the wrong host). Then: `select confirmed_at from newsletter_subscribers where email = 'you@example.com';` — expect a non-null timestamp. (Before clicking, the same query must return exactly one row with `confirmed_at` null — that is the double opt-in precondition.)
7. **Authenticated digest call succeeds, not a skip.**
   ```bash
   curl -sS -H "Authorization: Bearer $CRON_SECRET" "https://<your-tayf-domain>/api/cron/digest"
   ```
   Expect `200` with `sent >= 1` (at least your confirmed test address) and **no** `"skipped":true` / `"reason"` fail-closed body — that shape only appears while the key is missing. A normal response looks like `{"sent":<n>,"skipped":<n>}`, where `skipped` here counts individual send failures, not a feature-disabled flag.

## Ingest fetch state (041): apply migration, then redeploy `ingest`

`041_source_fetch_state.sql` adds five additive columns to `sources` — `fetch_etag`, `fetch_last_modified`, `fetch_body_hash`, `fetch_last_status`, `fetch_last_at` — so the `ingest` Edge Function's conditional-GET state survives a cold start instead of living only in the module-scope `conditionalCache` Map, which is empty every time a fresh instance spins up. Without this, pg_cron's 3-minute poke was re-fetching and re-parsing all ~118 feeds (~5,300 items) on most cycles when only ~5-30 articles were ever actually new, and most runs were hitting `546 WORKER_RESOURCE_LIMIT` before `ingest_cycles` ever got a row. The updated function also fetches the raw feed body's SHA-256 and short-circuits BEFORE decoding/parsing when it matches the stored `fetch_body_hash` (outlets that reissue byte-identical XML without changing ETag/Last-Modified), flushes fetch-state validators mid-cycle (not only in the cycle-end `finally`, which a 546 kill skips) so progress survives a resource-limit kill, and drops rows sharing a `(source_id, content_hash)` pair with either an earlier row in the same chunk OR an already-stored article under a different `url` — the latter via one `articles` lookup per chunk, since `on_conflict=url` alone can't see that constraint — before either upsert path can hit `articles_source_content_hash_key` (logged as `dedupedInBatch`, not a DB column — 039 shipped before this field existed).

No RLS change: `sources` is already publicly readable (017), and none of these five values are secrets. The migration also creates `public.ingest_set_source_fetch_state(jsonb)` (SECURITY DEFINER, service_role only — 034's shell), which the function calls to write those five columns back in one round trip: a PostgREST upsert can't do a partial-row write on `sources`, because Postgres checks its NOT NULL columns (`name`, `slug`, …) before the ON CONFLICT arbiter and rejects the payload with 23502.

1. **Apply the migration:**

   ```bash
   supabase db push
   # ...or the one-at-a-time psql pattern from step 1 above:
   psql "$DATABASE_URL" -f supabase/migrations/041_source_fetch_state.sql
   ```

2. **Redeploy `ingest`:**

   ```bash
   supabase functions deploy ingest --project-ref "$PROJECT_REF"
   ```

**Verification:**

```sql
-- Recently polled sources should show a real status and a fresh timestamp
-- within a few cycles of the redeploy.
select slug, fetch_last_status, fetch_last_at
  from sources
  order by fetch_last_at desc nulls last
  limit 10;
```

If `fetch_last_at` is still null on every row after a few cycles, the write-back is failing: look for `source fetch-state write failed` in the `ingest` function logs (most likely the function was redeployed before 041 was applied, so the RPC doesn't exist yet).

Also check the ratio of `200` to `546` in `net._http_response` for the pg_cron job that pokes `ingest` (Supabase Dashboard → Database → Extensions → pg_net, or query `net._http_response` directly) — it should shift heavily toward `200` within the first few cycles after redeploy, since most sources now short-circuit on a `304` or an unchanged body hash instead of doing a full parse/normalize/upsert pass.

## Retention (037)

`037_retention.sql` adds `clusters.is_archived` (boolean, default `false`) and a partial index (`clusters_active_updated_idx` on `updated_at desc where is_archived = false`) alongside it, plus two functions:

- **`public.prune_singleton_clusters(retention_days int default 30, batch int default 5000)`** — flags clusters that never grew past a single source (`article_count = 1`) and have been stale for more than `retention_days` as `is_archived = true`, working in batches of `batch` rows so a first run against a large backlog doesn't take one long-held table lock. Returns the total number of rows flagged.
- **`public.trim_pgmq_archives(keep_days int default 7)`** — deletes rows older than `keep_days` from pgmq's own archive tables (`pgmq.a_cluster_work`, `pgmq.a_image_backfill` — the DLQ-lite audit trail described in `supabase/functions/_shared/pgmq.ts`), which otherwise grow forever. No-op (not an error) on a database without pgmq installed. Returns the number of rows deleted.

**What "archived" means — and does not mean:** archiving is a flag flip, never a delete. `is_archived = true` clusters and their member articles stay in the database untouched; nothing in this migration or in 038's nightly schedule issues a `DELETE` against `clusters`, `cluster_articles`, or `articles`. The intent is for future home/politics-list queries to filter `is_archived = false` (mirroring the new partial index) so stale one-source noise stops competing for space in those lists — that query-side filtering is a follow-up, not part of this migration.

Both functions are `SECURITY DEFINER` with `search_path = ''` and are granted to `service_role` only (revoked from `anon`, `authenticated`, `public`), matching the convention in migrations 032 and 034.

**Running it manually.** Migration 038 schedules `prune-nightly` at 04:10 UTC to call both functions in sequence, but either is safe to invoke by hand at any time, e.g. after a bulk backfill or while tuning the retention window:

```sql
-- Flag stale singletons under the default 30-day window, 5000-row batches.
select public.prune_singleton_clusters();

-- Or override either parameter:
select public.prune_singleton_clusters(retention_days => 14, batch => 2000);

-- Trim pgmq's archive tables past the default 7-day window.
select public.trim_pgmq_archives();
```

Both return an integer count (rows flagged / rows deleted); `0` is a valid, unremarkable result once the backlog is caught up.

---

## Jev gölge modu (061): apply migration, set the gateway key, deploy the function

`061_jev_shadow.sql` ships TypeSafe Jev as a pure shadow observer: a `pg_cron`-poked Edge Function (`jev-shadow`, `*/10 * * * *`, bearer-gated like `archive-export`) asks Jev 12 typed questions per run across five subject types and records one row per (task, subject) in `jev_shadow_predictions`, alongside the current system's answer where a baseline exists. The three new tables (`jev_shadow_runs`, `jev_shadow_predictions`, `jev_shadow_reviews`) are `service_role`-only (RLS on, no policies, explicit revoke — the 059/060 shell); nothing this writes reaches a reader except the cookie-gated `/admin` "Jev gölge" section.

**ORDER IS LOAD-BEARING** (the 034/039/041 precedent): apply the migration **before** deploying the function or redeploying Vercel — both the Edge Function and the `/admin` page read tables that only exist after step 1, and a pg_cron poke before step 3 is a harmless 404 in `cron.job_run_details`.

1. **Vault precondition (038).** Verify the Vault secrets `service_role_key` and `functions_base_url` already exist — if either is missing, 061's do-block raises a NOTICE and schedules nothing (the tables and functions still land, but the cron job silently never runs):

   ```sql
   select name from vault.decrypted_secrets where name in ('service_role_key', 'functions_base_url');
   ```

2. **Apply the migration:**

   ```bash
   psql "$DATABASE_URL" -f supabase/migrations/061_jev_shadow.sql
   # ...or: supabase db push
   ```

   The file inserts its own ledger row (`('061', '061_jev_shadow')`), so a subsequent `supabase db push` will not try to re-apply it.

3. **Set the gateway key.** Until this is set, `jev-shadow` returns `{ok:true, skipped:true, reason:"no-api-key"}` and makes zero gateway calls or DB writes — so it is safe to deploy the function before the key exists.

   ```bash
   supabase secrets set AI_GATEWAY_API_KEY=<key> --project-ref "$PROJECT_REF"
   ```

   Or the `.env.production` route (that file is gitignored via `supabase/functions/.env*`; confirm with `git check-ignore -v -- supabase/functions/.env.production`):

   ```bash
   # add AI_GATEWAY_API_KEY=... to supabase/functions/.env.production, then:
   supabase secrets set --env-file supabase/functions/.env.production --project-ref "$PROJECT_REF"
   ```

   The key is never written to the database, never logged, never returned in any HTTP response.

4. **Optional — `JEV_MONTHLY_TOKEN_CAP`** (integer, input tokens). Unset = the SQL default of 3e8 (~$12.6). Set it lower for the first week — the recommended opening position is a ~$4.20 ceiling:

   ```bash
   supabase secrets set JEV_MONTHLY_TOKEN_CAP=100000000 --project-ref "$PROJECT_REF"
   ```

   Note the `/admin` budget line always reads against the SQL default's cap, so if you override the env var, change the SQL default in a follow-up migration too or the admin percentage will read against the wrong denominator.

5. **Deploy the function.** `--no-verify-jwt` is not optional here: omitting it re-enables gateway JWT verification and 401s every pg_cron poke (AGENTS.md:19).

   ```bash
   supabase functions deploy jev-shadow --project-ref "$PROJECT_REF" --no-verify-jwt
   ```

6. **Verify, in order:**

   ```sql
   select jobname, schedule, active from cron.job where jobname = 'jev-shadow';
   -- expect */10 * * * *, active = true
   ```

   ```bash
   curl -sS -X POST -H "Authorization: Bearer $SR" "https://$PROJECT_REF.functions.supabase.co/jev-shadow"
   # expect 200 with a counters JSON
   ```

   ```sql
   select * from public.jev_shadow_month_usage();
   select status, calls, errors, input_tokens from public.jev_shadow_runs order by id desc limit 5;
   ```

7. **Redeploy Vercel.** No new env var is needed — the `/admin` page reads the new tables with the existing `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — but `vercel --prod` **is** required for the new "Jev gölge" `/admin` section to appear.

**KILL SWITCH.** Three independent levers, none requiring a migration or a deploy:

```sql
-- 1. Stop the cron poke entirely.
update cron.job set active = false where jobname = 'jev-shadow';
```

```bash
# 2. Unset the gateway key -- the function then no-ops on every poke.
supabase secrets unset AI_GATEWAY_API_KEY --project-ref "$PROJECT_REF"
```

3. The run stops itself once the monthly token cap is hit (`jev_shadow_month_usage`, checked before the first call and re-checked mid-run).

---

## Jev şimdi paketi (063): altın küme, gece denetimi, kapasite

There is deliberately no 062 in this repo — the production ledger already carries a foreign `062_coverage_semantics_and_context` row applied outside this repository, so this pack was renumbered to 063. Do not create a 062_*.sql.

`063_jev_now_package.sql` turns the 061 shadow suite from an agreement meter into an accuracy meter: three new shadow tasks (`pair_positive`, `ticker_relevance`, `neutral_pick`), a nightly **audit** run mode that samples pairs against cluster membership instead of the live stream, a hashed question registry, and a new `/admin/jev-altin` "altın küme" (gold set) double-labeling surface with its own tables (`jev_gold_set`, `jev_gold_labels`) and `SECURITY DEFINER` RPCs (`jev_gold_seed`, `jev_gold_next`, `jev_gold_scorecard`). The monthly token cap default also rises from 3e8 to 5e8 (~$21 at the gateway market rate observed 2026-09-20); measured production burn at the `*/10` cadence puts that cap around day 23 of a 30-day month, so 5e8 is a deliberate ~3-week ceiling, not a month of headroom. `jev-shadow/index.ts` gains a `JEV_DISABLED` kill switch and routes `{"mode":"audit"}` to the new nightly path; everything else about the shadow observer — pure, `service_role`-only, nothing it writes reaches a reader except the cookie-gated `/admin` sections — is unchanged from 061.

**ORDER IS LOAD-BEARING** (same discipline as every migration above): apply the migration **before** deploying the function or redeploying Vercel — both the Edge Function and the new `/admin/jev-altin` page read objects that only exist after step 2.

1. **Vault precondition (038), unchanged.** Same check as 061 step 1 — if either secret is missing, 063's do-block silently schedules no audit cron (the tables and functions still land):

   ```sql
   select name from vault.decrypted_secrets where name in ('service_role_key', 'functions_base_url');
   ```

2. **Apply the migration:**

   ```bash
   psql "$DATABASE_URL" -f supabase/migrations/063_jev_now_package.sql
   # ...or: supabase db push
   ```

   The file inserts its own ledger row (`('063', '063_jev_now_package')`) and is safe to re-apply.

3. **The cap change — and the override trap.** The SQL default rises to `5e8` (~$21), but if a `JEV_MONTHLY_TOKEN_CAP` Edge secret was set during 061 step 4 (the recommended opening ~$4.20 ceiling), **that env var still wins over the new SQL default for the Edge Function**, while `/admin`'s budget percentage always reads the SQL default — so the two disagree until the override is removed: the function silently caps out around $4.20 while the page shows 20% of a $21 budget used. Unless you deliberately mean to keep the lower ceiling:

   ```bash
   supabase secrets unset JEV_MONTHLY_TOKEN_CAP --project-ref "$PROJECT_REF"
   supabase secrets list --project-ref "$PROJECT_REF" | grep JEV_MONTHLY_TOKEN_CAP   # expect no output
   ```

4. **Deploy the function.** `--no-verify-jwt` is not optional here, same as 061:

   ```bash
   supabase functions deploy jev-shadow --project-ref "$PROJECT_REF" --no-verify-jwt
   ```

5. **Verify, in order:**

   ```sql
   select jobname, schedule, active from cron.job where jobname in ('jev-shadow', 'jev-cluster-audit');
   -- expect */10 * * * * and 55 3 * * *, both active = true
   ```

   ```sql
   select * from public.jev_shadow_month_usage();
   -- expect cap = 500000000
   ```

6. **Smoke the audit path once, by hand, before the cron's first 03:55 UTC run:**

   ```bash
   curl -sS -X POST -H "Authorization: Bearer $SR" -H 'Content-Type: application/json' \
     -d '{"mode":"audit"}' "https://$PROJECT_REF.functions.supabase.co/jev-shadow"
   # expect non-zero audit_pairs and pairs stage counts, zero everywhere else
   ```

7. **Redeploy Vercel.** No new environment variable is needed — `/admin/jev-altin` reads the new RPCs with the existing `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — but `vercel --prod` **is** required for the page to exist:

   ```bash
   vercel --prod
   ```

8. **Seed the gold set** from `/admin/jev-altin` ("Altın kümeyi oluştur") only **after** at least 24h of shadow predictions exist — `jev_gold_seed` draws exclusively from articles that already carry a `task='politics'` prediction, so an early seed returns a small or empty set. The button is idempotent; re-running it later tops each category back up to the SQL default (38).

**KILL SWITCH.** Four independent levers, in escalating order, none requiring a migration or a deploy:

```sql
-- 1. Stop the nightly audit only -- the 10-minute shadow run keeps going.
update cron.job set active = false where jobname = 'jev-cluster-audit';
```

```bash
# 2. Stop BOTH modes instantly, without touching cron.job -- checked before
# any database read, run row, or gateway call.
supabase secrets set JEV_DISABLED=1 --project-ref "$PROJECT_REF"
# every poke now returns 200 {"ok":true,"skipped":true,"reason":"disabled"}
```

```sql
-- 3. Stop the 10-minute shadow poke entirely.
update cron.job set active = false where jobname = 'jev-shadow';
```

```bash
# 4. Unset the gateway key -- the function then no-ops on every poke,
# regardless of JEV_DISABLED or cron.job.
supabase secrets unset AI_GATEWAY_API_KEY --project-ref "$PROJECT_REF"
```

**WARNING — gold labels cascade-delete with their articles.** `jev_gold_labels.article_id` references `jev_gold_set(article_id)` which references `articles(id)`, both `on delete cascade`. The admin `nuke_articles` action (`src/app/api/admin/route.ts`) deletes every row of `public.articles` in one press, which silently and irrecoverably destroys the entire hand-labeled gold set with it. Before running `nuke_articles`, or any other bulk article delete, snapshot both tables:

```sql
copy (select * from public.jev_gold_set) to '/tmp/jev_gold_set_backup.csv' with csv header;
copy (select * from public.jev_gold_labels) to '/tmp/jev_gold_labels_backup.csv' with csv header;
```

## Sinyaller paketi (065): kaynak sapması, KAP kanaryası, arşiv etiketleri

`065_jev_signals.sql` adds four zero-gateway-cost measurements built entirely on the predictions the 061/063 shadow suite already writes: two `service_role`-only tables (`source_drift_daily`, `jev_alerts`), four `SECURITY DEFINER` functions (`jev_source_drift_compute`, `jev_kap_canary_compute`, `jev_kap_canary_status`, `kap_disclosure_signals_for`), and one SQL-only nightly `pg_cron` job (`jev-signals-nightly`, `05 4 * * *`) that calls the two writer functions. The nightly archive export also gains a per-article `labels` object and a declared `labels` block in `manifest.json`. Standing note: this pack adds zero new gateway calls (every number is computed in SQL from rows that already exist) and makes no reader-facing byte changes -- `/ekonomi`, `/`, `/kaynaklar/durum` and `/blindspots` are untouched.

**ORDER IS LOAD-BEARING**: apply the migration **before** deploying `archive-export` and **before** `vercel --prod` -- both read objects that only exist after the migration.

1. **Apply the migration:**

   ```bash
   psql "$DATABASE_URL" -f supabase/migrations/065_jev_signals.sql
   # ...or: supabase db push
   ```

   The file inserts its own ledger row (`('065', '065_jev_signals')`) and is safe to re-apply. Unlike 060/061/063, this migration needs **no Vault precondition** -- the cron job is SQL-only and never leaves Postgres.

2. **Verify the cron:**

   ```sql
   select jobname, schedule, active from cron.job where jobname = 'jev-signals-nightly';
   -- expect 05 4 * * *, active = true
   ```

3. **Smoke both writers by hand for yesterday, before the first 04:05 UTC run:**

   ```sql
   select * from public.jev_source_drift_compute();
   select * from public.jev_kap_canary_compute();
   ```

   On a fresh install both legitimately return zeros until 14 days of shadow predictions exist -- the baseline gate is `n >= 60` politics predictions over the trailing 14 days per source.

4. **Deploy the archive function:**

   ```bash
   supabase functions deploy archive-export --project-ref "$PROJECT_REF" --no-verify-jwt
   ```

   `--no-verify-jwt` is not optional here, same as every other Edge Function in this repo.

5. **ARCHIVE LABELS ARE DECLARED, MODEL-DERIVED DATA.** Every `articles.jsonl` row now carries a `labels` object and `manifest.json` carries `labels: {source: "typesafe-ai/jev via jev-shadow", question_set, coverage, declared: true}`. These are a model's answers, not editorial judgements and not ground truth; anyone consuming the archive must read them as such. Older day prefixes keep the pre-065 shape -- the export is idempotent per day and will **not** rewrite a day that already has an `archive_exports` ledger row. To backfill labels into an already-exported day, delete that day's ledger row first, then re-POST the day:

   ```sql
   delete from public.archive_exports where day = 'YYYY-MM-DD';
   ```

   ```bash
   curl -sS -X POST -H "Authorization: Bearer $SR" -H 'Content-Type: application/json' \
     -d '{"day":"YYYY-MM-DD"}' "https://$PROJECT_REF.functions.supabase.co/archive-export"
   ```

6. **Redeploy Vercel** -- required for the new `/admin` "Kaynak sapması" / "Uyarılar" sections and the `/admin/ekonomi` "KAP önemlilik" panel. No new environment variable is needed:

   ```bash
   vercel --prod
   ```

**KILL SWITCH** (no migration, no deploy):

```sql
update cron.job set active = false where jobname = 'jev-signals-nightly';
```

This stops both signal writers and changes nothing else -- the archive labels and the admin sections keep working off whatever rows already exist.

A SQL-only cron failure surfaces **only** in `cron.job_run_details`, never in Sentry (which is wired into the Deno Edge Functions, not into Postgres):

```sql
select jobname, status, return_message, start_time from cron.job_run_details where jobname = 'jev-signals-nightly' order by start_time desc limit 5;
```

**POST-DEPLOY WATCH.** Also check that the alert count does not explode on day one:

```sql
select count(*) from public.jev_alerts where acknowledged_at is null;
```

Treat the first weeks of this count as threshold-calibration data, not ground truth: the `drift_score >= 3` / `>= 0.250` cut points and the KAP canary's 10% / `n >= 10` gate are unvalidated first guesses. A synthetic 118-source / 283k-prediction uniform-random run flagged roughly 3-6% of sources per night on pure noise alone (an upper bound -- real sources are autocorrelated, so expect less in practice). A steady nightly floor at that rate means the thresholds need tuning, not that the feeds broke.

**RETRACTION IS NOT AUTOMATIC.** `jev_source_drift_compute` can only ever rewrite or add a row for a day that still qualifies (`politics_n >= 20` and `base_n >= 60`); it never deletes a row for a day that stopped qualifying -- the `upserted` CTE only inserts/updates. `source_drift_daily` also has no delete grant (`select`/`insert`/`update` only), so a stale `flagged = true` row keeps rendering in /admin's "Kaynak sapması" table for the rest of its 7-day window even after an operator confirms it was a false positive, and simply re-running `jev_source_drift_compute()` for that day returns `(0, 0)` with no change. There is no service_role delete path today -- retracting a known-bad row requires a follow-up migration; until one lands, treat it as "acknowledge and wait for it to age out of the 7-day window", not as something an operator can clear by hand.

---

## Çerçeve oyları paketi (068): oy tablosu + dört SECURITY DEFINER fonksiyon, cron yok

`068_framing_votes.sql` is PACK D's only migration (R10 + T11): the `public.framing_votes` table (one row per anonymous crowd vote from `/oyun`'s new "Çerçeve" mode) and four `SECURITY DEFINER` functions -- `framing_vote_totals`, `framing_next_headline`, `framing_gold_candidates`, `cluster_framing_receipt`. Same shell as every migration since 057/061: RLS enabled, zero policies, revoked from `anon`/`authenticated`/`public`, granted to `service_role` only, `search_path = ''` on every function. It adds **no cron job** -- every write is reader-driven (`POST /api/oyun/cerceve`) and every read is request-driven -- and **no new secret**: nothing here calls the AI gateway, so 068 costs $0 of model spend.

**ORDER IS LOAD-BEARING**, same discipline as every migration above: apply 068 **before** deploying to Vercel. The deployed `/oyun` Çerçeve mode and the two new `/admin` surfaces (`FramingVotesSection`, and `/admin/rapor/<clusterId>`'s receipt) call `framing_next_headline` / `framing_vote_totals` / `framing_gold_candidates` / `cluster_framing_receipt` the moment they render -- a route that selects a function that does not exist yet must go second, so the migration goes first.

1. **Apply the migration:**

   ```bash
   psql "$DATABASE_URL" -f supabase/migrations/068_framing_votes.sql
   # ...or: supabase db push
   ```

   The file inserts its own ledger row (`('068', '068_framing_votes')`) and is safe to re-apply.

2. No Edge Function deploy is needed -- `supabase/functions/**` is untouched by this pack. Redeploy Vercel once the migration has landed:

   ```bash
   vercel --prod
   ```

**Verification:**

```sql
-- (a) all four functions exist and are SECURITY DEFINER.
select proname, prosecdef from pg_proc
  where proname in ('framing_vote_totals', 'framing_next_headline', 'framing_gold_candidates', 'cluster_framing_receipt');
-- expect 4 rows, prosecdef = true
```

```sql
-- (b) a headline with no votes yet answers zeros, not an error.
select * from public.framing_vote_totals('00000000-0000-0000-0000-000000000000');
-- expect one row of zeros
```

```sql
-- (c) the 48h Çerçeve pool size -- single digits means the mode will run dry
-- and the launch should wait. Mirrors framing_next_headline's eligibility
-- predicate exactly (48h window + active + non-wire source + politics
-- prediction >= 0.7) so this count and the function's real pool can never
-- drift apart.
select count(*) from public.articles a
  join public.sources s on s.id = a.source_id
  where a.published_at >= now() - interval '48 hours'
    and s.active
    and coalesce(s.kind, 'outlet') <> 'wire'
    and exists (select 1 from public.jev_shadow_predictions p
                where p.article_id = a.id and p.task = 'politics' and p.jev_prob >= 0.7);
```

```sql
-- (d) whether cluster_framing_receipt has anything to score at all. If this
-- is 0, the receipt reports scored = 0 forever (fail-closed by design) and
-- FRAMING_RECEIPT_PUBLIC must stay off until a follow-up pack persists
-- per-choice probabilities.
select count(*) from public.jev_shadow_predictions
  where task = 'framing' and jsonb_typeof(jev_answer -> 'answer' -> 'probabilities') = 'object';
```

**WARNING -- the crowd vote ledger cascade-deletes with its articles.** `framing_votes.article_id` references `articles(id) on delete cascade`, the same hazard 063 documents for `jev_gold_labels`. The admin `nuke_articles` action deletes every row of `public.articles` in one press, which silently and irrecoverably destroys every crowd vote with it. Before running `nuke_articles`, or any other bulk article delete, snapshot the ledger:

```sql
copy (select * from public.framing_votes) to '/tmp/framing_votes_backup.csv' with csv header;
```

**KILL SWITCH.** There is no cron to disable. To stop the Çerçeve mode with no deploy:

```sql
revoke execute on function public.framing_next_headline(text) from service_role;
-- GET /api/oyun/cerceve/next now 500s and the client falls back to its
-- empty-pool state. Re-grant to restore:
grant execute on function public.framing_next_headline(text) to service_role;
```

**`FRAMING_RECEIPT_PUBLIC` stays unset.** It is a Vercel env var, server-only, read only through `isFramingReceiptPublic()`. Only the literal string `"1"` turns on the public cluster-page receipt; every other value (including unset) keeps it admin-only. Do not set it as part of this deploy -- flip it only after the operator has reviewed receipts by hand on `/admin/rapor/<clusterId>` and confirmed query (d) above is non-zero.

---

## Owner sign-off checklist

Before declaring the migration complete:

- [ ] `supabase functions deploy cluster-consumer` / `ingest` / `image-consumer` all returned success
- [ ] Migrations 024, 025, 026 applied; verification SQL above returned the expected rows (including `worker_metrics`)
- [ ] `cron.job` shows `cluster-drain`, `image-drain`, `ingest-drain`, and `prune-nightly` with `active = true`
- [ ] `cron.job_run_details` shows recent runs with `status = 'succeeded'`
- [ ] Migrations 037 and 038 applied; Vault secrets `service_role_key` and `functions_base_url` existed before 038 (see "Retention (037)" and section 3 above)
- [ ] `CRON_SECRET` and `ANTHROPIC_API_KEY` env vars are set on Vercel production
- [ ] `vercel --prod` deploy landed with the new `/api/cron/headline` schedule and no legacy cron entries
- [ ] `/api/health` reports `clustering.lag_minutes < 15`
- [ ] No `node scripts/*-worker.mjs` processes running anywhere
- [ ] At least one cluster created in the last 15 minutes (`select count(*) from clusters where created_at > now() - interval '15 minutes'`)
- [ ] At least one image backfilled in the last 15 minutes (`select count(*) from articles where image_url is not null and updated_at > now() - interval '15 minutes'`)
- [ ] Migration 034 applied, `cluster-consumer` redeployed, and both `select public.recompute_bias_distribution(now() - interval '48 hours');` / `select public.recompute_blindspot_flags();` return 0 on a second call
- [ ] `select kind, count(*) from sources group by kind order by kind;` shows non-zero `aggregator`, `wire`, and `niche` counts alongside `outlet`
- [ ] Migration 039 applied before this branch was deployed to Vercel AND before `ingest` was redeployed (`GET /api/metrics` reads `cluster_quality_snapshots`/`ingest_cycles` unconditionally); `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set as GitHub Actions repository secrets; `select count(*) from public.ingest_cycles;` is non-zero after the next `ingest-drain` tick

- [ ] Migration 040 applied — every `newsletter_subscribers` row has both `confirm_token` and `unsubscribe_token` set
- [ ] `RESEND_API_KEY`, `NEWSLETTER_FROM` (if overriding the default), and `NEXT_PUBLIC_SITE_URL` set on Vercel production
- [ ] `vercel --prod` deploy landed with `/api/cron/digest` (`0 6 * * 6`) alongside `/api/cron/headline` in the Cron Jobs dashboard
- [ ] A manual `POST /api/newsletter` test delivered a confirm email whose link redirects to `/?bulten=onaylandi` on click
- [ ] Migration 041 applied and `ingest` redeployed — `select slug, fetch_last_status, fetch_last_at from sources order by fetch_last_at desc nulls last limit 10;` shows recent timestamps; the `200`-vs-`546` ratio in `net._http_response` for the `ingest` cron job has shifted toward `200`

- [ ] Migration 061 applied (Vault precondition from 038 verified first) and `jev-shadow` deployed with `--no-verify-jwt`; `select jobname, schedule, active from cron.job where jobname='jev-shadow';` shows `*/10 * * * *`, active
- [ ] `AI_GATEWAY_API_KEY` set (`supabase secrets set ... --project-ref "$PROJECT_REF"` or the gitignored `.env.production` route) and `vercel --prod` redeployed so the `/admin` "Jev gölge" section renders

- [ ] Migration 063 applied (Vault precondition from 038 verified first); `select jobname, schedule, active from cron.job where jobname in ('jev-shadow','jev-cluster-audit');` shows `*/10 * * * *` and `55 3 * * *`, both active; `select * from public.jev_shadow_month_usage();` reports `cap = 500000000`
- [ ] `JEV_DISABLED` documented as the instant, no-deploy kill switch for both shadow and audit modes, and `vercel --prod` redeployed so `/admin/jev-altin` renders
- [ ] Operator knows `jev_gold_labels` (and `jev_gold_set`) cascade-delete with their `articles` rows, and that the admin `nuke_articles` action deletes every article -- a snapshot/export procedure is agreed before that action is ever used

- [ ] Migration 065 applied; `select jobname, schedule, active from cron.job where jobname = 'jev-signals-nightly';` shows `05 4 * * *`, active
- [ ] `archive-export` redeployed and the next manifest carries `labels.declared = true` with a plausible `coverage`
- [ ] Operator knows the SQL-only `jev-signals-nightly` cron has no Sentry alerting and must be checked in `cron.job_run_details`

- [ ] Migration 068 applied; `select proname, prosecdef from pg_proc where proname in ('framing_vote_totals','framing_next_headline','framing_gold_candidates','cluster_framing_receipt');` returns 4 rows, all `prosecdef = true`
- [ ] `select * from public.framing_vote_totals('00000000-0000-0000-0000-000000000000');` returns one row of zeros, not an error
- [ ] Operator has read the 48h Çerçeve pool size and the `task = 'framing'` scored-probability count (Verification queries (c) and (d) above) before announcing the mode
- [ ] `FRAMING_RECEIPT_PUBLIC` is documented as UNSET by default and is only ever set after the operator has reviewed receipts on `/admin/rapor/<clusterId>` by hand

---

## Docs / See also

- [`key-rotation.md`](key-rotation.md) — rotation runbook for every secret this system uses (Vercel env, GitHub Actions secrets, Supabase Vault, Edge Function secrets).
- [`backup-posture.md`](backup-posture.md) — what Supabase backs up automatically, what isn't backed up at all, the nightly jobs a restore has to be reconciled with, and the quarterly restore-drill procedure.

## 064 — Jev canlı küme paketi (pair_marginal, kör nokta geri çağırma, ayırma kuyruğu)

`064_jev_cluster_live.sql` is the first Jev migration that lets a Jev answer CHANGE what a reader sees, and it does so on the narrowest possible surface: two bounded production mechanisms behind kill switches, plus one fully shadow-only check. `pair_marginal` (cluster-consumer, flag `JEV_LIVE_PAIRS`) asks a second opinion only in the two score bands the ensemble clusterer is already unsure about — band-low `[0.36, 0.40)` and band-high `[0.40, 0.44)` — one call per article, 1500ms timeout, 40 calls per drain, any failure leaves the ensemble decision untouched. `blindspot_recall` (jev-shadow, shadow only, no reader change) asks whether the SILENT media zone of a blindspot cluster actually published the same event, and flags `clusters.blindspot_recall_suspect` for a human to review on `/admin`. The outlier-ejection queue (`jev_unlink_candidates` + the `cluster_unlink_article` RPC) turns low-probability `cluster_member` predictions into an `/admin` "Küme dışı adaylar" review list — nothing is ever unlinked automatically.

**ORDER IS LOAD-BEARING**, same discipline as every migration above: apply the migration **before** deploying either Edge Function or redeploying Vercel.

1. **Apply the migration:**

   ```bash
   psql "$DATABASE_URL" -f supabase/migrations/064_jev_cluster_live.sql
   # ...or: supabase db push
   ```

   Verify it landed and the two additive `clusters` columns and the new RPC exist:

   ```sql
   select * from supabase_migrations.schema_migrations where version = '064';
   select count(*) from public.jev_unlink_candidates;
   -- expect 0 immediately after apply
   select blindspot_recall_suspect, blindspot_recall_checked_at from public.clusters limit 1;
   select pg_catalog.pg_get_functiondef('public.cluster_unlink_article(uuid,uuid)'::regprocedure) is not null;
   -- expect true
   ```

2. **Deploy order: jev-shadow first, then cluster-consumer, both `--no-verify-jwt`, then Vercel.**

   ```bash
   supabase functions deploy jev-shadow --project-ref "$PROJECT_REF" --no-verify-jwt
   supabase functions deploy cluster-consumer --project-ref "$PROJECT_REF" --no-verify-jwt
   vercel --prod
   ```

   jev-shadow first because `blindspot_recall` and the `jev_unlink_candidates` writer both live there and have no reader-facing effect — safe to land before anything else touches this pack. cluster-consumer second because the live marginal-verification code path ships inert until the flag below is set. Vercel last so `/admin`'s two new sections (and the `POST /api/admin/jev-unlink` route) exist only once the RPC and the tables they read are already live.

3. **Secrets.** `AI_GATEWAY_API_KEY` is already present (shared by every Jev-calling function since migration 061) — no new secret is needed for `blindspot_recall` or the unlink queue. The live marginal-verification switch is separate and OFF by default:

   ```bash
   supabase secrets list --project-ref "$PROJECT_REF" | grep JEV_LIVE_PAIRS
   # expect no output -- leaving it unset is the safe default: cluster-consumer's
   # clustering behaviour is byte-identical to today, the drain body only gains
   # a jev_live block with enabled: false.
   ```

   Flip it only after confirming the byte-identical drain (step 4 below):

   ```bash
   supabase secrets set JEV_LIVE_PAIRS=1 --project-ref "$PROJECT_REF"
   # the next cluster-consumer invocation picks it up -- no redeploy needed.
   ```

4. **How to watch it.** Confirm a drain body carries `"jev_live":{"enabled":false,...}` before setting the flag, and once it is set, watch `calls` stay well under 40 with `errors`/`timeouts` near zero:

   ```bash
   curl -sS -X POST -H "Authorization: Bearer $SR" \
     "https://$PROJECT_REF.functions.supabase.co/cluster-consumer"
   # inspect the jev_live block in the JSON body
   ```

   Track `pair_marginal` and `blindspot_recall` volume and agreement in SQL. `recordMarginal`'s upsert (`onConflict: 'task,subject_id', ignoreDuplicates: true`, `subject_id = '<articleId>:<clusterId>'`) means a same-primary retry keeps the FIRST row (which can go stale relative to a retry that actually skipped on duplicate-source) and a different-primary retry writes a SECOND row for the same article — so `count(*)` can double-count and skew `avg(jev_prob)`; cross-check it against the distinct-subject count below before trusting the aggregate:

   ```sql
   select task, count(*), count(distinct split_part(subject_id, ':', 1)) as distinct_subjects, avg(jev_prob)
     from public.jev_shadow_predictions
    where task in ('pair_marginal', 'blindspot_recall')
      and created_at >= now() - interval '1 day'
    group by task;
   ```

   Confirm `jev_unlink_candidates` is receiving rows a few `jev-shadow` runs after deploy (`select count(*) from public.jev_unlink_candidates;`), and review `/admin`'s "Küme dışı adaylar" and "Şüpheli kör noktalar" sections by hand before trusting either signal.

   **What pressing "Ayır" actually does (read before using it).** `cluster_unlink_article` only deletes the `cluster_articles` row — it does not re-home the article anywhere. Every reader surface (cluster detail, the home feed, `/blindspots`) reaches articles through `cluster_articles`, and nothing on the ingest or admin side re-enqueues an unlinked article back onto the cluster queue. So unlinking removes the article from every reader surface entirely; it is effectively a **hide**, not a **move**, of that article — the operator is not correcting its cluster, they are pulling it off the site. If the article should end up in a different (correct) cluster: a plain re-enqueue onto `cluster_work` (the same queue `cluster-consumer` drains) replays the identical ensemble scoring against the identical cluster context, and `addArticleToCluster`'s duplicate-source guard no longer blocks it because the unlink just removed that source's only member row — so the article is very likely re-linked to the exact cluster it was just removed from. Today, treat "Ayır" as a **removal from the site, not a correction**; a safe re-home needs an exclude-cluster hint and is tracked as a follow-up, not a manual re-enqueue. Keep this in mind alongside the round-trip check above: confirming `jev_unlink_candidates` count and reviewing "Küme dışı adaylar" by hand tells you the queue is being populated, not that an unlinked article has landed anywhere else.

**KILL SWITCHES**, in order of bluntness — none of them requires a migration or a rollback, and 064 can stay applied with every switch off:

```bash
# 1. Live marginal verification off within one cluster-consumer invocation;
#    the shadow suite (blindspot_recall, the unlink queue) keeps running.
#    This is the ONLY switch that stops the live pair_marginal path.
supabase secrets unset JEV_LIVE_PAIRS --project-ref "$PROJECT_REF"
```

```bash
# 2. The whole jev-shadow suite off (blindspot_recall included).
#    Does NOT stop live marginal verification -- unset JEV_LIVE_PAIRS
#    (switch 1) first. The live path is also independent of
#    JEV_MONTHLY_TOKEN_CAP (it never reads jev_shadow_runs).
supabase secrets set JEV_DISABLED=1 --project-ref "$PROJECT_REF"
```

```sql
-- 3. Stop the 10-minute shadow poke entirely.
update cron.job set active = false where jobname = 'jev-shadow';
```

## Konu — küme konu ekseni (067): apply the migration, then redeploy jev-shadow

`067_cluster_topics.sql` is Pack C ("Konu", B4) and the FIRST migration that lets a Jev answer become something a reader sees directly: a topic label (`clusters.topic7`) that drives six new hub pages (`/konu/dunya`, `/konu/ekonomi`, `/konu/spor`, `/konu/yasam`, `/konu/teknoloji`, `/konu/genel` -- `/konu/politika` 308s to `/`, which already is the politics feed). It adds one new question to the existing per-article `jev-shadow` call (`topic7`, the 7-label feed taxonomy) and one pure-SQL, zero-gateway-call aggregation function, `public.cluster_topics_refresh(interval)`, scheduled on its own `pg_cron` job. Reader-facing gates are deliberately stricter than the shadow suite applies to itself: a member only counts as evidence at `>= 0.800` choice probability; a multi-member cluster needs `>= 2` confident members with `>= 60%` agreeing; a single-member cluster needs its one member at `>= 0.900`; anything else writes `topic7 = null`, rewritten on every pass -- a label never outlives its evidence. **Provenance of the 0.800 gate:** the 2026-09-20 limits test scored 90.3% at this gate for this exact question text asked TITLE-ONLY as one of SIX packed questions; this pack sends title+description as one of SEVEN questions alongside the existing 3-way `topic` question, and T8 measured a 10.0% answer-flip rate for title+description on topic while T7 caps the safe pack at six questions -- so the drift of the shipped configuration has NOT been measured. 0.800 is a confidence gate, not an accuracy claim.

**ORDER IS LOAD-BEARING**, same discipline as every migration above: apply the migration **before** redeploying `jev-shadow` — the redeployed function starts writing `task = 'topic7'` rows, which are harmless with or without the migration, but the cron job has nothing to aggregate if the migration lands second.

1. **Apply the migration:**

   ```bash
   psql "$DATABASE_URL" -f supabase/migrations/067_cluster_topics.sql
   # ...or: supabase db push
   ```

   `067`'s `create index if not exists clusters_topic7_updated_idx` runs inside this file's `begin;`/`commit;` wrapper, so it cannot be `CONCURRENTLY` and holds a `SHARE` lock on `public.clusters` for the whole build -- blocking `INSERT`/`UPDATE` from `cluster-consumer` and `cluster_link_atomic` for that duration. The index is partial and starts empty, but the build still scans the full table. Apply this migration during a quiet ingestion window.

   **Pre-flight, before the cron is enabled on production**: confirm nothing else already stamps `clusters.updated_at` on UPDATE. `cluster_topics_refresh()` deliberately never writes `updated_at` (that column is the `/api/health` liveness signal and the home feed's freshness input, per migration 027's `cluster_link_atomic`), but if a trigger already exists that stamps it independently, every labelled cluster would look permanently fresh -- `/api/health` would report a healthy pipeline while ingestion was actually dead. Check this **before** trusting the schedule:

   ```sql
   select tgname from pg_trigger where tgrelid = 'public.clusters'::regclass and not tgisinternal;
   ```

   If this returns any `BEFORE UPDATE` trigger that touches `updated_at`, **stop** -- do not let `cluster-topics-refresh` run until that trigger is accounted for (either it explicitly excludes this function's UPDATE, or it is removed). Migration 027 stamping `updated_at` explicitly inside `cluster_link_atomic` is strong evidence no such trigger exists, but this has not been verified against the live database.

2. **Deploy order: jev-shadow, then Vercel.**

   ```bash
   supabase functions deploy jev-shadow --project-ref "$PROJECT_REF" --no-verify-jwt
   vercel --prod
   ```

   `jev-shadow` first because the new `topic7` question is additive to an existing call -- nothing reads those rows until `cluster_topics_refresh()` (already scheduled by step 1) picks them up on its next tick. Vercel last so `/konu` and `/konu/<slug>` exist only once `clusters.topic7` is a real, populated column.

3. **Verification SQL**, run after one `jev-shadow` tick (<= 10 minutes) and then after the first `cluster-topics-refresh` tick (<= 13 minutes, since it runs 3 minutes behind the shadow poke):

   ```sql
   select count(*) from public.jev_shadow_predictions where task = 'topic7';
   -- expect non-zero once jev-shadow has run at least once post-deploy

   select public.cluster_topics_refresh();
   -- returns the number of cluster rows changed by a manual pass

   select topic7, count(*), round(avg(topic7_p), 3)
     from public.clusters where topic7 is not null
    group by topic7 order by 2 desc;
   -- sanity-check: politika should dominate (Tayf's feed is politics-heavy),
   -- dunya/ekonomi/spor should be non-trivial

   select jobname, schedule, active from cron.job where jobname = 'cluster-topics-refresh';
   -- expect '3-59/10 * * * *', active = true
   ```

   If `jev_shadow_predictions` shows rows for `task = 'topic7'` but the `probabilities` map is absent from `jev_answer->'answer'->'probabilities'`, the `>= 0.800` confidence gate can never pass and every hub will stay empty -- stop and investigate the gateway response shape before assuming the aggregation is broken.

4. **Backfill, off-peak, once the cron is confirmed healthy** (step 3's last query returns a healthy schedule):

   ```sql
   select public.cluster_topics_refresh(interval '7 days');
   ```

   This is the single heaviest pass the function will ever make. **It does NOT populate the hubs with the week already in the database on day one** -- it only labels clusters whose members were scored by `jev-shadow` AFTER this redeploy. The article-fetch stage's anti-join is keyed on a single task (`await anti_join("politics", ...)`, `supabase/functions/jev-shadow/index.ts`), and `jev_shadow_predictions` carries `unique (task, subject_id)` with `ON CONFLICT DO NOTHING` (migration 061), so every article scored before this deploy is permanently "seen" for that anti-join and is never re-fetched -- it will never receive a `task = 'topic7'` row. The hubs instead fill in gradually over the following ~24-48h as new articles are ingested and scored post-deploy. Time this pass anyway (if it exceeds ~30s, run it in two narrower windows instead of one 7-day sweep), but do not expect it to backfill history.

   **`topic7_n = 0` across the board on day one is therefore EXPECTED and is NOT the missing-probabilities signature** described elsewhere in this pack's risk notes -- cross-reference step 3's probabilities check (the `jev_answer->'answer'->'probabilities'` shape check) to tell the two apart: if `topic7_n` stays at 0 after 48h *and* step 3's probabilities check is failing, that is the missing-probabilities-map problem; if `topic7_n` stays at 0 right after the backfill but step 3's check passes, that is this expected day-one gap, not a bug.

   A true historical backfill would need a one-off re-ask path (delete-and-rescore the affected `jev_shadow_predictions` rows, or a `topic7`-keyed anti-join instead of the shared `politics`-keyed one) -- out of scope for this pack.

5. **Kill switch and label wipe**, in increasing severity, neither requires a migration or a rollback:

   ```sql
   -- 1. Stop new labels; existing labels keep rendering until they age out
   --    of the window or a member's evidence expires naturally.
   update cron.job set active = false where jobname = 'cluster-topics-refresh';
   ```

   ```sql
   -- 2. Empty every hub within one cacheLife window without touching a
   --    single URL -- /konu/<slug> renders its honest empty-state copy.
   update public.clusters set topic7 = null, topic7_p = null, topic7_n = 0
    where topic7 is not null;
   ```

   The `topic7`/`topic7_p`/`topic7_n` columns and `cluster_topics_refresh` itself are additive and can stay in place indefinitely with the cron off -- no follow-up migration is needed to "undo" 067.

6. **Cost.** One extra question on the existing per-article `jev-shadow` call, roughly +325 input tokens per article (measured post-deploy: 1265 avg input tokens/prediction vs 941 pre-deploy), about 58M tokens/month at ~6,000 articles/day against the `JEV_MONTHLY_TOKEN_CAP_DEFAULT` of `5e8` (migration 063) -- ~12% of the cap, still comfortable headroom, and worth re-measuring once several days of ticks have accumulated. No new secret, no new environment variable: `AI_GATEWAY_API_KEY` is already present (shared by every Jev-calling function since migration 061), and `cluster_topics_refresh()` makes zero gateway calls of its own.

