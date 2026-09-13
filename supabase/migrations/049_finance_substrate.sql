-- 049_finance_substrate.sql
--
-- Tayf Ekonomi substrate: KAP (Kamuyu Aydınlatma Platformu) disclosures,
-- the BIST company/ticker map, and article -> ticker resolution. This is
-- the shared data layer for the PEAD backtest and the per-ticker attention
-- feature. Nothing here trades or recommends.
--
--   bist_companies   one row per KAP member that has a stock code. Fed by
--                    the kap-ingest Edge Function when POSTed
--                    {"companies": true} (scrapes the RSC payload of
--                    https://www.kap.org.tr/tr/bildirim-sorgu).
--   bist_aliases     (alias, ticker) pairs the resolver matches on, stored
--                    already folded (see fold_tr). Hand overrides for the
--                    large caps are seeded below; kap-ingest adds one auto
--                    alias per company (first distinctive title token) with
--                    on-conflict-do-nothing, so rows edited here always win.
--   kap_disclosures  one row per KAP disclosureIndex, upserted by kap-ingest
--                    from POST https://www.kap.org.tr/tr/api/disclosure/members/byCriteria
--                    (2000-row cap per query, so the function walks one day
--                    at a time and splits by disclosureClass on a full page).
--   article_tickers  (article_id, ticker) hits from resolve_article_tickers().
--                    This is the attention signal.
--   ticker_attention_daily, disclosure_coverage
--                    the two views the backtester reads.
--
-- pg_cron (guarded exactly like 038): kap-drain pokes the Edge Function
-- every 10 min; resolve-tickers runs the resolver every 10 min over
-- articles created in the last 30 min.
--
-- All public data, so RLS = public read, like 017.

begin;

-- 1. Turkish fold ------------------------------------------------------------
-- Must stay equivalent to foldTr() in supabase/functions/_shared/kap.ts:
-- aliases are folded there, article text is folded here, and the match is
-- a plain whole-word substring search.

create or replace function public.fold_tr(s text)
returns text
language sql
immutable
strict
as $$
  select trim(regexp_replace(
    lower(translate(s, 'ŞĞÇÖÜİIşğçöüıÂÎÛâîû', 'SGCOUIIsgcouiAIUaiu')),
    '[^a-z0-9]+', ' ', 'g'
  ));
$$;

-- 2. Tables -------------------------------------------------------------------

create table if not exists public.bist_companies (
  kap_member_oid text primary key,
  mkk_member_oid text,
  tickers        text[] not null,
  title          text not null,
  city           text,
  kap_state      text,
  member_type    text,
  shares_traded  boolean not null default false,
  updated_at     timestamptz not null default now()
);
comment on table public.bist_companies is
  'KAP members with a stock code. shares_traded = kapMemberState A and payIslemDurumu 1.';

create table if not exists public.bist_aliases (
  alias  text not null,
  ticker text not null,
  origin text not null default 'manual',
  primary key (alias, ticker)
);
comment on table public.bist_aliases is
  'Folded (fold_tr) name aliases the resolver matches as whole-word substrings. origin: manual | auto.';

create table if not exists public.kap_disclosures (
  disclosure_index     bigint primary key,
  published_at         timestamptz not null,
  kap_title            text,
  stock_codes          text[] not null default '{}',
  related_stocks       text[] not null default '{}',
  disclosure_class     text,
  disclosure_type      text,
  disclosure_category  text,
  subject              text,
  summary              text,
  is_late              boolean,
  year                 text,
  period               text,
  rule_type            text,
  attachment_count     int,
  modify_status        text,
  raw                  jsonb not null,
  created_at           timestamptz not null default now()
);
comment on table public.kap_disclosures is
  'One row per KAP disclosureIndex (members/byCriteria list row). raw keeps the untouched list item.';

create index if not exists kap_disclosures_published_idx
  on public.kap_disclosures (published_at desc);
create index if not exists kap_disclosures_stock_codes_idx
  on public.kap_disclosures using gin (stock_codes);
create index if not exists kap_disclosures_subject_idx
  on public.kap_disclosures (subject);

create table if not exists public.article_tickers (
  article_id uuid not null references public.articles(id) on delete cascade,
  ticker     text not null,
  matched_on text not null,
  created_at timestamptz not null default now(),
  primary key (article_id, ticker)
);
create index if not exists article_tickers_ticker_idx
  on public.article_tickers (ticker);

-- 3. RLS ----------------------------------------------------------------------

alter table public.bist_companies  enable row level security;
alter table public.bist_aliases    enable row level security;
alter table public.kap_disclosures enable row level security;
alter table public.article_tickers enable row level security;

drop policy if exists "public read bist_companies"  on public.bist_companies;
drop policy if exists "public read bist_aliases"    on public.bist_aliases;
drop policy if exists "public read kap_disclosures" on public.kap_disclosures;
drop policy if exists "public read article_tickers" on public.article_tickers;

create policy "public read bist_companies"  on public.bist_companies  for select using (true);
create policy "public read bist_aliases"    on public.bist_aliases    for select using (true);
create policy "public read kap_disclosures" on public.kap_disclosures for select using (true);
create policy "public read article_tickers" on public.article_tickers for select using (true);

-- 4. Alias overrides ----------------------------------------------------------
-- Large caps whose KAP title does not start with the name the press uses.
-- Folded by hand; keep lowercase ASCII. Extend freely, this is the tuning
-- surface for the resolver.

insert into public.bist_aliases (alias, ticker) values
  ('thy', 'THYAO'), ('turk hava yollari', 'THYAO'), ('turkish airlines', 'THYAO'),
  ('is bankasi', 'ISCTR'), ('isbank', 'ISCTR'),
  ('garanti', 'GARAN'), ('garanti bbva', 'GARAN'),
  ('yapi kredi', 'YKBNK'),
  ('halkbank', 'HALKB'), ('halk bankasi', 'HALKB'),
  ('vakifbank', 'VAKBN'), ('vakiflar bankasi', 'VAKBN'),
  ('koc holding', 'KCHOL'),
  ('sabanci holding', 'SAHOL'), ('sabanci', 'SAHOL'),
  ('erdemir', 'EREGL'), ('eregli demir celik', 'EREGL'),
  ('tupras', 'TUPRS'),
  ('bim', 'BIMAS'), ('bim birlesik magazalar', 'BIMAS'),
  ('sisecam', 'SISE'),
  ('aselsan', 'ASELS'),
  ('turkcell', 'TCELL'),
  ('turk telekom', 'TTKOM'),
  ('ford otosan', 'FROTO'),
  ('tofas', 'TOASO'),
  ('pegasus', 'PGSUS'),
  ('emlak konut', 'EKGYO'),
  ('hektas', 'HEKTS'),
  ('koza altin', 'KOZAL'),
  ('koza anadolu', 'KOZAA'),
  ('ipek dogal enerji', 'IPEKE'),
  ('arcelik', 'ARCLK'),
  ('enka', 'ENKAI'),
  ('petkim', 'PETKM'),
  ('sasa', 'SASA'),
  ('dogan holding', 'DOHOL'),
  ('tav', 'TAVHL'), ('tav havalimanlari', 'TAVHL'),
  ('migros', 'MGROS'),
  ('ulker', 'ULKER'),
  ('coca cola icecek', 'CCOLA'),
  ('anadolu efes', 'AEFES'),
  ('vestel', 'VESTL'),
  ('astor', 'ASTOR'),
  ('odas', 'ODAS'),
  ('oyak cimento', 'OYAKC'),
  ('kardemir', 'KRDMD'),
  ('gubretas', 'GUBRF'), ('gubre fabrikalari', 'GUBRF'),
  ('tekfen', 'TKFEN'),
  ('alarko', 'ALARK'),
  ('anadolu grubu', 'AGHOL'),
  ('dogus otomotiv', 'DOAS'),
  ('turk traktor', 'TTRAK'),
  ('otokar', 'OTKAR'),
  ('borusan boru', 'BRSAN'), ('borusan mannesmann', 'BRSAN'),
  ('kontrolmatik', 'KONTR'),
  ('smart gunes', 'SMRTG'),
  ('enerjisa', 'ENJSA'),
  ('aksa enerji', 'AKSEN'),
  ('aksa akrilik', 'AKSA'),
  ('turkiye sigorta', 'TURSG'),
  ('anadolu sigorta', 'ANSGR'),
  ('is yatirim', 'ISMEN'),
  ('girisim elektrik', 'GESAN'),
  ('cimsa', 'CIMSA'),
  ('zorlu enerji', 'ZOREN'),
  ('mavi giyim', 'MAVI'), ('mavi jeans', 'MAVI'),
  ('tskb', 'TSKB'), ('sinai kalkinma bankasi', 'TSKB'),
  ('qnb finansbank', 'QNBFB'),
  ('tab gida', 'TABGD'),
  ('reeder', 'REEDR'),
  ('yeo teknoloji', 'YEOTK')
on conflict do nothing;

-- 5. Resolver -----------------------------------------------------------------
-- Two match paths over articles created in the last p_since:
--   alias: fold_tr(title + description) contains ' <alias> ' (whole word;
--          Turkish suffixes attach with an apostrophe, which fold_tr turns
--          into a space, so "Vestel'in" still hits "vestel").
--   code:  an UPPERCASE 4-6 letter token in the raw text equals a ticker
--          of a shares_traded company.
-- Re-runs are idempotent (on conflict do nothing). Returns rows inserted.
--
-- ponytail: strpos over every alias x every recent article, no index. Fine
-- at ~1k aliases x ~1k articles per 30-min window; move to a tsvector /
-- pg_trgm join if the window ever needs to be days.

create or replace function public.resolve_article_tickers(p_since interval default interval '30 minutes')
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
    where a.created_at >= now() - p_since
  ),
  alias_hits as (
    select r.id as article_id, al.ticker, 'alias:' || al.alias as matched_on
    from recent r
    join public.bist_aliases al on strpos(r.folded, ' ' || al.alias || ' ') > 0
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

-- 6. Views for the backtester -------------------------------------------------

create or replace view public.ticker_attention_daily as
select
  t.ticker,
  (a.published_at at time zone 'Europe/Istanbul')::date as day,
  count(*)                       as articles,
  count(distinct a.source_id)    as sources,
  min(a.published_at)            as first_at
from public.article_tickers t
join public.articles a on a.id = t.article_id
group by 1, 2;

comment on view public.ticker_attention_daily is
  'Per ticker, per Istanbul calendar day: how many articles and distinct outlets mentioned it.';

-- Every article that mentions one of a disclosure's stock codes from 2 days
-- before to 5 days after the disclosure. lag_minutes < 0 = press ran ahead
-- of KAP (leakage), > 0 = press followed.
create or replace view public.disclosure_coverage as
select
  d.disclosure_index,
  t.ticker,
  d.published_at                                       as disclosed_at,
  a.id                                                 as article_id,
  a.source_id,
  a.published_at                                       as article_at,
  round(extract(epoch from (a.published_at - d.published_at)) / 60)::int as lag_minutes,
  t.matched_on
from public.kap_disclosures d
join public.article_tickers t on t.ticker = any (d.stock_codes)
join public.articles a on a.id = t.article_id
where a.published_at between d.published_at - interval '2 days'
                         and d.published_at + interval '5 days';

comment on view public.disclosure_coverage is
  'Articles mentioning a disclosure''s ticker within [-2d, +5d] of the disclosure, with signed lag in minutes.';

commit;

-- 7. pg_cron ------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
  then
    raise notice
      'pg_cron and/or pg_net not installed — skipping kap-drain / resolve-tickers schedule (049_finance_substrate.sql).';
    return;
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key')
     or not exists (select 1 from vault.decrypted_secrets where name = 'functions_base_url')
  then
    raise notice
      'Vault secrets service_role_key / functions_base_url missing — skipping kap-drain schedule. See 038.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'kap-drain') then
    perform cron.unschedule('kap-drain');
  end if;
  if exists (select 1 from cron.job where jobname = 'resolve-tickers') then
    perform cron.unschedule('resolve-tickers');
  end if;

  perform cron.schedule(
    'kap-drain',
    '*/10 * * * *',
    $sql$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/kap-ingest',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      )
    $sql$
  );

  perform cron.schedule(
    'resolve-tickers',
    '*/10 * * * *',
    $sql$ select public.resolve_article_tickers(interval '30 minutes'); $sql$
  );
end
$$;
