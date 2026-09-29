# Gelişen hikaye (story threads)

Editor-curated chains of clusters that belong to one running story, shown day
by day at `/hikaye/[slug]` with the source-zone bar of each day. Migration
`098_story_threads.sql`; config `src/lib/story-threads/config.ts`; readers
`public-query.ts` / `admin-query.ts`; timeline `timeline.ts`; admin UI
`/admin/hikayeler`; cluster-page pill `src/components/story/thread-link.tsx`.

**Nothing is published automatically.** The nightly job only proposes cluster
pairs. An admin approves a pair (which creates a title-less, slug-less DRAFT
thread), gives the thread a title, and presses Yayınla. Publishing requires a
valid title and at least 3 member clusters (route check plus the
`story_threads_publishable` CHECK).

## Signal definitions and thresholds

`pg_trgm` is not installed and `articles.entities` is empty, so there is no
trigram or entity signal. The link signal is:

| Piece | Definition | Constant |
| --- | --- | --- |
| Base set | clusters with `first_published` in the last 14 days, not archived, `article_count >= 3` | `STORY_THREAD_WINDOW_DAYS`, `STORY_THREAD_MIN_ARTICLES` |
| Terms | turkish-stemmed lexemes of `title_tr_neutral \|\| title_tr`, length >= 4, not purely numeric | `STORY_THREAD_MIN_TERM_LEN` |
| Distinctive | `2 <= df <= greatest(3, floor(0.02 * base size))` (drops generic words like "özel") | `STORY_THREAD_DF_CAP_SHARE` |
| Per cluster | the 5 rarest distinctive terms, `idf = ln(base size / df)` | `STORY_THREAD_TOP_TERMS` |
| Pair | share >= 2 kept terms and `first_published` <= 72 h apart | `STORY_THREAD_MIN_SHARED_TERMS`, `STORY_THREAD_MAX_HOURS_APART` |
| Confidence | `0.60 * jac + 0.25 * (1 - hours/72) + 0.15 * topic7` where `jac` = shared idf / (idf A + idf B - shared idf); topic = 1 same, 0 different, 0.5 unknown | |
| Proposed | confidence >= 0.40, best 500 per run | `STORY_THREAD_MIN_CONFIDENCE`, `STORY_THREAD_RUN_CAP` |

Rules: a pair is skipped when both clusters already sit in a thread; re-runs
refresh only PENDING rows; rejected and approved pairs are never reopened;
pending/rejected rows unseen for 30 days are deleted.

Known limits: the Turkish stemmer is not consistent across suffixes (it maps
"soruşturmasında" and "soruşturması" to different lexemes), which lowers
recall. Recurring headlines ("New York borsası düşüşle açıldı", the daily
earthquake page) can look like a thread; the admin queue is the filter.
Step 0 on production (2026-09-29): base 1,390 clusters, 618 pairs, 476 at
>= 0.40, runtime under 1 s; 3 of the top 20 looked like false merges.

## Deploy

1. Merge; apply `098_story_threads.sql` (idempotent, additive; it writes the
   `schema_migrations` row itself). It schedules cron job
   `story-thread-candidates` at `53 1 * * *` UTC (04:53 TRT).
2. No env var is needed. `STORY_THREADS=off` is the optional kill switch.
3. Deploy the app. `/admin/hikayeler` reads "098 uygulanmamış olabilir" until
   the migration is applied; the public readers return null (no link, 404 page).

## Manual first run

The first proposals arrive with the first cron tick. To get them now, from a
service-role SQL session:

```sql
set statement_timeout = '5min';
select public.story_thread_candidates_refresh();   -- returns rows written
```

Then open `/admin/hikayeler`, review "Aday bağlantılar" (each row shows both
clusters, shared terms, hours apart), press Onayla or Reddet. Approving two
clusters that sit in different threads is refused (409). In "Hikayeler" give
the draft a title (the placeholder is the title of the biggest cluster),
save it, and press Yayınla. The slug is generated once
(`threadSlug(title, id)`) and never changes afterwards, also across
unpublish/republish and renames. Clusters can only be removed from drafts.

## Kill switch

- `STORY_THREADS=off` (Vercel env): `getPublishedThreadForCluster` returns null
  without a query, so the "Bu hikayenin devamı" pill disappears from
  `/cluster/[id]`. The `/hikaye/[slug]` pages themselves keep serving.
- To take one thread down: press "Yayından kaldır" (draft again, page 404s
  after the `story-threads` tag revalidates).
- To stop the nightly proposals: `select cron.unschedule('story-thread-candidates');`

## Rollback

Nothing else depends on these objects:

```sql
begin;
select cron.unschedule('story-thread-candidates');
drop function if exists public.story_thread_approve_candidate(bigint);
drop function if exists public.story_thread_candidates_refresh(integer);
drop table if exists public.story_thread_candidates;
drop table if exists public.story_thread_members;
drop table if exists public.story_threads;
delete from supabase_migrations.schema_migrations where version = '098';
commit;
```

Also revert the app change (or leave it: readers return null when the tables
are missing).

## Security notes

- `story_threads` / `story_thread_members`: `SELECT` for anon/authenticated,
  RLS-limited to published threads. `story_thread_candidates`: service_role
  only, no policy. INSERT/UPDATE/DELETE/TRUNCATE/MAINTAIN are never granted
  to anon or authenticated.
- Both functions are `SECURITY DEFINER`, `search_path = ''`, executable by
  service_role only.
- Both admin routes (`/api/admin/story-threads/candidates`, `/thread`) check
  the admin session before reading the body, then rate-limit (60 burst,
  1/s refill), then parse JSON.
- The public page shows no blindspot marker, so the recall veto (071) holds
  without extra logic.
