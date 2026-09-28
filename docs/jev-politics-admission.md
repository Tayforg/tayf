# Jev politics admission ("ADMIT") — runbook

Migration `089_jev_politics_admission.sql`. Ships with `JEV_POLITICS_ADMISSION`
unset (off). Nothing in this PR changes reader-facing behaviour: the flag
must be flipped by an operator, in stages, after the preconditions below
hold.

## Preconditions

- Migration `088` (JEV-A, per-task `question_hash` stamps) is deployed in
  code. `089`'s claim function joins `politics`/`topic7` predictions on
  `jev_answer.question_hash` and `jev_answer.call_id` — without 088's
  stamps, the claim query returns zero candidates forever (fails closed,
  never errors).
- `073` (alert CHECKs / canary resolver) is already on prod.
- 7-day rule volume and audit numbers this migration's defaults are tuned
  against (measured 2026-09-28): ~92 non-`dunya` articles/day, replay
  67/day with 19.5% joining existing clusters, audit 92% politics-relevant
  (Wilson 0.81–0.97), fresh-scoring-within-60-min 0.8% (G1 fails today).

## Deploy order (do not reorder)

1. **Apply `089` to prod BEFORE merging this PR to `main`.** Any unrelated
   `vercel --prod` deploy after merge but before the migration would ship
   the new `articles.politics_admitted_at` / `politics_admitted_at`
   embedded-select column to PostgREST before the column exists — a 400 on
   every cluster read (the 071 lesson).
2. Deploy the `cluster-consumer` Edge Function (`--no-verify-jwt`).
3. Deploy the Next.js app (Vercel).
4. Poll `vercel inspect` until Ready, then alias.

## Flag stages

`JEV_POLITICS_ADMISSION` is a Supabase Edge Function secret (Vercel never
sees it — the admin card's mode line says "Kapalı ya da aday yok" instead
of reading the secret directly, and infers mode from claim rows instead).

| Value | Behaviour |
|---|---|
| unset / anything but the exact strings below | off — identical to pre-089 |
| `shadow` | claims candidates, dry-runs them through the real clusterer, writes only the `jev_politics_admissions` row |
| `live` | claims + dry-runs everything not on `livePins`; `livePins`-pinned pairs are stamped and actually clustered |

`livePins` is `[]` in this PR — even `live` mode can only ever produce
shadow claims until a follow-up PR promotes a pin.

## Promotion gates (G1–G7, operator follow-ups — not part of this PR)

- **G1**: `fresh_scored_60m_share` ≥ 0.70 on 4 checks over 24h, and
  `claim_lag_p50_min` ≤ 45.
- **G2**: 40–150 claims/day.
- **G4**: `join_existing / decided` ≥ 15% over ≥ 150 decided claims
  (recalibrated from the original 20% bar to what a dry run can actually
  see — the replay measured 19.5%).
- **G5**: ≥ 80 stratified reviews; politics-relevant Wilson lower bound ≥
  0.80; foreign ≤ 10% with Wilson upper bound ≤ 15%; each zone (iktidar /
  bağımsız / muhalefet) ≥ 80% reviewed.
- G3, G6, G7: reserved for a later promotion PR that also populates
  `livePins`.

Hold shadow mode for ≥ 24h with G1 passing, and ≥ 50 stratified reviews,
before an operator moves a pair from `shadowPins` to `livePins` in
`supabase/functions/_shared/cluster/politics-admission.ts`.

## Acceptance for this PR

- Flag off: drain behaviour, writes and JSON are unchanged apart from the
  `admission` summary block.
- Shadow: the dry-run is provably write-free apart from the admissions row
  (no cluster insert, no `cluster_link_atomic`, no articles update, no Jev
  gateway call).
- The read paths (home feed, `/blindspots`, `/api/v1`) count a stamped
  member as a politics member; `/api/v1` never serialises the stamp.
- The `/admin` review route is admin-gated, input-validated, and rate
  limited (20 tokens, 0.2/s refill).

## Rollback

**Soft (flag only):** unset `JEV_POLITICS_ADMISSION` on the Edge Function.
Every subsequent drain claims nothing; already-claimed shadow rows are
inert (they were never clustered).

**Hard (undo live stamps):**

```sql
-- Dry run first — returns counts, writes nothing.
select * from public.jev_politics_admission_rollback('<since timestamptz>', true);

-- Then apply.
select * from public.jev_politics_admission_rollback('<since timestamptz>', false);
```

This calls `public.cluster_unlink_article` per affected `(cluster_id,
article_id)` (recomputing the cluster's aggregates under its per-cluster
advisory lock — same code path `/admin`'s "Küme dışı adaylar" unlink
action uses), clears `articles.politics_admitted_at`, and stamps
`rolled_back_at` on each affected `jev_politics_admissions` row so the
claim function never re-claims it. After a hard rollback, POST a
revalidation for every emptied/changed cluster (`/api/revalidate`, same
`CRON_SECRET`-bearer contract cluster-consumer's own revalidation POST
uses) so the home feed and `/blindspots` drop their stale cache entries.

**Code rollback:** revert the PR. `politics_admitted_at` stays a harmless
NULL-only column on `public.articles` (additive migration, nothing drops
it).

## Documented gaps (not fixed by this PR)

- The `015`/`020` backfill jobs and `/api/metrics` do not know about
  `politics_admitted_at` — they still count only `politika`/`son_dakika`
  category rows. Low-risk today (the column is NULL everywhere while
  `livePins` is empty) but will under-count once live pins exist.
- `jev-shadow`'s `blindspot_recall` stage and the `071` recall veto search
  only scan `politika`/`son_dakika` articles for silent-side matches — an
  admitted (non-`politika`-category) article is invisible to that search
  until a follow-up widens it.

## Founder decisions

1. **Column placement.** `politics_admitted_at` lives on `public.articles`,
   which already has policy "public read articles" plus a table-level
   `anon` SELECT grant, so the stamp is publicly readable. It only says
   "Jev admitted this article into political clustering" — no score, no
   reasoning. Because `livePins` is empty in this PR, the column stays
   NULL on every row until a promotion PR, so the founder can still choose
   the alternative (a service-role side table + server-side joins) with
   zero rows exposed so far.
2. **Review rubric.** `domestic` / `policy_adjacent` (siyasete komşu /
   yerel yönetim) / `foreign` / `not_politics` / `unsure`.
   Politics-relevant = `domestic` + `policy_adjacent` for the Wilson-bound
   G5 check.
3. **Ownership.** `platform-8`'s original admission stage is dropped; this
   migration (`ADMIT`) is the single owner of politics admission going
   forward. `jev_shadow_queue` stays owned by migration `085` — `ADMIT`
   never touches it.

## See also

- `docs/migration-guide.md` links here from the JEV-A section (not edited
  by this PR).
- `supabase/functions/_shared/cluster/politics-admission.ts` — the policy
  module (pins, thresholds, `routeMessage`).
- `supabase/functions/_shared/cluster/admission-effect.ts` — the pure
  blindspot/zone-effect helper used to fill the bookkeeping row.
