# Topic7 v2 (data-7, revised): groundwork, gate, and T7b

This is the operator runbook for the topic7 v2 project. **T7a (this
migration, 090) makes no question-text change and runs no gate.** T7b (the
question text plus /konu copy) does not start until the held-out gate below
passes. See `jev-specs.md` §5 for the full design rationale; this file is
the step-by-step procedure.

Not linked from `docs/migration-guide.md` on purpose — that file is owned
by another concurrent item (JEV-A) for this delivery round; JEV-A links
this doc from there.

## 1. 090 apply, deploy and backfill

1. Apply `supabase/migrations/090_topic7_v2_groundwork.sql` (idempotent —
   safe to re-run; verified locally applied twice on Postgres 15).
2. Deploy: no Edge Function changes in T7a, so no `supabase functions deploy`
   step is required for this migration.
3. Backfill: `jev_topic7_yardstick_daily` fills in from the next nightly
   cron tick (`jev-topic7-yardsticks`, `25 0 * * *` UTC). To backfill
   immediately after deploy, run once by hand:
   ```sql
   select public.jev_topic7_yardstick_refresh(7);
   ```
   (service_role only; run via the Supabase SQL editor or a service-role
   client, never via anon/authenticated.)

## 2. The held-out SELECT

The gate's held-out set is the 300 original gold articles that never
received an Opus label (the 356 `opus_seed` rows are the **dev** set,
in-sample, reported separately):

```sql
select g.article_id, a.title, a.description
  from jev_gold_set g
  join articles a on a.id = g.article_id
 where g.stratum <> 'opus_seed'
   and not exists (
     select 1 from jev_gold_provisional_labels pl where pl.article_id = g.article_id
   )
 order by g.position;
-- expect 300 rows
```

Run this read-only (e.g. via `sbq.py` against a read replica, or the
Supabase SQL editor with a read-only role) and save the result as
`heldout.json` (an array of `{ article_id, title, description }`).

## 3. The gate procedure

1. **Blind labels.** `node scripts/topic7-blind-label.mjs prepare --heldout heldout.json --out prompts.jsonl`
   renders one blind prompt per held-out article (the `JEV_TOPIC7_GUIDE_TR`
   rules, title and description only — never source, category, URL or any
   Jev field). A human labeller (or a separately-run, founder-approved
   model pass) answers each prompt with `{"is_politics": bool, "topic": "..."}`,
   one JSON object per line, in the SAME order as `heldout.json`, saved as
   `answers.jsonl`.
2. **Import.** `node scripts/topic7-blind-label.mjs ingest --heldout heldout.json --answers answers.jsonl --label-source blind-v2guide-A-YYYY-MM-DD --out /path/outside/the/repo/import.sql`
   renders the `jev_gold_import_provisional(...)` SQL. `labelSource` must
   match `blind-v2guide-A-YYYY-MM-DD`. Apply the SQL file with a
   service-role connection.
3. **Human adjudication.** With the blind labels imported as `stratum =
   'heldout'` provisional rows, work the `/admin/jev-altin` queue (source
   and feed category hidden pre-label, per 090's labelling fix) until the
   held-out set has a human-agreed or human-single final label for every
   row. `jev_gold_next_prioritized` already ranks a topic7 disagreement
   (blind label vs. any stored Jev topic7 answer) first.
4. **Freeze plus sha.** Once every held-out article has a final label,
   freeze the item set: `node scripts/topic7-v2-gate.mjs prepare --items items.json --v2-question v2.json`
   is a dry run (no network) that prints the call count (`2 * items`), the
   estimated input tokens (`chars * 0.389`), and `sha256(items.json)`. That
   hash is the frozen reference for the paired run below — if it ever
   changes, the gate must be re-run from a fresh freeze, never patched.
5. **Paired run.** `node scripts/topic7-v2-gate.mjs run --items items.json --v2-question v2.json --execute`
   is the one live Jev call. It refuses unless **all three** of `--execute`,
   `JEV_GATE_APPROVED` (founder approval) and `AI_GATEWAY_API_KEY` are
   present, and refuses before any network call if any of the three is
   missing. Hard caps: 1,400 calls, 2,500,000 input tokens. Concurrency 8.
   Writes only answers and usage; logs only HTTP status codes, never a key
   or a response body.
6. **Score.** `node scripts/topic7-v2-gate.mjs score --items items.json --results results.json --mix mix.json`
   runs `evaluateGate()` (`scripts/lib/topic7-gate.mjs`) and prints the
   report JSON, exiting non-zero on any failed check.

## 4. Pass bars (the lead's 7 conditions)

1. Held-out v2 − v1 ≥ **+3.0 pt** after the category-mix reweight, **and**
   McNemar exact p < 0.05.
2. Dev (Opus-labelled) v2 ≥ v1.
3. Held-out politika: `|share(v2) − gold| ≤ 5 pt` **and**
   `precision(v2) ≥ precision(v1) − 3 pt`.
4. Held-out dünya: `recall(v2) ≥ recall(v1) − 5 pt` **and**
   `|genel share(v2) − gold| ≤ 5 pt`.
5. Held-out p ≥ 0.8 slice: accuracy ≥ 90% with coverage ≥ 65%.
6. Pack stability: politics@0.5, topic, clickbait and framing each flip
   ≤ 3% versus the current production pack.
7. Mean input tokens v2 − v1 ≤ **+700**.

All seven must pass (`evaluateGate().pass === true`) before T7b starts.

## 5. Founder decision #5

Approved cost envelope: **≈1.9M Jev tokens plus 300 blind labels** for one
paired v1/v2 held-out run. Re-running the gate (e.g. after a v2 wording
revision) is a new founder decision, not an automatic retry — the item set
is frozen by its sha256 precisely so a silent re-roll can't happen.

## 6. T7b is blocked

**T7b (the topic7 question-text change, `/konu` copy, and any
`JEV_QUESTION_REGISTRY.topic7` / `_shared/jev.ts` edit) does not start
until the gate above passes.** T7a introduces no question-text change and
runs no gate; it is groundwork only (the yardstick tables, the stratified
queue, the scorecard, and the held-out gate tooling itself).
