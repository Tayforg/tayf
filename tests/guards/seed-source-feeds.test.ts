import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt 33, h33-ops-1 / h33-ops-2): the feed URLs that
// supabase/seed_sources.sql carries for two sources whose old feed was wrong.
//
//   bianet        The seed pointed at https://bianet.org/biamag.rss, the weekly
//                 MAGAZINE feed (every pubDate is a Saturday, about 10 items a
//                 week). The all-news feed is https://bianet.org/rss/bianet
//                 (about 30 items a day). The old URL answers 304 with a fail
//                 streak of 0, so no ops row ever flags it: valid but stale.
//   medya-gazete  The seed pointed at https://www.medyagazete.com/rss/genel-0,
//                 a path that moved (404 since 2026-10-25). The working feed on
//                 the same host is https://www.medyagazete.com/rss.xml.
//
// The seed ends in `on conflict (slug) do update set rss_url = excluded.rss_url`,
// so re-running it would write whatever URL it carries over production's. The
// seed must therefore never carry the stale URLs. The production rows are
// repointed by the founder SQL in docs/feed-registry-2026-09.md (section 8),
// not by a migration.
//
// The research CSV ('turkish_news_rss_database_v2.xlsx - All News Outlets.csv')
// is the seed's stated source ("Source: turkish_news_rss_database_v2.xlsx"), so
// its Bianet row must agree with the seed.
//
// Parsed with a small field scanner (quoted strings with '' escapes), not a
// regular expression over SQL text (the CodeQL rules of this repo).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const SEED = resolve(ROOT, "supabase", "seed_sources.sql");
const CSV = resolve(ROOT, "turkish_news_rss_database_v2.xlsx - All News Outlets.csv");

const REGISTRY_DOC = resolve(ROOT, "docs", "feed-registry-2026-09.md");
const MIGRATIONS = resolve(ROOT, "supabase", "migrations");

const BIANET_FEED = "https://bianet.org/rss/bianet";
const MEDYA_GAZETE_FEED = "https://www.medyagazete.com/rss.xml";

interface SeedRow {
  name: string;
  slug: string;
  url: string;
  rssUrl: string;
}

/** The single-quoted SQL string literals of one line, in order ('' is an escaped quote). */
function quotedFields(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "'") {
      i++;
      continue;
    }
    let value = "";
    i++;
    for (;;) {
      if (i >= line.length) return out; // unterminated: ignore the tail
      const ch = line[i] as string;
      if (ch === "'") {
        if (line[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        i++;
        break;
      }
      value += ch;
      i++;
    }
    out.push(value);
  }
  return out;
}

/** Seed value rows: lines of the form `  ('Name', 'slug', 'url', 'rss_url', 'bias', 'kind', true),`. */
function parseSeed(sql: string): SeedRow[] {
  const rows: SeedRow[] = [];
  for (const raw of sql.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("('")) continue;
    const fields = quotedFields(line);
    if (fields.length < 6) continue;
    rows.push({
      name: fields[0] as string,
      slug: fields[1] as string,
      url: fields[2] as string,
      rssUrl: fields[3] as string,
    });
  }
  return rows;
}

/** One CSV record's cells (RFC 4180 quoting, enough for this file). */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

function csvRowsByOutlet(csv: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = csv.split("\n").filter((l) => l.trim() !== "");
  for (const line of lines.slice(1)) {
    const cells = csvCells(line);
    const outlet = cells[1];
    if (outlet !== undefined) out.set(outlet, cells);
  }
  return out;
}

const seedSql = readFileSync(SEED, "utf8");
const seedRows = parseSeed(seedSql);
const bySlug = (slug: string): SeedRow | undefined => seedRows.find((r) => r.slug === slug);

