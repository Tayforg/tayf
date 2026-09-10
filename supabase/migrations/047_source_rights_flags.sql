-- 047_source_rights_flags.sql
--
-- BL-13: per-source rights flags for reused media.
--
-- Some outlets have asked Tayf not to reuse their photos and/or their
-- article text (the RSS description that seeds clusters.summary_tr /
-- rss.xml's per-item excerpt). `image_allowed` and `excerpt_allowed`
-- record that per source; the read path (politics-query.ts,
-- cluster-detail-query.ts for images; summary-attribution.ts,
-- rss-summary-attribution.ts for excerpts) must never render that
-- source's image or excerpt once the corresponding flag is false --
-- falling back to the next eligible member, or to no image/excerpt at
-- all. Both default to `true` so every existing source keeps behaving
-- exactly as before until an operator explicitly flips one to `false`
-- for a specific outlet that has objected.

begin;

alter table public.sources
  add column if not exists image_allowed boolean not null default true,
  add column if not exists excerpt_allowed boolean not null default true;

comment on column public.sources.image_allowed is
  'False when this outlet has asked Tayf not to reuse its photos. The '
  'read path (hero/card image candidate selection in politics-query.ts '
  'and cluster-detail-query.ts) must never render this source''s article '
  'images once false -- it must skip to the next eligible member''s '
  'image, or render no image at all.';

comment on column public.sources.excerpt_allowed is
  'False when this outlet has asked Tayf not to reuse its article text. '
  'The read path (summary-attribution.ts, rss-summary-attribution.ts) '
  'must never attribute or render this source''s excerpt/summary text '
  'once false -- it must fall back to the next eligible member, or to no '
  'excerpt at all.';

commit;
