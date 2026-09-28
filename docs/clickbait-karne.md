# Tık tuzağı karnesi (clickbait-karne)

Per-outlet "tık tuzağı" (clickbait) scorecard, reported in three equal
terciles (Düşük / Orta / Yüksek), surfaced on `/sources`, `/source/[slug]`
and the admin page `/admin/tik-tuzagi`. Migration `078_source_clickbait.sql`;
TypeScript in `src/lib/sources/clickbait.ts`; components in
`src/components/source/clickbait-karne.tsx`.

## Decisions

1. **Signal: Jev task `clickbait`, not `sensational`.** `sensational` is a
   0-3 wording-intensity score (`JEV_SCORE_TASKS`,
   `supabase/functions/_shared/jev.ts`) that the 2026-09-20 limits test
   rejected at ~20% precision, and the research report already dropped for
   the same reason. `clickbait` ("does this headline deliberately withhold
   the key fact to force a click?") scored Spearman 0.76 / 85% accuracy
   against Opus gold, but its ECE (0.12-0.15) means it is only usable as a
   RANKING (terciles) — never a headline count, a percentage, a per-headline
   label or an example headline.
2. **Flag threshold: `jev_prob >= 0.7`.** Pre-registered; drives both the
   per-outlet metric (share of flagged headlines, mean probability as the
   tie-break) and the Step-0 precision sample. Public output is the tercile
   only, plus `n` and the real covered window (`first_day`–`last_day`), never
   a raw percentage.
3. **One question-set version: `CLICKBAIT_QUESTION_SETS = ['2026-09-24.1']`**
   (the current `JEV_QUESTION_SET_VERSION`). A parity test
   (`tests/migrations/078-source-clickbait.test.ts`) pins
   `CLICKBAIT_QUESTION_EN` against `JEV_QUESTION_REGISTRY.clickbait.instructions`
   and `CLICKBAIT_ARTICLE_CALL_SHA` against a sha256 of
   `buildArticleCall(...).questions`, so a silent Jev wording bump can't
   silently widen "the same measurement".
4. **Eligibility.** Only active sources of the voting kinds (outlet, wire —
   `VOTING_SOURCE_KINDS`, `src/lib/bias/config.ts`) with `n >= 300` headlines
   in the 30-day window count. Terciles are only computed with `>= 9`
   qualifying outlets; below that, the section stays hidden.
5. **Rollup table, not query-time aggregation.** `jev_answer` is a wide
   jsonb with `question_set` inside it, so a 30-day aggregate needs a heap
   scan per matching row. Measured against production on 2026-09-28
   (read-only EXPLAIN, no writes): 15.1s cold, ~125k buffer blocks, for a
   window that at measurement time only covered ~4 days of the current
   question set — see the full EXPLAIN in `078_source_clickbait.sql`'s
   header. A cron-written `source_clickbait_daily` rollup, read by a plain
   indexed aggregate (`source_clickbait_30d`), replaces that scan.
6. **Public gate.** Nothing reaches `/sources` or `/source/[slug]` unless
   `CLICKBAIT_PRECISION_CHECK` (in `src/lib/sources/clickbait.ts`) is
   non-null and records precision `>= 0.80` on 200 labelled flags, at
   threshold 0.7, under the same question set. Default is `null`
   (admin-only). The same `ClickbaitKarneSection` component renders on
   `/admin/tik-tuzagi` in either state (with `showShares` for the admin
   view).

## Status: gate closed (pending Step-0 review)

`CLICKBAIT_PRECISION_CHECK = null` in this codebase today. Per the model-tier
rule for this implementation pass, the 200-row blind precision label sample
(Step 0d below) is judgement work delegated to a Fable/Opus-tier reviewer,
not performed by the Sonnet-tier engineering pass that built the migration,
TypeScript library, components and pages. `tests/fixtures/clickbait-precision.json`
currently holds a **synthetic placeholder** (its own `status` field says so)
used only to exercise the recomputation-from-fixture unit test contract —
it is NOT a real precision measurement and must not be treated as one.

**Outstanding runbook step:** a reviewer must run Step 0 below end-to-end
(the read-only SQL steps have already been run against production once, see
"Data gathered 2026-09-28" below), do the 200-row blind label pass, replace
`tests/fixtures/clickbait-precision.json` with the real reviewed sample, and
set `CLICKBAIT_PRECISION_CHECK` in `src/lib/sources/clickbait.ts` from the
result. Until then the gate stays closed by design and every public surface
renders unchanged.

## Step 0: precision check (runbook)

All SQL is read-only, via
`SBQ_TIMEOUT=60 python3 <path-to>/sbq.py -e '...'`.

a) **Version inventory** — which `question_set` values exist and how many
   rows each has:
   ```sql
   select jev_answer->>'question_set' qs, min(created_at), max(created_at), count(*)
   from public.jev_shadow_predictions
   where task = 'clickbait'
   group by 1 order by 2;
   ```