describe("seed_sources.sql feed URLs (h33-ops-1, h33-ops-2)", () => {
  it("parses the seed (the scan is not vacuous)", () => {
    expect(seedRows.length).toBeGreaterThanOrEqual(140);
    expect(new Set(seedRows.map((r) => r.slug)).size).toBe(seedRows.length);
    for (const r of seedRows) expect(r.rssUrl, r.slug).toMatch(/^https?:\/\//);
  });

  it("bianet is ingested from its all-news feed, not the weekly magazine feed", () => {
    expect(bySlug("bianet")?.rssUrl).toBe(BIANET_FEED);
  });

  it("medya-gazete is ingested from the feed that works on its host", () => {
    expect(bySlug("medya-gazete")?.rssUrl).toBe(MEDYA_GAZETE_FEED);
  });

  it("no seed row points at a biamag (weekly magazine) feed", () => {
    expect(seedRows.filter((r) => r.rssUrl.toLowerCase().includes("biamag")).map((r) => r.slug)).toEqual([]);
    expect(seedSql.toLowerCase()).not.toContain("biamag");
  });

  it("no other seed row uses a bianet.org feed (a duplicate would double-ingest)", () => {
    const isBianetHost = (url: string): boolean => {
      try {
        const host = new URL(url).hostname.toLowerCase();
        return host === "bianet.org" || host.endsWith(".bianet.org");
      } catch {
        return false;
      }
    };
    expect(seedRows.filter((r) => isBianetHost(r.rssUrl)).map((r) => r.slug)).toEqual(["bianet"]);
  });

  it("the research CSV row for Bianet carries the same feed URL as the seed", () => {
    const row = csvRowsByOutlet(readFileSync(CSV, "utf8")).get("Bianet");
    expect(row, "CSV has a Bianet row").toBeDefined();
    expect(row?.[2]).toBe(bySlug("bianet")?.rssUrl);
    expect(row?.[2]).toBe(BIANET_FEED);
  });
});

// ---------------------------------------------------------------------------
// The founder SQL. Production's rows are repointed by hand (a data-rewriting
// migration is out of bounds), so the statements live in the registry doc as
// fenced sql blocks. docs/*.md sql blocks are scanned by docs-sql-snippets for
// cron / pgmq mistakes only; the column names are checked HERE against the
// migrations that add them.
// ---------------------------------------------------------------------------

interface FounderUpdate {
  slug: string;
  assignments: Map<string, string>;
}

/** The fenced sql blocks of the "## 8." section of the registry doc. */
function section8SqlBlocks(doc: string): string[] {
  const start = doc.indexOf("\n## 8.");
  if (start < 0) return [];
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of doc.slice(start).split("\n")) {
    const trimmed = line.trim();
    if (current === null) {
      if (trimmed === "```sql") current = [];
    } else if (trimmed === "```") {
      blocks.push(current.join("\n"));
      current = null;
    } else current.push(line);
  }
  return blocks;
}

/** `update public.sources set a = x, b = y where slug = 'z'` statements, parsed with string operations. */
function founderUpdates(blocks: string[]): FounderUpdate[] {
  const out: FounderUpdate[] = [];
  for (const block of blocks) {
    const code = block
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join(" ")
      .replace(/\s+/g, " ");
    for (const stmt of code.split(";")) {
      const text = stmt.trim();
      const lower = text.toLowerCase();
      if (!lower.startsWith("update public.sources set ")) continue;
      const whereAt = lower.lastIndexOf(" where ");
      if (whereAt < 0) continue;
      const setList = text.slice("update public.sources set ".length, whereAt);
      const condition = text.slice(whereAt + " where ".length).trim();
      const slugPrefix = "slug = '";
      if (!condition.toLowerCase().startsWith(slugPrefix) || !condition.endsWith("'")) continue;
      const slug = condition.slice(slugPrefix.length, -1);
      const assignments = new Map<string, string>();
      for (const part of setList.split(",")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        assignments.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
      }
      out.push({ slug, assignments });
    }
  }
  return out;
}

/** Every migration's text, lower-cased, joined: the columns added to public.sources are found in it. */
function migrationsText(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(resolve(MIGRATIONS, f), "utf8").toLowerCase())
    .join("\n");
}

