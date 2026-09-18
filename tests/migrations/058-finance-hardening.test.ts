import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Tests for the Ekonomi fix pack's SQL worker (pack F, worker A-sql):
//   - supabase/migrations/058_finance_hardening.sql (new)
//   - supabase/migrations/049_finance_substrate.sql (replay-safety edit)
//   - supabase/migrations/050_finance_signals.sql (replay-safety edit)
//
// Two tiers, mirroring tests/migrations/024-028.test.ts:
//
//   1. Always: static assertions on the migration source. These catch a
//      missing REVOKE, a wrong signature, a misordered DROP/CREATE, or a
//      regression in 049/050 without needing Postgres at all.
//
//   2. When `process.env.SUPABASE_LOCAL_URL` is set: connect to that
//      Postgres — intended to be a scratch Supabase branch already migrated
//      through 048 (`supabase db reset` up to that point, or a full branch
//      reset), per the fix pack's own deploy notes — replay 049-058 in
//      order, then exercise the live behaviour the review's DB-01..DB-14 /
//      SEC-01..SEC-03 findings are about. Opting in is binding: a broken
//      connection or a replay failure fails the suite, it does not
//      downgrade to a skipped no-op.
// ---------------------------------------------------------------------------

const SUPABASE_LOCAL_URL = process.env.SUPABASE_LOCAL_URL;
const LIVE = Boolean(SUPABASE_LOCAL_URL);

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

