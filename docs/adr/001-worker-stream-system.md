# ADR 001 — Event-driven worker stream on Supabase

| Status   | Accepted                                          |
|----------|---------------------------------------------------|
| Date     | 2026-05-21                                        |
| Branch   | `refactor/worker-stream-system`                   |
| Replaces | Long-running tmux workers (`scripts/*-worker.mjs`)|

## 1. Context

The original ingestion / clustering / image-backfill pipeline ran as three long-running Node processes inside tmux sessions on a single VM:

- `scripts/rss-worker.mjs` — RSS poll loop across 144 sources
- `scripts/cluster-worker.mjs` — ensemble clustering pass over new articles
- `scripts/image-worker.mjs` — `og:image` backfill for politics articles missing imagery
- `scripts/headline-worker.mjs` — LLM-generated neutral cluster titles

This design produced two recurring incident patterns:

1. **Silent stalls.** When any one of the workers crashed or wedged on a slow outlet, the tmux pane stayed nominally "alive" but the pipeline stopped progressing. Detection latency averaged hours and peaked at 7 days during a `/api/cron/cluster` outage — surfaced only when the on-call dashboard's article-age tile crossed a threshold.
2. **No deployment / rollback story.** Patching a worker required SSHing into the VM, killing tmux panes by hand, pulling the branch, and restarting. There was no green/blue and no commit-to-prod link.

The audit performed prior to this work identified seven contributing findings (T1–T7), all addressed by this refactor.

## 2. Decision

Replace the tmux pattern with an **event-driven worker stream** colocated with the database:

- **Cadence is owned by `pg_cron`.** Three scheduled jobs (`ingest-drain`, `cluster-drain`, `image-drain`) call `net.http_post` against the Supabase Edge Function endpoints with a service-role bearer.
- **Work fans out via Postgres triggers + pgmq.** An `AFTER INSERT ON articles` trigger enqueues to two pgmq queues (`cluster_work`, `image_backfill`); the consumers drain them with visibility-timeout semantics and archive on success.
- **Workers are Supabase Edge Functions (Deno 2.x).** Three new functions: `ingest`, `cluster-consumer`, `image-consumer`. Co-located with the database for low-latency PostgREST round-trips and zero VM ops surface.
- **The only Vercel cron in the new pipeline is `/api/cron/headline`.** Headline rewriting is a low-frequency, LLM-bound batch task that benefits from the longer Vercel function ceiling and a clean serverless billing path.
- **Observability is built in.** A `@sentry/deno` wrapper covers every Edge Function (and the inner-catch blocks call `captureException` explicitly so a swallowed 500 never goes unpaged); a `worker_metrics` view aggregates queue depth; `/api/health` and `/api/metrics` expose those signals behind bearer-gated endpoints with anonymous rate limits, and `/api/metrics` also surfaces `clusters.neutralizedRatio` and `clusters.oldestPendingNeutralAgeSec` so headline-cron drift pages on age, not just ratio.

## 3. Alternatives considered

| Option | Outcome | Rationale |
|---|---|---|
| **Vercel Queues** (preview) | Rejected | Preview-tier; SLA insufficient for a 24/7 pipeline. No co-location with Postgres — every read/write is a round-trip across providers. |
| **Inngest** | Rejected | Strong DX, but introduces a third vendor and another billing surface for what is fundamentally Postgres-adjacent work. |
| **Cloudflare Queues + Workers** | Rejected | Excellent infrastructure but adds a fourth vendor and a fan-out across two clouds (Supabase + Cloudflare + Vercel + the LLM provider). |
| **Trigger.dev** | Rejected | Similar to Inngest. Vendor risk + duplicated retry semantics. |
| **Keep tmux, add supervisord** | Rejected | Treats symptoms (process death) without addressing the deployment story or the silent-stall pattern. |
| **pgmq + Edge Functions + pg_cron** | **Selected** | Single vendor (Supabase). Queue, scheduler, runtime, and database are co-located. pgmq provides at-least-once delivery with visibility timeouts. pg_cron makes cadence introspectable via the `cron.job` table. Edge Functions deploy through `supabase functions deploy` with full audit history. |

## 4. Audit findings addressed

