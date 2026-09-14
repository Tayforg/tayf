-- 052_alias_hygiene.sql
--
-- First production run of the resolver (2026-09-14, 14 days, 91k articles)
-- showed two failure modes of the single-token auto alias rule:
--
--   1. Dictionary words that happen to be a company's first title token:
--      "hedef" (7.8k hits), "destek", "halk", "saat", "medya", "gelecek",
--      months, cities. A curated stoplist cannot keep up with 1,000
--      companies, so the rule becomes empirical: an auto alias that hits
--      more than p_max_hits articles in p_days is generic and gets
--      disabled. Manual aliases are never touched.
--   2. Football clubs are listed companies (FENER, GSRAY, BJKAS, TSPOR),
--      so every match report matched. Sports-desk articles are not finance
--      news; the resolver now skips category 'spor'. Club names still
--      match in economy/general coverage.
--
-- Also: bist_daily_targets skips codes shorter than 4 characters (bank and
-- brokerage member codes that Yahoo does not carry) so they cannot clog
-- the daily fill queue.

begin;

alter table public.bist_aliases
  add column if not exists enabled boolean not null default true;

comment on column public.bist_aliases.enabled is
  'false = ignored by the resolver. Set by prune_generic_aliases() for auto aliases that behave like common words.';

create or replace function public.resolve_article_tickers_for(p_ids uuid[])
returns integer
language plpgsql
as $$
declare
  v_n integer;
begin
  with recent as (
    select a.id,
           a.title || ' ' || coalesce(a.description, '') as raw,
           ' ' || public.fold_tr(a.title || ' ' || coalesce(a.description, '')) || ' ' as folded
    from public.articles a
    where a.id = any (p_ids)
      and coalesce(a.category, '') <> 'spor'
  ),
  alias_hits as (
    select r.id as article_id, al.ticker, 'alias:' || al.alias as matched_on
    from recent r
    join public.bist_aliases al on al.enabled and strpos(r.folded, ' ' || al.alias || ' ') > 0
  ),
  code_hits as (
    select distinct r.id as article_id, c.ticker, 'code' as matched_on
    from recent r
    cross join lateral regexp_matches(r.raw, '\m([A-Z]{4,6})\M', 'g') m
    join (
      select unnest(tickers) as ticker from public.bist_companies where shares_traded
    ) c on c.ticker = m[1]
  ),
  hits as (
    select * from alias_hits
    union all
    select * from code_hits
  )
  insert into public.article_tickers (article_id, ticker, matched_on)
  select distinct on (article_id, ticker) article_id, ticker, matched_on
  from hits
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Disable auto aliases that hit more than p_max_hits articles in the last
-- p_days (counted from article_tickers, so it is cheap), and drop the
-- matches they produced. Returns the number of aliases disabled.
create or replace function public.prune_generic_aliases(p_days int default 14, p_max_hits int default 300)
returns integer
language plpgsql
as $$
declare
  v_n integer;
begin
  with hot as (
    select substr(matched_on, 7) as alias, count(*) as n
    from public.article_tickers
    where matched_on like 'alias:%' and created_at >= now() - make_interval(days => p_days)
    group by 1
    having count(*) > p_max_hits
  ),
  disabled as (
    update public.bist_aliases al
    set enabled = false
    from hot
    where al.alias = hot.alias and al.origin = 'auto' and al.enabled
    returning al.alias
  )
  delete from public.article_tickers t
  using disabled d
  where t.matched_on = 'alias:' || d.alias;

  select count(*) into v_n from public.bist_aliases where origin = 'auto' and not enabled;
  return v_n;
end;
$$;

-- Pınar group loses its generic first token; give it real names.
insert into public.bist_aliases (alias, ticker) values
  ('pinar sut', 'PNSUT'), ('pinar et', 'PETUN'), ('pinar su', 'PINSU'),
  ('zorlu enerji', 'ZOREN'), ('halkbank', 'HALKB')
on conflict do nothing;

-- Apply to the current state: prune, then drop sports-desk matches.
select public.prune_generic_aliases();

delete from public.article_tickers t
using public.articles a
where a.id = t.article_id and a.category = 'spor';

create or replace function public.bist_daily_targets(p_limit int default 80)
returns table (ticker text, last_day date)
language sql
stable
as $$
  select t.ticker, b.last_day
  from (select distinct unnest(tickers) as ticker from public.bist_companies where shares_traded) t
  left join (select ticker, max(day) as last_day from public.bist_bars_daily group by 1) b using (ticker)
  where length(t.ticker) >= 4
  order by b.last_day nulls first, t.ticker
  limit p_limit;
$$;

commit;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron missing — skipping alias-prune schedule (052).';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'alias-prune') then
    perform cron.unschedule('alias-prune');
  end if;
  perform cron.schedule('alias-prune', '20 4 * * *', $sql$ select public.prune_generic_aliases(); $sql$);
end
$$;
