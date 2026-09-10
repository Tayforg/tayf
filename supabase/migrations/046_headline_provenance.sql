-- 046_headline_provenance.sql
--
-- Provenance for LLM-rewritten neutral headlines. Migration 019 added
-- title_tr_neutral / title_neutral_at but recorded no audit trail of which
-- model or which prompt version produced a given rewrite. These two columns
-- close that gap: the headline cron (src/app/api/cron/headline/route.ts)
-- now writes both in the same update as title_tr_neutral/title_neutral_at,
-- so a rewrite can never land without one.
--
-- Additive, nullable, no backfill: NULL correctly means "written before
-- provenance existed" -- there are zero rewritten rows in production today
-- (ANTHROPIC_API_KEY is unset). `clusters` is already publicly readable
-- (017_rls_policies.sql) and neither new value is a secret (a model id and
-- a prompt-template version string), so no RLS change.

alter table public.clusters
  add column if not exists title_neutral_model text,
  add column if not exists title_neutral_prompt_version text;

comment on column public.clusters.title_neutral_model is
  'LLM model id (e.g. claude-haiku-4-5-20251001) that produced '
  'title_tr_neutral for this cluster. NULL until the headline cron '
  'rewrites this cluster at least once. See '
  'src/app/api/cron/headline/route.ts (LLM_MODEL).';

comment on column public.clusters.title_neutral_prompt_version is
  'Value of HEADLINE_PROMPT_VERSION (src/lib/headline/prompt.ts) at the '
  'time title_tr_neutral was generated for this cluster. NULL until the '
  'headline cron rewrites this cluster at least once.';
