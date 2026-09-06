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

pg_cron + pg_net live in Supabase but are NOT installed by the portable migrations (they're project-scoped extensions whose grants differ between Supabase Free and Pro). Schedule them once via the Supabase Dashboard → SQL Editor:

```sql
-- Run in Supabase Dashboard → SQL Editor.
-- Both extensions are pre-installed on Supabase Pro; on Free, enable
-- them under Database → Extensions first.

-- Stash the service-role key in a database-level setting so the cron
-- payload can reference it without baking the literal into pg_cron's
-- jobname (which is logged in cron.job_run_details, readable to any DB
-- role with usage on cron). The setting itself lives in
-- pg_db_role_setting, readable only by superuser / the bootstrap role.
alter database postgres set app.service_role_key = '<paste service-role key here>';

-- Drain cluster_work every minute. current_setting(..., true) returns
-- NULL instead of raising when the setting is unset, so the cron job's
-- HTTP request goes out with an empty bearer (handler responds 401) and
-- the failure mode is visible in Edge Function logs rather than as a
-- SQL exception buried in cron.job_run_details.
SELECT cron.schedule(
  'cluster-drain',
  '* * * * *',
  $$ SELECT net.http_post(
       url := 'https://<PROJECT_REF>.functions.supabase.co/cluster-consumer',
       headers := jsonb_build_object(
         'Authorization',
         'Bearer ' || coalesce(current_setting('app.service_role_key', true), '')
       )
     ) $$
);

-- Drain image_backfill every five minutes (lower priority, larger pages).
SELECT cron.schedule(
  'image-drain',
  '*/5 * * * *',
  $$ SELECT net.http_post(
       url := 'https://<PROJECT_REF>.functions.supabase.co/image-consumer',
       headers := jsonb_build_object(
         'Authorization',
         'Bearer ' || coalesce(current_setting('app.service_role_key', true), '')
       )
     ) $$
);

-- Drive the ingest Edge Function every 3 minutes. This is the canonical
-- ingest entry point now that the legacy Vercel /api/cron/ingest route
-- has been retired — there is no other scheduled invoker, so missing
-- this schedule means RSS articles stop flowing.
SELECT cron.schedule(
  'ingest-drain',
  '*/3 * * * *',
  $$ SELECT net.http_post(
       url := 'https://<PROJECT_REF>.functions.supabase.co/ingest',
       headers := jsonb_build_object(
         'Authorization',
         'Bearer ' || coalesce(current_setting('app.service_role_key', true), '')
       )
     ) $$
);
```

Substitute `<PROJECT_REF>` literally before running — the SQL editor does not expand shell variables.

**Verification:**

```sql
-- All three rows should appear; `active = true`.
select jobname, schedule, active from cron.job
  where jobname in ('cluster-drain', 'image-drain', 'ingest-drain');

-- After ~3 minutes, this should show recent runs with `status = 'succeeded'`.
select jobname, status, return_message, start_time
  from cron.job_run_details
  where jobname in ('cluster-drain', 'image-drain', 'ingest-drain')
  order by start_time desc limit 10;
```

If you ever need to remove a schedule (for example to re-create it with a different URL):

```sql
SELECT cron.unschedule('cluster-drain');
SELECT cron.unschedule('image-drain');
SELECT cron.unschedule('ingest-drain');
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

   - `status = 'failed'` with `return_message` showing an HTTP 401 → bearer header was empty or wrong. Re-run `alter database postgres set app.service_role_key = '<key>';` against the **same** database the cron jobs target.
   - `status = 'failed'` with `return_message = 'unrecognized configuration parameter "app.service_role_key"'` → you did NOT use `current_setting('app.service_role_key', true)` (the `missing_ok` argument). Re-run the `cron.schedule` block with the snippet exactly as written above.
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

1. Pause the pg_cron jobs (don't delete them — pausing is reversible):

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

## Owner sign-off checklist

Before declaring the migration complete:

- [ ] `supabase functions deploy cluster-consumer` / `ingest` / `image-consumer` all returned success
- [ ] Migrations 024, 025, 026 applied; verification SQL above returned the expected rows (including `worker_metrics`)
- [ ] `cron.job` shows `cluster-drain`, `image-drain`, and `ingest-drain` with `active = true`
- [ ] `cron.job_run_details` shows recent runs with `status = 'succeeded'`
- [ ] `CRON_SECRET` and `ANTHROPIC_API_KEY` env vars are set on Vercel production
- [ ] `vercel --prod` deploy landed with the new `/api/cron/headline` schedule and no legacy cron entries
- [ ] `/api/health` reports `clustering.lag_minutes < 15`
- [ ] No `node scripts/*-worker.mjs` processes running anywhere
- [ ] At least one cluster created in the last 15 minutes (`select count(*) from clusters where created_at > now() - interval '15 minutes'`)
- [ ] At least one image backfilled in the last 15 minutes (`select count(*) from articles where image_url is not null and updated_at > now() - interval '15 minutes'`)
- [ ] Migration 034 applied, `cluster-consumer` redeployed, and both `select public.recompute_bias_distribution(now() - interval '48 hours');` / `select public.recompute_blindspot_flags();` return 0 on a second call
- [ ] `select kind, count(*) from sources group by kind order by kind;` shows non-zero `aggregator`, `wire`, and `niche` counts alongside `outlet`
