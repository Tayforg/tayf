# Fact-check links ("Bu konuda doğrulama")

Migration 080 adds `fact_checks` / `cluster_fact_checks` and a Vercel cron
(`/api/cron/fact-checks`, hourly at :23) that fetches independent
fact-check publisher feeds, stores their headline + link only, and links
them to Tayf clusters whose keyword overlap suggests they cover the same
claim or event. Rendered on the cluster page as a small link-out box
(`src/components/story/fact-check-box.tsx`) -- never a verdict, description
or excerpt.

## Step 0 -- feed verification (2026-09-28)

Each candidate URL was fetched with:

```
curl -sS -L -m 15 -A "TayfBot/1.0 (fact-check link checker)" <url>
```

A feed was kept only if it returned 200, parsed as RSS/Atom XML, had at
least one item, and every item link's host belonged to that publisher (AA
additionally required `/teyithatti/` in the path).

| Publisher | URL tried | Result | Items | Newest pubDate | Kept? |
|---|---|---|---|---|---|
| Teyit | `https://teyit.org/feed` | 200 `text/xml`, 8,744 bytes | 10 | 2026-09-28 19:35 +0300 | **Yes** |
| Doğruluk Payı | `https://www.dogrulukpayi.com/rss` | 404 `text/html` | -- | -- | No |
| Doğruluk Payı | `https://www.dogrulukpayi.com/feed` | 404 `text/html` | -- | -- | No |
| Doğruluk Payı | `https://www.dogrulukpayi.com/rss.xml` | 200 `text/xml`, 8,902 bytes | 12 | 2026-09-28 16:59 +0300 | **Yes** |
| Malumatfuruş | `https://www.malumatfurus.org/feed/` | 200 `application/rss+xml`, 30,866 bytes | 20 | 2026-09-28 11:09 +0000 | **Yes** |
| Malumatfuruş | `https://malumatfurus.org/feed` | 200 (redirects `-L` to the `www.` URL above, identical body) | 20 | same | Same feed, canonical `www.` URL used |
| AA Teyit Hattı | `https://www.aa.com.tr/tr/rss/default?cat=teyithatti` | 404 | -- | -- | No |
| AA Teyit Hattı | HTML page `https://www.aa.com.tr/tr/teyithatti`, `<link rel="alternate">` | advertises only `/rss/` (AA's single site-wide feed, not scoped to teyithatti) | -- | -- | No |
| AA Teyit Hattı | `https://www.aa.com.tr/rss/` | curl timed out (15s) behind a redirect (`302` to `defaultcat=guncel`) | -- | -- | No |

**Result:** 3 of 4 candidate publishers have a verified feed
(`src/lib/fact-checks/feeds.ts`). AA Teyit Hattı ships with `feedUrl: null`
-- there is no feed scoped to the teyithatti section, and even the
site-wide feed's items would fail the `/teyithatti/` path rule. It stays
in `FACT_CHECK_PUBLISHER_KEYS` (so the schema/UI/matcher all already
support it) but the cron simply never fetches it until AA publishes a
proper feed.

## Step 0 -- FTS timing

```sql
explain (analyze, buffers)
select id from clusters
where search_tsv @@ websearch_to_tsquery('turkish','tiktok or vpn or hesap')
  and updated_at >= now()-interval '9 days'
  and not is_archived
  and article_count >= 2
order by article_count desc limit 25;
```

Result (read-only, against production): a `BitmapAnd` of
`clusters_search_tsv_idx` (GIN, migration 035) and
`idx_clusters_active_updated_at`, feeding a top-N heapsort. **17.6 ms**
execution time (Planning 14.9 ms), well under the 100 ms budget -- no
sequential scan, no lifetime-of-table cost.

## Step 0 -- precision sample

Methodology: the pure matcher (`match.ts`, zero imports) was run from a
throwaway scratch script over every item of the 3 verified feeds x a
3,000-cluster sample (`updated_at >= now() - 14 days`, `article_count >=
2`, not archived; each cluster's headline = `title_tr_neutral ??
title_tr`, member titles from `cluster_articles`). Every pair scoring
`>= 0.3` was collected (169 total), sorted descending, and the top 50 were
judged by hand: **yes** if the fact-check is about the same claim or event
as the cluster.

| threshold | n judged | positives | precision |
|---|---|---|---|
| 0.3 | 50 | 30 | 0.600 |
| 0.4 | 50 | 30 | 0.600 |
| 0.5 | 44 | 28 | 0.636 |
| 0.6 | 10 |  9 | 0.900 |
| 0.7 |  8 |  8 | 1.000 |

Below 0.6 the matcher is dominated by generic word overlap ("okul",
"saldırı", "gemi") pulling in unrelated headlines (e.g. Teyit's "Nuh'un
Gemisi'nin bulunduğu iddiası" matching an unrelated shipbuilding story on
the shared stem "gemi"). At 0.6+ every judged pair is a genuine same-event
match (the Mekke İHA saldırısı fact-check against the matching news
clusters, and the Rusya/Ukrayna video fact-check against the matching
attack cluster).

**Decision rule:** lowest threshold with precision >= 0.90 and >= 5 judged
positives at or above it -> **`PUBLISH_MIN_SCORE = 0.6`**
(`src/lib/fact-checks/match.ts`). `SHADOW_MIN_SCORE = 0.3` stays the
shadow floor: pairs scoring 0.3-0.59 are written but never shown
(`is_published = false`), so they're auditable and promotable by an
operator without ever being auto-published on weak signal.

## Post-launch precision audit (2026-11-05) -- `keyword-v2`

The Step 0 calibration above judged only 10 pairs at the 0.6 cut. Production
now holds 181 `cluster_fact_checks` rows (11 published, 170 shadow; all
`method = 'keyword-v1'`, `decided_by = 'auto'`), and **4 of the 11 published
links were wrong** (measured precision 7/11 = 0.636, not 0.90):

| Fact-check (Teyit) | Wrong cluster(s) | matched_terms | score |
|---|---|---|---|
| "Hakan Fidan'ın Almanca konuştuğu video gerçek mi?" | `cc57f5f6`, `26e48fc5`, `9a0d12b4` (three unrelated Fidan stories) | hakan, fidan, konus | 0.667 |
| "Cemil Tugay'ın katıldığı temizlik çalışmalarını gösteren video güncel mi?" | `2df57b90` (an unrelated CHP story naming Tugay) | cemil, tugay, katil, goste | 0.625 |

The other 7 published links (NASA / Deniz Burnham, Panama x2, okul saldırısı,
Fransa öğrenci eylemleri, Rusya/Ukrayna, Doğu Akdeniz) are on topic.

**Root cause.** `matched.length >= 3` treated a person's first and last name
as two independent pieces of evidence and a generic claim verb ("konuş",
"katıl", "göster") as a third. Name + name + verb cleared
`matched >= 3`, `entityMatched >= 1` and `score >= 0.6` for any story that
merely named the same person.

**Fix (`MATCH_METHOD = "keyword-v2"`, no migration, no LLM).**

- `extractFactCheckTerms` also returns `nameSpans`: the stems of person-name
  spans, i.e. runs of 2+ adjacent capitalised words (a title may open with
  one). A run ends at, and includes, the first word with an apostrophe suffix
  ("Fidan'ın") or one ending in clause punctuation, and otherwise stops before
  the next non-capitalised word. A run must carry at least 2 stems (a leading
  "Video" is not part of a name).
- Spans are only trusted in sentence-case titles (Teyit). Title Case titles
  (Doğruluk Payı) yield none, because adjacency means nothing when every word
  is capitalised. The test is: lowercase-initial content words at least as
  many as capitalised ones, **not counting the words inside the candidate
  spans themselves**, and a title with no lowercase content word at all (and
  2+ capitalised ones) is Title Case outright. Two real titles motivate the
  refinements: "Hakan Fidan'ın **Almanca** konuştuğu video" has a capitalised
  language name next to the name, and "Bir Okul Saldırısı Başlamadan
  Önlenebilir mi?" is one run that swallows the whole title.
- `GENERIC_CLAIM_VERB_STEMS` (`konus`, `katil`, `goste`, `acikl`, `soyle`,
  `yapti`, `payla`) still count in `matched` and in the score weight but never
  toward the term minimum.
- `scoreCluster` reports `distinctTerms` = (name spans that claim a matched
  stem no earlier span claimed) + (matched stems outside any span that are not
  generic claim verbs). Overlapping spans of one person ("Bakan Hakan Fidan ve
  Hakan Fidan'ın ...", or "Ali Veli, Veli Ali, Ali Veli Can") share stems, so
  the second and third add nothing and the person counts once. **Publish**
  needs `distinctTerms >= MIN_MATCHED_TERMS (3)`, `matched.length >=
  MIN_MATCHED_TERMS` (the keyword-v1 gate, kept so v2 can only publish what v1
  would have), an entity match and `score >= 0.6`. The **shadow** rule is
  unchanged (2 matched terms, `score >= 0.3`).
- **Known recall cost.** A span is any run of 2+ capitalised words, so a role
  before the name ("CHP Genel Başkanı Özgür Özel") and an adjacent place with a
  case suffix ("Özel Silivri'de", "Erdoğan Yeni Delhi'de") join the person's
  span and count once. An on-topic pair whose evidence is role/name/place plus
  one other term therefore lands in shadow, where an operator can promote it,
  instead of publishing. Example: "Cumhurbaşkanı Erdoğan Yeni Delhi'de G20
  zirvesine katıldı mı?" against the headline "Erdoğan Yeni Delhi'de G20" has 4
  matched stems and a 0.727 score (keyword-v1 would publish it) but 2 distinct
  terms (the span and `g20`), so it is shadow; `match.test.ts` pins this. A
  wrong box is worse than none, so the heuristic stays as it is. The candidate
  refinement is a locative-suffix split (close the run before a -de/-da/-te/-ta
  word), but it needs a replay of all stored pairs first.

**Replay** (read-only; every stored pair re-scored from the live cluster
headline and member titles). All 11 published rows reproduce their stored
`matched_terms` and `score` exactly (170 shadow rows: 162 reproduce, 8 have
drifted because their clusters changed since scoring). Result for all 181
pairs, old matcher and new matcher on the same data:

- exactly the 4 wrong published pairs above flip to shadow (`distinctTerms = 1`);
- the 7 on-topic published pairs stay `publish` (`distinctTerms` 3-4);
- 0 shadow-to-publish flips, and no pair changes score or matched terms.

`distinctTerms <= matched.length` always, so keyword-v2 can only publish less
than keyword-v1, never more. It holds by construction: a span counts only if it
claims a matched stem no earlier span claimed, so overlapping spans of one
person cannot count twice, and the publish gate also keeps v1's
`matched.length >= 3`. Tests: `src/lib/fact-checks/match.test.ts`
rebuilds all 11 published pairs from their real headline and member titles.

**This does not repair rows already live.** The cron only re-scores fact-checks
from the last `RECENT_WINDOW_DAYS = 3` days and only ever promotes shadow rows,
never demotes an auto-published one, so the four keyword-v1 links above stay
on the site until an operator unpublishes them with the SQL under *Ops notes*.
Rows written after this change carry `method = 'keyword-v2'`; audit the old
ones with `select * from cluster_fact_checks where method = 'keyword-v1' and
is_published;`.

## Volume expectation

Fact-checkers mostly debunk viral social-media claims, not the
professional-outlet coverage this corpus is built from -- prod `sources`
has 0 rows matching teyit/doğruluk/malumat, confirming the two universes
rarely overlap. Match volume is expected to stay small; the gate is
deliberately conservative (`MIN_MATCHED_TERMS = 3` distinct terms, an entity
match required, `MAX_CLUSTERS_PER_FACT_CHECK = 3`) -- a wrong "doğrulama" box
is worse than none.

## Ops notes

- **Kill switch:** set `FACT_CHECK_BOX=off` to hide every box immediately
  with zero Supabase queries (`isFactCheckBoxEnabled()` in
  `cluster-fact-checks-query.ts`). The cron keeps running independently --
  this only gates the reader-facing render.
- **Unpublishing a link is operator-only SQL:**
  ```sql
  update cluster_fact_checks
  set is_published = false, decided_by = 'admin'
  where cluster_id = '<uuid>' and fact_check_id = '<uuid>';
  ```
  `decided_by = 'admin'` is load-bearing: the cron only ever promotes rows
  where `decided_by = 'auto'`, so an admin-set decision is never
  overwritten by the next run.
- To hide a whole fact-check article (all its links) instead:
  `update fact_checks set is_published = false where id = '<uuid>';` -- RLS
  means an unpublished parent also hides every link row via the
  `cluster_fact_checks` policy's `exists (... f.is_published)` clause,
  even if that individual link row is itself `is_published = true`.