// Slices out one `create or replace function <name>` header (or a bare
// `create function`), or one `create or replace view <name>`, up to its
// body delimiter, so assertions can be scoped instead of matching anywhere
// in a 250-line file. Mirrors tests/migrations/retention-cron.test.ts.
function objectBody(sql: string, marker: string, endMarker = "$$;"): string {
  const start = sql.indexOf(marker);
  expect(start, `expected to find "${marker}"`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(endMarker, start);
  expect(end, `expected to find a "${endMarker}" after "${marker}"`).toBeGreaterThan(start);
  return sql.slice(start, end + endMarker.length);
}

// ---------------------------------------------------------------------------
// Static checks — always run.
// ---------------------------------------------------------------------------

describe("migration 058_finance_hardening.sql (static)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("058_finance_hardening.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("wraps the core DDL in begin/commit", () => {
    // Header comments precede `begin;` (matching every sibling migration's
    // style), so this checks position relative to the first DDL statement
    // rather than the literal start of the file.
    const beginIdx = sql.indexOf("begin;");
    const firstRevokeIdx = sql.indexOf("revoke all on public.finance_signals");
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(firstRevokeIdx).toBeGreaterThan(beginIdx);
    expect(sql).toMatch(/commit;/);
  });

  it("does not touch 055, 056 or 057 (reserved for other packs)", () => {
    expect(sql).not.toMatch(/05[567]_/);
  });

  // -- SEC-01 / DB-05: view grants --------------------------------------------

  it("revokes the four operator views from anon/authenticated and grants them to service_role only", () => {
    for (const view of ["finance_signals", "finance_health", "ml_news_events", "ml_disclosure_events"]) {
      expect(sql).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+public\\.${view}\\s+from\\s+anon,\\s*authenticated`, "i"),
      );
    }
    expect(sql).toMatch(
      /grant\s+select\s+on\s+public\.finance_signals[\s\S]{0,120}to\s+service_role/i,
    );
  });

  it("sets security_invoker = on for all seven finance views", () => {
    const views = [
      "ticker_attention_daily",
      "disclosure_coverage",
      "bist_quote_stats",
      "finance_signals",
      "finance_health",
      "ml_news_events",
      "ml_disclosure_events",
    ];
    for (const view of views) {
      expect(sql).toMatch(
        new RegExp(`alter\\s+view\\s+public\\.${view}\\s+set\\s*\\(\\s*security_invoker\\s*=\\s*on\\s*\\)`, "i"),
      );
    }
  });

  // DBF-01: a bare `create or replace view` resets reloptions to NULL, so
  // `alter view ... set (security_invoker = on)` is only effective for a
  // view that has no LATER `create or replace view` in this same file.
  // This is the check that actually catches the regression without a live
  // database -- the reloptions assertion above only confirms the ALTER
  // text exists somewhere in the file, not that nothing undoes it after.
  it("issues every security_invoker ALTER after the last CREATE OR REPLACE VIEW of that view in this file", () => {
    const views = [
      "ticker_attention_daily",
      "disclosure_coverage",
      "bist_quote_stats",
      "finance_signals",
      "finance_health",
      "ml_news_events",
      "ml_disclosure_events",
    ];
    for (const view of views) {
      const alterRe = new RegExp(
        `alter\\s+view\\s+public\\.${view}\\s+set\\s*\\(\\s*security_invoker\\s*=\\s*on\\s*\\)`,
        "i",
      );
      const alterMatch = alterRe.exec(sql);
      expect(alterMatch, `expected an ALTER VIEW security_invoker for ${view}`).not.toBeNull();
      const alterIdx = alterMatch!.index;

      const createRe = new RegExp(`create\\s+or\\s+replace\\s+view\\s+public\\.${view}\\b`, "gi");
      let createMatch: RegExpExecArray | null;
      while ((createMatch = createRe.exec(sql)) !== null) {
        expect(
          createMatch.index,
          `create or replace view public.${view} at offset ${createMatch.index} appears after its ` +
            `security_invoker ALTER at offset ${alterIdx} -- the CREATE OR REPLACE resets reloptions to NULL`,
        ).toBeLessThan(alterIdx);
      }
    }
  });

  // -- SEC-02 / DB-12: function EXECUTE ----------------------------------------

  it("drops the zero-arg bist_intraday_targets before the one-arg version is created", () => {
    const dropIdx = sql.indexOf("drop function if exists public.bist_intraday_targets();");
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    const createIdx = sql.indexOf("create or replace function public.bist_intraday_targets(p_limit");
    expect(createIdx).toBeGreaterThan(dropIdx);
  });

  it("revokes anon/authenticated/PUBLIC execute (not public alone) and grants service_role on all thirteen finance functions", () => {
    const signatures = [
      "public.fold_tr(text)",
      "public.resolve_article_tickers(interval)",
      "public.resolve_article_tickers_for(uuid[])",
      "public.resolve_article_tickers_trigger()",
      "public.prune_generic_aliases(int, int)",
      "public.prune_bist_bars_5m(int)",
      "public.bist_daily_targets(int)",
      "public.bist_intraday_targets(int)",
      "public.price_at(text, timestamptz)",
      "public.feed_reference_prices(uuid[])",
      "public.bar_returns(text, timestamptz)",
      "public.ticker_articles(text, int)",
      "public.econ_feed(int)",
    ];

    const revokeStart = sql.indexOf("revoke execute on function");
    expect(revokeStart).toBeGreaterThanOrEqual(0);
    const revokeEnd = sql.indexOf("from anon, authenticated, public;", revokeStart);
    expect(revokeEnd).toBeGreaterThan(revokeStart);
    const revokeBlock = sql.slice(revokeStart, revokeEnd);

    const grantStart = sql.indexOf("grant execute on function", revokeEnd);
    expect(grantStart).toBeGreaterThan(revokeEnd);
    const grantEnd = sql.indexOf("to service_role;", grantStart);
    expect(grantEnd).toBeGreaterThan(grantStart);
    const grantBlock = sql.slice(grantStart, grantEnd);

    for (const signature of signatures) {
      expect(revokeBlock, `revoke block missing ${signature}`).toContain(signature);
      expect(grantBlock, `grant block missing ${signature}`).toContain(signature);
    }
  });

  it("revokes bist_intraday_targets(int), econ_feed(int) and prune_bist_bars_5m(int) only after they are created", () => {
    const revokeStart = sql.indexOf("revoke execute on function");
    expect(revokeStart).toBeGreaterThanOrEqual(0);

    const econFeedCreate = sql.indexOf("create or replace function public.econ_feed(");
    const intradayCreate = sql.indexOf("create or replace function public.bist_intraday_targets(p_limit");
    const pruneBarsCreate = sql.indexOf("create or replace function public.prune_bist_bars_5m(");

    expect(econFeedCreate).toBeGreaterThanOrEqual(0);
    expect(intradayCreate).toBeGreaterThanOrEqual(0);
    expect(pruneBarsCreate).toBeGreaterThanOrEqual(0);

    expect(revokeStart).toBeGreaterThan(econFeedCreate);
    expect(revokeStart).toBeGreaterThan(intradayCreate);
    expect(revokeStart).toBeGreaterThan(pruneBarsCreate);
  });

  // -- SEC-03 / SEC-08 / DB-11 / DB-12: trigger --------------------------------

  describe("resolve_article_tickers_trigger()", () => {
    let body = "";
    beforeAll(() => {
      body = objectBody(sql, "create or replace function public.resolve_article_tickers_trigger()");
    });

    it("runs with an empty search_path", () => {
      expect(body).toMatch(/set\s+search_path\s*=\s*''/);
    });

    it("guards the resolver call with a lock_timeout and a catch-all exception handler that still returns NEW", () => {
      // DBF-02: lock_timeout is declared on the function itself (proconfig),
      // not via `set local` in the body -- a body-level `set local` demotes
      // the GUC to a nested level that survives the plpgsql subtransaction
      // and leaks 200ms lock_timeout into the calling (article INSERT)
      // transaction for its remainder. A proconfig entry is correctly
      // saved/restored by the function call itself.
      expect(body).toMatch(/set\s+lock_timeout\s*=\s*'200ms'/i);
      expect(body).not.toMatch(/set\s+local\s+lock_timeout/i);
      expect(body).toMatch(/exception\s+when\s+others\s+then/i);
      expect(body).toMatch(/raise\s+warning/i);
      expect(body).toMatch(/return\s+new;/i);
    });

    it("does not set an actual statement_timeout (would not be caught by WHEN OTHERS, giving false assurance)", () => {
      // The body's own comment explains *why* not, via the phrase "NOT
      // statement_timeout" — so this checks for a real SET statement, not
      // bare word presence.
      expect(body).not.toMatch(/set\s+(local\s+)?statement_timeout\s*=/i);
    });

    it("keeps the SECURITY DEFINER + owner-to-postgres pairing from 051:93-99", () => {
      expect(body).toMatch(/security\s+definer/i);
      expect(sql).toMatch(
        /alter\s+function\s+public\.resolve_article_tickers_trigger\(\)\s+owner\s+to\s+postgres/i,
      );
    });
  });

  // -- DB-01 / DB-09: denormalized timestamp -----------------------------------

  it("adds published_at and source_id to article_tickers, backfills, and enforces NOT NULL only on published_at", () => {
    expect(sql).toMatch(
      /alter\s+table\s+public\.article_tickers\s+add\s+column\s+if\s+not\s+exists\s+published_at\s+timestamptz/i,
    );
    expect(sql).toMatch(
      /alter\s+table\s+public\.article_tickers\s+add\s+column\s+if\s+not\s+exists\s+source_id\s+uuid/i,
    );
    expect(sql).toMatch(
      /update\s+public\.article_tickers\s+t\s*\n?\s*set\s+published_at\s*=\s*a\.published_at,\s*source_id\s*=\s*a\.source_id/i,
    );
    expect(sql).toMatch(
      /alter\s+table\s+public\.article_tickers\s+alter\s+column\s+published_at\s+set\s+not\s+null/i,
    );
    expect(sql).not.toMatch(/alter\s+column\s+source_id\s+set\s+not\s+null/i);
  });

  it("indexes article_tickers on (published_at desc, ticker)", () => {
    expect(sql).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+article_tickers_published_ticker_idx\s+on\s+public\.article_tickers\s*\(\s*published_at\s+desc,\s*ticker\s*\)/i,
    );
  });

  it("rewrites resolve_article_tickers_for to supply published_at and source_id, keeping the 052 sports-desk skip and 4-6 letter code match", () => {
    const body = objectBody(sql, "create or replace function public.resolve_article_tickers_for(p_ids uuid[])");
    expect(body).toMatch(/coalesce\(a\.category,\s*''\)\s*<>\s*'spor'/i);
    expect(body).toMatch(/\\m\(\[A-Z\]\{4,6\}\)\\M/);
    expect(body).toMatch(/a\.published_at/);
    expect(body).toMatch(/a\.source_id/);
    expect(body).toMatch(
      /insert\s+into\s+public\.article_tickers\s*\(\s*article_id,\s*ticker,\s*matched_on,\s*published_at,\s*source_id\s*\)/i,
    );
  });

  it("redefines ticker_attention_daily to aggregate article_tickers alone, with no join back to articles", () => {
    const body = objectBody(sql, "create or replace view public.ticker_attention_daily as", ";");
    expect(body).toMatch(/from\s+public\.article_tickers\s+t\b/i);
    expect(body).not.toMatch(/join\s+public\.articles/i);
    expect(body).toMatch(/t\.published_at/);
  });

  it("redefines disclosure_coverage on the indexable stock_codes containment, keeping BOTH published_at window predicates", () => {
    const body = objectBody(sql, "create or replace view public.disclosure_coverage as", ";");
    expect(body).toMatch(/d\.stock_codes\s*@>\s*array\[t\.ticker\]/i);
    expect(body).toMatch(/t\.published_at\s+between/i);
    expect(body).toMatch(/a\.published_at\s+between/i);
  });

  // -- DB-02: econ_feed RPC -----------------------------------------------------

  it("adds econ_feed(p_limit) driving from article_tickers, with the exact contract worker B reads", () => {
    const body = objectBody(sql, "create or replace function public.econ_feed(");
    expect(body).toMatch(/p_limit\s+int\s+default\s+80/i);
    expect(body).toMatch(
      /returns\s+table\s*\(\s*id\s+uuid,\s*title\s+text,\s*url\s+text,\s*published_at\s+timestamptz,\s*category\s+text,\s*\n?\s*source_name\s+text,\s*source_slug\s+text,\s*tickers\s+text\[\]\s*\)/i,
    );
    expect(body).toMatch(/from\s+public\.article_tickers\s+t\b/i);
    expect(body).toMatch(/group\s+by\s+1\s*\n?\s*order\s+by\s+2\s+desc\s*\n?\s*limit\s+p_limit/i);
    expect(body).toMatch(/join\s+public\.articles\s+a\s+on\s+a\.id\s*=\s*p\.article_id/i);
    expect(body).toMatch(/left\s+join\s+public\.sources\s+s/i);
  });

  // -- DB-04: prune_generic_aliases ---------------------------------------------

  it("hardens prune_generic_aliases: counts distinct articles, protects enabled manual aliases, and deletes by (alias, ticker)", () => {
    const body = objectBody(sql, "create or replace function public.prune_generic_aliases(");
    expect(body).toMatch(/count\(distinct\s+article_id\)\s+as\s+n/i);
    expect(body).toMatch(/having\s+count\(distinct\s+article_id\)\s*>\s*p_max_hits/i);
    expect(body).toMatch(
      /not\s+exists\s*\(\s*select\s+1\s+from\s+public\.bist_aliases\s+m\s*\n?\s*where\s+m\.alias\s*=\s*al\.alias\s+and\s+m\.origin\s*=\s*'manual'\s+and\s+m\.enabled/i,
    );
    expect(body).toMatch(/returning\s+al\.alias,\s*al\.ticker/i);
    expect(body).toMatch(
      /delete\s+from\s+public\.article_tickers\s+t\s*\n?\s*using\s+disabled\s+d\s*\n?\s*where\s+t\.matched_on\s*=\s*'alias:'\s*\|\|\s*d\.alias\s*\n?\s*and\s+t\.ticker\s*=\s*d\.ticker/i,
    );
  });

  // -- TS-02: bist_intraday_targets ---------------------------------------------

  it("bounds bist_intraday_targets to p_limit (default 120), ordered staleness-first so the whole set rotates", () => {
    const body = objectBody(sql, "create or replace function public.bist_intraday_targets(p_limit");
    expect(body).toMatch(/p_limit\s+int\s+default\s+120/i);
    expect(body).toMatch(/left\s+join[\s\S]{0,120}max\(ts\)\s+as\s+last_ts[\s\S]{0,20}from\s+public\.bist_bars_5m/i);
    expect(body).toMatch(/order\s+by\s+b\.last_ts\s+nulls\s+first,\s*t\.ticker/i);
    expect(body).toMatch(/limit\s+p_limit/i);
  });

  // -- DB-06: GIN index + indexable join form -----------------------------------

  it("adds a GIN index on bist_companies(tickers) and swaps finance_signals + ml_disclosure_events to the containment form", () => {
    expect(sql).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+bist_companies_tickers_idx\s+on\s+public\.bist_companies\s+using\s+gin\s*\(\s*tickers\s*\)/i,
    );

    const finance = objectBody(sql, "create or replace view public.finance_signals as", ";");
    expect(finance).toMatch(/bc\.tickers\s*@>\s*array\[c\.ticker\]/i);
    expect(finance).not.toMatch(/c\.ticker\s*=\s*any\s*\(\s*bc\.tickers\s*\)/i);

    const mlDisclosure = objectBody(sql, "create or replace view public.ml_disclosure_events as", ";");
    expect(mlDisclosure).toMatch(/bc\.tickers\s*@>\s*array\[c\.ticker\]/i);
    expect(mlDisclosure).not.toMatch(/c\.ticker\s*=\s*any\s*\(\s*bc\.tickers\s*\)/i);
  });

  it("keeps finance_signals and ml_disclosure_events column lists identical to 050/051 (kind/ticker/score/evidence/observed_at, disclosure_index..pre5)", () => {
    const finance = objectBody(sql, "create or replace view public.finance_signals as", ";");
    expect(finance).toMatch(/'attention_spike'::text\s+as\s+kind/i);
    expect(finance).toMatch(/'silent_disclosure'/i);
    expect(finance).toMatch(/'press_ahead'/i);

    const mlDisclosure = objectBody(sql, "create or replace view public.ml_disclosure_events as", ";");
    expect(mlDisclosure).toMatch(/d\.disclosure_index/i);
    expect(mlDisclosure).toMatch(/r\.entry_day,\s*r\.entry_close,\s*r\.r0,\s*r\.r1,\s*r\.r5,\s*r\.r20,\s*r\.pre5/i);
  });

  // -- DB-07: bist_bars_5m retention ---------------------------------------------

  it("adds prune_bist_bars_5m(keep_days) as SECURITY DEFINER with empty search_path, batched", () => {
    expect(sql).toMatch(
      /create\s+or\s+replace\s+function\s+public\.prune_bist_bars_5m\(\s*keep_days\s+int\s+default\s+90\s*\)/i,
    );
    const body = objectBody(sql, "create or replace function public.prune_bist_bars_5m(");
    expect(body).toMatch(/security\s+definer/i);
    expect(body).toMatch(/set\s+search_path\s*=\s*''/i);
    expect(body).toMatch(/limit\s+5000/i);
    expect(body).toMatch(/for\s+update\s+skip\s+locked/i);
  });

  it("schedules bars-5m-prune as its own cron job at 25 4 * * *, without rewriting prune-nightly's body", () => {
    expect(sql).toMatch(/cron\.schedule\(\s*\n?\s*'bars-5m-prune',\s*\n?\s*'25 4 \* \* \*'/i);
    // DB-07: the function's own default (90) is far beyond any read path --
    // the growth this job fixes was 46 MB / 10 days, so 90 days is a no-op
    // for ~80 nights. The cron call passes 14, the window the read paths
    // (price_at's daily-close fallback) actually justify.
    expect(sql).toMatch(/prune_bist_bars_5m\(14\)/);
    expect(sql).not.toMatch(/select\s+public\.prune_bist_bars_5m\(90\)/);
    // "prune-nightly" may appear in prose (explaining why it's untouched),
    // but 058 must never call cron.schedule/unschedule on that jobname.
    expect(sql).not.toMatch(/cron\.(un)?schedule\(\s*\n?\s*'prune-nightly'/i);
  });

  // -- DB-13: quotes-daily cron ---------------------------------------------------

  it("reschedules quotes-daily to start after the closing auction settles, noting the 051:334 supersession without editing 051", () => {
    expect(sql).toMatch(/'quotes-daily'[\s\S]{0,40}'12-59\/3 15-16 \* \* 1-5'/);
    expect(sql).toMatch(/051:334/);
  });

  // -- DB-14: dead indexes ---------------------------------------------------------

  it("drops the two indexes no query can use", () => {
    expect(sql).toMatch(/drop\s+index\s+if\s+exists\s+public\.kap_disclosures_subject_idx/i);
    expect(sql).toMatch(/drop\s+index\s+if\s+exists\s+public\.article_tickers_ticker_idx/i);
  });

  // -- Idempotency lint --------------------------------------------------------

  it("uses only idempotent DDL forms (if exists / if not exists / or replace) for every table/index/function it defines or drops", () => {
    const bareCreateTable = /create\s+table\s+(?!if\s+not\s+exists)/i;
    const bareCreateIndex = /create\s+index\s+(?!if\s+not\s+exists)/i;
    const bareDropFunction = /drop\s+function\s+(?!if\s+exists)/i;
    const bareDropIndex = /drop\s+index\s+(?!if\s+exists)/i;
    expect(sql).not.toMatch(bareCreateTable);
    expect(sql).not.toMatch(bareCreateIndex);
    expect(sql).not.toMatch(bareDropFunction);
    expect(sql).not.toMatch(bareDropIndex);
  });
});

// ---------------------------------------------------------------------------
// Static checks for the replay-safety edits in 049 and 050 (DB-10).
// ---------------------------------------------------------------------------

describe("migration 049_finance_substrate.sql replay guard (static, DB-10)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("049_finance_substrate.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("still schedules kap-drain and resolve-tickers (the guard must not delete the original schedule calls)", () => {
    expect(sql).toMatch(/cron\.schedule\(\s*\n?\s*'kap-drain'/);
    expect(sql).toMatch(/cron\.schedule\(\s*\n?\s*'resolve-tickers'/);
  });

  it("no-ops the reschedule when a later migration already owns a faster kap-drain cadence", () => {
    const guardIdx = sql.search(
      /if\s+exists\s*\(\s*select\s+1\s+from\s+cron\.job\s*\n?\s*where\s+jobname\s*=\s*'kap-drain'\s+and\s+schedule\s*<>\s*'\*\/10 \* \* \* \*'/i,
    );
    expect(guardIdx).toBeGreaterThanOrEqual(0);

    const raiseNearGuard = sql.slice(guardIdx, guardIdx + 300);
    expect(raiseNearGuard).toMatch(/raise\s+notice/i);
    expect(raiseNearGuard).toMatch(/return;/i);

    // The guard must run before the unconditional unschedule/reschedule.
    const unscheduleIdx = sql.indexOf("cron.unschedule('kap-drain')");
    expect(unscheduleIdx).toBeGreaterThan(guardIdx);
  });
});

describe("migration 050_finance_signals.sql replay guard (static, DB-10)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("050_finance_signals.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("no longer defines finance_health (051 owns it, with 11 columns vs. these original 7)", () => {
    expect(sql).not.toMatch(/create\s+or\s+replace\s+view\s+public\.finance_health/i);
  });

  it("leaves a comment explaining the removal, referencing 051 and the column-drop hazard", () => {
    expect(sql).toMatch(/finance_health/i);
    expect(sql).toMatch(/051/);
    expect(sql).toMatch(/cannot\s+drop\s+columns|replaying|column/i);
  });

  it("still defines finance_signals (only finance_health was removed)", () => {
    expect(sql).toMatch(/create\s+or\s+replace\s+view\s+public\.finance_signals\s+as/i);
  });
});

// ---------------------------------------------------------------------------
// DBF-07: the same ticker-blind DELETE hazard DB-04 fixed inside
// prune_generic_aliases (058) also existed, unfixed, in 052's one-off body.
// bist_aliases' PK is (alias, ticker), so an alias-only predicate deletes
// every ticker sharing a disabled alias string, including a different,
// still-enabled, manual alias row for another ticker. Replay-safety-only
// fix (the statement has already applied in production).
// ---------------------------------------------------------------------------

describe("migration 052_alias_hygiene.sql replay guard (static, DBF-07)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("052_alias_hygiene.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("deletes article_tickers by (alias, ticker), not alias text alone", () => {
    expect(sql).toMatch(
      /delete\s+from\s+public\.article_tickers\s+t\s*\n?\s*using\s+public\.bist_aliases\s+al\s*\n?\s*where\s+t\.matched_on\s*=\s*'alias:'\s*\|\|\s*al\.alias\s+and\s+t\.ticker\s*=\s*al\.ticker\s+and\s+not\s+al\.enabled/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Live integration checks — opt-in via SUPABASE_LOCAL_URL.
//
// Assumes SUPABASE_LOCAL_URL points at a scratch DB already migrated
// through 048 (a `supabase db reset`, or a Supabase branch, per the fix
// pack's own deploy notes). We replay 049-058 ourselves so the DB-10
// regression ("the whole set replays clean end to end") is exercised
// directly, then run the behavioural assertions the review's findings are
// about. No try/catch around setup: a failure here must fail the suite.
// ---------------------------------------------------------------------------

describe.runIf(LIVE)("migrations 049-058 finance hardening (live against SUPABASE_LOCAL_URL)", () => {
  type PgRow = Record<string, unknown>;
  type PgClient = {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: PgRow[] }>;
    end: () => Promise<void>;
    connect: () => Promise<void>;
    on: (event: "notice", cb: (notice: { message?: string }) => void) => void;
  };

  let client!: PgClient;
  const notices: string[] = [];
  let testSourceId = "";

  async function applyMigration(name: string): Promise<void> {
    await client.query(read(name));
  }

  beforeAll(async () => {
    const pgMod = (await import("pg").catch(() => null)) as
      | { Client?: new (opts: unknown) => PgClient }
      | null;
    if (!pgMod?.Client) {
      throw new Error(
        "SUPABASE_LOCAL_URL is set but the 'pg' driver is not installed — " +
          "run npm i -D pg or unset SUPABASE_LOCAL_URL",
      );
    }
    client = new pgMod.Client({ connectionString: SUPABASE_LOCAL_URL });
    client.on("notice", (n) => notices.push(String(n.message ?? "")));
    await client.connect();

    // DB-10 regression: 049-058, in order, against a DB already migrated
    // through 048. If any file errors, this throws and the whole suite
    // fails — deliberately, see the file header.
    const finalPackMigrations = [
      "049_finance_substrate.sql",
      "050_finance_signals.sql",
      "051_finance_bars_and_speed.sql",
      "052_alias_hygiene.sql",
      "053_breaker_tickers_and_aliases.sql",
      "054_ticker_page_perf.sql",
      "058_finance_hardening.sql",
    ];
    for (const name of finalPackMigrations) {
      await applyMigration(name);
    }

    const { rows } = await client.query(
      `insert into public.sources (name, slug, url, rss_url, bias)
       values ('A-sql Test Source', 'a-sql-test-source-058', 'https://example.com', 'https://example.com/rss', 'center')
       on conflict (slug) do update set active = excluded.active
       returning id`,
    );
    testSourceId = String(rows[0]?.id);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
  });

  it("049-058 replayed clean: the finance substrate tables exist", async () => {
    const { rows } = await client.query(
      `select to_regclass('public.article_tickers') is not null as ok`,
    );
    expect(rows[0]?.ok).toBe(true);
  });

  it("058 re-applies a second time without error and leaves row counts unchanged (idempotence)", async () => {
    const before = await client.query(`
      select
        (select count(*)::int from public.bist_aliases) as aliases,
        (select count(*)::int from public.article_tickers) as article_tickers
    `);
    await applyMigration("058_finance_hardening.sql");
    const after = await client.query(`
      select
        (select count(*)::int from public.bist_aliases) as aliases,
        (select count(*)::int from public.article_tickers) as article_tickers
    `);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  describe("SEC-01/DB-05 view grants", () => {
    it("locks anon/authenticated out of the four operator views and sets security_invoker on all seven", async () => {
      const { rows } = await client.query(
        `select relname, relacl::text[] as acl, reloptions::text[] as opts
         from pg_class
         where relnamespace = 'public'::regnamespace
           and relname = any($1)`,
        [
          [
            "finance_signals",
            "finance_health",
            "ml_news_events",
            "ml_disclosure_events",
            "ticker_attention_daily",
            "disclosure_coverage",
            "bist_quote_stats",
          ],
        ],
      );
      expect(rows.length).toBe(7);

      const locked = new Set(["finance_signals", "finance_health", "ml_news_events", "ml_disclosure_events"]);
      for (const row of rows) {
        const opts = (row.opts as string[] | null) ?? [];
        // DBF-03: Postgres stores the reloption verbatim as written --
        // `set (security_invoker = on)` persists as `security_invoker=on`,
        // not `=true`. The old `=true`-only regex never matched any of the
        // seven views and so could never have caught DBF-01.
        expect(opts.some((o) => /security_invoker=(on|true)/.test(o))).toBe(true);

        if (locked.has(String(row.relname))) {
          const acl = (row.acl as string[] | null) ?? [];
          for (const entry of acl) {
            expect(entry).not.toMatch(/^anon=/);
            expect(entry).not.toMatch(/^authenticated=/);
          }
        }
      }
    });
  });

  describe("SEC-02/DB-12 function EXECUTE", () => {
    it("revokes anon/authenticated/PUBLIC execute from all thirteen finance functions", async () => {
      const { rows } = await client.query(
        `select p.proname, p.proacl::text[] as acl, p.prosecdef, p.proconfig::text[] as config
         from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname = any($1)`,
        [
          [
            "fold_tr",
            "resolve_article_tickers",
            "resolve_article_tickers_for",
            "resolve_article_tickers_trigger",
            "prune_generic_aliases",
            "prune_bist_bars_5m",
            "bist_daily_targets",
            "bist_intraday_targets",
            "price_at",
            "feed_reference_prices",
            "bar_returns",
            "ticker_articles",
            "econ_feed",
          ],
        ],
      );
      expect(rows.length).toBeGreaterThanOrEqual(13);

      for (const row of rows) {
        const acl = (row.acl as string[] | null) ?? [];
        for (const entry of acl) {
          expect(entry, `${String(row.proname)} acl entry`).not.toMatch(/^anon=/);
          expect(entry, `${String(row.proname)} acl entry`).not.toMatch(/^authenticated=/);
          expect(entry, `${String(row.proname)} acl entry`).not.toMatch(/^=/);
        }
      }

      const trigger = rows.find((r) => r.proname === "resolve_article_tickers_trigger");
      expect(trigger?.prosecdef).toBe(true);
      const config = (trigger?.config as string[] | null) ?? [];
      expect(config.some((c) => c.startsWith("search_path="))).toBe(true);
    });

    it("bist_intraday_targets() resolves with no arguments (no ambiguous overload), returns <= 120 rows", async () => {
      const { rows } = await client.query("select ticker from public.bist_intraday_targets()");
      expect(rows.length).toBeLessThanOrEqual(120);
      const tickers = rows.map((r) => String(r.ticker));
      const sorted = [...tickers].sort((a, b) => a.localeCompare(b));
      // bist_bars_5m is empty on a fresh replay, so every row ties on
      // last_ts (nulls first) and the tie-break (ticker asc) is the whole
      // order — a direct check that the rotation key is wired correctly.
      expect(tickers).toEqual(sorted);
    });
  });

  describe("SEC-03 resolver exception guard", () => {
    it("an article INSERT still commits even when the resolver faults", async () => {
      notices.length = 0;
      await client.query(`
        create or replace function public.resolve_article_tickers_for(p_ids uuid[])
        returns integer language plpgsql as $$
        begin
          raise exception 'boom (test-injected fault)';
        end;
        $$;
      `);

      const url = `https://example.com/sec-03-${Date.now()}`;
      const { rows } = await client.query(
        `insert into public.articles (title, url, source_id, content_hash, published_at)
         values ('sec-03 fault-injection test', $1, $2, $3, now())
         returning id`,
        [url, testSourceId, "a".repeat(40)],
      );
      expect(rows.length).toBe(1);

      const { rows: check } = await client.query(
        `select count(*)::int as n from public.articles where url = $1`,
        [url],
      );
      expect(check[0]?.n).toBe(1);
      expect(notices.some((n) => /resolve_article_tickers/.test(n))).toBe(true);

      // Restore the real resolver (058 is idempotent, see above).
      await applyMigration("058_finance_hardening.sql");
    });
  });

  describe("DB-04 prune_generic_aliases", () => {
    it("protects an alias sharing text with an enabled manual row, and deletes matches only for the ticker actually disabled", async () => {
      // 'kardemir' -> KRDMD is 049's manual seed. Add three AUTO siblings on
      // the same alias text, then enough distinct-article hits to cross the
      // default p_max_hits (100).
      await client.query(`
        insert into public.bist_aliases (alias, ticker, origin, enabled)
        values ('kardemir', 'KARCL', 'auto', true),
               ('kardemir', 'KRDMA', 'auto', true),
               ('kardemir', 'KRDMB', 'auto', true)
        on conflict (alias, ticker) do update set origin = excluded.origin, enabled = true
      `);

      const articleIds: string[] = [];
      for (let i = 0; i < 110; i++) {
        const { rows } = await client.query(
          `insert into public.articles (title, url, source_id, content_hash, published_at)
           values ($1, $2, $3, $4, now())
           returning id`,
          [`kardemir db-04 test ${i}`, `https://example.com/db04-${Date.now()}-${i}`, testSourceId, "b".repeat(40)],
        );
        articleIds.push(String(rows[0]?.id));
      }

      for (const ticker of ["KARCL", "KRDMA", "KRDMB", "KRDMD"]) {
        for (const id of articleIds) {
          await client.query(
            `insert into public.article_tickers (article_id, ticker, matched_on, published_at, source_id)
             select $1, $2, 'alias:kardemir', a.published_at, a.source_id
             from public.articles a where a.id = $1
             on conflict do nothing`,
            [id, ticker],
          );
        }
      }

      await client.query("select public.prune_generic_aliases(14, 100)");

      const { rows: krdmdRows } = await client.query(
        `select count(*)::int as n from public.article_tickers
         where ticker = 'KRDMD' and matched_on = 'alias:kardemir'`,
      );
      expect(krdmdRows[0]?.n).toBe(110);

      const { rows: aliasRows } = await client.query(
        `select enabled from public.bist_aliases where alias = 'kardemir' and ticker = 'KRDMD' and origin = 'manual'`,
      );
      expect(aliasRows[0]?.enabled).toBe(true);
    });
  });

  describe("DB-01 / DB-02 / DB-06 query shape", () => {
    it("ticker_attention_daily's plan never touches articles, and runs well under the old 8s cap", async () => {
      const { rows } = await client.query(
        `explain (analyze, timing off, summary on)
         select ticker, day, articles, sources from public.ticker_attention_daily
         where day >= current_date - 7`,
      );
      const plan = rows.map((r) => String(r["QUERY PLAN"])).join("\n");
      expect(plan.toLowerCase()).not.toMatch(/articles_pkey/);
      expect(plan.toLowerCase()).not.toMatch(/on public\.articles/);
      const timeMatch = plan.match(/Execution Time:\s*([\d.]+)\s*ms/i);
      expect(timeMatch).not.toBeNull();
      expect(Number(timeMatch?.[1])).toBeLessThan(500);
    });

    it("econ_feed(80) drives from article_tickers, not a seq scan over articles", async () => {
      const { rows } = await client.query(
        `explain (analyze, timing off, summary on) select * from public.econ_feed(80)`,
      );
      const plan = rows
        .map((r) => String(r["QUERY PLAN"]))
        .join("\n")
        .toLowerCase();
      expect(plan).toMatch(/article_tickers/);
      expect(plan).not.toMatch(/seq scan on articles/);
    });

    it("finance_signals' bist_companies leg can use bist_companies_tickers_idx (GIN), forcing the planner off seq scan", async () => {
      await client.query("set enable_seqscan = off");
      try {
        const { rows } = await client.query(
          `explain select * from public.finance_signals order by score desc limit 120`,
        );
        const plan = rows
          .map((r) => String(r["QUERY PLAN"]))
          .join("\n")
          .toLowerCase();
        expect(plan).toMatch(/bist_companies_tickers_idx/);
      } finally {
        await client.query("set enable_seqscan = on");
      }
    });
  });
});
