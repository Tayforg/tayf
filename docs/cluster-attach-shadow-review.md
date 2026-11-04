# Split-story attach (migration 151): shadow review, 3 November 2026

Status: **stay in shadow** (CLUSTER_ATTACH_MODE unset). This page records the first review of the
attach-only admission that migration 151 added (wave BD, PR #173), so the go-live decision has its
evidence in the repo. Window: 2026-11-02 15:24Z to 2026-11-03 00:10Z, read-only (SQL, edge logs and an
offline replay of the HEAD attach code). Produced by hunt 30 and checked by its adjudicator.

## Findings this review refers to

1. Topic misfit: the obituary cluster 3b4ceacf counts as politics only through its SON DAKİKA members.
   A politika-anchor guard (or an explicit founder decision to accept such clusters) is needed before
   any live flip.
2. Evidence volume: almost all would-attach rows are one story (the Ahmet Nazif Zorlu death). The
   ~75 rows/day estimate in the 151 header is stale.
3. Recall: the rule repairs about a quarter of the split articles; a wide-headline lane would need its
   own shadow and a lane CHECK change.
4. One-shot consumption: an article that arrives before its story's cluster exists is never looked at
   again.
5. Shadow-table fidelity: the table records positives only, and the same-source refusal live mode
   applies is not emulated.
6. Queue gap 22:38-22:48Z: the cluster_attach queue was dropped by an agent during wave BI docs
   verification and restored by re-applying 151 (see
   [the incident record](incidents/2026-11-02-cluster-attach-queue-drop.md)); 20 candidates were lost,
   one of which would have attached.


## Recommendation: STAY SHADOW. Do not flip to live, do not turn off.
Precision is not the problem: 26 of 26 decisions I could judge were the same story (19 in the table, 7 from my replay). The problems are that (a) the evidence is one story, and the cluster it joins is "politics" only by a SON DAKIKA label (finding 1); (b) the rule fixes about a quarter of the split articles (finding 3); and (c) it misses articles that arrive before their story's cluster exists (finding 4).

Before the next review, make three test-first changes:
1. A politika-anchor guard (or an explicit founder decision to accept obituaries in the politics feed).
2. A separately labelled wide-headline shadow lane (shared stems >= 4, Jaccard >= 0.40).
3. A delayed second look at no-match articles.

Then run 48-72 h including a weekday daytime. Suggested go-live bar: at least 10 distinct stories, at least 60 rows, 0 wrong after hand-labelling, no queue gaps, and at least one politika-anchored story with 5 or more outlets.

Running cost is negligible (drain p50 1.6 s, p95 4.5 s, maximum 9.2 s; budgeted_out 0; failed 0; delete_errors 0; maximum queue age 63 s; the 25-message cap was hit at most briefly). Turning it off would lose nothing today, but it would also lose the data to settle the questions above.

No defect was found in the shadow decision logic itself, so no code was changed. All writes were avoided. The only prod requests beyond SQL and logs were 3 GETs (cluster page 3b4ceacf, the home page and /gundem).

## Data integrity checks
- The shadow table has 19 rows, from 18:42:09Z to 22:37:02Z. Per-hour sums of would_attach in the drain summaries are 1, 1, 13, 3 and 1 for 18h-22h, total 19, matching the table exactly.
- Code versions: v42 (#173) from 15:25:31Z, v43 (#175) from 17:53:03Z, v44 (#178) from 22:52:03Z. All 19 decisions ran on v43. attach.ts, ensemble.ts and fingerprint.ts are unchanged between v43 and HEAD, so my offline replay of HEAD is valid.
- Replay fidelity: HEAD attach code over DB state (titles reconstructed from article_title_versions, members created at or before the article, newest-200 + sticky context cap, 6 h window) reproduced 18 of 19 stored rows exactly in cluster, lane and score. The 19th (istiklal 78e66207) differs only in score. It also reproduced the logged by_reason counts (stale 3, same-source 1). Removing the context cluster cap changes nothing (20 vs 20; 6 vs 7 in the earlier window), so the cap is not what limits volume.
- Gap: the queue was missing 22:38-22:48Z (finding 6), so 20 candidates were lost, one of which would have attached.

## Per-row hand labels (decision-time titles; Z = "Zorlu Holding Yönetim Kurulu Başkanı Ahmet Nazif Zorlu hayatını kaybetti")
All 19 are CORRECT attach on story identity. "gzt" is member 4b50dc90. Its title was "SON DAKİKA | Vestel'in sahibi Ahmet Nazif Zorlu hayatını kaybetti" until 20:24:06, then "SON DAKİKA | Z" until 20:51:07, then Z.

| # | time Z | article | source / cat | title at decision | target cluster + evidence member | lane / score | label, reason |
|---|---|---|---|---|---|---|---|
| 1 | 18:42:09 | f28f7a78 | haberport / genel | Amna Baloch, Ankara'da Pakistan'ın ilk kadın büyükelçisi olarak göreve başladı | c0819494: haberler-com 5de5d816 (then-title "Amna Baloch, Ankara'da ilk kadın Pakistan büyükelçisi olarak göreve başladı") | headline 0.995 | correct: same appointment, near-identical headline |
| 2 | 19:01:01 | fb830a85 | aydinlik / genel | Amna Baloch Pakistan'ın Türkiye Büyükelçisi olarak göreve başladı | c0819494: same member | headline 0.820 | correct: same appointment |
| 3 | 20:16:03 | 8f98389a | hurriyet / dunya | ABD Başkanı Trump: İran'ın bir anlaşma gerçekleşebilir | 7c2fe9dc: haber7 "Trump'tan seçim öncesi açıklama: İran ile anlaşma olabilir", haberler-com quote "Bu gerçekleşebilir" | headline 0.771 | correct: same Trump statement (garbled title) |
| 4 | 20:19:02 | 7766c14d | gazete-oksijen / dunya | Ahmet Nazif Zorlu hayatını kaybetti | 3b4ceacf: gzt (Vestel title) | headline 0.856 | correct: same death (topic-misfit cluster) |
| 5 | 20:19:02 | 38218495 | aksam / genel | same | gzt | headline 0.856 | correct |
| 6 | 20:25:02 | 78e66207 | istiklal / genel | same | gzt | headline 0.855 | correct |
| 7 | 20:27:14 | b28fc709 | cumhuriyet / genel | Z | gzt ("SON DAKİKA \| Z") | exact-title 1.0 | correct |
| 8 | 20:31:02 | 8bb6278a | diken / genel | Ahmet Nazif Zorlu hayatını kaybetti | gzt | headline 0.775 | correct |
| 9 | 20:33:07 | 46dc1b46 | haberturk / genel | same | gzt | headline 0.774 | correct (haberturk #1) |
| 10 | 20:39:08 | 0e34dca0 | takvim / yasam | Z | gzt | exact-title 1.0 | correct |
| 11 | 20:39:08 | 9315d34d | evrensel / genel | Z | gzt | exact-title 1.0 | correct |
| 12 | 20:39:09 | 2909c102 | yenicag / genel | Z (extended with ": Cenaze programı açıklandı" at 20:45:20, after the decision) | gzt | exact-title 1.0 | correct |
| 13 | 20:43:04 | 0a627244 | birgun / genel | Z | gzt | exact-title 1.0 | correct |
| 14 | 20:48:05 | a58ae8aa | haberturk / genel | Zorlu Holding'in kurucusu Ahmet Nazif Zorlu hayatını kaybetti! | gzt, cnn-turk | headline 0.792 | correct; second haberturk row, live would refuse (same-source) |
| 15 | 20:52:04 | cb1ce631 | posta / ekonomi | İş insanı Ahmet Nazif Zorlu hayatını kaybetti (edited to Z at 21:00:07) | cnn-turk b6718afe "Son dakika haberi: Ahmet Nazif Zorlu hayatını kaybetti" | headline 0.854 | correct |
| 16 | 21:07:05 | 3f7af6c8 | milat / genel | Ahmet Nazif Zorlu hayatını kaybetti | cnn-turk | headline 0.910 | correct |
| 17 | 21:10:05 | db9a7ef9 | trt-haber / genel | same (description repeats the Z sentence) | hurriyet 34b8fa6d, equal strict fingerprint (shingle set equal despite different title text) | fingerprint 1.0 | correct: legitimate near-duplicate text |
| 18 | 21:34:02 | 6d2d8253 | yeni-mesaj / genel | Z | gzt, hurriyet | exact-title 1.0 | correct |
| 19 | 22:37:02 | f002f1a8 | indyturk / dunya | Z | gzt | exact-title 1.0 | correct |

Extra decisions from my replay (not in the table, all judged correct):
- a3832627 haberturk/dunya "Trump'tan sandığa gidin çağrısı" 22:45Z, to cluster 5a262ed6 (bloomberg-ht, haber-com), headline 0.760. This is the one lost in the queue gap.
- ad6c7aa1 evrensel/dunya 09:48Z, Carlson nuclear-strike claim, headline 0.819.
- 68f826f7 haber-global/dunya 12:06Z, same Carlson story, headline 0.812.
- bc1b1979 cgtn-turk/dunya 11:54Z, Israel alert before the US midterms, headline 0.750.
- 0a94207c aydinlik/yasam 13:33Z, Memişoğlu tobacco statement, headline 0.849.
- 06724bb6 habervakti/genel 14:09Z, Bayraktar fon remark, headline 0.728, attaches to a 1-member cluster. Lowest score seen; leaning correct (same statement).
- 418dd029 evrensel/genel 14:36Z, Silivri shipwreck families' call, headline 0.895.

## Precision, lanes, categories, errors
- Precision on the 19 table rows: 19/19 same story (Wilson 95% lower bound 83%). On 3 distinct stories: 3/3 (lower bound 44%). Combined with the replay (26 rows, 9 stories): 26/26 (lower bound 87%), 9/9 stories (70%). The author's replay found 73/73. No wrong attach, no unsure in the 19.
- Lanes in the 19 rows: headline 11 (58%, mean score 0.84, range 0.77-0.995), exact-title 7 (37%), fingerprint 1 (5%). Replay-only extras are all headline (0.73-0.90). Scores as low as 0.728 were still correct, so there is no evidence that a score floor above 0.7 is needed.
- Categories in the 19 rows: genel 14, dunya 3, yasam 1, ekonomi 1, teknoloji 0. Error rate is zero in every category and lane. The concentration risk is topic, not identity: 12 of the 16 Zorlu rows are genel.
- Reasons in the drain logs, 1,103 reads: no-match 1,080 (97.9%), would_attach 19 (1.7%), stale 3, same-source 1, ambiguous 0, below-share 0, roundup 0.
- Sources: 18 distinct outlets in the 19 rows; opposition (cumhuriyet, birgun, evrensel, diken, aydinlik) and government-side (aksam, takvim, trt-haber, yeni-mesaj, yenicag, hurriyet, haberturk) outlets both benefit, so bias bars would improve where the cluster is truly political.

## Volume per hour (cluster-consumer drain summaries, 15:24-23:58Z)
| hour Z | drains | attach reads | would_attach | no-match | stale | same-source | max depth after |
|---|---|---|---|---|---|---|---|
| 15 (from 15:24) | 36 | 81 | 0 | 81 | 0 | 0 | 0 |
| 16 | 60 | 141 | 0 | 141 | 0 | 0 | 0 |
| 17 | 60 | 143 | 0 | 143 | 0 | 0 | 0 |
| 18 | 60 | 139 | 1 | 138 | 0 | 0 | 0 |
| 19 | 60 | 123 | 1 | 121 | 1 | 0 | 0 |
| 20 | 60 | 174 | 13 | 161 | 0 | 0 | 2 |
| 21 | 60 | 182 | 3 | 178 | 1 | 0 | 4 |
| 22 | 60 | 46 | 1 | 44 | 1 | 0 | 0 |
| 23 (to 23:58) | 53 | 74 | 0 | 73 | 0 | 1 | 0 |

Totals: 1,103 reads in 8.57 h is 128.7/h (design assumed 174/h average, 467 peak; observed maximum 182/h). Would-attach 19 is 2.2/h. Outside the Zorlu burst it is 3 rows, or 0.35/h (about 8/day). From my replay, 09:30-15:24Z gave 6 attaches in 5.9 h (about 24/day).

## Share of the gate-split stories fixed
- Hunt-25 finding: the FETÖ story, 9 unclustered articles beside cluster 304a47ce. The author's replay attaches 3 of 9 (33%); the other 5 have different stems and 1 is a niche source.
- Today, window 15:24-23:58Z: 61 hand-judged same-story misses (plus 9 unsure) against 20 attached. That is article recall of about 25% (20/81). Without Zorlu it is 4 attached vs 46 missed (8%).
- Story level: 19 stories have misses; 3 got at least one attach; 0 are fully repaired. In every one of the 19 a politics cluster already exists, so the attach-only design is the right population; the rule is just too narrow.
- Misses by story (id8): Zorlu 15, Yigit Uzun 3 (af4e9344, 63a876be, 7df62335), Altinbas 3 (83e9f834, 94f7c52b, 88cb1fbc), Bolat exports 1 (10b2e5ae), Pakistan 1 (9c31a7cc), Hamaney/Pezeskiyan 4, Trump-deal 6, Trump-sandiga-gidin 3 (4203725a, 80c92bc9, 98c81d77), Washington outage 2, Hürmüz/Arakçi 2, Mekke 2, Merz 1, Sarigul 4-arrest 3, Tuzla 1, Van soldier 4 (826096f8, 4b2aeaf1, c79ddcc3, b75d721e), Balfour 3, Lübnan 1, Konya 1, Kayseri fire 5.
- Wide-band experiment on that list: shared stems >= 4 and Jaccard >= 0.40 would admit 26 more articles; 25 are clearly the same story, 1 is unsure (1950b84b), 0 clearly wrong. Rows near the band that are NOT the same story (Ergun/Fon vs Sarigul, 4 stems, Jaccard 0.19-0.27) fall below 0.40, which is why the cutoff sits there.

## Caveats
- The replay approximates "member present at time T" with members' created_at, and processing time with created_at + 60 s. It reproduces production, but it is an approximation.
- Hand labels on misses used titles only; 9 pairs are unsure (Trump 'acelem yok' remarks, sozcu fae8f5eb, mynet 9cc03c4c).
- The 09:30-15:24Z replay uses titles-only fingerprints for part of that window; the fingerprint lane never mattered there (0 fingerprint hits).