b) **Duplicate check** — the rollup assumes one row per article per version;
   expect 0:
   ```sql
   select count(*) - count(distinct (article_id, jev_answer->>'question_set'))
   from public.jev_shadow_predictions
   where task = 'clickbait' and created_at > now() - interval '30 days';
   ```

c) **Reproducible sample** — order by `md5` with a fixed salt, never
   `random()`:
   ```sql
   select p.article_id, s.slug, s.bias, p.jev_prob, a.title, a.description
   from public.jev_shadow_predictions p
   join public.articles a on a.id = p.article_id
   join public.sources s on s.id = a.source_id
   where p.task = 'clickbait'
     and p.created_at > now() - interval '30 days'
     and p.jev_prob >= 0.7
     and p.jev_answer->>'question_set' = '2026-09-24.1'
     and s.active
     and coalesce(s.kind, 'outlet') in ('outlet', 'wire')
   order by md5(p.article_id::text || 'tik-tuzagi-v1')
   limit 200;
   ```

d) **Label every row blind** to `jev_prob` and to the outlet: shuffle the
   rows, show only title + description, record a rule code per row.

   | Code | Verdict | Rule |
   |---|---|---|
   | Y1 | YES | Withheld payload / curiosity gap ("İşte o isim", "Bakın ne oldu", "herkes bunu konuşuyor"). |
   | Y2 | YES | The subject IS the news and is hidden ("Ünlü oyuncu…", "Eski bakan…"). |
   | Y3 | YES | Forward reference whose payload lives only in the article ("Bu yöntemle…", "Şu hatayı yapmayın", "İşte detaylar"). |
   | Y4 | YES | Teaser question the article answers but the headline withholds. |
   | Y5 | YES | List teaser where the list is the payload. |
   | Y6 | YES | Emotional bait with no stated fact ("Kan donduran görüntü"). |
   | N1 | NO | States actor and action, even with loud wording (şok/skandal is sensational, not clickbait). |
   | N2 | NO | A quote headline stating a claim. |
   | N3 | NO | A question headline that still states the key fact. |
   | N4 | NO | A "Son dakika" prefix alone. |
   | N5 | NO | A live headline naming the event. |
   | N6 | NO | Other. |

   Borderline rows (actor named, action vague) are NO unless the vague part
   is the core news — conservative, can only lower precision.

e) precision = YES / 200.
   - Full sheet (titles included) goes to the session scratchpad only,
     never committed.
   - `tests/fixtures/clickbait-precision.json` holds `{checkedOn,
     questionSet, threshold: 0.7, salt: 'tik-tuzagi-v1', rows:
     [{article_id, source_slug, zone, jev_prob, label, rule}]}` — no titles.
   - Per-zone precision recorded in this file's "Results" section (below).

f) `CLICKBAIT_PRECISION_CHECK = {checkedOn, sample: 200, clickbait: k,
   precision: k/200, threshold: 0.7, questionSets: ['2026-09-24.1'],
   labeler: 'model-proxy (single labeller)'}`. If precision < 0.80, leave
   the gate closed and say so in the PR body. Copy must never claim a human
   or double-labelled check.

g) Also record the EXPLAIN, the eligible-outlet count, and the existing
   cron jobs (confirm minute `:19` is free) — see below.

## Data gathered 2026-09-28 (read-only, against production)

- **Version inventory** (`task = 'clickbait'`):
  - `2026-09-20.1`: 3,539 rows (2026-09-20 15:30–19:10)
  - `2026-09-21.1`: 5,673 rows (2026-09-20 19:20–2026-09-21 20:30)
  - `2026-09-21.2`: 420 rows (2026-09-21 20:34–22:00)
  - `2026-09-21.3`: 18,718 rows (2026-09-21 22:20–2026-09-24 23:10)
  - `2026-09-24.1` (current): 22,031 rows (2026-09-24 23:20–2026-09-28 18:50
    at measurement time)
- **Duplicate check** (30-day window, `(article_id, question_set)`): `0`.
- **EXPLAIN** (30-day, single-task, single-version aggregate): 15,133 ms
  execution, `Buffers: shared hit=78883 read=46076 written=2` (~124,959
  blocks), `Bitmap Heap Scan` on `jev_shadow_predictions` alone taking
  ~5.9s–7.3s with 36,734 exact heap blocks. Full plan committed in
  `supabase/migrations/078_source_clickbait.sql`'s header comment.
- **Eligible-outlet count** at measurement time (`n >= 300`, `2026-09-24.1`,
  30-day window): **24 outlets** — clears the `CLICKBAIT_MIN_OUTLETS = 9`
  gate with room to spare.
