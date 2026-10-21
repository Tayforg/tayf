# JEV-B: slim article pack (JEV_ARTICLE_PACK)

Drops **opinion** (15% precision) and **sensational** (20%) from the per-article Jev call.
Kept: politics, topic, topic7, clickbait, framing. Framing stays because it is reader-facing
(068 receipt) and ADMIT needs it. Registry entries stay for historical rows.

Nothing changes until the flag is switched on.

## Flag

`JEV_ARTICLE_PACK` is read in the `jev-shadow` edge function (`Deno.env`).

| value | behaviour |
|---|---|
| unset, `full`, anything unknown | today: 7 questions, `question_set` = `JEV_QUESTION_SET_VERSION` (`2026-09-24.1`) |
| `slim` | 5 questions, no opinion/sensational rows, article rows and the regression run header carry `JEV_QUESTION_SET_VERSION_SLIM` (`2026-10-04.1`) |

- `2026-10-04` is only the date baked into the version string. The precondition is not met on
  that date (see Precondition: the same-set 660-article count starts after migration 104, earliest
  2026-10-25). If the switch happens later, that is fine; the string is never reused.
  If the text is ever changed again, bump to a new string.
- Question text and `question_hash` fingerprints are identical in both packs, so ADMIT pins and
  KAP canaries are unaffected. Only article-stage rows get the slim version; cluster, pair and
  KAP rows keep `2026-09-24.1`.
- `CLICKBAIT_QUESTION_SETS` (src/lib/sources/clickbait.ts) already includes the slim string so the
  per-outlet clickbait window continues (clickbait text is byte-identical).
- Admin: the app cannot see the edge function's env, so the admin section labels are unchanged.
  Opinion and sensational simply stop receiving new rows under slim.

## Precondition

Two same-set **660-article** regression replays exist (the noise floor). The count only
starts after migration `104_jev_regression_freeze_660.sql` is applied.

The earlier plan counted the Sunday 2026-10-04 run as the first 660-item replay. It was not:
the runs on 2026-10-04 and 2026-10-11 (regression runs 5 and 6) replayed **180 items**
(120 articles + 60 pairs, the manual `jev_regression_freeze(120, 60)`), because the 088 runbook
freeze was never run. Migration 104 freezes all 660 `jev_gold_set` articles (the pairs stay at
60), so a replay becomes about 720 calls. Runs 1-6 are a different set and do not count.

1. Apply 104 and check it (the two verification queries are in its header: article `n` = `gold` =
   660, pair = 60, and 0 gold articles without an `in_gold` item).
2. First candidate: the Sunday **2026-10-25 04:20 UTC** `jev-regression-weekly` run, or a manual
   `select public.jev_regression_trigger();` run by the founder after 104.
3. A second same-set replay is needed before switching: another manual
   `select public.jev_regression_trigger();` once the first has closed.
4. Both runs must close status `ok` with `items` = 660 + pairs (720 with the 60 frozen pairs).
   A `partial` or `error` run does not count:
   `select id, status, items, started_at from public.jev_regression_runs order by id desc limit 3;`

Do not switch before both exist.

**Warning: do NOT press "Seti dondur" in /admin while this precondition is being collected.**
With no arguments it tops pairs up to 100, which changes the set and resets the count (the two
replays would no longer be same-set).

## Switch

```
supabase secrets set JEV_ARTICLE_PACK=slim
supabase functions deploy jev-shadow
select public.jev_regression_trigger();   -- slim replay to compare with the last full replay
```

## Acceptance

- Article-call mean input tokens 1,089 +/- 3% (1,221 - 132, modelled).
- No opinion or sensational rows under `2026-10-04.1`; framing on 100% of article calls.
- Replay vs the last pre-B replay: every task's flip rate <= 2 x the same-set floor + 1 pt;
  politics accuracy vs provisional labels delta >= -2 pt, dev and held-out separately.
- ADMIT claims per day within +/- 30% of the prior 7-day mean.
- Prediction rows fall by about 11,860/day (opinion 41,514 + sensational 41,514 per 7 days).

## Rollback

```
supabase secrets unset JEV_ARTICLE_PACK
supabase functions deploy jev-shadow
```

Reverts to the 7-question call and `2026-09-24.1`. No SQL. Rows written under
`2026-10-04.1` stay as history.
