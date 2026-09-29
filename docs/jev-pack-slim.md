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

- `2026-10-04` is the earliest date the precondition allows (the Sunday of the first
  same-set replay). If the switch happens later, that is fine; the string is never reused.
  If the text is ever changed again, bump to a new string.
- Question text and `question_hash` fingerprints are identical in both packs, so ADMIT pins and
  KAP canaries are unaffected. Only article-stage rows get the slim version; cluster, pair and
  KAP rows keep `2026-09-24.1`.
- `CLICKBAIT_QUESTION_SETS` (src/lib/sources/clickbait.ts) already includes the slim string so the
  per-outlet clickbait window continues (clickbait text is byte-identical).
- Admin: the app cannot see the edge function's env, so the admin section labels are unchanged.
  Opinion and sensational simply stop receiving new rows under slim.

## Precondition

Two same-set 660-item regression replays exist (the noise floor). The first is the Sunday
2026-10-04 04:20 UTC `jev-regression-weekly` run; a second same-set replay is needed before
switching (a manual `select public.jev_regression_trigger();` after the first is enough).
Do not switch before both exist.

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