- **cron.job**: no job scheduled at minute `:19` — free for
  `source-clickbait-rollup` (`19 * * * *`). Neighbors: `jev-shadow` (`*/10`),
  `cluster-topics-refresh` (`3-59/10`), `blindspot-recall-veto` (`7-59/10`),
  `articles-vacuum` (`*/30`).

## Results (per-zone precision)

**Measured 2026-09-28** on the Step 0c sample (200 rows, `jev_prob >= 0.7`,
question set `2026-09-24.1`, salt `tik-tuzagi-v1`). Blind labelling: two
independent model-proxy labellers (Opus) labelled all 200 rows from title +
description only (no outlet, no `jev_prob`); raw agreement 198/200 (99%); a
third labeller adjudicated the 2 disagreements. This is a model-proxy check,
not a human one, and copy must never claim otherwise.

| Scope | Clickbait / flagged | Precision |
|---|---|---|
| All | 153 / 200 | **0.765** |
| iktidar | 82 / 90 | 0.911 |
| muhalefet | 53 / 75 | 0.707 |
| bağımsız | 18 / 35 | 0.514 |

By flag threshold (same sample, rows with `jev_prob` at or above t):

| t | n | Precision | bağımsız |
|---|---|---|---|
| 0.70 | 200 | 0.765 | 18/35 |
| 0.80 | 86 | 0.814 | 5/11 |
| 0.85 | 45 | 0.822 | 0/3 |
| 0.90 | 13 | 1.000 | 0/0 |

**Decision: gate stays closed** (`CLICKBAIT_PRECISION_CHECK = null`).
Overall precision is below the 0.80 floor, and — more importantly — the false
positives are not spread evenly: the question over-flags bağımsız outlets'
headlines (about half of their flags are not clickbait), so a public per-outlet
ranking would systematically penalise one zone. Raising the threshold does
not fix the zone skew at any n large enough to rank outlets. Next step is a
question rewrite (as the kap_class rewrite did), then re-run Step 0 on the new
question set. The real rows (no titles) are in
`tests/fixtures/clickbait-precision.json`.

## Runbook

### Applying 078

`078_source_clickbait.sql` is additive-only and idempotent (`create table if
not exists`, `create or replace function`, ledger insert `on conflict do
nothing`) — safe to re-apply. Dry-run locally on Postgres 15 before applying
to a real environment:

1. `initdb` a throwaway data dir, `pg_ctl start` on a scratch port,
   `createdb`.
2. Apply, in order: `tests/qa/stub.sql` (or the repo's schema stub),
   `alter table public.articles add column if not exists created_at
   timestamptz not null default now()`, `061_jev_shadow.sql`, `078`.
3. Seed one outlet, one wire and one aggregator source with 300 articles
   each and `clickbait` predictions carrying
   `jev_answer->>'question_set' = '2026-09-24.1'`.
4. Call `select public.source_clickbait_rollup(...)` twice — first call
   returns `> 0`, second returns `0` (the `is distinct from` guard). Call
   `select * from public.source_clickbait_30d(array['2026-09-24.1'], 30,
   1)` and confirm it returns the outlet and the wire but not the
   aggregator, `n_flag` only counts `>= 0.7`, and a seeded duplicate row is
   counted once.
5. `pg_ctl stop`.

Deploy order: 078 can apply before or after this PR's TypeScript/UI changes
land — a missing migration only makes the rpc error, which
`getClickbaitKarne()` turns into `null` (section hidden), never a 500. Apply
078 first anyway so the rollup starts accumulating data immediately (the
migration includes a one-off 30-day backfill).

### Rollup cron

`source-clickbait-rollup` runs at `:19` past every hour
(`select public.source_clickbait_rollup();`, default window: yesterday
through today UTC, clamped to 40 days). It upserts
`public.source_clickbait_daily`, one row per `(source, UTC day the
prediction was written, question_set)`.

### Kill switch

```sql
update cron.job set active = false where jobname = 'source-clickbait-rollup';
```

### When Jev's question-set version bumps

`tests/migrations/078-source-clickbait.test.ts` pins `CLICKBAIT_QUESTION_SETS`
against `JEV_QUESTION_SET_VERSION` and `CLICKBAIT_ARTICLE_CALL_SHA` against a
sha256 of the article call's `questions`. When `JEV_QUESTION_SET_VERSION`
bumps, that test goes red by design:

- **If the article call's `clickbait` question is byte-identical** to the
  previous version (a wording-unrelated bump elsewhere), append the new
  version string to `CLICKBAIT_QUESTION_SETS` — the window keeps
  accumulating across both versions.
- **If the question text changed**, replace `CLICKBAIT_QUESTION_SETS` with
  only the new version — this resets the window (the UI's "real covered
  span" copy makes the reset visible rather than silently discontinuous).

Either way, re-run Step 0 (Step 0d, the blind label pass) against the new
version before trusting `CLICKBAIT_PRECISION_CHECK` again — a different
question wording is a different classifier for precision purposes, even at
the same Spearman correlation.