describe("founder SQL in docs/feed-registry-2026-09.md section 8 (h33-ops-1, h33-ops-2)", () => {
  const doc = readFileSync(REGISTRY_DOC, "utf8");
  const updates = founderUpdates(section8SqlBlocks(doc));
  const updateOf = (slug: string): FounderUpdate | undefined => updates.find((u) => u.slug === slug);

  it("records one update per repointed slug, each a bounded `where slug = ...` statement", () => {
    expect(updates.map((u) => u.slug).sort()).toEqual(["bianet", "medya-gazete"]);
  });

  it("bianet: new rss_url and a reset of every fetch validator, so the next cycle fetches unconditionally", () => {
    const a = updateOf("bianet")?.assignments;
    expect(a?.get("rss_url")).toBe(`'${BIANET_FEED}'`);
    for (const col of ["fetch_etag", "fetch_last_modified", "fetch_body_hash", "fetch_items_count"]) {
      expect(a?.get(col), col).toBe("null");
    }
    expect([...(a?.keys() ?? [])].sort()).toEqual(
      ["fetch_body_hash", "fetch_etag", "fetch_items_count", "fetch_last_modified", "rss_url"].sort(),
    );
  });

  it("medya-gazete: the same reset plus the fail streak and the quarantine (or the row is skipped until it expires)", () => {
    const a = updateOf("medya-gazete")?.assignments;
    expect(a?.get("rss_url")).toBe(`'${MEDYA_GAZETE_FEED}'`);
    for (const col of ["fetch_etag", "fetch_last_modified", "fetch_body_hash", "fetch_items_count", "fetch_quarantined_until"]) {
      expect(a?.get(col), col).toBe("null");
    }
    expect(a?.get("fetch_fail_streak")).toBe("0");
    expect(a?.size).toBe(7);
  });

  it("the URLs in the founder SQL are the ones the seed carries", () => {
    expect(updateOf("bianet")?.assignments.get("rss_url")).toBe(`'${bySlug("bianet")?.rssUrl}'`);
    expect(updateOf("medya-gazete")?.assignments.get("rss_url")).toBe(`'${bySlug("medya-gazete")?.rssUrl}'`);
  });

  it("every assigned column exists on public.sources (added by a migration)", () => {
    const migrations = migrationsText();
    const columns = new Set<string>();
    for (const u of updates) for (const col of u.assignments.keys()) columns.add(col);
    expect(columns.size).toBeGreaterThanOrEqual(7);
    for (const col of columns) {
      if (col === "rss_url") continue; // the original table definition
      expect(migrations, `no migration adds sources.${col}`).toMatch(
        new RegExp(`add column(?: if not exists)? ${col}\\b`),
      );
    }
    expect(migrations).toContain("rss_url");
  });

  it("neither slug is added to ops_dark_source_baseline (a repointed feed must leave sources_newly_dark, not be acknowledged)", () => {
    const sqlBlocks = section8SqlBlocks(doc).join("\n").toLowerCase();
    expect(sqlBlocks).not.toContain("ops_dark_source_baseline");
    expect(doc).toContain("Do NOT add");
  });
});

describe("seed_sources.sql scanner self-tests", () => {
  it("reads quoted fields with '' escapes and ignores everything outside quotes", () => {
    expect(quotedFields("  ('O''Brien', 'o-brien', 'https://x', 'https://x/rss', 'center', 'outlet', true),")).toEqual([
      "O'Brien",
      "o-brien",
      "https://x",
      "https://x/rss",
      "center",
      "outlet",
    ]);
    expect(quotedFields("('open")).toEqual([]);
  });

  it("parses value rows only and skips comments and the conflict clause", () => {
    const sql = [
      "insert into sources (name, slug) values",
      "  -- Gov ('not', 'a', 'row', 'at', 'all', 'x', true)",
      "  ('A', 'a', 'https://a', 'https://a/rss', 'center', 'outlet', true),",
      "  ('B', 'b', 'https://b', 'https://b/biamag.rss', 'center', 'outlet', false)",
      "on conflict (slug) do update set rss_url = excluded.rss_url;",
    ].join("\n");
    expect(parseSeed(sql).map((r) => [r.slug, r.rssUrl])).toEqual([
      ["a", "https://a/rss"],
      ["b", "https://b/biamag.rss"],
    ]);
  });

  it("reads CSV cells with quoted commas and doubled quotes", () => {
    expect(csvCells('1,"Outlet, The",https://x/rss,"say ""hi""",Active')).toEqual([
      "1",
      "Outlet, The",
      "https://x/rss",
      'say "hi"',
      "Active",
    ]);
  });

  it("parses founder updates, skipping comments and statements without a slug bound", () => {
    const sql = [
      "-- update public.sources set rss_url = 'x' where slug = 'commented';",
      "update public.sources",
      "   set rss_url = 'https://a/rss', fetch_etag = null, fetch_fail_streak = 0",
      " where slug = 'a';",
      "update public.sources set rss_url = 'https://b/rss';",
      "select 1;",
    ].join("\n");
    expect(founderUpdates([sql])).toEqual([
      {
        slug: "a",
        assignments: new Map([
          ["rss_url", "'https://a/rss'"],
          ["fetch_etag", "null"],
          ["fetch_fail_streak", "0"],
        ]),
      },
    ]);
  });
});