| ID | Finding | Resolution |
|----|---------|------------|
| T1 | Worker stalls go undetected for days | pg_cron cadence + worker_metrics view + Sentry coverage on every function + `/api/health` reads worker_metrics. Detection latency now ≤ next cron tick (1–5 min). |
| T2 | No deploy/rollback story for workers | Workers are Edge Functions deployed via `supabase functions deploy <name>`. Rollback recipe: `git checkout <prior-sha> -- supabase/functions/<name>/ && supabase functions deploy <name> --project-ref $PROJECT_REF` (no first-class "redeploy previous bundle" CLI flag exists today; cross-referenced in [`../migration-guide.md`](../migration-guide.md) §Rollback step 2). Migration history captured in `supabase/migrations/`. |
| T4 | Image fetcher had no SSRF protection | New `supabase/functions/_shared/safe-fetch.ts` resolves the host via DNS and rejects RFC1918, loopback, link-local, ULA, CGNAT, benchmark, TEST-NETs, multicast, future-use, IPv6 documentation, IPv6 link-local, IPv6 multicast, IPv6 ULA, IPv4-mapped IPv6 forms, and the unspecified address before opening a socket. For plain HTTP the dial is also pinned to the validated literal IP (Host header preserved) to close the DNS-rebinding TOCTOU; HTTPS keeps the hostname so SNI/TLS handshakes still verify. |
| T3 | `/api/cron/headline` had no fail-closed behaviour when `CRON_SECRET` was unset | Bearer check is constant-time (`crypto.timingSafeEqual`) and **fail-closed** when the env var is missing or empty (returns 503, never 200). Mirror pattern in `/api/metrics`. |
| T5 | `err.message` leaks in 500 response bodies | All routes route through `withApiErrors`; 500 bodies are now a canonical envelope with a `request_id` and the raw error is sent to Sentry / Edge Function logs only. |
| T6 | No Sentry coverage on the Deno side (long-running worker errors were invisible) | New `supabase/functions/_shared/sentry.ts` wraps all three Edge Functions. Graceful no-op when `SENTRY_DSN` is unset. |
| T7 | Two parallel `content_hash` regimes (sha1-of-shingles in newer paths, raw-URL sha256 in older data) | Treated as a permanent, intentional dual regime: old rows keep their 64-hex sha256, new ingest writes 40-hex sha1, and the two coexist without conflict (`articles_source_content_hash_key` is UNIQUE on the raw bytes; the pipeline never compares across regimes). Migration `026_unify_content_hash_v2.sql` deletes nothing — it installs a permissive `CHECK (content_hash is null or content_hash ~ '^[0-9a-f]{40}$' or content_hash ~ '^[0-9a-f]{64}$')`, added `NOT VALID` so it takes no validate lock. That CHECK is the only enforcement. |

## 5. Migration plan

The branch is structured so that the cutover is fully reversible — no migration in the set destroys data.

1. **Pre-deploy (no production change)** — review the branch, run `tsc` + `vitest`, lint the migrations.
2. **Database** — apply `024_pgmq_setup.sql`, `025_worker_triggers.sql`, `026_unify_content_hash_v2.sql` in order. Migration 026 deletes nothing — it adds a permissive dual-regime `content_hash` CHECK (`NOT VALID`, no validate lock). Take a database snapshot first as routine hygiene.
3. **Edge Functions** — `supabase functions deploy ingest cluster-consumer image-consumer` with `SENTRY_DSN`, `SERVICE_ROLE_KEY`, and `app.service_role_key` GUC configured.
4. **pg_cron** — install three jobs (`ingest-drain`, `cluster-drain`, `image-drain`). The exact `cron.schedule(...)` statements are in `supabase/migrations/038_cron_schedules.sql`; see [`../migration-guide.md`](../migration-guide.md) step 3 for how to apply it.
5. **Vercel** — deploy the branch; `/api/cron/headline` is the only Vercel cron in the new pipeline.
6. **Decommission** — stop the tmux workers on the VM; the `scripts/*-worker.mjs` runners have already been deleted from the repo. The cluster reference libraries under `scripts/lib/cluster/*.mjs` are intentionally retained as the parity-test golden vector for `tests/functions/_shared/cluster.test.ts`.

Rollback up to step 3: revert the branch on Vercel and stop the new pg_cron jobs. The pgmq queues are append-only and idle when no consumer is draining them. Migration 026 needs no reverse: it deletes no rows and rewrites no hashes. The only artefact it adds is the permissive dual-regime CHECK, which accepts every existing row (sha256 and sha1 alike) and can be dropped manually if ever required (`alter table articles drop constraint articles_content_hash_length_chk`). There is no data loss to restore from a snapshot.

## 6. Consequences

**Operational.** The pipeline now has a single source of truth for cadence (`cron.job`), a single source of truth for queue state (`pgmq`), and a single source of truth for errors (Sentry, with a `tags:function:<name>` discriminator). There is no longer a "the workers" — there are individually deployable, observable functions.

**Security.** Service-role bearer is required on every Edge Function. The image fetcher is SSRF-gated by DNS resolution. The headline route is fail-closed on missing secrets. Every public API route either is bearer-gated or rate-limited (or both).

**Cost.** Edge Function invocations are cheap (~$2/month projected at current cadence). LLM cost for the headline route remains the dominant variable ($<1/month at the default batch size). The VM that ran tmux is decommissionable. Net cost is lower than the prior setup.

**Coupling.** This refactor doubles down on Supabase. If we ever need to leave Supabase, the pgmq layer is the part that does not portably exist on AWS / GCP; the rest is plain Postgres and plain Deno. We accept that risk because the operational wins are large and Supabase is currently a healthy vendor.
