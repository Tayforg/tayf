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

## A migration that adds an RPC the app calls: APPLY, VERIFY THE GRANT, THEN DEPLOY

Whenever a migration creates a function that application code calls (`supabase.rpc("...")`), the order is fixed:

1. **Apply the migration** before the app deploy that first calls the function (the ordering invariant above, applied to RPCs).
2. **Verify the grant, read-only,** before that deploy reaches Production. For migration 141's `neutral_title_repick_candidates`:

   ```sql
   select has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute');
   ```

   It must be `true`. The same check with `'anon'` in place of `'service_role'` must be `false` (and `'authenticated'` too): the function is `SECURITY DEFINER` and executable by `service_role` only. Use the function's real signature, with the argument types in the parentheses.
3. **Then** let the Vercel deploy go to Production.

Why this is a rule and not a courtesy: on 2026-11-01 23:15-23:55 UTC `/api/cron/headline` got `42501 permission denied for function neutral_title_repick_candidates` from its first call to the migration 141 function on 9 ticks in a row (the grants read correctly afterwards: `service_role` true, `anon` false). The route logs that and answers 200 on purpose, so all 9 ticks were recorded as 200 and `ops_health_report()` stayed green. Since then a swallowed sub-step failure is recorded as 599 and row 15 warns on the first bad tick and fails on the third (the fourth when the window holds 7 runs; a 30 minute window of a 5 minute cron holds 6 or 7 runs, and the row needs at least 2 failures that are at least half of them; see `docs/ops-heartbeat.md`, "599 = 200 with a failed sub-step"), but that is a net, not a substitute for the order above.

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
-- cron.job_run_details has no jobname column (join cron.job on jobid), and a
-- drain stays 'succeeded' once its HTTP request is queued: the HTTP outcome
-- is in net._http_response (Troubleshooting, "clustering stale").
select j.jobname, d.status, d.return_message, d.start_time
  from cron.job_run_details d join cron.job j using (jobid)
  where j.jobname in ('cluster-drain', 'image-drain', 'ingest-drain', 'prune-nightly')
    and d.runid > (select max(runid) - 20000 from cron.job_run_details)
  order by d.runid desc limit 10;
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
   select j.jobname, d.status, d.return_message, d.start_time
     from cron.job_run_details d join cron.job j using (jobid)
     where j.jobname in ('cluster-drain')
       and d.runid > (select max(runid) - 20000 from cron.job_run_details)
     order by d.runid desc limit 5;
   ```

   This only proves that pg_cron ran the command. `cluster-drain` calls the Edge Function with `net.http_post`, which returns as soon as the request is queued, so the run stays `status = 'succeeded'` whatever the function answers: a 401, a 404 and a 500 all look healthy here. `status = 'failed'` appears only when the SQL itself errors inside Postgres. Read the HTTP outcome from `net._http_response`:

   ```sql
   select created, status_code, timed_out, error_msg, left(content, 200) as body
     from net._http_response
     where created > now() - interval '30 minutes'
       and (status_code >= 400 or timed_out or error_msg is not null)
     order by created desc limit 50;
   ```

   Match the `created` minute against the schedule of the job you are chasing (`cluster-drain` `* * * * *`, `ingest-drain` `*/3 * * * *`, `image-drain` `*/5 * * * *`, `kap-drain` `*/2 * * * *`):

   - `status_code = 401` → the `service_role_key` Vault secret is empty or wrong. Update it (`select vault.update_secret(id, '<key>') from vault.secrets where name = 'service_role_key'`) and re-apply 038.
   - `status_code = 404` → the `functions_base_url` Vault secret is wrong; it must end in `/functions/v1`.
   - `status_code >= 500` (including `546`, the platform killing the function at its resource limit) → the function failed. Check Edge Function logs in the Supabase Dashboard.

   The heartbeat row `edge_http_errors_30m` counts these same rows, so read `left(content, 200)` before chasing a consumer. Since hunt 30 a KAP-only outage (5xx, timeout, network error or an unusable body) no longer shows up here: `kap-ingest` answers 200 with `"upstream_unavailable":true` and the row ignores it (redeploy `kap-ingest` with `--no-verify-jwt` for this to take effect). A `kap-ingest` 502 now means a Tayf-side failure, a mixed cycle (some days KAP's fault, some ours) or a circuit-breaker trip (403/429). The outage itself is visible in `kap_fetch_state.last_status` / `last_error` (`last_status` 0 means KAP gave no usable answer) and in `net._http_response` rows whose content contains `"upstream_unavailable":true`; see `docs/ops-heartbeat.md` row 2. History: on 2026-11-02 all 15 error rows of one 30 minute window were `kap-ingest` 502 during a KAP outage, before the 200 answer existed.

2. Is `cluster_work` accumulating without being drained?

   ```sql
   select queue_length, oldest_msg_age_sec from pgmq.metrics('cluster_work');
   ```

   If `queue_length` is growing but `cluster-drain` is `succeeded`, the consumer is processing too slowly — bump the cron frequency to every 30 seconds (`*/30 * * * * *` requires pg_cron 1.6+; on older versions, schedule two jobs offset by 30 s).

### `image_backfill` queue is stuck

The most common cause is SSRF blocks consuming the visibility timeout without making progress. Check:

```sql
-- The messages most often read first (read-only: a plain select of the queue table).
select msg_id, read_ct, enqueued_at, vt
  from pgmq.q_image_backfill
  order by read_ct desc, enqueued_at limit 10;

-- What the consumer finished with in the last 24 hours, by number of reads.
select read_ct, count(*) as archived_24h
  from pgmq.a_image_backfill
  where archived_at > now() - interval '24 hours'
  group by read_ct order by read_ct;
```

A message is archived (never deleted) once `read_ct > 3`, so its payload stays in `pgmq.a_image_backfill`. A live message with `read_ct` 3 has used its last attempt (the next read archives it); one that stays in `pgmq.q_image_backfill` with a higher `read_ct` across several drain ticks means the consumer is not archiving it, which is a bug in image-consumer. Never call `pgmq.read` from the SQL editor: it hides the messages for the visibility timeout and bumps `read_ct`, and a healthy message read three times by hand is archived as poison on its next real read.

The same check for `cluster_work` (the consumer archives it at `read_ct > 3` too):

```sql
select msg_id, read_ct, enqueued_at, vt
  from pgmq.q_cluster_work
  order by read_ct desc, enqueued_at limit 10;

select read_ct, count(*) as archived_24h
  from pgmq.a_cluster_work
  where archived_at > now() - interval '24 hours'
  group by read_ct order by read_ct;
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

## Running the live migration tests

Most files in `tests/migrations/` have a static tier (reads the SQL, always runs) and some also a live tier: a `describe.runIf(Boolean(process.env.TAYF_PSQL))` block that runs the migration and its fixtures on a real Postgres. Without a database that tier skips and `npm test` stays database-free. `tests/migrations/sql/run-live.sh` builds the databases and runs the live tier for real:

```bash
PATH="$HOME/.local/share/node-24/bin:$PATH" bash tests/migrations/sql/run-live.sh
```

It takes about half a minute and needs only a local PostgreSQL 15 (Homebrew `postgresql@15` is found by default). It does two things:

1. **Phase A.** Every `tests/migrations/sql/*-dryrun.sql` runs on its own fresh database (stub loaded first) and must exit 0 and print its `DRYRUN ... OK` line.
2. **Phase B.** Every `run` line of `tests/migrations/sql/live-manifest.txt` gets a fresh database: `tests/migrations/sql/stub.sql`, then the entry's setup files, then vitest on that one test file with `TAYF_PSQL` and `PGDATABASE` set. Each live block expects its own database state (`140 applied`, `122 and 136 applied`, "the state the dry-run leaves behind"), which is why no database is shared.

It ends with a table (file, env, passed, failed, skipped), the totals and every `pending` entry with its reason, and exits 1 on a setup error, a failed test, a file with no passing test, or more skipped tests than the entry allows.

The server is a private, throwaway PostgreSQL on a unix socket (no TCP port, so concurrent runs never collide) that is stopped and deleted on exit. The stub (`tests/migrations/sql/stub.sql`) is tracked in the repo, holds no secrets, and ends with a deliberately pessimistic Supabase-like prelude (`service_role` with `BYPASSRLS`, permissive default privileges), so every migration's revokes are really exercised.

| Knob | Effect |
| --- | --- |
| `PGBIN` | Directory with `initdb`, `pg_ctl`, `psql`. Default: Homebrew `postgresql@15`, else the directory of `initdb` on `PATH`. |
| `TAYF_PSQL` | The `psql` binary the tests use. Default: `$PGBIN/psql` (or `psql` on `PATH` in external mode). |
| `TAYF_LIVE_ONLY` | Run only the dry-run scripts and manifest entries whose file name contains this text, e.g. `TAYF_LIVE_ONLY=140`. |
| `TAYF_LIVE_KEEP` | `1`: keep the data directory, the socket directory and the logs for inspection (the server is still stopped). |
| `TAYF_PG_EXTERNAL` | `1`: do not start a server; use the caller's `PGHOST`, `PGPORT`, `PGUSER` (the CI service container). |

### The manifest

`tests/migrations/sql/live-manifest.txt` has one entry per test file that has a live block (`#` starts a comment, fields are separated by ` | `):

- `run | <test file> | <setup files, or -> | <TAYF_* KEY=VAL env, or -> | <allowed skips>`: the file gets a fresh database, the stub, the setup files in order (raw migrations, or a dry-run script that leaves the state behind), and runs. Allowed skips is normally `0`, so a live test that quietly skips fails the run.
- `pending | <test file> | <reason>`: a live suite that cannot run in the harness yet. The reason (at least 20 characters) is the first real error seen or what it needs. Pending entries are listed at the end of every run so they stay visible. Today: `128` (the stub's foreign keys lack `ON DELETE CASCADE`, which that block expects) and the three suites that need a full local Supabase stack (`SUPABASE_LOCAL_URL`: `024-028`, `058`, `081`).

### Adding a live test

1. In the test file call `assertLiveReady("<NNN>", { ledger: [...], relations: [...], functions: [...] })` as the FIRST statement inside the `describe.runIf(Boolean(process.env.TAYF_PSQL))` body (import it from `tests/_helpers/live-db.ts`). It first refuses a database that is, or looks like, production (see below), then checks that the stub and the named ledger versions, relations and function signatures exist, and THROWS from `beforeAll` otherwise, so a wrongly built database fails the file instead of failing in the middle with a confusing SQL error. Pass `{}` when the block applies its own migration.
2. Add a `run` line to the manifest (or a `pending` line with the reason).

`tests/migrations/live-harness.test.ts` runs in plain `npm test` and enforces both: every test file that mentions the live gates must be in the manifest, every manifest file and setup file must exist, and every live describe must start with `assertLiveReady(`. It also keeps machine-local paths out of `tests/migrations`.

### Never point it at production

Three independent layers, because the live blocks apply migrations twice outside any transaction and write fixtures, and production has every ledger row, relation and function a block looks for:

1. **The runner vets where it connects.** `run-live.sh` creates and drops databases (`tayf_live_*`). In the default mode it only talks to its own private server. With `TAYF_PG_EXTERNAL=1` it REFUSES to run unless `PGHOST` is `localhost`, `127.0.0.1`, `::1` or an absolute socket directory (and `PGHOSTADDR` / `PGSERVICE` are unset). It also vets the manifest before it starts anything: the env field of a `run` line may set only `TAYF_*` test knobs (today `TAYF_SHAPE`). `PGHOST`, `PGHOSTADDR`, `PGSERVICE`, `PGPORT`, `PGOPTIONS`, `NODE_OPTIONS`, and the runner's own `TAYF_PSQL`, `TAYF_PG_EXTERNAL` and `TAYF_LIVE_*` are refused with exit 2, because those pairs would reach vitest after the host check. `live-harness.test.ts` enforces the same rule on the manifest in plain `npm test`.
2. **Every live block vets the database it is connected to.** `assertLiveReady` (first statement of each live `describe`) asks the database itself, before looking for any object, and THROWS (the file fails, it never skips) when `inet_server_addr()` is not null (unix socket), loopback or a private-network address, or when a schema only a Supabase project has (`auth`, `storage`, `supabase_functions`) exists. This also catches what the `PGHOST` check cannot: ambient `PG*` variables or `~/.pgpass` in the shell that runs `npx vitest run tests/migrations`, and an SSH tunnel to a Supabase project on localhost. Private ranges are allowed on purpose: a published Docker port reaches the CI service container on its own `172.x` address, never on `127.0.0.1`. The schema check is the one that identifies a Supabase project; the address check is a second line. The database name is not checked: production is called `postgres`, and the dry-run headers use `postgres` and other names on local servers.
3. **The stub refuses too.** `tests/migrations/sql/stub.sql` starts with `\set ON_ERROR_STOP on` and a guard that raises before anything is created or altered when `public.sources` already exists (it loads only into a fresh database), when `auth`, `storage`, `supabase_functions` or `cron` exists, or when the server address is not local or private. Without it, a mistaken `psql -f tests/migrations/sql/stub.sql` against a Supabase project would exit 0, skip the `create table`s that fail, and still run the closing `alter default privileges ... grant all ... to anon, authenticated, service_role`, silently undoing migration 117's default revoke for every future table. `tests/migrations/stub-guard.test.ts` proves it on scratch databases (it is a manifest entry like any other live file).

Do not work around any of these: nothing here applies a migration to a Supabase project, and the stub is not a copy of production. Never give the stub, the dry-run scripts or `TAYF_PSQL` a remote connection string.

### CI

The `live-db` job in `.github/workflows/ci.yml` runs the same script against a `postgres:15` service container (`TAYF_PG_EXTERNAL=1`, `PGHOST=localhost`, trust authentication on a container that exists only for the job). It installs with `npm ci --ignore-scripts` and holds no repository credential, so a live block that breaks shows up as a red check, not as `skipped`.

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
-- HISTORICAL: run once at the 032 rollout. Do not re-run after the 132 / h63
-- legacy repair: it would flag the 153 never-recall-checked clusters (132 step 5)
-- and rewrite ~21 sides.
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
   -- HISTORICAL: run once at the 032/034 rollout. Do not re-run this pair after
   -- the 132 / h63 legacy repair: the flag pass would flag the 153
   -- never-recall-checked clusters (132 step 5) and rewrite ~21 sides.
   select public.recompute_bias_distribution(now() - interval '48 hours');
   select public.recompute_blindspot_flags();
   -- Expect: 0 the second time you run this pair. If either returns
   -- non-zero on the first call here, that's expected — it's catching the
   -- old consumer's writes from the step 1 → step 2 window. Re-run once
   -- more and confirm both settle at 0.
   ```

Clusters last touched more than 48h before you run step 3 keep their pre-034 (all-sources) `bias_distribution`, which is why 215 of them still wear a public "Kör nokta" flag that fails the rule (measured 2026-11-08). The one-shot rebuild this paragraph used to offer (`recompute_bias_distribution('1970-01-01')` followed by `recompute_blindspot_flags()`) is **superseded: do not run it on production.** Neither call has an upper bound, and `recompute_blindspot_flags()` scans every cluster (265,023 rows) in one statement (through PostgREST it hits the 8 s limit; in psql as postgres there is no statement timeout, so it runs to completion). Finishing is the danger, not the limit: the flag pass would also newly flag 153 old clusters that were never recall-checked (071, 126), so it is not offered at all after the h63 repair. The chunked, dry-run-first repair is the subsection "Legacy bias_distribution repair (h63)" at the end of this section.

`supabase/seed_sources.sql` now carries a `kind` column for every seeded row, so a fresh environment (`supabase db reset`, or a new project seeded from scratch) gets the correct source kinds without needing this migration's slug-keyed UPDATE at all — the seed file is the source of truth for new installs, 034's VALUES list is the backfill for the existing production database.

### Legacy bias_distribution repair (h63)

**Why.** 034 re-derived `clusters.bias_distribution` for the last 48 hours only, so older clusters still store the all-member distribution (aggregator and niche votes included), and 032 derived the public "Kör nokta" flag from it. Measured read-only on 2026-11-08: of 1,164 flagged clusters (`is_blindspot`, not archived, `article_count >= 2`), **215 fail the rule** of at least 5 voting articles with one zone holding at least 0.8 of them (209 have fewer than 5 voting articles, 6 have a top-zone share below 0.8). The newest of them was last updated on 2026-09-04 13:55Z, so the set is bounded and legacy. Among clusters first published from 2026-08-01 up to (not including) 2026-08-15, 689 of 1,258 store a total that differs from their outlet and wire member count. Example: `/cluster/861b4249-f553-41b7-be98-45544008b1bc` stores `{center 4, gov_leaning 1}`, but its only `gov_leaning` member is the aggregator `haberler-com`, which the page itself says is listed but not counted ("toplayıcı / niş kaynaklar kümelerde listelenir ama yanlılık dağılımına sayılmaz"); the four voting members are all `center`. Two October clusters lost a late vote the same way (`e0c1324a-c47e-4952-beed-c37f858a15e3` stores `opposition_leaning 3` for 4 voters; `52823177-3a62-4b56-8312-18cd3f07b53e` stores 3 votes for 4 voters); their `updated_at` is after 2026-09-05, so the live-range chunks below repair them too.

**No new migration, no deploy.** The tools already exist and are applied in production: migration 132 (section "132" below) ships `recompute_bias_distribution_range`, `clear_false_blindspots_range` and `legacy_bias_voter_dists` (windows of at most 31 days, dry run by default, one operator at a time, a re-check that skips a cluster the live consumer re-stamped during the call), and `scripts/recompute-legacy-bias.mjs` drives them. This subsection is the order in which to run them and the read-only counts that prove the result. The tools never write `updated_at` and never set a flag: they only withdraw flags that fail the rule.

**Who runs it, and when.** This is a founder-run production write. The worker, CI and the agents never run it (`--apply` is the only write, and nothing in the repository passes it). Run it off-peak, in chunks of at most 31 days, oldest first, with a read-only count before and after.

1. **Count before (read-only).** Paste into psql or the SQL editor. It takes about 7 s, close to the 8 s limit; if it stops with `57014`, run it in psql inside `begin read only; set local statement_timeout = '60s'; ...; commit;`. Expect today `flagged 1164, failing 215` (`flagged` moves as new flags are set, `failing` can only fall):

   ```sql
   with b as (select id, updated_at from clusters where is_blindspot and not is_archived and article_count>=2), v as (select b.id, s.bias from b join cluster_articles ca on ca.cluster_id=b.id join articles a on a.id=ca.article_id join sources s on s.id=a.source_id where s.kind in ('outlet','wire')), z as (select id, case when bias in ('pro_government','gov_leaning','state_media','islamist_conservative','nationalist') then 'i' when bias in ('center','international','pro_kurdish') then 'b' else 'm' end zone, count(*) n from v group by 1,2), t as (select b.id, coalesce(sum(z.n),0) total, coalesce(max(z.n),0) top from b left join z on z.id=b.id group by 1) select count(*) flagged, count(*) filter (where total<5 or top::numeric/nullif(total,0)<0.8) failing from t;
   ```

   Then the per-window mismatch count, stored total against the outlet and wire member count. It is windowed on `first_published`, never on `updated_at`: an `updated_at` window over this many clusters hits `57014`. Two weeks take about 5 s; shrink the window if it times out. Expect `visible 1258, mismatching 689` for this window:

   ```sql
   with c as (
     select id, (select coalesce(sum(e.value::int), 0) from jsonb_each_text(bias_distribution) e) stored
       from clusters
      where not is_archived and article_count >= 2
        and first_published >= '2026-08-01' and first_published < '2026-08-15'),
   v as (
     select c.id, count(*) filter (where s.kind in ('outlet', 'wire')) voting
       from c
       join cluster_articles ca on ca.cluster_id = c.id
       join articles a on a.id = ca.article_id
       join sources s on s.id = a.source_id
      group by 1)
   select count(*) visible, count(*) filter (where c.stored <> coalesce(v.voting, 0)) mismatching
     from c left join v on v.id = c.id;
   ```

   Last, the tool's own dry run (132 step 1, `p_dry_run` true, writes nothing): `node scripts/recompute-legacy-bias.mjs --from 2026-04-01 --to 2026-09-05` prints `would_change` and `would_clear` per window and a `TOTAL` line whose `would_clear` is 215 (it can only fall).

   Then the live range: `node scripts/recompute-legacy-bias.mjs --from 2026-09-05 --to <tomorrow, YYYY-MM-DD>` (expect would_change about 2, the October pair e0c1324a / 52823177, and would_clear 0). It also warms the pages before the apply.

2. **Snapshot** the rows that will change, per month, with the read-only `\copy` of 132 step 2, plus the live range the apply below also covers: `2026-09-05..2026-10-05`, `2026-10-05..2026-11-05` and `2026-11-05..<tomorrow>` (31 days at most each; change the dates and the file name in the 132 `\copy`). Do this before the first `--apply`: the CSVs are the only undo, and the October pair (e0c1324a, 52823177) is only in the live windows.

3. **Apply**, oldest first, each chunk at most 31 days (the script walks 7-day windows inside a chunk; the SQL clamps a call to 31 days either way). The 183 stray rows older than 2026-04-01 are not part of this repair (22 would change, none would clear; see 132). Stop at the first non-zero exit: the script prints the command that resumes it, every window is idempotent, and `55P03` means another 132 call holds the lock (wait a minute and rerun). The last command runs up to tomorrow's date (`YYYY-MM-DD`); if more than 31 days have passed since 2026-11-05, split it:

   ```bash
   node scripts/recompute-legacy-bias.mjs --from 2026-04-01 --to 2026-05-01 --apply
   node scripts/recompute-legacy-bias.mjs --from 2026-05-01 --to 2026-06-01 --apply
   node scripts/recompute-legacy-bias.mjs --from 2026-06-01 --to 2026-07-01 --apply
   node scripts/recompute-legacy-bias.mjs --from 2026-07-01 --to 2026-08-01 --apply
   node scripts/recompute-legacy-bias.mjs --from 2026-08-01 --to 2026-09-01 --apply
   node scripts/recompute-legacy-bias.mjs --from 2026-09-01 --to 2026-09-05 --apply
   node scripts/recompute-legacy-bias.mjs --from 2026-09-05 --to 2026-10-05 --apply
   node scripts/recompute-legacy-bias.mjs --from 2026-10-05 --to 2026-11-05 --apply
   node scripts/recompute-legacy-bias.mjs --from 2026-11-05 --to <tomorrow> --apply
   ```

4. **Count after (read-only).** Re-run the three counts of step 1. `failing 0` is the pass condition; `mismatching` is 0 for the window above (a cluster the live consumer touched in between is recomputed by the consumer under the same rule, so it stays 0); every `would_change` and `would_clear` of the dry run is 0 (`would_newly_flag` stays 153, see below). Then the spot checks:

   ```sql
   select is_blindspot, blindspot_side, bias_distribution from public.clusters where id = '861b4249-f553-41b7-be98-45544008b1bc';  -- expect f, null, center 4 and every other key 0
   select id, bias_distribution from public.clusters where id in ('e0c1324a-c47e-4952-beed-c37f858a15e3', '52823177-3a62-4b56-8312-18cd3f07b53e');  -- e0c1324a: opposition 1 and opposition_leaning 3; 52823177: center 2, gov_leaning 1, opposition_leaning 1
   ```

   Once the page cache refreshes (the tools revalidate nothing; pages follow their normal `cacheLife`), `/cluster/861b4249-f553-41b7-be98-45544008b1bc` shows no "Kör nokta" ribbon, Merkez %100 and "Spektrum 4 sınıflandırılmış kaynaktan oluşturuldu · 1 toplayıcı / niş kaynak sayılmadı", and `e0c1324a` shows a Muhalefet tally of 4. The detail page already shows that recount once the read-path change is deployed (it counts voting members itself), so the page check proves the deploy and the SQL spot checks above prove the data repair.

**Expected effect.** About 9.3k bars change (the 9,368 clusters with `article_count >= 2` among the roughly 66k stored distributions that differ, 132 header); about 215 "Kör nokta" pills drop; closed `/hafta` weeks for April to September shift slightly. The repair never sets a flag, so the 153 old clusters that would newly pass the rule stay unflagged: they were never recall-checked by 071 and 126, and flagging one is a founder decision (132 step 5). The repair changes stored data only and no UI copy.

**Not part of this repair.** 12 same-source duplicate clusters from 15 to 21 October (for example `1998389c` with yeni-safak twice, `3e33e11e` with aydinlik twice, `5955ca0e` with haberport twice) keep a double vote, because voting counts per article. That is a data decision, not part of this change.

**Rollback.** There is no function to roll back (nothing here adds one). The data is restored from the CSV snapshots of step 2, per file and only for clusters nobody re-stamped since: see the 132 rollback.

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
5. **Confirmation mail received.** A "Tayf bültenine kaydınızı onaylayın" email arrives in the inbox used above within a few seconds.
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
select j.jobname, d.status, d.return_message, d.start_time
  from cron.job_run_details d join cron.job j using (jobid)
  where j.jobname in ('jev-signals-nightly')
    and d.runid > (select max(runid) - 20000 from cron.job_run_details)
  order by d.runid desc limit 5;
```

**POST-DEPLOY WATCH.** Also check that the alert count does not explode on day one:

```sql
select count(*) from public.jev_alerts where acknowledged_at is null;
```

Treat the first weeks of this count as threshold-calibration data, not ground truth: the `drift_score >= 3` / `>= 0.250` cut points and the KAP canary's 10% / `n >= 10` gate are unvalidated first guesses. A synthetic 118-source / 283k-prediction uniform-random run flagged roughly 3-6% of sources per night on pure noise alone (an upper bound -- real sources are autocorrelated, so expect less in practice). A steady nightly floor at that rate means the thresholds need tuning, not that the feeds broke.

**RETRACTION IS NOT AUTOMATIC.** `jev_source_drift_compute` can only ever rewrite or add a row for a day that still qualifies (`politics_n >= 20` and `base_n >= 60`); it never deletes a row for a day that stopped qualifying -- the `upserted` CTE only inserts/updates. `source_drift_daily` also has no delete grant (`select`/`insert`/`update` only), so a stale `flagged = true` row keeps rendering in /admin's "Kaynak sapması" table for the rest of its 7-day window even after an operator confirms it was a false positive, and simply re-running `jev_source_drift_compute()` for that day returns `(0, 0)` with no change. There is no service_role delete path today -- retracting a known-bad row requires a follow-up migration; until one lands, treat it as "acknowledge and wait for it to age out of the 7-day window", not as something an operator can clear by hand.

### Migration 066 — Metodoloji regresyonu (frozen regression set)

`066_jev_regression.sql` adds a frozen regression set that is replayed on a fixed cadence against the CURRENT question set: three new `service_role`-only tables (`jev_regression_items`, `jev_regression_runs`, `jev_regression_answers`), an idempotent `SECURITY DEFINER` top-up function `jev_regression_freeze(p_articles=400, p_pairs=100)`, an on-demand `jev_regression_trigger()` that pokes `jev-shadow` the same way the 061/063 cron do-blocks do, and the `jev-regression-weekly` cron (`20 4 * * 0`, body `{"mode":"regression"}`). `jev-shadow/index.ts` gains a third mode, `"regression"`, that asks the SAME existing questions (no new question string, no `JEV_QUESTION_SET_VERSION` bump) and writes answers to `jev_regression_answers`, never `jev_shadow_predictions`. Regression tokens still land in `jev_shadow_runs` (note `'regression'`), so `jev_shadow_month_usage()` counts them against the same monthly cap every other run spends from.

**ORDER IS LOAD-BEARING**: apply the migration **before** deploying the function or redeploying Vercel, and freeze the set **before** the first cron Sunday.

1. **Vault precondition (038), unchanged.** Same check as 061/063/065 step 1 — if either secret is missing, 066's do-block silently skips the weekly cron (the tables and functions still land) and `jev_regression_trigger()` returns `null` forever:

   ```sql
   select name from vault.decrypted_secrets where name in ('service_role_key', 'functions_base_url');
   ```

2. **Apply the migration:**

   ```bash
   psql "$DATABASE_URL" -f supabase/migrations/066_jev_regression.sql
   # ...or: supabase db push
   ```

   The file inserts its own ledger row (`('066', '066_jev_regression')`) and is safe to re-apply.

3. **Deploy the function.** `--no-verify-jwt` is not optional here, same as every other Edge Function in this repo:

   ```bash
   supabase functions deploy jev-shadow --project-ref "$PROJECT_REF" --no-verify-jwt
   ```

4. **Redeploy Vercel** so the `/admin` "Metodoloji regresyonu" section renders. No new environment variable is needed — it reads the new tables with the existing `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`:

   ```bash
   vercel --prod
   ```

5. **FREEZE DELIBERATELY, by hand, BEFORE pressing "Seti dondur".** The set size IS the run cost — one gateway call per article item (`buildArticleCall` asks all seven article questions in a single call, but there is no batching across articles). Three production regression runs (126 calls each — `jev_shadow_runs` ids 196/197/200, all `status='ok'`) completed in ~5.6s wall at `JEV_CONCURRENCY=8`, about 0.36s/call (~22 calls/s). Extrapolating, the SQL defaults (400 articles + 100 pairs, ~410 calls) take roughly 18-20s against `JEV_DEADLINE_MS=50_000` and the cron's 60s `timeout_milliseconds` — comfortably inside both, though this is an extrapolation from a 126-call sample and per-call latency would have to roughly triple before a full-size set started truncating. Because the baseline query only accepts `status='ok'`, a run that does close `'partial'` never produces a baseline and `deltas` stays `{first_run:true}` forever. Freeze a deliberately smaller set first if you want a faster initial baseline:

   ```sql
   select * from public.jev_regression_freeze(120, 60);
   -- ~126 calls, comfortably inside the 50s deadline; closes 'ok'
   ```

   The `/admin` button's RPC call carries no arguments, so it always tops up to the SQL defaults (400/100), which are now believed to fit comfortably inside the deadline (see step 5's timing above). The top-up is additive — there is no shrink path from `/admin` (no delete route, and the table has no service_role DELETE path in code) — so an operator who wants a small set should freeze by hand first, before ever pressing "Seti dondur". (Since migration 104 froze all 660 gold articles, pressing it also tops the pairs up from 60 to 100 and so changes the set; read "104" below before pressing it.)

   Re-running the freeze is also how a previously-random article gets upgraded: if an article was frozen by step 5b (`in_gold=false`) and has since entered `jev_gold_set` via the 063 labelling flow, the next `jev_regression_freeze()` call flips it to `in_gold=true` in place (no new row, no quota spent) so it becomes visible to the gold comparison.

6. **Verify, in order:**

   ```sql
   select jobname, schedule, active from cron.job where jobname = 'jev-regression-weekly';
   -- expect 20 4 * * 0, active = true
   ```

   ```sql
   select kind, count(*), count(*) filter (where in_gold) as gold from public.jev_regression_items group by kind;
   ```

7. **Smoke the path once, by hand, before the cron's first Sunday:**

   ```bash
   curl -sS -X POST -H "Authorization: Bearer $SR" -H 'Content-Type: application/json' \
     -d '{"mode":"regression"}' "https://$PROJECT_REF.functions.supabase.co/jev-shadow"
   # expect non-zero regression_articles/regression_pairs stage counts, zero everywhere else, and a `regression` key in the response
   ```

   Read the first run:

   ```sql
   select id, question_set, status, items, calls, input_tokens, deltas->'overall', deltas->'gold'
   from public.jev_regression_runs order by id desc limit 3;
   -- the first run's deltas is {"first_run": true, "gold": {...}} -- there is nothing to compare against yet.
   -- the SECOND run is the first one that can show a flip.
   ```

   Confirm the spend landed in the shared ledger:

   ```sql
   select id, status, note, calls, input_tokens from public.jev_shadow_runs order by id desc limit 3;
   -- the regression run's row must be here, note starting 'regression'
   select * from public.jev_shadow_month_usage();
   ```

   Note on `deltas.overall.flip_rate`: only boolean/choice tasks (`politics`, `topic`, `topic7`, `opinion`, `clickbait`, `framing`, `pair_negative`) contribute a flip and count toward `flip_rate`. `sensational` is a 0-10 SCORE answer, not a `[0,1]` probability, so a 0.5 crossing is meaningless for it; `computeRegressionDeltas` excludes it from `flips`/`flip_rate` and tracks its drift only via `mean_abs_delta`/`max_abs_delta`.

8. **CRON COLLISION — known, accepted.** `'20 4 * * 0'` lands on the `jev-shadow` `*/10` grid (minutes `00/10/20/30/40/50`), unlike 063's deliberately off-grid `'55 3 * * *'`. One Sunday morning per week, two `jev-shadow` instances run concurrently. They write to disjoint tables and each opens its own `jev_shadow_runs` row, so there is no corruption and no double-counting — the exposure is gateway rate limiting (which `callOnce` downgrades to `status='rate_limited'`, not a crash) and two simultaneous `monthTokens` reads racing the cap check. Shipped as specified; move the job to `'25 4 * * 0'` if the gateway starts rate-limiting on Sunday mornings:

   ```sql
   select cron.unschedule('jev-regression-weekly');
   select cron.schedule('jev-regression-weekly', '25 4 * * 0', $sql$ ... $sql$); -- copy the do-block body from 066
   ```

9. **KILL SWITCH.** Two independent levers, in escalating order, none requiring a migration or a deploy:

   ```sql
   -- 1. Stop the weekly regression replay only -- the 10-minute shadow run
   -- and the nightly audit (if 063 is applied) keep going.
   update cron.job set active = false where jobname = 'jev-regression-weekly';
   ```

   ```bash
   # 2. Stop all three modes instantly -- checked before any database read,
   # run row, or gateway call.
   supabase secrets set JEV_DISABLED=1 --project-ref "$PROJECT_REF"
   ```

**WARNING — `jev_regression_items` deliberately has NO foreign key to `articles`, so it SURVIVES `nuke_articles`** (unlike `jev_gold_set`/`jev_gold_labels`, which cascade-delete with their articles — see the 063 section's warning above). The regression ITEMS keep existing after a bulk article delete, but `computeRegressionGold`'s `in_gold` half depends on `jev_gold_labels`, so the gold comparison inside `deltas` silently becomes `{n:0}` once the underlying gold labels are gone. The 063 snapshot procedure (`jev_gold_set`/`jev_gold_labels` CSV export) is still the only protection for the gold half of this pack too.

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
- [ ] Migration 034 applied and `cluster-consumer` redeployed (the 034 step 3 recompute pair was a one-time rollout step; do not re-run it after the h63 repair). After the h63 repair, the read-only 132 dry run `node scripts/recompute-legacy-bias.mjs --from 2026-04-01 --to 2026-09-05` shows would_clear 0
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

- [ ] Migration 066 applied (Vault precondition from 038 verified first); `select jobname, schedule, active from cron.job where jobname = 'jev-regression-weekly';` shows `20 4 * * 0`, active
- [ ] The operator has read the first run's `status` and `calls` from `jev_regression_runs` and confirmed the run closed `'ok'` before trusting any later delta
- [ ] Operator knows `jev_regression_items` deliberately has NO foreign key to `articles` and therefore SURVIVES `nuke_articles` (unlike `jev_gold_set`/`jev_gold_labels`), but the gold half of `deltas` still depends on `jev_gold_labels` and goes to `{n:0}` if those rows are gone
- [ ] Migration 068 applied; `select proname, prosecdef from pg_proc where proname in ('framing_vote_totals','framing_next_headline','framing_gold_candidates','cluster_framing_receipt');` returns 4 rows, all `prosecdef = true`
- [ ] `select * from public.framing_vote_totals('00000000-0000-0000-0000-000000000000');` returns one row of zeros, not an error
- [ ] Operator has read the 48h Çerçeve pool size and the `task = 'framing'` scored-probability count (Verification queries (c) and (d) above) before announcing the mode
- [ ] `FRAMING_RECEIPT_PUBLIC` is documented as UNSET by default and is only ever set after the operator has reviewed receipts on `/admin/rapor/<clusterId>` by hand

---

## Docs / See also

- [`key-rotation.md`](key-rotation.md) — rotation runbook for every secret this system uses (Vercel env, GitHub Actions secrets, Supabase Vault, Edge Function secrets).
- [`backup-posture.md`](backup-posture.md) — what Supabase backs up automatically, what isn't backed up at all, the nightly jobs a restore has to be reconciled with, and the quarterly restore-drill procedure.
- [`ops-heartbeat.md`](ops-heartbeat.md) — the `ops_health_report()` (077) thresholds table, GitHub cron caveats, and the kill switch.

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



## 069 — API anahtarları, rapor paylaşım bağlantıları, LLM bütçesi

`069_api_keys_reports_llm_budget.sql` ships three independent, additive-only business-plumbing features in one migration because they landed in the same wave (Pack E: "İş altyapısı"): B7 puts a cost gate + daily USD ledger in front of the dormant LLM branch of `/api/cron/headline`; B9 adds tokened self-serve share links for the per-cluster Yelpaze Raporu; B11 adds a keyed, tiered `/api/v1` public read API. It creates four new tables (`llm_budget_daily`, `report_share_links`, `api_keys`, `api_key_usage_daily`) and five new functions (`llm_budget_add`, `llm_budget_gate`, `headline_llm_eligible`, `report_share_view`, `api_key_touch`), all in the same service_role-only shell as 041/057/059/060/061 — RLS enabled with zero policies, `revoke all ... from anon, authenticated, public`, and every function `SECURITY DEFINER` with `set search_path = ''`.

**NO CRON IS SCHEDULED BY THIS MIGRATION, AND NO VAULT SECRET IS NEEDED.** Nothing in this pack needs a timer: the LLM budget is written by the existing Vercel cron `/api/cron/headline` on its own `*/5 * * * *` schedule, share links expire by `expires_at` comparison at read time (no sweeper job — an expired row is already dead to `report_share_view`), and API usage rows are written by the request path itself. There is no `do-block`, no `cron.schedule` call, and no `vault.decrypted_secrets` read anywhere in this file — apply it exactly like any other additive migration, no Supabase secret dance beforehand.

1. **Apply the migration:**

   ```bash
   psql "$DATABASE_URL" -f supabase/migrations/069_api_keys_reports_llm_budget.sql
   # ...or: supabase db push
   ```

   Verify it landed and every new object exists:

   ```sql
   select * from supabase_migrations.schema_migrations where version = '069';
   select count(*) from public.llm_budget_daily;   -- expect 0 immediately after apply
   select public.headline_llm_eligible(array[]::uuid[]);  -- expect zero rows, no error
   ```

   Prove the two budget RPCs' INSERT paths actually plan on the live server
   (plpgsql bodies are only checked at call time, and the null-day guard
   returns before the INSERT, so a read-only call proves nothing). Run this
   BEFORE `ANTHROPIC_API_KEY` is ever set; the rollback leaves no row behind:

   ```sql
   begin;
   select public.llm_budget_add('1970-01-01'::date, 1, 10, 5, 0.0001);
   select public.llm_budget_gate('1970-01-01'::date, 1, 1);
   select * from public.llm_budget_daily where day = '1970-01-01';
   -- expect one row: calls 1, input_tokens 10, output_tokens 5,
   -- usd 0.0001, eligible_n 1, ineligible_n 1
   rollback;
   ```

2. **No Edge Function redeploy needed.** All five functions and four tables are read/written entirely from the Next.js app (`/api/cron/headline`, the new `/api/admin/rapor/*` and `/api/admin/api-keys*` routes, `/api/v1/*`, `/rapor/[token]`). Deploy the migration, then `vercel --prod` as usual — order matters only in that direction (DB before app), the same discipline as every migration above.

3. **New env var: `HEADLINE_LLM_DAILY_USD_CAP`.** Decimal string, default `"2.00"` (USD per UTC day). Parsed with `Number()`; a NaN, zero, negative, or unset value falls back to the 2.00 default and logs the fallback once. Set it explicitly on Vercel (Production + Preview) so the ceiling is visible in the dashboard next to `ANTHROPIC_API_KEY`, even though omitting it is safe.

   ```bash
   vercel env add HEADLINE_LLM_DAILY_USD_CAP production
   # value: 2.00 (or the founder's chosen ceiling)
   ```

   **There is deliberately no bypass switch for the eligibility gate.** An env var that disables a cost gate is a footgun; if the gate is wrongly refusing spend, the fix is jev-shadow coverage (see the warning below), never loosening or disabling the check.

4. **THE ELIGIBILITY GATE IS FAIL-SAFE AND CAN SILENTLY KEEP THE LLM BRANCH DORMANT — this is by design, read it before setting `ANTHROPIC_API_KEY`.** `headline_llm_eligible()` reads `jev_shadow_predictions` for a candidate cluster's members. That table's politics/clickbait coverage is sparse and opportunistic (`jev-shadow` samples, it does not sweep every article), so a cluster with no scored members comes back ineligible every time. If coverage is thin, EVERY candidate is ineligible and the LLM branch spends nothing even after `ANTHROPIC_API_KEY` is set — the gate can only ever underspend, never overspend, but it will look like "nothing is happening" if you don't check the right number. **/admin's "Başlık LLM bütçesi" section's "Uygun küme: N/M" line is that number.** If it reads `0/N` (or "henüz ölçülmedi"), the gate is correctly refusing to spend on clusters Jev hasn't scored yet — do not "fix" this by loosening the gate or adding a bypass; the fix is more `jev-shadow` coverage.

5. **B7 stays dormant in production on purpose.** `ANTHROPIC_API_KEY` remains unset today, so the whole LLM branch — eligibility check, budget ledger, the vendor call itself — is inert; `/api/cron/headline` keeps running in extractive mode exactly as before, with the two new response counters (`eligible`, `ineligible`, `budgetedOut`) present and zero. Do not set `ANTHROPIC_API_KEY` as part of this deploy. When the founder later wants LLM headlines, set it and watch the "Uygun küme" line for at least an hour before trusting the spend numbers.

**KILL SWITCHES**, one per feature in this pack, none requiring a migration or rollback:

```bash
# 1. Pause the whole /api/cron/headline cron (both LLM and extractive mode).
#    Already documented for migration 046 — repeated here because B7's gate
#    lives inside the same route.
vercel env add HEADLINE_PAUSED production   # value: 1
```

```sql
-- 2. Kill one API consumer (B11) — 403s every subsequent request from that key.
update public.api_keys set revoked_at = now() where id = <n>;
```

```sql
-- 3. Kill one share link (B9) — the token 404s identically to unknown/expired.
update public.report_share_links set revoked_at = now() where token = '<t>';

-- 3b. Kill EVERY share link at once (e.g. a suspected leak).
update public.report_share_links set revoked_at = now() where revoked_at is null;
```

```bash
# 4. Drop the LLM branch back to extractive mode entirely (B7) — no
#    migration change, no redeploy: the very next cron tick picks it up.
vercel env rm ANTHROPIC_API_KEY production
```

## 071 — Kör nokta geri çağırma vetosu (blindspot recall veto): APPLY 071 BEFORE THE VERCEL DEPLOY

> **DEPLOY ORDER IS CRITICAL. Apply migration 071 to production *before* the Vercel deploy of this branch reaches Production.** Every reader-facing cluster query in this branch (`CLUSTER_EMBED_SELECT` in `politics-query.ts`, `cluster-detail-query.ts`, `blindspots-query.ts`, `weekly-query.ts`, `V1_CLUSTER_SELECT` in `v1-clusters.ts`, and the admin suspects list) now selects `clusters.blindspot_recall_veto`. PostgREST answers a `select` naming an unknown column with **HTTP 400**, and those fetchers throw on error — so deploying the app first takes down **home, /konu, search, RSS, /blindspots, /hafta, every /cluster page (and its OG/twitter images and /kart), and /api/v1/clusters** until 071 lands. Put the same warning in the PR body.

What 071 does (additive only):

- Adds `clusters.blindspot_recall_veto boolean not null default false` and `clusters.blindspot_recall_veto_at timestamptz`, plus the partial index `clusters_blindspot_recall_veto_idx`.
- Adds `public.blindspot_recall_veto_refresh(p_since interval default '26 hours', p_min_prob numeric default 0.85)` — SECURITY DEFINER, `search_path = ''`, execute granted to `service_role` only. It adds each distinct voting (outlet/wire) source with a `blindspot_recall` match at `jev_prob >= 0.85` that is not already a member to the cluster's live tally, and sets the veto when the BLINDSPOT contract (≥5 sources, dominant zone ≥0.8) held before and fails after. It **never writes `is_blindspot`, `blindspot_side` or `updated_at`**; read paths treat `is_blindspot AND NOT blindspot_recall_veto` as the public claim (`src/lib/clusters/recall-veto.ts`).
- Schedules pg_cron job `blindspot-recall-veto` at `7-59/10 * * * *` (7 minutes after each `jev-shadow` tick) and runs a one-off 30-day backfill.

Steps:

1. **Apply the migration** (the SQL editor or the one-at-a-time psql pattern from step 1). It records itself as version `'071'` in `supabase_migrations.schema_migrations`.
2. **Verify before deploying:**

   ```sql
   -- column exists (the app's selects depend on it)
   select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'clusters' and column_name like 'blindspot_recall_veto%';
   -- the backfill moved data (~7-8 on 2026-09-28)
   select count(*) from public.clusters
    where is_blindspot and blindspot_recall_veto and updated_at > now() - interval '7 days';
   -- idempotent: a second run changes nothing
   select public.blindspot_recall_veto_refresh();   -- expect 0
   -- the schedule exists
   select jobname, schedule from cron.job where jobname = 'blindspot-recall-veto';
   ```

3. **Then** let the Vercel deploy go to Production. After ~10 minutes, check `cron.job_run_details` for `blindspot-recall-veto` succeeding.

**Kill switch** (no redeploy; readers see every DB-flagged blindspot again on the next cache refresh):

```sql
select cron.unschedule('blindspot-recall-veto');
update public.clusters set blindspot_recall_veto = false, blindspot_recall_veto_at = null
 where blindspot_recall_veto;
```

**Rollback:** do **not** drop the columns while this branch is deployed (the 400 above). Unschedule and clear as in the kill switch; drop the columns only after reverting the app.

## 077 — Ops heartbeat (ops_health_report + GitHub Action): APPLY 077 BEFORE MERGING THE WORKFLOW

> **APPLY 077 TO PRODUCTION BEFORE `.github/workflows/ops-heartbeat.yml` REACHES THE DEFAULT BRANCH.** The workflow calls `public.ops_health_report()` over PostgREST on a `*/30` schedule; if the function doesn't exist yet, every run 404s and `scripts/ops-heartbeat.mjs` exits 2 — a confusing red CI run rather than a real alert, and 48 of them a day until 077 lands.

What 077 does (additive only, read-only):

- Adds `public.ops_health_report()` — a SECURITY DEFINER, `search_path = ''`, `service_role`-only function returning 10 fixed pass/warn/fail/unknown/skip rows (cron failures, Edge Function HTTP error rate, ingest cycle throughput, per-zone ingest freshness ×3, jev-shadow freshness, the 071 blindspot-veto cron, unacked Jev alerts, and dead feeds). It never writes any table and never reads `cron.job.command` or `cron.job_run_details.return_message`.
- Reaches `cron.*` / `net.*` only through `EXECUTE` behind `to_regclass`, so a project without `pg_cron` or `pg_net` still returns 10 rows (status `'unknown'` for the affected checks) instead of raising.

Steps:

1. **Apply the migration** (the SQL editor or the one-at-a-time psql pattern from step 1). It records itself as version `'077'` in `supabase_migrations.schema_migrations`.
2. **Verify before merging the workflow:**

   ```sql
   select * from public.ops_health_report();
   -- expect exactly 10 rows, in the fixed order documented on the function's comment, no exception raised
   ```

3. **Then** let the branch containing `.github/workflows/ops-heartbeat.yml` merge to the default branch (GitHub only runs `schedule:` triggers from there). Trigger once by hand to confirm:

   ```bash
   gh workflow run ops-heartbeat.yml --repo <org>/<repo>
   ```

See [`ops-heartbeat.md`](ops-heartbeat.md) for the full thresholds table (with the Step 0 numbers each was tuned from), the required secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — already set for `cluster-audit.yml`), who receives the failure email, and the kill switch.

**Rollback:** `gh workflow disable ops-heartbeat.yml` stops the poll immediately, no database change needed. The function itself is inert (read-only, called by nothing else) — there is no reason to drop it, but doing so is safe at any time since nothing else references it.

## 081 — Jev günlük özet + ops artığı temizliği (jev-shadow-daily, ops-exhaust-prune)

`081_ops_retention.sql` does two independent things, both non-destructive to product data:

1. **A daily rollup** (`public.jev_shadow_daily`, refreshed by `public.jev_shadow_daily_refresh(p_days)`) of `public.jev_shadow_predictions` — one row per (UTC day, task, question_set). `public.jev_shadow_agreement_rollup(p_days)` reads complete days from the rollup plus a raw tail (today, or since the rollup last ran) and returns the same `(task, total, agreed, undecided)` shape as the existing `jev_shadow_agreement(p_hours)`. `src/lib/admin/jev-shadow-status.ts`'s 7-day call now uses the rollup, with an automatic fallback to the original raw `jev_shadow_agreement({p_hours: 168})` if the rollup RPC errors (e.g. this migration hasn't landed yet). The 24h call is untouched.
2. **Retention of SYSTEM exhaust only** — `public.ops_exhaust_prune(p_cron_keep, p_net_keep, p_batch, p_max_batches)` deletes old rows from `cron.job_run_details` and `net._http_response`. It **never** touches `public.jev_shadow_predictions` or any other product table — enforced by a static SQL-contract test (`tests/migrations/081-ops-retention.test.ts`) that scans the migration file for every `delete from` target and fails the build if anything outside those two system tables appears.

`jev_shadow_predictions` itself is **deliberately left alone** by 081 — still ~413 MB and growing ~50 MB/day (2.2 GB / 1.96 M rows by 2026-10-21). This migration is the prerequisite for a later, separate decision about pruning the raw table; it does not make that decision. **Migration 102 made it:** a nightly, IRREVERSIBLE prune (`jev-shadow-prune`, 04:50 UTC, first possible deletion 2026-11-05) now removes rows older than 45 days, and the rollups below are then the only record of the pruned days. From that point 081 must not be re-applied and its backfill must not be re-run; see "102" below.

### Step 0 numbers (measured 2026-09-28, read-only — see the migration file's own header for the full detail and the savings math)

| Object | Size | Rows | Notes |
|---|---|---|---|
| `public.jev_shadow_predictions` | 413 MB | 401,277 | 2026-09-20 → today, ~53 MB/day growth, untouched by this migration |
| `cron.job_run_details` | 211 MB | 258,310 | back to 2026-06-10; 212,628 rows (82%) already older than the 14-day keep window |
| `net._http_response` | 178 MB | 838 live | all rows <6h old (pg_net TTL already works) — the 178 MB is dead-tuple bloat, `last_autovacuum` 2026-08-05 |
| whole DB | 3,021 MB | — | — |

Expected effect: the first `ops_exhaust_prune()` run makes ~174 MB reusable inside `cron.job_run_details` (file shrinks only after a manual compaction pass); the `net._http_response` 3-day guard removes ~0 rows on this measurement (it's a guard against pg_net TTL regressing, not a fix for today's bloat) — that bloat needs a one-off manual compaction pass instead. `/admin`'s 7-day agreement read moves off a raw scan of the ever-growing predictions table onto the bounded rollup.

### Deploy order

1. **Apply the migration.** It is safe to apply at any time relative to the app deploy — `jev_shadow_agreement_rollup` is additive, and `jev-shadow-status.ts`'s fallback means the admin page works whether or not 081 has landed yet:

   ```bash
   psql "$DATABASE_URL" -f supabase/migrations/081_ops_retention.sql
   # ...or: supabase db push
   ```

   The migration itself runs a one-off backfill (`select public.jev_shadow_daily_refresh(400);`) inside the same transaction, rolling up every complete day since the table's 2026-09-20 start. **That backfill is only safe while nothing has been pruned:** once 102's `jev-shadow-prune` has deleted anything (2026-11-05 04:50 UTC at the earliest), never re-apply 081 and never run `jev_shadow_daily_refresh(400)`, because it upserts every day from the raw table and overwrites the preserved history near the cutoff with smaller, partial numbers. See "102" below for the maximum safe window of each rollup refresh.

2. **If the SQL editor times out on the backfill (first apply only, before any 102 prune; never after it, see "102" below):** this migration is one transaction, so a timeout rolls the *entire* file back, including the table/function creation. Apply the file with the backfill line removed, then run the backfill separately (it can take a lot longer safely outside a single-timeout window):

   ```sql
   -- with "select public.jev_shadow_daily_refresh(400);" deleted from the file:
   \i supabase/migrations/081_ops_retention.sql
   -- then, separately, possibly in smaller chunks if needed:
   select public.jev_shadow_daily_refresh(400);
   ```

3. **Deploy the Vercel branch** whenever convenient — no ordering constraint with this one (unlike 071/064 above): the admin page degrades to the raw 168h RPC automatically if it runs against a database without 081 yet.

### First manual prune

Run this once by hand after applying, to confirm the numbers before trusting the nightly `ops-exhaust-prune` schedule (04:40 UTC):

```sql
select * from public.ops_exhaust_prune();
-- expect cron_deleted close to Step 0's "prunable" count on a fresh DB, net_deleted
-- close to 0 unless net._http_response has accumulated rows older than 3 days.
```

### Manual full-table compaction (optional, one-off)

DELETE makes space reusable inside a table but does not shrink the file on disk — that needs a manual full-table compaction pass (`VACUUM FULL`), which is **not** run automatically because it cannot execute inside a transaction block and takes an ACCESS EXCLUSIVE lock. Run it in the 04:30 UTC lull, ten minutes before `ops-exhaust-prune` fires:

```sql
-- needs table-owner privileges (supabase_admin on this project, per Step 0);
-- if denied, fall back to a plain (non-FULL) VACUUM, or ask Supabase support.
vacuum full net._http_response;
vacuum full cron.job_run_details;
```

### Kill switches

```sql
update cron.job set active = false where jobname in ('jev-shadow-daily', 'ops-exhaust-prune');
```

### Verification

```sql
select min(day), max(day), count(*) from public.jev_shadow_daily;
-- expect min = 2026-09-20, max = yesterday (UTC), no row for today

select public.jev_shadow_daily_refresh(2);
-- idempotent: re-running with the same window changes nothing further

select jobname, schedule from cron.job where jobname in ('jev-shadow-daily', 'ops-exhaust-prune');

select count(*) from cron.job_run_details where start_time < now() - interval '14 days';
-- expect 0 after the first ops-exhaust-prune run

select count(*) from public.jev_shadow_predictions;
-- must never decrease across an ops_exhaust_prune() run
-- (102's jev-shadow-prune is a different job and does shrink it, from 2026-11-05)

-- /admin 7-day rates should be within ~2 points of the pre-081 raw values for
-- tasks with at least 500 comparable rows, and the section should load well
-- under PostgREST's 8s statement_timeout.
```

## 088 — Jev harcama defteri (aşama bütçesi, KAP örneklemesi, soru parmak izleri): APPLY 088 BEFORE DEPLOYING jev-shadow

**Preconditions:** migration 073 must already be applied — 088's leading guard block raises `'088 requires 073 (jev_alerts.resolved_at + jev_alerts_auto_resolve) to be applied first'` and rolls back the whole transaction otherwise. 088 is copied from the lead's validated `083_jev_spend_ledger.sql`, renumbered, with 073's step (c) `drift_quiet` day+1 existence guard restored (the lead's copy had dropped it, which would resolve a `source_drift` alert as `drift_quiet` on a day with no day+1 measurement at all) and a `set local lock_timeout = '5s'` added before the two `ALTER TABLE`s.

**Deploy order (load-bearing):**

1. Apply `073_jev_pipeline_lifecycle.sql` if not already applied.
2. Apply `088_jev_spend_ledger.sql`.
3. Deploy the `jev-shadow` Edge Function (writes `jev_shadow_runs.stage_tokens`, stamps `jev_answer.question_hash`/`.pack`, and samples `kap_class` at 1-in-5 via `kapClassSampled`). **Deploying jev-shadow before 088 is applied makes every `finishRun`/`recordTokens` PostgREST write 400 on the unknown `stage_tokens` column — runs never close and the monthly-cap accounting breaks.**
4. Deploy the Vercel branch (adds the "Aşama bütçesi" table, the `stage_budget` alert kind/label, the `under_allowance` resolved-reason label, the topic7/`Konu (7)` relabel, and the regression section's three new columns). No strict ordering against step 3, but do it in the same window.

The KAP anti-join move (`fetchPendingKap` now anti-joins on `kap_materiality`, not `kap_class`) must ship in the SAME jev-shadow deploy as the sampling change in step 3 — deploying sampling without the anti-join move re-asks every unsampled disclosure on every 10-minute tick.

**Verification SELECTs (read-only, safe to run in production after step 2):**

```sql
select version from supabase_migrations.schema_migrations where version = '088';

select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.jev_alerts'::regclass and contype = 'c';
-- kind CHECK must include 'stage_budget'; resolved_reason CHECK must include 'under_allowance'

select * from public.jev_stage_budgets order by stage;
-- 12 seeded rows, articles 11,000,000 .. live_pair_marginal 150,000

select day, stage, calls, tokens, allowance from public.jev_budget_daily(2) order by 1 desc, 2;

select jobname, schedule from cron.job where jobname = 'jev-budget-nightly';
-- '15 4 * * *', only present if pg_cron is installed
```

**Regression freeze runbook:** the frozen regression set replay (`mode: 'regression'`) can cover all 660 gold-frozen articles in one pass — `JEV_REGRESSION_ITEM_LIMIT` rose 500 → 700 and `JEV_REGRESSION_CONCURRENCY` (32, regression stages only; shadow/audit stay at `JEV_CONCURRENCY`=8) keeps ~660 calls inside `JEV_DEADLINE_MS`. **The freeze itself was never run in production until migration 104:** before 104 a replay covers only 180 items (120 articles + 60 pairs, the manual `jev_regression_freeze(120, 60)`), so `items` = 660 + the frozen pair count (720 with the 60 frozen pairs) is true only after 104 is applied (see "104" below). After 104, trigger one on-demand regression run with the `/admin` "Regresyonu çalıştır" button (or `select public.jev_regression_trigger();`) and confirm it closes `ok` (not `partial`) with that `items` count, and that `deltas.gold` now carries `topic7` and (when the provisional label fetch succeeds) a `provisional.dev` / `provisional.heldout` split. The run button is safe; **do not press "Seti dondur"** while the JEV-B same-set precondition (`docs/jev-pack-slim.md`) is being collected, because it tops the pairs up to 100 and changes the set.

**Rollback:**

```sql
update cron.job set active = false where jobname = 'jev-budget-nightly';
```

Redeploy the previous `jev-shadow` Edge Function version (pre-`stage_tokens`/pre-sampling). The `jev_alerts_auto_resolve()` redefinition from 088 may stay in place — its step (a) only changes behavior for `kap_class_canary` alerts, which is backward-compatible with the pre-088 reader.

See also `docs/jev-politics-admission.md` (migration 089, the ADMIT item) and `docs/topic7-v2.md` (migration 090, the T7a item) for the two migrations that build on top of 088 in this same wave.

## Audit fix A (083-086): deploy order

Seven-part rollout: three DB migrations (083, 084, 085 — 086 lands
separately), two Edge Function redeploys, a mandatory edge rate-limit rule,
and one Vercel deploy. Follow this order; 083 and 086 gate the Vercel
deploy, 084/085 do not.

1. **Apply 083 (reader query RPCs) before the Vercel deploy.** It has an
   optional/required pre-step of
   `create index concurrently if not exists clusters_search_tsv_live_idx ...`
   and `clusters_neutral_eligible_idx ...` (see the 083 migration header for
   the exact statements). Verify with:
   ```sql
   select * from public.headline_neutral_counts();
   ```
2. **Apply 084 off-peak** (see "084: DB housekeeping" below) — it briefly
   takes an ACCESS EXCLUSIVE lock on `public.articles` and does a bounded
   30-day `UPDATE` over it.
3. **Apply 085** (see "085: ticker code gate" below).
4. **Apply 086 (admin login throttle) before the Vercel deploy.** Otherwise
   admin login fails closed with "Çok fazla deneme. Lütfen biraz sonra
   tekrar deneyin." (the same generic message a rate-limited attempt gets —
   the two "not allowed" outcomes are deliberately indistinguishable to the
   caller). The escape hatch is:
   ```sql
   delete from public.admin_login_attempts;
   ```
5. **Redeploy the `ingest` and `cluster-consumer` Edge Functions** with
   `--no-verify-jwt` (per this doc's existing Edge Function convention).
6. **Before or immediately after the Vercel deploy, add a Vercel
   Firewall/Edge Config rate-limit rule on `POST /admin/login`.** This is
   mandatory, not optional: `admin_login_throttle()` (086) does a
   `pg_advisory_xact_lock` + delete-sweep + two `count(*)` selects on every
   call — allowed or blocked — so a request flood distributed across many
   IPs/serverless instances still drives full DB round-trips at whatever
   rate the client can sustain; the in-memory limiter in
   `src/lib/rate-limit.ts` only shields a single instance. An edge-level
   rule (e.g. 20 req/min per IP, or per-ASN if abuse is distributed) keeps
   that flood from ever reaching Postgres, which also serves all public
   reader traffic.
7. **Deploy Vercel.** It now runs in `lhr1` (London) — confirm with:
   ```bash
   curl -sI https://www.tayfhaber.com/api/health
   ```
   and check the response's `x-vercel-id` header shows `::lhr1::`.

## 084: DB housekeeping

**What it changes:** tunes `public.clusters`'s autovacuum thresholds
(scale factors 0.2 -> 0.05/0.02, so autovacuum fires at ~10k dead tuples
instead of ~41k at the table's current ~206k-row size); adds three FK
support indexes (`corrections.cluster_id`, `zone_guesses.article_id`,
`story_stances.source_id`, all currently-empty tables); drops the two
articles indexes confirmed dead by a 30+ day idx_scan=0 window
(`idx_articles_fingerprint`, `idx_articles_body_excerpt_backfill`); nulls
out `image_url` for the last 30 days of video URLs (mp4/m3u8/webm/mov) and
explicitly re-enqueues `image_backfill` for those rows (migration 025's
`articles_image_enqueue` trigger only fires on INSERT, not UPDATE); and
upgrades the rcman 150x84 default thumbnail crop to 1280x720 for the last
30 days (verified 25/25 sampled URLs return `200 image/*` after rewrite —
see the migration's own header for the full Step 0 evidence).

**Lock note:** the two `drop index` statements in 084 (on `public.articles`)
each take a brief ACCESS EXCLUSIVE lock on that table — briefly excluding
both readers and writers. The three `create index` statements (on the
currently-empty `corrections` / `zone_guesses` / `story_stances`) each take
only a SHARE lock — Postgres's documented level for a non-`CONCURRENTLY`
`CREATE INDEX` — which blocks writers but not readers. None of these run
`CONCURRENTLY` (084 runs inside one transaction, and `CREATE INDEX
CONCURRENTLY` cannot run inside a transaction block). `set local
lock_timeout = '5s'` means the whole migration fails fast and can simply be
re-run rather than queuing behind a long-running reader. To avoid any lock
risk on the DROPs (the half that genuinely excludes readers), an operator
can pre-run them outside a transaction before applying 084:
```sql
drop index concurrently if exists public.idx_articles_fingerprint;
drop index concurrently if exists public.idx_articles_body_excerpt_backfill;
```
084's own `drop index if exists` then becomes a no-op.

**Right after applying**, run the manual vacuum by hand once (084 also
schedules this every 6 hours at :35 (`35 */6 * * *`) via pg_cron, guarded — it
no-ops with a `raise notice` if pg_cron isn't installed):
```sql
vacuum (analyze) public.clusters;
```

**Rollback:**
```sql
alter table public.clusters reset (
  autovacuum_vacuum_scale_factor,
  autovacuum_analyze_scale_factor,
  autovacuum_vacuum_insert_scale_factor
);
select cron.unschedule('clusters-vacuum');
-- re-create the dropped indexes from 007/020 if ever needed:
create index if not exists idx_articles_fingerprint on public.articles (fingerprint);
create index if not exists idx_articles_body_excerpt_backfill on public.articles (body_excerpt) where body_excerpt is null;
```

## 085: ticker code gate

**The rule:** a bare ticker CODE match (e.g. "DEVA" appearing as a
stand-alone 4-6 letter uppercase token) is only kept for a stoplisted
ticker (`public.ticker_code_stoplist()`: `DEVA`, `BEYAZ`, `ATLAS`, `KONYA`)
when the article is genuinely finance-context (`category = 'ekonomi'`) or
the ticker already appears parenthesised in the text (e.g. "... Deva
Holding (DEVA) ..."). Non-stoplisted tickers are completely unaffected —
same unconditional code-hit behaviour as migration 062. See the migration's
own header for the full per-ticker evidence (S9/S10) behind the stoplist
and the two disabled aliases (`dinamik`, `goldman`).

**How to extend the stoplist:** ship a new migration (086+) that does
`create or replace function public.ticker_code_stoplist() returns text[] ...`
with the extra ticker(s) appended to the array, plus a `delete from
public.article_tickers` cleanup scoped the same way 085's is (matched_on =
'code', ticker = the new stoplist, category <> 'ekonomi', no "(TICKER)" in
the text). Do not edit 085 in place — migrations are immutable once
applied.

**Verification query** — code rows for the stoplist over 14 days should
all be genuine company news (either ekonomi-category or explicitly
parenthesised):
```sql
select t.ticker, a.category, left(a.title, 120)
  from public.article_tickers t
  join public.articles a on a.id = t.article_id
 where t.matched_on = 'code'
   and t.ticker = any (public.ticker_code_stoplist())
   and t.published_at > now() - interval '14 days'
 order by t.published_at desc;
-- every remaining row should be category = 'ekonomi' or carry "(TICKER)" in
-- the title/description -- anything else means the gate has a gap.
```

### net._http_response bloat: the operator step (corrects the 081 section)

The "Manual full-table compaction" section above (and the analogous advice
elsewhere in this doc) is **wrong for `net._http_response`** specifically:
`VACUUM` (plain or `FULL`) run as `postgres` is silently skipped —
`net._http_response` is owned by `supabase_admin`, not `postgres`, and
Postgres prints `skipping "..." --- only table or database owner can vacuum
it` rather than erroring. The fix is a `TRUNCATE`, not a `VACUUM`:

1. **Check the size and the privilege:**
   ```sql
   select pg_size_pretty(pg_total_relation_size('net._http_response'));
   select has_table_privilege('net._http_response', 'TRUNCATE');
   ```
2. **If `has_table_privilege(...) = true`**, run this in the 04:30 UTC lull
   (ten minutes before `ops-exhaust-prune` fires, per the 081 section
   above):
   ```sql
   truncate table net._http_response;
   ```
   This drops at most ~6 hours of `pg_net` response log (its own TTL keeps
   the table's live row count small — 178 MB of bloat sat behind only ~820
   live rows in the 2026-09-28 measurement). The only reader is
   `ops_health_report`'s 30-minute `edge_http_errors_30m` check, which
   cannot fail on an empty window.
3. **If `has_table_privilege(...) = false`** in some environment, open a
   Supabase support ticket asking for a `VACUUM FULL` on the table, and ask
   why autovacuum skips it — include its `reloptions` (null as of
   2026-09-28) and its `last_autovacuum` (2026-08-05 10:11 UTC as of that
   measurement, ~7 weeks stale).

**Expected effect:** about 170 MB reclaimed at once, and `pg_net`'s TTL
`DELETE` (per the 081 Step 0 numbers, the costliest statement measured:
233k calls, ~42k s total) becomes cheap again against a small table.

**Regrowth:** bloat regrows at roughly 3 MB/day (178 MB accumulated since
the `last_autovacuum` on 2026-08-05); re-check monthly via the size query
above and repeat this step once the table passes ~50 MB again.

**Correction to the `cron.job_run_details` advice** in the "Manual
full-table compaction" section above: the same ownership caveat applies
there in principle (`cron.job_run_details` is also owned by
`supabase_admin`), but 081's `ops_exhaust_prune()` already `DELETE`s the
old rows on a schedule, which makes that space reusable in place without
needing `VACUUM FULL` at all — a `TRUNCATE` is not appropriate there since
recent run history must be kept, unlike `net._http_response`'s pure
response-log rows.

## 093 — Feed registry repoint (dead/moved RSS feeds)

**What it does:** repoints `sources.rss_url` for 9 sources whose old feed was
404, a Cloudflare 403, an HTML page or an empty feed, to replacements verified
on 2026-09-28 (`ajans-haber`, `hurriyet-daily-news`, `mfa-turkey`, `milat`,
`muhalif`, `posta`, `trt-world`, `turkiye-gazetesi`, `yeni-mesaj`). It resets
`fetch_fail_streak`, `fetch_quarantined_until`, `fetch_etag`,
`fetch_last_modified` and `fetch_body_hash` on those rows only, so the new URL
is never sent the old feed's validators. Every changed row is first written to
`public.sources_rss_backup_093` in the same statement. It never touches
`active`, `bias`, `kind`, `url`, `name` or `slug`, and never deactivates,
deletes or relabels a source. Evidence, and the 25 outlets with no working
feed (founder decision), are in `docs/feed-registry-2026-09.md`.

**Data-only, apply any time:** no app or edge-function dependency and no
deploy ordering. Re-running is a no-op (the match requires the old URL).

**Verify** (expect 9 backup rows; within about 15 min each repointed source
should show status 200/304, streak 0 and new articles):

```sql
select count(*) from public.sources_rss_backup_093;

select s.slug, s.fetch_last_status, s.fetch_fail_streak, max(a.created_at)
  from public.sources s
  join public.sources_rss_backup_093 b on b.id = s.id
  left join public.articles a on a.source_id = s.id and a.created_at > b.backed_up_at
 group by 1, 2, 3;
```

The URLs were verified from a residential network. If a source still fails
from the Supabase datacenter IP, roll that row back (below) and treat it as a
`SOURCE_HEADERS` follow-up.

**Rollback:**

```sql
update public.sources s set rss_url = b.old_rss_url
  from public.sources_rss_backup_093 b
 where b.id = s.id and s.rss_url = b.new_rss_url;
```

## 094 — Silent feeds: redeploy ingest FIRST, then apply 094

**What it does:** resets `fetch_etag`, `fetch_last_modified` and `fetch_body_hash` for six sources whose feeds were answered with a 304 or a body-hash hit while their current items were never stored (`iklim-haber`, `investing-com-tr`, `newslab-turkey`, `platform-24`, `turkiye-haber-ajansi`, `journo`). Old values go to `public.sources_fetch_state_backup_094` in the same statement. It never touches `rss_url`, `active`, `bias`, `kind`, the fail streak or quarantine. Root cause and evidence: `docs/feed-registry-2026-09.md` section 3 ("Root cause (2026-09-29)").

**Deploy order matters:**

1. Deploy the fixed ingest: `supabase functions deploy ingest --no-verify-jwt`. It commits a feed's validators only after all of its rows are durable, and reports `validatorsWithheld` in the cycle JSON and summary line.
2. Apply `094_reset_poisoned_feed_validators.sql`. If applied before step 1, the old code can poison the validators again on the next starved cycle.
3. Redeploy ingest once more (or wait for the warm instances to recycle). A warm instance keeps sending the old ETag from its in-memory cache after the columns were nulled, and would keep getting 304.

**Verify** (expect each source to show `new_articles >= 1` and `validators_back` true within about 15-30 min):

```sql
select s.slug, s.fetch_last_status, s.fetch_etag is not null or s.fetch_body_hash is not null as validators_back,
       count(a.id) filter (where a.created_at > b.backed_up_at) new_articles
  from public.sources s
  join public.sources_fetch_state_backup_094 b on b.id = s.id
  left join public.articles a on a.source_id = s.id
 group by 1, 2, 3;
```

After deploy, watch `validatorsWithheld` in the ingest logs and the 546 share in `net._http_response`: under sustained upsert starvation, withheld feeds are re-parsed every cycle (the price of at-least-once delivery). Rollback of the code is redeploying the previous ingest.

**Rollback** (data):

```sql
update public.sources s
   set fetch_etag = b.old_fetch_etag, fetch_last_modified = b.old_fetch_last_modified, fetch_body_hash = b.old_fetch_body_hash
  from public.sources_fetch_state_backup_094 b
 where b.id = s.id;
```

## 097 — newsroom-alerts webhooks (additive, service_role only)

**What it does:** creates `public.api_key_webhooks` (one signed webhook per API key) and `public.api_key_webhook_deliveries` (the durable queue, unique `(key_id, alert_id)` for idempotency), the `public.api_webhook_claim(int, interval)` claim function (`security definer`, empty `search_path`, `for update of d skip locked`), and the `api-webhook-deliveries-retention` pg_cron job (daily 03:37 UTC, 30 days). Nothing existing is altered. Both tables: RLS on with zero policies, everything revoked from anon/authenticated/public (including the PG17 MAINTAIN guard), grants to service_role only.

**Deploy order:**

1. Apply `097_api_key_webhooks.sql`. Applying it early is harmless: nothing reads the tables until the cron ships.
2. Deploy the app. The new Vercel cron `/api/cron/alerts-webhooks` (`*/10 * * * *`) then runs; with no webhook registered it returns `{"skipped":"no webhooks"}` before any other query.
3. Register a receiver at `/admin/api-webhooks` (the secret is shown once).

Deploying the app BEFORE 097 is also safe for the public feed (`/api/v1/alerts/blindspots` never touches the new tables); the cron would fail its first query with a logged 500 until 097 lands.

**Kill switch:** `ALERT_WEBHOOKS_DISABLED=1` makes the cron a no-op.

**Verify:**

```sql
select relname, relrowsecurity from pg_class where relname in ('api_key_webhooks','api_key_webhook_deliveries');
select has_function_privilege('anon', 'public.api_webhook_claim(int,interval)', 'execute') as anon_exec;  -- expect false
select jobname, schedule from cron.job where jobname = 'api-webhook-deliveries-retention';
```

**Rollback** (data; drops queued deliveries and stored secrets):

```sql
select cron.unschedule('api-webhook-deliveries-retention');
drop function public.api_webhook_claim(int, interval);
drop table public.api_key_webhook_deliveries, public.api_key_webhooks;
delete from supabase_migrations.schema_migrations where version = '097';
```

## 100 — pg_net bloat guard (`net-response-compact`, `net_response_heap_mb`)

**Why:** on 2026-10-21 `net._http_response` (pg_net's response log, owned by `supabase_admin`) sat at 278 MB of heap behind 552 live rows. pg_net's own TTL `DELETE` became the #1 database time consumer (683k s, 310k calls) and evicted the page cache on the Micro instance: pages took 8-22 s and `/rss.xml` returned 500. A hand-run `truncate net._http_response` fixed it at once (pages back to 0.2-0.7 s). 100 automates that, because `DELETE` never shrinks the heap (081's `ops_exhaust_prune` cannot help: every row is under 6 h old) and `VACUUM FULL` cannot run inside the job's function (on PG15 and earlier `postgres` also does not own the table; on prod's PG 17.6 the table's ACL grants `MAINTAIN` to PUBLIC, so a manual `VACUUM FULL` as `postgres` is probably allowed there, untested).

**What it does** (additive, one transaction, safe to re-apply):

1. `public.ops_net_response_compact(p_max_bytes bigint default 64 MiB)` returns `text`: `'ok <size>'` under the threshold, `'truncated <size>'` after truncating, `'skipped: lock'` if pg_net's worker held the table for the whole 20 s `lock_timeout` (the 55P03 is caught, so pg_cron shows success and the next tick retries), and `'skipped: ...'` when pg_net is absent, the role lacks `TRUNCATE`, or a previous run still holds the advisory lock. `service_role` only. The threshold is floored at 1 MiB.
2. pg_cron job `net-response-compact`, every 15 minutes.
3. `public.ops_health_report()` gains an 11th row, `net_response_heap_mb` (total relation size in MiB: pass < 64, warn 64-200, fail > 200). The other ten rows are byte-identical to 077's. A warn or fail means the compactor is being skipped (job disabled, lock never free, privilege lost) while the table bloats again.

**Deploy order:** no ordering constraint with the app. Apply 100 any time; the heartbeat workflow just starts seeing 11 rows (`scripts/lib/ops-heartbeat.mjs` does not enumerate check names).

**Verify:**

```sql
select public.ops_net_response_compact();            -- 'ok <size>' on a healthy table
select jobname, schedule, active from cron.job where jobname = 'net-response-compact';  -- */15 * * * *, active
select check_name, status, observed from public.ops_health_report() where check_name = 'net_response_heap_mb';
select has_function_privilege('anon', 'public.ops_net_response_compact(bigint)', 'execute');  -- expect false
```

pg_cron records only the command tag, so the `truncated` / `skipped: lock` text is visible only when you call the function by hand; a lock-skip also writes a `LOG` line to the Postgres log.

**Trade-off:** each truncate drops at most ~6 h of pg_net response log. Its only reader is `edge_http_errors_30m` (last 30 minutes), which reads an empty window as `pass`, so an error burst right before a truncate can go unseen for one window.

**Kill switch:**

```sql
update cron.job set active = false where jobname = 'net-response-compact';
```

Re-applying 100 re-schedules the job and therefore re-enables it.

**Rollback:** `select cron.unschedule('net-response-compact'); drop function public.ops_net_response_compact(bigint);`, then re-apply `077_ops_health_report.sql` to restore the 10-row report and remove the ledger row for version 100.

This supersedes the manual `truncate` step in "net._http_response bloat: the operator step" above: that step still works for a one-off, but the job now does it.

## 101 — DB hot paths (`cluster_topics_refresh` join, two partial indexes, `cron-log-compact`): PRE-BUILD THE INDEXES BEFORE APPLYING 101

**Why:** the same 2026-10-21 incident as 100. The database runs on a Micro instance (`shared_buffers` 256 MB against a 5.2 GB database), so every cron statement that reads cold pages evicts the page cache the site depends on. 101 trims the statements that read more than they must and caps the one pg_cron log table that grows without bound between the daily prunes.

**What it does** (additive, one transaction, safe to re-apply; it starts with `set local lock_timeout = '5s'` and `set local statement_timeout = '60s'`; needs 061, 064 and 067 already applied):

1. `public.cluster_topics_refresh(interval)` is 067's function with one join changed: the topic7 predictions are probed through the unique `(task, subject_id)` key (`p.task = 'topic7' and p.subject_id = ca.article_id::text`) instead of the wide `article_id` index. It selects the same rows (0 exceptions over all 253,806 topic7 rows) with about 39% fewer cold page reads. The 067 cron job is not touched.
2. `clusters_blindspot_checked_idx`, a partial index on `public.clusters (blindspot_recall_checked_at desc) where is_blindspot`, so `blindspot_recall_veto_refresh()` (071) can BitmapOr it with 064's `clusters_blindspot_recall_idx` instead of filtering 941 blindspots to find 36.
3. `jev_shadow_predictions_live_marginal_idx`, a partial covering index for the `live` CTEs of `jev_shadow_month_usage` and `jev_budget_daily` (088).
4. Autovacuum `reloptions` on `public.jev_shadow_predictions` (`autovacuum_vacuum_scale_factor = 0.02`, `autovacuum_vacuum_insert_scale_factor = 0.02`, `autovacuum_analyze_scale_factor = 0.01`; the 0.2 defaults waited for ~390k tuples). 102's prune relies on these and does not set them.
5. `public.ops_cron_log_compact(p_max_bytes bigint default 150 MiB, p_keep interval default 1 day)` and the pg_cron job `cron-log-compact` (hourly, minute 35). Above the cap it copies the rows younger than `p_keep` aside, `TRUNCATE`s `cron.job_run_details` and puts them back (081's `DELETE` prune cannot shrink the heap), so cron history older than `p_keep` is gone after a compaction. It returns `ok <size>`, `compacted <size>, kept <n>` or `skipped: no pg_cron | no truncate privilege | no insert privilege | busy | lock` (the `lock` skip swallows the 55P03 so pg_cron shows success and the next tick retries). The cap is floored at 16 MiB and `p_keep` is clamped to 1 hour .. 3 days. `service_role` only.

**Deploy order (load-bearing): pre-build both indexes, then apply.**

1. **Pre-build the two indexes.** Run each statement on its own, outside any transaction block (`CREATE INDEX CONCURRENTLY` cannot run inside one; use `psql` in autocommit). Inserts into `jev_shadow_predictions` and `clusters` keep flowing while they build, and 101's own `create index if not exists` then does nothing:

   ```sql
   create index concurrently if not exists jev_shadow_predictions_live_marginal_idx on public.jev_shadow_predictions (created_at) include (input_tokens) where task = 'pair_marginal' and run_id is null;
   create index concurrently if not exists clusters_blindspot_checked_idx on public.clusters (blindspot_recall_checked_at desc) where is_blindspot;
   ```

   Do NOT build a third index on `public.clusters (updated_at desc) where is_blindspot`: it already exists as `clusters_blindspot_recall_idx` (064) and a copy would double the write cost for nothing.

2. **Check that no build was left invalid.** A failed or cancelled `CONCURRENTLY` build leaves an INVALID index behind, and `create index if not exists` skips it silently. Expect 0 rows:

   ```sql
   select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname in ('jev_shadow_predictions_live_marginal_idx', 'clusters_blindspot_checked_idx') and not i.indisvalid;
   ```

   If a name comes back, run `drop index concurrently <name>;` and rebuild it. 101 re-checks `indisvalid` itself and aborts with that instruction.

3. **Apply `101_db_hot_paths.sql`.** If a pre-build was skipped, 101 builds the missing index inside its own transaction, which takes a SHARE lock that blocks writes to the table. The 60 s `statement_timeout` then aborts the whole migration with **57014** (`query_canceled`) on a table too big to index in that time, and nothing is recorded in the ledger: build the index concurrently (step 1) and re-apply. A `55P03` (the 5 s `lock_timeout`) only means a table was busy; re-apply.

There is no ordering constraint with the app deploy.

**Verify:**

```sql
select c.relname, i.indisvalid from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname in ('jev_shadow_predictions_live_marginal_idx', 'clusters_blindspot_checked_idx');  -- 2 rows, both true
select reloptions from pg_catalog.pg_class where oid = 'public.jev_shadow_predictions'::regclass;  -- the three autovacuum settings
select jobname, schedule, active from cron.job where jobname = 'cron-log-compact';  -- 35 * * * *, active
select public.ops_cron_log_compact();  -- 'ok <size>' while cron.job_run_details is under 150 MiB; it compacts for real above that
select has_function_privilege('anon', 'public.ops_cron_log_compact(bigint,interval)', 'execute');  -- expect false
```

Do not call `ops_cron_log_compact(0)` to "test" it: the cap is floored at 16 MiB, so on a table larger than that (79 MB when measured) it truncates the log down to the last day.

**Kill switch:**

```sql
update cron.job set active = false where jobname = 'cron-log-compact';
-- or: select cron.unschedule('cron-log-compact');
```

Re-applying 101 re-schedules the job and therefore re-enables it.

**Rollback:** re-apply 067's `create or replace function public.cluster_topics_refresh`; `drop index concurrently if exists clusters_blindspot_checked_idx;`; `drop index concurrently if exists jev_shadow_predictions_live_marginal_idx;`; `alter table public.jev_shadow_predictions reset (autovacuum_vacuum_scale_factor, autovacuum_vacuum_insert_scale_factor, autovacuum_analyze_scale_factor);`; `select cron.unschedule('cron-log-compact'); drop function public.ops_cron_log_compact(bigint, interval);`; then `delete from supabase_migrations.schema_migrations where version = '101';`.

## 102 — `jev_shadow_predictions` retention (`jev_shadow_prune`, `jev-shadow-prune`): THE DELETE IS IRREVERSIBLE

**Why:** `public.jev_shadow_predictions` reached 2.2 GB / 1,962,216 rows (about 78 MB and 68k rows per day) with nothing ever deleting from it (2026-10-21 incident, finding 4).

**What it does** (additive, one transaction, safe to re-apply):

1. `jev_politics_admissions_prediction_idx`, a partial index on `jev_politics_admissions (politics_prediction_id)`: the FK column of 089's `ON DELETE SET NULL`, so a deleted prediction does not seq scan the admissions table.
2. `public.jev_shadow_prune(p_keep interval default '45 days', p_batch int default 20000, p_max_batches int default 20)`, `SECURITY DEFINER`, `service_role` only, returning `(deleted, batches, cutoff, note)`. The keep window is floored at 21 days (no argument, not null, zero or negative, can go below it) and the batch size and count are clamped (1000..50000 and 1..200). At most `p_batch x p_max_batches` rows (400k by default) go per run, in ONE transaction.
3. The pg_cron job `jev-shadow-prune`, daily at 04:50 UTC.

**The delete is IRREVERSIBLE.** There is no soft delete, no archive table and no undo: a pruned row is gone and only the rollups keep its aggregate. The first row is from 2026-09-20 15:30 UTC, so at the default 45-day keep nothing qualifies before about 2026-11-04 and **the first nightly run that can delete anything is 2026-11-05 04:50 UTC**. Until then the job returns `ok: nothing older than cutoff`. Take a `pg_dump` of the table (or rely on the Supabase point-in-time backup) before you tighten the keep window below its default.

**Never deleted** (all inside the delete's own predicate): rows with a `jev_shadow_reviews` row (that FK is `ON DELETE CASCADE`, so a naive delete would destroy the founder's verdicts); rows referenced by `jev_politics_admissions`; rows of a `jev_gold_set` article; rows whose `subject_id` is a frozen `jev_regression_items.subject_id`; every row of the tasks `pair_marginal`, `blindspot_recall`, `ticker_relevance`, `kap_class`, `kap_materiality` and `pair_positive` (reader- or spend-facing); rows of a cluster that is still live (`clusters.updated_at >= cutoff`); and rows whose UTC day and task are not yet in `jev_shadow_daily`. The function returns `skipped: rollup behind` instead of deleting when the 081 rollup lags, and `skipped: busy` when another run holds its advisory lock.

**Deploy order:**

1. Apply `102_jev_shadow_retention.sql` (needs 089 for the index; the prune reads 061, 063, 066 and 081 objects at run time). Applying it early is harmless: the job is a no-op until 2026-11-05.
2. **Before 2026-11-05, back-fill the yardstick rollup.** `jev_topic7_yardstick_daily` stopped at 2026-10-16 although topic7 predictions exist for 10-17 onwards, because its nightly job (`jev-topic7-yardsticks`, 00:25 UTC) failed with a statement timeout on 2026-10-20 and 2026-10-21:

   ```sql
   select public.jev_topic7_yardstick_refresh(10);
   ```

3. **Check that all four rollups are current** before the first prune. Only `jev_shadow_daily` is enforced in SQL (the `skipped: rollup behind` guard and the per-(day, task) exemption); the other three are an operator check:

   ```sql
   select 'jev_shadow_daily' t, max(day) from public.jev_shadow_daily
   union all select 'source_clickbait_daily', max(day) from public.source_clickbait_daily
   union all select 'jev_topic7_yardstick_daily', max(day) from public.jev_topic7_yardstick_daily
   union all select 'source_drift_daily', max(day) from public.source_drift_daily;
   ```

**Dry run (read-only).** Before tightening the keep window, count per task what a prune with that cutoff would remove. It carries the same predicates as the delete (a test pins the header copy to the delete's text); change the interval in the first line (21 days or more):

```sql
with k as (select pg_catalog.now() - interval '30 days' as cutoff)
select p.task, count(*) as would_delete
  from public.jev_shadow_predictions p, k
 where p.created_at < k.cutoff
   and p.task not in ('pair_marginal', 'blindspot_recall', 'ticker_relevance', 'kap_class', 'kap_materiality', 'pair_positive')
   and not exists (select 1 from public.jev_shadow_reviews r where r.prediction_id = p.id)
   and not exists (select 1 from public.jev_politics_admissions a where a.politics_prediction_id = p.id)
   and not exists (select 1 from public.jev_gold_set g where g.article_id = p.article_id)
   and not exists (select 1 from public.jev_gold_set g where g.article_id::text = p.subject_id)
   and not exists (select 1 from public.jev_regression_items i where i.subject_id = p.subject_id)
   and not exists (select 1 from public.cluster_articles ca join public.clusters c on c.id = ca.cluster_id where ca.article_id = p.article_id and c.updated_at >= k.cutoff)
   and not exists (select 1 from public.clusters c where c.id = p.cluster_id and c.updated_at >= k.cutoff)
   and exists (select 1 from public.jev_shadow_daily d where d.day = (p.created_at at time zone 'utc')::date and d.task = p.task)
 group by 1
 order by 2 desc;
```

**Tightening the window** (21-30 days instead of 45): reschedule with an argument. Tightening to 21 days as of 2026-10-21 would delete up to about 596k rows, over at least two nights.

```sql
select cron.unschedule('jev-shadow-prune');
select cron.schedule('jev-shadow-prune', '50 4 * * *',
  $$ set statement_timeout = '10min'; select * from public.jev_shadow_prune(interval '30 days'); $$);
```

Re-applying 102 reschedules the job with the default command, so it also reverts a tightened window to 45 days.

**AFTER THE FIRST PRUNE: never re-apply 081, and never run a rollup refresh wider than the keep window.** 081's last statement is the one-off backfill `select public.jev_shadow_daily_refresh(400);`, which upserts every complete day from the raw table. After a prune the days near the cutoff are partial, so it overwrites the preserved history with smaller numbers. The same applies to every rollup refresh. With `keep_days` = the `p_keep` in days (45 by default, never below 21) and `today_utc` = the current UTC date, the maximum safe argument is:

| Function | Safe argument | At the 45-day default / 21-day floor |
|---|---|---|
| `public.jev_shadow_daily_refresh(p_days)` | `p_days <= keep_days - 1` | 44 / 20 (nightly job: 2) |
| `public.source_clickbait_rollup(p_from, p_to)` | `p_from >= today_utc - (keep_days - 1)` | its own 40-day span clamp is safe only while `keep_days >= 41` (nightly: yesterday..today) |
| `public.jev_topic7_yardstick_refresh(p_days)` | `p_days <= keep_days - 1` | 44 (its own clamp is 31) / 20 (nightly: 2) |
| `public.jev_source_drift_compute(p_day)` | `p_day >= today_utc - (keep_days - 15)` | the last 30 days / the last 6 days (nightly: yesterday) |

Also: `archive-export` exports the previous UTC day nightly. A manual backfill (`POST {"day": ...}`) older than the keep window would export that day without its labels, so do not backfill past the keep window.

**Verify:**

```sql
select jobname, schedule, active from cron.job where jobname = 'jev-shadow-prune';  -- 50 4 * * *, active
select has_function_privilege('anon', 'public.jev_shadow_prune(interval,integer,integer)', 'execute');  -- expect false
select count(*) from public.jev_shadow_predictions where created_at < pg_catalog.now() - interval '45 days';  -- 0 until about 2026-11-04; after the first prune only the exempt rows are left
```

Do not "test" `jev_shadow_prune` by hand: any call whose cutoff has eligible rows really deletes them.

**Kill switch (no deploy):**

```sql
update cron.job set active = false where jobname = 'jev-shadow-prune';
```

Re-applying 102 re-enables it.

**Rollback:** rows already deleted can only come back from a dump or point-in-time restore. To remove the machinery: `select cron.unschedule('jev-shadow-prune'); drop function public.jev_shadow_prune(interval, integer, integer); drop index if exists public.jev_politics_admissions_prediction_idx;` and `delete from supabase_migrations.schema_migrations where version = '102';`.

## 103 — ops heartbeat row 12 (`jev_shadow_cron_failures_30m`): REDEPLOY `jev-shadow` WITH `--no-verify-jwt`

**Why:** when the database timed out inside `jev-shadow`'s first calls, the function answered 500 having written NO `jev_shadow_runs` row, and pg_cron reports `succeeded` for an http-poking job the instant `net.http_post` queues the request. Nothing recorded the failure, and `jev_shadow_last_run_min` only fires after three ticks are already lost.

**What it does** (read-only, additive, safe to re-apply): `create or replace` of `public.ops_health_report()` with 100's eleven checks unchanged and a 12th row, `jev_shadow_cron_failures_30m` (warn >= 1, fail >= 2). Its value is the sum, over the last 30 minutes, of (a) failed pg_cron runs of `jev-shadow`, `jev-cluster-audit` and `jev-regression-weekly`, and (b) `net._http_response` rows with `status_code >= 500` whose body contains the `"fn":"jev-shadow"` marker. No table, no cron job, no data. Same signature and `service_role`-only grants. `scripts/lib/ops-heartbeat.mjs` does not enumerate check names, so the heartbeat workflow simply starts seeing 12 rows. Details: `docs/ops-heartbeat.md`.

**Deploy order:**

1. Apply `103_jev_shadow_stall_check.sql` (after 100: it repeats 100's function body and adds the row last).
2. **Redeploy `jev-shadow`.** The same release makes it retry its first two calls and the closing `finishRun` once, answer a stable 503 `db-unavailable`, and stamp the `"fn":"jev-shadow"` marker into every error body:

   ```bash
   supabase functions deploy jev-shadow --project-ref <ref> --no-verify-jwt
   ```

   Always with `--no-verify-jwt`, like every Edge Function in this guide. Until it is redeployed, the HTTP half of the row has nothing to count: the row reflects cron failures only, and its `detail` says so. Steps 1 and 2 may happen in either order.

**Verify:**

```sql
select count(*) from public.ops_health_report();  -- 12
select check_name, status, observed, threshold, detail from public.ops_health_report() where check_name = 'jev_shadow_cron_failures_30m';  -- pass, observed 0 on a healthy project
select has_function_privilege('anon', 'public.ops_health_report()', 'execute');  -- expect false
```

**Kill switch:** none needed, the function is read-only and nothing calls it except the heartbeat poll (`gh workflow disable ops-heartbeat.yml` stops that).

**Rollback:** re-apply `100_pgnet_bloat_guard.sql` to restore the 11-row report (its cron reschedule is idempotent), then `delete from supabase_migrations.schema_migrations where version = '103';`. The redeployed `jev-shadow` can stay.

## 104 — regression freeze to 660 articles: DO NOT PRESS "Seti dondur" WHILE THE JEV-B PRECONDITION IS COLLECTED

**Why:** 088 shipped the code side (`JEV_REGRESSION_ITEM_LIMIT` = 700, `JEV_REGRESSION_CONCURRENCY` = 32) and seeded the `regression:regression_articles` budget at 1.2M tokens for "660 frozen articles", but the freeze itself was never run. Production still replays 180 items (120 articles + 60 pairs, the manual `jev_regression_freeze(120, 60)`). 104 carries the freeze out.

**What it does** (additive, one transaction, idempotent; `lock_timeout` 5 s, `statement_timeout` 60 s):

1. Takes 066's advisory lock (`hashtext('jev_regression_freeze')`), so it serializes with the "Seti dondur" button. If a freeze is mid-flight it fails fast with `55P03`; re-apply.
2. Inserts every `jev_gold_set` article that has no `jev_regression_items` row yet (`in_gold = true`, state = the `{title, description clamped to 600}` snapshot). On production that is 540 rows: 660 gold articles + the 60 pairs = 720 items.
3. Runs 066's upgrade path: a frozen article that is in `jev_gold_set` but still `in_gold = false` is flipped to true (a no-op on production today).
4. Guards that roll the whole migration back: more than 700 article items (`fetchRegressionItems` orders by id and would cut the newest gold rows out of every replay), or any gold article still without an `in_gold` item.

Pairs stay at 60, nothing is deleted, no grant changes, and existing items are never refreshed except for the `in_gold` flag. Re-applying inserts 0 rows.

**Deploy order:**

1. Apply `104_jev_regression_freeze_660.sql` and run the verification below.
2. `jev-shadow` must be writing `jev_shadow_runs` again before the first replay, which is the **Sunday 2026-10-25 04:20 UTC** `jev-regression-weekly` run (or a manual `select public.jev_regression_trigger();`). The 2026-10-18 run never happened: pg_cron said `succeeded` but `jev-shadow` opened no run row, which is what the 103 row and the `jev-shadow` retry now surface.
3. A replay is about 720 calls and 0.8M tokens, inside the 1.2M allowance.

**Do NOT press "Seti dondur" in `/admin` while the JEV-B precondition is being collected** (two same-set replays, `docs/jev-pack-slim.md`). With no arguments it tops the pairs up from 60 to 100, which changes the set, so the replays are no longer same-set and the count restarts. The "Regresyonu çalıştır" button and `jev_regression_trigger()` are safe. Runs 5 and 6 (2026-10-04 and 2026-10-11) replayed 180 items and do not count.

**Verify** (read-only):

```sql
select kind, count(*) n, count(*) filter (where in_gold) gold from public.jev_regression_items group by kind order by kind;  -- article n = gold = 660 (plus any pre-existing random rows), pair 60
select count(*) from public.jev_gold_set g where not exists (select 1 from public.jev_regression_items i where i.kind='article' and i.subject_id=g.article_id::text and i.in_gold);  -- 0
```

After the first replay: `select id, status, items, started_at from public.jev_regression_runs order by id desc limit 3;` should show `ok` with `items` = 720.

**Kill switch / rollback:** none. It is a one-off data freeze and there is no shrink path from `/admin`. Undoing it would mean deleting the added `jev_regression_items` rows by hand (their `jev_regression_answers` go with them, `ON DELETE CASCADE`) plus the ledger row for version 104, and it changes the replay set again, so do not do that once a replay has run.

## 107 — BİK mahkeme/resmi ilanları ticker dikkatinden çıkar (`legal_notice_articles`, cron `legal-notice-mark`): APPLY 107, BACKFILL, THEN DEPLOY

**Why:** the `/ekonomi` attention totals (`fetchTopTickers`, the per-ticker attention series) are summed in JS over `article_tickers` rows, which carry no title. A BİK notice such as "GARANTİ FAKTORİNG ... İCRA DAİRESİ" string-matches a ticker and inflates its article and source counts. Ingest already drops notices (`supabase/functions/_shared/rss/legal-notice.ts`), but rows stored before that filter, rows that slip past it, and rows ingested by a lagging edge deploy are still counted. The `/ekonomi` feed and the per-ticker list already filter by title; the totals could not. A read-time join on `articles.title` or an ILIKE pre-scan would add reads that cannot fit the 4 s reader cap on a cold Micro database (Step 0 numbers are in the migration header), so 107 keeps a small service-role table of notice article ids and the readers drop those rows before aggregating.

**What it does** (additive, one transaction, idempotent, safe to re-apply):

1. `public.legal_notice_articles(article_id, published_at, marked_at)`: RLS on, every default grant revoked from `anon`/`authenticated`/`public` (plus the PG17-guarded `MAINTAIN` revoke), `SELECT` granted to `service_role`. Rows cascade with their article.
2. `public.is_legal_notice(p_title, p_url)`: the SQL twin of `isLegalNotice()`. The five regexes are the JS `.source` of `LEGAL_NOTICE_PATTERNS`, copied verbatim; `tests/migrations/107-legal-notice-articles.test.ts` fails the build on drift.
3. `public.legal_notice_mark(p_from, p_to)`: marks the notices published in `[p_from, p_to)` idempotently and returns the number of newly marked rows. It raises unless both bounds are given, `p_from < p_to` and the window is at most 2 days.
4. Cron `legal-notice-mark` (`23 */6 * * *`, `statement_timeout` 2 min) re-marks the last 30 hours and the next 3: a backstop for slips and edge-deploy lag.

No backfill runs inside the migration. The readers are FAIL-OPEN (`fetchLegalNoticeIdsSince` warns `[finance] legal-notice lookup unavailable: ...` and counts every row, i.e. the behaviour before 107), so the app may deploy before or after the migration; before it, every uncached `/ekonomi` render logs that warning.

**Deploy order:**

1. Apply `107_legal_notice_articles.sql`. It needs `public.articles` and nothing else; pg_cron missing only skips the schedule with a notice.
2. Run the backfill below, once. Until it has run, the table is empty and the totals are unchanged.
3. Merge/deploy the app. `/ekonomi` caches (`finance-feed`: 60 s revalidate, 10 min expire) pick the change up on their own; no tag purge needed.
4. **No `ingest` redeploy is required.** The `legal-notice.ts` change only exports the rule constants and rewrites one character class without a behaviour change (`deno check` clean). If you redeploy anyway, use `--no-verify-jwt` like every Edge Function in this guide.

**Backfill** (operator, once; idempotent and resumable; one call per 2-day slice, each its own statement so none risks the API timeout; about 25k articles and a couple of seconds a slice on production):

```bash
for i in $(seq 30 -2 0); do
  psql "$DATABASE_URL" -Atc "set statement_timeout = '2min'; select public.legal_notice_mark(date_trunc('day', now()) - interval '$i days', date_trunc('day', now()) - interval '$i days' + interval '2 days');"
done
```

Without psql, run the same `select` in the SQL editor one slice at a time (`$i` = 30, 28, ... 2, 0). 30 days is what the widest reader window uses. Expect roughly 27 new rows per day (about 820 over the 30 days, measured 2026-10-22: 82 notices among 34,319 articles in 3 days); re-running returns 0.

**Verify:**

```sql
select count(*), min(published_at), max(published_at) from public.legal_notice_articles;  -- ~820 over 30 days after the backfill
select jobname, schedule, active from cron.job where jobname = 'legal-notice-mark';  -- '23 */6 * * *', active
select has_table_privilege('anon', 'public.legal_notice_articles', 'select');  -- false
select has_table_privilege('authenticated', 'public.legal_notice_articles', 'select');  -- false
select has_function_privilege('anon', 'public.legal_notice_mark(timestamptz, timestamptz)', 'execute');  -- false
select has_function_privilege('anon', 'public.is_legal_notice(text, text)', 'execute');  -- false
select relacl from pg_class where oid = 'public.legal_notice_articles'::regclass;  -- no anon= / authenticated= entry (service_role keeps Supabase's default grants, like 105's pool table)
select t.title from public.legal_notice_articles l join public.articles t on t.id = l.article_id order by l.published_at desc limit 20;  -- eyeball: all notices, no real news
```

After the deploy, a ticker whose attention was mostly notices (for example a bank named in debtor notices) should drop in the `/ekonomi` ranking within a few minutes.

**Limits to know:**

- PostgREST truncates a response at `max_rows` (1,000), whatever `.limit()` asks (the reader asks for 5,000). The 30-day set is already ~820 rows, so `fetchLegalNoticeIdsSince` continues with `.range()` pages (newest first) whenever a response comes back with exactly 1,000 rows, up to 5,000 ids in total. Past 5,000 ids the oldest notices of the window stop being excluded; raise `LEGAL_NOTICE_LOOKUP_LIMIT` if the volume ever gets there.
- Accepted divergences from the JS predicate: letters outside the Turkish/ASCII sets are not counted (JS counts any `\p{L}`), and `.` / `\s` treat newlines and Unicode spaces differently. Titles are single-line after ingest; NBSP and BOM are trimmed explicitly.
- A notice the rules do not recognise is still counted (this is a filter, not a classifier). Add the shape to `legal-notice.ts` and 107's SQL together (the parity test enforces that), then re-run the backfill.

**Kill switch:** `select cron.unschedule('legal-notice-mark');` stops the backstop. To make the readers count everything again without a deploy, empty the table as the owner: `delete from public.legal_notice_articles;` (the next cron tick or backfill refills it, so unschedule first).

**Rollback:** nothing depends on 107, and the readers fail open. `select cron.unschedule('legal-notice-mark'); drop function public.legal_notice_mark(timestamptz, timestamptz); drop function public.is_legal_notice(text, text); drop table public.legal_notice_articles; delete from supabase_migrations.schema_migrations where version = '107';` Redeploying the previous app build is optional.

## 108 — ops heartbeat v2 + jev-shadow cron (timeout 120 s, enqueued_at): REDEPLOY jev-shadow WITH --no-verify-jwt

**Why:** the 2026-10-22 `jev-shadow` stall read green. pg_net rows 329690 and 329711 had `timed_out = true` and a NULL status (no body, so row 12's 5xx count saw nothing), and the function kept closing zero-call `partial` runs (3622, 3623) that advanced `max(finished_at)`, so `jev_shadow_last_run_min` (row 7 in `docs/ops-heartbeat.md`) passed too. The run rows also carried a NULL `note`, and the 60 s pg_net timeout is shorter than the run's wall time (50 s deadline + startup + queue time). Separately, 41 of the 42 unacked `jev_alerts` were already resolved, so `jev_alerts_unacked_72h` warned for nothing.

**What it does** (one transaction, no new table, safe to re-apply):

1. `create or replace` of `public.ops_health_report()`: 103's body verbatim except three checks. `jev_shadow_last_run_min` reads only runs that closed `ok`/`budget_exceeded` or made a call (`budget_exceeded` counts as fresh, so a deliberate monthly cap does not page); `jev_alerts_unacked_72h` counts only unresolved alerts; `jev_shadow_cron_failures_30m` adds zero-call `partial`/`error` runs of the last 30 minutes and reports `timed_out` pg_net rows in its `detail` (they only raise `pass` to `warn`). Same signature, `service_role`-only grants.
2. Reschedules the `jev-shadow` pg_cron job (`*/10 * * * *`, url and headers as in 061) with `timeout_milliseconds := 120000` and a body `{"enqueued_at": "<UTC ISO-8601, ms precision>"}`. Same guards as 061: if `pg_cron`/`pg_net` or the Vault secrets `service_role_key` / `functions_base_url` are missing it raises a NOTICE and does nothing. It reads only `cron.job.active`, never the command.

**Deploy order:**

1. Apply `108_jev_stall_check_v2.sql` (after 103; it repeats 103's function body). Expect no NOTICE on production; a "skipping jev-shadow reschedule" NOTICE means the cron half did nothing and must be investigated (Vault secrets, see 038).
2. **Redeploy `jev-shadow`:**

   ```bash
   supabase functions deploy jev-shadow --project-ref <ref> --no-verify-jwt
   ```

   Always with `--no-verify-jwt`, like every Edge Function in this guide. The new code (a) derives its deadline from `enqueued_at` (`JEV_POKE_BUDGET_MS` 45 s minus the queue age, floor `JEV_MIN_DEADLINE_MS` 10 s, never above `JEV_DEADLINE_MS` 50 s; a body without `enqueued_at`, such as the audit/regression crons or a manual poke, keeps 50 s), (b) stops the anti-join and the article pager once that deadline passes, and (c) writes `deadline: <stage> at <ms>ms, calls=<n>` into `jev_shadow_runs.note` when a deadline stop closes the run `partial` (a `stage failed: ...` note wins; regression runs keep their `regression; ` prefix). Steps 1 and 2 may happen in either order: the old function ignores `enqueued_at`, and the new one works without it.

**Kill switch preserved:** if an operator paused the job (`update cron.job set active = false where jobname = 'jev-shadow';`), the migration reads `active` before unscheduling and sets it back to `false` after rescheduling, so applying 108 never re-enables a paused job. A job that did not exist is created active.

**Verify** (read-only; never select `cron.job.command` in a shared terminal):

```sql
select count(*) from public.ops_health_report();  -- 12
select check_name, status, observed, detail from public.ops_health_report() where check_name in ('jev_shadow_last_run_min', 'jev_alerts_unacked_72h', 'jev_shadow_cron_failures_30m');
select jobname, schedule, active from cron.job where jobname = 'jev-shadow';  -- */10 * * * *, active as before
select id, status, calls, note from public.jev_shadow_runs order by id desc limit 5;  -- a deadline stop now has a note
select has_function_privilege('anon', 'public.ops_health_report()', 'execute');  -- expect false
```

**Rollback:** re-apply `103_jev_shadow_stall_check.sql` to restore the previous function, re-run the `do $$ ... $$` block of `061_jev_shadow.sql` to restore the 60 s timeout and empty-body cron command (re-pause the job afterwards if it was paused), then `delete from supabase_migrations.schema_migrations where version = '108';`. The redeployed `jev-shadow` can stay.

## 112 — Yükselen Konular (`trends_daily_entity_counts_ist_rollup`, folded into cron `trends-rollup-refresh`): APPLY 112, THEN DEPLOY

**Why:** `/trends` now opens with a "Yükselen Konular" card: people, institutions, countries and economy terms whose article count today is far above their own trailing-week average. The only trends rollup was per (day, zone) (092), `articles.entities` is EMPTY in production (098 header), and the page must not scan `articles`. 112 tokenizes article **titles** against a curated vocabulary (`src/lib/trends/rising-entities.ts`, 62 entities) one Istanbul day at a time and stores one count per (day, entity).

**What it does** (one transaction, additive, safe to re-apply):

1. Creates `public.trends_daily_entity_counts_ist_rollup (day, entity, count, updated_at)`. Service-role only: RLS on with no policy, every default grant revoked (anon, authenticated, public; PG17 `MAINTAIN` too), `SELECT` granted to `service_role`. There is no public read; the app reads it through the service-role `createReaderClient()`.
2. Creates `public.trends_daily_entity_counts_ist_refresh(p_days default 2)`: `SECURITY DEFINER`, `search_path = ''`, service-role-only. Recomputes the last `p_days` (cap 10) Istanbul days plus the days hit by late-ingested rows, one statement per day, counting outlet/wire **articles** (once per entity), excluding legal notices (107), and writing a row for **every** vocabulary entity (zero included). A failure (including a statement timeout) raises a `WARNING` and returns `-1`; it never aborts the transaction it shares with the zone refresh. An overlapping call returns `0`.
3. `cron.alter_job` on `trends-rollup-refresh`: the command becomes `select public.trends_daily_zone_counts_ist_refresh(); select public.trends_daily_entity_counts_ist_refresh();`. The schedule (`25 * * * *`, 109) is not touched. Without `pg_cron` or without that job it raises a NOTICE and skips.
4. Backfills with `refresh(9)` (today plus 8 days), roughly 20-40 s, inside a `DO` block that **fails the migration** when `refresh()` returns `-1` (the preceding `WARNING: 112 entity refresh failed: ...` names the cause, e.g. a role/pooler `statement_timeout`) or when fewer than 9 days were written (an overlapping cron refresh holds the lock and returns `0`). The whole transaction then rolls back: no table, no cron change, no `112` ledger row. Fix the cause (raise the timeout for the session, or retry away from the `:25` cron run) and re-apply.

**Deploy order:**

1. Apply `112_trends_entity_rollup.sql` (before the Vercel deploy, so the first prerender already has data):

   ```bash
   supabase db push --linked        # or: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/112_trends_entity_rollup.sql
   ```

2. Ship the Vercel deploy. Before step 1 (or if the table is empty) the card shows "Yükselen konular şu anda hesaplanamıyor." and retries within about a minute (failures cache for the short `minutes` lifetime); the chart is unaffected.

**Verify** (read-only):

```sql
select count(*), count(distinct day), count(distinct entity), min(day), max(day)
  from public.trends_daily_entity_counts_ist_rollup;  -- right after the backfill: 558, 9, 62, today-8, today
select command, schedule, active from cron.job where jobname = 'trends-rollup-refresh';
  -- command holds BOTH calls, schedule still '25 * * * *'
select day, entity, count from public.trends_daily_entity_counts_ist_rollup
 where day = (now() at time zone 'Europe/Istanbul')::date and count > 0 order by count desc limit 10;
select has_table_privilege('anon', 'public.trends_daily_entity_counts_ist_rollup', 'select');  -- false
select has_table_privilege('authenticated', 'public.trends_daily_entity_counts_ist_rollup', 'select');  -- false
select has_function_privilege('anon', 'public.trends_daily_entity_counts_ist_refresh(integer)', 'execute');  -- false
select jobid, status, return_message, start_time, end_time from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'trends-rollup-refresh') order by runid desc limit 3;
  -- the next :25 run; the duration includes the zone refresh (6 h avg 34 s before 112)
```

The migration aborts rather than commit a partial backfill, so a successful apply already means 9 days. If the table later has fewer than 9 days (for example after an operator pruned it), re-run the refresh; it is idempotent and bounded per day: `select public.trends_daily_entity_counts_ist_refresh(9);` (service role / SQL editor). The hourly run only refreshes the last 2 days, so a missing older day does not fill by itself, and "Yükselen konular için yeterli geçmiş veri henüz yok." shows until 6 of the 7 baseline days exist.

**Cost:** the per-day statement was timed read-only on production before writing the migration: 0.95-2.1 s for yesterday, 3.6 s for a 21-day-old day nobody had touched (the statement narrows each day with two index range scans so a late-ingest repair day does not heap-scan every article since then; the plain `created_at >=` form took 10.1 s cold for 2026-10-13). A normal hourly run does 2-4 such statements. If the combined cron run ever gets too long, split it: `select cron.alter_job((select jobid from cron.job where jobname = 'trends-rollup-refresh'), command := 'select public.trends_daily_zone_counts_ist_refresh();');` and schedule `select public.trends_daily_entity_counts_ist_refresh();` as its own job.

**Changing the vocabulary:** edit `src/lib/trends/rising-entities.ts` and write a new migration that `create or replace`s the refresh function with the new `emap` VALUES and re-runs the backfill (copy the body of the NEWEST migration that replaced the function, which since 163 is 163's with its `guard_map` / `guarded` block; copying 112's text would silently drop the guards); `tests/migrations/112-trends-entity-rollup.test.ts` pins the migration to the TS list and its fold strings.

**Rollback:** nothing else depends on 112; the card degrades to its "hesaplanamıyor" copy.

```sql
select cron.alter_job((select jobid from cron.job where jobname = 'trends-rollup-refresh'),
  command := 'select public.trends_daily_zone_counts_ist_refresh();');
drop function public.trends_daily_entity_counts_ist_refresh(integer);
drop table public.trends_daily_entity_counts_ist_rollup;
delete from supabase_migrations.schema_migrations where version = '112';
```

The migration itself never deletes: days that leave the rolling window keep their last counts (about 62 rows a day, 23k a year).

## 113 — source_article_key + twin drop + parse budget: PRE-BUILD, APPLY 113, BACKFILL, THEN DEPLOY ingest

**Why:** two ingest problems, one deploy.

- **Twin articles.** An outlet that edits a headline publishes the same article under a new URL slug and keeps the numeric id its CMS gave it (aksam `.../haber-1708664` before and after, articles `1fe98b20` and `8f291028`). Ingest upserts on `url` and checks `(source_id, content_hash)`; both change with the headline, so every edit became a second row that clusters and counts as a second article of the same source (23 of 104 blindspot clusters held such a pair). 113 stores the id as `articles.source_article_key`; the new ingest drops a re-polled item whose `(source_id, key)` is already stored under a different url and records the new headline through the existing title-version path (`article_title_versions` + `apply_article_title_edits`) instead.
- **CPUTime kills.** Cycles were dying with HTTP 546 (reason `CPUTime`), losing everything they had fetched: over 3 days only 417 to 456 of the 480 scheduled cycles finished per full day. A cycle decoded, parsed and normalised every changed feed (parse + normalise is 17 to 48 ms per MB; the numbers are in `supabase/functions/ingest/index.ts`). The new ingest parses at most 55 changed feeds and 8 MB of body per cycle and defers the rest to the front of the next cycle (55 is about the p90 of the load, see Verify; a cap of 40 would be below the median and make deferral the steady state). This half needs no migration.

**What 113 does** (additive, one transaction, safe to re-apply; starts with `set local lock_timeout = '5s'` and `set local statement_timeout = '60s'`):

1. `articles.source_article_key text` (nullable, no default) and the partial index `articles_source_article_key_idx` on `(source_id, source_article_key) where source_article_key is not null`.
2. `public.source_article_key(p_url text)`: the SQL twin of `sourceArticleKey()` in `supabase/functions/_shared/rss/article-key.ts` (the last run of 6 to 20 digits in the last path segment that is neither date-shaped nor round: one or two significant digits followed by at least four zeros, such as `100000`, a quantity in a headline slug). The four regexes are copied verbatim; `tests/migrations/113-source-article-key.test.ts` fails the build on drift and, with `TAYF_PSQL` set, runs the shared fixture table through a real Postgres.
3. `public.articles_source_key_backfill(p_from, p_to)`: fills NULL keys of the rows created in `[p_from, p_to)`, at most 2 days at a time, skipping the sources in `ARTICLE_KEY_EXCLUDED_SLUGS` (today `a-news` and `daily-sabah`: their urls carry numbers in the slug, not ids; a 7-day replay merged two daily-sabah stories on `500000`, and a 30-day replay found three false a-news groups on `100000`, `250000` and `300000`, two of them inside the 7-day twin window). Both functions are `SECURITY DEFINER`, `search_path = ''`, `service_role` only. No table, no cron, nothing granted to `anon`/`authenticated`.

**Deploy order (load-bearing): pre-build, apply, backfill, then deploy ingest.** An ingest deployed before the column exists fails every upsert (unknown column).

1. **Pre-build the column and the index.** Run each statement on its own, outside any transaction block (`CREATE INDEX CONCURRENTLY` cannot run inside one; use `psql` in autocommit). Inserts into `articles` keep flowing while the index builds, and 113's own `if not exists` statements then do nothing:

   ```sql
   set lock_timeout = '5s'; alter table public.articles add column if not exists source_article_key text;
   create index concurrently if not exists articles_source_article_key_idx on public.articles (source_id, source_article_key) where source_article_key is not null;
   ```

2. **Check that the build was not left invalid** (expect 0 rows). If a name comes back, `drop index concurrently articles_source_article_key_idx;` and rebuild; 113 re-checks `indisvalid` itself and aborts with that instruction:

   ```sql
   select c.relname from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid where c.relname = 'articles_source_article_key_idx' and not i.indisvalid;
   ```

3. **Apply `113_source_article_key.sql`.** Do not skip step 1. 113 fails closed: if `articles_source_article_key_idx` does not exist and `articles` is over 64 MB (it is 1850 MB), its first guard raises `public.articles is N MB and articles_source_article_key_idx does not exist yet ... Run the ORCHESTRATOR PRE-BUILD first` before touching anything (no lock, no column, no ledger row): run step 1 and re-apply. The reason: `alter table ... add column if not exists` takes ACCESS EXCLUSIVE on `articles` before it checks the column, even when it is a no-op, and holds it until commit, so a non-concurrent index build in the same transaction would block every read of `articles` (the public site) as well as every write (ingest) for the whole build. With the pre-build done the transaction is sub-second (0.03 s on a 97 MB scratch table); a long reader ahead of its lock wait can make new readers queue for at most 5 s (`lock_timeout`), after which 113 aborts with **55P03** and records nothing: re-apply. On a small database (a fresh dev or CI one) 113 adds the column and builds the index itself.

4. **Backfill** (operator, once; idempotent and resumable; NOT part of the migration; one call per 2-day slice, each its own statement; the anchor `T0` keeps the slices gapless). About 112,600 rows over 14 days (about 8,000 a day; 1.2 s for a 43,000-row slice on a scratch Postgres 15):

   ```bash
   T0=$(psql "$DATABASE_URL" -Atc "select now()")
   for i in 14 12 10 8 6 4 2; do
     psql -q "$DATABASE_URL" -Atc "set statement_timeout = '2min'; select public.articles_source_key_backfill('$T0'::timestamptz - interval '$i days', '$T0'::timestamptz - interval '$i days' + interval '2 days');"
   done
   ```

   Without psql, run each `select` in the SQL editor one slice at a time. Verify (the `keyed` count should be close to `total`; the unkeyed rows are slug-only urls, `a-news`, `daily-sabah`, round numbers in a slug, and rows without an id in the url):

   ```sql
   select count(*) total, count(source_article_key) keyed, count(*) filter (where source_article_key is null) unkeyed from public.articles where created_at >= now() - interval '14 days';
   ```

5. **Deploy ingest** with `--no-verify-jwt` like every Edge Function in this guide: `npx supabase functions deploy ingest --no-verify-jwt`. Rows older than 14 days stay NULL (the lookup window is 7 days).
6. **Catch-up** (after the deploy; the old ingest wrote no key between `T0` and the deploy): `select public.articles_source_key_backfill('<T0>'::timestamptz, now() + interval '1 hour');`

The Vercel app does not read the column; there is no ordering constraint with an app deploy.

**Tuning without a deploy** (Edge Function secrets; both are read once per cycle, and anything but a positive integer falls back to the default, so a typo cannot disable the budget):

```bash
npx supabase secrets set INGEST_MAX_PARSES_PER_CYCLE=55 INGEST_PARSE_BUDGET_BYTES=8000000
```

**Verify** (read-only; give the new ingest a day):

```sql
-- twin replay: keys with 2+ urls that were BOTH created in the last 24 h. About 180 groups before the deploy, about 0 after.
select count(*) from (
  select source_id, source_article_key from public.articles
   where created_at >= now() - interval '24 hours' and source_article_key is not null
   group by 1, 2 having count(distinct url) >= 2
) g;
-- cycles per day: at least 470 of the 480 scheduled (417 to 456 before)
select date_trunc('day', started_at) d, count(*) from public.ingest_cycles where started_at >= now() - interval '3 days' group by 1 order by 1;
-- the index and the privileges
select indexrelid::regclass, indisvalid from pg_index where indexrelid = 'public.articles_source_article_key_idx'::regclass;  -- true
select has_function_privilege('anon', 'public.source_article_key(text)', 'execute');  -- false
select has_function_privilege('anon', 'public.articles_source_key_backfill(timestamptz, timestamptz)', 'execute');  -- false
```

In the Supabase Logs Explorer (function_edge_logs) the number of ingest responses with `status_code = 546` should drop to about 0:

```sql
select cast(timestamp as date) as day, count(*) as n
from function_edge_logs
  cross join unnest(metadata) as m
  cross join unnest(m.response) as r
where r.status_code = 546
group by 1 order by 1 desc
```

The cycle summary line (`[ingest] cycle {...}`, function logs) now carries `twinsDroppedStored` (the #128 measure: rows not inserted because the source already holds that article under another url), `twinsDroppedIntraFeed` (the same key twice in one feed; it is re-counted on every re-parse of a long feed, so it is high overnight), `twinsDropped` (their sum, kept for one release), `parseDeferred` (changed feeds postponed to the next cycle), `parseDeferredMaxStreak` (the longest run of consecutive cycles any feed has been deferred, counting this one; best effort, a cold start resets it) and `parsedBytes` (body bytes admitted to a parse). They are JSON-only: there is no `ingest_cycles` column. A twin-only chunk prints `dropped N twin row(s) ...` and a feed with intra-feed twins prints `[ingest] <slug>: N intra-feed twin(s)` once per source per cycle (counts, never a url or headline); #128 is judged on `twinsDroppedStored` during 06-09 UTC, not on the intra-feed count. A cycle with deferrals prints `parse budget: deferred N changed feed(s) ... longest deferral streak S`, and a lookup failure counts in `prefilter_errors`.

**`parseDeferred` is not expected to be 0.** The default cap, 55 changed feeds a cycle, sits at about the p90 of the load, not above its peak. `ingest_cycles.fetched` is the number of changed feeds a cycle parsed; over the 3 days to 2026-10-23 (1,328 cycles) it had p50 45, p90 55, p99 71, max 78, and in hours 06-08 UTC p50 52, p90 68 (overnight, 22:00 to 03:00 UTC, p90 46 or less). Replayed against that load a cap of 55 defers about 10% of the cycles, 0.8 feeds a cycle on average and 2.6 at 06-08 UTC (30% of the cycles in those hours); a cap of 40 would have deferred 74% of them (6.8 feeds on average, 14.4 at 06-08 UTC), which is why it is not the default. Deferred feeds go first next cycle, so a backlog drains by itself once the tail of the load passes. A healthy 24 hours looks like this (count the `parse budget: deferred` log lines against the 480 scheduled cycles):

- cycles with deferrals: about 10% (the replay figure; look into it above 25%), clustered at 06-09 UTC and around 13 UTC, almost none overnight;
- `parseDeferred` on a deferring cycle: typically 1 to 10, occasionally 20 at 07-09 UTC;
- `longest deferral streak`: 1, rarely 2; a value of 4 or more means a feed is starving, so raise the cap;
- 546 responses: down from about 6% (27 of 454 over 24 h) toward 0.

If 546s persist (above about 1% of the cycles), lower the cap with `INGEST_MAX_PARSES_PER_CYCLE` (for example 45); if deferral stays high and the 546s are gone, raise it (for example 65). The share of expected cycles missing from `ingest_cycles` was highest where the load tail is longest (hours 07-09 and 13 UTC, 15 to 33%); the killed cycles write no row, so their own load is not in that table and the cap is a judgement from the survivors, hence the secret.

**Limits to know:**

- A twin is detected against rows created in the last 7 days, per source. An edit that comes back later than that is inserted as before.
- A source whose urls carry no article id has no key and is untouched. Sources whose digit runs are slug numbers, not ids, are listed in `ARTICLE_KEY_EXCLUDED_SLUGS` in `article-key.ts` and in the backfill's `WHERE` clause (`a-news` and `daily-sabah` today); add a slug to both (the migration test compares them) the day a replay shows a false group for it. A round number in a slug (`100000`, `250000`, `1000000`) is never a key for any source, so the common false group is closed for outlets not on the list; the rare real id of that shape simply is not deduped.
- One CMS item reused as a rolling bulletin (haber7 "Borsa güne yükselişle başladı" then "Borsa İstanbul'da düşüş devam ediyor!") keeps its id, so only the first url is stored and the later headlines are recorded as title versions.
- A feed bigger than the byte budget is not starved: a feed deferred last cycle goes first and may exceed the budget once per cycle.

**Rollback** (nothing depends on 113 until the new ingest is deployed):

1. Redeploy the previous ingest function (it neither reads nor writes the column).
2. `drop function public.articles_source_key_backfill(timestamptz, timestamptz); drop function public.source_article_key(text); drop index concurrently if exists articles_source_article_key_idx;`
3. Only after step 1 (the new ingest writes the column on every upsert): `alter table public.articles drop column if exists source_article_key;`
4. `delete from supabase_migrations.schema_migrations where version = '113';`

## 114 — sources_newly_dark: APPLY 114 only, no deploy (see docs/ops-heartbeat.md)

Adds `ops_health_report()` row 13 `sources_newly_dark` (warn only) and a small baseline table of the sources already known to be dark; additive, one transaction, safe to re-apply, no Edge Function or app deploy.
Apply `114_sources_newly_dark.sql`; the new row is described in `docs/ops-heartbeat.md`.

## 115 — sources_newly_dark at 24 h: APPLY 115 only, no deploy (see docs/ops-heartbeat.md)

Re-creates `ops_health_report()` with row 13 `sources_newly_dark` looking at the last 24 hours instead of 12 (still at least 50 articles in the 14 days before, baseline still excluded); every other row, the signature and the grants are unchanged. One transaction, safe to re-apply, no Edge Function or app deploy.
Apply `115_sources_newly_dark_24h.sql`. Rollback: re-apply the `ops_health_report()` block (function, comment, revoke, grant) of `114_sources_newly_dark.sql`, then `delete from supabase_migrations.schema_migrations where version = '115';`.

## Anon yüzeyi (116/117) devreye alma: APPLY 116, DEPLOY THE APP, VERIFY, THEN APPLY 117

The public anon key (shipped to every browser and to the edge middleware) could `SELECT` 23 public relations and use 6 sequences (read-only prod facts, 2026-10-24; see the header of `117_revoke_anon_surface.sql`). The app only ever needed three things from it: resolving `/saved` bookmark ids, the merged-cluster 308 map and the `/source/<slug>` existence gate. After this rollout anon reaches data **only** through four bounded, read-only `SECURITY DEFINER` RPCs; nothing else is granted.

- `116_anon_public_rpcs.sql` (additive): `saved_clusters(uuid[])` (input truncated to 200 ids, at most 200 rows), `merged_cluster_map()` (newest 1000 merges), `source_slugs()` (at most 2000), `source_slug_exists(text)` (regex `^[a-z0-9][a-z0-9-]{0,63}$`, one boolean). `language sql stable`, `search_path = ''`, executable by `anon` and `service_role` only, never `authenticated`. Ends with `notify pgrst, 'reload schema'`.
- `117_revoke_anon_surface.sql` (revoke only): `revoke all on all tables / all sequences in schema public from anon, authenticated`, `trends_daily_bias_counts` becomes `security_invoker`, `alter default privileges for role postgres in schema public revoke ...` for tables, sequences and functions, and `revoke execute` on `public.rls_auto_enable()` (the only other definer function anon could run; guarded, so it also applies where it does not exist). `service_role` and `postgres` are never referenced.
- App: `saved-list.tsx` and `bookmark-snapshots.ts` call `.rpc("saved_clusters", ...)`; `merged-cluster-gate.ts` and `source-slug-gate.ts` GET `/rest/v1/rpc/...`. Fail-open behaviour, timeouts and caches are unchanged.

### Order matters (each step is its own deploy)

1. **Apply `116`** (SQL editor or `supabase db push`). Nothing calls the functions yet, so this is harmless. Check: `select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('saved_clusters','merged_cluster_map','source_slugs','source_slug_exists');` returns four rows.
2. **Deploy the app** (merge to `main`, Vercel builds it). No Edge Function redeploy is involved: the gates run in the Next.js edge middleware.
3. **Verify, still before 117** (the old grants are still in place, so a failure here is not an outage):
   - `/saved` with at least one bookmarked story lists it with its title, source count and time-ago. In the browser network tab the lookup is `POST /rest/v1/rpc/saved_clusters` (200), and there is no request to `/rest/v1/clusters`.
   - A merged cluster: `curl -sI https://www.tayfhaber.com/cluster/<merged-id>` answers `308` with the survivor in `location`. At the time of writing production has no merged clusters (`select count(*) from public.clusters where merged_into is not null` is 0); if it is still 0, instead check `curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/rpc/merged_cluster_map" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"` answers `[]` with 200, and rely on `merged-cluster-gate.test.ts` for the redirect.
   - `curl -s -o /dev/null -w '%{http_code}\n' https://www.tayfhaber.com/source/zz-not-a-source` answers `404` with the site's own not-found page (the middleware rewrite to `/__tayf-not-found`), and `/source/cnn-turk` (any real slug) still renders.
   - RPC smoke with the anon key: `source_slug_exists?p_slug=<real slug>` answers `true`; `?p_slug=Bad!` answers `false`.
4. **Apply `117`** only when step 3 is green. It is one short transaction (`lock_timeout` 5 s); the only real lock is the one view alter.

If the order is violated nothing breaks hard: 117 before the app deploy makes the old gates fail open (no 308, no source 404 sink; the pages' own fallbacks answer) and `/saved` shows `Kaydedilenler yüklenemedi. Lütfen sayfayı yenileyin.` until the deploy lands.

### After 117: read-only checks (expect the stated result)

```sql
-- 0 rows: no relation readable by anon/authenticated
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','p','v','m')
   and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'));
-- 0 rows: no sequence usable by anon/authenticated
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'S'
   and (has_sequence_privilege('anon', c.oid, 'usage') or has_sequence_privilege('authenticated', c.oid, 'usage'));
-- exactly the four 116 functions
select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute');
-- no anon/authenticated entry for postgres-owned objects in public
select d.defaclobjtype, d.defaclacl from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
 where n.nspname = 'public' and d.defaclrole = 'postgres'::regrole;
```

And over HTTP: `curl -s -o /dev/null -w '%{http_code}' "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/clusters?select=id&limit=1" -H "apikey: $ANON"` now answers `401` or `403` (`42501 permission denied for table clusters`), while `/saved`, `/cluster/<id>` and `/source/<slug>` keep working. Server routes, crons and Edge Functions use the service-role key and are unaffected.

### Rollback

- 117: the commented `-- ROLLBACK` block at the end of the file restores `SELECT` on the 23 relations (and `reset (security_invoker)`); it never re-grants writes, sequence usage or the default ACLs. The new app keeps working either way because it only calls the RPCs.
- 116: the four `drop function` lines in its header, only after the app has been rolled back (the gates and `/saved` call them).

### What this does not close (residual, by design)

- `PUBLIC` still gets `EXECUTE` on every future function (a per-schema default cannot revoke it; a global one would break extension functions `service_role` relies on). Every new `SECURITY DEFINER` function still needs `revoke all on function ... from public, anon, authenticated`. `tests/guards/anon-surface.test.ts` fails any migration >= 116 that grants to anon/authenticated/public (other than the four 116 executes), grants through default privileges, or defines a definer function without an anon revoke. It also pins that only `saved-list.tsx` and `bookmark-snapshots.ts` import the browser client (no `.from(`, only `saved_clusters`) and that only `browser.ts` and the two gates read the anon key.
- Default ACLs owned by `supabase_admin` cannot be altered by `postgres`; every object in `public` is owned by `postgres` today (66 tables, 10 views, 18 sequences, 108 functions), so nothing is affected.
- The RLS `SELECT` policies from `017` stay in place (inert without the table privilege).
- `docs/key-rotation.md` and `README.md` still describe the anon key in older terms; the anon key itself is unchanged and is not rotated by this rollout.

## 119 — feed freshness: APPLY 119, THEN DEPLOY ingest

**Why:** a frozen feed (HTTP 200, but the newest item never changes: `haberport`, `korkusuz` and `en-politik` on 2026-10-24) looked exactly like a quiet outlet in `ops_health_report()` row 13 `sources_newly_dark`, and unlike a blocked one (403, DNS) that needs a different fix. Ingest now stores what each feed reports about itself, and the report and `/kaynaklar/durum` label every silent source `erişim yok`, `akış donmuş` or `sessiz` (the labels and what to do about each are in `docs/ops-heartbeat.md`).

**What 119 does** (additive, one transaction, safe to re-apply; starts with `set local lock_timeout = '5s'`):

1. `public.sources.fetch_newest_item_at timestamptz` and `fetch_items_count integer` (nullable, no default, no grant: they inherit 117's empty anon/authenticated ACL).
2. `ingest_set_source_fetch_state(jsonb)` re-created with 074's body plus the two keys. A payload without `fetch_items_count` keeps both stored values; a count with no date stores NULL (an undated feed is never fresh, never a bare `least()`); a date is clamped to now + 10 minutes; a negative count becomes 0.
3. Ingest (edge half) ignores feed item dates before 1990 or after now + 10 minutes, bounds what it sends to 1990..2100, and retries a batched fetch-state write that Postgres refuses for a data reason (SQLSTATE 22/23) in halves, at most 24 calls, so one hostile feed cannot erase every other source's state. Watch the function log for `source fetch-state write failed` and `dropped source`.
4. `ops_health_report()` re-created with 115's body (rows 1-12 byte-identical); row 13 appends ` · <reason>` to each entry. `akış donmuş` needs a feed whose newest item is over 72 hours old (or an empty feed): row 13 only lists a source after 24 silent hours, so a 24 hour threshold would have labelled every listed source frozen, a paused outlet included.

**Steps (order is load-bearing, but neither order breaks anything):**

1. Apply `supabase/migrations/119_feed_freshness.sql`. Check: `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name in ('fetch_newest_item_at','fetch_items_count');` returns two rows; `select count(*) from public.ops_health_report();` returns 13.
2. Deploy the ingest Edge Function: `npx supabase functions deploy ingest --no-verify-jwt`. The new ingest selects the two columns and, on Postgres `42703` (119 not applied yet), retries once with the old select and carries on without freshness, so deploying first is safe but records nothing. The app (Vercel) half has the same fallback and needs no ordering.
3. Wait three to four cycles (about 12 minutes). Every source whose `fetch_items_count` is NULL is **bootstrapped** once: ingest skips its etag and body-hash short-circuits, parses the feed (the parse budget still applies, so a deferred bootstrap is retried first next cycle), stores the freshness and, when the body is the one already stored, inserts no row. This is what makes the frozen feeds measurable: their byte-identical bodies are otherwise never parsed again. The cycle summary line (`[ingest] cycle {...}`) carries `freshnessBootstraps`; expect a burst of full fetches (about one per active source) in the first cycles, then 0.

**Verify** (read-only, after the bootstrap):

```sql
-- unmeasured sources left (expect 0, or the blocked ones: they have no 2xx to parse)
select count(*) from public.sources where active and fetch_items_count is null;
-- the three frozen feeds carry their frozen newest item date (row 13 labels them `akış donmuş` once it is over 72 h old, `sessiz` before that)
select slug, fetch_items_count, fetch_newest_item_at from public.sources where slug in ('haberport','korkusuz','en-politik');
-- row 13 now names the reason
select detail from public.ops_health_report() where check_name = 'sources_newly_dark';
-- the new columns are not readable by anon/authenticated (expect f, f)
select has_column_privilege('anon','public.sources','fetch_items_count','select'), has_column_privilege('authenticated','public.sources','fetch_newest_item_at','select');
```

On `/kaynaklar/durum` a silent source now shows its label (and a legend appears under the totals while anything is silent); the page is cached for the `source-directory` window, so allow a few minutes.

**Rollback** (nothing else depends on 119; redeploy the previous ingest first):

1. Redeploy the previous ingest function (it never sends the keys, and the old writer ignores them).
2. Re-apply the `create or replace function` block of `074_ingest_fixes.sql` for `ingest_set_source_fetch_state(jsonb)` (with its comment, revoke and grant) and the `ops_health_report()` block of `115_sources_newly_dark_24h.sql` (with its comment, revoke and grant).
3. The columns may stay (nullable, unread). To drop them as well, only after steps 1 and 2: `alter table public.sources drop column if exists fetch_newest_item_at, drop column if exists fetch_items_count;`
4. Remove ledger row 119: `delete from supabase_migrations.schema_migrations where version = '119';`

## 120 — twin cluster pairs: APPLY 120 only, no deploy

Adds the read-only `service_role` function `public.admin_twin_cluster_pairs(integer, integer)` for `/admin/birlestir`; apply `120_*.sql`, nothing to deploy. Rollback: drop the function (`drop function public.admin_twin_cluster_pairs(integer, integer);`) and delete ledger row 120 (`delete from supabase_migrations.schema_migrations where version = '120';`).

## 121 — cluster_link_atomic recomputes under the lock: APPLY 121 only, no deploy

**Why:** `cluster_link_atomic` (027) locks the cluster and inserts the member, but wrote `bias_distribution`, `is_blindspot`, `blindspot_side` and `first_published` exactly as the cluster-consumer sent them, and the consumer builds those from a member snapshot it reads *before* the lock. Two links into one cluster at the same time each wrote a snapshot without the other's article, so the later writer erased the earlier writer's vote (`article_count`, recounted under the lock, stayed right). Production shows it on two clusters, `52823177-3a62-4b56-8312-18cd3f07b53e` and `e0c1324a-c47e-4952-beed-c37f858a15e3` (drift query below).

**What 121 does** (additive, one transaction, safe to re-apply; starts with `set local lock_timeout = '5s'`): `create or replace function` on `cluster_link_atomic(uuid, uuid, jsonb, boolean, text, timestamptz)` (no `drop function`: that would strip the grants and break consumer calls in flight). The body keeps 027's advisory lock and idempotent insert, adds a `for update` row lock on the cluster after the advisory lock (099's order, so no deadlock against `cluster_merge_atomic`), and then calls `cluster_unlink_article(cluster, null)` (064), the canonical SQL recompute: `article_count`, `bias_distribution` (voting kinds `outlet` and `wire`, one vote per article, ten keys), `is_blindspot` / `blindspot_side` (five voting articles, 0.8 zone share), `first_published = min(published_at)` and `updated_at = now()` (still the `/api/health` liveness signal). The four aggregate parameters stay in the signature and are **ignored**, so the Edge Function needs no change and no redeploy. Still `security definer`, `search_path = ''`, volatile, `service_role` only.

**Independent of 122, either order.** Nothing to deploy; it takes effect on the next link. The two drifted clusters are not backfilled: they heal on their next link or by the repair below.

**Verify** (read-only):

```sql
-- the recomputing body is live (expect fb81251b45dd50907160832f6f84db0c, 2006, t, v)
select md5(prosrc), length(prosrc), prosecdef, provolatile
  from pg_proc where oid = 'public.cluster_link_atomic(uuid,uuid,jsonb,boolean,text,timestamptz)'::regprocedure;
-- service_role only (expect f, f, t)
select has_function_privilege('anon', 'public.cluster_link_atomic(uuid,uuid,jsonb,boolean,text,timestamptz)', 'execute'),
       has_function_privilege('authenticated', 'public.cluster_link_atomic(uuid,uuid,jsonb,boolean,text,timestamptz)', 'execute'),
       has_function_privilege('service_role', 'public.cluster_link_atomic(uuid,uuid,jsonb,boolean,text,timestamptz)', 'execute');
select count(*) from supabase_migrations.schema_migrations where version = '121';  -- 1
```

**Drift query** (read-only; one row per live cluster whose stored distribution differs from the one recomputed from its members; expect the two clusters above before the repair, and no new ones after the apply):

```sql
with live as (select c.id, c.bias_distribution from public.clusters c where not c.is_archived and c.merged_into is null and c.article_count >= 2 and c.updated_at >= now() - interval '30 days'),
votes as (select l.id, s.bias, count(*)::int n from live l join public.cluster_articles ca on ca.cluster_id = l.id join public.articles a on a.id = ca.article_id join public.sources s on s.id = a.source_id where s.kind in ('outlet','wire') group by l.id, s.bias),
rec as (select l.id, coalesce(jsonb_object_agg(v.bias, v.n) filter (where v.bias is not null), '{}'::jsonb) d from live l left join votes v on v.id = l.id group by l.id),
sto as (select l.id, coalesce((select jsonb_object_agg(e.key, (e.value)::int) from jsonb_each_text(l.bias_distribution) e where (e.value)::int > 0), '{}'::jsonb) d from live l)
select sto.id, sto.d stored_nonzero, rec.d recomputed_nonzero from sto join rec using (id) where sto.d <> rec.d order by 1;
```

**Optional repair** (operator, not run by the migration): for each id the drift query returns, `select public.cluster_unlink_article('<id>'::uuid, null);` (service_role). It recomputes that cluster from its members and stamps `updated_at = now()`; if the old value matters, read it first and restore it afterwards the way 099 does (`update public.clusters set updated_at = '<old value>' where id = '<id>';`).

**Rollback** (nothing else depends on 121): re-apply the `create or replace function` block of `027_cluster_link_atomic.sql` (write `create function` as `create or replace function`, skip its `drop function if exists` line; with its comment, revoke and grant), then remove ledger row 121: `delete from supabase_migrations.schema_migrations where version = '121';`.

## 122 — ops heartbeat row 14 (`ingest_gaps`): APPLY 122 only, no deploy

**Why:** the ingest function writes its `ingest_cycles` row at the *end* of a cycle, so a tick the platform kills (pg_net `546 WORKER_RESOURCE_LIMIT`) leaves no row, and row 3 (`ingest_cycles_30m`, pass from 8 of the expected 10) can read pass while ticks are lost. Row 14 looks at the spacing of `ingest_cycles.started_at` in the last 6 hours: `ingest-drain` runs every 3 minutes (038), so a gap over 5 minutes is at least one lost tick.

**What 122 does** (additive, one transaction, safe to re-apply): re-creates `ops_health_report()` with 119's text verbatim through row 13 (the test compares the raw text) and appends row 14 `ingest_gaps`: `observed` = number of gaps over 5 minutes, **warn** at 3 or more gaps or any gap over 10 minutes (threshold 3), never `fail`, `detail` lists the gaps as `HH:MI→HH:MI` in UTC, longest first. The function returns 14 rows. `service_role` only, no table, no grant to anon/authenticated. The heartbeat workflow and `/durum` do not depend on the row count. Thresholds checked against the retained history (migration header, Step 0): quiet when ingest is healthy (2.6% of sliding windows), warning through the degraded stretch since 10-13 (55%).

**Independent of 121, either order.** Nothing to deploy; the next heartbeat run (30 minutes) shows the row.

**Verify** (read-only):

```sql
select count(*) from public.ops_health_report();  -- 14
select status, observed, threshold, detail from public.ops_health_report() where check_name = 'ingest_gaps';
-- service_role only (expect f, f, t)
select has_function_privilege('anon', 'public.ops_health_report()', 'execute'),
       has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'),
       has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
-- md5(prosrc) was f6548a98c236a3b998fedf8c192e6b7c (19,091 characters) right after 122 (historical:
-- 136, 145 and 150 replace the function). Current value: 2445cd7d15a23d4af88d42ddf79ac2ff, 38,876
-- characters (migration 150, verified on production 2026-11-02).
select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
```

When it warns, check `net._http_response` for 546 in the gap minutes *before* the compaction trims it: see `docs/ops-heartbeat.md`, "Kayıp ingest turları".

**Rollback** (nothing else depends on 122): re-apply the `ops_health_report()` block of `119_feed_freshness.sql` (function, comment, revoke, grant; the report returns 13 rows again), then remove ledger row 122: `delete from supabase_migrations.schema_migrations where version = '122';`.

## 123 — entity hubs (`entity_cluster_ids`): APPLY 123, THEN DEPLOY the app

**Why:** `/gundem/<key>` hubs (roadmap G2) list the clusters about one person, party or institution from the 62-term curated vocabulary in `src/lib/trends/rising-entities.ts`. `articles.entities` is empty, so the hubs search the existing `clusters.search_tsv` GIN index.

**What 123 does** (additive, one transaction, safe to re-apply): creates `public.entity_cluster_ids(p_variants text[], p_since timestamptz, p_limit integer)`, `SECURITY DEFINER`, `search_path = ''`, read-only. It returns ids of live clusters (not archived, `merged_into is null`, `article_count >= 2`) matching any variant, newest `updated_at` first, with the full match count via `count(*) over ()`. `p_since` defaults to 14 days and is clamped to at most 30; `p_limit` is clamped to 1..50. Execute is revoked from public/anon/authenticated and granted to `service_role` only; the app reads it through the server reader.

**Order:** apply 123 before deploying the app. Before 123 the hub read fails and the page shows its "unavailable" state (noindex), so an early deploy degrades but does not break.

**Verify** (read-only):

```sql
-- service_role only (expect f, f)
select has_function_privilege('anon', 'public.entity_cluster_ids(text[],timestamptz,integer)', 'execute'),
       has_function_privilege('authenticated', 'public.entity_cluster_ids(text[],timestamptz,integer)', 'execute');
-- a live hub returns rows; 422 for Erdoğan on 2026-11-01
select total from public.entity_cluster_ids(array['Erdoğan'], now() - interval '14 days', 20) limit 1;
```

Then `curl -sI https://www.tayfhaber.com/gundem/erdogan` (200) and `/gundem/nope` (404 from the middleware gate).

**Rollback:** `drop function public.entity_cluster_ids(text[], timestamptz, integer);` then `delete from supabase_migrations.schema_migrations where version = '123';`. The hubs fall back to their unavailable state.

## 124 — saved list rows (`saved_clusters_v2`): APPLY 124, THEN DEPLOY the app

**Why:** `/saved` rows show a compact bias bar and a "Kör nokta" pill per saved story. RPC `saved_clusters` (116) has no `is_blindspot`.

**What 124 does** (additive, one transaction, safe to re-apply): creates `public.saved_clusters_v2(uuid[])`, 116's body plus `c.is_blindspot`, with the same bounds (at most 200 ids in, 200 rows out), `SECURITY DEFINER`, `search_path = ''`. Execute goes to `anon` and `service_role` only, the exact grant shape `tests/guards/anon-surface.test.ts` allowlists (it is the fifth and only new anon RPC). `saved_clusters` (v1) stays for `bookmark-snapshots.ts`.

**Order:** apply 124 before deploying. The client falls back to v1 without pills on `PGRST202`, so an early deploy shows plain rows instead of failing.

**Verify** (read-only):

```sql
-- anon yes, authenticated no (expect t, f)
select has_function_privilege('anon', 'public.saved_clusters_v2(uuid[])', 'execute'),
       has_function_privilege('authenticated', 'public.saved_clusters_v2(uuid[])', 'execute');
```

**Rollback:** `drop function public.saved_clusters_v2(uuid[]);` then `delete from supabase_migrations.schema_migrations where version = '124';`. `/saved` falls back to v1 rows on its own.

## 125 — precise entity hubs (`entity_cluster_ids_v2`): APPLY 125, THEN DEPLOY the app

**Why:** the `/gundem/<key>` hubs from 123 matched the entity label through the Turkish stemmer alone, so unrelated words that stem alike crept in: 234 "DEVA" clusters of which 11 name the party ("devam" stems to "deva"), 7 "domuz" stories in the Dolar top 20, 70 İYİ Parti clusters of which 36 are real, and only 8 Zelenski and 8 Borsa clusters where 24 and 34 exist (one of four spellings, "Borsa İstanbul" needing both words). The hub card ages also read out of order (9, 3, 4, 4, 11 saat) because 123 sorts by `updated_at` while the card prints `first_published`.

**What 125 does** (additive, one transaction, safe to re-apply): creates `public.entity_cluster_ids_v2(p_queries text[], p_patterns text[], p_since timestamptz, p_limit integer)`, `SECURITY DEFINER`, `search_path = ''`, read-only. The stemmed tsquery over `p_queries` (every curated spelling, for example `AK Parti` and `AKP`) is the recall prefilter on the existing GIN index; a regex guard over `p_patterns`, run on the folded title and summary exactly like migration 112, is ANDed for precision, so only stories that literally name the entity remain. Same live predicates and window as 123 (14 days on `updated_at`, never wider than 30), but ordered by `first_published desc, id`. `p_limit` is clamped to 1..50; empty or null `p_patterns` return no rows. Execute is revoked from public/anon/authenticated and granted to `service_role` only. 123 is not touched: it stays the fallback.

**Order:** apply 125 before deploying the app. An early app deploy is safe too: until 125 is applied PostgREST answers `PGRST202` for v2, the app falls back to 123 for that read, and the old imprecise lists keep working, so nothing breaks. After applying 125 the hubs switch to the precise lists as their `clusters-entity` cache entries expire (the `cluster-feed` window).

**Verify** (read-only):

```sql
-- service_role only (expect f, f)
select has_function_privilege('anon', 'public.entity_cluster_ids_v2(text[],text[],timestamptz,integer)', 'execute'),
       has_function_privilege('authenticated', 'public.entity_cluster_ids_v2(text[],text[],timestamptz,integer)', 'execute');
-- about the literal count: 11 for DEVA on 2026-11-01 (123 said 234)
select total from public.entity_cluster_ids_v2(array['deva'], array['\mdeva\M'], null, 20) limit 1;
```

Then `curl -s https://www.tayfhaber.com/gundem/deva` and `/gundem/dolar`: the DEVA hub lists only DEVA stories (no "devam"), the Dolar hub has no "domuz" story, and the card ages read newest first.

**Rollback:** `drop function public.entity_cluster_ids_v2(text[], text[], timestamptz, integer);` then `delete from supabase_migrations.schema_migrations where version = '125';`. The hubs fall back to 123 (the old imprecise lists) on their own.

## 126 — blindspot sibling veto (`blindspot_recall_veto_refresh`, `clusters.blindspot_veto_reason`): APPLY 126 only, no deploy-order constraint

**Why:** a public "Kör nokta" badge stayed on clusters whose silent side was covered by a live, near-identical sibling cluster. `112a68bd` showed "Kör nokta: iktidar ağırlıklı" while eight sibling clusters (among them `f4c68960` and `923ec64a`) held the bağımsız and muhalefet coverage of the same Erdoğan–Zelenski meeting. 071's veto only knows what Jev matched. On production (2026-11-01, read-only) 7 of the 19 public blindspots created in the last 48 hours are `blindspot_recall_suspect`; the new rule withdraws 6 of the 19 (16 of 61 over seven days).

**What 126 does** (additive, safe to re-apply, run as four short pieces rather than one transaction; the first starts with `set local lock_timeout = '5s'`): adds `clusters.blindspot_veto_reason` (`jev_recall` or `sibling_headline`; the CHECK is added `not valid` in the same millisecond-long transaction as the column, then validated by a separate `validate constraint` statement that takes only SHARE UPDATE EXCLUSIVE, because `add column` holds ACCESS EXCLUSIVE on `clusters` until its transaction commits and a validation scan of the 398 MB table inside it would block every read for seconds), `create or replace function` on `blindspot_recall_veto_refresh(interval, numeric)` (same signature and defaults, so the `blindspot-recall-veto` cron job at `7-59/10` and the grants carry over; cron is not touched), and runs `blindspot_recall_veto_refresh(interval '7 days')` once, in a `do` block after the transactions, taking the function's advisory lock first (the function returns 0 without working while the 10-minute cron holds it): the block retries for up to 30 seconds and then raises, so the ledger row 126 is only written after a backfill that ran. The rule: after adding the voting (`outlet`, `wire`) sources that are not yet members and that Jev matched at p ≥ 0.85 **or** that published a sibling article (title stems of at least 4 letters cut to 5 characters, at least 3 shared and Jaccard ≥ 0.5, published at most 24 hours apart, in a live cluster created within the last 72 hours), the dominant zone drops below 0.8. The search covers blindspots created in the last `greatest(48 hours, p_since)`; a sibling veto older than that is frozen and only clears when the live contract stops holding. `is_blindspot`, `blindspot_side` and `updated_at` are never written; a second run returns 0. The app never selects the new column, so no app deploy is needed.

**Order:** none. Apply with `supabase db push` (do not wrap the file in an outer transaction: the explicit `commit`s are what release the ACCESS EXCLUSIVE lock early). The backfill takes about 6 to 10 seconds on production (measured as a SELECT) and holds row locks only; reads and writes of `clusters` are never blocked longer than the millisecond-scale `add column` piece. If the backfill raises `stayed locked by another session`, just apply the migration again (every piece is idempotent). The edge functions and the app are untouched.

**Verify** (read-only):

```sql
-- the new body is live (expect 2904bdbadff34838259ffb901807cc33, 9162, t); before 126 it was ee3a003fa0225da3bbb22a3fbb7da1b0
select md5(prosrc), length(prosrc), prosecdef
  from pg_proc where oid = 'public.blindspot_recall_veto_refresh(interval,numeric)'::regprocedure;
-- the 071 cron job survived (expect 7-59/10; 7-59/20 once 144 is applied)
select schedule from cron.job where jobname = 'blindspot-recall-veto';
-- service_role only (expect f, f, t)
select has_function_privilege('anon', 'public.blindspot_recall_veto_refresh(interval,numeric)', 'execute'),
       has_function_privilege('authenticated', 'public.blindspot_recall_veto_refresh(interval,numeric)', 'execute'),
       has_function_privilege('service_role', 'public.blindspot_recall_veto_refresh(interval,numeric)', 'execute');
-- every veto has a reason, no reason without a veto (expect 0)
select count(*) from public.clusters
 where blindspot_recall_veto is distinct from (blindspot_veto_reason is not null);
-- the motivating cluster (expect t, sibling_headline)
select blindspot_recall_veto, blindspot_veto_reason from public.clusters where id = '112a68bd-68d3-4bc8-ab0b-6d12b37762b8';
-- reasons in use
select blindspot_veto_reason, count(*) from public.clusters where blindspot_recall_veto group by 1;
select count(*) from supabase_migrations.schema_migrations where version = '126';  -- 1
```

The next cron tick (within 10 minutes) must return 0 changes when nothing else moved. Known limit: title overlap cannot tell two events with the same wording, for example "Emine Erdoğan'dan 29 Ekim mesajı" against "Cumhurbaşkanı Erdoğan'dan 29 Ekim mesajı", or two "Tugay'ı kabul etti" meetings with different ministers; those withdraw a genuine badge (never invent one).

**Rollback** (nothing else depends on 126): re-apply the `create or replace function` block of `071_blindspot_recall_veto.sql` (function, comment, revoke, grant; skip its cron and backfill sections), then `select public.blindspot_recall_veto_refresh(interval '7 days');` so sibling vetoes clear (071's function does not write the reason, so stale reasons stay on cleared rows; `update public.clusters set blindspot_veto_reason = null where not blindspot_recall_veto and blindspot_veto_reason is not null;` tidies them, optional because nothing reads the column). The column may stay (nullable, unread). To drop it as well, after the function is back: `alter table public.clusters drop constraint if exists clusters_blindspot_veto_reason_check, drop column if exists blindspot_veto_reason;`. Remove ledger row 126: `delete from supabase_migrations.schema_migrations where version = '126';`.

## 132 — Eski kör nokta bayrakları (legacy bias range tools): APPLY 132 only, no deploy; operator runs the script, dry run first

**Why:** 034 re-derived `clusters.bias_distribution` for the last 48 hours only, so every older cluster still counts aggregator and niche votes, and 032 derived the public "Kör nokta" flag from that. Cluster pages contradict themselves ("Spektrum 5 kaynaktan oluşturuldu" next to "spektruma sayılmaz"; e.g. `/cluster/861b4249-f553-41b7-be98-45544008b1bc`). Measured read-only on 2026-11-01 for `updated_at < 2026-09-05`: 182,778 clusters, 66,494 store a distribution that differs from their voting members' (57,278 of them go to all zeros; 9,368 have `article_count >= 2`), 444 are flagged, 330 of those store a wrong distribution and **215 fail the rule** (at least 5 voting articles, dominant zone at least 0.8). A plain `recompute_blindspot_flags()` would also newly flag 153 older clusters that were never recall-checked, so the tools only ever *clear*.

**What 132 does** (additive, safe to re-apply, one transaction, starts with `set local lock_timeout = '5s'`): three `service_role`-only functions, no table, no index, no cron, **no backfill** (applying the file writes nothing but the ledger row):

- `legacy_bias_voter_dists(p_from, p_to)` read-only: stored vs voter-derived distribution and whether it passes the rule, per cluster with `updated_at` in `[p_from, least(p_to, p_from + 31 days))`.
- `recompute_bias_distribution_range(p_from, p_to, p_dry_run default true)` returns `(scanned, would_change, changed)`; with `p_dry_run => false` it sets `bias_distribution` where it differs.
- `clear_false_blindspots_range(p_from, p_to, p_dry_run default true)` returns `(would_clear, would_newly_flag, cleared)`; with `p_dry_run => false` it sets `is_blindspot = false, blindspot_side = null` where the flag is set and the rule fails.

They never write `updated_at` (home feed order, `/api/health`), never set a flag and never touch the recall-veto columns. A NULL or inverted window raises `22023`; a second 132 call at the same time gets `55P03`.

**Order:** apply 132 (`supabase db push`, or run the file), no deploy. Nothing changes until the operator runs the script. Needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` or the shell (https only; the key is never printed).

**Run (operator):**

1. **Dry run** (the default; every request sends `p_dry_run: true`). `min(updated_at)` of `clusters` is 2009-01-08 because of 183 stray rows older than 2026-04-01 (22 would change, none would clear); the script allows at most 200 windows, so start where the live range starts:

   ```bash
   node scripts/recompute-legacy-bias.mjs --from 2026-04-01 --to 2026-09-05
   ```

   It prints `DRY RUN: nothing is written. Re-run with --apply to write.`, one line per 7-day window and a `TOTAL` line. Compare the total with the 132 header (STEP 0 d)): as of 2026-11-01 `scanned=182595 would_change=66472 changed=0 | would_clear=215 would_newly_flag=153 cleared=0` (the header's totals include the 183 stray rows; a later merge or link re-stamps `updated_at` and moves a cluster out of the range, so the numbers can only fall). The first pass reads cold pages (3 to 5 s for the busiest windows, 0.5 s warm), so expect a few minutes. If a window stops with `57014` (the 8 s PostgREST limit), the script prints the command to resume with `--days 1`; with `55P03` wait a minute and rerun. Every window is idempotent.

2. **Snapshot the rows that will change**, per month, with a read-only `\copy` (psql against the database, not the SQL editor). Windows are 31 days at most, so April to August are one month each:

   ```sql
   \copy (select c.id, c.bias_distribution, c.is_blindspot, c.blindspot_side, c.updated_at from public.legacy_bias_voter_dists('2026-04-01', '2026-05-01') d join public.clusters c on c.id = d.cluster_id where c.bias_distribution is distinct from d.dist or (c.is_blindspot and not d.rule_ok)) to 'legacy-bias-2026-04.csv' csv header
   ```

   Repeat for `2026-05-01..2026-06-01`, `06-01..07-01`, `07-01..08-01`, `08-01..09-01` and `09-01..09-05` (change the dates and the file name). Keep the CSVs.

3. **Apply**, in a quiet window (after the dry run, which warmed the pages):

   ```bash
   node scripts/recompute-legacy-bias.mjs --from 2026-04-01 --to 2026-09-05 --apply
   ```

   Per window it recomputes first, then clears. The line shows `changed=` and `cleared=` equal to `would_change=` and `would_clear=` (lower by a few only if the live consumer re-stamped a cluster during the call; the recheck skips such a row, which is the point).

4. **Verify** by re-running the dry run of step 1: every `would_change` and `would_clear` must be 0 (`would_newly_flag` stays 153: they are not repaired). Then a dry run over the live range, `node scripts/recompute-legacy-bias.mjs --from 2026-09-05 --to <tomorrow, YYYY-MM-DD>`: `would_clear` 0 and `would_change` 0 (2 of 42,605 clusters from October differed by one late vote on 2026-11-01, unrelated to this tool; investigate if it grows). Read-only spot check of the motivating cluster:

   ```sql
   select is_blindspot, blindspot_side, bias_distribution from public.clusters where id = '861b4249-f553-41b7-be98-45544008b1bc';  -- expect f, null, the voters only
   ```

5. **The 153 clusters that would newly flag** are for the founder to decide, never flagged by the tools (they were never recall-checked by 071/126). Read-only list, per month as in step 2:

   ```sql
   select c.id, c.title_tr, c.updated_at, c.article_count, c.blindspot_recall_veto, c.blindspot_veto_reason, d.dist
     from public.legacy_bias_voter_dists('2026-04-01', '2026-05-01') d
     join public.clusters c on c.id = d.cluster_id
    where not d.is_blindspot and d.rule_ok
    order by c.updated_at desc;
   ```

   Flagging one is a founder action (`update public.clusters set is_blindspot = true, blindspot_side = ...`) after `blindspot_recall_veto_refresh` has looked at it; this runbook does not do it.

**Expected effects:** the "Kör nokta" badge goes from 215 old clusters; the bias bars of about 66k old clusters stop counting aggregator and niche votes (the 9,368 with `article_count >= 2` are the visible ones); closed `/hafta` weeks for April to September shift slightly; cached pages refresh on their normal `cacheLife` (the tools revalidate nothing). Known limit: `blindspot_side` of a flag that stays is not recomputed (about 21 of the 229 surviving flags store a side that is not the top category of the voters).

**Rollback:** the functions: `drop function if exists public.recompute_bias_distribution_range(timestamptz, timestamptz, boolean); drop function if exists public.clear_false_blindspots_range(timestamptz, timestamptz, boolean); drop function if exists public.legacy_bias_voter_dists(timestamptz, timestamptz); delete from supabase_migrations.schema_migrations where version = '132';`. The **data** written by `--apply` is restored only from the CSV snapshots of step 2, per file, and only for clusters nobody re-stamped since:

```sql
create temp table snap (id uuid, bias_distribution jsonb, is_blindspot boolean, blindspot_side text, updated_at timestamptz);
\copy snap from 'legacy-bias-2026-04.csv' csv header
update public.clusters c
   set bias_distribution = s.bias_distribution, is_blindspot = s.is_blindspot, blindspot_side = s.blindspot_side
  from snap s
 where c.id = s.id and c.updated_at = s.updated_at;
```

## 143 — /hafta "Ayrışan Kelimeler" sample (`weekly_words_sample`, cron `weekly-words-sample`): APPLY 143, BACKFILL ONCE, DEPLOY IN ANY ORDER

**Why:** a cold `/hafta` fill read 21 (zone x day) article samples and could pass the 4 s reader cap. 143 precomputes the 300-article sample per Istanbul day and zone every hour into a tiny table (at most 32,400 rows, about 12 MB; no index on any large table), and the app reads that table, falling back to the old article reads for any day it has no row for.

**What 143 does** (additive, safe to re-apply, one transaction): table `public.weekly_words_sample` (RLS on, no policy, `service_role` select only, nothing for `anon`/`authenticated`), function `public.weekly_words_sample_refresh(p_days)` (`service_role` only), pg_cron job `weekly-words-sample` at `38 * * * *` that calls it with 2 days. Details and dry-run records are in the file header.

**Order:** apply 143 (the first job run is the next :38), run the one-off backfill below, deploy the app whenever. Until the table exists the page logs one `[weekly-words] weekly_words_sample is not available` warning and reads the articles directly.

```sql
set statement_timeout = '120s'; select public.weekly_words_sample_refresh(8);
```

**Deleted articles (orphan sweep):** the table keeps its own copy of title, url and source id and has no foreign key on `article_id`, and the hourly job rewrites only today and yesterday. So each run ends with an orphan sweep: it deletes the rows of the page window (today and the 6 days before it) whose article is no longer in `public.articles` (one primary-key lookup per row, at most 6,300 an hour). A deleted article therefore leaves `/hafta` at the next :38 tick, plus the 6 h cache.

**Takedown, to remove an article from `/hafta` at once:** after deleting it from `public.articles`, delete its sample copy and drop the cache tag:

```sql
delete from public.weekly_words_sample where article_id = '<id>';
```

then clear the cache: `POST /api/revalidate` with `Authorization: Bearer $CRON_SECRET` and body `{"tags":["weekly-words"]}` (the tag is on the route's allowlist).

**Verify:** `select jobname, schedule from cron.job where jobname = 'weekly-words-sample';` (one row), `select day, zone, count(*) from public.weekly_words_sample group by 1, 2 order by 1 desc, 2;` (300 per cell for past days), `select pg_size_pretty(pg_total_relation_size('public.weekly_words_sample'));` (never above about 12 MB).

**Rollback** (nothing else depends on 143): `select cron.unschedule('weekly-words-sample'); drop function public.weekly_words_sample_refresh(integer); drop table public.weekly_words_sample; delete from supabase_migrations.schema_migrations where version = '143';`. The reader tolerates the missing table (one warning per fill, then the article reads).

## 144 — blindspot-recall-veto cadence (`7-59/10` -> `7-59/20`): APPLY 144 only, no deploy

**Why:** since 126 every 10-minute run of the `blindspot-recall-veto` cron starts cold (a Micro instance with 256 MB `shared_buffers` against a 5.2 GB database; 126's "warm because it runs every 10 minutes" claim did not hold). The mean run went from 2.1 s to 5.2 s: 144 runs, 750 DB-seconds and 0 failures in the last 24 h before 144, worst run 13.70 s. The cost is database time only; no page got slower.

**What 144 does** (additive, safe to re-apply, one transaction): a guarded `cron.alter_job` that moves the job, found by name, to `7-59/20 * * * *` (minutes :07, :27 and :47; 72 runs a day instead of 144, about 375 s a day). It keeps the `:x7` slot of 109's minute map, so it still never shares a minute with `jev-shadow` (`:x0`), `cluster-topics-refresh` (`:x3`) or `ops-health-snapshot` (`:x4`). The command, the function and the grants are untouched, and no data is written. A missing pg_cron or a missing job raises a notice and skips. The dry-run records are in the file header.

**Order:** none. The app and the edge functions are untouched. Apply 144 with `supabase db push`.

**Verify:**

```sql
-- the job moved (expect 7-59/20 * * * *)
select schedule from cron.job where jobname = 'blindspot-recall-veto';
-- after 24 h: expect about 72 runs, about 375 s, 0 failed
select count(*) as runs,
       round(avg(extract(epoch from (d.end_time - d.start_time)))::numeric, 2) as avg_s,
       round(sum(extract(epoch from (d.end_time - d.start_time)))::numeric) as total_s,
       count(*) filter (where d.status = 'failed') as failed
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
 where j.jobname = 'blindspot-recall-veto'
   and d.start_time > now() - interval '24 hours';
```

`blindspot_veto_cron_min` in `ops_health_report()` (the only check that watches this job) must stay `pass`.

**Margin and trade-offs:** the check fails when the last succeeded run is more than 30 minutes old. The steady-state worst case is 20 min plus the worst observed run (13.7 s), about 20.2 min, so about 9.8 min of margin; the 10-minute `ops_health_snapshot` tick (`:x4`) sees at most about 17 min. `cron_failed_runs_30m` is unaffected. Two costs: one failed run now trips `blindspot_veto_cron_min` (the next success is about 40 min after the previous one, where before three consecutive misses were needed), and a vetoed "Kör nokta" badge (or a veto that should clear) can stay up to 10 minutes longer. `tests/migrations/144-blindspot-veto-cadence.test.ts` reads the 30-minute threshold out of the newest `ops_health_report()` definition, so a later threshold edit breaks it.

**Rollback** (nothing else depends on 144):

```sql
select cron.alter_job((select jobid from cron.job where jobname = 'blindspot-recall-veto'), schedule := '7-59/10 * * * *');
delete from supabase_migrations.schema_migrations where version = '144';
```

## 145 — ops_health_report row 17 `anon_surface`: APPLY 145 only, no deploy

**Why:** `tests/guards/anon-surface.test.ts` scans migration *text* only, so a privilege that anon or authenticated gets from a dashboard change, or through the `supabase_admin` default ACL (tables `arwdDxtm`, sequences `rwU`, functions `X`; `postgres` cannot alter it), is invisible to CI and to every row of `ops_health_report()`. Today nothing is exposed (0 table grants to either role; every anon read goes through the five allowlisted RPCs), but Supabase Auth signup is open although the app never uses it (`auth.users` holds 0 rows) and 13 dormant `USING (true)` SELECT policies sit on `public`: one stray privilege would make articles, clusters or sources public. Row 17 turns such a privilege into a `fail` within minutes (hunt 19, h19-security-1).

**What 145 does** (additive, one transaction, safe to re-apply): re-creates `ops_health_report()` with 136's text verbatim through row 16 (the test compares the raw text) and appends row 17, `anon_surface` (threshold 1). `fail` when `anon` or `authenticated` holds any privilege on a table, view, materialized view, foreign or partitioned table or sequence of `public` (`has_table_privilege` / `has_sequence_privilege` and the relation ACLs, which also catches PG17 `MAINTAIN`), or can execute a SECURITY DEFINER function there other than the five allowlisted RPCs (`saved_clusters(uuid[])`, `merged_cluster_map()`, `source_slugs()`, `source_slug_exists(text)`, `saved_clusters_v2(uuid[])`, each exempt by its full signature, so an anon-executable overload of one of those names is counted; trigger functions and extension members are not counted). `warn` when either role can execute an invoker function, or `auth.users` holds a row (signup abuse). `skip` without the roles, `unknown` on an error. The detail carries counts only, never an object name or user data: the heartbeat prints every detail to the job log and `$GITHUB_STEP_SUMMARY` of a public repository, so the names come from the service-role query in `docs/ops-heartbeat.md`, "Anon yüzeyi". The function returns 17 rows; `service_role` only; no table, no policy, no grant, no data change (the 13 policies and the platform default ACL stay as they are). The heartbeat, `/durum` and `/api/health` do not depend on the row count or the names. The dry-run records, the production Step 0 numbers and the mutation checks are in the file header. **Production reads `pass` today** (0 of 102 relations and 0 of 137 functions exposed, all five allowlisted signatures present once, 0 users, 6-9 ms).

**Order:** none. Apply 145 with `supabase db push`; nothing to deploy (no app, no edge function). The next heartbeat run (30 minutes), or the next 10 minute snapshot (131), shows the row.

**FOUNDER STEP (about one minute, not code, any order relative to 145):** in the Supabase Dashboard, Authentication, Sign In / Providers, turn off `Allow new users to sign up` and disable the Email provider (unused: no code calls Supabase Auth). Verify (read-only; never paste the key anywhere):

```bash
curl -s "$SUPABASE_URL/auth/v1/settings" -H "apikey: $SUPABASE_ANON_KEY"
# expect "disable_signup":true
```

Until you do, row 17 stays `pass` while `auth.users` is empty and turns `warn` on the first signup.

**Verify** (read-only):

```sql
select count(*) from public.ops_health_report();   -- 17
select check_name, status, observed, threshold, detail from public.ops_health_report() where check_name = 'anon_surface';
-- expect pass / 0 / 1 / anon/authenticated yetkisi yok: tablo/dizi 0, definer fonksiyon 0, invoker fonksiyon 0 (5 izinli RPC hariç) · auth.users 0
-- service_role only (expect f, f, t)
select has_function_privilege('anon', 'public.ops_health_report()', 'execute'),
       has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'),
       has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
-- md5(prosrc) was fa5581a2e5edd98ce214b9621ecef7a4 (30,774 characters) right after 145 (historical:
-- 150 replaces the function). Current value: 2445cd7d15a23d4af88d42ddf79ac2ff, 38,876 characters
-- (migration 150, verified on production 2026-11-02).
select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
```

When it fails or warns, `docs/ops-heartbeat.md`, "Anon yüzeyi (migration 145, row 17)", has the two read-only queries that name the exposed objects (the report itself carries counts only) and the revoke for each kind of object. The `warn` rows add one snapshot row every 10 minutes (131) until the cause is fixed.

**Rollback** (nothing else depends on 145): re-run ONLY 136's `ops_health_report()` section, the text of `136_ops_heartbeat_app_side.sql` from `create or replace function public.ops_health_report()` through `grant execute on function public.ops_health_report() to service_role;` (about 525 lines; it re-creates the function with its comment, revoke and grant, which returns the report to 16 rows, md5 `a2b0b84c193022c78547beb0296e5f0c`), then `notify pgrst, 'reload schema';`, then remove ledger row 145: `delete from supabase_migrations.schema_migrations where version = '145';`. Do NOT re-apply `136_ops_heartbeat_app_side.sql` as a whole file: its section 2 re-creates `public.ops_db_size_limits()` with the defaults `7000 / 7600`, which silently overwrites the limits you set with `create or replace` (70% / 85% of the provisioned disk) and can mute a real disk-size warn or fail (or raise a false one), and its section 4 re-schedules the `ops-cron-route-runs-prune` job.

## 148 — blindspot sibling veto, unclustered siblings: APPLY 148 only, no deploy

**Why:** 126's sibling veto only counts siblings that sit in a live cluster, and the clusterer admits only `politika` / `son_dakika` articles, so a story the silent side ran under `dunya`, `genel`, `yasam` or `ekonomi` could never withdraw a false "Kör nokta" badge (over 96 hours: 6,391 voting-source politika/son_dakika articles against 19,132 in other categories, 75% out of reach). `bdbf9948` shows "kör nokta (Muhalefet)" with 5 iktidar members while cumhuriyet `ca13efe9` (dunya), birgun `d4121d30` (dunya), yenicag `16b6ec7f` (genel) and evrensel `5599ab56` (yasam) ran the same story the same morning and sit in no cluster (hunt 22, h22-editorial-1). On the real headlines cumhuriyet, evrensel and yenicag match a member title (3 muhalefet sources, 5/8 = 0.625 < 0.8); birgun's shorter headline does not.

**What 148 does** (additive, ONE short transaction, safe to re-apply): `create or replace function public.blindspot_recall_veto_refresh(interval, numeric)` with 126's body verbatim plus ONE `union all` arm in the `scand` CTE: `public.articles` joined to `public.sources`, `kind in ('outlet','wire')`, `coalesce(category, '') not in ('politika','son_dakika')`, the `min/max(wart.published_at) ± 24 hours` bounds cut by the clock (`greatest(min − 24 h, now() − v_scope − 48 hours)` and `least(max + 24 h, now())`: a member date is feed data, ingest clamps only future dates, and production holds members dated 2022-01-13/14, which would otherwise stretch this arm to a sequential scan of about 1.06M articles; read-only, the clamped arm returns 19,187 rows with such a member in place), the article id as pseudo cluster id (so `st.cluster_id <> w.cluster_id` and the per-article token count still hold; no anti-join, a clustered article that lands in both arms is absorbed by the `DISTINCT` in `sibling`). Window 24 h, minShared 3, Jaccard 0.5, `wmem`, the freeze, the reason `sibling_headline`, the three-column UPDATE and the grants (service_role only) are unchanged; `tests/migrations/148-blindspot-unclustered-siblings.test.ts` removes the new arm and requires the rest of the body to equal 126's. Then the function comment, revoke, grant and ledger row 148. One cron change: `cron.alter_job` (found by job name `blindspot-recall-veto`, guarded like 144, schedule `7-59/20` and active flag untouched) sets the command to `set local statement_timeout = '120s'; select public.blindspot_recall_veto_refresh();`, so a pathological run fails fast (120 s is ten times the worst observed run, 13.7 s; the timeout lives in the command because a SET on the function does not reach the already running statement, and pg_cron on production runs jobs through libpq as one simple-query string where the timeout applies to each statement). One timed-out run is a failed run: it shows in `cron_failed_runs_30m` and trips `blindspot_veto_cron_min` like any failed run since 144. No index, no table lock, **no backfill**. The app never selects the veto reason: no deploy.

**Order:** none. Apply with `supabase db push`. The dry-run (`tests/migrations/sql/148-blindspot-unclustered-siblings-dryrun.sql`, PG15, applied twice on two fresh clusters, `DRYRUN 148 OK`) records the 16 scenarios and the cron job on a stub `pg_cron` (including a 2022-dated member that must not widen the arm).

**Perf** (read-only EXPLAIN ANALYZE of the CTE chain as a SELECT on production, 2026-11-02): cold 5.59 s, warm 1.28 s; 126's chain 0.50 s warm (3.46 s cold per 144). The cron runs every 20 minutes (144; ops threshold 30 minutes), so the 10 s bar holds with room. The new arm reads about 18k articles through `idx_articles_published_at` in 40 ms and grows `scand` from 5,783 to 18,912 titles; the cold time is dominated by the Jev `matched` arm and arm 1's `cluster_articles` scan, which 126 already paid. Expect the cron's mean run time to rise by about 0.8 s.

**Expected withdrawals:** the cron only re-scores blindspots updated or recall-checked within 26 hours (the `win` set), so the default run newly vetoes ONE public blindspot today: `07f6d2d0` (İmamoğlu's message to the farmer Emine Teğin; birgun `58a754aa`, evrensel `9bb83d50` and karar `f8336999` ran it unclustered; same event, 0 false vetoes of 1). Going forward every new badge is checked against unclustered coverage within its first 26 hours. Known limit as in 126: title overlap cannot tell two events with the same wording; the error direction is "badge hidden", never "badge invented".

**Verify** (read-only):

```sql
-- the new body is live (md5 differs from 126's 2904bdbadff34838259ffb901807cc33); the arm marker is present (expect t)
select md5(prosrc), length(prosrc), position('148: unclustered candidates' in prosrc) > 0, prosecdef
  from pg_proc where oid = 'public.blindspot_recall_veto_refresh(interval,numeric)'::regprocedure;
-- service_role only (expect f, f, t)
select has_function_privilege('anon', 'public.blindspot_recall_veto_refresh(interval,numeric)', 'execute'),
       has_function_privilege('authenticated', 'public.blindspot_recall_veto_refresh(interval,numeric)', 'execute'),
       has_function_privilege('service_role', 'public.blindspot_recall_veto_refresh(interval,numeric)', 'execute');
-- reason in use only on vetoed rows (expect 0)
select count(*) from public.clusters where blindspot_recall_veto is distinct from (blindspot_veto_reason is not null);
select count(*) from supabase_migrations.schema_migrations where version = '148';  -- 1
```

The cron run after the apply should change about one row (`07f6d2d0`), then return 0. Check `cron.job_run_details` of job `blindspot-recall-veto` a day later: mean run time should be about 6 s, max well under 30 s, 0 failed.

**FOUNDER NOTE (production write, not part of 148):** `bdbf9948` is still inside the 48-hour creation scope (created 2026-10-31 12:25 UTC, scope ends 2026-11-02 12:25 UTC) but outside the cron's `win` set (updated 2026-10-31 13:13, recall-checked 2026-11-01 00:00, both older than 26 hours), so 148 alone will not withdraw its badge. A one-off `select public.blindspot_recall_veto_refresh(interval '72 hours');` after applying 148 would newly veto `07f6d2d0`, `bdbf9948` and `7b66bbcf` (read-only simulation: 3.2 s wall; 126 at 72 hours vetoes none of the three; all three hand-checked as the same event). The other solid cases from the hunt (`31b0354f`, `5dda5833`) were created on 2026-10-26 (updated and recall-checked on 10-26 and 10-27, still public, not vetoed), so they need a window of about 7 days; 126's own backfill used `interval '7 days'` and took 5.8 s, and the unclustered arm makes a 7-day run heavier, so measure the SELECT variant first (it was not measured here). 148 never re-scores outside the cron's own scope.

**Rollback** (nothing else depends on 148): re-apply piece (c) of `126_blindspot_sibling_veto.sql` (the `create or replace function` block, its comment, revoke and grant; skip the column, constraint, backfill and ledger pieces), put the cron command back (`select cron.alter_job((select jobid from cron.job where jobname = 'blindspot-recall-veto'), command := 'select public.blindspot_recall_veto_refresh();');`), then remove ledger row 148 (`delete from supabase_migrations.schema_migrations where version = '148';`). Vetoes found through unclustered siblings keep their stored `sibling_headline` reason until the next run inside the 48-hour scope recomputes them (they clear once the evidence is gone); older ones stay frozen like any 126 veto.

## 149 — source_article_key parent-segment ids (evrensel /haber/<id>/, indyturk /node/<id>/): APPLY 149 + REDEPLOY ingest, any order

**Why:** evrensel keeps its CMS id in `/haber/<id>/<slug>` and indyturk in `/node/<id>/[<section>/]<slug>`, a PARENT segment followed by a slug that changes with every headline edit. 113's key reads only the last path segment (so that `/kategori/123456/slug` section ids never merge stories), which gave these two outlets no key at all: of 1,103 evrensel and 295 indyturk rows in 7 days, 1 and 0 carried a `source_article_key`, so the "same id, new url" drop in ingest never fired. 76 evrensel ids and 7 indyturk ids have two or more rows (183 + 14 rows, in 64 + 11 different clusters): evrensel `6007631` (b3a2b8e4 09:18Z and 829e55e4 09:33Z, slugs `...50-tlyi-asacak` and `...50-tl-yi-asacak`, identical title) and indyturk `784651` (6cf47ad9 09:48Z and 5e0c2aa6 10:30Z, the url gained a `/kültür/` segment, identical title) (hunt 24, h24-feeds-1).

**What 149 does** (ONE short transaction, additive, safe to re-apply): `create or replace function public.source_article_key(text)` with 113's body verbatim plus two host-anchored regexes tried first (`foreach v_re in array`), the SQL twin of `PARENT_SEGMENT_KEY_RES` in `supabase/functions/_shared/rss/article-key.ts`: `^https?://(?:www\.)?evrensel\.net/haber/([0-9]{6,20})(?:/|$)` and the `indyturk\.com/node/` twin, matched case-insensitively on the whole url, the capture still passing the date-shape and round-number guards (a rejected capture falls through to the last-segment rule). `evil.test/haber/...`, `evrensel.net.evil.test` and `notevrensel.net` do not match; any other `/kategori/123456/slug` still gives no key. Same security definer, `search_path = ''`, `revoke ... from public, anon, authenticated`, `grant execute ... to service_role` as 113. **No backfill, no article update, no index change, no table touched.** `tests/migrations/149-source-article-key-parent-segment.test.ts` checks the regexes verbatim against the TS module, that the body without the new block equals 113's, and that 149 is the newest definition; `tests/migrations/sql/149-source-article-key-parent-segment-dryrun.sql` (PG15, applied twice on two fresh clusters, `DRYRUN 149 OK`) records the md5 gate (production's `source_article_key` body is `dbbba7e0e939036ef5c4298b593b7474`, 1397 characters, equal to 113's; 149's is `7beb33a72d1009004ef74e82f3fb0f28`, 2498).

**Order:** none. Ingest computes the key in TypeScript (`sourceArticleKeyFor`), so the forward fix is the **ingest redeploy** (`npx supabase functions deploy ingest --no-verify-jwt`); the SQL function is called only by the operator backfill `articles_source_key_backfill`, so applying 149 changes no behaviour by itself and applying it before, after or without the redeploy is harmless. Apply with `supabase db push`.

**Only re-titles of articles ingested AFTER the deploy are deduped.** Rows stored before the deploy keep a NULL key (no backfill), so a re-title of an item that is already stored and still in the feed on deploy day can insert one more row; that row is the first keyed one and later re-titles drop against it. The roughly 250 existing duplicate rows stay as they are. A backfill of the two sources and a decision on merging those rows is a separate, optional operator step (not in this wave).

**What to expect** (7-day replay, read-only, before the deploy): the twin drop would have dropped 94 of the 107 extra evrensel rows and 6 of the 7 extra indyturk rows. The other 13 + 1 groups share an id but fail the title gate (`TITLE_TWIN_MIN_JACCARD` 0.2): live updates whose headline moved on (works accident -> the worker's death, derby line-ups -> first half, editors detained -> released). They stay separate rows, as before, so the gate never merges two different stories. Hand-judged: no different stories share an id in either source. Corpus: `tests/fixtures/ingest-corpus.json` keys change for 7 urls (6 evrensel, 1 indyturk), all null -> id; `content_hash` is untouched.

**Verify** (read-only, as service_role; anon and authenticated cannot call it):

```sql
-- the new body is live (expect 7beb33a72d1009004ef74e82f3fb0f28, 2498, i, t)
select md5(prosrc), length(prosrc), provolatile, prosecdef
  from pg_proc where oid = 'public.source_article_key(text)'::regprocedure;
-- both incident pairs now share a key (expect 6007631, 6007631, 784651, 784651)
select public.source_article_key('https://www.evrensel.net/haber/6007631/akaryakita-zam-ustune-zam-otogaza-9-tl-zam-bekleniyor-litresi-50-tlyi-asacak?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication'),
       public.source_article_key('https://www.evrensel.net/haber/6007631/akaryakita-zam-ustune-zam-otogaza-9-tl-zam-bekleniyor-litresi-50-tl-yi-asacak?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication'),
       public.source_article_key('https://www.indyturk.com/node/784651/heatin-83-ya%C5%9F%C4%B1ndaki-usta-y%C3%B6netmeni-kazara-kendini-vurdu'),
       public.source_article_key('https://www.indyturk.com/node/784651/k%C3%BClt%C3%BCr/heatin-83-ya%C5%9F%C4%B1ndaki-usta-y%C3%B6netmeni-kazara-kendini-vurdu');
-- host anchoring and section ids stay unkeyed (expect null, null, null)
select public.source_article_key('https://evil.test/haber/6007631/x'),
       public.source_article_key('https://www.evrensel.net.evil.test/haber/6007631/x'),
       public.source_article_key('https://x.test/kategori/123456/slug');
-- service_role only (expect f, f, t)
select has_function_privilege('anon', 'public.source_article_key(text)', 'execute'),
       has_function_privilege('authenticated', 'public.source_article_key(text)', 'execute'),
       has_function_privilege('service_role', 'public.source_article_key(text)', 'execute');
select count(*) from supabase_migrations.schema_migrations where version = '149';  -- 1
```

After the ingest redeploy (replace `<deploy>` with the deploy time), new rows carry keys and re-titles stop piling up (expect keyed > 0 within two cycles, then a handful of groups at most, each one failing the title gate):

```sql
select s.slug, count(*) filter (where a.source_article_key is not null) keyed, count(*) total
  from public.articles a join public.sources s on s.id = a.source_id
 where s.slug in ('evrensel', 'indyturk') and a.created_at > timestamptz '<deploy>' group by 1;
```

**Rollback** (the TS rules ship with the ingest function, this only restores the SQL twin): redeploy the previous ingest function if the TypeScript rules must go too; re-run ONLY 113's `source_article_key` section (the `create or replace function public.source_article_key(p_url text)` block, its comment, revoke and grant; not the column, index or backfill pieces), which restores the body with md5 `dbbba7e0e939036ef5c4298b593b7474`; then remove ledger row 149: `delete from supabase_migrations.schema_migrations where version = '149';`.

## 150 — queue_lag + cron_jobs_stalled (`ops_health_report` rows 18 and 19, table `ops_cron_expected`): APPLY 150 only, no deploy

**Why:** nothing watched clustering. The deployed report never mentioned pgmq, `cluster_work` or `image_backfill`, and row 1 counts only runs with `status = 'failed'`, so an unscheduled or deactivated job (`cluster-drain`, `image-drain`, `prune-nightly`, `ops-health-snapshot` itself) produced no row and read `pass`. The failure mode is the core product (home and cluster pages) freezing while the ingest rows stay green. 150 makes the report notice both (hunt 24, h24-ops-1).

**What 150 does** (additive, one transaction, safe to re-apply):

- adds `public.ops_cron_expected` (`jobname` primary key, `max_gap interval`, `note`): RLS on, no policy, readable by `service_role` only, nothing granted to `anon` or `authenticated`. It is seeded with the 20 jobs that tick all day (the note is the schedule; weekday-only and weekly jobs are not listed);
- re-creates `ops_health_report()` with 145's text verbatim through row 17 and appends row 18 `queue_lag` (depth and age of the oldest visible message of `cluster_work` and `image_backfill`, plus messages archived in the last 24 hours that count as poison (150 counted `read_ct` 3 or more; 167 corrected it to `read_ct > 3`, the 4th read, the consumers' own `MAX_READS` contract); warn at 300 s / 1800 s, fail at 900 s / 3600 s) and row 19 `cron_jobs_stalled` (every job in `ops_cron_expected` is scheduled, active and has started a run within its `max_gap`). The function returns 19 rows; the detail carries counts and job names only, never `cron.job.command`, a run's `return_message` or a message body;
- adds, changes and unschedules no pg_cron job.

**Order:** none. Apply 150 only (`supabase db push`). There is no Edge Function deploy and no app deploy; the next heartbeat run (30 minutes), or the next 10 minute snapshot (131), shows rows 18 and 19.

**Standing rule: every new pg_cron job also goes into `public.ops_cron_expected`.** Row 19 watches only the jobs listed there, so a job added by a later migration without its row can stop for days unnoticed. Put the `insert into public.ops_cron_expected (jobname, max_gap, note) values (...) on conflict (jobname) do nothing` next to the `cron.schedule` call (guarded with `to_regclass('public.ops_cron_expected') is not null`, as 154 does for its note), and keep the note equal to the schedule; `docs/ops-heartbeat.md`, "Kuyruk ve cron canlılığı", has the `max_gap` rule and how to tune or retire a row.

**Verify** (read-only):

```sql
select count(*) from public.ops_health_report();   -- 19
select check_name, status, observed, threshold, detail
  from public.ops_health_report()
  where check_name in ('queue_lag', 'cron_jobs_stalled');
-- cron_jobs_stalled: pass / 0 / 1 / "20 iş izleniyor". queue_lag: pass, or warn while the detail says
-- "zehirli (24 sa): N" with N > 0 (messages archived with read_ct > 3, the 4th read, in the last 24 hours; with
-- 150 to 161 it counted read_ct 3 or more and read warn with N = 3 on 2026-11-02 and N = 11 on 2026-11-06 for messages
-- that were processed on their 3rd read; 167 fixed that). Look at the a_image_backfill / a_cluster_work counts by read_ct in
-- Troubleshooting, "image_backfill queue is stuck".
select count(*) from public.ops_cron_expected;      -- 20
-- md5(prosrc) 2445cd7d15a23d4af88d42ddf79ac2ff, 38,876 characters (verified on production 2026-11-02)
select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
-- service_role only (expect f, f, t)
select has_function_privilege('anon', 'public.ops_health_report()', 'execute'),
       has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'),
       has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
```

**Rollback** (nothing else depends on 150): re-run ONLY 145's `ops_health_report()` section, the text of `145_ops_anon_surface_check.sql` from `create or replace function public.ops_health_report()` through `grant execute on function public.ops_health_report() to service_role;` (it returns the report to 17 rows, md5 `fa5581a2e5edd98ce214b9621ecef7a4`), then remove the table `public.ops_cron_expected`, run `notify pgrst, 'reload schema';` and remove ledger row 150 (`delete from supabase_migrations.schema_migrations where version = '150';`).

## 151 — attach-only admission, SHADOW (`cluster_attach` queue, `cluster_attach_shadow`, trigger `articles_cluster_attach_probe`): APPLY 151, THEN DEPLOY cluster-consumer, REVIEW 48 H, THEN DECIDE `CLUSTER_ATTACH_MODE`

**Why:** the politics gate is decided per article. On 2026-11-02 the "32 ilde FETÖ operasyonu" story had 13 clustered rows (18 now) in `304a47ce`, and nine rows with the same or a near-identical headline sat unclustered in `genel` next to it (hurriyet `2f93603f` is character-identical to aksam `26ede371`). `enqueue_cluster_work` (025) only enqueues `politika` / `son_dakika`, so those articles never reach the clusterer and the cluster's bias bar misses TRT Haber, CNN Türk, Hürriyet, Karar and BirGün (hunt 25, h25-clusters-3). 148's sibling veto only hides the false-blindspot symptom.

**What 151 does** (additive, ONE short transaction, safe to re-apply): the new pgmq queue `cluster_attach` (024's guard) with every privilege on its two tables revoked from `public`, `anon`, `authenticated`; `public.cluster_attach_shadow` (`article_id` primary key and foreign key `on delete cascade`, `cluster_id` with no foreign key, `score`, `lane`, `mode`, `created_at`; RLS on, no policy, `service_role` select + insert only, 140's model); `public.enqueue_cluster_attach_probe()` (SECURITY DEFINER, `search_path = ''`, owner postgres, execute revoked from anon/authenticated/public, a swallowed exception: a probe never fails an ingest insert) and the trigger `articles_cluster_attach_probe` (after insert, WHEN category in genel, ekonomi, dunya, yasam, teknoloji; the function also requires an outlet or wire source, so aggregators, niche sources, spor and null categories never enqueue). **025's function and trigger are not touched**: the politika path stays byte-identical (the dry run gates on production's body, md5 `858efd334d1586fdf340af3835c2ca9f`, which is 025's body without its comments). No cron job, no data rewrite, no backfill.

**Why a new queue:** `cluster_work` carries ~78 messages an hour, the attach candidates ~174 an hour (467 at the peak hour). One FIFO queue would delay politika work and trip 150's `queue_lag` warning, and a per-drain cap on it would push over-cap messages toward the poison threshold. The consumer reads `cluster_attach` only after `cluster_work` ran dry, once, at most 25 messages (`planAttachRead`), and deletes a successful message instead of archiving it (037's retention covers only the two older queues).

**Order:** apply 151 (`supabase db push`; the trigger step takes an ACCESS EXCLUSIVE lock on `public.articles` under `lock_timeout = '5s'`: if the table is busy it fails fast and rolls back, run it again at a quieter minute), then `npx supabase functions deploy cluster-consumer --no-verify-jwt`. Either order is safe: a function deployed before the migration warns once per isolate (`cluster_attach read failed`) and drains politika as before; a migration applied before the function lets about 3 messages a minute wait, and the consumer deletes the ones older than 6 hours as stale.

**`CLUSTER_ATTACH_MODE`** (a Supabase function secret; strict parse, `supabase secrets set CLUSTER_ATTACH_MODE=<value>`):

| value | meaning |
|---|---|
| unset, `shadow`, or anything not listed below (`""`, `LIVE`, ` live`, `on`, `1`, ...) | **shadow (the default)**: each decision is written to `cluster_attach_shadow` with mode `shadow`; no cluster or article change, the processed message is deleted |
| `off` (the exact string) | the `cluster_attach` queue is not read at all; messages wait (and expire as stale once read later) |
| `live` (the exact string) | the article is stamped `politics_admitted_at` (so the reader's 60% politics share, `isPoliticsMember`, keeps counting the cluster) and linked through `cluster_link_atomic`; a row with mode `live` is written; the cluster page is revalidated. A failed link clears the stamp it set |

Garbage never means live. **Nothing in this change sets `live`.** The evidence is only the identical folded headline, an equal strict fingerprint, or the headline lane (identical numerals, >= 4 shared stems, within 6 hours), against a cluster with >= 60% politics members that does not hold the article's source and has no twin within 0.05; it never creates a cluster and never calls the ensemble, tf-idf, MinHash, entities or Jev.

**Acceptance (read-only, before this PR):** the last 24 h of unclustered non-gate outlet/wire rows (4,412) replayed against the 48 h politics clusters (1,938): 73 would attach (18 exact-title, 55 headline), 4,325 no-match, 10 stale, 2 same-source, 2 ambiguous; all 73 read by hand against the cluster and the evidence member, **0 wrong**. Of the finding's nine rows, three attach (hurriyet `2f93603f`, aydinlik `2ae4c098`, birgun `5401d734`); five with different stems ("41 tutuklama", "72 gözaltı") stay unclustered by design and one is a niche source.

**Verify** (read-only):

```sql
select to_regclass('public.cluster_attach_shadow');                                          -- the table
select relrowsecurity from pg_class where oid = 'public.cluster_attach_shadow'::regclass;   -- t
select has_table_privilege('anon', 'public.cluster_attach_shadow', 'select'),
       has_table_privilege('authenticated', 'public.cluster_attach_shadow', 'insert'),
       has_table_privilege('service_role', 'public.cluster_attach_shadow', 'insert'),
       has_table_privilege('service_role', 'public.cluster_attach_shadow', 'update');       -- f, f, t, f
select count(*) from pgmq.list_queues() q where q.queue_name = 'cluster_attach';            -- 1
-- 025's trigger and function are unchanged (expect 858efd334d1586fdf340af3835c2ca9f)
select md5(prosrc) from pg_proc where oid = 'public.enqueue_cluster_work()'::regprocedure;
select tgname, pg_get_triggerdef(oid) from pg_trigger
 where tgname in ('articles_cluster_enqueue', 'articles_cluster_attach_probe') and not tgisinternal;
-- the queue stays shallow (a few messages, oldest seconds)
select count(*), min(enqueued_at) from pgmq.q_cluster_attach;
select count(*) from supabase_migrations.schema_migrations where version = '151';           -- 1
```

**The 48-hour review** (read every row before flipping to `live`; expect about 75 rows a day, nearly all `headline` or `exact-title`; `fingerprint` should be rare):

```sql
select s.created_at, s.lane, round(s.score::numeric, 3) score, src.slug, a.category,
       a.title as article_title, c.title_tr as cluster_title, c.article_count, s.cluster_id, s.article_id
  from public.cluster_attach_shadow s
  join public.articles a on a.id = s.article_id
  join public.sources src on src.id = a.source_id
  left join public.clusters c on c.id = s.cluster_id
 where s.created_at >= now() - interval '48 hours'
 order by s.created_at desc;
-- the evidence for one row: the cluster's members
select a.published_at, src.slug, a.category, a.title
  from public.cluster_articles ca join public.articles a on a.id = ca.article_id
  join public.sources src on src.id = a.source_id
 where ca.cluster_id = '<cluster_id>' order by a.published_at;
-- how the decisions split
select lane, mode, count(*) from public.cluster_attach_shadow group by 1, 2 order by 3 desc;
```

Also read the function logs: the drain summary line carries `attach {mode, read, would_attach, attached, by_reason, failed, delete_errors, depth_after, oldest_age_after_s}`. `by_reason` shows why articles were NOT attached (`no-match`, `stale`, `same-source`, `ambiguous`, `below-share`, `in-gate`, `not-found`). A growing `depth_after` means the cap of 25 a drain is not enough at peak (measured peak 7.8 a minute) or `cluster_work` never runs dry.

**After the decision:** flip with `supabase secrets set CLUSTER_ATTACH_MODE=live` (or `off`). In `live`, a wrong attach is undone by removing the `cluster_articles` row and clearing the article's `politics_admitted_at`; the `cluster_attach_shadow` row (mode `live`) names both. Once the decisions have been reviewed the operator empties `public.cluster_attach_shadow` (`service_role` cannot).

**Rollback** (nothing else depends on 151):

```sql
-- MUTATES QUEUE STATE: this rollback drops the cluster_attach queue.
-- first: supabase secrets set CLUSTER_ATTACH_MODE=off  (the consumer stops reading the queue)
drop trigger if exists articles_cluster_attach_probe on public.articles;
drop function if exists public.enqueue_cluster_attach_probe();
drop table if exists public.cluster_attach_shadow;
select pgmq.drop_queue('cluster_attach');
delete from supabase_migrations.schema_migrations where version = '151';
```

The consumer tolerates the missing queue and table (one warning per isolate each); revert the function only if you want the warnings gone. A `live` run leaves `politics_admitted_at` stamps and `cluster_articles` rows behind; revert those by hand from `cluster_attach_shadow` before dropping it.

## 152 — schema parity (`sources.tradition` / `source_type` / `sources_alignment_check`): APPLY 152 only, no deploy-order constraint

Production's `public.sources` carries objects no migration declared: `tradition` and `source_type` (text, not null, defaults `'mainstream'` / `'general'`) with `sources_tradition_check` and `sources_source_type_check`, indexes `idx_sources_tradition` / `idx_sources_source_type`, and `sources_alignment_check`, which lets `bias` be one of **five** keys (`pro_government`, `gov_leaning`, `center`, `opposition_leaning`, `opposition`). The 001-151 chain has none of those and keeps the ten-key `sources_bias_check`. The app accepted ten keys, so admin `add_source` answered 500 and `set_source_bias` answered 400 with the raw Postgres text for `state_media`, `islamist_conservative`, `international`, `pro_kurdish`, `nationalist`.

152 re-declares production's objects **additively**; every step is guarded on the object's absence, so on production it writes only the ledger row and takes no table lock. The app now refuses the five legacy keys on write (`WRITABLE_SOURCE_BIAS`, `400 {"error":"Invalid bias"}` before any DB call), the add dialog only lists the five, and `supabase/seed_sources.sql` carries production's current label for its 31 legacy rows.

**Apply:** once, in the Supabase SQL editor or `supabase db push` (one transaction, `lock_timeout` 5 s, `statement_timeout` 60 s). Re-running is a no-op. No PRE-BUILD (about 150 `sources` rows, no `articles` index). No edge function or cron change. Deploy the app in any order.

**Not in 152 (deferred, operator decision):** `articles_content_hash_length_chk` and the `026` ledger row. Step 0 found one violating row of 1,391,507 (`6f038461-536a-4a7b-9547-0f0a3a8e7f32`, created 2026-04-17, `content_hash` = its URL, written before the raw-URL fallback was replaced by `sha1(url)` on 2026-06-07). A NOT VALID check still fires on every UPDATE of an old row, so adding it would turn that row's later writes (image backfill, enrichment, admission stamps) into 23514. The follow-up, in its own migration after the row is repaired, is in the header of `152_schema_parity.sql`.

**Founder decision, not made here:** widening the bias CHECK to the ten keys the app knows would move zones; 152 keeps production's five.

**Verify** (read-only; production expects 6 rows, 2 rows, 2 rows, then `152` only):

```sql
select conname, convalidated from pg_constraint
 where conrelid = 'public.sources'::regclass order by 1;
-- sources_alignment_check, sources_kind_check, sources_pkey, sources_slug_key,
-- sources_source_type_check, sources_tradition_check   (all convalidated = t)
select column_name, is_nullable, column_default from information_schema.columns
 where table_schema = 'public' and table_name = 'sources'
   and column_name in ('tradition', 'source_type') order by 1;
-- source_type NO 'general'::text / tradition NO 'mainstream'::text
select indexname from pg_indexes where schemaname = 'public' and tablename = 'sources'
   and indexname in ('idx_sources_tradition', 'idx_sources_source_type') order by 1;
select version, name from supabase_migrations.schema_migrations
 where version in ('026', '152') order by 1;                    -- 152 only
```

**Rollback:**

```sql
-- Production: only the ledger row is new. Do NOT drop the constraints, columns or indexes:
-- they are production's own and 152 created none of them there.
delete from supabase_migrations.schema_migrations where version = '152';

-- A rebuild or branch database where 152 added them:
alter table public.sources drop constraint if exists sources_alignment_check;
alter table public.sources drop constraint if exists sources_tradition_check;
alter table public.sources drop constraint if exists sources_source_type_check;
drop index if exists public.idx_sources_tradition;
drop index if exists public.idx_sources_source_type;
alter table public.sources drop column if exists tradition, drop column if exists source_type;
delete from supabase_migrations.schema_migrations where version = '152';
```

On a branch database that already holds a legacy-key `sources` row, 152 skips `sources_alignment_check` with `NOTICE: 152: sources_alignment_check skipped, N existing sources row(s) ...` (a NOT VALID check would fail every later UPDATE of that row, such as ingest fetch-state writes); the chain's ten-key `sources_bias_check` is never dropped. Dry runs: `tests/migrations/sql/152-schema-parity-prod-shape-dryrun.sql` and `...-chain-shape-dryrun.sql` (local PostgreSQL 15 only, never production).

## 153 — `worker_metrics` names its two queues (fixes `/api/health` stuck on `degraded`): APPLY 153, THEN 154

**Why:** `/api/health` answered `{"status":"degraded"}` on 2026-11-02 and had since 151. `public.worker_metrics` (024) read `FROM pgmq.metrics_all() WHERE queue_name IN ('cluster_work','image_backfill')`. `metrics_all()` is SECURITY INVOKER and loops over every row of `pgmq.meta` before the `WHERE` runs, so it also called `pgmq.metrics()` for the `cluster_attach` queue that 151 created and deliberately did not grant to `service_role`. The queue probe failed with `42501 permission denied for sequence q_cluster_attach_msg_id_seq` (Supabase postgres logs, four times between 20:14 and 20:24Z), `checks.queues.ok` was false and the whole verdict was `degraded`: the queue depth and age alarm was blind (hunt 28, h28-live-1). `ops_health_report()` row 18 reads pgmq through a definer and was not affected.

**What 153 does** (additive, ONE short transaction, safe to re-apply): `create or replace view public.worker_metrics` over `pgmq.metrics('cluster_work') union all pgmq.metrics('image_backfill')`, the same six columns in the same order and types, no `WITH` options; a new comment; the same `revoke all ... from public, anon, authenticated` and `grant select ... to service_role` as 024; the ledger row. `pgmq.metrics(text)` touches only the queue it is given, so a queue nobody granted can never break the view. **Nothing is granted on any pgmq object**: `cluster_attach` stays locked to `service_role` on purpose (151's invariant, the 024-028 tripwire). The price is that a new queue is not in the view until someone adds it; `tests/migrations/153-worker-metrics-named-queues.test.ts` fails on any `pgmq.create('<q>')` that is neither named in the view nor in its `EXCLUDED` set with a reason, and on any later migration that goes back to `metrics_all`. No app change: `route.ts` already reads the view.

**Step 0 note:** production's ACL on the view is `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}` (service_role holds every privilege, a Supabase default 024 never revoked), not select only. 153 leaves it as it is; the view is not updatable, so the surplus cannot do anything. The fix was also run read-only on production as `service_role` before this PR (`set local role service_role; select ... from pgmq.metrics('cluster_work') union all ... pgmq.metrics('image_backfill')` returned 2 rows; the old `pgmq.metrics_all()` returned the 42501).

**Order:** apply 153 (`supabase db push`), then 154. They are independent, but 154's cadence is chosen so that the `oldest_msg_age_sec` this view reports stays far below the route's 1800 s bound, and that only matters once the probe works again.

**Verify** (read-only; production expects 2 rows, no 42501, `f`, `f`, `f`, `1`):

```sql
begin; set local role service_role;
select queue_name, queue_length, oldest_msg_age_sec from public.worker_metrics;          -- 2 rows
rollback;
select pg_get_viewdef('public.worker_metrics'::regclass);                                -- two pgmq.metrics(...) calls, no metrics_all
select has_table_privilege('service_role', 'pgmq.q_cluster_attach', 'select');           -- f (still locked)
select has_table_privilege('anon', 'public.worker_metrics', 'select'),
       has_table_privilege('authenticated', 'public.worker_metrics', 'select');          -- f, f
select count(*) from supabase_migrations.schema_migrations where version = '153';        -- 1
```

Then `GET /api/health`: `"status":"healthy"` (or `degraded` only for a real reason; `checks.queues.error` no longer says `permission denied for sequence`).

**Rollback** (nothing else depends on 153): re-create 024's view (`create or replace view public.worker_metrics as select queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages, scrape_time from pgmq.metrics_all() where queue_name in ('cluster_work', 'image_backfill');`), `notify pgrst, 'reload schema';` and `delete from supabase_migrations.schema_migrations where version = '153';`. That brings `/api/health` back to `degraded` for as long as `cluster_attach` exists. Dry runs: `tests/migrations/sql/153-worker-metrics-named-queues-dryrun.sql` (local PostgreSQL 15 only, never production).

## 154 — image requeue stagger (`image_backfill_requeue` attempts 1-2, 20 s stagger, 4 x 40 an hour): APPLY 154 after 153, no deploy

**Why:** 142's `image-backfill-requeue` sent 150 un-delayed messages at minute 17 of every hour. The image-consumer takes at most 40 messages per `image-drain` tick (every 5 minutes), FIFO, so the burst kept it busy for about 15 minutes and every fresh article enqueued behind it waited: fresh-message queue wait p95 **1026 s** in minutes 0-9 after `:17` (n=295), 311 s in minutes 10-19, 301 s in the rest of the hour (24 h of `pgmq.a_image_backfill`). Only 333 of 3,000 requeued messages (enqueued 2-24 h ago) are for articles that now have an image, and 1,669 are for articles still image-less after 5 attempts, so the later tries (attempts 3 and 4) are mostly waste (hunt 28, h28-freshness-2).

**What 154 does** (additive: one function replaced, one cron job rescheduled by name, one note updated; ONE short transaction; safe to re-apply): `public.image_backfill_requeue(p_limit integer default 300)` keeps its signature, attributes and grants (`service_role` only) and 142's body except for two changes: it selects `image_backfill_attempts between 1 and 2` (the second and third try, where the yield is), and every send is `pgmq.send('image_backfill', {article_id}, least(v_sent * 20, 900))`, so a batch becomes visible one message per 20 s (the first has delay 0). The cron job moves from `17 * * * *` / `image_backfill_requeue(150)` to **`2,17,32,47 * * * *` / `image_backfill_requeue(40)`**: 160 messages an hour of capacity (at least the old 150), largest delay 39 x 20 = 780 s. `ops_cron_expected.note` for the job follows the schedule; `max_gap` stays 3 hours. No other cron job is touched.

**Why not hourly 150 with the same stagger:** that holds the last message 2,980 s invisible. `pgmq.metrics`' `oldest_msg_age_sec` counts invisible messages, so `/api/health` (1800 s bound, working again after 153) would be `degraded` from about `:47` to `:70` of every hour, and `ops_health_report()` row 18 (`queue_lag`, which ages the oldest visible message from `enqueued_at`) would warn above 1800 s. The simulation in `tests/migrations/154-image-requeue-stagger.test.ts` (FIFO, 40 per 5 minutes, a fresh message every 45 s) gives: old design fresh p95 1065 s; new design 285 s with max queue age 779 s; brief-literal design 285 s but max queue age 3179 s.

**Order:** apply 153, then 154 (`supabase db push`). The first new tick is the next minute 2, 17, 32 or 47. No Edge Function and no app deploy: the delay is applied by `pgmq.send`, and the image-consumer only reads visible messages. `docs/architecture.md` still describes 142's cadence in its "Image requeue" row (tests/migrations/142 pins that row against 142's file); it is updated together with that test in a follow-up.

**Verify** (read-only):

```sql
select jobname, schedule, command from cron.job where jobname = 'image-backfill-requeue';
   -- one row: 2,17,32,47 * * * *, select public.image_backfill_requeue(40)
select has_function_privilege('anon', 'public.image_backfill_requeue(integer)', 'execute'),
       has_function_privilege('authenticated', 'public.image_backfill_requeue(integer)', 'execute'),
       has_function_privilege('service_role', 'public.image_backfill_requeue(integer)', 'execute');   -- f, f, t
select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.image_backfill_requeue(integer)'::regprocedure;
   -- 2c3e427b0c98801b873b335544ab7699, 866
select note, max_gap from public.ops_cron_expected where jobname = 'image-backfill-requeue';   -- 2,17,32,47 * * * *, 03:00:00
select queue_length, oldest_msg_age_sec from pgmq.metrics('image_backfill');   -- oldest stays under about 800 s
select count(*) from supabase_migrations.schema_migrations where version = '154';             -- 1
```

Next day, the fresh-wait buckets (bounded by `archived_at`):

```sql
select (extract(epoch from q.enqueued_at)::bigint % 3600) / 600 as bucket_of_10_min, count(*),
       percentile_cont(0.95) within group (order by extract(epoch from (q.archived_at - q.enqueued_at))) as p95_wait_s
  from pgmq.a_image_backfill q join public.articles a on a.id = (q.message ->> 'article_id')::uuid
 where q.archived_at > now() - interval '24 hours' and q.enqueued_at < a.created_at + interval '30 seconds'
 group by 1 order by 1;                                  -- p95 under 320 s in every bucket
```

Acceptance: p95 under 320 s in every bucket and `image-consumer` averaging under 8 s at `:20`, `:25` and `:30`.

**Rollback** (nothing else depends on 154): re-run only 142's function section (`create or replace function public.image_backfill_requeue(` through its `grant execute`; `md5(prosrc)` is `917624baf55f5021fe458e8f0664b6d1` again), then `select cron.unschedule('image-backfill-requeue');`, `select cron.schedule('image-backfill-requeue', '17 * * * *', $$ set statement_timeout = '60s'; select public.image_backfill_requeue(150); $$);`, `update public.ops_cron_expected set note = '17 * * * *' where jobname = 'image-backfill-requeue';` and `delete from supabase_migrations.schema_migrations where version = '154';`. Messages already on the queue are ordinary `image_backfill` messages. Dry runs: `tests/migrations/sql/154-image-requeue-stagger-dryrun.sql` (local PostgreSQL 15 only, never production).

## 156 — entity hubs match only the summary's first line (`entity_cluster_ids_v2` body v3): APPLY 156 + DEPLOY cluster-consumer, any order

**Why:** `d91ab2f1` (Erdoğan returns from Korea) was listed under `/gundem/trump` because its stored `summary_tr` carries a pasted related-news teaser, "İşte ... Trump...", under two real sentences. Milliyet and Posta paste other stories' headlines under an article without a "Son dakika" marker, and 125's hub regex ran over the whole `summary_tr`, so the teaser's "Trump" was the only match (hunt 34, h34-reader-5).

**What 156 does** (one function replaced, one transaction, safe to re-apply): `create or replace function public.entity_cluster_ids_v2(text[], text[], timestamptz, integer)` with one changed term. The regex text now takes `pg_catalog.split_part(coalesce(c.summary_tr, ''), E'\n', 1)` (the first line of the summary) instead of the whole `summary_tr`. Same signature, `SECURITY DEFINER`, `search_path = ''`, execute revoked from public, anon and authenticated and granted to `service_role`. No table, index or data change, no backfill. **Expected effect** (production replay, read-only, 2026-11-05): `/gundem/afad` goes from 24 to 20 clusters, and 46 (key, cluster) removals in total over 22 keys, of which 11 are pasted teasers or tickers; the other 35 name the entity in a later real sentence, which is the price of a first-line rule. 40 of the 62 hub keys do not change, and nothing is added anywhere.

**Order:** independent, any order. The app needs no deploy for 156 (it only calls the function). The other half of the fix, the trailing-teaser strip `stripTrailingTeasers` in `supabase/functions/_shared/cluster/description-clean.ts`, reaches the clustering fingerprint and entities only after `npx supabase functions deploy cluster-consumer --no-verify-jwt`: `supabase/functions/cluster-consumer/index.ts` is the only function that imports `_shared/cluster/description-clean.ts`. Ingest does NOT import it (it uses its own cleaner in `_shared/rss/normalize.ts`, so `content_hash` and the stored description stay byte-identical) and needs no redeploy. The shown-summary strip (`src/lib/articles/summary-tidy.ts`) ships with the Vercel app deploy. Until the consumer is deployed, new clusters keep seeding from the unstripped description; 156 already keeps the hubs clean for them because it reads only the first summary line.

**Verify** (read-only):

```sql
-- the new body is live (expect t)
select position('split_part' in prosrc) > 0 from pg_proc where proname = 'entity_cluster_ids_v2';
-- service_role only (expect f, f)
select has_function_privilege('anon', 'public.entity_cluster_ids_v2(text[],text[],timestamptz,integer)', 'execute'),
       has_function_privilege('authenticated', 'public.entity_cluster_ids_v2(text[],text[],timestamptz,integer)', 'execute');
select count(*) from supabase_migrations.schema_migrations where version = '156';   -- 1
```

Then `curl -s https://www.tayfhaber.com/gundem/trump` and check that `d91ab2f1` is gone (the hubs switch as their `clusters-entity` cache entries expire), and that `/gundem/erdogan` still lists it (its title names Erdoğan).

**Rollback:** re-run the `create or replace function public.entity_cluster_ids_v2` statement of `125_entity_cluster_ids_v2.sql` (the bare `summary_tr` term), then `delete from supabase_migrations.schema_migrations where version = '156';`. The app does not care which of the two bodies is live. The consumer deploy is independent of the rollback.

## 157 — ingest deferral counters + `feed_poll_stale` (`ops_health_report` row 20): APPLY 157 first, THEN DEPLOY ingest

**Why:** BHA (an opposition wire, a 4.25 MB body of 1000 items) was last polled 2 h 39 min before the 2026-11-05 08:24Z reading while its peers were under a minute old, and its newest stored article was 17 hours old. The ingest isolate item budget estimated its body as `floor(bytes / 1500) = 2,833` items, which `createItemBudget().fits()` admits only on an isolate that holds at most 2,167 of the 5,000 items; a refused feed writes no fetch state, and the in-memory memory of deferred feeds is lost when the isolate recycles. No ops row fires before 24-72 hours of silence, and `ingest_cycles` did not count the deferrals (hunt 36, h36-pipeline-1). The ingest change (a `fetch_items_count`-based estimate and stale-first ordering) is in the ingest function; 157 is its observability.

**What 157 does** (additive, one transaction, safe to re-apply):

- adds three nullable integer columns to `public.ingest_cycles`: `isolate_budget_deferred`, `parse_deferred` and `parse_deferred_max_streak`, written by ingest with each cycle row (NULL on older rows);
- re-creates `ops_health_report()` with 150's text verbatim through row 19 and appends row 20 `feed_poll_stale`: the active sources with no quarantine marker (`fetch_quarantined_until is null`) whose `fetch_last_at` is older than 30 minutes; **warn at 1, fail at 3**. A source never polled (`fetch_last_at` null) is not counted, only named in the detail. The function returns 20 rows; the detail carries slugs and minutes only. Row 20 was evaluated on production before it shipped: 118 active sources, 27 quarantined (fail streaks 32-59), 0 never polled, 1 stale (`bha`, 171 min); the next oldest feed was 3.9 min old, so a healthy roster reads 0;
- adds, changes and unschedules no pg_cron job; no data rewrite, no index.

**Order:** apply 157 first (`supabase db push`), then deploy ingest: `npx supabase functions deploy ingest --no-verify-jwt`. The reverse order is safe too: an insert that names a column the table lacks fails the whole cycle row, so ingest retries the `ingest_cycles` insert once without the three columns when the answer is Postgres `42703` or PostgREST `PGRST204` (the same pattern as the legacy `sources` select for 119). Deployed before 157, ingest logs `ingest_cycles deferral columns missing (migration 157 not applied?)` once per cycle and writes the row it wrote before; the counters are simply absent until 157 is applied. **Expected right after 157, before the ingest deploy: row 20 reads `warn` / 1 with `bha`** (BHA is stale today); it returns to `pass` once the new ingest reaches a fresh isolate and polls BHA every cycle. The Vercel app needs no deploy.

**Verify** (read-only):

```sql
select count(*) from public.ops_health_report();   -- expect 20
select check_name, status, observed, threshold, detail
  from public.ops_health_report() where check_name = 'feed_poll_stale';
-- before the ingest deploy: warn / 1 / 3 / "30 dakikadır yoklanmayan aktif kaynak 1: bha 171 dk" (the minutes grow);
-- after it: pass / 0 / 3 / "aktif kaynakların hepsi son 30 dakikada yoklandı (91)"
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema = 'public' and table_name = 'ingest_cycles'
   and column_name in ('isolate_budget_deferred', 'parse_deferred', 'parse_deferred_max_streak');   -- 3 rows, integer, YES
-- service_role only (expect f, f, t)
select has_function_privilege('anon', 'public.ops_health_report()', 'execute'),
       has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'),
       has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
select version, name from supabase_migrations.schema_migrations where version = '157';   -- 1 row
```

After the ingest deploy (replace `<deploy>` with the deploy time):

```sql
-- BHA polled every cycle: stays under 10 minutes across a 2 h sample
select slug, now() - fetch_last_at as age from public.sources where slug = 'bha';
-- BHA's lag from publication to storage, last day (was p50 79 min, p90 363 min over 3 days): expect p50 under 20 min
select percentile_cont(0.5) within group (order by extract(epoch from a.created_at - a.published_at) / 60)
  from public.articles a join public.sources s on s.id = a.source_id
 where s.slug = 'bha' and a.published_at > now() - interval '1 day';
-- the counters arrive on the cycle rows (deferrals are expected at news peaks, a streak above 2 is not)
select started_at, isolate_budget_deferred, parse_deferred, parse_deferred_max_streak
  from public.ingest_cycles where started_at > timestamptz '<deploy>' order by started_at desc limit 10;
```

Also watch `net._http_response` for ingest 546 / `CPUTime` bodies against the 6 hour baseline before the deploy: the estimate cap books BHA at 1,250 items instead of 2,833 (the cap, 125% of the stored `fetch_items_count`, is applied only while the size estimate is at most 4 times it; a body further out than that keeps the size-only estimate, so a stale small count cannot shrink a big body's estimate), so an isolate admits it more often, and the item budget (5,000), the byte budget (8 MB) and the parse cap (55) are unchanged. If 546s rise, lower `INGEST_ISOLATE_ITEM_BUDGET` (no deploy needed) and report it.

**Rollback** (nothing else depends on 157): re-run ONLY 150's `ops_health_report()` section, the text of `150_ops_queue_and_cron_liveness.sql` from `create or replace function public.ops_health_report()` through `grant execute on function public.ops_health_report() to service_role;` (it returns the report to 19 rows, md5 `2445cd7d15a23d4af88d42ddf79ac2ff`), then remove the three columns (`alter table public.ingest_cycles drop column if exists isolate_budget_deferred, drop column if exists parse_deferred, drop column if exists parse_deferred_max_streak;`), run `notify pgrst, 'reload schema';` and remove ledger row 157 (`delete from supabase_migrations.schema_migrations where version = '157';`). Dropping the columns while the new ingest is deployed is safe (it retries the cycle row without them). To roll the ingest change back, redeploy the previous ingest function; the columns and row 20 can stay.

## 158 — `/saved` waits the Kör nokta delay (`saved_clusters_v3`, anon allowlist in `ops_health_report` row 17): apply 158 before the Vercel deploy

**Why:** #199 (h37-content-1) made the "Kör nokta" pill wait `BLINDSPOT.feedDelayHours` (24 h) after `first_published` on every card, the cluster page and `/hafta` (`publicBlindspotClaim` in `src/lib/clusters/recall-veto.ts`). `/saved` is a browser component that calls the anon RPC `saved_clusters_v2` (124, recall veto in 138), and v2 returns no `first_published`, so it showed the pill at once; `/metodoloji` and its CHANGELOG entry carried the exception "(Kaydedilenler listesi hariç)". On 2026-11-05, 9 of the 28 flagged, unvetoed clusters updated in the last 3 days were first published less than 24 hours ago (hunt 38, h38-saved-1).

**What 158 does** (additive, one transaction, safe to re-apply):

- creates `public.saved_clusters_v3(p_ids uuid[])`: 138's `saved_clusters_v2` character for character (the seven columns, the veto expression, the `p_ids[1:200]` truncation, `order by c.updated_at desc limit 200`, `language sql stable security definer set search_path = ''`, revoke from `public, anon, authenticated`, grant execute to `anon, service_role`) plus **one more column, `first_published timestamptz`, last**. The client (`src/components/bookmark/saved-list.tsx`) calls v3, maps every row through `publicBlindspotClaim` (the clock is read once, after the rows load, in the effect), and shows the pill only when the claim holds. `saved_clusters_v2` (124 / 138) and `saved_clusters` (116, used by `bookmark-snapshots.ts`) are **not touched**: PostgreSQL cannot add an OUT column with `create or replace`, and dropping v2 would break the deployed app between the migration and the deploy;
- re-creates `ops_health_report()` with 157's text verbatim except six spots that name the allowlisted anon RPCs: row 17 (`anon_surface`, 145) counts every anon-executable `SECURITY DEFINER` function outside an allowlist of full identities, so without a sixth entry `'saved_clusters_v3(uuid[])'` row 17 would read `fail` (definer function 1) the moment 158 is applied. The detail now says `(6 izinli RPC hariç)`; the other 19 rows, their order and thresholds, the revoke and the grant (`service_role` only) are 157's. The anon-surface guard's allowlist (`tests/_helpers/anon-rpc-allowlist.ts`) and the browser client's own allowlist (`src/lib/supabase/browser.ts`) gain the same sixth name;
- no table, column, index, trigger, policy or pg_cron job is touched, no data is written, nothing is granted to `authenticated`.

**Production fingerprint the migration was built from** (read-only, 2026-11-05): `saved_clusters_v2` has `md5(prosrc)` `8ad5bfef58acd7c79d238c6feee06a6d`, length 365, `SECURITY DEFINER`, `STABLE`, `proconfig {search_path=""}`, `proacl {postgres=X/postgres,service_role=X/postgres,anon=X/postgres}`, and that md5 is the md5 of the text between the `$fn$` markers of 138, the latest migration that defines it (`tests/migrations/158-saved-clusters-v3.test.ts` recomputes it). `clusters.first_published` is `NOT NULL` there.

**Order:** apply 158 before the Vercel deploy (`supabase db push`, operator), then merge/deploy the app. PostgREST reloads its schema cache on the `notify`, so `/rest/v1/rpc/saved_clusters_v3` is routable at once. The reverse order is safe: until 158 is applied the client's v3 call answers `PGRST202` (PostgREST) or `42883` (Postgres), it falls back once to v2 and treats `first_published` as unknown, which is exactly the previous behaviour (veto applied, no 24 h wait); a missing v2 falls back to v1 on `PGRST202` as before. `/metodoloji` no longer carries the saved-list exception, so apply 158 first to keep that sentence true. Applying 158 alone (old app) changes nothing visible.

**Verify** (read-only):

```sql
select count(*) from public.ops_health_report();   -- expect 20
select status, detail from public.ops_health_report() where check_name = 'anon_surface';
-- expect pass / anon/authenticated yetkisi yok: tablo/dizi 0, definer fonksiyon 0, invoker fonksiyon 0 (6 izinli RPC hariç) · auth.users 0
select has_function_privilege('anon', 'public.saved_clusters_v3(uuid[])', 'execute'),
       has_function_privilege('authenticated', 'public.saved_clusters_v3(uuid[])', 'execute'),
       has_function_privilege('service_role', 'public.saved_clusters_v3(uuid[])', 'execute');   -- t, f, t
select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.saved_clusters_v3(uuid[])'::regprocedure;   -- 2964f03d7a434b67dc00ddeecf833131, 393
select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;           -- 04c2ffc4d047278703cd16f02db6808d, 41855
select md5(prosrc), length(prosrc) from pg_proc where proname = 'saved_clusters_v2';   -- unchanged: 8ad5bfef58acd7c79d238c6feee06a6d, 365
select version, name from supabase_migrations.schema_migrations where version = '158';   -- 1 row
```

Then open `/saved` with a bookmarked, flagged story younger than 24 hours: no pill; the same story after 24 hours: the pill.

**Rollback** (nothing else in the database depends on 158; one transaction): `drop function public.saved_clusters_v3(uuid[]);`, then re-run ONLY 157's `ops_health_report()` section, the text of `157_ingest_poll_stale.sql` from `create or replace function public.ops_health_report()` through `grant execute on function public.ops_health_report() to service_role;` (the report returns to the five-RPC allowlist, md5 `d4e50357ea4ae0b85601d5e2047c2c7c`, length 41827), then `notify pgrst, 'reload schema';` and remove ledger row 158 (`delete from supabase_migrations.schema_migrations where version = '158';`). Drop the function only together with the report (or after it): a v3 that still exists while the report is back at five entries reads as `fail`. A client that gets `PGRST202` or `42883` from v3 reads v2, so the app keeps working.

## 159 — ingest stale-feed admission (`ingest_cycles.stale_deferred` / `oldest_stale_min`, `ops_health_report` row 20 fails at 60 minutes): APPLY 159 BEFORE DEPLOYING ingest

**Why:** #198 (migration 157) did not end BHA's starvation. The opposition wire went 107 minutes unpolled on 2026-11-05 (09:25 to 11:12Z) and was still skipped on most cycles at 12:26Z (fetch_last_at 11.4 min old after three cycles). #198 put the stale feeds first in the order fetches START in, but admission follows the order bodies ARRIVE in, and BHA's 4.25 MB body finishes last: on a fresh isolate the other feeds had taken 7.17 of the 8 MB cycle byte budget and 4,299 of the 5,000 isolate items (ingest response of 12:24:01Z), so it was refused, and on the next, reused isolate the item budget (4,299 + 1,250 > 5,000) refused it again before the isolate recycled and the in-memory priority was lost. Row 20 (`feed_poll_stale`) read `warn` / 1 in eight consecutive snapshots (`bha 218 dk` ... `bha 99 dk`) and nothing paged, because one stale feed can only warn (hunt 39, h39-pipeline2-1). The ingest change reserves the stalest feed's items (never above the 5,000-item isolate budget) before the fetch pool starts; 159 is its observability and its pager.

**What 159 does** (additive, one transaction, safe to re-apply):

- adds two nullable integer columns to `public.ingest_cycles`, no default: `stale_deferred` (stale feeds the cycle still deferred, expected 0) and `oldest_stale_min` (whole minutes since `fetch_last_at` of the oldest stale feed at cycle start), written by ingest with each cycle row (NULL on older rows). A "stale feed" is a source with no quarantine marker (`fetch_quarantined_until` null, row 20's population) whose `fetch_last_at` is null or older than three cycle periods: the daily probe of an expired quarantine (its `fetch_last_at` is its last attempt, about 1,440 minutes old) is not one, so it neither sets `oldest_stale_min` nor takes the reservation. A column added without a default is a catalogue change only;
- re-creates `ops_health_report()` with 158's text verbatim (md5 `04c2ffc4d047278703cd16f02db6808d`, length 41855, the production fingerprint) except row 20 `feed_poll_stale`: it is now `fail` when 3 or more counted feeds are over 30 minutes **or when any counted feed was last polled more than 60 minutes ago**, `warn` at 1, else `pass`. The population (active sources with no quarantine marker), `observed`, `threshold` 3 and the detail text are unchanged. The function comment lists 159 and the new rule; the revoke and the grant (`service_role` only) are 158's;
- adds, changes and unschedules no pg_cron job; no data rewrite, no index, no grant to anon or authenticated.

**Order:** apply 159 before deploying ingest (`supabase db push`, operator), then `npx supabase functions deploy ingest --no-verify-jwt`. PostgREST reloads its schema cache on the `notify`, so the ingest insert naming the two columns is accepted from the first cycle. The reverse order is safe but costs counters: an insert that names a column the table lacks fails the whole row, so ingest retries the `ingest_cycles` insert once without all five new columns (157's three and 159's two) when the answer is Postgres `42703` or PostgREST `PGRST204`, logs `ingest_cycles deferral columns missing (migration 157 not applied? or 159?)` once per cycle and writes the row it wrote before 157; no cycle row is lost, but 157's `isolate_budget_deferred` / `parse_deferred` / `parse_deferred_max_streak` are absent until 159 is applied too. The Vercel app needs no deploy. The ingest build changes no budget: `ISOLATE_ITEM_BUDGET` (5,000), `PARSE_BUDGET_BYTES` (8 MB) and `MAX_PARSES_PER_CYCLE` (55) are untouched; a reservation is booked under the isolate limit, a cycle's byte total can exceed the byte budget by at most the one reserved feed's own body, and while the reservation is held one parse slot is kept for the reserved feed (the other feeds get at most 54 of the 55, so small feeds that arrive first cannot leave it at the cap; the slot is freed with the reservation on a 304, an error or a release, and the total never passes 55).

**Verify** (read-only):

```sql
select count(*) from public.ops_health_report();   -- expect 20
select check_name, status, observed, threshold, detail
  from public.ops_health_report() where check_name = 'feed_poll_stale';
-- expect pass / 0 / 3 / "aktif kaynakların hepsi son 30 dakikada yoklandı (91)"; one feed over 60 minutes now reads fail
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema = 'public' and table_name = 'ingest_cycles'
   and column_name in ('stale_deferred', 'oldest_stale_min');   -- 2 rows, integer, YES
select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
-- a2246bc0ea663b123144a2fa4c4f5735, 42501 (was 04c2ffc4d047278703cd16f02db6808d, 41855)
-- service_role only (expect f, f, t)
select has_function_privilege('anon', 'public.ops_health_report()', 'execute'),
       has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'),
       has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
select version, name from supabase_migrations.schema_migrations where version = '159';   -- 1 row
```

After the ingest deploy (replace `<deploy>` with the deploy time), for two hours:

```sql
-- BHA is parsed on each fresh isolate on which it is more than 9 minutes old. Fresh and reused
-- isolates alternate every 3 minutes, so that is about every 12 minutes. Sampled every 10 minutes,
-- expect at most about 13 minutes; a sample over 15 minutes, or stale_deferred > 0, means a reservation was missed
select slug, now() - fetch_last_at as age from public.sources where slug = 'bha';
-- feed_poll_stale shows no bha rows
select taken_at, status, detail from public.ops_health_snapshots
 where check_name = 'feed_poll_stale' and taken_at > timestamptz '<deploy>' order by taken_at;
-- the new counters: stale_deferred mostly 0
select started_at, stale_deferred, oldest_stale_min, parse_deferred, isolate_budget_deferred
  from public.ingest_cycles where started_at > timestamptz '<deploy>' order by started_at desc limit 20;
-- BHA created-minus-published p50 for new rows: under 20 min
select percentile_cont(0.5) within group (order by extract(epoch from a.created_at - a.published_at) / 60)
  from public.articles a join public.sources s on s.id = a.source_id
 where s.slug = 'bha' and a.created_at > timestamptz '<deploy>';
```

Also watch `net._http_response` for ingest: no 546 / `CPUTime` bodies. Judge `isolateItemsUsed` on bodies with `isolateCycles` 1 (a fresh isolate) only: expect at most about 5000 (the replay peak is 4,994). Bodies with `isolateCycles` 2 already read 5,919 to 6,530 on the build in production before this change (2026-11-05 12:00 to 13:09Z), because `settle()` charges the real item counts over the size estimates after each parse; that is the baseline, not a regression of the reservation. Judge the deploy by the 546 / `CPUTime` bodies, `stale_deferred` and BHA's age.

**Rollback** (nothing else depends on 159; one transaction): re-run ONLY 158's `ops_health_report()` section, the text of `158_saved_clusters_v3.sql` from `create or replace function public.ops_health_report()` through `grant execute on function public.ops_health_report() to service_role;` (row 20 returns to fail at 3 stale feeds only, md5 `04c2ffc4d047278703cd16f02db6808d`, length 41855), then `alter table public.ingest_cycles drop column if exists stale_deferred, drop column if exists oldest_stale_min;`, `notify pgrst, 'reload schema';` and remove ledger row 159 (`delete from supabase_migrations.schema_migrations where version = '159';`). Dropping the columns while the new ingest build is deployed is safe (it retries the cycle row without them). To roll the ingest change back, redeploy the previous ingest function; the columns and the 60-minute rule can stay.

## 160 — quotes-ingest intraday keeps only traded tickers (`bist_intraday_targets` joins `bist_companies.shares_traded`): APPLY 160, DEPLOY quotes-ingest in any order

**Why:** `quotes-intraday` (`*/5 7-15 * * 1-5` UTC) asks `public.bist_intraday_targets(120)` for its tickers. 058's body took every distinct `article_tickers.ticker` of the last 7 days with no `shares_traded` filter, so a news code that is not a traded share never got a bar, kept `last_ts` NULL and sorted to the head (`order by b.last_ts nulls first`) of every run for ever. Yahoo answers those with 404. On 2026-11-05 the six consecutive intraday responses from 12:15 to 12:40Z were all `tickers 120, fetched 66, 54 x "yahoo 404"` (AKCVR, AKCKM, ARTI, ATAC, AYDGN, BOYNR, DENIZ, DNZ, FNCLL, KILER, OYA, SEK, TRMEN ...), about 650 Yahoo requests an hour that were certain to fail, while the 131 real news tickers shared the remaining 66 slots (news-ticker bar lag p50 21.0 min, p90 26.0 min at 12:41Z). Last 7 days: 186 news tickers, 131 with a bar in 2 days, 55 with none, and 52 of those 55 have no `shares_traded` company. The daily mode already restricts to traded tickers (051 / 052); the intraday mode never got the filter (hunt 39, h39-pipeline2-2).

**What 160 does** (additive, one transaction, safe to re-apply):

- `create or replace function public.bist_intraday_targets(p_limit int default 120)` with the **same signature, return columns (`ticker text, last_ts timestamptz`), `language sql`, `stable` and SECURITY INVOKER** as 058 section 7. The body is 058's body plus `intersect select distinct unnest(tickers) as ticker from public.bist_companies where shares_traded` in the `t` subquery, the traded set exactly as `bist_daily_targets` writes it. The left join on `bist_bars_5m`, `order by b.last_ts nulls first, t.ticker` and `limit p_limit` are unchanged, so the stalest-first rotation works as before;
- restates 058's `revoke execute ... from anon, authenticated, public` and `grant execute ... to service_role` for this one function (no-ops on production, where the ACL already is `{postgres=X/postgres,service_role=X/postgres}`);
- adds, changes and unschedules no pg_cron job, touches no table, column, index or row, and leaves `bist_daily_targets` and the daily mode alone.

**Production fingerprint the replace was based on** (read-only, 2026-11-05): `bist_intraday_targets(integer)` has `md5(prosrc)` `ee892ad1547b7563bb43bb3ba4b17e52` (length 315), LANGUAGE sql, STABLE, SECURITY INVOKER, `proconfig` NULL, owner `postgres`, and that md5 is the md5 of the text between the `$$` markers of 058 section 7, the latest migration that defines it (`tests/migrations/160-intraday-traded-targets.test.ts` recomputes it). The new body is `md5(prosrc)` `36d7209bf11615ba628fcee3f274faa3`, length 422.

**Read-only replay before shipping** (the new body run inline, `p_limit` 120): candidates **186 -> 134** (52 removed, every one of them in the 404 list); of the 120 rows, 54 were 404 codes before and **2 after, OYA and SEK** (traded shares Yahoo has no data for: never fetched, so they still sort first; a data-quality note, not part of this fix). 52 other tickers enter the batch (THYAO, GARAN, BIMAS, TUPRS, ...); 134 candidates for 120 slots, so the 14 stalest wait one run. Cost unchanged (EXPLAIN ANALYZE 48.6 ms before, 48.4 ms after).

**quotes-ingest** (optional, small): the JSON summary gains `notFound`, the count of `yahoo 404` failures, so a real symbol going dark shows without parsing the `failed` array. Nothing else changes; the function calls the same RPC with the same `p_limit`. Deploy it with `npx supabase functions deploy quotes-ingest --no-verify-jwt`. 160 works without the deploy and the deploy works without 160, in either order.

**Order:** apply 160 (`supabase db push`, operator); the next `quotes-intraday` tick (every 5 minutes, 07:00-15:55 UTC on weekdays) uses the new function. No Vercel deploy.

**Verify** (read-only):

```sql
select md5(prosrc), length(prosrc), prosecdef, provolatile, proacl::text
  from pg_proc where oid = 'public.bist_intraday_targets(integer)'::regprocedure;
-- 36d7209bf11615ba628fcee3f274faa3, 422, f, s, {postgres=X/postgres,service_role=X/postgres}
select has_function_privilege('anon', 'public.bist_intraday_targets(integer)', 'execute'),
       has_function_privilege('authenticated', 'public.bist_intraday_targets(integer)', 'execute'),
       has_function_privilege('service_role', 'public.bist_intraday_targets(integer)', 'execute');   -- f, f, t
select version, name from supabase_migrations.schema_migrations where version = '160';   -- 1 row
select count(*), count(*) filter (where last_ts is null) from public.bist_intraday_targets(1000);
-- about 134 candidates (was 186), and only the traded never-fetched ones (OYA, SEK today) have last_ts null
```

Then, during the next session (07:00-15:55 UTC), the intraday responses:

```sql
select to_char(created at time zone 'UTC', 'HH24:MI:SS') as at_utc, status_code,
       (content::jsonb ->> 'tickers')::int as tickers, (content::jsonb ->> 'fetched')::int as fetched,
       (select count(*) from jsonb_array_elements_text(content::jsonb -> 'failed') f where f like '%:yahoo 404') as n404,
       (select count(*) from jsonb_array_elements_text(content::jsonb -> 'failed') f where f like '%:deadline') as n_deadline,
       content::jsonb ->> 'notFound' as not_found   -- null until quotes-ingest is redeployed
  from net._http_response
 where created > now() - interval '30 minutes' and content like '{"mode":"intraday"%'
 order by created desc limit 6;
-- before 160: tickers 120, fetched 66, n404 54, n_deadline 0 on every row
-- after 160: n404 at most 3 (OYA, SEK and a symbol that just went dark), fetched >= 110, n_deadline 0
select round((percentile_cont(0.5) within group (order by extract(epoch from now() - b.last_ts) / 60))::numeric, 1) as p50_min,
       round((percentile_cont(0.9) within group (order by extract(epoch from now() - b.last_ts) / 60))::numeric, 1) as p90_min
  from (select distinct ticker from public.article_tickers where created_at >= now() - interval '7 days') t
  join (select ticker, max(ts) as last_ts from public.bist_bars_5m group by 1) b using (ticker);
-- during the session: p90 falls from about 26-28 min toward about 22 min (Yahoo's own delay is about 15 min plus the 5 min cadence)
```

**Rollback** (nothing else depends on 160; one transaction): re-run ONLY 058 section 7's `create or replace function public.bist_intraday_targets(p_limit int default 120)` statement (the text of `058_finance_hardening.sql` from that line through its closing `$$;`; it restores `md5(prosrc)` `ee892ad1547b7563bb43bb3ba4b17e52`), then remove ledger row 160 (`delete from supabase_migrations.schema_migrations where version = '160';`). The ACL does not change in either direction. A redeployed quotes-ingest that reports `notFound` is harmless without 160.

## 161 — `image_coverage` (`ops_health_report` row 21) and `image-consumer` tells a Cloudflare challenge from "no image": APPLY 161, THEN DEPLOY image-consumer

**Why:** medyascope.tv has answered every article fetch of the image consumer with a Cloudflare challenge (HTTP 403, `cf-mitigated: challenge`, title `Just a moment...`) since 2026-10-29. Its articles stored without an image, per day by `created_at` (image-less / total): 10-19..10-27 = 0 every day (12 to 47 a day); 10-28 1/26; 10-29 4/15; 10-30 27/32; 10-31 21/24; 11-01 15/18; 11-02 32/38; 11-03 34/37; 11-04 40/45; 11-05 28/31, every settled row at `image_backfill_attempts >= 3`. `fetchOgImage` and `fetchHeroImage` returned `null` for any non-2xx, so `image-consumer` filed the block as `not-found`, and no ops row noticed: `queue_lag` reads depth and age, `sources_newly_dark` (row 13) watches missing articles, and the report had no per-source image row. The code change does not touch the block: no User-Agent change, no retry, no other endpoint, no extra request. It only classifies the response the existing fetch already returned, and makes it visible.

**What 161 does** (additive, one transaction, safe to re-apply):

- re-creates `ops_health_report()` with 159's text verbatim (md5 `a2246bc0ea663b123144a2fa4c4f5735`, length 42501, the production fingerprint) plus **one new row, the 21st, `image_coverage`**: per source of kind `outlet` or `wire` with at least 10 articles created between 25 hours and 1 hour ago (the newest hour is skipped, the backfill has not reached it), the share stored without an image against the same source's own share over the 14 days before (at least 10 articles in it); **warn** when the 24 hour share is at least 50% and at least 40 points above that baseline; `observed` is the number of such sources, threshold 1; never a fail. The detail lists slug and the two percentages only (`... medyascope %86 görselsiz (14 gün: %38)`). Read-only on production (2026-11-05): 31-40 ms warm, 0.3-1.0 s on a cold cache, through `idx_articles_created_at` (the 24 hour window) and `idx_articles_created_source` (the baseline, only for sources over 50%); expected today `warn` / 1 naming medyascope. The function comment gains the description; revoke and grant are 159's two statements;
- adds, changes and unschedules no pg_cron job; no table, column or index; no data rewrite; **no reset of the parked rows**.

**What the image-consumer build does** (`supabase/functions/_shared/og-image.ts`, `supabase/functions/image-consumer`): new `classifyFetchBlock(status, headers, bodyHead)` returns `'challenge'` for a 403/429/503 that carries `cf-mitigated: challenge`, the `<title>Just a moment...` interstitial or the `challenge-platform` script (a 2xx or a 404 never); `fetchOgImageResult` / `fetchHeroImageResult` answer `{kind: 'found', url}`, `{kind: 'none'}` or `{kind: 'blocked', status}`, and `fetchOgImage` / `fetchHeroImage` stay thin `url | null` wrappers. `processMessage` gets a `blocked` outcome that is handled **exactly like not-found** (one `bumpAttempt`, one archive, so the row stops at attempts 3 (the requeue re-sends attempts 1-2 only, every 15 minutes) and a blocking site is asked at most 3 times per article) and is counted apart: the drain summary and the `drain` log line gain `blocked` and `blockedBySource` (slugs only, no URL, `unknown` for an article without a source).

**Order:** apply 161 first (`supabase db push`, operator), then deploy the function: `npx supabase functions deploy image-consumer --no-verify-jwt`. The reverse order is safe: the new function needs nothing from the database that 161 adds, and the report works with or without the row. No Vercel deploy.

**Verify** (read-only):

```sql
select count(*) from public.ops_health_report();   -- expect 21
select check_name, status, observed, threshold, detail
  from public.ops_health_report() where check_name = 'image_coverage';
-- expect warn / 1 / 1 / "son 24 saatte görselsiz haber oranı sıçrayan kaynak 1: medyascope %NN görselsiz (14 gün: %MM)" today;
-- pass / 0 / 1 once the site lets the fetch through again (or after the block has filled the 14 day baseline, around 2026-11-08)
select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
-- c1c2ff6c61daede5a5e8c8695547b445, 47349 (was a2246bc0ea663b123144a2fa4c4f5735, 42501)
select has_function_privilege('anon', 'public.ops_health_report()', 'execute'),
       has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'),
       has_function_privilege('service_role', 'public.ops_health_report()', 'execute');   -- expect f, f, t
select version, name from supabase_migrations.schema_migrations where version = '161';   -- 1 row
```

After the deploy, the next image-drain bodies carry the block, by slug, without a URL (the image-consumer bodies contain `"drained"`):

```sql
select created, content::jsonb ->> 'blocked' as blocked, content::jsonb -> 'blockedBySource' as by_source
  from net._http_response
 where created > now() - interval '30 minutes' and content like '%"drained"%'
 order by created desc limit 10;
-- blocked > 0 and {"medyascope": n} while the site blocks us; notFound no longer includes those pages
```

The per-day check is unchanged until access returns (the numbers above): `select (created_at at time zone 'UTC')::date, count(*) filter (where image_url is null), count(*) from public.articles where source_id = (select id from public.sources where slug = 'medyascope') and created_at > now() - interval '17 days' group by 1 order by 1`.

**Rollback** (nothing else depends on 161; one transaction): re-run ONLY 159's `ops_health_report()` section, the text of `159_ingest_stale_admission.sql` from `create or replace function public.ops_health_report()` through `grant execute on function public.ops_health_report() to service_role;` (it restores `md5(prosrc)` `a2246bc0ea663b123144a2fa4c4f5735`, length 42501, and 20 rows), then remove ledger row 161 (`delete from supabase_migrations.schema_migrations where version = '161';`). The ACL does not change in either direction. To undo the function, redeploy the previous `image-consumer`; a new function without 161 is harmless (the report just has no row 21), and 161 without the new function only reads the existing numbers.

**Founder follow-up (not part of this change, nothing here runs it):** access is a decision, not code. Ask Medyascope to allowlist Tayf's User-Agent (`Mozilla/5.0 (compatible; Tayf/1.0; +https://tayf.app)`), or approve a sanctioned image source (their RSS items carry no image). Once the fetch works again, the rows that gave up stay out of the requeue pool: most stop at attempts 3, and those from before migration 154 sit at 5 with attempted_at 7 days ahead. `image_backfill_requeue` picks only `image_backfill_attempts` 1 or 2, and only when the last try is over 2 hours old (a row parked at the 5th attempt has `image_backfill_attempted_at` 7 days ahead), so a one-off founder SQL puts the last 7 days back into its pool, newest first, 40 per quarter hour:

```sql
-- founder, ONLY after the site lets the fetch through; touches medyascope's image-less rows of the last 7 days
update public.articles a
   set image_backfill_attempts = 1,
       image_backfill_attempted_at = now() - interval '3 hours'   -- a parked row's attempted_at lies 7 days ahead
 where a.source_id = (select id from public.sources where slug = 'medyascope')
   and a.image_url is null and a.image_backfill_attempts >= 3
   and a.created_at > now() - interval '7 days';
```

## 162 — a stored neutral title the outlet has edited away is re-picked (`neutral_title_repick_candidates` stale-edit branch): DEPLOY Vercel, THEN APPLY 162 (no function deploy)

**Why:** `apply_article_title_edits` (074) rewrites `articles.title` when an outlet edits a headline and never touches `clusters.title_tr_neutral`; the re-pick (155) offers a stamped cluster only after a model change, a NULL stamp or growth, and an edit does none of the three. Cluster 31fde7d7 kept "Denizli'de çöp kamyonu sürücüsü, sıkışan temizlikçinin ölümü üzerine gözaltına alındı" (extractive-v6, stamped 2 of 2) after both members had been edited to "...temizlik işçisi hayatını kaybetti" (`article_title_versions` id 722175 holds the stored text as `old_title`), and `/cluster/31fde7d7-...` showed the detention claim in `<title>` and the H1 on a workplace death. Same pattern: 5893d4e5, 620362a3, 38610f3f. On 2026-11-05, folded substring match over clusters with a member published in the last 48 hours: **24 of 597**; over 7 days the stale set below returns **59 clusters**. Even a re-pick with `{ incumbent }` would not have helped: the incumbent branch only compared scores and never asked whether any member still carries the stored title (hunt 42, h42-titles-1).

**What 162 does** (additive, one transaction, safe to re-apply):

- `create or replace function public.neutral_title_repick_candidates(p_model text, p_limit integer default 20)` with 155's **signature, return columns, `language sql`, `stable`, SECURITY DEFINER, `search_path = ''`** and 155's three predicates, byte for byte, plus **one branch**: `or w.id in (select cluster_id from stale)`. The `stale` CTE (computed once, a hashed subplan) is: clusters that are active, have no LLM title and a stored title, whose stored title is contained in an `old_title` that `article_title_versions` recorded in the last 7 days for one of their articles, **and** that no current member title contains. "Contained" is judged on a **key**, `regexp_replace(public.tayf_search_fold(x), '[^a-z0-9]+', '', 'g')` (the house fold of 129, then every character outside `[^a-z0-9]` removed, the alphabet of 129's literal tier), applied to the old title, the stored title and the member titles, so case, Turkish letters, quotes, apostrophes and separators do not matter; a stored title whose key is empty is never stale. The anti join also accepts the legacy wording, `key(replace(member, 'Başkan Erdoğan', 'Cumhurbaşkanı Erdoğan'))`: extractive v1 to v5 stored "Cumhurbaşkanı Erdoğan ..." for a member's "Başkan Erdoğan ..." (cc01f26a). The 14 day / newest 5000 window, `order by w.updated_at desc` and the 1..50 limit are unchanged;
- restates the function comment (now "... Migrations 141, 155, 162."), 155's `revoke ... from public, anon, authenticated` and `grant execute ... to service_role`; adds, changes and unschedules no pg_cron job; touches no table, column, index or row. `apply_article_title_edits` is unchanged.

**Why a key and not the plain fold:** the first version compared `tayf_search_fold(x)` as it was, which keeps quotes and apostrophes as typed, while the picker's member test is blind to them. Five live clusters (read-only, 2026-11-05) stayed in the set after the picker had done all it could: 38721672 (straight quotes around "Türk Yüzyılı" against the member's curly ones), a6874bad (a curly apostrophe against a straight one), cc01f26a (the legacy wording), and 502e3032 and c2e4a77c (a stored question: it fails the gate and the picker answered null). The cron writes only the stamp and the CTE ignores stamps, so each was offered, re-written and stamped on every 5-minute tick until its `old_title` was 7 days old. The key removes the first three; the picker answering a stored title that fails the gate with the floor pick turns the last two into a member's wording. With the key the set swaps three clusters for three (38721672, a6874bad and cc01f26a leave; 38610f3f, bbe26fe7 and c526f480, edited titles the plain fold missed because the punctuation differed, enter) and stays at 59.

**Production fingerprint the replace was based on** (read-only, 2026-11-05): `md5(prosrc)` `e0d9b88645ff3d4952fb44d02b38ee98` (length 839), `prosecdef` t, `provolatile` s, `proconfig` `{search_path=""}`, `proacl` `{postgres=X/postgres,service_role=X/postgres}`; that md5 is the md5 of the text between the `$fn$` markers of 155 (`tests/migrations/162-stale-edit-repick.test.ts` recomputes it). The new body is `md5(prosrc)` `bb64fbb5bd16d32f659fb9d22889a166`, length 2418.

**What the Vercel deploy does** (`src/lib/clusters/neutral-title.ts`, no model bump for this part): new `incumbentIsMemberTitle(inc, memberTitles)` (case-, quote- and separator-blind, so a recased, sentence-cased, quote-repaired or glued-twin form of a member title still counts, as does the cleaned form of a "Son dakika..." member) and the `pickNeutralTitle` wrapper. A stored title that no member carries is not protected, **whether or not it passes the gate**: if it fails the gate (a question, a surviving lead-in) the pick is the first pick with the floor, a member's own cleaned wording; if it passes, the pick is the best member that passes the gate and is no more loaded or framed than the stored title and not Title Case, else the best member that passes the gate, else the stored title itself (never a floor title that fails the gate). That is what lets the cron fix the row 162 offers, and a new stored title is a member title, so the cluster leaves the stale set.

**Residue (what the branch does not guarantee):** a stale row is re-offered, and stamped without a change, on every 5-minute tick until its `old_title` is 7 days old when (a) its members give no usable title (every member title is blank or a placeholder, `pickNeutralTitle` returns null), (b) its stored title passes the gate when no member does (the picker keeps it rather than replace it with a floor title that fails the gate; fd5896d8 is the one such cluster among the 97 whose stored title no member carries in the 14-day replay), or (c) its stored title is a member's cleaned form that is not a substring of any member's key because `cleanHeadline` removed words from the middle (a mid-title "son dakika"; 0670a048 and 8088059e of 3,884, neither in the stale set that day). Each costs one re-pick and one stamp per tick, bounded by the 7-day window, and shares the 20-per-tick budget with the model-heal rows. The set therefore does not empty: it shrinks to this residue.

**Read-only checks before shipping:** the stale set returns 59 clusters (61 rows before the `IN` dedupes two clusters that two old titles each match) and all 59 sit inside the 14 day window (the same evening the model, growth and NULL-stamp branches offered 0 of the 3,878 in the window, so all 59 were stale-only); the function body as a plain SELECT (`p_model` `extractive-v6`, `p_limit` 50) returns 50 rows; EXPLAIN (ANALYZE, BUFFERS) with the key: 163-166 ms warm (three runs, 25,774 buffer hits, no reads; 4,747 `article_title_versions` rows, 1,292 distinct (cluster, old title key) pairs, 147 survive the strpos, 61 the anti join), against 94-101 ms for the plain fold. A cold run could not be repeated (the same pages had been read seconds before); the plan is the same plan on the same pages as the first version's cold run, which read 2,174 pages and took 1.54 s, so a cold execution is that run plus about 65 ms of regexp work.

**Order:** deploy to Vercel first (the headline cron is a Vercel route), then apply 162 (`supabase db push`, operator). Applying 162 before the new picker is live is harmless but wasteful: the cron would re-pick each stale cluster, get its stale title back and stamp it, and because the stale set does not look at the stamps the same 20 newest rows would be offered on every 5-minute tick, crowding the model-heal rows out of the budget until the deploy lands. No Edge Function deploy.

**Verify** (read-only):

```sql
select md5(prosrc), length(prosrc), prosecdef, provolatile, proconfig::text, proacl::text
  from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
-- bb64fbb5bd16d32f659fb9d22889a166, 2418, t, s, {search_path=""}, {postgres=X/postgres,service_role=X/postgres}
select has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
       has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
       has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute');   -- f, f, t
select version, name from supabase_migrations.schema_migrations where version = '162';   -- 1 row
-- the stale set, on the same key as the function: 59 right after applying; the cron re-picks 20 per tick and it shrinks to the residue above
with e as (select distinct ca.cluster_id, pg_catalog.regexp_replace(public.tayf_search_fold(v.old_title), '[^a-z0-9]+', '', 'g') fo
             from public.article_title_versions v join public.cluster_articles ca on ca.article_id = v.article_id
            where v.seen_at > pg_catalog.now() - interval '7 days')
select count(distinct e.cluster_id) from e join public.clusters c on c.id = e.cluster_id
 where not c.is_archived and c.title_neutral_at is null and c.title_tr_neutral is not null
   and pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), '[^a-z0-9]+', '', 'g') <> ''
   and pg_catalog.strpos(e.fo, pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), '[^a-z0-9]+', '', 'g')) > 0
   and not exists (select 1 from public.cluster_articles ca2 join public.articles a2 on a2.id = ca2.article_id
                    where ca2.cluster_id = c.id
                      and (pg_catalog.strpos(pg_catalog.regexp_replace(public.tayf_search_fold(a2.title), '[^a-z0-9]+', '', 'g'),
                                             pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), '[^a-z0-9]+', '', 'g')) > 0
                           or pg_catalog.strpos(pg_catalog.regexp_replace(public.tayf_search_fold(pg_catalog.replace(a2.title, 'Başkan Erdoğan', 'Cumhurbaşkanı Erdoğan')), '[^a-z0-9]+', '', 'g'),
                                                pg_catalog.regexp_replace(public.tayf_search_fold(c.title_tr_neutral), '[^a-z0-9]+', '', 'g')) > 0));
```

Then `GET /cluster/31fde7d7-548c-42b2-8f5e-7d293510f329` (after the page's ISR window) shows "...temizlik işçisi hayatını kaybetti" in `<title>` and the H1.

**Rollback** (nothing else depends on 162; one transaction): re-run section 1 of `155_neutral_title_repick_growth.sql` (its `create or replace function`, `comment on function`, `revoke` and `grant`; it restores `md5(prosrc)` `e0d9b88645ff3d4952fb44d02b38ee98`, length 839), then remove ledger row 162 (`delete from supabase_migrations.schema_migrations where version = '162';`). The ACL does not change in either direction. The picker change needs no rollback for the SQL: a Vercel build without it simply never repairs the stale rows.

## 163 — "Yükselen Konular" counts only what the hubs would show (`trends_daily_entity_counts_ist_refresh` guards): APPLY 163, no deploy-order constraint

**Why:** 112 joins every title gram to the vocabulary with none of the guards the `/gundem/<key>` hubs apply (`RISING_HUB_SPECS` excludes for `tcmb`, `aym` and `meclis`, `QUANTITY_GUARD` for `dolar`, `src/lib/trends/rising-entities.ts` and `src/lib/entities/entity-hub.ts`). On 2026-11-05 (read-only) `/trends` listed "Merkez Bankası · Bugün 38 haber · 7 günlük ortalamanın 2,1 katı", and 10 of those 38 titles were the Bank of England ("İngiltere Merkez Bankası faizi yüzde 4'e çıkardı", aksam, anadolu-ajansi, euronews, sozcu, ...); the rest is mostly the weekly TCMB reserves item. `dolar` read 47, of which 35 name an amount ("158,1 milyar dolar", "200 milyon dolar", "brent petrolün varili 94,07 dolar"). `meclis` counted "İsrail Meclis Başkanı", "İran Meclis Başkanı" and municipal "meclis üyesi" stories; `aym` counted "Polonya Anayasa Mahkemesi" (h43-entities-3).

**What 163 does** (function-only, one transaction, safe to re-apply): `create or replace function public.trends_daily_entity_counts_ist_refresh(p_days integer default 2)` with 112's **signature, `SECURITY DEFINER`, `search_path = ''`, `plan_cache_mode = force_custom_plan` and grants** (revoke from public, anon, authenticated; execute to `service_role`), the comment restated, and 112's body **byte for byte except two places**: a marked block between the `hits` and `agg` CTEs (`-- 163 guards begin` .. `-- 163 guards end`: `guard_map` and `guarded`, joined back to `day_articles` for the folded title), and `agg` counting `from guarded h`. The guards:

- `tcmb`: a hit is dropped when the folded title matches one of `RISING_HUB_SPECS.tcmb.excludes` (`avrupa merkez`, `ecb`, `fed`, `abd merkez`, `amerikan merkez`, `israil merkez`, `ingiltere merkez`, `japonya merkez`, `rusya merkez`, `cin merkez`) and has no `tcmb` word (TCMB is trusted: "TCMB, Fed kararını değerlendirdi" stays);
- `aym` and `meclis`: the same rule with their excludes; the trusted tokens `aym`, `tbmm` and `büyük millet meclisi` bypass the veto. The hub's `requires` list for the bare "Meclis" is **not** mirrored;
- `dolar`: a hit is kept only when some `dolar` in the title passes `QUANTITY_GUARD` (not after a digit, `bin`, `milyon`, `milyar`, `trilyon`, `milyonlarca`, `milyarlarca`);
- every other entity passes untouched. It creates, drops, alters and deletes nothing else, schedules no cron job and writes no row. `tests/migrations/163-trends-entity-rollup-guards.test.ts` pins the body to 112's, the regex strings to `RISING_HUB_SPECS` and `QUANTITY_GUARD`, and runs a JS twin on the four fixtures of the spec.

**No backfill.** The hourly `trends-rollup-refresh` run (`:25`) recomputes the last 2 Istanbul days (and any day within 10 days that received a late-ingested row) with the new body, so today and yesterday are right one run after applying. Older baseline rows (D-2 .. D-8) keep their unguarded counts and leave the 7-day baseline within a week. Until then the baseline of `tcmb`, `dolar`, `meclis` and `aym` is a little high, so a spike in those four is judged against a generous baseline: it can be hidden for a few days, never invented.

**Function fingerprint** (`md5(prosrc)`, `length(prosrc)`):

| | md5 | length |
|---|---|---|
| production before 163 (read-only, 2026-11-05) = the body of 112 | `b0a0dcce4dd8df781c35ed7a73af576e` | 5937 |
| after 163 | `dc1e1d4780b3b8d2e9c0a4ac8c64caf8` | 7590 |

**Read-only replay before shipping** (the per-day statement of 112/163 without its `insert`, as a plain SELECT for the Istanbul day 2026-11-05, run through the read-only SQL console; 0.8-1.3 s, the same as 112's):

| entity | 112 (now) | 163 |
|---|---|---|
| `tcmb` | 38 | 28 |
| `dolar` | 47 | 12 |
| `meclis` | 127 | 105 |
| `aym` | 13 | 12 |

The other 58 entities are identical. The 10 dropped `tcmb` titles are all "İngiltere Merkez Bankası ..."; two more Bank of England stories stay because no title carries the phrase "ingiltere merkez" (the hub has the same hole), and 26 are domestic (weekly reserves, TCMB reports). A currency headline with a date in front ("5 kasım 2026 dolar kuru ne kadar oldu?") reads as an amount and is dropped, as it is on the dolar hub. 2026-11-02: `tcmb` 20 -> 18, `dolar` 64 -> 18, `meclis` 99 -> 89. 2026-10-26 (the deepest day the function can touch) took 1.2 s against 1.1 s for 112's text, both warm.

**Order:** apply `163_trends_entity_rollup_guards.sql` (`supabase db push`, or `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/163_trends_entity_rollup_guards.sql`; operator) at any time. It depends on no app build and nothing depends on it; the Vercel deploy of the `/trends` hub-link change (a thin hub links to the home search) can go before or after. No Edge Function deploy.

**Verify** (read-only):

```sql
select md5(prosrc), length(prosrc), prosecdef, proconfig::text, proacl::text
  from pg_proc where oid = 'public.trends_daily_entity_counts_ist_refresh(integer)'::regprocedure;
-- dc1e1d4780b3b8d2e9c0a4ac8c64caf8, 7590, t, {"search_path=\"\"",plan_cache_mode=force_custom_plan}, {postgres=X/postgres,service_role=X/postgres}
select has_function_privilege('anon', 'public.trends_daily_entity_counts_ist_refresh(integer)', 'execute'),
       has_function_privilege('authenticated', 'public.trends_daily_entity_counts_ist_refresh(integer)', 'execute'),
       has_function_privilege('service_role', 'public.trends_daily_entity_counts_ist_refresh(integer)', 'execute');   -- f, f, t
select version, name from supabase_migrations.schema_migrations where version = '163';   -- 1 row
-- after the next :25 run: today's guarded counts (updated_at later than the apply)
select entity, count, updated_at from public.trends_daily_entity_counts_ist_rollup
 where day = (now() at time zone 'Europe/Istanbul')::date and entity in ('tcmb', 'dolar', 'meclis', 'aym') order by entity;
select jobid, status, return_message, start_time, end_time from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'trends-rollup-refresh') order by runid desc limit 3;
```

Then `GET /trends`: a "Yükselen Konular" row whose hub is thin (fewer than 3 clusters) links to `/?q=<label>`, and `GET /gundem` shows no link to a hub with no cluster in the last 14 days (for example `/gundem/hamas` while it is empty).

**Rollback** (nothing else depends on 163; one transaction): re-run the function statements of `112_trends_entity_rollup.sql` (section 2: its `create or replace function`, `comment on function`, `revoke` and `grant`; it restores `md5(prosrc)` `b0a0dcce4dd8df781c35ed7a73af576e`, length 5937), then remove ledger row 163 (`delete from supabase_migrations.schema_migrations where version = '163';`). The ACL does not change in either direction. The next `:25` run recomputes today and yesterday unguarded again.

## 164 — `price_at` reads the 5-minute bar until the daily close is final (session-aware): APPLY 164, no deploy-order constraint

**Why:** 062's `price_at(p_ticker, p_ts)` preferred the daily close of the Istanbul day of `p_ts` whenever one existed, so a news timestamp inside today's session (or before 18:10, when the daily bar is still being written) was priced at a close that did not exist yet at that moment, and the "+%N haberden" chips on `/ekonomi` measured against the wrong base (h48).

**What 164 does** (function-only, one transaction, safe to re-apply): `create or replace function public.price_at(...)` with 062's signature, volatility and grants. The latest 5-minute bar at or before `p_ts` (within 4 days) wins unless a daily close exists for a day whose 18:00 Istanbul close is after that bar; the daily close is only used for days that had closed (18:10 Istanbul) by `p_ts`. No table, index, cron or data change.

| | md5(prosrc) | length |
|---|---|---|
| before 164 = the body of 062 | `57f79dbd2e2845d01d44bce6c67d4354` | 533 |
| after 164 (applied 2026-11-06) | `062c2405345dd5e61a3bdb11f6474eb5` | 827 |

**Rollback:** re-run only 062 section 2's function statement (restores md5 `57f79dbd…`), then `delete from supabase_migrations.schema_migrations where version = '164';`.

## 165 — the framing candidate pool admits only political, outlet-kind, Turkish-language sources: APPLY 165, no deploy-order constraint

**Why:** 130's `framing_candidate_pool_refresh()` pooled every article of a multi-source cluster, so the framing game drew agency wires, ministry feeds and English-language outlets next to political Turkish outlets (h48).

**What 165 does** (function-only, `SECURITY DEFINER`, `search_path = ''`, one transaction, safe to re-apply): 130's body plus three gates: the article's category is political (or the source has `politics_admitted_at`), `coalesce(s.kind, 'outlet') = 'outlet'`, and the six `ENGLISH_SOURCE_SLUGS` (including `mfa-turkey`) are excluded. The next 5-minute refresh rebuilds the pool; on 2026-11-06 it held 2,545 rows with 0 non-outlet and 0 non-political.

| | md5(prosrc) | length |
|---|---|---|
| before 165 = the body of 130 | `9d57360d0dc610c8c2d3c1d97ca6fc75` | 2093 |
| after 165 (applied 2026-11-06) | `eca2c0c86cd141e01a6f4b141fa8b977` | 3022 |

**Rollback:** re-run only 130 section 4's `create or replace function public.framing_candidate_pool_refresh()` statement (restores md5 `9d57360d…`), then delete ledger row 165. The next refresh rebuilds the old pool.

## 166 — archive search stops filling its page with stem collisions (`search_cluster_ids` over-stem guard): APPLY 166, no deploy-order constraint

**Why:** the Turkish snowball stemmer cuts some words to 2-4 letters (`burdur -> bur`, `ersan -> er`, `ilhan -> ilha`, `tarla -> tar`, `iğdir -> ik`), and 129's `cand` CTE takes every row holding any word with that stem; its literal word-start tier only re-orders, so `LIMIT 24` is filled from the stem-only tail. On 2026-11-06 (read-only) `/?q=burdur` showed 14 Bursa / Bulgaristan / "burun buruna" stories of 24, `ersan` 22 "erken seçim" / "sona erdi" rows, `ilhan` 11 İlham Aliyev rows, `tarla` 18 Tarım Bakanlığı rows (h50-search-1).

**What 166 does** (function-only, `SECURITY DEFINER`, `search_path = ''`, grants re-issued to `service_role` only, one transaction, safe to re-apply): 129's body plus one guard. A typed word whose stem over-cuts it (stem shorter than the word and at most 4 letters) must also appear, by `left(word, max(4, len(stem)+1))`, at a word start in the title, the summary or the neutral title of every kept row. Exempt: a 3-4 letter folded root plus a case or plural suffix (`irakta`, `kirada`, `natonun`, `faize`, `zamlar`, `ilaci`); a 3-letter root needs a suffix of 3+ letters, so `tarla` and `putin` stay guarded. The guard is skipped for queries with `OR` or a negated phrase; negated words are never guards. A query with no guarded word runs exactly as 129 (same top 24 for `şişli`, `putin`, `erdoğan`, `chp`, `istanbul`, `iran`, `seçim`, the `akp` alias). 083's two-argument fallback and the app are untouched.

| | md5(prosrc) | length |
|---|---|---|
| before 166 = the body of 129 (production, 2026-11-06) | `cb7fee8680c50e8f20bafab3e29fef39` | 3426 |
| after 166 | `d7f4b4223730e06db8479f42776d8040` | 9680 |

**Cost** (EXPLAIN ANALYZE on production, inline bodies, medians): `iran` 128 -> 165 ms (1.29x), `seçim` 129 -> 165 ms, `bakan` 156 -> 194 ms; guarded queries get cheaper (`burdur` 42 -> 30 ms, `ersan` 67 -> 42 ms). Known worst case above the 1.3x gate: a few-survivor query walks every candidate (`bakam` 152 -> 444 ms, `ayse` 145 -> 268 ms), close to the existing `-qwxz` worst case of about 382 ms.

**Order:** apply `166_search_overstem_guard.sql` any time; no app deploy depends on it.

**Verify** (read-only): `md5(prosrc), length(prosrc)` of `'public.search_cluster_ids(text[], text, integer)'::regprocedure` is `d7f4b4223730e06db8479f42776d8040`, 9680; `has_function_privilege('anon', …, 'execute')` false and `('service_role', …)` true; ledger row 166 present. Then `GET /?q=burdur` and `/?q=ersan` show no Bursa or erken-seçim cards, `/?q=irakta` still shows the Irak stories, `/?q=şişli` is unchanged.

**Rollback:** re-run only the function statement of section 3 of `129_search_fold_rank.sql` (restores md5 `cb7fee86…`), then `delete from supabase_migrations.schema_migrations where version = '166'; notify pgrst, 'reload schema';`.

## 167 — `queue_lag` counts poison as the consumers define it (`read_ct > 3`, the 4th read; `ops_health_report` row 18): APPLY 167 only, no deploy

**Why:** row 18 (`queue_lag`) counted a message as `zehirli` (poison) when it was archived in the last 24 hours with `read_ct` 3 or more. `image-consumer` and `cluster-consumer` archive a message as poison only when `read_ct > MAX_READS` (`MAX_READS = 3`), on the 4th read; a message processed and archived on its 3rd read is healthy. On 2026-11-06 the 11 `image_backfill` rows `msg_id` 182446-182456 (`haberport`, enqueued 06:51, archived by 07:05) all had `read_ct = 3` and every article had `image_url` set with `image_backfill_attempts = 0`, yet `ops_health_report()` read `queue_lag` warn with `zehirli (24 sa): 11`, for 24 hours after the archive. Across both archives, rows with `read_ct > 3` = 0 on every day since 2026-10-30. The report is not public, so this is an ops monitoring fix: no more false warn after a requeue flood, and a real poison message (a 4th read) is no longer masked by 3rd-read archives.

**What 167 does** (function-only, `SECURITY DEFINER`, `search_path = ''`, grants re-issued to `service_role` only, one transaction with `lock_timeout = '5s'`, safe to re-apply): 161's body verbatim except the two `a.read_ct` comparisons of row 18 (now `a.read_ct > 3`) and the two sentences that describe them (the row-18 comment and the function comment, which also gains 167 in its migration list). The detail format (`zehirli (24 sa): N`), every limit and every other row are unchanged. `tests/migrations/167-ops-queue-poison-contract.test.ts` parses both Edge Functions, so the SQL limit and `MAX_READS` cannot drift apart. The `image-consumer` edit that ships with it fixes a wrong comment at the top of the per-message loop (an unprocessed tail was already counted by `pgmq.read`, and comes back after the visibility timeout; `READ_BUDGET_FLOOR_MS` limits how often); it is comment-only.

| | md5(prosrc) | length |
|---|---|---|
| before 167 = the body of 161 (production, 2026-11-06) | `c1c2ff6c61daede5a5e8c8695547b445` | 47349 |
| after 167 | `5a9f9e384da09a19df1cd73a3f8ba4a5` | 47439 |

**Order:** APPLY 167 only (`supabase db push`). No Edge Function deploy and no app deploy: the `image-consumer` change is comment-only, so there is no redeploy; the next heartbeat run (30 minutes) or 10 minute snapshot (131) shows the new count.

**Verify** (read-only): `select status, detail from public.ops_health_report() where check_name = 'queue_lag'` answers `pass` when the ages are normal, with a detail ending `zehirli (24 sa): 0` (it read `warn` and `zehirli (24 sa): 11` before); `select count(*) from pgmq.a_image_backfill where archived_at > now() - interval '24 hours' and read_ct > 3` is 0; `md5(prosrc), length(prosrc)` of `'public.ops_health_report()'::regprocedure` is `5a9f9e384da09a19df1cd73a3f8ba4a5`, 47439; `has_function_privilege('anon', …, 'execute')` and `('authenticated', …)` false, `('service_role', …)` true; `select version, name from supabase_migrations.schema_migrations where version = '167'` returns one row.

**Rollback:** re-run only the `ops_health_report()` section of `161_image_coverage_by_source.sql` (from `create or replace function public.ops_health_report()` through `grant execute on function public.ops_health_report() to service_role;`, which restores md5 `c1c2ff6c61daede5a5e8c8695547b445`, length 47349), then `delete from supabase_migrations.schema_migrations where version = '167';`. The false warn after a 3rd-read archive comes back with it.

## 168 — Çerçeve meets each story once per session (`framing_next_headline` draws one row per event): APPLY 168 only, no Next.js change

**Why:** 105's draw excluded only the exact article a session had voted on, and the newest 300 pool rows are 167 events (cluster `85ef184c` alone supplies 25 of them, `48e267ee` 13, `ab528fee` 10). A Monte Carlo over that draw set gives P(an event repeats within one session) = 0.42 / 0.70 / 0.87 / 0.99 after 10 / 15 / 20 / 30 headlines and P(byte-identical text) = 0.015 / 0.039 / 0.064 / 0.142. A round is 60 seconds and the session cookie lasts 30 days; the footer says the cookie exists to avoid showing the same headline again (h52-game-1).

**What 168 does** (one function and one index, `SECURITY DEFINER`, `search_path = ''`, grants re-issued to `service_role` only, one transaction, safe to re-apply): it creates `framing_votes_session_hash_article_idx` on `framing_votes (session_hash, article_id)` (plain `create index if not exists`, in the same transaction) and replaces the draw with 105's body plus three things. The index is there because the voted-set read needs every vote of the session and no existing index of the table starts with `session_hash`; without it each draw read the whole unique `(article_id, session_hash)` index, up to 3 times per request. The clusters and the normalised texts (`lower(regexp_replace(title, '\s+', ' ', 'g'))`) the session has voted on are excluded, the first before the newest-300 cut (so the window slides past voted events) and the second after it. The newest 300 are then cut to one row per event, picked at random (event = cluster, else the normalised text), so every event has the same chance whatever its copy count. The event key is the smallest cluster id by ordering: the finding's `min(cluster_id)` fails on production, which has no `min(uuid)` aggregate (PostgreSQL 17.6). The cluster exclusion is written as `NOT IN` over `cluster_articles` (see Cost). The 48 h window, the per-article anti-join, the limit 300, the fewer-than-5-votes-first order and the final random pick are 105's text; the route and the pool are untouched. No table, column, cron or data change; the new index is the only new object.

| | md5(prosrc) | length |
|---|---|---|
| before 168 = the body of 105 (production, 2026-11-06) | `21a64cbeecb880d83d988fb0e9bbe42b` | 1137 |
| after 168 | `56fd752b4bd8f15bd843c24d5769548c` | 3616 |

**Cost** (EXPLAIN ANALYZE on production, read-only, the new body as a plain SELECT with the voted set a literal id list whose row estimate is forced low, the unfavourable case): planning 3.0 to 3.5 ms; execution 8 to 12.5 ms for an empty session (105's body: 1.3 plus 1.0 ms), 16.4 ms with 40 voted events, 22.6 ms with 120 and 32 ms with 600, all far under 100 ms. The cluster exclusion is `NOT IN`, not `NOT EXISTS`: the draw is a non-inlined SQL function, so `session_hash = $1` is estimated from the average votes per session and a heavy player's voted set is under-estimated. The `NOT EXISTS` form then planned as a Nested Loop Anti Join with a Join Filter: at 600 voted events it removed 1.45M rows and took about 215 ms (217 ms in each of three repeat runs), against about 31 ms for `NOT IN` (32 to 33 ms in the same repeats), which plans as a hashed subplan filter (with an empty voted set the two are equal). `NOT IN` is NULL-safe here because `cluster_articles.article_id`, `cluster_articles.cluster_id` and `framing_candidate_pool.article_id` are all NOT NULL, and it returns the same pool rows (an empty difference both ways at 120 and 600 voted events). The newest 300 rows give 161 one-per-event rows with 161 distinct event keys. `framing_votes` had no index that starts with `session_hash`, so every draw would have read the whole unique index, whatever the session's own history; the table is append-only and anonymous clients write to it through the vote route (200 votes per hour per IP), so its size is not ours to bound. `framing_votes_session_hash_article_idx` makes the voted-set read an index range scan, so a draw's cost follows that session's own votes. The index builds instantly on today's table (0 rows).

**Order:** APPLY `168_framing_draw_one_per_event.sql` any time (`supabase db push` or post the SQL). No Next.js change and no Edge Function deploy: the next draw uses the new body.

**Verify** (read-only): `md5(prosrc), length(prosrc)` of `'public.framing_next_headline(text)'::regprocedure` is `56fd752b4bd8f15bd843c24d5769548c`, 3616; `select indexdef from pg_indexes where schemaname = 'public' and indexname = 'framing_votes_session_hash_article_idx'` returns one row, `CREATE INDEX framing_votes_session_hash_article_idx ON public.framing_votes USING btree (session_hash, article_id)`; `has_function_privilege('anon', …, 'execute')` and `('authenticated', …)` false, `('service_role', …)` true; `select version, name from supabase_migrations.schema_migrations where version = '168'` returns one row. A plain SELECT of the new body with a literal session hash returns one row. Then play one round on `/oyun` in Çerçeve mode: no two headlines of one story, and no headline repeated after a vote.

**Rollback:** re-run only the `create or replace function public.framing_next_headline(p_session_hash text)` statement of section 3 of `105_framing_candidate_pool.sql` (restores md5 `21a64cbeecb880d83d988fb0e9bbe42b`, length 1137; its revoke and grant are unchanged), then `drop index if exists public.framing_votes_session_hash_article_idx;` and `delete from supabase_migrations.schema_migrations where version = '168';`. Sessions then see sibling headlines again.

## 169 — a stamped neutral title that fails the length or '?' gate is re-offered once the cluster grows (`neutral_title_repick_candidates` gate-fail branch): APPLY 169 only, no Next.js change

**Why:** the first pick of a cluster at 2 members keeps the floor title when no member passes the gate, and the re-pick (155, 162) offers a stamped cluster again only after a model change, a NULL stamp, growth by half (5 members for a stamp of 2) or an outlet edit. A title that fails the gate and then gains a clean member is none of those, so it stays live. On 2026-11-06 (read-only, 18:48-18:53Z, all extractive-v6, all stamped 2): `d096acf8` 203 characters, `article_count` 3 (the haberler-com quote, next to AA's own 95-character wording); `442e0395` 167 characters, count 4 (Hürriyet's "... 100 bin dolar rüşvet verilen kutu içindeki atkıları ... kendi kredi kartımla aldım", an unproven bribery stated as fact about the opposition leader in the first person, in `<title>` and `og:title` of a 200 / index,follow page); `e0750c57` 129 characters, count 3. The v6 heal does not cover them (they already carry v6). A replay of the real `pickNeutralTitle` on the current members, fresh and with `{ incumbent: stored }`, returns the member that passes for each, so one re-offer heals each. Scope: 34 v6 titles in 7 days are over 110 characters or hold a '?' (18:48Z), 5 of them grown since the stamp and all 5 below the growth bar; re-measured at about 19:08Z, 42 and 6, none past the bar (`f19d276c`, `7324209f` and `012deab8` are the other three, titles that hold a question; no member passes the gate there, so the picker answers null, the cron keeps the title and stamps the count, and they leave the set after one tick).

**What 169 does** (function-only, `SECURITY DEFINER`, `search_path = ''`, grants re-issued to `service_role` only, one transaction with `lock_timeout = '5s'`, safe to re-apply): 162's body byte for byte plus one branch at the end of the outer `WHERE`: the cluster is stamped, `article_count` is strictly greater than the stamp, and the stored title is longer than 110 characters, or shorter than 20 after `btrim`, or holds a '?'. 110 and 20 are `ACCEPT_MAX_LEN` and `ACCEPT_MIN_LEN` in `src/lib/clusters/neutral-title.ts`; `tests/migrations/169-repick-gate-fail.test.ts` reads both from that file, and checks the picker's own gate at both edges. The function comment now ends "Migrations 141, 155, 162, 169.". There is no loop: the headline cron stamps `title_neutral_member_count` = `article_count` after every pick, a kept title included, so a title that still fails the gate comes back only after further growth, and the pick runs with `{ incumbent }`, where a gate-failing incumbent is not protected. No table, column, index, cron job or data change, no `UPDATE`, no `EXTRACTIVE_MODEL_ID` bump (the v6 heal is running), no LLM. The cron route changes by a comment only.

| | md5(prosrc) | length |
|---|---|---|
| before 169 = the body of 162 (production, 2026-11-06) | `bb64fbb5bd16d32f659fb9d22889a166` | 2418 |
| after 169 | `c5a3b354ff0f51ef77fae5b3fbf11b0a` | 2745 |

**Cost** (EXPLAIN ANALYZE, BUFFERS, TIMING OFF as a plain SELECT, read-only, 2026-11-06 ~19:10Z): 162's body 1,157 ms cold, then 133 and 150 ms warm; 169's body 136, 136 and 150 ms warm. Planning time 4.6-6 ms for both. The new branch is a few comparisons on the at most 5000 rows of the window.

**Order:** APPLY `169_neutral_title_repick_gate_fail.sql` any time (`supabase db push` or post the SQL). No app deploy and no Next.js change: the picker already returns a member's wording for a gate-failing incumbent, and the cron already stamps after every pick.

**Verify** (read-only): `md5(prosrc), length(prosrc)` of `'public.neutral_title_repick_candidates(text, integer)'::regprocedure` is `c5a3b354ff0f51ef77fae5b3fbf11b0a`, 2745 (was `bb64fbb5bd16d32f659fb9d22889a166`, 2418); `has_function_privilege('anon', …, 'execute')` and `('authenticated', …)` false, `('service_role', …)` true; `select version, name from supabase_migrations.schema_migrations where version = '169'` returns one row. The newly offered clusters are the ones that are stamped, grown and gate-failing (the query is in the header of the migration; 6 on 2026-11-06 ~19:08Z, including `d096acf8`, `442e0395` and `e0750c57`). Within two headline cron ticks, `GET /cluster/d096acf8-690a-4c46-bdd0-b2f2263ef3d7` shows AA's "Cumhurbaşkanı Erdoğan: Azerbaycan'la ilişkilerimiz klasik diplomatik temasların çok ötesindedir" in `<title>` and the H1 (page cache: allow the ISR window).

**Rollback:** re-run only section 1 of `162_neutral_title_stale_edit_repick.sql` (its `create or replace function`, comment, revoke and grant; restores md5 `bb64fbb5bd16d32f659fb9d22889a166`, length 2418), then `delete from supabase_migrations.schema_migrations where version = '169';`. The ACL does not change in either direction.

## 170 — `/gundem/akp` stops listing clusters that name the party only in the summary lead (new `entity_cluster_ids_v3` with `p_headline_only`): APPLY 170 first, then DEPLOY the app

**Why:** h56-entities-2 (hunt 56). 156 made the hub regex read the title, the neutral title and the first line of the summary. For akp that first line is mostly an epithet: "eski AK Parti milletvekili Ertan Aydın", "AK Parti Samsun Milletvekili Mehmet Muş başkanlığında", a minister at an AK Parti ilçe başkanlığı. Read-only replay on 2026-11-06 (~21:27Z, 14-day window, live clusters, the app's exact akp queries and patterns): 308 candidates by the prefilter, 303 match the lead mode, 174 name the party in a headline (`title_tr` or `title_tr_neutral`), 129 only in the lead, 0 added. A hand label of 30 random lead-only rows: 3 clearly about the party, 10 borderline (the party is a participant), 17 not. Visible cards of the old list that were not about the party: `0f16f0f5` (Bakan Bayraktar, Milli Enerji 2040), `8bc853c6` (Gürlek in Mardin), `cef0db8b` (an Ağrı school opening), `fffc451b` (the Kültür ve Turizm Bakanlığı budget in the Plan ve Bütçe Komisyonu) and `7c57724b` (Emine Erdoğan). The hub's bias bar is summed over these. The loss is real but small: a poll whose lead says "AK Parti yüzde 29,7" (`d77c3949`) leaves too. chp and mhp keep the lead: their lead-only rows (58 of 152, 49 of 100) are mostly the story of the party itself (the split to Yeni Parti, "MHP lideri Devlet Bahçeli"), and the country and person hubs name their subject in the lead far more often than a party is an epithet. This is not h34-reader-5 (teaser lines after the first newline, fixed by 156): these epithets are in the lead sentence itself.

**What 170 does** (one function created, `SECURITY DEFINER`, `search_path = ''`, `stable`, execute revoked from public, anon and authenticated and granted to `service_role` only, one transaction with `lock_timeout = '5s'`, safe to re-apply): `public.entity_cluster_ids_v3(p_queries text[], p_patterns text[], p_since timestamptz default null, p_limit integer default 20, p_headline_only boolean default false)`. Its body is the body of `entity_cluster_ids_v2` (production's, 156's) with one expression changed: the text the regex runs on is a CASE on `p_headline_only`, the title and the neutral title alone when it is true, 156's expression (those two plus the first line of the summary) otherwise. The flag defaults to false and a NULL flag takes the else branch, so a four-argument call behaves like v2. The prefilter, the 083 live predicate, the 14/30-day window, the order, the 1..50 clamp and the total are v2's. `entity_cluster_ids_v2` is not dropped, replaced or granted again: it is the app's fallback. 156 is named v3 but defines v2; a search of every migration finds no object called `entity_cluster_ids_v3`. No table, column, index, cron job or data change, no `UPDATE`, no LLM. The app side is `headlineOnly` on the akp entry of `RISING_HUB_SPECS` and a v3 call that sends the flag (true for akp, false for every other hub).

| | md5(prosrc) | length |
|---|---|---|
| `entity_cluster_ids_v2` before and after 170 = the body of 156 (production, 2026-11-06) | `81be59e839f81c6e738e32a658c2a8eb` | 884 |
| `entity_cluster_ids_v3` after 170 | `bc1ea39f547ca8d6810833f12c7bd983` | 1117 |

**Cost** (EXPLAIN ANALYZE, BUFFERS, TIMING OFF as a plain SELECT with the akp arrays, read-only, 2026-11-06 ~21:30Z): the same plan for both bodies (a BitmapAnd of `idx_clusters_active_updated_at` and `clusters_search_tsv_idx`, 454 buffers). v2's body 29.5 ms twice; 170's body with the flag false 30.3 and 29.5 ms, with the flag true 20.2 ms twice (less text to fold). Planning 4.7 to 5.0 ms for all three.

**Order:** migration first, then the app. APPLY `170_entity_cluster_ids_headline_only.sql` (`supabase db push` or post the SQL), then DEPLOY the app. An app deployed before the migration still works: PostgREST answers PGRST202 for `entity_cluster_ids_v3`, the app retries the four-argument `entity_cluster_ids_v2` (the lead counts for akp again until 170 is applied), and on PGRST202 again it falls back to 123's `entity_cluster_ids`. The cache key of a hub read includes the flag. No Edge Function deploy.

**Verify** (read-only): `md5(prosrc), length(prosrc)` of `'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)'::regprocedure` is `bc1ea39f547ca8d6810833f12c7bd983`, 1117, and of `entity_cluster_ids_v2` still `81be59e839f81c6e738e32a658c2a8eb`, 884; `has_function_privilege('anon', …, 'execute')` and `('authenticated', …)` false, `('service_role', …)` true; `select version, name from supabase_migrations.schema_migrations where version = '170'` returns one row. After the deploy `GET /gundem/akp` reads "Son 14 günde" about 174 and lists none of `0f16f0f5`, `cef0db8b` and `fffc451b` (page cache: allow the ISR window); `/gundem/chp` and `/gundem/mhp` are unchanged.

**Rollback:** `drop function public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean);` then `delete from supabase_migrations.schema_migrations where version = '170';`. The app falls back to `entity_cluster_ids_v2` on PGRST202 by itself (akp counts the lead again); v2 is not part of this migration and is not touched by the rollback.

## 171 — a shared brand alias no longer attaches every sibling company (`resolve_article_tickers_for`, `alias_hits` rules A and B): APPLY 171 only, no Next.js change

**Why:** h57-ekonomi-2 (hunt 57). 085's `alias_hits` joins every enabled `bist_aliases` row found in the folded text (an auto row only needs finance context). When one alias is shared by several tickers, every sibling attaches. `/ekonomi` on 2026-11-07 (one GET at 14:25Z plus read-only SQL), feed items as rendered: "TSKB’nin iklim finansman hedefi 5 milyar dolar" carries TSGYO 4,16 +%1,71 next to TSKB and TSKYO; "Turkcell COP31’de dijital ve yeşil dönüşüm vizyonunu paylaşacak" carries FNCLL next to TCELL; the "ARTIK" sergisi COP31 story carries AKFEN, AKFGY, AKFIS and AKFYE; "OYAK’tan Libya petrolünde büyük hamle" carries OYAKC +%0,15 and OYAYO 30,52 +%9,86. `tskb` maps to TSKB (manual), TSGYO (auto, traded) and TSKYO (auto, not traded); `turkcell` maps to TCELL (manual) and FNCLL (auto, TURKCELL FİNANSMAN, not traded). 61 enabled aliases are shared by 2 to 6 tickers (ihlas 6, nurol 6, oyak 4, akfen 4, kardemir 4, alarko 3, ...). Over 30 days `alias:turkcell` gives FNCLL 75 rows against TCELL 117. Attachments of an auto row through a shared alias total 1,319 rows: 263 where a manual sibling exists, 461 to untraded affiliates and 595 all-auto traded siblings. The Jev relevance gate is fail-open and passed TSGYO at 0.21; the tape's "N haber" counts and the per-ticker news lists are inflated the same way. This is not h57-ekonomi-1 (the volume rounding).

**What 171 does** (one function replaced, `SECURITY INVOKER` as in 085, `search_path = ''`, the revoke and grant re-issued to `service_role` only (a no-op: `create or replace` keeps the ACL), one transaction with `lock_timeout = '5s'`, safe to re-apply): `public.resolve_article_tickers_for(uuid[])` is 085's body (production's, md5 pinned below) verbatim, except that 085's `alias_hits` is split in two CTEs: `alias_matches as materialized` (085's join conditions, unchanged: every enabled `bist_aliases` row found in the folded text, an auto row also needing finance context) and `alias_hits`, which applies two predicates to the rows that already matched the text, in alias_hits' WHERE. Both read the alias row only and both start with `origin = 'auto'`, so a manual row is never dropped. Rule A, the manual sibling wins: an auto row does not attach when another enabled manual row of the same alias names another ticker. Rule B, an untraded affiliate never attaches through a shared alias next to a manual or traded sibling: an auto row does not attach when no traded company (`bist_companies.shares_traded`) holds its ticker and another enabled row of the same alias names another ticker and that row is manual or its ticker is traded. Rule B narrows the spec's text, whose sibling test was any other enabled row of the alias: a deliberate deviation. 23 shared aliases have only untraded auto rows (denizbank, alternatifbank, anadolubank, fibabanka, burgan, alnus, trive, ...; the other 16 are allbatross, aytemiz, bankpozitif, camsan, freedom, invest, kapital, marbas, meksa, midas, misyon, odea, pasha, phillipcapital, raks and tacirler). Under the spec's B every row of such an alias drops, so the brand attaches nothing; they carry 231 rows on 114 articles in 30 days, and 74 of those articles have no other ticker. Untraded tickers have live pages (`/ekonomi/[ticker]` says "işlem görmüyor"), so their news lists would stop updating. With no manual or traded sibling there is no parent to defer to, so such an alias keeps 085's behaviour. An alias with a single enabled row is untouched, and a disabled row neither wins nor shares. `recent`, `ctx`, `code_hits` and the insert are 085's, so a headline that writes a sibling's own code (TSGYO) still matches it by code. No table, column, index, trigger, cron job or data change, no update or delete, and the rows already in `article_tickers` stay. Expected effect on the current alias rows (unchanged by the narrowing: each has a manual traded parent): turkcell gives TCELL only, tskb TSKB only, alarko ALARK only, migros MGROS only, enerjisa ENJSA only and kardemir KRDMD only (KRDMA, KRDMB and KARCL drop; this is expected). The test `tests/migrations/171-ticker-alias-siblings.test.ts` pins "substituting 085's alias_hits for the alias_matches + alias_hits pair gives 085's body".

| | md5(prosrc) | length |
|---|---|---|
| before 171 = the body of 085 (production, 2026-11-07) | `2667cc7fad0d66879f77ec6ad31e52ab` | 1760 |
| after 171 | `999a286fb58e46bf1958b78dfedcad98` | 3401 |

**Dry run** (read-only on production, 2026-11-07 ~15:45Z; the local PG15 script `tests/migrations/sql/171-ticker-alias-siblings-dryrun.sql` runs the shipped function): the last 24 hours of articles (7,978 non-sports rows) through 085's `recent`, `ctx` and `alias_hits` join as a plain SELECT, once without and once with the final text of rules A and B (`ctx` and `alias_matches` written `MATERIALIZED`: with `ctx` left inlined the planner repeats `fold_tr` for every alias pair and the statement hits the read-only path's roughly 8 s statement timeout). 227 alias hits without, 206 with: 21 dropped, 0 added; articles with an alias hit 163 before and 163 after. The 21 are 7 (alias, ticker) pairs: turkcell FNCLL 7, vestel VESBE 5, tskb TSGYO 3 and TSKYO 3, alarko ALCAR 1 and ALGYO 1, akfen AKFEN 1. Zero drops outside shared aliases: all 7 pairs belong to an alias with two or more enabled rows. No article loses every attachment: each article with a dropped hit keeps a manual or traded alias hit (TCELL, TSKB, ALARK, VESTL, AKFGY/AKFIS/AKFYE), and the three tskb stories also keep TSKB by code. The spec's B as first written gave 186 hits, 41 dropped on the same window: the 21 plus trive TRMEN 9, trive TVM 9, meksa MEKMD 1 and meksa MSA 1, whose siblings are all untraded; those 20 are kept now, and two Trive Yatırım stories and one meksa story would have lost every attachment under it. Over 30 days none of the 17 ALCAR rows, 17 ALGYO rows and 18 MIGRS rows is the article's only ticker (each also carries ALARK or MGROS). Measured side effect: ALCAR's only alias is `alarko` (auto), so a story about Alarko Carrier now attaches ALARK only; 7 of those 17 headlines name Carrier, GYO or Gayrimenkul ("Alarko Carrier Gebze fabrikasını kapatıyor" is one). A manual alias such as `alarko carrier` for ALCAR restores it (rule A keeps a manual row): an owner decision, follow-up (b).

**Cost** (EXPLAIN ANALYZE, TIMING OFF, read-only, 3 runs each, the alias join as a plain SELECT count): one article, the shape of the 058 AFTER INSERT per-row trigger's call, is about 1 ms again: 085 0.89 ms, the earlier draft of this migration (both predicates inside the join) 62 ms, this migration 0.92 ms. On a TSKB story the final text, rule B narrowed, ran 0.721 to 0.726 ms against 0.58 to 1.45 ms for 085 and 61.8 to 63.0 ms for the draft. The draft was slow because A and B read the alias row only, so the planner ran them as filters on the scan of `bist_aliases` for every enabled auto alias row on every call, whatever the text says (SubPlan loops=567; rule B's `NOT EXISTS` scans `bist_companies`, 1,047 rows, loops=556). A `@>` rewrite of B alone measured 9.2 and 6.2 ms, still 7 to 10 times 085. A MATERIALIZED `alias_matches` (`alias_matches as materialized`) runs the predicates only on the rows that matched the text; without the keyword PG inlines the CTE and pushes them back into the scan. The 24-hour batch is dominated by the text match (about 2.4 s for 7,978 articles) and is the same in every shape. Why it matters: the 058 per-row trigger runs inside the ingest PostgREST upsert (`UPSERT_BATCH` = 500 rows per statement) under authenticator's 8 s statement_timeout (`service_role` has no setting of its own), and a cancel by that timeout (57014) is not catchable by 058's `when others`, so the whole chunk is cancelled and bisected and the 50 s cycle deadline can delay or skip articles. Production single-statement bursts over 7 days: 234 rows (223 non-spor rows) at 2026-11-06 13:03:10Z, 207 (187), 168 (144), 152 (145) and 123 (114). 223 x 62 ms is about 13.8 s, over the limit; 223 x 0.9 ms is 0.2 s. The dry-run script holds a time budget: one non-matching article against 2,000 shared untraded auto aliases and 2,000 companies must take under 50 ms (the draft took 212 ms there, this migration 0.5 ms).

**Order:** APPLY `171_ticker_alias_siblings.sql` any time (`supabase db push` or post the SQL). No Next.js change and no Edge Function deploy: the 058 trigger calls the resolver by name, so the next article insert runs the new body. The ACL does not change.

**Verify** (read-only): `md5(prosrc), length(prosrc)` of `'public.resolve_article_tickers_for(uuid[])'::regprocedure` is `999a286fb58e46bf1958b78dfedcad98`, 3401 (was `2667cc7fad0d66879f77ec6ad31e52ab`, 1760); `has_function_privilege('anon', …, 'execute')` and `('authenticated', …)` false, `('service_role', …)` true; `select version, name from supabase_migrations.schema_migrations where version = '171'` returns one row. After the deploy, `select matched_on, ticker, count(*) from public.article_tickers where created_at > '<deploy ts>' and matched_on in ('alias:turkcell', 'alias:tskb', 'alias:alarko', 'alias:migros', 'alias:enerjisa', 'alias:kardemir') group by 1, 2` shows no FNCLL, TSGYO, TSKYO, ALCAR, ALGYO, MIGRS, EEDAS, KRDMA, KRDMB or KARCL row. One GET of `/ekonomi` after the next TSKB or Turkcell item shows TSKB and TCELL without the siblings (page cache: allow the ISR window).

**FOUNDER-ONLY follow-ups** (not part of this migration; neither is done by it): (a) optional cleanup of the existing 30-day rows in buckets A and B (724 rows) is a data rewrite of `article_tickers`; 171 only stops new rows. The 231 rows on the 23 all-untraded aliases sit in bucket B and are not stopped by the narrowed rule B, so a cleanup leaves them. (b) The 595 all-auto traded siblings (oyak OYAKC/OYAYO, akfen, ihlas, lydia, ...) need an owner pick of a manual parent alias; rule A then resolves them. The same pick fixes the Alarko Carrier case above.

**Rollback:** re-run only the `create or replace function public.resolve_article_tickers_for(p_ids uuid[])` statement of `085_ticker_code_gate.sql` (restores md5 `2667cc7fad0d66879f77ec6ad31e52ab`, length 1760; the grants do not change in either direction), then `delete from supabase_migrations.schema_migrations where version = '171';`. Rows written while 171 was applied are the narrower set and stay.

## 172 — archive search lists the real rows of a name-shaped word first (`search_cluster_ids` exempt-word tier): APPLY 172 only, no deploy-order constraint

**Why:** h58-postship-1 (hunt 58, follow-up to 166). 166 does not guard a word whose 3-4 letter Turkish stem is its own root plus a case or plural suffix (`irakta` = irak + ta, `zamlar` = zam + lar), because guarding such a word emptied the archive. The same shape fits names: `miller` = mil + ler, `bartin` = bart + in, `saniye` = sani + ye. Their guard set is empty, so every row with any word of that stem is a candidate, and 129's literal tier only looks at the headline and only re-orders. Read-only replay on 2026-11-07 with the arguments `search-query.ts` builds: `miller` returns 18 rows, 15 of them Milli Enerji / "70 mil teklifi" / Mili Eğitim; the three rows that hold "Miller" (`fb8e464a`, `767ba64a`, `ed35845e`) sit at ranks 1, 16 and 18. `bartın` (`['bartın','bartin']`, `'bartin'`): the archive has 18 Bartın stories, the top 24 shows 16 of them (ranks 27 and 32 are cut) and 8 stem collisions (Belgian De Wever stories, Ronen Bar, others); the variants arm stems `bartın` to `bar` and is never guarded, because the guard reads only `p_folded`. `saniye`: 9 of the 24 rows are Al Sani. A tier simulation on the RPC output showed that ordering alone fixes all three. Rejected: a row-dropping rule (a row must show the exempt word's own prefix). It would regress the inflected roots 166 documents: natonun 24 -> 1, atesi 24 -> 6, faize 24 -> 14, ilaci 24 -> 19, zamlar 24 -> 19. Also rejected: the hamidi sub-claim (its stem is not over-cut, 166's known limit 3, and its rows hold "Hamid'i") and the şeniz sub-claim (raising the 4-letter prefix floor would cut inflected short-stem queries).

**What 172 does** (function-only, `SECURITY DEFINER`, `search_path = ''`, grants re-issued to `service_role` only, one transaction with `lock_timeout = '5s'`, safe to re-apply, no table, index or data change, no app change): `public.search_cluster_ids(text[], text, integer)` is 166's body (production's, md5 pinned below) plus one ranking tier. `ge` is the set of folded words that 166's `g` step exempts, read from a new CTE `gx` that evaluates the exemption once (`g` reads its rows with `ex` false, exactly as before; `ge` reads the rows with `ex` true); both are empty under the same two switches, an `or` token and a negated phrase. In `hits`, `lit_ok` is true when every `ge` word starts a word of the title, neutral title or summary (apostrophes U+0027 and U+2019 deleted, folded; `strpos` only, no user text reaches a regex) and true when `ge` is empty. The title and neutral title are folded once (`ftitle`, shared with the score) and the summary only for a hit whose title does not already hold every exempt word. `ORDER BY` starts with `(case when lit_ok then 0 else 1 end)`; 166's score expression, `article_count`, `updated_at` and `id` follow byte for byte. Rows are only re-ordered, never dropped: recall is unchanged, the 1000-row cap is 166's, and a query without an exempt word is in one tier and returns 166's list. The tier also applies to 166's inflected roots (for `irakta` the rows with a word starting with irakta come first, Irak'tan included: the test is a word-start prefix). Known limit: stem-collision rows still fill the tail when fewer real rows exist (`miller keeps 15 after its 3`).

| | md5(prosrc) | length |
|---|---|---|
| before 172 = the body of 166 (production, 2026-11-07) | `d7f4b4223730e06db8479f42776d8040` | 9680 |
| after 172 | `192218b7b6a56b3c8fcc48d5e0610a2c` | 12913 |

**Replay** (production, read-only, 166's body and 172's body inline in one statement, `p_limit` 50, the RPC's cap; the app sends 24 (`SEARCH_LIMIT`)): `miller` 18 -> 18 rows, the three literal rows from ranks 1, 16, 18 to 1, 2, 3; `bartın` the 18 Bartın stories all in the top 24 (166: 16), De Wever and Ronen Bar out; `bartin` (ASCII) 18 real rows first of 23; `saniye` 24 of 24 hold the word (166: 15). For `zamlar`, `irakta`, `natonun`, `faize`, `karsta`, `ilaci`, `atesi` and `saniye`, 172's list with the cap lifted equals 166's list stably partitioned by the tier (same ids); `kirada` and `okulda` keep the identical top 24. Identical top 24 (and the identical 50-row list): burdur, ersan, ilhan, tarla, ığdır, iğdır, igdir, iran, seçim, şişli, sancaktepe, putin, akp, "ak parti", chp, meclis, enflasyon, istanbul, ankara, imamoğlu, erdoğan.

**Cost** (EXPLAIN (ANALYZE, BUFFERS) on production, inline bodies, alternated in one session, warm, medians of 5 runs): `iran` 169.6 -> 152.3 ms (0.90x), `seçim` 167.8 -> 152.1 ms (0.91x), `burdur` 35.1 -> 31.3, `erdoğan` 150.4 -> 131.4, `şişli` 5.93 -> 5.75 (all within the 1.3x gate; no exempt word means the tier costs nothing). The exempt queries: `miller` 4.49 -> 5.41 ms (1.20x), `bartin` 5.93 -> 6.92 (1.17x), `saniye` 12.99 -> 14.58 (1.12x), `zamlar` 17.87 -> 21.07 (1.18x), `irakta` 29.86 -> 33.34 (1.12x). A first draft that folded title, neutral title and summary of every hit measured 1.67x on `miller` and 1.75x on `zamlar`; folding the title once and the summary only for hits whose title lacks the word fixed it (`translate()` is the cost: about 28 ms for 1000 average summaries). Worst case: 1000 hits and few real rows add about 30 ms.

**Order:** APPLY `172_search_exempt_word_tier.sql` any time (`supabase db push` or post the SQL). No app change and no deploy: the app calls the same three-argument function and keeps its PGRST202 fallback to 083's two-argument one.

**Verify** (read-only): `md5(prosrc), length(prosrc)` of `'public.search_cluster_ids(text[], text, integer)'::regprocedure` is `192218b7b6a56b3c8fcc48d5e0610a2c`, 12913 (was `d7f4b4223730e06db8479f42776d8040`, 9680); `has_function_privilege('anon', …, 'execute')` false and `('service_role', …)` true; `select version, name from supabase_migrations.schema_migrations where version = '172'` returns one row. Then `search_cluster_ids(array['miller'], 'miller', 24)` lists the three Miller rows first, `array['bartın','bartin']` with `'bartin'` puts the 18 Bartın stories in the first 18 and no De Wever row among them, `array['saniye']` returns 24 rows that all hold saniye, and `GET /?q=miller`, `/?q=bartın` show it; `/?q=iran`, `/?q=seçim` and `/?q=şişli` are unchanged.

**Rollback:** re-run the function statement and the `comment on function` statement of `166_search_overstem_guard.sql` (restores md5 `d7f4b4223730e06db8479f42776d8040`, length 9680; `create or replace` keeps 172's comment otherwise), then `delete from supabase_migrations.schema_migrations where version = '172'; notify pgrst, 'reload schema';`. 083's two-argument function is not involved.

## 174 — `/ekonomi` relative volume is hidden when its 20-session window is not in one unit or not real volumes (`bist_quote_stats` unit guard): APPLY 174 only, no deploy-order constraint

**Why:** h67-edgefns-1 (hunt 67). 051's `bist_quote_stats` is the last session's volume over `avg(volume)` of the 20 rows before it, with no unit or zero handling. `quotes-ingest` daily mode keeps only the rows with `day >= last_day`, so a row Yahoo has since split-adjusted stays frozen in the old unit, and a halt placeholder (a flat bar with volume 0) is stored as a real row. Re-verified 2026-11-08 (one GET each at 08:21-08:26Z plus read-only SQL): `/ekonomi/MERCN` said "hacim 20 günlük ortalamanın 1,7 katı" (stored `avg_volume_20` 5,117,508.75, `rvol` 1.73) across its 3.00004-for-1 split of 2026-10-30; with the 15 pre-split volumes multiplied by 3.00004 the average is 10,815,320 and the ratio 0.82. `/ekonomi/DUNYH` said 7,5 in amber: 19 of its 20 prior rows are flat at 109.10 with volume 0, the only real prior print is 2026-10-12 (17,013,257), so the average is 850,662.85 and `rvol` 7.51. SKBNK has a 4.48 to 3.21 step on 10-22 in its window until about 11-20; SASA has 4 zero-volume rows (real bars) among its 20 and reads 3.44 where the real-volume average gives 2.75. Over the 626 tickers with a 2026-11-06 bar: 3 windows with a close step outside 0.75 to 1.35 and 5 with zero-volume prior rows. This is not h36-data-1, h48-ekonomi-1, h51-morphology-2 or h57-ekonomi-1.

**What 174 does** (`create or replace view` only, `security_invoker = on` in the WITH list and again with `alter view`, one transaction with `lock_timeout = '5s'`, safe to re-apply, no table, data, Edge Function or UI copy change): the same seven columns in the same order with the same types. Per ticker in day order, `unit_break` is a close outside 0.75 to 1.35 of the previous close (BIST's daily band is +-10 percent, so such a step is a unit change or a placeholder; the division sits in a CASE branch that tests the divisor first). `break_in_window` is `bool_or(unit_break)` over the 19 preceding rows and the current one, `avg_nz` and `n_nz` are the average and count of `volume > 0` over the 20 rows before the current one. For the `rn = 1` row `prev_close` is unchanged (`rebaseQuoteOnStat` reads it), `avg_volume_20` is null when `break_in_window`, or `n_nz < 10`, or the last volume is null or not above 0, else `avg_nz`, and `rvol` is `round(last_volume / avg_volume_20, 2)` when that average is above 0. `avg_volume_20` is nulled as well as `rvol` because `relativeVolume()` in `queries.ts` divides `last_volume` by `avg_volume_20` first and uses the stored `rvol` only as a fallback. `rvolLabel()` returns null for a null `rvol`, so the `/ekonomi/<ticker>` header drops the volume line, and `ticker-chip.tsx` renders its "hacim" span only when `rvol` is not null. Every window partitions by ticker, so `.in('ticker', ...)` still reaches `bist_bars_daily_pkey`. The ACL is production's (postgres and `service_role` only; `create or replace` keeps it and the migration re-issues the `service_role` grant, a no-op).

| | `md5(pg_get_viewdef(...))` | length |
|---|---|---|
| before 174 = 051's view (production, 2026-11-08, PostgreSQL 17.6) | `8f5ecc5369051b3b9405e23a6376c68c` | 880 |

**Replay** (read-only on production, 2026-11-08, the new body as a plain SELECT against 051's): MERCN 1.73 to null, DUNYH 7.51 to null, SKBNK 1.72 to null (until the 10-22 step leaves the window), SASA 3.44 to 2.75, GARAN 1.85 unchanged. Over all 630 tickers 8 `rvol` values change: DUNYH, MERCN, SKBNK and TERA (last volume 0 on 11-05, was 0.00) go to null; SASA 3.44 to 2.75, TRHOL 4.14 to 3.72, RALYH 2.33 to 2.21, ISBTR 2.75 to 2.61. `avg_volume_20` changes for 10 (those 8 plus ISATR and UMPAS, last volume 0, average 0 before and `rvol` null before and after); `last_day`, `last_close`, `prev_close` and `last_volume` are identical for all 630. **Cost** (EXPLAIN ANALYZE, read-only): 5 tickers 8.5 ms against 6.2 ms for 051's body, plan Index Scan using `bist_bars_daily_pkey` with `Index Cond: (ticker = ANY (...))`; 40 tickers 59 to 63 ms against 39 ms.

**Order:** APPLY `174_bist_quote_stats_unit_guard.sql` any time (`supabase db push` or post the SQL). No Vercel deploy, no Edge Function deploy, no cron change: the pages read the view by name and show the new values once the feed cache window has passed. The local dry run is `tests/migrations/sql/174-bist-quote-stats-unit-guard-dryrun.sql` (ends with `DRYRUN 174 OK`); `tests/migrations/174-bist-quote-stats-unit-guard.test.ts` pins the statements, thresholds and frames and runs the fixtures live in the harness.

**Verify** (read-only): `reloptions` of `public.bist_quote_stats` is `{security_invoker=on}`; `md5(pg_get_viewdef('public.bist_quote_stats'::regclass, true))` is no longer `8f5ecc53...`; `select ticker, avg_volume_20, rvol from public.bist_quote_stats where ticker in ('MERCN', 'DUNYH', 'GARAN')` gives null / null for MERCN and DUNYH and 23743772.6 / 1.85 for GARAN (as of the 2026-11-06 bar); `select version, name from supabase_migrations.schema_migrations where version = '174'` returns one row. After the cache window, `GET /ekonomi/MERCN` and `/ekonomi/DUNYH` carry no "hacim ... katı" line, `/ekonomi/GARAN` still reads 1,8, and the `/ekonomi` tape chip of a nulled ticker has no "hacim" span.

**FOUNDER-ONLY follow-up** (not part of this migration; it is not done by it): the stored history is not repaired. A re-fetch of the old rows (`quotes-ingest` daily mode with the `full` flag, dropping the flat zero-volume bars in `supabase/functions/quotes-ingest/bars.ts`) rewrites `bist_bars_daily` rows, so it waits for an OK. 174 only stops the page from computing a ratio over a window it cannot trust; on a clean window the view is unchanged.

**Rollback:** re-run only the `create or replace view public.bist_quote_stats` statement of `051_finance_bars_and_speed.sql`, then `alter view public.bist_quote_stats set (security_invoker = on);` (a bare replace clears the option), then `delete from supabase_migrations.schema_migrations where version = '174';`. The ACL does not change in either direction.

## 175 — `/sources` Dataset `dateModified` follows the registry (`sources.registry_changed_at`, trigger `sources_registry_changed_at_trg`): APPLY 175 FIRST, THEN DEPLOY the app

**Why:** h69-jsonld-1 (hunt 69). The `/sources` JSON-LD Dataset promises "yanlılık kategorisi, tür (outlet/aggregator/wire/niche), hak bayrakları ve kayyum durumu", and its `dateModified` was the latest of every active source's `created_at` and `zone_rationale_at` and the newest `source_zone_history` row. Re-verified 2026-11-08 (~10:25Z, one GET plus read-only SQL): the page says `"dateModified":"2026-04-06T14:20:11.360Z"`; `max(sources.created_at)` is `2026-04-06 14:20:11.360187+00` over 144 rows, `zone_rationale_at` is null on all 144 and `source_zone_history` is empty (its insert trigger was created after the 144 rows existed, so no origin row was ever written, and no bias UPDATE has happened since). The registry changed after that: 034 (kind, ledger version `20260906221636`, 2026-09-06) set `kind` on 38 rows and 055 section 5 (trustee dates "verified 2026-09-18") set `trustee_since` on 3 rows. None of `created_at`, `zone_rationale_at` or the history moves for kind, kayyum status, rights flags, name, URL or `active`, and `sources` has no `updated_at`, so the stated date was about five months early (the page's own comment calls a too-early date worse than none).

**What 175 does** (additive, one transaction with `lock_timeout = '5s'`, safe to re-apply, no existing row is updated, no `source_zone_history` backfill, no UI copy change): `alter table public.sources add column if not exists registry_changed_at timestamptz not null default now()`. `now()` is STABLE, so Postgres stores the default as a fast default with no table rewrite: every row that exists at apply time reads the migration's transaction time until its first registry edit, and a later insert gets its own insert time (a re-apply does not move a stamp, `if not exists`). A trigger function `public.sources_touch_registry_changed_at()` (plpgsql, `set search_path = ''`, not SECURITY DEFINER, revoked from public, anon and authenticated) sets `new.registry_changed_at := pg_catalog.now()`. The trigger `sources_registry_changed_at_trg` is BEFORE UPDATE FOR EACH ROW with a WHEN clause of `old.c is distinct from new.c`, OR-ed, for exactly 15 columns: `name, slug, url, rss_url, bias, kind, active, logo_url, tradition, source_type, image_allowed, excerpt_allowed, zone_rationale, trustee_since, trustee_note`. `is distinct from` is null-safe (null to a value and a value to null count) and writing a column its own value does not. The clause names no `fetch_*` column and not `registry_changed_at` itself (a write of the stamp alone is kept). `notify pgrst, 'reload schema'` is sent because the app reads the new column through PostgREST.

**Why no `fetch_*` column (read-only, production, 2026-11-08):** `ingest_set_source_fetch_state(jsonb)` (041, 074, 119) is the only automated writer of `sources`. The ingest Edge Function calls it every few minutes with one UPDATE over every active feed, writing `fetch_etag, fetch_last_modified, fetch_body_hash, fetch_last_status, fetch_last_at, fetch_fail_streak, fetch_quarantined_until, fetch_newest_item_at, fetch_items_count`: all nine are out of the WHEN clause, and counting any of them would make `dateModified` track ingest instead of the registry. The other writers are human or deliberate: `set_source_bias` (055) writes `bias` only, so `bias` is in the clause; `delete_source` (128) deletes a row, which fires no UPDATE trigger; no `cron.job` command mentions `sources`; the admin route writes name, slug, url, rss_url, kind, active, the two rights flags, `zone_rationale` (with `zone_rationale_at`, which the page still reads as an input), `trustee_since` and `trustee_note`. Also left out: `id`, `created_at`, `zone_rationale_at`.

| `public.sources` (production, 2026-11-08, PostgreSQL 17.6) | before 175 | after 175 |
|---|---|---|
| columns | 27 | 28 (`registry_changed_at`) |
| user triggers | `sources_zone_history_insert_trg`, `sources_zone_history_trg` | those two plus `sources_registry_changed_at_trg` |
| `max(created_at)`, `count(*) filter (where kind <> 'outlet')`, `count(*) filter (where trustee_since is not null)` | `2026-04-06 14:20:11.360187+00`, 38, 3 | unchanged |

**The page** (`src/app/sources/page.tsx`): the directory read's `Promise.all` gains a third one-row read, `sources.select('registry_changed_at').order('registry_changed_at', { ascending: false }).limit(1)`, deliberately not filtered by `active` (deactivating a source is a registry change; the directory read lists active sources only). Its value joins `registryModifiedAt`'s inputs next to `created_at`, `zone_rationale_at` and the newest zone-history row, and an unreadable stamp voids `dateModified` the way an unreadable history does (a warn, the key left out of the JSON-LD, the directory still renders).

**Order:** APPLY `175_sources_registry_changed_at.sql` FIRST (`supabase db push` or post the SQL), THEN DEPLOY the app on Vercel. Nothing in the old app reads the column, so the apply is safe on its own. The reverse order is safe but leaves `dateModified` out of the JSON-LD until the apply: the new read errors, the page never falls back to the old value, and the directory read is cached for `source-directory` (1 h). No Edge Function deploy, no cron change. The local dry run is `tests/migrations/sql/175-sources-registry-changed-at-dryrun.sql` (ends with `DRYRUN 175 OK`); `tests/migrations/175-sources-registry-changed-at.test.ts` pins the statements, the exact WHEN clause and the header, and runs one UPDATE per column live in the harness.

**Verify** (read-only): `select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name = 'registry_changed_at'` gives `timestamp with time zone`, `NO`, `now()`; `select min(registry_changed_at), max(registry_changed_at), count(*) from public.sources` gives one value (the apply time) over 144 rows; `select tgenabled, tgtype from pg_trigger where tgrelid = 'public.sources'::regclass and tgname = 'sources_registry_changed_at_trg'` gives `O`, 19 and `pg_get_triggerdef` shows 15 `IS DISTINCT FROM` terms and no `fetch_`; `has_function_privilege('anon', 'public.sources_touch_registry_changed_at()', 'execute')` and the same for `authenticated` are false; `select version, name from supabase_migrations.schema_migrations where version = '175'` returns one row. After one ingest cycle `max(registry_changed_at)` is unchanged. After the deploy and the cache window, `curl -s https://www.tayfhaber.com/sources | grep -o '"dateModified":"[^"]*"'` prints that max instead of `2026-04-06T14:20:11.360Z`, and it moves at the next kind, rights, trustee, name, URL or active edit.

**Known limits:** `dateModified` starts at the apply time, not at the real last edit (2026-09-18): every old row reads the migration's transaction time, so the value is an upper bound that is never too early. `delete_source` stamps nothing; if the deleted row held the newest stamp the page steps back to the next newest one, which is not older than the apply time while one pre-175 row remains. `TRUNCATE` and a bulk load that bypasses UPDATE are not stamped.

**FOUNDER-ONLY follow-up** (not part of this migration): inserting origin rows into the append-only `source_zone_history` for the 144 sources, so "when was this label first set" is answerable, is a separate decision. 175 does not need them.

**Rollback:** the old app does not read the column and the new page voids `dateModified` when the read fails, so roll the app back first or accept a missing date. Then in one transaction: `drop trigger if exists sources_registry_changed_at_trg on public.sources;`, `drop function if exists public.sources_touch_registry_changed_at();`, `alter table public.sources drop column if exists registry_changed_at;`, `notify pgrst, 'reload schema';`, `delete from supabase_migrations.schema_migrations where version = '175';`. The `sources_zone_history_*` triggers, the data and the ACL are untouched in either direction.
