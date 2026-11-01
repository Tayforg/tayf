import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
// Real (unmocked) normalizer — used only to pre-compute the exact
// content_hash a fixture item will get, so the migration-041 F2 test below
// can seed `existingArticleHashPairs` with a value the SUT will actually
// produce, instead of a hand-picked string that happens to never collide.
import {
  canonicalizeUrl,
  normalizeArticles,
} from "../../supabase/functions/_shared/rss/normalize.ts";
import { sourceArticleKeyFor } from "../../supabase/functions/_shared/rss/article-key.ts";

// ---------------------------------------------------------------------------
// Contract tests for the ingest Edge Function (audit T7 P1-22 verification).
//
// The headline test in this file — "decodes a CP1254 (iso-8859-9) Turkish
// feed without mojibake" — is the mandatory regression check for the
// charset bug the audit caught: the old `res.text()` path silently fell
// back to UTF-8 and corrupted Turkish characters (ş, ı, ğ, ç, ö, ü).
//
// We exercise the contract at three levels:
//
//   1. The pure helper (`decodeRssBody`) if it can be
//      imported standalone — the cheapest, most diagnostic-friendly check.
//   2. The whole `ingest` handler invoked end-to-end against a `fetch`
//      stub that yields the CP1254 fixture — proves the full pipeline
//      doesn't lose the decoded characters between fetcher → normalizer →
//      Supabase upsert.
//   3. SSRF / safety guards (rejecting feeds whose URL resolves into
//      RFC1918 / 169.254 space) — the real guard now lives IN `fetchFeed`
//      itself (SEC-01: fetchFeed routes through the shared `safeResponse`
//      primitive, the same one the og-image path uses) and is covered
//      directly, against the real fetcher module, in fetcher.test.ts. This
//      file only proves that a guard rejection (`fetchFeed` returning
//      `{ status: 0, error }`) propagates correctly through the mocked
//      fetcher into the ingest cycle's fetch-state write and failure count.
//
// All Supabase + pgmq surfaces are mocked. No network. No live feeds.
// ---------------------------------------------------------------------------

// Polyfill Deno before importing the SUT.
(globalThis as unknown as { Deno?: unknown }).Deno = {
  env: { get: (k: string) => process.env[k] },
  serve: (handler: (req: Request) => Promise<Response> | Response) => {
    (globalThis as unknown as { __ingestHandler?: unknown }).__ingestHandler = handler;
    return { finished: Promise.resolve() };
  },
};

// Service-role bearer mirrored into `SUPABASE_SERVICE_ROLE_KEY` in
// `beforeEach`. The `requireServiceRoleBearer` gate in the handler reads the
// env var via the Deno polyfill and compares it to the inbound Authorization
// header. Every authorised `new Request(...)` is built via `authedRequest(...)`
// so the gate accepts the call; the dedicated 401 test below intentionally
// bypasses this helper.
const TEST_SERVICE_ROLE_KEY = "test-service-role-key";

function authedRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${TEST_SERVICE_ROLE_KEY}`,
    },
  });
}

// ---------------------------------------------------------------------------
// CP1254 fixture
//
// Turkish source line — every character that differs from ISO-8859-1 /
// UTF-8 single-byte is exercised: ş (0xFE), ı (0xFD), ğ (0xF0), ç (0xE7),
// ö (0xF6), ü (0xFC), İ (0xDD), Ş (0xDE).
//
// We hand-assemble the bytes rather than calling `iconv-lite` so the
// fixture is self-contained and CI doesn't need a third-party encoder
// installed just to run this test.
// ---------------------------------------------------------------------------

const CP1254_BYTES = new Uint8Array([
  0x3c, 0x3f, 0x78, 0x6d, 0x6c, 0x20, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f,
  0x6e, 0x3d, 0x22, 0x31, 0x2e, 0x30, 0x22, 0x20, 0x65, 0x6e, 0x63, 0x6f,
  0x64, 0x69, 0x6e, 0x67, 0x3d, 0x22, 0x69, 0x73, 0x6f, 0x2d, 0x38, 0x38,
  0x35, 0x39, 0x2d, 0x39, 0x22, 0x3f, 0x3e, 0x0a, // <?xml version="1.0" encoding="iso-8859-9"?>
  0x3c, 0x72, 0x73, 0x73, 0x3e, 0x3c, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65,
  0x6c, 0x3e, // <rss><channel>
  0x3c, 0x69, 0x74, 0x65, 0x6d, 0x3e, // <item>
  0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, // <title>
  // Body bytes for: "Türkçe başlık: şirin İğne çağı"
  0x54, 0xfc, 0x72, 0x6b, 0xe7, 0x65, 0x20, 0x62, 0x61, 0xfe, 0x6c, 0xfd,
  0x6b, 0x3a, 0x20, 0xfe, 0x69, 0x72, 0x69, 0x6e, 0x20, 0xdd, 0xf0, 0x6e,
  0x65, 0x20, 0xe7, 0x61, 0xf0, 0xfd,
  0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, // </title>
  0x3c, 0x6c, 0x69, 0x6e, 0x6b, 0x3e, 0x68, 0x74, 0x74, 0x70, 0x73, 0x3a,
  0x2f, 0x2f, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x63, 0x6f,
  0x6d, 0x2f, 0x61, 0x31, 0x3c, 0x2f, 0x6c, 0x69, 0x6e, 0x6b, 0x3e, // <link>https://example.com/a1</link>
  0x3c, 0x2f, 0x69, 0x74, 0x65, 0x6d, 0x3e, // </item>
  0x3c, 0x2f, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c, 0x3e, 0x3c, 0x2f,
  0x72, 0x73, 0x73, 0x3e, // </channel></rss>
]);

const EXPECTED_TITLE = "Türkçe başlık: şirin İğne çağı";

// ---------------------------------------------------------------------------
// Mock collaborators.
// ---------------------------------------------------------------------------

const upserted: Array<Record<string, unknown>> = [];

// Rows the SUT writes to `ingest_cycles` (migration 039's best-effort
// per-cycle telemetry row — supabase/functions/ingest/index.ts's
// `recordIngestCycle`). Tracked the same way `upserted` tracks `articles`.
const ingestCycleInserts: Array<Record<string, unknown>> = [];

// When set, the "sources" branch of `settle()` below returns this as a
// Supabase `error` instead of the fake roster — used to exercise the
// `runCycleBody` failure path (the `sourcesError` throw) and confirm
// `ingest_cycles` still gets a row via the `finally` in `runCycle`.
let forcedSourcesError: string | null = null;

// Rows the SUT writes to `sources` via `persistSourceFetchState` (migration
// 041's best-effort per-cycle fetch-validator write). One entry per
// `.rpc("ingest_set_source_fetch_state", ...)` call — and, as a regression
// tripwire, per `.from("sources").upsert(...)` call, which the real DB
// rejects with 23502 (NOT NULL on name/slug/... is checked before the ON
// CONFLICT arbiter) — so the tests can assert both the call count (exactly
// one per cycle) and that it went through the RPC.
const sourceFetchStateWrites: Array<{
  fn: string;
  rows: Array<Record<string, unknown>>;
}> = [];

// Simulates rows that already exist in `articles` from a previous cycle —
// seeded by the migration-041 F2 test to reproduce the production 23505:
// a row sharing (source_id, content_hash) with an ALREADY-STORED article
// under a different url. The pre-filter lookup
// (the pairwise `existing_source_content_hash_pairs` RPC, or its legacy
// `.in().in()` fallback) reads this; `.from("articles").upsert(...)`
// simulates the real UNIQUE-constraint failure when a call's payload still
// contains a colliding pair, so the test can prove the fix drops the row
// BEFORE that call rather than relying on (and retrying through) the
// per-row fallback.
let existingArticleHashPairs: Array<{ source_id: string; content_hash: string }> = [];

// ingest-health: when set, `.from("articles").upsert(rows)` fails whenever
// `rows` contains an item whose `url` equals this value — independent of
// the (source_id, content_hash) collision mechanism above, so a test can
// exercise `upsertWithBisect`'s isolation directly.
let forcedPoisonedUrl: string | null = null;

// One entry per `.from("articles").upsert(rows, opts)` call this test made
// — lets the migration-041 F2 test assert the offending row never reaches
// an upsert call at all (batched OR per-row fallback), not just that it's
// absent from `upserted`.
const articlesUpsertCalls: Array<Array<Record<string, unknown>>> = [];

// Simulates rows currently stored in `articles`, keyed by url — read by
// `recordTitleVersions`'s `select(...).in("url", urls)` lookup (migration
// 056). Distinct from `existingArticleHashPairs` above: that map backs the
// (source_id, content_hash) lookup `dropExistingSourceContentHashRows`
// makes against the SAME `articles` table; this one backs the
// (url -> {id, title, source_id}) lookup `recordTitleVersions` makes. The
// mock tells the two apart by which column the SUT's `.in(...)` call used
// ("url" vs "source_id"/"content_hash"), not by call order, so both
// helpers can run against the same chunk without one starving the other's
// fixture.
let storedArticlesByUrl: Record<
  string,
  { id: string; title: string; source_id: string }
> = {};

// When set, the url-keyed `articles` lookup above returns this as a
// Supabase `error` instead of reading `storedArticlesByUrl` — proves
// `recordTitleVersions` degrades to a no-op (returns 0, never throws) on a
// lookup failure, same discipline as `dropExistingSourceContentHashRows`.
let forcedTitleLookupError: string | null = null;

// When set, `.from("article_title_versions").insert(...)` returns this as
// an error instead of recording the rows — proves `recordTitleVersions`
// degrades to a no-op on an insert failure too.
let forcedTitleVersionInsertError: string | null = null;

// One entry per `.from("articles").select(...).in("url", urls)` call this
// test made — lets the tests assert the lookup is bounded to exactly the
// chunk's urls (length equality) and happens exactly once per chunk.
const articlesUrlLookupCalls: Array<{ urls: string[] }> = [];

// One entry per `.from("article_title_versions").upsert(rows, opts)` call
// this test made — lets the tests assert exactly one upsert call carrying
// every changed row in a chunk, not one call per changed row. (Named
// "InsertCalls" for history: the SUT used a plain `.insert(...)` here
// before MF-02 switched it to an `.upsert(..., { ignoreDuplicates: true })`
// keyed on (article_id, new_title_hash) so a headline that stays changed
// across cycles is recorded once, not every cycle.)
const titleVersionInsertCalls: Array<Array<Record<string, unknown>>> = [];

// Simulates the migration-056 unique index on (article_id, new_title_hash)
// combined with the SUT's `ignoreDuplicates: true`: a pair already
// "recorded" (in this test, keyed on article_id + new_title, standing in
// for the real md5(new_title) hash) returns no row on a repeat call,
// exactly like the DB silently no-opping a duplicate upsert.
const recordedTitleVersionKeys = new Set<string>();

// One entry per `.rpc("apply_article_title_edits", { p_rows })` call this
// test made -- migration 074's headline write-back (decision (b): write the
// outlet's CURRENT headline back into `articles.title` at ingest, guarded
// only in SQL by word-Jaccard >= 0.2; TS sends every same-source change).
const titleEditRpcCalls: Array<Array<Record<string, unknown>>> = [];
// When set, the `apply_article_title_edits` RPC above returns this as an
// error -- proves the write-back is swallowed (never throws, never touches
// the article upsert or the cycle's response).
let forcedTitleEditRpcError: string | null = null;

// When set, the "ingest_cycles" `insert()` mock below returns this as an
// error instead of recording the row — used to prove `recordIngestCycle`'s
// try/catch absorbs a telemetry-write failure instead of failing the cycle.
let forcedIngestCyclesInsertError: string | null = null;

// One entry per `.rpc("existing_source_content_hash_pairs", { p_source_ids,
// p_hashes })` call this test made -- the chunked (source_id, content_hash)
// pre-filter lookup (`dropExistingSourceContentHashRowsChunk`, migration
// 074 §4, made pairwise by migration 130). `sourceIds` and `hashes` are the
// RPC's two arrays exactly as sent (index-aligned per-row pairs, NOT deduped
// sets). Lets the tests assert both the number of chunks (rows-per-chunk
// = PREFILTER_CHUNK = 100) and, via `forcedPrefilterErrorOnCall`, that a
// single failing chunk degrades only itself.
const prefilterLookupCalls: Array<{ sourceIds: string[]; hashes: string[] }> = [];
// 1-indexed call number (into `prefilterLookupCalls`) that should fail --
// null means never fail.
let forcedPrefilterErrorOnCall: number | null = null;
// Migration 130 not applied yet: PostgREST answers the RPC with PGRST202
// (function not in the schema cache) and ingest must fall back to the legacy
// `.in("source_id", ...).in("content_hash", ...)` probe.
let forcedPrefilterRpcMissing = false;
// The RPC call itself rejects (network down, not a PostgREST error object).
let forcedPrefilterRpcThrow = false;
// One entry per legacy cross-product probe (`.from("articles").select(
// "source_id, content_hash").in("source_id", ...).in("content_hash", ...)`),
// reached only through the PGRST202 fallback (`legacyExistingPairsProbe`).
const legacyPrefilterLookupCalls: Array<{ sourceIds: string[]; hashes: string[] }> = [];

// Twin-articles (migration 113): rows "stored" in `articles` that carry a
// source_article_key, read by `dropExistingSourceArticleKeyRows`'s
// `select("id, url, title, source_id, source_article_key, created_at")
// .in("source_id", ids).in("source_article_key", keys).gte("created_at", since)`.
// The mock tells that lookup apart from the other two `articles` reads by its
// `.in("source_article_key", ...)` call, and answers like the real table does:
// every stored row whose source_id AND key are in the two lists (a cross
// product, not a pairwise match -- the SUT must check exact pairs itself) and
// whose created_at is >= the gte value.
type StoredKeyRow = {
  id: string;
  url: string;
  title: string;
  source_id: string;
  source_article_key: string;
  created_at?: string;
};
let storedArticlesByKey: StoredKeyRow[] = [];
// When set, the key lookup returns this as a Supabase `error`.
let forcedKeyLookupError: string | null = null;
// When true, the key lookup throws instead of returning an envelope.
let forcedKeyLookupThrow = false;
// One entry per key lookup this test made.
const keyLookupCalls: Array<{
  sourceIds: string[];
  keys: string[];
  gte: Array<{ column: string; value: unknown }>;
  order: Array<{ column: string; ascending: boolean }>;
  limit: number | null;
}> = [];
// Every `.gte(column, value)` call on an `articles` query this test made.
const articlesGteCalls: Array<{ column: string; value: unknown }> = [];

// Per-test source roster. The ingest handler reads from `sources` via
// `.from("sources").select(...).eq("active", true).order("slug")` and
// awaits the chain directly — so the chainable mock terminates via `then`.
// Tests that exercise the end-to-end ingest path populate this list with
// a single source pointing at the fixture URL.
const fakeSources: Array<Record<string, unknown>> = [];

// Counts the title-similarity comparisons the SUT makes (both the string form
// and the pre-tokenized set form), so the twin gate's CPU bound is asserted as
// a number of calls, not as a flaky wall-clock figure. The real functions
// still run.
const jaccardWork = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../supabase/functions/_shared/rss/title-jaccard.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../supabase/functions/_shared/rss/title-jaccard.ts")>();
  return {
    ...actual,
    titleWordJaccard: (a: string | null | undefined, b: string | null | undefined) => {
      jaccardWork.calls++;
      return actual.titleWordJaccard(a, b);
    },
    jaccardOfSets: (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
      jaccardWork.calls++;
      return actual.jaccardOfSets(a, b);
    },
  };
});

// Counts the strictFingerprint calls the SUT makes. normalize.ts calls it once
// per item that reaches the heavy (complete) phase and nowhere else, so the
// number is "items that were fully normalised". The real function still runs.
// Reset in beforeEach; read it BEFORE a test calls normalizeArticles itself.
const heavyWork = vi.hoisted(() => ({ fingerprints: 0 }));
vi.mock("../../supabase/functions/_shared/cluster/fingerprint.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../supabase/functions/_shared/cluster/fingerprint.ts")>();
  return {
    ...actual,
    strictFingerprint: (a: string | null | undefined, b: string | null | undefined) => {
      heavyWork.fingerprints++;
      return actual.strictFingerprint(a, b);
    },
  };
});

vi.mock("../../supabase/functions/_shared/supabase.ts", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      // Captured per `.from(table)` call so two concurrent query shapes
      // against the same table (the (source_id, content_hash) lookup vs
      // the url-keyed title-version lookup, both against `articles`) never
      // bleed into each other.
      const inCalls: Array<{ column: string; values: unknown[] }> = [];
      const gteCalls: Array<{ column: string; value: unknown }> = [];
      const orderCalls: Array<{ column: string; ascending: boolean }> = [];
      let limitCall: number | null = null;
      const settle = () => {
        if (table === "sources") {
          if (forcedSourcesError) {
            return { data: null, error: { message: forcedSourcesError } };
          }
          return { data: [...fakeSources], error: null };
        }
        if (table === "articles") {
          const urlIn = inCalls.find((c) => c.column === "url");
          if (urlIn) {
            // `recordTitleVersions`'s bounded lookup (migration 056):
            // `select("id, url, title, source_id").in("url", urls)`.
            const urls = urlIn.values as string[];
            articlesUrlLookupCalls.push({ urls: [...urls] });
            if (forcedTitleLookupError) {
              return { data: null, error: { message: forcedTitleLookupError } };
            }
            const rows = urls
              .map((url) => {
                const stored = storedArticlesByUrl[url];
                return stored
                  ? { id: stored.id, url, title: stored.title, source_id: stored.source_id }
                  : null;
              })
              .filter((r): r is { id: string; url: string; title: string; source_id: string } =>
                r !== null,
              );
            return { data: rows, error: null };
          }
          // `dropExistingSourceArticleKeyRows`'s lookup (migration 113):
          // `.in("source_id", ids).in("source_article_key", keys).gte(...)`.
          const keyIn = inCalls.find((c) => c.column === "source_article_key");
          if (keyIn) {
            const ids = (inCalls.find((c) => c.column === "source_id")?.values ?? []) as string[];
            const keys = keyIn.values as string[];
            keyLookupCalls.push({
              sourceIds: [...ids],
              keys: [...keys],
              gte: [...gteCalls],
              order: [...orderCalls],
              limit: limitCall,
            });
            if (forcedKeyLookupThrow) throw new Error("simulated key lookup throw");
            if (forcedKeyLookupError) {
              return { data: null, error: { message: forcedKeyLookupError } };
            }
            const since = gteCalls.find((c) => c.column === "created_at")?.value;
            const sinceMs = typeof since === "string" ? Date.parse(since) : Number.NEGATIVE_INFINITY;
            const hours1Ago = new Date(Date.now() - 3_600_000).toISOString();
            let rows = storedArticlesByKey
              .filter((r) => ids.includes(r.source_id) && keys.includes(r.source_article_key))
              .map((r) => ({ ...r, created_at: r.created_at ?? hours1Ago }))
              .filter((r) => Date.parse(r.created_at) >= sinceMs);
            // Like PostgREST: order first, then cut to the limit.
            const byCreated = orderCalls.find((c) => c.column === "created_at");
            if (byCreated) {
              const dir = byCreated.ascending ? 1 : -1;
              rows = [...rows].sort(
                (a, b) => dir * (Date.parse(a.created_at) - Date.parse(b.created_at)),
              );
            }
            if (limitCall !== null) rows = rows.slice(0, limitCall);
            return { data: rows, error: null };
          }
          // Only reached by a plain `.select(...)` read (the batched/
          // per-row `.upsert(...)` calls below return their own thenable
          // and never hit this `settle()`). Since migration 130 the
          // existing-pair lookup goes through the pairwise RPC; this
          // `.in("source_id", ...).in("content_hash", ...)` branch answers
          // only the legacy fallback (`legacyExistingPairsProbe`, reached on
          // PGRST202). Like PostgREST it is a CROSS PRODUCT: every stored
          // pair whose source is in one list and whose hash is in the other.
          const sourceIdIn = inCalls.find((c) => c.column === "source_id");
          const hashIn = inCalls.find((c) => c.column === "content_hash");
          if (sourceIdIn && hashIn) {
            const sourceIds = [...(sourceIdIn.values as string[])];
            const hashes = [...(hashIn.values as string[])];
            legacyPrefilterLookupCalls.push({ sourceIds, hashes });
            return {
              data: existingArticleHashPairs.filter(
                (p) => sourceIds.includes(p.source_id) && hashes.includes(p.content_hash),
              ),
              error: null,
            };
          }
          return { data: [...existingArticleHashPairs], error: null };
        }
        return { data: null, error: null };
      };
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        order: (column: string, opts?: { ascending?: boolean }) => {
          orderCalls.push({ column, ascending: opts?.ascending !== false });
          return chain;
        },
        limit: (n: number) => {
          limitCall = n;
          return chain;
        },
        gte: (column: string, value: unknown) => {
          gteCalls.push({ column, value });
          if (table === "articles") articlesGteCalls.push({ column, value });
          return chain;
        },
        in: (column: string, values: unknown) => {
          inCalls.push({
            column,
            values: Array.isArray(values) ? values : [values],
          });
          return chain;
        },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        // Make the chain awaitable: `await supabase.from("sources").select(...)`.
        then: (
          onFul?: (v: { data: unknown; error: unknown }) => unknown,
          onRej?: (e: unknown) => unknown,
        ) => Promise.resolve(settle()).then(onFul, onRej),
        upsert: (rows: unknown) => {
          const arr = Array.isArray(rows) ? rows : [rows];
          if (table === "articles") {
            articlesUpsertCalls.push(arr as Array<Record<string, unknown>>);
            // Simulate the real `articles_source_content_hash_key` UNIQUE
            // constraint: if this call's payload still contains a row
            // sharing (source_id, content_hash) with an already-"stored"
            // pair, the whole call fails exactly like production's 23505
            // — proving (migration 041 F2) that the fix must drop such a
            // row BEFORE either the batched or per-row upsert call, not
            // rely on this failure + fallback to sort it out.
            const collides = (arr as Array<Record<string, unknown>>).some((r) =>
              existingArticleHashPairs.some(
                (p) =>
                  p.source_id === r.source_id && p.content_hash === r.content_hash,
              ),
            );
            if (collides) {
              const result = {
                data: null,
                error: {
                  message:
                    'duplicate key value violates unique constraint "articles_source_content_hash_key"',
                },
              };
              return {
                select: () => Promise.resolve(result),
                then: (
                  onFul?: (v: typeof result) => unknown,
                  onRej?: (e: unknown) => unknown,
                ) => Promise.resolve(result).then(onFul, onRej),
              };
            }
            // ingest-health: simulates a batch that fails whenever it
            // contains a specific "poisoned" url — lets a test drive
            // `upsertWithBisect`'s O(log n) isolation directly, independent
            // of the (source_id, content_hash) collision path above.
            const hasPoisonedUrl =
              forcedPoisonedUrl !== null &&
              (arr as Array<Record<string, unknown>>).some(
                (r) => r.url === forcedPoisonedUrl,
              );
            if (hasPoisonedUrl) {
              const result = {
                data: null,
                error: { message: "simulated poisoned row upsert failure" },
              };
              return {
                select: () => Promise.resolve(result),
                then: (
                  onFul?: (v: typeof result) => unknown,
                  onRej?: (e: unknown) => unknown,
                ) => Promise.resolve(result).then(onFul, onRej),
              };
            }
            for (const r of arr) upserted.push(r as Record<string, unknown>);
            // Reflect the TRUE batch length (not a fixed single-row stub) so
            // `inserted` counts computed from `data.length` are meaningful
            // for the multi-row bisect tests above.
            const okResult = {
              data: (arr as Array<Record<string, unknown>>).map((_, idx) => ({
                id: `fake-row-id-${upserted.length}-${idx}`,
              })),
              error: null,
            };
            return {
              select: () => Promise.resolve(okResult),
              then: (
                onFul?: (v: typeof okResult) => unknown,
                onRej?: (e: unknown) => unknown,
              ) => Promise.resolve(okResult).then(onFul, onRej),
            };
          } else if (table === "sources") {
            // Regression tripwire: a partial-row upsert on `sources` fails
            // in the real DB (23502) — record it under its own `fn` so the
            // "exactly one RPC write" assertions below catch a drift back.
            sourceFetchStateWrites.push({
              fn: "sources.upsert",
              rows: arr as Array<Record<string, unknown>>,
            });
          } else if (table === "article_title_versions") {
            titleVersionInsertCalls.push(arr as Array<Record<string, unknown>>);
            if (forcedTitleVersionInsertError) {
              const result = {
                data: null,
                error: { message: forcedTitleVersionInsertError },
              };
              return {
                select: () => Promise.resolve(result),
                then: (
                  onFul?: (v: typeof result) => unknown,
                  onRej?: (e: unknown) => unknown,
                ) => Promise.resolve(result).then(onFul, onRej),
              };
            }
            const insertedRows: Array<{ id: string }> = [];
            for (const r of arr as Array<Record<string, unknown>>) {
              const key = `${r.article_id as string}::${r.new_title as string}`;
              if (recordedTitleVersionKeys.has(key)) continue;
              recordedTitleVersionKeys.add(key);
              insertedRows.push({ id: `fake-title-version-${recordedTitleVersionKeys.size}` });
            }
            const result = { data: insertedRows, error: null };
            return {
              select: () => Promise.resolve(result),
              then: (
                onFul?: (v: typeof result) => unknown,
                onRej?: (e: unknown) => unknown,
              ) => Promise.resolve(result).then(onFul, onRej),
            };
          }
          // The SUT chains `.upsert(...).select("id")` (production code at
          // supabase/functions/ingest/index.ts:185-188). Returning a bare
          // Promise here makes the chain throw `select is not a function`
          // — vitest swallows the throw inside the SUT's outer catch and
          // the tests then green-pass on the `upserted[]` rows we pushed
          // ABOVE the throw. Round-3 / Round-4 QA flagged this as TC-R4-F1.
          // Return a chainable thenable so `.select("id")` works AND
          // direct-await still resolves to the result envelope.
          const result = { data: [{ id: "fake-row-id" }], error: null };
          const builder = {
            select: () => Promise.resolve(result),
            then: (
              onFul?: (v: typeof result) => unknown,
              onRej?: (e: unknown) => unknown,
            ) => Promise.resolve(result).then(onFul, onRej),
          };
          return builder;
        },
        insert: (rows: unknown) => {
          const arr = Array.isArray(rows) ? rows : [rows];
          if (table === "ingest_cycles") {
            if (forcedIngestCyclesInsertError) {
              return Promise.resolve({
                data: null,
                error: { message: forcedIngestCyclesInsertError },
              });
            }
            for (const r of arr) ingestCycleInserts.push(r as Record<string, unknown>);
          }
          // `article_title_versions` is written via `.upsert(...)` now (see
          // above), not `.insert(...)` — MF-02.
          return Promise.resolve({ data: null, error: null });
        },
        update: () => chain,
      });
      return chain;
    },
    rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === "existing_source_content_hash_pairs") {
        const sourceIds = [...((args?.p_source_ids ?? []) as string[])];
        const hashes = [...((args?.p_hashes ?? []) as string[])];
        prefilterLookupCalls.push({ sourceIds, hashes });
        if (forcedPrefilterRpcThrow) throw new Error("simulated rpc transport failure");
        if (forcedPrefilterErrorOnCall === prefilterLookupCalls.length) {
          return {
            data: null,
            error: { code: "57014", message: "simulated prefilter chunk lookup failure" },
          };
        }
        if (forcedPrefilterRpcMissing) {
          return {
            data: null,
            error: { code: "PGRST202", message: "Could not find the function" },
          };
        }
        // Like the SQL function: zip the two arrays and return the stored
        // pairs that match PAIRWISE (an existing (s1,h2) never matches the
        // pairs (s1,h1) and (s2,h2) just because s1 and h2 were both asked for).
        const asked = new Set(sourceIds.map((sid, i) => `${sid}\x1f${hashes[i]}`));
        return {
          data: existingArticleHashPairs.filter((p) =>
            asked.has(`${p.source_id}\x1f${p.content_hash}`),
          ),
          error: null,
        };
      }
      if (fn === "ingest_set_source_fetch_state") {
        sourceFetchStateWrites.push({
          fn,
          rows: (args?.p_rows ?? []) as Array<Record<string, unknown>>,
        });
      }
      if (fn === "apply_article_title_edits") {
        titleEditRpcCalls.push((args?.p_rows ?? []) as Array<Record<string, unknown>>);
        if (forcedTitleEditRpcError) {
          return { data: null, error: { message: forcedTitleEditRpcError } };
        }
        return { data: (args?.p_rows as unknown[] | undefined)?.length ?? 0, error: null };
      }
      return { data: null, error: null };
    }),
  }),
}));

// Stub the fetcher module. The real module exports `fetchFeed(source, opts)`
// and returns a `FetchResult` ({ source, items, status, ... }); the mock
// mirrors that named export and shape exactly — any drift (e.g. exporting
// `fetchAllFeeds`/`fetchOneFeed` instead) leaves the SUT's named import as
// `undefined` and silently masks regressions.
//
// Per-test fixtures live in `fetcherItems` keyed by `source.rss_url`. Each
// test seeds the items it wants the handler to see, the mock returns them,
// and the post-handler tripwire asserts `upserted.length === fixtureItems.length`
// so a silent fetcher/normalizer drop is impossible to miss.
type MockFeedItem = {
  title: string;
  link: string;
  pubDate?: string;
  contentSnippet?: string;
  content?: string;
  contentHash?: string;
};

type FetchOverride = {
  status?: number;
  notModified?: boolean;
  etag?: string | null;
  lastModified?: string | null;
  bodyHash?: string;
  error?: string;
  notAFeed?: boolean;
  // Parse budget (twin-articles item, part B). `bodyBytes` is what the mocked
  // fetcher reports to `opts.admitParse` for a changed body (default 1000); it
  // is not part of the returned result. `parseDeferred` lets a test force that
  // flag onto a result directly.
  bodyBytes?: number;
  parseDeferred?: boolean;
};

const fetcherItems: Record<string, MockFeedItem[]> = {};
// Per-test overrides on top of the default `{ status: 200, items }` result —
// used by the migration-041 tests below to simulate a 304, a body-hash
// match, an etag/lastModified change, or a fetch error without needing a
// real `fetch` round trip.
const fetcherResultOverrides: Record<string, FetchOverride> = {};
// One entry per `fetchFeed(source, opts)` call this test made, capturing
// exactly the `conditionalCache` entry (if any) the SUT looked up for that
// source — the cheapest way to prove hydration ran without re-implementing
// header construction (fetchFeed itself is mocked out in this file).
const fetchFeedCalls: Array<{
  sourceId: string;
  cached?: { etag?: string; lastModified?: string };
}> = [];

vi.mock("../../supabase/functions/_shared/rss/fetcher.ts", () => ({
  fetchFeed: vi.fn(
    async (
      source: { id: string; rss_url: string },
      opts?: {
        conditionalCache?: Map<string, { etag?: string; lastModified?: string }>;
        admitParse?: (bodyBytes: number) => boolean;
      },
    ): Promise<{
      source: unknown;
      items: MockFeedItem[];
      status: number;
      notModified?: boolean;
      etag?: string | null;
      lastModified?: string | null;
      bodyHash?: string;
      error?: string;
      notAFeed?: boolean;
      parseDeferred?: boolean;
    }> => {
      fetchFeedCalls.push({
        sourceId: source.id,
        cached: opts?.conditionalCache?.get(source.id),
      });
      const items = fetcherItems[source.rss_url] ?? [];
      const { bodyBytes, ...override } = fetcherResultOverrides[source.rss_url] ?? {};
      // Like the real fetcher: the parse budget is asked only for a changed
      // 2xx body -- never for an error, a 304 or a body-hash hit.
      if (opts?.admitParse && !override.error && !override.notModified) {
        if (!opts.admitParse(bodyBytes ?? 1000)) {
          // The real fetcher stamps the response's validators on the cache
          // before it consults the budget and restores them itself; this mock
          // stamps and does NOT restore, so the tests prove the ingest worker
          // puts the cache back on its own.
          if (override.etag && opts.conditionalCache) {
            opts.conditionalCache.set(source.id, { etag: override.etag });
          }
          return { source, items: [], status: override.status ?? 200, parseDeferred: true };
        }
      }
      return { source, items, status: 200, ...override };
    },
  ),
}));

async function tryImport(path: string): Promise<unknown> {
  try {
    return await import(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// `fetch` interception.
//
// We replace the global fetch with a stub that returns the CP1254 fixture
// (or other configured per-URL responses) so the ingest handler sees a
// real-looking Response object — Content-Type header, ArrayBuffer body,
// status, etc. — without hitting the network.
// ---------------------------------------------------------------------------

const fetchResponses: Record<
  string,
  { status?: number; headers?: Record<string, string>; body: Uint8Array | string }
> = {};

const originalFetch = globalThis.fetch;

function installFetchStub() {
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const entry = fetchResponses[url];
    if (!entry) {
      return new Response("not found", { status: 404 });
    }
    const body =
      typeof entry.body === "string"
        ? new TextEncoder().encode(entry.body)
        : entry.body;
    return new Response(body, {
      status: entry.status ?? 200,
      headers: entry.headers ?? {},
    });
  }) as typeof fetch;
}

// A-ingest-cpu: the ingest module keeps an isolate-wide item budget in module
// state, and this file imports the module once. A budget no test reaches keeps
// every other test independent of how many items earlier tests parsed; the
// tests that exercise the budget set their own value and reset the module.
const ORIGINAL_ISOLATE_ITEM_BUDGET = process.env.INGEST_ISOLATE_ITEM_BUDGET;

beforeEach(() => {
  process.env.INGEST_ISOLATE_ITEM_BUDGET = "100000000";
  heavyWork.fingerprints = 0;
  upserted.length = 0;
  ingestCycleInserts.length = 0;
  sourceFetchStateWrites.length = 0;
  fetchFeedCalls.length = 0;
  articlesUpsertCalls.length = 0;
  existingArticleHashPairs = [];
  forcedPoisonedUrl = null;
  storedArticlesByUrl = {};
  forcedTitleLookupError = null;
  forcedTitleVersionInsertError = null;
  titleEditRpcCalls.length = 0;
  forcedTitleEditRpcError = null;
  prefilterLookupCalls.length = 0;
  legacyPrefilterLookupCalls.length = 0;
  forcedPrefilterErrorOnCall = null;
  forcedPrefilterRpcMissing = false;
  forcedPrefilterRpcThrow = false;
  storedArticlesByKey = [];
  forcedKeyLookupError = null;
  forcedKeyLookupThrow = false;
  keyLookupCalls.length = 0;
  jaccardWork.calls = 0;
  articlesGteCalls.length = 0;
  articlesUrlLookupCalls.length = 0;
  titleVersionInsertCalls.length = 0;
  recordedTitleVersionKeys.clear();
  forcedSourcesError = null;
  forcedIngestCyclesInsertError = null;
  fakeSources.length = 0;
  for (const k of Object.keys(fetchResponses)) delete fetchResponses[k];
  for (const k of Object.keys(fetcherItems)) delete fetcherItems[k];
  for (const k of Object.keys(fetcherResultOverrides)) delete fetcherResultOverrides[k];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SERVICE_ROLE_KEY;
  installFetchStub();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
  if (ORIGINAL_ISOLATE_ITEM_BUDGET === undefined) delete process.env.INGEST_ISOLATE_ITEM_BUDGET;
  else process.env.INGEST_ISOLATE_ITEM_BUDGET = ORIGINAL_ISOLATE_ITEM_BUDGET;
});

// ---------------------------------------------------------------------------
// Direct charset helper test — fastest signal if `charset.ts` ships.
// ---------------------------------------------------------------------------

type DecodeResult = { text: string; charset: string };
type CharsetModule = {
  decodeRssBody: (bytes: Uint8Array, contentType: string | null) => DecodeResult;
};

describe("rss/charset (CP1254 decode helper)", () => {
  it("decodes iso-8859-9 (Windows-1254) bytes into the correct Turkish title", async () => {
    const mod = (await tryImport(
      "../../supabase/functions/_shared/rss/charset.ts",
    )) as CharsetModule | null;

    // Tripwire: if the helper failed to import or the named export drifted,
    // fail loud rather than silently skip the regression check.
    expect(mod?.decodeRssBody).toBeDefined();

    const result = mod!.decodeRssBody(
      CP1254_BYTES,
      "text/xml; charset=iso-8859-9",
    );
    expect(result.text).toContain(EXPECTED_TITLE);
    expect(result.charset.toLowerCase()).toMatch(/(iso-8859-9|windows-1254)/);
    // Negative: must NOT contain the U+FFFD replacement character that
    // appears when CP1254 bytes are mis-decoded as UTF-8.
    expect(result.text).not.toContain("�");
  });

  it("falls back to UTF-8 when no charset is declared", async () => {
    const mod = (await tryImport(
      "../../supabase/functions/_shared/rss/charset.ts",
    )) as CharsetModule | null;
    expect(mod?.decodeRssBody).toBeDefined();

    const utf8 = new TextEncoder().encode("<rss>UTF-8 default</rss>");
    const result = mod!.decodeRssBody(utf8, null);
    expect(result.text).toContain("UTF-8 default");
    expect(result.charset.toLowerCase()).toBe("utf-8");
  });
});

// ---------------------------------------------------------------------------
// End-to-end ingest handler test — invokes the registered Deno.serve
// callback with a `Request`, lets it dial out via the stubbed `fetch`,
// then asserts on the rows that ended up in the Supabase upsert sink.
// ---------------------------------------------------------------------------

async function importIngestHandler(): Promise<
  ((req: Request) => Promise<Response>) | null
> {
  // No try/catch — import failures must propagate so a broken SUT can't
  // hide behind a no-op suite.
  await import("../../supabase/functions/ingest/index.ts");
  const reg = (globalThis as unknown as {
    __ingestHandler?: (req: Request) => Promise<Response>;
  }).__ingestHandler;
  return reg ?? null;
}

describe("ingest Edge Function", () => {
  it("returns 200 with no sources configured (empty fan-out)", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    expect([200, 207]).toContain(res.status);
  });

  it("decodes a CP1254 (iso-8859-9) feed end-to-end without mojibake [T7 P1-22]", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    // Seed a single active source so the loop body actually runs against
    // the fixture URL instead of short-circuiting on an empty roster.
    fakeSources.push({
      id: "src-cp1254",
      name: "CP1254 Fixture",
      slug: "cp1254-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/cp1254.rss",
      active: true,
    });

    // Still install the raw-bytes fetch stub for completeness — useful if a
    // future revision swaps the fetcher mock back to the real implementation
    // — but the assertion below is on what `fetchFeed` (mocked) hands the
    // normalizer, which is the already-decoded title.
    fetchResponses["https://example.com/cp1254.rss"] = {
      status: 200,
      // Content-Type header is the primary signal the charset helper sniffs.
      headers: { "Content-Type": "text/xml; charset=iso-8859-9" },
      body: CP1254_BYTES,
    };

    // Seed the mocked fetcher with one item carrying the expected Turkish
    // title — the helper-level test above already proves the byte-level
    // decode; here we just verify the normalizer + upsert sink preserve
    // multi-byte characters without re-encoding damage.
    const fixtureItems: MockFeedItem[] = [
      {
        title: EXPECTED_TITLE,
        link: "https://example.com/a1",
        pubDate: "Mon, 01 Jan 2024 00:00:00 GMT",
      },
    ];
    fetcherItems["https://example.com/cp1254.rss"] = fixtureItems;

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));

    // Tripwire: row count must match the fixture exactly — any silent drop
    // in the fetcher → normalizer → upsert chain fails here.
    expect(upserted.length).toBe(fixtureItems.length);
    const titles = upserted.map((r) => String(r.title ?? ""));
    expect(titles.some((t) => t.includes(EXPECTED_TITLE))).toBe(true);
    for (const t of titles) {
      expect(t).not.toContain("�");
    }
  });

  it("uses a unified sha1-of-shingles content_hash (40 hex chars), never sha256", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-simple",
      name: "Simple Fixture",
      slug: "simple-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/simple.rss",
      active: true,
    });

    fetchResponses["https://example.com/simple.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>Sample headline</title>" +
        "<link>https://example.com/simple/1</link>" +
        "</item></channel></rss>",
    };

    const fixtureItems: MockFeedItem[] = [
      {
        title: "Sample headline",
        link: "https://example.com/simple/1",
        pubDate: "Mon, 01 Jan 2024 00:00:00 GMT",
      },
    ];
    fetcherItems["https://example.com/simple.rss"] = fixtureItems;

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    // Tripwire: row count must match the fixture exactly — silent drops
    // in fetcher → normalizer → upsert fail here, not later in soft asserts.
    expect(upserted.length).toBe(fixtureItems.length);

    let checked = 0;
    for (const row of upserted) {
      const h = String((row as { content_hash?: string }).content_hash ?? "");
      if (!h) continue;
      // 40 hex = sha1; 64 hex = sha256. Audit T7 P1-21 says we want sha1.
      expect(h).toMatch(/^[0-9a-f]{40}$/);
      checked += 1;
    }
    // Tripwire: at least one upserted row must carry a content_hash so the
    // sha1-vs-sha256 assertion above is actually exercised.
    expect(checked).toBeGreaterThan(0);
  });

  it("adds a canonicalized canonical_url alongside the raw url [migration 039]", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-canon",
      name: "Canon Fixture",
      slug: "canon-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/canon.rss",
      active: true,
    });

    // Raw link carries an uppercase `www.` host, a tracking param
    // (utm_source), a non-tracking param (keep), and a fragment — every
    // rule canonicalizeUrl() applies gets exercised in one fixture.
    const rawLink =
      "https://WWW.Example.com/canon/1/?utm_source=rss&keep=1#frag";
    fetchResponses["https://example.com/canon.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>Canon</title>" +
        `<link>${rawLink}</link>` +
        "</item></channel></rss>",
    };

    const fixtureItems: MockFeedItem[] = [
      { title: "Canon", link: rawLink, pubDate: "Mon, 01 Jan 2024 00:00:00 GMT" },
    ];
    fetcherItems["https://example.com/canon.rss"] = fixtureItems;

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    expect(upserted.length).toBe(fixtureItems.length);

    const row = upserted[0] as { url?: string; canonical_url?: string };
    // The raw absolute url is untouched.
    expect(row.url).toBe(rawLink);
    // canonical_url: host lowercased + www-stripped, utm_source removed
    // (tracking), `keep` param retained (not a tracking key), trailing
    // slash trimmed, fragment dropped.
    expect(row.canonical_url).toBe("https://example.com/canon/1?keep=1");
  });

  it("upserts with ON CONFLICT DO NOTHING semantics (re-run is a no-op)", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-dup",
      name: "Dup Fixture",
      slug: "dup-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/dup.rss",
      active: true,
    });

    fetchResponses["https://example.com/dup.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>Dup</title><link>https://example.com/dup/1</link>" +
        "</item></channel></rss>",
    };

    const fixtureItems: MockFeedItem[] = [
      {
        title: "Dup",
        link: "https://example.com/dup/1",
        pubDate: "Mon, 01 Jan 2024 00:00:00 GMT",
      },
    ];
    fetcherItems["https://example.com/dup.rss"] = fixtureItems;

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    // Tripwire: first-run row count matches fixture; the re-run check below
    // then guards the ON CONFLICT DO NOTHING semantic.
    expect(upserted.length).toBe(fixtureItems.length);
    const firstRun = upserted.length;
    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    // Both runs hit upsert; the DB-side UNIQUE constraint is what makes
    // re-runs a no-op, not the application code. We just check the handler
    // didn't *grow* its row count beyond a reasonable bound.
    expect(upserted.length).toBeLessThanOrEqual(firstRun * 2);
  });

  it("returns 401 without a service-role bearer", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    // No Authorization header → the gate must reject before fan-out.
    const res = await handler(
      new Request("http://localhost/ingest", { method: "POST" }),
    );
    expect(res.status).toBe(401);
    expect(upserted).toHaveLength(0);
    // The auth gate rejects before runCycle ever starts, so no ingest_cycles
    // row should be written for a request that never reached a cycle.
    expect(ingestCycleInserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ingest_cycles telemetry (migration 039) — one best-effort row per cycle,
// written from `recordIngestCycle` on both the success and the failure path.
// ---------------------------------------------------------------------------

describe("ingest_cycles telemetry [migration 039]", () => {
  it("writes one ingest_cycles row summarizing a successful cycle", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-telemetry",
      name: "Telemetry Fixture",
      slug: "telemetry-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/telemetry.rss",
      active: true,
    });
    fetchResponses["https://example.com/telemetry.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>Telemetry</title><link>https://example.com/telemetry/1</link>" +
        "</item></channel></rss>",
    };
    fetcherItems["https://example.com/telemetry.rss"] = [
      { title: "Telemetry", link: "https://example.com/telemetry/1" },
    ];

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    expect(res.status).toBe(200);

    // Tripwire: exactly one row per cycle, not zero and not one per source.
    expect(ingestCycleInserts).toHaveLength(1);
    const row = ingestCycleInserts[0] as {
      started_at?: string;
      fetched?: number;
      inserted?: number;
      row_errors?: number;
      failed?: number;
      duration_ms?: number;
    };
    expect(typeof row.started_at).toBe("string");
    expect(Number.isNaN(Date.parse(row.started_at ?? ""))).toBe(false);
    expect(row.fetched).toBe(1);
    expect(row.inserted).toBeGreaterThanOrEqual(1);
    expect(row.row_errors).toBe(0);
    expect(row.failed).toBe(0);
    expect(typeof row.duration_ms).toBe("number");
    expect(row.duration_ms as number).toBeGreaterThanOrEqual(0);
  });

  it("still writes an ingest_cycles row when the cycle throws (sources fetch failure)", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    // Force the `sources` select to come back with an error so
    // `runCycleBody` throws before any fetch/upsert work happens — this is
    // the failure path the `finally` in `runCycle` must still cover.
    forcedSourcesError = "sources table unreachable (test-forced)";

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    // The thrown error propagates to the handler's outer catch, which
    // reports it as a 500 (supabase/functions/ingest/index.ts's Deno.serve
    // callback) — the telemetry write must not mask or swallow that.
    expect(res.status).toBe(500);

    expect(ingestCycleInserts).toHaveLength(1);
    const row = ingestCycleInserts[0] as {
      fetched?: number;
      failed?: number;
      row_errors?: number;
      duration_ms?: number;
    };
    expect(row.fetched).toBe(0);
    expect(row.failed).toBe(0);
    expect(row.row_errors).toBe(0);
    expect(typeof row.duration_ms).toBe("number");
  });

  it("does not fail the cycle when the ingest_cycles insert itself errors", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-telemetry-fail",
      name: "Telemetry Fail Fixture",
      slug: "telemetry-fail-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/telemetry-fail.rss",
      active: true,
    });
    fetchResponses["https://example.com/telemetry-fail.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>T</title><link>https://example.com/telemetry-fail/1</link>" +
        "</item></channel></rss>",
    };
    fetcherItems["https://example.com/telemetry-fail.rss"] = [
      { title: "T", link: "https://example.com/telemetry-fail/1" },
    ];

    // Simulate the ingest_cycles insert coming back with a Supabase error
    // (e.g. an RLS/grant misconfiguration) and assert the outer request
    // still resolves 200 — recordIngestCycle logs and swallows it rather
    // than letting a telemetry-write failure fail the cycle.
    forcedIngestCyclesInsertError = "simulated ingest_cycles insert failure";

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(upserted.length).toBe(1);
    // The error path never pushes into the tracking array.
    expect(ingestCycleInserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fair upsert order + bisecting fallback (ingest-health).
// ---------------------------------------------------------------------------

describe("ingest-health: bisecting upsert fallback", () => {
  it(
    "isolates a single poisoned row in O(log n) upsert calls: " +
      "inserted = n-1, rowErrors = 1, calls <= 1 + 2*ceil(log2 n)",
    async () => {
      const handler = await importIngestHandler();
      expect(handler).toBeDefined();
      if (!handler) throw new Error("unreachable: handler tripwire above must throw");

      const N = 20;
      fakeSources.push({
        id: "src-bisect",
        name: "Bisect Fixture",
        slug: "bisect-fixture",
        url: "https://example.com",
        rss_url: "https://example.com/bisect.rss",
        active: true,
      });
      const fixtureItems: MockFeedItem[] = Array.from({ length: N }, (_, i) => ({
        title: `Bisect item ${i}`,
        link: `https://example.com/bisect/${i}`,
        pubDate: "Mon, 01 Jan 2024 00:00:00 GMT",
      }));
      fetcherItems["https://example.com/bisect.rss"] = fixtureItems;
      forcedPoisonedUrl = "https://example.com/bisect/13";

      const res = await handler(
        authedRequest("http://localhost/ingest", { method: "POST" }),
      );
      const body = (await res.json()) as { rowErrors?: number; upsertSkipped?: number };

      expect(upserted.length).toBe(N - 1);
      expect(upserted.some((r) => r.url === forcedPoisonedUrl)).toBe(false);
      expect(body.rowErrors).toBe(1);
      const bound = 1 + 2 * Math.ceil(Math.log2(N));
      expect(articlesUpsertCalls.length).toBeLessThanOrEqual(bound);
      expect(body.upsertSkipped ?? 0).toBe(0);
    },
  );

  it("reports upsertSkipped in the cycle JSON (0 on a normal, on-time cycle)", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-skipped-shape",
      name: "Skipped Shape Fixture",
      slug: "skipped-shape-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/skipped-shape.rss",
      active: true,
    });
    fetcherItems["https://example.com/skipped-shape.rss"] = [
      { title: "Shape", link: "https://example.com/skipped-shape/1" },
    ];

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    const body = (await res.json()) as { upsertSkipped?: number };
    expect(typeof body.upsertSkipped).toBe("number");
    expect(body.upsertSkipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Conditional-fetch state persistence (migration 041) — hydrating
// `conditionalCache` from `sources` at cycle start, treating an unchanged
// body hash like a 304, and writing updated validators back in one upsert.
// ---------------------------------------------------------------------------

describe("ingest conditional-fetch state [migration 041]", () => {
  it("hydrates conditionalCache from the source row and passes it to fetchFeed", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-041-hydrate",
      name: "Hydrate Fixture",
      slug: "hydrate-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/hydrate.rss",
      active: true,
      fetch_etag: 'W/"stored-etag"',
      fetch_last_modified: "Wed, 01 Jan 2025 00:00:00 GMT",
      fetch_body_hash: null,
      fetch_last_status: 200,
      fetch_last_at: "2025-01-01T00:00:00.000Z",
    });
    // No items needed — this test only checks what fetchFeed was called
    // with, not what came out of the normalize/upsert path.
    fetcherItems["https://example.com/hydrate.rss"] = [];

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));

    const call = fetchFeedCalls.find((c) => c.sourceId === "src-041-hydrate");
    expect(call).toBeDefined();
    // The values that would become If-None-Match / If-Modified-Since headers
    // inside the real (unmocked) fetchFeed.
    expect(call?.cached?.etag).toBe('W/"stored-etag"');
    expect(call?.cached?.lastModified).toBe("Wed, 01 Jan 2025 00:00:00 GMT");
  });

  it("skips normalize/upsert and counts notModified when the body hash is unchanged", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-041-samehash",
      name: "Same Hash Fixture",
      slug: "samehash-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/samehash.rss",
      active: true,
      fetch_body_hash: "deadbeef",
    });
    // An item is present, proving it's the hash check — not an empty feed —
    // that suppresses normalize/upsert. `notModified: true` mirrors what the
    // REAL fetcher now returns for a body-hash match (migration 041 F1: the
    // short-circuit lives in fetchFeed itself, before decode/parse, so
    // index.ts only has `result.notModified` to react to — see
    // fetcher.test.ts for the real-module version of this contract).
    fetcherItems["https://example.com/samehash.rss"] = [
      { title: "Should be skipped", link: "https://example.com/samehash/1" },
    ];
    fetcherResultOverrides["https://example.com/samehash.rss"] = {
      notModified: true,
      bodyHash: "deadbeef",
    };

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    const body = (await res.json()) as { notModified?: number; fetched?: number };

    expect(upserted.some((r) => r.source_id === "src-041-samehash")).toBe(false);
    expect(body.notModified).toBeGreaterThanOrEqual(1);
  });

  it("persists changed validators with exactly one ingest_set_source_fetch_state RPC call", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-041-persist",
      name: "Persist Fixture",
      slug: "persist-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/persist.rss",
      active: true,
      fetch_etag: null,
      fetch_last_modified: null,
      fetch_body_hash: null,
    });
    fetcherItems["https://example.com/persist.rss"] = [
      { title: "Persist", link: "https://example.com/persist/1" },
    ];
    fetcherResultOverrides["https://example.com/persist.rss"] = {
      etag: '"v1"',
      lastModified: "Thu, 02 Jan 2025 00:00:00 GMT",
      bodyHash: "hash-v1",
    };

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));

    // One batched write for the whole cycle, not one per source — and via
    // the RPC, never `.from("sources").upsert(...)` (see tripwire above).
    expect(sourceFetchStateWrites).toHaveLength(1);
    expect(sourceFetchStateWrites[0]?.fn).toBe("ingest_set_source_fetch_state");
    const row = sourceFetchStateWrites[0]?.rows.find(
      (r) => r.id === "src-041-persist",
    );
    expect(row).toBeDefined();
    expect(row?.fetch_etag).toBe('"v1"');
    expect(row?.fetch_last_modified).toBe("Thu, 02 Jan 2025 00:00:00 GMT");
    expect(row?.fetch_body_hash).toBe("hash-v1");
    expect(row?.fetch_last_status).toBe(200);
    expect(Number.isNaN(Date.parse(String(row?.fetch_last_at)))).toBe(false);
  });

  it("keeps existing validators when a 2xx response omits ETag/Last-Modified [migration 041 F4]", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-041-keepvalidators",
      name: "Keep Validators Fixture",
      slug: "keepvalidators-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/keepvalidators.rss",
      active: true,
      fetch_etag: 'W/"old"',
      fetch_last_modified: "Tue, 31 Dec 2024 00:00:00 GMT",
      fetch_body_hash: "stored-hash",
    });
    fetcherItems["https://example.com/keepvalidators.rss"] = [
      { title: "Fresh content", link: "https://example.com/keepvalidators/1" },
    ];
    // A 2xx that changed enough to be worth parsing (no `notModified`) but
    // whose response happened to omit both conditional-GET headers this
    // time — set-only-when-present semantics must keep the stored
    // validators rather than blanking them to null.
    fetcherResultOverrides["https://example.com/keepvalidators.rss"] = {
      etag: null,
      lastModified: null,
      bodyHash: "stored-hash",
    };

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));

    expect(sourceFetchStateWrites).toHaveLength(1);
    expect(sourceFetchStateWrites[0]?.fn).toBe("ingest_set_source_fetch_state");
    const row = sourceFetchStateWrites[0]?.rows.find(
      (r) => r.id === "src-041-keepvalidators",
    );
    expect(row).toBeDefined();
    expect(row?.fetch_etag).toBe('W/"old"');
    expect(row?.fetch_last_modified).toBe("Tue, 31 Dec 2024 00:00:00 GMT");
  });

  it("keeps memory and DB in sync when a 2xx response fails to parse [migration 041 F5]", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-041-parseerror",
      name: "Parse Error Fixture",
      slug: "parseerror-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/parseerror.rss",
      active: true,
      fetch_etag: 'W/"old"',
      fetch_last_modified: null,
      fetch_body_hash: null,
    });
    // The fetcher can return `etag`/`lastModified`/`bodyHash` ALONGSIDE
    // `error` on a 2xx whose body failed to parse (fetcher.ts refreshes its
    // cache before attempting the parse) — the persisted row must pick
    // those up too, so a warm instance (which already moved to the new
    // ETag) and the DB don't disagree about which validators produced this
    // unparseable body.
    fetcherResultOverrides["https://example.com/parseerror.rss"] = {
      error: "parse error: unexpected end of input",
      status: 200,
      etag: '"new-etag"',
      lastModified: "Wed, 02 Jan 2025 00:00:00 GMT",
      bodyHash: "new-hash",
    };

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    const body = (await res.json()) as { failed?: number };
    expect(body.failed).toBeGreaterThanOrEqual(1);

    expect(sourceFetchStateWrites[0]?.fn).toBe("ingest_set_source_fetch_state");
    const row = sourceFetchStateWrites[0]?.rows.find(
      (r) => r.id === "src-041-parseerror",
    );
    expect(row).toBeDefined();
    expect(row?.fetch_etag).toBe('"new-etag"');
    expect(row?.fetch_last_modified).toBe("Wed, 02 Jan 2025 00:00:00 GMT");
    expect(row?.fetch_body_hash).toBe("new-hash");
    expect(row?.fetch_last_status).toBe(200);
  });

  it("counts an HTML/not-a-feed 2xx body as a failure and advances fetch_fail_streak without adopting new validators [ingest-health]", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-health-notafeed",
      name: "Not A Feed Fixture",
      slug: "notafeed-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/notafeed.rss",
      active: true,
      fetch_etag: 'W/"stored-etag"',
      fetch_last_modified: null,
      fetch_body_hash: "stored-body-hash",
      fetch_fail_streak: 3,
    });
    // fetchFeed itself is mocked in this file (see the module mock above) --
    // this simulates the real fetcher.ts's NotAFeedError branch, which
    // returns `error`/`notAFeed` WITHOUT etag/lastModified/bodyHash.
    fetcherResultOverrides["https://example.com/notafeed.rss"] = {
      error: "not a feed: html",
      status: 200,
      notAFeed: true,
    };

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    const body = (await res.json()) as { failed?: number; notAFeed?: number };
    expect(body.failed).toBeGreaterThanOrEqual(1);
    expect(body.notAFeed).toBe(1);

    const row = sourceFetchStateWrites
      .find((w) => w.fn === "ingest_set_source_fetch_state")
      ?.rows.find((r) => r.id === "src-health-notafeed");
    expect(row).toBeDefined();
    // No fresh validators on the wire for a notAFeed result -- the stored
    // ones must be kept untouched, never blanked or replaced by the bad
    // body's own etag/hash.
    expect(row?.fetch_etag).toBe('W/"stored-etag"');
    expect(row?.fetch_body_hash).toBe("stored-body-hash");
    expect(row?.fetch_fail_streak).toBe(4);
  });

  it(
    "drops a row whose (source_id, content_hash) already exists under a " +
      "different url instead of retrying it per-row [migration 041 F2]",
    async () => {
      const handler = await importIngestHandler();
      if (!handler) throw new Error("unreachable: handler tripwire above must throw");

      const rssSource = {
        id: "src-041-crossdupe",
        name: "Cross Dupe Fixture",
        slug: "crossdupe-fixture",
        url: "https://example.com",
        rss_url: "https://example.com/crossdupe.rss",
      };
      const item = {
        title: "Republished under a new URL",
        link: "https://example.com/crossdupe/new-url",
        contentSnippet: "Same story, new address.",
      };
      // Pre-compute the EXACT content_hash the real (unmocked) normalizer
      // will produce for this item, so the seeded "existing" pair actually
      // collides — a hand-picked hash string would just prove the guard
      // query works, not that it keys on the field the SUT really uses.
      const [{ content_hash: existingHash }] = normalizeArticles(rssSource, [item]);

      fakeSources.push({ ...rssSource, active: true });
      // Simulate an article already stored (e.g. from a prior cycle, under
      // the outlet's OLD url) sharing this exact (source_id, content_hash).
      existingArticleHashPairs.push({
        source_id: rssSource.id,
        content_hash: existingHash,
      });
      fetcherItems["https://example.com/crossdupe.rss"] = [item];

      const res = await handler(
        authedRequest("http://localhost/ingest", { method: "POST" }),
      );
      const body = (await res.json()) as {
        dedupedInBatch?: number;
        rowErrors?: number;
      };

      // The row never reaches an upsert call at all -- neither the batched
      // attempt nor a per-row fallback -- so the simulated 23505 in the
      // fake's `upsert` never fires and `rowErrors` stays 0.
      expect(articlesUpsertCalls).toHaveLength(0);
      expect(upserted).toHaveLength(0);
      expect(body.dedupedInBatch).toBeGreaterThanOrEqual(1);
      expect(body.rowErrors).toBe(0);
    },
  );

  it("propagates an SSRF guard rejection as fetch_last_status 0 without disturbing stored validators [SEC-01]", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-sec01-ssrf",
      name: "SSRF Fixture",
      slug: "ssrf-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/ssrf.rss",
      active: true,
      fetch_etag: 'W/"seeded"',
      fetch_last_modified: "Mon, 01 Jan 2024 00:00:00 GMT",
      fetch_body_hash: "seeded-hash",
    });
    // fetchFeed is mocked in this file (see the top-of-file vi.mock) — this
    // override simulates the real (unmocked, fetcher.test.ts-covered)
    // guard's rejection shape for a literal link-local target: status 0,
    // no items, an error string identifying the blocked range.
    fetcherResultOverrides["https://example.com/ssrf.rss"] = {
      status: 0,
      error: "URL rejected: literal IP in blocked range (link-local 169.254.0.0/16)",
    };

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    const body = (await res.json()) as { failed?: number };

    expect(body.failed).toBeGreaterThanOrEqual(1);
    expect(sourceFetchStateWrites).toHaveLength(1);
    expect(sourceFetchStateWrites[0]?.fn).toBe("ingest_set_source_fetch_state");
    const row = sourceFetchStateWrites[0]?.rows.find(
      (r) => r.id === "src-sec01-ssrf",
    );
    expect(row).toBeDefined();
    expect(row?.fetch_last_status).toBe(0);
    // A guard rejection carries no fresh validators (it never reached a
    // 2xx), so the write must keep whatever was already stored rather than
    // blanking it to null.
    expect(row?.fetch_etag).toBe('W/"seeded"');
  });
});

// ---------------------------------------------------------------------------
// Batch de-dup (migration 041) — a pure-function unit test against the
// exported helper, since the intra-cycle `seenIntraCycle` guard already
// prevents a duplicate (source_id, content_hash) pair from ever reaching
// `allRows` in the full handler pipeline (this is the last-line-of-defense
// path, exercised directly rather than by fighting that guard end-to-end).
// ---------------------------------------------------------------------------

describe("dedupeBySourceContentHash [migration 041]", () => {
  it("drops rows that repeat an earlier row's (source_id, content_hash), keeping the first", async () => {
    const mod = (await import("../../supabase/functions/ingest/index.ts")) as {
      dedupeBySourceContentHash: <T extends { source_id: string; content_hash: string }>(
        rows: readonly T[],
      ) => { rows: T[]; deduped: number };
    };

    const rows = [
      { source_id: "s1", content_hash: "h1", url: "https://a" },
      { source_id: "s1", content_hash: "h1", url: "https://b" }, // dup of row 0
      { source_id: "s1", content_hash: "h2", url: "https://c" },
      { source_id: "s2", content_hash: "h1", url: "https://d" }, // different source, not a dup
    ];

    const { rows: out, deduped } = mod.dedupeBySourceContentHash(rows);

    expect(deduped).toBe(1);
    expect(out.map((r) => r.url)).toEqual(["https://a", "https://c", "https://d"]);
  });
});

// ---------------------------------------------------------------------------
// Headline-version collection (migration 056, U-07 collection half) — a
// pure-function unit test against the exported `recordTitleVersions`
// helper, the same technique `dedupeBySourceContentHash` above uses:
// direct import + a hand-built `chunk`, asserting against the mocked
// Supabase client's `titleVersionInsertCalls` / `articlesUrlLookupCalls`
// sinks declared at the top of this file. `storedArticlesByUrl` stands in
// for the row `recordTitleVersions`'s bounded `select(...).in("url", ...)`
// would read back from `articles`.
// ---------------------------------------------------------------------------

type RecordTitleVersionsChunkRow = { url: string; title: string; source_id: string };
type RecordTitleVersionsFn = (
  supabase: unknown,
  chunk: ReadonlyArray<RecordTitleVersionsChunkRow>,
) => Promise<number>;

async function importRecordTitleVersions(): Promise<{
  recordTitleVersions: RecordTitleVersionsFn;
  supabase: unknown;
}> {
  const mod = (await import("../../supabase/functions/ingest/index.ts")) as {
    recordTitleVersions: RecordTitleVersionsFn;
  };
  const { createServiceClient } = (await import(
    "../../supabase/functions/_shared/supabase.ts"
  )) as { createServiceClient: () => unknown };
  return { recordTitleVersions: mod.recordTitleVersions, supabase: createServiceClient() };
}

describe("recordTitleVersions [migration 056, U-07 collection half]", () => {
  it("records exactly one row with the right article_id/source_id/old_title/new_title when the stored title differs", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    storedArticlesByUrl["https://example.com/changed"] = {
      id: "article-changed",
      title: "Eski başlık",
      source_id: "source-1",
    };
    const chunk: RecordTitleVersionsChunkRow[] = [
      { url: "https://example.com/changed", title: "Yeni başlık", source_id: "source-1" },
    ];

    const { titleVersions: count } = await recordTitleVersions(supabase, chunk);

    expect(count).toBe(1);
    expect(titleVersionInsertCalls).toHaveLength(1);
    expect(titleVersionInsertCalls[0]).toEqual([
      {
        article_id: "article-changed",
        source_id: "source-1",
        old_title: "Eski başlık",
        new_title: "Yeni başlık",
      },
    ]);
  });

  it("does not insert when the title is unchanged", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    storedArticlesByUrl["https://example.com/unchanged"] = {
      id: "article-unchanged",
      title: "Aynı başlık",
      source_id: "source-1",
    };
    const chunk: RecordTitleVersionsChunkRow[] = [
      { url: "https://example.com/unchanged", title: "Aynı başlık", source_id: "source-1" },
    ];

    const { titleVersions: count } = await recordTitleVersions(supabase, chunk);

    expect(count).toBe(0);
    expect(titleVersionInsertCalls).toHaveLength(0);
  });

  it("treats a trim-only whitespace difference as unchanged but a bare case change as changed", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    storedArticlesByUrl["https://example.com/whitespace"] = {
      id: "article-whitespace",
      title: "Aynı başlık",
      source_id: "source-1",
    };
    storedArticlesByUrl["https://example.com/case"] = {
      id: "article-case",
      title: "degisen baslik",
      source_id: "source-1",
    };
    const chunk: RecordTitleVersionsChunkRow[] = [
      // Only leading/trailing whitespace differs from the stored title —
      // NOT a change once both sides are `.trim()`-ed.
      { url: "https://example.com/whitespace", title: "  Aynı başlık  ", source_id: "source-1" },
      // Only casing differs — the brief's contract says this IS a change:
      // no case/punctuation normalization, exact string compare only.
      { url: "https://example.com/case", title: "DEGISEN BASLIK", source_id: "source-1" },
    ];

    const { titleVersions: count } = await recordTitleVersions(supabase, chunk);

    expect(count).toBe(1);
    expect(titleVersionInsertCalls).toHaveLength(1);
    expect(titleVersionInsertCalls[0]).toEqual([
      {
        article_id: "article-case",
        source_id: "source-1",
        old_title: "degisen baslik",
        new_title: "DEGISEN BASLIK",
      },
    ]);
  });

  it("does not insert when the chunk's url has no matching stored row", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    // Deliberately nothing seeded into storedArticlesByUrl for this url.
    const chunk: RecordTitleVersionsChunkRow[] = [
      { url: "https://example.com/never-stored", title: "Herhangi bir şey", source_id: "source-1" },
    ];

    const { titleVersions: count } = await recordTitleVersions(supabase, chunk);

    expect(count).toBe(0);
    expect(titleVersionInsertCalls).toHaveLength(0);
  });

  it("batches two changed titles in one chunk into a single insert call carrying two rows", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    storedArticlesByUrl["https://example.com/multi-1"] = {
      id: "article-multi-1",
      title: "Eski C",
      source_id: "source-1",
    };
    storedArticlesByUrl["https://example.com/multi-2"] = {
      id: "article-multi-2",
      title: "Eski D",
      source_id: "source-2",
    };
    const chunk: RecordTitleVersionsChunkRow[] = [
      { url: "https://example.com/multi-1", title: "Yeni C", source_id: "source-1" },
      { url: "https://example.com/multi-2", title: "Yeni D", source_id: "source-2" },
    ];

    const { titleVersions: count } = await recordTitleVersions(supabase, chunk);

    expect(count).toBe(2);
    // Exactly ONE insert call carrying both rows, not two separate calls.
    expect(titleVersionInsertCalls).toHaveLength(1);
    expect(titleVersionInsertCalls[0]).toHaveLength(2);
    expect(titleVersionInsertCalls[0]).toEqual([
      {
        article_id: "article-multi-1",
        source_id: "source-1",
        old_title: "Eski C",
        new_title: "Yeni C",
      },
      {
        article_id: "article-multi-2",
        source_id: "source-2",
        old_title: "Eski D",
        new_title: "Yeni D",
      },
    ]);
  });

  it("looks the chunk up with exactly one select bounded to the chunk's urls", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    storedArticlesByUrl["https://example.com/bound-1"] = {
      id: "article-bound-1",
      title: "X",
      source_id: "source-1",
    };
    // The other two urls are deliberately never stored -- they still count
    // toward the bound, proving the lookup covers the whole chunk, not just
    // the rows that happen to already exist.
    const chunk: RecordTitleVersionsChunkRow[] = [
      { url: "https://example.com/bound-1", title: "Y", source_id: "source-1" },
      { url: "https://example.com/bound-2", title: "Z", source_id: "source-1" },
      { url: "https://example.com/bound-3", title: "W", source_id: "source-1" },
    ];

    await recordTitleVersions(supabase, chunk);

    expect(articlesUrlLookupCalls).toHaveLength(1);
    expect(articlesUrlLookupCalls[0].urls).toHaveLength(chunk.length);
    expect(articlesUrlLookupCalls[0].urls).toEqual(chunk.map((r) => r.url));
  });

  it("skips the insert call entirely (not an empty-array call) when nothing changed", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    storedArticlesByUrl["https://example.com/no-change"] = {
      id: "article-no-change",
      title: "Sabit başlık",
      source_id: "source-1",
    };
    const chunk: RecordTitleVersionsChunkRow[] = [
      { url: "https://example.com/no-change", title: "Sabit başlık", source_id: "source-1" },
    ];

    const { titleVersions: count } = await recordTitleVersions(supabase, chunk);

    expect(count).toBe(0);
    // Not just "no rows recorded" -- the insert() call must never happen.
    expect(titleVersionInsertCalls).toHaveLength(0);
  });

  it("returns 0 on an empty chunk without making any calls", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    const { titleVersions: count } = await recordTitleVersions(supabase, []);

    expect(count).toBe(0);
    expect(articlesUrlLookupCalls).toHaveLength(0);
    expect(titleVersionInsertCalls).toHaveLength(0);
  });

  it("never throws: a synchronous throw from the Supabase client degrades to 0", async () => {
    const { recordTitleVersions } = await importRecordTitleVersions();

    const throwingSupabase = {
      from: () => {
        throw new Error("simulated client failure");
      },
    };
    const chunk: RecordTitleVersionsChunkRow[] = [
      { url: "https://example.com/throws", title: "Bir şey", source_id: "source-1" },
    ];

    await expect(recordTitleVersions(throwingSupabase, chunk)).resolves.toEqual({ titleVersions: 0, titleWriteBacks: 0 });
  });

  it("degrades to 0 (never throws) when the lookup select itself returns an error", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    forcedTitleLookupError = "simulated select failure";
    const chunk: RecordTitleVersionsChunkRow[] = [
      { url: "https://example.com/select-fails", title: "Bir şey", source_id: "source-1" },
    ];

    await expect(recordTitleVersions(supabase, chunk)).resolves.toEqual({ titleVersions: 0, titleWriteBacks: 0 });
    expect(titleVersionInsertCalls).toHaveLength(0);
  });

  it("degrades to 0 (never throws) when the insert itself returns an error", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    storedArticlesByUrl["https://example.com/insert-fails"] = {
      id: "article-insert-fails",
      title: "Eski başlık",
      source_id: "source-1",
    };
    forcedTitleVersionInsertError = "simulated insert failure";
    const chunk: RecordTitleVersionsChunkRow[] = [
      { url: "https://example.com/insert-fails", title: "Yeni başlık", source_id: "source-1" },
    ];

    await expect(recordTitleVersions(supabase, chunk)).resolves.toMatchObject({ titleVersions: 0 });
    // The insert was attempted (and failed) -- distinguishes this from the
    // "nothing changed, insert never called" case above.
    expect(titleVersionInsertCalls).toHaveLength(1);
  });

  // MF-02: the ingest cycle runs every 3 minutes and `articles.title` is
  // never updated by the upsert (`ignoreDuplicates: true` on `url`), so a
  // headline that stays changed presents the SAME chunk again next cycle.
  // Without a dedupe key the row would be re-recorded every cycle it stays
  // changed; migration 056's (article_id, new_title_hash) unique index +
  // `ignoreDuplicates: true` on the upsert must collapse that to one row.
  it("re-recording the same (article_id, new_title) pair on a later cycle inserts nothing new [MF-02]", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    storedArticlesByUrl["https://example.com/dup-cycle"] = {
      id: "article-dup-cycle",
      title: "Eski başlık",
      source_id: "source-1",
    };
    const chunk: RecordTitleVersionsChunkRow[] = [
      { url: "https://example.com/dup-cycle", title: "Yeni başlık", source_id: "source-1" },
    ];

    const { titleVersions: first } = await recordTitleVersions(supabase, chunk);
    expect(first).toBe(1);

    // Same chunk presented again, as it would be on the next 3-minute
    // cycle while the item stays in the feed with the same new title.
    const { titleVersions: second } = await recordTitleVersions(supabase, chunk);
    expect(second).toBe(0);
    // Both cycles attempt the upsert -- the dedupe happens at the DB layer
    // (unique index + ignoreDuplicates), not by skipping the call.
    expect(titleVersionInsertCalls).toHaveLength(2);
  });

  // MF-03: `articles.url` is globally unique across all outlets, but a
  // syndicating/linking feed can still present another outlet's url under
  // its OWN source_id. The stored row's source_id must be checked, not
  // just its url, or the change gets attributed to the wrong outlet.
  it("never attributes a title change to a stored row belonging to a different source_id [MF-03]", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    storedArticlesByUrl["https://example.com/cross-source"] = {
      id: "article-cross-source",
      title: "Eski başlık",
      source_id: "source-original",
    };
    const chunk: RecordTitleVersionsChunkRow[] = [
      {
        url: "https://example.com/cross-source",
        title: "Yeni başlık",
        source_id: "source-syndicator",
      },
    ];

    const { titleVersions: count } = await recordTitleVersions(supabase, chunk);

    expect(count).toBe(0);
    expect(titleVersionInsertCalls).toHaveLength(0);
  });

  // MF-05: a full 500-url `.in(...)` lookup can push the PostgREST request
  // URI past proxy request-line limits and fail (silently, per the
  // degrade-to-0 discipline above). Sub-batching the lookup keeps every
  // select request small while the write stays a single call.
  it("sub-batches a 500-row chunk's lookup into selects of at most 100 urls, and still makes one upsert call [MF-05]", async () => {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();

    const chunk: RecordTitleVersionsChunkRow[] = [];
    for (let n = 0; n < 500; n++) {
      const url = `https://example.com/batch-${n}`;
      storedArticlesByUrl[url] = {
        id: `article-batch-${n}`,
        // Only the first url's title actually changes -- enough to prove
        // the single upsert call still carries the right row while the
        // lookup itself is sub-batched.
        title: n === 0 ? "Eski başlık" : `Sabit başlık ${n}`,
        source_id: "source-1",
      };
      chunk.push({ url, title: n === 0 ? "Yeni başlık" : `Sabit başlık ${n}`, source_id: "source-1" });
    }

    const { titleVersions: count } = await recordTitleVersions(supabase, chunk);

    expect(count).toBe(1);
    expect(articlesUrlLookupCalls).toHaveLength(5);
    for (const call of articlesUrlLookupCalls) {
      expect(call.urls.length).toBeLessThanOrEqual(100);
    }
    expect(
      articlesUrlLookupCalls.reduce((sum, call) => sum + call.urls.length, 0),
    ).toBe(500);
    expect(titleVersionInsertCalls).toHaveLength(1);
    expect(titleVersionInsertCalls[0]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: recordTitleVersions must never block, delay or reduce the
// article upsert, and the cycle's one-line JSON summary must report the
// count -- exercised through the full ingest handler so the call-site
// wiring (not just the helper in isolation) is covered.
// ---------------------------------------------------------------------------

describe("ingest cycle + recordTitleVersions integration [migration 056]", () => {
  it("reports the titleVersions count in the cycle's one-line JSON summary", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-title-stats",
      name: "Title Stats Fixture",
      slug: "title-stats-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/title-stats.rss",
      active: true,
    });
    fetchResponses["https://example.com/title-stats.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>Yeni başlık</title><link>https://example.com/title-stats/1</link>" +
        "</item></channel></rss>",
    };
    fetcherItems["https://example.com/title-stats.rss"] = [
      { title: "Yeni başlık", link: "https://example.com/title-stats/1" },
    ];
    storedArticlesByUrl["https://example.com/title-stats/1"] = {
      id: "article-title-stats",
      title: "Eski başlık",
      source_id: "src-title-stats",
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await handler(
        authedRequest("http://localhost/ingest", { method: "POST" }),
      );
      expect(res.status).toBe(200);

      const cycleCall = logSpy.mock.calls.find(
        (args) => args[0] === "[ingest] cycle",
      ) as [string, string] | undefined;
      expect(cycleCall).toBeDefined();
      const summary = JSON.parse(cycleCall?.[1] ?? "{}") as { titleVersions?: number };
      expect(summary.titleVersions).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("a select error in the title-version lookup never touches the article upsert or the cycle's inserted count", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-title-select-err",
      name: "Title Select Error Fixture",
      slug: "title-select-err-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/title-select-err.rss",
      active: true,
    });
    fetchResponses["https://example.com/title-select-err.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>Bir haber</title><link>https://example.com/title-select-err/1</link>" +
        "</item></channel></rss>",
    };
    fetcherItems["https://example.com/title-select-err.rss"] = [
      { title: "Bir haber", link: "https://example.com/title-select-err/1" },
    ];
    forcedTitleLookupError = "simulated select failure";

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );

    expect(res.status).toBe(200);
    expect(upserted.length).toBe(1);
    expect(ingestCycleInserts).toHaveLength(1);
    expect((ingestCycleInserts[0] as { inserted?: number }).inserted).toBe(1);
    expect(titleVersionInsertCalls).toHaveLength(0);
  });

  it("an insert error while writing article_title_versions never touches the article upsert or the cycle's inserted count", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-title-insert-err",
      name: "Title Insert Error Fixture",
      slug: "title-insert-err-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/title-insert-err.rss",
      active: true,
    });
    fetchResponses["https://example.com/title-insert-err.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>Yeni haber</title><link>https://example.com/title-insert-err/1</link>" +
        "</item></channel></rss>",
    };
    fetcherItems["https://example.com/title-insert-err.rss"] = [
      { title: "Yeni haber", link: "https://example.com/title-insert-err/1" },
    ];
    // Seeded with a DIFFERENT title so recordTitleVersions actually attempts
    // the insert (and not just short-circuits on "nothing changed").
    storedArticlesByUrl["https://example.com/title-insert-err/1"] = {
      id: "article-title-insert-err",
      title: "Eski haber",
      source_id: "src-title-insert-err",
    };
    forcedTitleVersionInsertError = "simulated insert failure";

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );

    expect(res.status).toBe(200);
    expect(upserted.length).toBe(1);
    expect(ingestCycleInserts).toHaveLength(1);
    expect((ingestCycleInserts[0] as { inserted?: number }).inserted).toBe(1);
    expect(titleVersionInsertCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Chunked pre-filter (migration 074 §4) -- `dropExistingSourceContentHashRows`
// chunks ROWS by PREFILTER_CHUNK (100), one lookup per chunk instead of a
// single call over the whole batch. Since migration 130 each lookup is the
// pairwise `existing_source_content_hash_pairs(p_source_ids, p_hashes)` RPC
// (index-aligned per-row arrays) instead of a source x hash `.in().in()`
// cross product; PGRST202 (130 not applied yet) falls back to the old probe.
// ---------------------------------------------------------------------------

describe("chunked (source_id, content_hash) pre-filter [migration 074]", () => {
  it("splits 250 rows into 3 pairwise RPC lookups of at most 100 pairs each, dropping existing pairs in every chunk", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const rssSource = {
      id: "src-074-prefilter",
      name: "Prefilter Fixture",
      slug: "prefilter-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/prefilter.rss",
    };
    const items = Array.from({ length: 250 }, (_, n) => ({
      title: `Prefilter item ${n}`,
      link: `https://example.com/prefilter/${n}`,
    }));
    const normalized = normalizeArticles(rssSource, items);

    // Seed one already-"existing" (source_id, content_hash) pair per
    // expected chunk (0-99, 100-199, 200-249) so all three chunks exercise
    // a drop, not just the first.
    existingArticleHashPairs.push(
      { source_id: rssSource.id, content_hash: normalized[0]!.content_hash },
      { source_id: rssSource.id, content_hash: normalized[100]!.content_hash },
      { source_id: rssSource.id, content_hash: normalized[200]!.content_hash },
    );

    fakeSources.push({ ...rssSource, active: true });
    fetcherItems["https://example.com/prefilter.rss"] = items;

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    const body = (await res.json()) as { dedupedInBatch?: number };

    expect(prefilterLookupCalls).toHaveLength(3);
    for (const call of prefilterLookupCalls) {
      // The two RPC arrays are index-aligned pairs: always the same length.
      expect(call.sourceIds.length).toBe(call.hashes.length);
      expect(call.hashes.length).toBeLessThanOrEqual(100);
    }
    expect(
      prefilterLookupCalls.reduce((sum, c) => sum + c.hashes.length, 0),
    ).toBe(250);
    expect(
      prefilterLookupCalls.reduce((sum, c) => sum + c.sourceIds.length, 0),
    ).toBe(250);
    // Migration 130 is "applied" in this mock: the legacy cross-product
    // probe is never touched.
    expect(legacyPrefilterLookupCalls).toHaveLength(0);
    // One dropped row per chunk -- 3 total.
    expect(body.dedupedInBatch).toBe(3);
    expect(upserted.length).toBe(247);
  });

  it("a forced chunk lookup error degrades only that chunk and records prefilter_errors = 1", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const rssSource = {
      id: "src-074-prefilter-err",
      name: "Prefilter Error Fixture",
      slug: "prefilter-error-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/prefilter-err.rss",
    };
    const items = Array.from({ length: 150 }, (_, n) => ({
      title: `Prefilter err item ${n}`,
      link: `https://example.com/prefilter-err/${n}`,
    }));

    fakeSources.push({ ...rssSource, active: true });
    fetcherItems["https://example.com/prefilter-err.rss"] = items;
    // Fail the 2nd chunk (rows 100-149) -- the 1st chunk (0-99) must still
    // succeed and go through the upsert unaffected.
    forcedPrefilterErrorOnCall = 2;

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    expect(res.status).toBe(200);

    expect(prefilterLookupCalls).toHaveLength(2);
    // The failing chunk's rows are KEPT (not dropped), so all 150 items
    // still reach the upsert.
    expect(upserted.length).toBe(150);

    expect(ingestCycleInserts).toHaveLength(1);
    expect(
      (ingestCycleInserts[0] as { prefilter_errors?: number }).prefilter_errors,
    ).toBe(1);
    // Any error other than PGRST202 (here a statement timeout) is fail-open,
    // NOT a reason to run the expensive legacy cross-product probe.
    expect(legacyPrefilterLookupCalls).toHaveLength(0);
  });

  it("sends the per-row pairs, index-aligned with the chunk rows: repeated source ids, not deduped sets", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const srcA = {
      id: "src-130-pairs-a",
      name: "Pairs A",
      slug: "pairs-a",
      url: "https://a.example.com",
      rss_url: "https://a.example.com/pairs.rss",
    };
    const srcB = {
      id: "src-130-pairs-b",
      name: "Pairs B",
      slug: "pairs-b",
      url: "https://b.example.com",
      rss_url: "https://b.example.com/pairs.rss",
    };
    const itemsA = [1, 2, 3].map((n) => ({
      title: `Pairs A story ${n}`,
      link: `https://a.example.com/pairs/${n}`,
    }));
    const itemsB = [1, 2].map((n) => ({
      title: `Pairs B story ${n}`,
      link: `https://b.example.com/pairs/${n}`,
    }));
    const expectedPairs = [
      ...normalizeArticles(srcA, itemsA),
      ...normalizeArticles(srcB, itemsB),
    ].map((r) => ({ source_id: r.source_id, content_hash: r.content_hash }));
    expect(expectedPairs).toHaveLength(5);

    fakeSources.push({ ...srcA, active: true }, { ...srcB, active: true });
    fetcherItems[srcA.rss_url] = itemsA;
    fetcherItems[srcB.rss_url] = itemsB;

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    expect(res.status).toBe(200);

    // 5 rows fit one chunk: ONE call carrying FIVE source ids (two distinct,
    // so repeated) and FIVE hashes -- the rows' pairs, not {A,B} x 5 hashes.
    expect(prefilterLookupCalls).toHaveLength(1);
    const call = prefilterLookupCalls[0]!;
    expect(call.sourceIds).toHaveLength(5);
    expect(call.hashes).toHaveLength(5);
    expect(new Set(call.sourceIds).size).toBe(2);
    const zipped = call.sourceIds.map((sid, i) => ({
      source_id: sid,
      content_hash: call.hashes[i]!,
    }));
    const key = (p: { source_id: string; content_hash: string }) =>
      `${p.source_id}\x1f${p.content_hash}`;
    expect(zipped.map(key).sort()).toEqual(expectedPairs.map(key).sort());
    // Rows were grouped by source before the lookup: each source's pairs are contiguous.
    expect(call.sourceIds).toEqual([
      srcA.id,
      srcA.id,
      srcA.id,
      srcB.id,
      srcB.id,
    ]);
    expect(upserted.length).toBe(5);
  });

  it("an existing (s1,h2) drops nothing when the chunk holds (s1,h1) and (s2,h2): the match is pairwise", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const s1 = {
      id: "src-130-cross-s1",
      name: "Cross S1",
      slug: "cross-s1",
      url: "https://s1.example.com",
      rss_url: "https://s1.example.com/cross.rss",
    };
    const s2 = {
      id: "src-130-cross-s2",
      name: "Cross S2",
      slug: "cross-s2",
      url: "https://s2.example.com",
      rss_url: "https://s2.example.com/cross.rss",
    };
    const item1 = { title: "Cross one", link: "https://s1.example.com/cross/1" };
    const item2 = { title: "Cross two", link: "https://s2.example.com/cross/2" };
    const h2 = normalizeArticles(s2, [item2])[0]!.content_hash;
    // s1 stores h2, but s1's own row in this chunk has h1, and h2 belongs to s2.
    existingArticleHashPairs.push({ source_id: s1.id, content_hash: h2 });

    fakeSources.push({ ...s1, active: true }, { ...s2, active: true });
    fetcherItems[s1.rss_url] = [item1];
    fetcherItems[s2.rss_url] = [item2];

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    const body = (await res.json()) as { dedupedInBatch?: number };

    expect(res.status).toBe(200);
    expect(prefilterLookupCalls).toHaveLength(1);
    expect(body.dedupedInBatch ?? 0).toBe(0);
    expect(upserted.length).toBe(2);
  });

  it("falls back to the legacy probe on PGRST202, still drops the existing pair and warns once across chunks", async () => {
    // The warn-once flag is module state: take a fresh copy of the module so
    // this test does not depend on which test ran before it.
    vi.resetModules();
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const rssSource = {
      id: "src-130-fallback",
      name: "Fallback Fixture",
      slug: "fallback-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/fallback.rss",
    };
    const items = Array.from({ length: 150 }, (_, n) => ({
      title: `Fallback item ${n}`,
      link: `https://example.com/fallback/${n}`,
    }));
    const normalized = normalizeArticles(rssSource, items);
    existingArticleHashPairs.push({
      source_id: rssSource.id,
      content_hash: normalized[0]!.content_hash,
    });

    fakeSources.push({ ...rssSource, active: true });
    fetcherItems["https://example.com/fallback.rss"] = items;
    forcedPrefilterRpcMissing = true;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await handler(
        authedRequest("http://localhost/ingest", { method: "POST" }),
      );
      const body = (await res.json()) as { dedupedInBatch?: number };
      expect(res.status).toBe(200);

      // Two chunks (100 + 50): each tries the RPC first (so the function is
      // picked up the moment 130 is applied), then runs the legacy probe.
      expect(prefilterLookupCalls).toHaveLength(2);
      expect(legacyPrefilterLookupCalls).toHaveLength(2);
      expect(legacyPrefilterLookupCalls[0]!.hashes.length).toBeLessThanOrEqual(100);

      // The existing pair is still dropped and nothing else is.
      expect(body.dedupedInBatch).toBe(1);
      expect(upserted.length).toBe(149);
      expect(
        (ingestCycleInserts[0] as { prefilter_errors?: number }).prefilter_errors,
      ).toBe(0);

      // One warning per isolate, not one per chunk.
      const missing = warn.mock.calls.filter((c) =>
        String(c[0]).includes("existing_source_content_hash_pairs missing"),
      );
      expect(missing).toHaveLength(1);
      expect(String(missing[0]![0])).toContain("apply migration 130");
    } finally {
      warn.mockRestore();
    }
  });

  it("the legacy cross-product fallback still compares exact pairs: an existing (s1,h2) drops nothing", async () => {
    vi.resetModules();
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const s1 = {
      id: "src-130-legacy-s1",
      name: "Legacy S1",
      slug: "legacy-s1",
      url: "https://s1.example.com",
      rss_url: "https://s1.example.com/legacy.rss",
    };
    const s2 = {
      id: "src-130-legacy-s2",
      name: "Legacy S2",
      slug: "legacy-s2",
      url: "https://s2.example.com",
      rss_url: "https://s2.example.com/legacy.rss",
    };
    const item1 = { title: "Legacy one", link: "https://s1.example.com/legacy/1" };
    const item2 = { title: "Legacy two", link: "https://s2.example.com/legacy/2" };
    const h2 = normalizeArticles(s2, [item2])[0]!.content_hash;
    existingArticleHashPairs.push({ source_id: s1.id, content_hash: h2 });

    fakeSources.push({ ...s1, active: true }, { ...s2, active: true });
    fetcherItems[s1.rss_url] = [item1];
    fetcherItems[s2.rss_url] = [item2];
    forcedPrefilterRpcMissing = true;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await handler(
        authedRequest("http://localhost/ingest", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      // The legacy probe DID return (s1,h2) -- a cross product -- yet nothing is dropped.
      expect(legacyPrefilterLookupCalls).toHaveLength(1);
      expect(upserted.length).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("an RPC that throws keeps every row and counts one prefilter error, with no legacy fallback", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const rssSource = {
      id: "src-130-rpc-throw",
      name: "RPC Throw Fixture",
      slug: "rpc-throw-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/rpc-throw.rss",
    };
    const items = Array.from({ length: 40 }, (_, n) => ({
      title: `Rpc throw item ${n}`,
      link: `https://example.com/rpc-throw/${n}`,
    }));
    fakeSources.push({ ...rssSource, active: true });
    fetcherItems["https://example.com/rpc-throw.rss"] = items;
    forcedPrefilterRpcThrow = true;

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await handler(
        authedRequest("http://localhost/ingest", { method: "POST" }),
      );
      expect(res.status).toBe(200);

      expect(prefilterLookupCalls).toHaveLength(1);
      expect(legacyPrefilterLookupCalls).toHaveLength(0);
      expect(upserted.length).toBe(40);
      expect(
        (ingestCycleInserts[0] as { prefilter_errors?: number }).prefilter_errors,
      ).toBe(1);
      // One console.error per failing chunk.
      const lookupErrors = err.mock.calls.filter((c) =>
        String(c[0]).includes("existing (source_id, content_hash) lookup"),
      );
      expect(lookupErrors).toHaveLength(1);
    } finally {
      err.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Feed quarantine (migration 074 §4) -- a source whose
// `fetch_quarantined_until` is still in the future is skipped entirely (no
// `fetchFeed` call, no pool slot spent); one whose quarantine already
// expired is fetched normally (a "probe").
// ---------------------------------------------------------------------------

describe("feed quarantine [migration 074]", () => {
  it("never calls fetchFeed for a source whose quarantine is still in the future", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-074-quarantined",
      name: "Quarantined Fixture",
      slug: "quarantined-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/quarantined.rss",
      active: true,
      fetch_fail_streak: 25,
      fetch_quarantined_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    fetcherItems["https://example.com/quarantined.rss"] = [
      { title: "Should never be seen", link: "https://example.com/quarantined/1" },
    ];

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    const body = (await res.json()) as { quarantined?: number };

    expect(fetchFeedCalls.some((c) => c.sourceId === "src-074-quarantined")).toBe(
      false,
    );
    expect(upserted).toHaveLength(0);
    expect(body.quarantined).toBeGreaterThanOrEqual(1);
  });

  it("fetches a source whose quarantine has already expired", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-074-expired-quarantine",
      name: "Expired Quarantine Fixture",
      slug: "expired-quarantine-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/expired-quarantine.rss",
      active: true,
      fetch_fail_streak: 20,
      fetch_quarantined_until: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    fetcherItems["https://example.com/expired-quarantine.rss"] = [
      { title: "Probe item", link: "https://example.com/expired-quarantine/1" },
    ];

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));

    expect(
      fetchFeedCalls.some((c) => c.sourceId === "src-074-expired-quarantine"),
    ).toBe(true);
  });

  it("streak 19 + a failing fetch quarantines for ~1h (streak 20)", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-074-streak19",
      name: "Streak 19 Fixture",
      slug: "streak19-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/streak19.rss",
      active: true,
      fetch_fail_streak: 19,
    });
    fetcherResultOverrides["https://example.com/streak19.rss"] = {
      status: 0,
      error: "simulated network failure",
    };

    const before = Date.now();
    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    const after = Date.now();

    const row = sourceFetchStateWrites
      .find((w) => w.fn === "ingest_set_source_fetch_state")
      ?.rows.find((r) => r.id === "src-074-streak19");
    expect(row).toBeDefined();
    expect(row?.fetch_fail_streak).toBe(20);
    const untilMs = Date.parse(String(row?.fetch_quarantined_until));
    expect(untilMs).toBeGreaterThanOrEqual(before + 3_600_000 - 5_000);
    expect(untilMs).toBeLessThanOrEqual(after + 3_600_000 + 5_000);
  });

  it("a 304 (not modified) resets the streak to 0 and clears quarantine", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-074-reset",
      name: "Reset Fixture",
      slug: "reset-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/reset.rss",
      active: true,
      fetch_fail_streak: 7,
    });
    fetcherItems["https://example.com/reset.rss"] = [
      { title: "Ignored", link: "https://example.com/reset/1" },
    ];
    fetcherResultOverrides["https://example.com/reset.rss"] = { notModified: true };

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));

    const row = sourceFetchStateWrites
      .find((w) => w.fn === "ingest_set_source_fetch_state")
      ?.rows.find((r) => r.id === "src-074-reset");
    expect(row).toBeDefined();
    expect(row?.fetch_fail_streak).toBe(0);
    expect(row?.fetch_quarantined_until).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Headline write-back (migration 074 §1/§4, decision (b)) -- a changed,
// same-source headline calls `apply_article_title_edits` with FULL,
// unclamped titles; an RPC error is swallowed.
// ---------------------------------------------------------------------------

describe("headline write-back [migration 074]", () => {
  it("calls apply_article_title_edits with full titles when a headline changes", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-074-writeback",
      name: "Write-back Fixture",
      slug: "writeback-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/writeback.rss",
      active: true,
    });
    fetcherItems["https://example.com/writeback.rss"] = [
      { title: "Güncellenmiş başlık", link: "https://example.com/writeback/1" },
    ];
    storedArticlesByUrl["https://example.com/writeback/1"] = {
      id: "article-writeback",
      title: "Eski başlık",
      source_id: "src-074-writeback",
    };

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    expect(res.status).toBe(200);

    expect(titleEditRpcCalls).toHaveLength(1);
    expect(titleEditRpcCalls[0]).toEqual([
      {
        article_id: "article-writeback",
        old_title: "Eski başlık",
        new_title: "Güncellenmiş başlık",
      },
    ]);
  });

  it("swallows an apply_article_title_edits RPC error -- the cycle still returns 200 and articles are still upserted", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-074-writeback-err",
      name: "Write-back Error Fixture",
      slug: "writeback-error-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/writeback-err.rss",
      active: true,
    });
    fetcherItems["https://example.com/writeback-err.rss"] = [
      { title: "Yeni başlık", link: "https://example.com/writeback-err/1" },
    ];
    storedArticlesByUrl["https://example.com/writeback-err/1"] = {
      id: "article-writeback-err",
      title: "Eski başlık",
      source_id: "src-074-writeback-err",
    };
    forcedTitleEditRpcError = "simulated apply_article_title_edits failure";

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(upserted.length).toBe(1);
    expect(titleEditRpcCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// silent-feeds: a fetched feed's fresh validators (etag / last-modified / body
// hash) are committed only after every one of its rows is durable. A feed
// whose rows were skipped or failed keeps its OLD validators, so the next
// cycle re-offers it instead of getting a 304 / body-hash hit forever.
// ---------------------------------------------------------------------------
describe("validators follow row durability [silent-feeds]", () => {
  function seedSource(
    id: string,
    extra: Record<string, unknown> = {},
  ): string {
    const rssUrl = `https://example.com/${id}.rss`;
    fakeSources.push({
      id,
      name: id,
      slug: id,
      url: "https://example.com",
      rss_url: rssUrl,
      active: true,
      fetch_etag: null,
      fetch_last_modified: null,
      fetch_body_hash: null,
      fetch_fail_streak: 3,
      ...extra,
    });
    return rssUrl;
  }

  function items(id: string, n: number): MockFeedItem[] {
    return Array.from({ length: n }, (_, i) => ({
      title: `${id} baslik ${i + 1} ozel haber metni ${i * 7919}`,
      link: `https://example.com/${id}/${i + 1}`,
      pubDate: "Mon, 01 Jan 2024 00:00:00 GMT",
    }));
  }

  async function run() {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");
    const res = await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    return (await res.json()) as Record<string, unknown>;
  }

  function persisted(id: string) {
    return sourceFetchStateWrites.flatMap((w) => w.rows).find((r) => r.id === id);
  }

  it("a poisoned row withholds the fresh validators (old ones kept, streak reset) and the next call re-sends the old etag", async () => {
    const rssUrl = seedSource("sf-poison", {
      fetch_etag: 'W/"old"',
      fetch_body_hash: "stored-hash",
    });
    fetcherItems[rssUrl] = items("sf-poison", 4);
    fetcherResultOverrides[rssUrl] = { etag: '"new"', bodyHash: "hash-new" };
    forcedPoisonedUrl = "https://example.com/sf-poison/2";

    const body = await run();

    expect(body.validatorsWithheld).toBe(1);
    expect(body.rowErrors).toBe(1);
    const row = persisted("sf-poison");
    expect(row?.fetch_etag).toBe('W/"old"');
    expect(row?.fetch_body_hash).toBe("stored-hash");
    expect(row?.fetch_fail_streak).toBe(0);
    expect(row?.fetch_last_status).toBe(200);

    forcedPoisonedUrl = null;
    sourceFetchStateWrites.length = 0;
    await run();
    expect(fetchFeedCalls.at(-1)?.sourceId).toBe("sf-poison");
    expect(fetchFeedCalls.at(-1)?.cached?.etag).toBe('W/"old"');
  });

  it("commits the fresh validators once every row was dropped as already stored", async () => {
    const rssUrl = seedSource("sf-stored", {
      fetch_etag: 'W/"old2"',
      fetch_body_hash: "stored-hash-2",
    });
    const feedItems = items("sf-stored", 3);
    fetcherItems[rssUrl] = feedItems;
    fetcherResultOverrides[rssUrl] = { etag: '"new2"', bodyHash: "hash-new2" };
    const normalized = normalizeArticles(
      { id: "sf-stored", name: "sf-stored", slug: "sf-stored", url: "https://example.com", rss_url: rssUrl },
      feedItems,
      Date.now(),
    );
    existingArticleHashPairs = normalized.map((r) => ({
      source_id: r.source_id,
      content_hash: r.content_hash,
    }));

    const body = await run();

    expect(body.validatorsWithheld).toBe(0);
    expect(body.dedupedInBatch).toBe(3);
    expect(upserted).toHaveLength(0);
    const row = persisted("sf-stored");
    expect(row?.fetch_etag).toBe('"new2"');
    expect(row?.fetch_body_hash).toBe("hash-new2");
  });

  it("two sources: the clean one is committed, the poisoned one withheld, at most two RPC writes", async () => {
    const cleanUrl = seedSource("sf-two-clean", { fetch_etag: 'W/"c-old"', fetch_body_hash: "c-old-hash" });
    const badUrl = seedSource("sf-two-bad", { fetch_etag: 'W/"b-old"', fetch_body_hash: "b-old-hash" });
    fetcherItems[cleanUrl] = items("sf-two-clean", 3);
    fetcherItems[badUrl] = items("sf-two-bad", 3);
    fetcherResultOverrides[cleanUrl] = { etag: '"c-new"', bodyHash: "c-new-hash" };
    fetcherResultOverrides[badUrl] = { etag: '"b-new"', bodyHash: "b-new-hash" };
    forcedPoisonedUrl = "https://example.com/sf-two-bad/1";

    const body = await run();

    expect(body.validatorsWithheld).toBe(1);
    expect(persisted("sf-two-clean")?.fetch_etag).toBe('"c-new"');
    expect(persisted("sf-two-clean")?.fetch_body_hash).toBe("c-new-hash");
    expect(persisted("sf-two-bad")?.fetch_etag).toBe('W/"b-old"');
    expect(persisted("sf-two-bad")?.fetch_body_hash).toBe("b-old-hash");
    expect(sourceFetchStateWrites.length).toBeLessThanOrEqual(2);
    expect(upserted.some((r) => r.source_id === "sf-two-clean")).toBe(true);
  });

  it("a clean single-source cycle still makes exactly one RPC call and the next call sees the fresh etag", async () => {
    const rssUrl = seedSource("sf-clean");
    fetcherItems[rssUrl] = items("sf-clean", 3);
    fetcherResultOverrides[rssUrl] = { etag: '"fresh-e"', lastModified: "Thu, 02 Jan 2025 00:00:00 GMT", bodyHash: "fresh-h" };

    const body = await run();

    expect(body.validatorsWithheld).toBe(0);
    expect(sourceFetchStateWrites).toHaveLength(1);
    expect(sourceFetchStateWrites[0]?.fn).toBe("ingest_set_source_fetch_state");
    expect(persisted("sf-clean")?.fetch_etag).toBe('"fresh-e"');
    expect(persisted("sf-clean")?.fetch_body_hash).toBe("fresh-h");

    await run();
    expect(fetchFeedCalls.at(-1)?.cached?.etag).toBe('"fresh-e"');
    expect(fetchFeedCalls.at(-1)?.cached?.lastModified).toBe("Thu, 02 Jan 2025 00:00:00 GMT");
  });
});

// ---------------------------------------------------------------------------
// Twin articles (migration 113): a headline edit gives an article a new URL
// slug and keeps the numeric id its CMS put in the URL. The url-keyed upsert
// and the (source_id, content_hash) check both miss that, so the edit used to
// become a second row. `source_article_key` (the id) is stored on every row;
// a re-polled item whose key is already stored for the same source under a
// DIFFERENT url is a twin: it is not inserted, its new headline is recorded
// through the existing title-version path instead.
// ---------------------------------------------------------------------------
describe("twin drop: same source_article_key under another url [migration 113]", () => {
  const AKSAM = {
    id: "src-aksam-113",
    name: "Akşam",
    slug: "aksam",
    url: "https://www.aksam.com.tr",
    rss_url: "https://www.aksam.com.tr/rss.xml",
  };
  const URL_A =
    "https://www.aksam.com.tr/guncel/bakan-gulerden-mekke-ittifaki-vurgusu/haber-1708664";
  const URL_B =
    "https://www.aksam.com.tr/guncel/bakan-gulerden-mekke-ittifaki-vurgusu-husilerle-catismaya-girilmeyecek/haber-1708664";
  const TITLE_A = "Bakan Güler'den Mekke ittifakı vurgusu";
  const TITLE_B = "Bakan Güler: Husilerle çatışmaya girilmeyecek";
  const URL_C = "https://www.aksam.com.tr/guncel/ucuncu-baslik/haber-1708664";
  const TITLE_C = "Bakan Güler: üçüncü başlık";

  function seed(
    source: { id: string; name: string; slug: string; url: string; rss_url: string },
    feed: MockFeedItem[],
    extra: Record<string, unknown> = {},
  ): string {
    fakeSources.push({
      ...source,
      active: true,
      fetch_etag: null,
      fetch_last_modified: null,
      fetch_body_hash: null,
      fetch_fail_streak: 0,
      ...extra,
    });
    fetcherItems[source.rss_url] = feed;
    return source.rss_url;
  }

  async function run() {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");
    const res = await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  // `run()` with console.log captured: each entry is one call's args joined by
  // a space, the same shape the log-line assertions below read.
  async function runLogged() {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const body = await run();
      return { body, lines: logSpy.mock.calls.map((args) => args.join(" ")) };
    } finally {
      logSpy.mockRestore();
    }
  }

  const upsertedUrls = () => articlesUpsertCalls.flat().map((r) => r.url);

  function persisted(id: string) {
    return sourceFetchStateWrites.flatMap((w) => w.rows).find((r) => r.id === id);
  }

  it("1. drops the twin, records its headline against the stored article and still commits the validators", async () => {
    const rssUrl = seed(
      AKSAM,
      [{ title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" }],
      { fetch_etag: 'W/"old"', fetch_body_hash: "stored-hash" },
    );
    fetcherResultOverrides[rssUrl] = { etag: '"new"', bodyHash: "hash-new" };
    storedArticlesByKey = [
      { id: "art-1", source_id: AKSAM.id, source_article_key: "1708664", url: URL_A, title: TITLE_A },
    ];

    const { body, lines } = await runLogged();

    // The twin never reaches an upsert call (and an all-twin chunk sends none).
    expect(upsertedUrls()).not.toContain(URL_B);
    expect(articlesUpsertCalls).toHaveLength(0);
    expect(body.twinsDroppedStored).toBe(1);
    expect(body.twinsDroppedIntraFeed).toBe(0);
    expect(body.twinsDropped).toBe(1);
    expect(body.inserted).toBe(0);
    // No second item of the feed shares the key: no intra-feed line is logged.
    expect(lines.filter((l) => l.includes("intra-feed"))).toEqual([]);

    // The new headline is recorded against the STORED article, with no extra
    // url lookup (the stored row was already resolved by the key lookup). The
    // one url select of the cycle is the feed loop's lookup of what is stored
    // (hunt-11), which names the twin's new url and found nothing.
    expect(titleVersionInsertCalls).toEqual([
      [{ article_id: "art-1", source_id: AKSAM.id, old_title: TITLE_A, new_title: TITLE_B }],
    ]);
    expect(titleEditRpcCalls).toEqual([
      [{ article_id: "art-1", old_title: TITLE_A, new_title: TITLE_B }],
    ]);
    expect(articlesUrlLookupCalls).toHaveLength(1);
    expect(articlesUrlLookupCalls[0]?.urls).toEqual([URL_B]);
    expect(body.titleVersions).toBe(1);
    expect(body.titleWriteBacks).toBe(1);

    // A twin counts as stored: the source settles and its validators commit.
    expect(body.validatorsWithheld).toBe(0);
    const row = persisted(AKSAM.id);
    expect(row?.fetch_etag).toBe('"new"');
    expect(row?.fetch_body_hash).toBe("hash-new");
    expect(row?.fetch_fail_streak).toBe(0);
  });

  it("1b. a twin whose headline did not change is dropped without a title version", async () => {
    seed(AKSAM, [{ title: TITLE_A, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" }]);
    storedArticlesByKey = [
      { id: "art-1", source_id: AKSAM.id, source_article_key: "1708664", url: URL_A, title: TITLE_A },
    ];

    const body = await run();

    expect(body.twinsDropped).toBe(1);
    expect(upsertedUrls()).not.toContain(URL_B);
    expect(titleVersionInsertCalls).toHaveLength(0);
    expect(titleEditRpcCalls).toHaveLength(0);
  });

  it("1c. a twin and a new article in one chunk: the new one is upserted, the twin is recorded, and the urls are selected once", async () => {
    const URL_NEW = "https://www.aksam.com.tr/spor/baska-bir-haber/haber-1708999";
    seed(AKSAM, [
      { title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: "Tamamen başka bir haber", link: URL_NEW, pubDate: "Fri, 23 Oct 2026 17:20:00 GMT" },
    ]);
    storedArticlesByKey = [
      { id: "art-1", source_id: AKSAM.id, source_article_key: "1708664", url: URL_A, title: TITLE_A },
    ];

    const body = await run();

    expect(upsertedUrls()).toEqual([URL_NEW]);
    expect(body.twinsDropped).toBe(1);
    expect(body.inserted).toBe(1);
    expect(titleVersionInsertCalls).toHaveLength(1);
    expect(titleVersionInsertCalls[0]).toEqual([
      { article_id: "art-1", source_id: AKSAM.id, old_title: TITLE_A, new_title: TITLE_B },
    ]);
    // ONE url select for the whole cycle (hunt-11): the feed loop's lookup, which
    // names both urls of the feed in feed order. The title-version path selects
    // nothing more: the twin's stored article was resolved through its key, and
    // the new url was already confirmed absent by the lookup.
    expect(articlesUrlLookupCalls).toHaveLength(1);
    expect(articlesUrlLookupCalls[0]?.urls).toEqual([URL_B, URL_NEW]);
  });

  it("2. leaves a row alone when the stored row with that key has the SAME url (the normal re-poll path)", async () => {
    seed(AKSAM, [{ title: TITLE_A, link: URL_A, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" }]);
    storedArticlesByKey = [
      { id: "art-1", source_id: AKSAM.id, source_article_key: "1708664", url: URL_A, title: TITLE_A },
    ];

    const body = await run();

    expect(upsertedUrls()).toEqual([URL_A]);
    expect(body.twinsDropped).toBe(0);
    expect(keyLookupCalls).toHaveLength(1);
  });

  it("2b. keeps the row when ANY match has its url, even beside a different-url match", async () => {
    seed(AKSAM, [{ title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" }]);
    storedArticlesByKey = [
      { id: "art-1", source_id: AKSAM.id, source_article_key: "1708664", url: URL_A, title: TITLE_A },
      { id: "art-2", source_id: AKSAM.id, source_article_key: "1708664", url: URL_B, title: TITLE_B },
    ];

    const body = await run();

    expect(upsertedUrls()).toEqual([URL_B]);
    expect(body.twinsDropped).toBe(0);
  });

  it("3. does not treat the same key under ANOTHER source_id as a twin (exact (source_id, key) pair)", async () => {
    // Two sources in one chunk, so the lookup's two `.in()` lists are a cross
    // product that returns BOTH stored rows. Source X's item carries the key
    // that is stored for source Y, and the other way round.
    const SRC_X = { id: "src-x-113", name: "X", slug: "x-113", url: "https://x.test", rss_url: "https://x.test/rss" };
    const SRC_Y = { id: "src-y-113", name: "Y", slug: "y-113", url: "https://y.test", rss_url: "https://y.test/rss" };
    seed(SRC_X, [{ title: "X haberi bir", link: "https://x.test/a/haber-2222222" }]);
    seed(SRC_Y, [{ title: "Y haberi bir", link: "https://y.test/a/haber-1111111" }]);
    storedArticlesByKey = [
      { id: "art-x", source_id: SRC_X.id, source_article_key: "1111111", url: "https://x.test/old/haber-1111111", title: "x eski" },
      { id: "art-y", source_id: SRC_Y.id, source_article_key: "2222222", url: "https://y.test/old/haber-2222222", title: "y eski" },
    ];

    const body = await run();

    expect(upsertedUrls().sort()).toEqual(["https://x.test/a/haber-2222222", "https://y.test/a/haber-1111111"]);
    expect(body.twinsDropped).toBe(0);
    // The cross product really was returned: the lookup ran with both lists.
    expect(keyLookupCalls).toHaveLength(1);
    expect(keyLookupCalls[0]?.sourceIds.sort()).toEqual([SRC_X.id, SRC_Y.id]);
    expect(keyLookupCalls[0]?.keys.sort()).toEqual(["1111111", "2222222"]);
  });

  it("4. never looks up a row without a key, and upserts it", async () => {
    const URL_SLUG = "https://www.aksam.com.tr/guncel/sadece-slug-var";
    seed(AKSAM, [{ title: "Anahtarsız haber", link: URL_SLUG, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" }]);
    storedArticlesByKey = [
      { id: "art-1", source_id: AKSAM.id, source_article_key: "1708664", url: URL_A, title: TITLE_A },
    ];

    const body = await run();

    expect(keyLookupCalls).toHaveLength(0);
    expect(upserted.map((r) => r.url)).toEqual([URL_SLUG]);
    expect(upserted[0]?.source_article_key).toBeNull();
    expect(body.twinsDropped).toBe(0);
  });

  it("4b. a source in ARTICLE_KEY_EXCLUDED_SLUGS (daily-sabah) gets no key even when its url has a digit run", async () => {
    const DS = {
      id: "src-ds-113",
      name: "Daily Sabah",
      slug: "daily-sabah",
      url: "https://www.dailysabah.com",
      rss_url: "https://www.dailysabah.com/rss",
    };
    const urlA = "https://www.dailysabah.com/business/economy/german-industry-lost-nearly-500000-jobs-since-2019-ifo";
    const urlB = "https://www.dailysabah.com/world/mid-east/funding-shortfall-forces-wfp-to-cut-food-aid-to-500000-gazans";
    seed(DS, [
      { title: "German industry lost nearly 500,000 jobs since 2019: Ifo", link: urlA },
      { title: "Funding shortfall forces WFP to cut food aid to 500,000 Gazans", link: urlB },
    ]);

    const body = await run();

    expect(keyLookupCalls).toHaveLength(0);
    expect(upserted.map((r) => r.url).sort()).toEqual([urlA, urlB].sort());
    expect(upserted.every((r) => r.source_article_key === null)).toBe(true);
    expect(body.twinsDropped).toBe(0);
  });

  it("5. a key lookup error keeps the row (fail-open) and counts one prefilter error", async () => {
    seed(AKSAM, [{ title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" }]);
    storedArticlesByKey = [
      { id: "art-1", source_id: AKSAM.id, source_article_key: "1708664", url: URL_A, title: TITLE_A },
    ];
    forcedKeyLookupError = "simulated key lookup failure";

    const body = await run();

    expect(upsertedUrls()).toEqual([URL_B]);
    expect(body.twinsDropped).toBe(0);
    expect(body.prefilterErrors).toBe(1);
    expect(ingestCycleInserts).toHaveLength(1);
    expect((ingestCycleInserts[0] as { prefilter_errors?: number }).prefilter_errors).toBe(1);
  });

  it("5b. a key lookup that THROWS also keeps the row and counts one prefilter error", async () => {
    seed(AKSAM, [{ title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" }]);
    forcedKeyLookupThrow = true;

    const body = await run();

    expect(upsertedUrls()).toEqual([URL_B]);
    expect(body.prefilterErrors).toBe(1);
  });

  it("6. two twins inside one feed: one is upserted, the other counts as dropped", async () => {
    seed(AKSAM, [
      { title: TITLE_A, link: URL_A, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);

    const body = await run();

    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.url).toBe(URL_A);
    expect(upsertedUrls()).toEqual([URL_A]);
    expect(body.twinsDroppedIntraFeed).toBe(1);
    expect(body.twinsDroppedStored).toBe(0);
    expect(body.twinsDropped).toBe(1);
    expect(body.dedupedInBatch).toBe(0);
    // Dropped before the chunk loop: nothing was stored to look the key up against.
    expect(upsertedUrls()).not.toContain(URL_B);
    // The first one stands and the dropped one is not recorded as a title
    // version of it: intra-feed twins never reach recordTitleVersions.
    expect(titleVersionInsertCalls).toEqual([]);
    expect(titleEditRpcCalls).toEqual([]);
  });

  it("6c. three items with one key in a feed: two intra-feed drops, one count-only log line, the first stands", async () => {
    seed(AKSAM, [
      { title: TITLE_A, link: URL_A, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: TITLE_C, link: URL_C, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);

    const { body, lines } = await runLogged();

    expect(body.twinsDroppedIntraFeed).toBe(2);
    expect(body.twinsDroppedStored).toBe(0);
    expect(body.twinsDropped).toBe(2);
    expect(upsertedUrls()).toEqual([URL_A]);

    // Exactly one per-source line, slug and count only.
    expect(lines.filter((l) => l === "[ingest] aksam: 2 intra-feed twin(s)")).toHaveLength(1);
    expect(lines.filter((l) => l.includes("intra-feed"))).toHaveLength(1);
    for (const l of lines) {
      for (const u of [URL_A, URL_B, URL_C]) expect(l).not.toContain(u);
      expect(l).not.toContain("Husilerle");
      expect(l).not.toContain("üçüncü");
    }
  });

  it("6d. one stored twin and one intra-feed twin in the same cycle are counted apart", async () => {
    seed(AKSAM, [
      { title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: TITLE_C, link: URL_C, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);
    storedArticlesByKey = [
      { id: "art-1", source_id: AKSAM.id, source_article_key: "1708664", url: URL_A, title: TITLE_A },
    ];

    const body = await run();

    // B is the first of the feed to carry the key, so it is the one checked
    // against the stored row (a stored twin); C is the later item (intra-feed).
    expect(body.twinsDroppedStored).toBe(1);
    expect(body.twinsDroppedIntraFeed).toBe(1);
    expect(body.twinsDropped).toBe(2);
    expect(articlesUpsertCalls).toHaveLength(0);
    expect(titleVersionInsertCalls).toEqual([
      [{ article_id: "art-1", source_id: AKSAM.id, old_title: TITLE_A, new_title: TITLE_B }],
    ]);
  });

  it("6b. a repeat with the same content hash counts as deduped, not as a twin", async () => {
    seed(AKSAM, [
      { title: TITLE_A, link: URL_A, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: TITLE_A, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);

    const body = await run();

    expect(upserted).toHaveLength(1);
    expect(body.twinsDropped).toBe(0);
  });

  it("7. bounds the lookup to the last 7 days with gte(created_at, now - 7d)", async () => {
    seed(AKSAM, [{ title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" }]);

    await run();

    expect(articlesGteCalls).toHaveLength(1);
    const call = articlesGteCalls[0]!;
    expect(call.column).toBe("created_at");
    expect(typeof call.value).toBe("string");
    const expected = Date.now() - 7 * 24 * 3_600_000;
    expect(Math.abs(Date.parse(call.value as string) - expected)).toBeLessThan(60_000);
  });

  it("7b. a stored row older than the 7-day window is not a twin", async () => {
    seed(AKSAM, [{ title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" }]);
    storedArticlesByKey = [
      {
        id: "art-old",
        source_id: AKSAM.id,
        source_article_key: "1708664",
        url: URL_A,
        title: TITLE_A,
        created_at: new Date(Date.now() - 8 * 24 * 3_600_000).toISOString(),
      },
    ];

    const body = await run();

    expect(upsertedUrls()).toEqual([URL_B]);
    expect(body.twinsDropped).toBe(0);
  });

  it("8. stamps source_article_key on every upserted row", async () => {
    const URL_EIGHT = "https://www.aksam.com.tr/yasam/baska-haber/haber-1708701";
    seed(AKSAM, [
      { title: "Sekiz numaralı haber", link: URL_EIGHT, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);

    await run();

    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.source_article_key).toBe("1708701");
    // The key rides in the upsert only: ingest_cycles has no column for it.
    expect(JSON.stringify(ingestCycleInserts)).not.toContain("1708701");
  });

  // -------------------------------------------------------------------------
  // Title gate (ingest-gates). Some CMSs reuse a numeric id for a different
  // story, so "same (source, key), other url" is not enough to call a row a
  // twin: a real headline edit keeps words (word-Jaccard >= 0.2, the same gate
  // as the SQL write-back), an id reuse shares none. A reuse is a distinct
  // story and must be stored.
  // -------------------------------------------------------------------------
  const AKSAM_REUSE_KEY = "1708103";
  const AKSAM_REUSE_STORED_URL =
    "https://www.aksam.com.tr/spor/trabzonspor-hearts-macina-hazir/haber-1708103";
  const AKSAM_REUSE_NEW_URL =
    "https://www.aksam.com.tr/spor/fenerbahcede-derbi-mesaisi-ara-vermeden-basladi/haber-1708103";
  const AKSAM_REUSE_STORED_TITLE = "Trabzonspor, Hearts maçına hazır";
  const AKSAM_REUSE_NEW_TITLE = "Fenerbahçe'de derbi mesaisi ara vermeden başladı";

  it("9. a CMS id reused for a different story is stored, not dropped as a twin (aksam 1708103)", async () => {
    seed(AKSAM, [
      { title: AKSAM_REUSE_NEW_TITLE, link: AKSAM_REUSE_NEW_URL, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);
    storedArticlesByKey = [
      {
        id: "art-reuse",
        source_id: AKSAM.id,
        source_article_key: AKSAM_REUSE_KEY,
        url: AKSAM_REUSE_STORED_URL,
        title: AKSAM_REUSE_STORED_TITLE,
      },
    ];

    const { body, lines } = await runLogged();

    expect(upsertedUrls()).toEqual([AKSAM_REUSE_NEW_URL]);
    expect(upserted[0]?.source_article_key).toBe(AKSAM_REUSE_KEY);
    expect(body.inserted).toBe(1);
    expect(body.twinsDroppedStored).toBe(0);
    expect(body.twinsDroppedIntraFeed).toBe(0);
    expect(body.twinsDropped).toBe(0);
    expect(body.twinsKeptDistinct).toBe(1);
    // A reuse is not an edit of the stored article: no version, no write-back.
    expect(titleVersionInsertCalls).toEqual([]);
    expect(titleEditRpcCalls).toEqual([]);
    expect(body.titleVersions).toBe(0);
    expect(body.titleWriteBacks).toBe(0);
    // The key lookup did run (the row was checked, then kept).
    expect(keyLookupCalls).toHaveLength(1);
    // Count-only log line for the kept row.
    const keptLines = lines.filter((l) => /kept .*unrelated headline/.test(l));
    expect(keptLines).toHaveLength(1);
    for (const l of lines) {
      expect(l).not.toContain(AKSAM_REUSE_NEW_URL);
      expect(l).not.toContain(AKSAM_REUSE_STORED_URL);
      expect(l).not.toContain("Fenerbahçe");
      expect(l).not.toContain("Trabzonspor");
    }
  });

  it("9b. a reuse and a genuine edit in one feed: the reuse is stored, the edit is still a twin", async () => {
    const URL_OTHER_STORED = "https://www.aksam.com.tr/spor/baska-haber/haber-1709000";
    const URL_OTHER_EDIT = "https://www.aksam.com.tr/spor/baska-haber-duzenlendi/haber-1709000";
    seed(AKSAM, [
      { title: AKSAM_REUSE_NEW_TITLE, link: AKSAM_REUSE_NEW_URL, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: "Başka haber düzenlendi", link: URL_OTHER_EDIT, pubDate: "Fri, 23 Oct 2026 17:17:00 GMT" },
    ]);
    storedArticlesByKey = [
      { id: "art-reuse", source_id: AKSAM.id, source_article_key: AKSAM_REUSE_KEY, url: AKSAM_REUSE_STORED_URL, title: AKSAM_REUSE_STORED_TITLE },
      { id: "art-edit", source_id: AKSAM.id, source_article_key: "1709000", url: URL_OTHER_STORED, title: "Başka haber" },
    ];

    const body = await run();

    expect(upsertedUrls()).toEqual([AKSAM_REUSE_NEW_URL]);
    expect(body.twinsDroppedStored).toBe(1);
    expect(body.twinsKeptDistinct).toBe(1);
    expect(body.twinsDropped).toBe(1);
    expect(titleVersionInsertCalls).toEqual([
      [{ article_id: "art-edit", source_id: AKSAM.id, old_title: "Başka haber", new_title: "Başka haber düzenlendi" }],
    ]);
  });

  it("9c. a stored row with the same url wins: kept, and not counted as a reuse", async () => {
    seed(AKSAM, [
      { title: AKSAM_REUSE_NEW_TITLE, link: AKSAM_REUSE_NEW_URL, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);
    storedArticlesByKey = [
      { id: "art-reuse", source_id: AKSAM.id, source_article_key: AKSAM_REUSE_KEY, url: AKSAM_REUSE_STORED_URL, title: AKSAM_REUSE_STORED_TITLE },
      { id: "art-same", source_id: AKSAM.id, source_article_key: AKSAM_REUSE_KEY, url: AKSAM_REUSE_NEW_URL, title: AKSAM_REUSE_NEW_TITLE },
    ];

    const body = await run();

    expect(upsertedUrls()).toEqual([AKSAM_REUSE_NEW_URL]);
    expect(body.twinsDropped).toBe(0);
    expect(body.twinsKeptDistinct).toBe(0);
  });

  it("9d. intra-feed: two items with one id and unrelated headlines are both stored", async () => {
    seed(AKSAM, [
      { title: AKSAM_REUSE_STORED_TITLE, link: AKSAM_REUSE_STORED_URL, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: AKSAM_REUSE_NEW_TITLE, link: AKSAM_REUSE_NEW_URL, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);

    const { body, lines } = await runLogged();

    expect(upsertedUrls().sort()).toEqual([AKSAM_REUSE_NEW_URL, AKSAM_REUSE_STORED_URL].sort());
    expect(body.twinsDroppedIntraFeed).toBe(0);
    expect(body.twinsDroppedStored).toBe(0);
    expect(body.twinsDropped).toBe(0);
    expect(body.twinsKeptDistinct).toBe(1);
    for (const l of lines) {
      expect(l).not.toContain(AKSAM_REUSE_NEW_URL);
      expect(l).not.toContain(AKSAM_REUSE_STORED_URL);
      expect(l).not.toContain("Fenerbahçe");
      expect(l).not.toContain("Trabzonspor");
    }
  });

  it("9e. intra-feed: a later item that matches ANY earlier kept headline is dropped, an unrelated one is kept", async () => {
    // 1: A (kept). 2: unrelated reuse (kept, +1 distinct). 3: an edit of the
    // FIRST headline (matches A, dropped). 4: an edit of the SECOND (matches
    // the reuse title, which is in the kept list, dropped).
    const URL_X = "https://www.aksam.com.tr/guncel/baska-bir-haber/haber-1708664";
    const URL_Y = "https://www.aksam.com.tr/guncel/baska-bir-haber-duzenlendi/haber-1708664";
    seed(AKSAM, [
      { title: TITLE_A, link: URL_A, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: "Hafta sonu hava durumu açıklandı", link: URL_X, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: "Hafta sonu hava durumu yarın açıklandı", link: URL_Y, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);

    const body = await run();

    expect(upsertedUrls().sort()).toEqual([URL_A, URL_X].sort());
    expect(body.twinsKeptDistinct).toBe(1);
    expect(body.twinsDroppedIntraFeed).toBe(2);
    expect(body.twinsDropped).toBe(2);
  });

  it("9f. intra-feed kept titles are scoped to the cycle and to (source, key): another source with the same key is untouched", async () => {
    const SRC_X = { id: "src-x-9f", name: "X", slug: "x-9f", url: "https://x.test", rss_url: "https://x.test/rss" };
    seed(AKSAM, [
      { title: AKSAM_REUSE_STORED_TITLE, link: AKSAM_REUSE_STORED_URL, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);
    seed(SRC_X, [{ title: "Tamamen farklı bir kaynak haberi", link: "https://x.test/a/haber-1708103" }]);

    const body = await run();

    expect(upserted).toHaveLength(2);
    expect(body.twinsDropped).toBe(0);
    expect(body.twinsKeptDistinct).toBe(0);
  });

  it("9h. the kept-title map lives for one cycle: an edit seen in the NEXT cycle is not dropped by it", async () => {
    // Cycle 1 keeps A. In cycle 2 the feed only has B (an edit of A, same
    // key, other url). Nothing is stored in the fake table, so the stored
    // lookup finds nothing either: if cycle 1's kept title survived, B would
    // be dropped as an intra-feed twin here.
    const rssUrl = seed(AKSAM, [
      { title: TITLE_A, link: URL_A, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);
    const first = await run();
    expect(upsertedUrls()).toEqual([URL_A]);
    expect(first.twinsDropped).toBe(0);

    fetcherItems[rssUrl] = [
      { title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:20:00 GMT" },
    ];
    const second = await run();

    expect(upsertedUrls()).toEqual([URL_A, URL_B]);
    expect(second.twinsDroppedIntraFeed).toBe(0);
    expect(second.twinsKeptDistinct).toBe(0);
  });

  it("9g. a reuse does not touch the headline write-back of a genuine edit of the SAME stored article", async () => {
    // Stored A. Feed: B (an edit of A, a twin) and the unrelated reuse R with
    // the same key. B is recorded against A; R is stored.
    seed(AKSAM, [
      { title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: "Hava durumu raporu yayımlandı", link: "https://www.aksam.com.tr/guncel/hava/haber-1708664", pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);
    storedArticlesByKey = [
      { id: "art-1", source_id: AKSAM.id, source_article_key: "1708664", url: URL_A, title: TITLE_A },
    ];

    const body = await run();

    // Intra-feed: B is first (kept), R is unrelated to B (kept, +1 distinct).
    // Stored: B matches A (twin, dropped), R matches nothing (kept, +1 distinct).
    expect(upsertedUrls()).toEqual(["https://www.aksam.com.tr/guncel/hava/haber-1708664"]);
    expect(body.twinsDroppedStored).toBe(1);
    expect(body.twinsKeptDistinct).toBe(2);
    expect(titleVersionInsertCalls).toEqual([
      [{ article_id: "art-1", source_id: AKSAM.id, old_title: TITLE_A, new_title: TITLE_B }],
    ]);
  });

  // -------------------------------------------------------------------------
  // CPU bound (ingest-gates). The feed is untrusted input: one that repeats an
  // id on thousands of items with unrelated headlines must not turn the title
  // gate into N^2 comparisons (a CPU-killed 546 cycle writes no row and loses
  // every feed's work). Per key, at most MAX_KEPT_TITLES_PER_KEY headlines are
  // tracked; every item compares against at most that many.
  // -------------------------------------------------------------------------
  it("9i. a feed repeating ONE id on 3000 unrelated headlines does bounded work, not N^2", async () => {
    const { MAX_KEPT_TITLES_PER_KEY } = (await import(
      "../../supabase/functions/ingest/index.ts"
    )) as { MAX_KEPT_TITLES_PER_KEY: number };
    const N = 3000;
    // One unique token per headline: no two share a word, so none is a twin.
    seed(
      AKSAM,
      Array.from({ length: N }, (_, n) => ({
        title: `benzersiz${n}kelime ${n}tekil`,
        link: `https://www.aksam.com.tr/spor/yazi-${n}/haber-1708103`,
        pubDate: "Fri, 23 Oct 2026 17:16:00 GMT",
      })),
    );

    const t0 = performance.now();
    const body = await run();
    const elapsedMs = performance.now() - t0;

    // The quadratic form made N*(N-1)/2 = 4.5M comparisons here.
    expect(jaccardWork.calls).toBeLessThanOrEqual(N * MAX_KEPT_TITLES_PER_KEY);
    expect(elapsedMs).toBeLessThan(20_000);
    // Nothing is lost: every unrelated item is stored.
    expect(upsertedUrls()).toHaveLength(N);
    expect(body.twinsDropped).toBe(0);
    // The first MAX titles are tracked (the first one is just the first); the
    // rest are kept without being tracked and counted in twinsKeyCapped.
    expect(body.twinsKeptDistinct).toBe(MAX_KEPT_TITLES_PER_KEY - 1);
    expect(body.twinsKeyCapped).toBe(N - MAX_KEPT_TITLES_PER_KEY);
  });

  it("9j. past the per-key cap a headline that matches a TRACKED one is still dropped as a twin", async () => {
    const { MAX_KEPT_TITLES_PER_KEY } = (await import(
      "../../supabase/functions/ingest/index.ts"
    )) as { MAX_KEPT_TITLES_PER_KEY: number };
    const unrelated = MAX_KEPT_TITLES_PER_KEY + 3;
    const items = Array.from({ length: unrelated }, (_, n) => ({
      title: `benzersiz${n}kelime ${n}tekil`,
      link: `https://www.aksam.com.tr/spor/yazi-${n}/haber-1708103`,
      pubDate: "Fri, 23 Oct 2026 17:16:00 GMT",
    }));
    // An edit of the FIRST headline (tracked), arriving after the cap is full.
    items.push({
      title: "benzersiz0kelime 0tekil guncellendi",
      link: "https://www.aksam.com.tr/spor/yazi-0-guncellendi/haber-1708103",
      pubDate: "Fri, 23 Oct 2026 17:16:00 GMT",
    });
    seed(AKSAM, items);

    const body = await run();

    expect(body.twinsDroppedIntraFeed).toBe(1);
    expect(body.twinsDropped).toBe(1);
    expect(upsertedUrls()).toHaveLength(unrelated);
    expect(upsertedUrls()).not.toContain(
      "https://www.aksam.com.tr/spor/yazi-0-guncellendi/haber-1708103",
    );
    expect(body.twinsKeyCapped).toBe(unrelated - MAX_KEPT_TITLES_PER_KEY);
  });

  it("9k. twinsKeyCapped is 0 for a normal feed (an id repeated within the cap is fully checked)", async () => {
    seed(AKSAM, [
      { title: AKSAM_REUSE_STORED_TITLE, link: AKSAM_REUSE_STORED_URL, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
      { title: AKSAM_REUSE_NEW_TITLE, link: AKSAM_REUSE_NEW_URL, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);
    const body = await run();
    expect(body.twinsKeyCapped).toBe(0);
    expect(body.twinsKeptDistinct).toBe(1);
  });

  it("reports twinsKeptDistinct in the cycle JSON summary and not as an ingest_cycles column", async () => {
    seed(AKSAM, [
      { title: AKSAM_REUSE_NEW_TITLE, link: AKSAM_REUSE_NEW_URL, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" },
    ]);
    storedArticlesByKey = [
      { id: "art-reuse", source_id: AKSAM.id, source_article_key: AKSAM_REUSE_KEY, url: AKSAM_REUSE_STORED_URL, title: AKSAM_REUSE_STORED_TITLE },
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let httpBody: Record<string, unknown>;
    try {
      httpBody = await run();
      const cycleCall = logSpy.mock.calls.find((args) => args[0] === "[ingest] cycle") as
        | [string, string]
        | undefined;
      expect(cycleCall).toBeDefined();
      const summary = JSON.parse(cycleCall?.[1] ?? "{}") as { twinsKeptDistinct?: number };
      expect(summary.twinsKeptDistinct).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
    expect(httpBody.twinsKeptDistinct).toBe(1);
    // Summary line and HTTP JSON only: no ingest_cycles column for it.
    expect(ingestCycleInserts).toHaveLength(1);
    const cycleKeys = Object.keys(ingestCycleInserts[0] ?? {});
    for (const k of ["twins_kept_distinct", "twinsKeptDistinct", "twins_kept", "kept_distinct"]) {
      expect(cycleKeys).not.toContain(k);
    }
    expect(JSON.stringify(ingestCycleInserts)).not.toContain("KeptDistinct");
    expect(JSON.stringify(ingestCycleInserts)).not.toContain("kept_distinct");
  });

  it("reports twinsDropped in the cycle JSON summary and not as an ingest_cycles column", async () => {
    seed(AKSAM, [{ title: TITLE_B, link: URL_B, pubDate: "Fri, 23 Oct 2026 17:16:00 GMT" }]);
    storedArticlesByKey = [
      { id: "art-1", source_id: AKSAM.id, source_article_key: "1708664", url: URL_A, title: TITLE_A },
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run();
      const cycleCall = logSpy.mock.calls.find((args) => args[0] === "[ingest] cycle") as
        | [string, string]
        | undefined;
      expect(cycleCall).toBeDefined();
      const summary = JSON.parse(cycleCall?.[1] ?? "{}") as {
        twinsDropped?: number;
        twinsDroppedStored?: number;
        twinsDroppedIntraFeed?: number;
      };
      expect(summary.twinsDroppedStored).toBe(1);
      expect(summary.twinsDroppedIntraFeed).toBe(0);
      expect(summary.twinsDropped).toBe(1);
      // A count-only log line: neither url nor title appears in it.
      const twinLines = logSpy.mock.calls
        .map((args) => args.join(" "))
        .filter((l) => /twin/i.test(l) && !l.startsWith("[ingest] cycle"));
      expect(twinLines.length).toBeGreaterThan(0);
      for (const l of twinLines) {
        expect(l).not.toContain(URL_B);
        expect(l).not.toContain("Husilerle");
      }
    } finally {
      logSpy.mockRestore();
    }
    // Summary line and HTTP JSON only: no ingest_cycles column for any of them.
    const cycleKeys = Object.keys(ingestCycleInserts[0] ?? {});
    for (const k of [
      "twins_dropped",
      "twins_dropped_stored",
      "twins_dropped_intra_feed",
      "twinsDroppedStored",
      "twinsDroppedIntraFeed",
    ]) {
      expect(cycleKeys).not.toContain(k);
    }
  });
});

// ---------------------------------------------------------------------------
// dropExistingSourceArticleKeyRows, called directly (same technique as
// dedupeBySourceContentHash / recordTitleVersions above).
// ---------------------------------------------------------------------------

type KeyedRow = { source_id: string; url: string; title: string; source_article_key: string | null };
type ExistingKeyed = {
  id: string;
  url: string;
  title: string;
  source_id: string;
  source_article_key: string;
  created_at: string;
};
type DropKeyFn = (
  supabase: unknown,
  rows: ReadonlyArray<KeyedRow>,
  sinceIso: string,
) => Promise<{
  rows: KeyedRow[];
  twins: Array<{ row: KeyedRow; existing: ExistingKeyed }>;
  lookupErrors: number;
  keptDistinct: number;
}>;

async function importDropKey(): Promise<{ drop: DropKeyFn; supabase: unknown }> {
  const mod = (await import("../../supabase/functions/ingest/index.ts")) as {
    dropExistingSourceArticleKeyRows: DropKeyFn;
  };
  const { createServiceClient } = (await import(
    "../../supabase/functions/_shared/supabase.ts"
  )) as { createServiceClient: () => unknown };
  return { drop: mod.dropExistingSourceArticleKeyRows, supabase: createServiceClient() };
}

describe("dropExistingSourceArticleKeyRows [migration 113]", () => {
  const SINCE = "2026-10-16T00:00:00.000Z";

  it("returns the rows untouched and makes no query when nothing carries a key", async () => {
    const { drop, supabase } = await importDropKey();
    const rows: KeyedRow[] = [
      { source_id: "s1", url: "https://a.test/x", title: "Birinci haber", source_article_key: null },
      { source_id: "s1", url: "https://a.test/y", title: "İkinci haber", source_article_key: null },
    ];
    const out = await drop(supabase, rows, SINCE);
    expect(out.rows).toEqual(rows);
    expect(out.twins).toEqual([]);
    expect(out.lookupErrors).toBe(0);
    expect(out.keptDistinct).toBe(0);
    expect(keyLookupCalls).toHaveLength(0);
  });

  it("returns an empty result for an empty input", async () => {
    const { drop, supabase } = await importDropKey();
    const out = await drop(supabase, [], SINCE);
    expect(out).toEqual({ rows: [], twins: [], lookupErrors: 0, keptDistinct: 0 });
    expect(keyLookupCalls).toHaveLength(0);
  });

  it("looks up keyed rows only and keeps unkeyed rows in their original order", async () => {
    const { drop, supabase } = await importDropKey();
    storedArticlesByKey = [
      { id: "a1", source_id: "s1", source_article_key: "1111111", url: "https://a.test/old-1111111", title: "Bakan açıklama yaptı" },
    ];
    const rows: KeyedRow[] = [
      { source_id: "s1", url: "https://a.test/none-1", title: "Anahtarsız bir", source_article_key: null },
      { source_id: "s1", url: "https://a.test/new-1111111", title: "Bakan açıklama yaptı bugün", source_article_key: "1111111" },
      { source_id: "s1", url: "https://a.test/none-2", title: "Anahtarsız iki", source_article_key: null },
      { source_id: "s1", url: "https://a.test/fresh-2222222", title: "Yeni haber", source_article_key: "2222222" },
    ];
    const out = await drop(supabase, rows, SINCE);
    expect(out.rows.map((r) => r.url)).toEqual([
      "https://a.test/none-1",
      "https://a.test/none-2",
      "https://a.test/fresh-2222222",
    ]);
    expect(out.twins.map((t) => t.row.url)).toEqual(["https://a.test/new-1111111"]);
    expect(out.keptDistinct).toBe(0);
    expect(keyLookupCalls).toHaveLength(1);
    expect(keyLookupCalls[0]?.keys.sort()).toEqual(["1111111", "2222222"]);
  });

  it("picks the EARLIEST created_at match as the stored article of a twin", async () => {
    const { drop, supabase } = await importDropKey();
    storedArticlesByKey = [
      { id: "later", source_id: "s1", source_article_key: "1111111", url: "https://a.test/v2-1111111", title: "Gündem haberi ikinci sürüm", created_at: "2026-10-20T10:00:00.000Z" },
      { id: "earliest", source_id: "s1", source_article_key: "1111111", url: "https://a.test/v1-1111111", title: "Gündem haberi birinci sürüm", created_at: "2026-10-20T08:00:00.000Z" },
      { id: "middle", source_id: "s1", source_article_key: "1111111", url: "https://a.test/v15-1111111", title: "Gündem haberi 1.5 sürüm", created_at: "2026-10-20T09:00:00.000Z" },
    ];
    const out = await drop(
      supabase,
      [{ source_id: "s1", url: "https://a.test/v3-1111111", title: "Gündem haberi üçüncü sürüm", source_article_key: "1111111" }],
      SINCE,
    );
    expect(out.rows).toEqual([]);
    expect(out.twins).toHaveLength(1);
    expect(out.twins[0]?.existing.id).toBe("earliest");
    expect(out.twins[0]?.existing.title).toBe("Gündem haberi birinci sürüm");
    expect(out.keptDistinct).toBe(0);
  });

  it("splits keyed rows into lookups of at most 100 (PREFILTER_CHUNK)", async () => {
    const { drop, supabase } = await importDropKey();
    const rows: KeyedRow[] = Array.from({ length: 250 }, (_, n) => ({
      source_id: "s1",
      url: `https://a.test/x-${1000000 + n}`,
      title: `Haber ${n}`,
      source_article_key: String(1000000 + n),
    }));
    const out = await drop(supabase, rows, SINCE);
    expect(out.rows).toHaveLength(250);
    expect(keyLookupCalls.map((c) => c.keys.length)).toEqual([100, 100, 50]);
    for (const c of keyLookupCalls) {
      expect(c.gte).toEqual([{ column: "created_at", value: SINCE }]);
    }
  });

  it("a failing slice keeps only its own rows and counts one lookup error", async () => {
    const { drop, supabase } = await importDropKey();
    forcedKeyLookupError = "boom";
    const rows: KeyedRow[] = Array.from({ length: 150 }, (_, n) => ({
      source_id: "s1",
      url: `https://a.test/x-${1000000 + n}`,
      title: `Haber ${n}`,
      source_article_key: String(1000000 + n),
    }));
    const out = await drop(supabase, rows, SINCE);
    expect(out.rows).toHaveLength(150);
    expect(out.twins).toEqual([]);
    expect(out.lookupErrors).toBe(2);
    expect(out.keptDistinct).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Title gate (ingest-gates): a match only makes a twin when its headline
  // shares words with the row's (word-Jaccard >= 0.2, the SQL write-back gate).
  // The two pairs below are real CMS-id reuses seen in prod on 2026-10-24.
  // -------------------------------------------------------------------------
  it.each([
    [
      "odatv 120168027",
      "odatv",
      "120168027",
      "https://www.odatv.com/gundem/eski-spk-baskani-erman-cete-ye-gozalti-karari-120168027",
      "Eski SPK Başkanı Erman Çete'ye gözaltı kararı",
      "https://www.odatv.com/gundem/feridun-gecgel-ve-enver-gecgel-5-milyar-tl-iade-etti-120168027",
      "Feridun Geçgel ve Enver Geçgel 5 milyar TL iade etti",
    ],
    [
      "yenicag 1084546",
      "yenicag",
      "1084546",
      "https://www.yenicaggazetesi.com.tr/arnavutkoy-de-okullara-10-bin-parca-spor-malzemesi-destegi-1084546h.htm",
      "Arnavutköy'de okullara 10 bin parça spor malzemesi desteği",
      "https://www.yenicaggazetesi.com.tr/kartal-da-kahkaha-firtinasi-ruh-salatasi-oyunu-1084546h.htm",
      "Kartal'da kahkaha fırtınası: Ruh Salatası oyunu",
    ],
  ])(
    "keeps a row whose id is reused for a different story (%s) and counts it as keptDistinct",
    async (_label, sourceId, key, storedUrl, storedTitle, rowUrl, rowTitle) => {
      const { drop, supabase } = await importDropKey();
      storedArticlesByKey = [
        { id: "stored-1", source_id: sourceId, source_article_key: key, url: storedUrl, title: storedTitle },
      ];
      const row: KeyedRow = { source_id: sourceId, url: rowUrl, title: rowTitle, source_article_key: key };

      const out = await drop(supabase, [row], SINCE);

      expect(out.rows).toEqual([row]);
      expect(out.twins).toEqual([]);
      expect(out.keptDistinct).toBe(1);
      expect(out.lookupErrors).toBe(0);
    },
  );

  it("takes the EARLIEST PASSING match: an unrelated earliest match is skipped for a later related one", async () => {
    const { drop, supabase } = await importDropKey();
    storedArticlesByKey = [
      // Earliest overall, but a different story that reused the id.
      { id: "unrelated-earliest", source_id: "s1", source_article_key: "1111111", url: "https://a.test/other-1111111", title: "Trabzonspor, Hearts maçına hazır", created_at: "2026-10-20T07:00:00.000Z" },
      { id: "related-late", source_id: "s1", source_article_key: "1111111", url: "https://a.test/v2-1111111", title: "Bakan Güler: Husilerle çatışmaya girilmeyecek", created_at: "2026-10-20T10:00:00.000Z" },
      { id: "related-early", source_id: "s1", source_article_key: "1111111", url: "https://a.test/v1-1111111", title: "Bakan Güler'den Mekke ittifakı vurgusu", created_at: "2026-10-20T09:00:00.000Z" },
    ];
    const out = await drop(
      supabase,
      [{ source_id: "s1", url: "https://a.test/v3-1111111", title: "Bakan Güler: üçüncü başlık", source_article_key: "1111111" }],
      SINCE,
    );
    expect(out.rows).toEqual([]);
    expect(out.twins).toHaveLength(1);
    // Earlier than "related-late" and passing; "unrelated-earliest" is skipped.
    expect(out.twins[0]?.existing.id).toBe("related-early");
    expect(out.keptDistinct).toBe(0);
  });

  it("keeps the row (keptDistinct 1, not 2) when EVERY match is unrelated", async () => {
    const { drop, supabase } = await importDropKey();
    storedArticlesByKey = [
      { id: "u1", source_id: "s1", source_article_key: "1111111", url: "https://a.test/u1-1111111", title: "Trabzonspor, Hearts maçına hazır" },
      { id: "u2", source_id: "s1", source_article_key: "1111111", url: "https://a.test/u2-1111111", title: "Hava durumu raporu yayımlandı" },
    ];
    const row: KeyedRow = {
      source_id: "s1",
      url: "https://a.test/new-1111111",
      title: "Fenerbahçe'de derbi mesaisi ara vermeden başladı",
      source_article_key: "1111111",
    };
    const out = await drop(supabase, [row], SINCE);
    expect(out.rows).toEqual([row]);
    expect(out.twins).toEqual([]);
    expect(out.keptDistinct).toBe(1);
  });

  it("counts keptDistinct per row across a mixed batch", async () => {
    const { drop, supabase } = await importDropKey();
    storedArticlesByKey = [
      { id: "s-a", source_id: "s1", source_article_key: "1111111", url: "https://a.test/a-1111111", title: "Merkez Bankası faizi sabit tuttu" },
      { id: "s-b", source_id: "s1", source_article_key: "2222222", url: "https://a.test/b-2222222", title: "Merkez Bankası faiz kararını açıkladı" },
      { id: "s-c", source_id: "s1", source_article_key: "3333333", url: "https://a.test/c-3333333", title: "Derbi öncesi kritik açıklama" },
    ];
    const reuse1: KeyedRow = { source_id: "s1", url: "https://a.test/r1-1111111", title: "Deprem sonrası yeni açıklama", source_article_key: "1111111" };
    const edit: KeyedRow = { source_id: "s1", url: "https://a.test/e-2222222", title: "Merkez Bankası faiz kararını duyurdu", source_article_key: "2222222" };
    const reuse3: KeyedRow = { source_id: "s1", url: "https://a.test/r3-3333333", title: "Hava durumu raporu yayımlandı", source_article_key: "3333333" };
    const fresh: KeyedRow = { source_id: "s1", url: "https://a.test/f-4444444", title: "Hiç görülmemiş haber", source_article_key: "4444444" };

    const out = await drop(supabase, [reuse1, edit, reuse3, fresh], SINCE);

    expect(out.rows).toEqual([reuse1, reuse3, fresh]);
    expect(out.twins.map((t) => t.row)).toEqual([edit]);
    expect(out.twins[0]?.existing.id).toBe("s-b");
    expect(out.keptDistinct).toBe(2);
  });

  it("does not count a same-url match as a reuse (the normal re-poll), even beside an unrelated match", async () => {
    const { drop, supabase } = await importDropKey();
    storedArticlesByKey = [
      { id: "other", source_id: "s1", source_article_key: "1111111", url: "https://a.test/other-1111111", title: "Trabzonspor, Hearts maçına hazır" },
      { id: "same", source_id: "s1", source_article_key: "1111111", url: "https://a.test/new-1111111", title: "Fenerbahçe'de derbi mesaisi ara vermeden başladı" },
    ];
    const row: KeyedRow = {
      source_id: "s1",
      url: "https://a.test/new-1111111",
      title: "Fenerbahçe'de derbi mesaisi ara vermeden başladı",
      source_article_key: "1111111",
    };
    const out = await drop(supabase, [row], SINCE);
    expect(out.rows).toEqual([row]);
    expect(out.twins).toEqual([]);
    expect(out.keptDistinct).toBe(0);
  });

  it("applies the gate inclusively at 0.2: one shared word of five is a twin, one of six is a reuse", async () => {
    const { drop, supabase } = await importDropKey();
    storedArticlesByKey = [
      { id: "edge", source_id: "s1", source_article_key: "1111111", url: "https://a.test/edge-1111111", title: "a b c" },
      { id: "below", source_id: "s1", source_article_key: "2222222", url: "https://a.test/below-2222222", title: "a b c" },
    ];
    const atGate: KeyedRow = { source_id: "s1", url: "https://a.test/n-1111111", title: "a d e", source_article_key: "1111111" };
    const belowGate: KeyedRow = { source_id: "s1", url: "https://a.test/n-2222222", title: "a d e f", source_article_key: "2222222" };

    const out = await drop(supabase, [atGate, belowGate], SINCE);

    expect(out.twins.map((t) => t.row)).toEqual([atGate]);
    expect(out.rows).toEqual([belowGate]);
    expect(out.keptDistinct).toBe(1);
  });

  // -------------------------------------------------------------------------
  // CPU / row bound (ingest-gates): the stored matches of a reused key pile up
  // over the 7-day window and the key comes from an untrusted url. The lookup
  // is ordered and limited, and a row is compared against at most
  // MAX_KEPT_TITLES_PER_KEY of the (earliest) matches.
  // -------------------------------------------------------------------------
  it("orders the lookup by created_at ascending and limits it to PREFILTER_CHUNK * MAX_KEPT_TITLES_PER_KEY", async () => {
    const { drop, supabase } = await importDropKey();
    const mod = (await import("../../supabase/functions/ingest/index.ts")) as {
      MAX_KEPT_TITLES_PER_KEY: number;
      KEY_LOOKUP_LIMIT: number;
    };
    expect(mod.KEY_LOOKUP_LIMIT).toBe(100 * mod.MAX_KEPT_TITLES_PER_KEY);
    await drop(
      supabase,
      [{ source_id: "s1", url: "https://a.test/x-1111111", title: "Haber", source_article_key: "1111111" }],
      SINCE,
    );
    expect(keyLookupCalls).toHaveLength(1);
    expect(keyLookupCalls[0]?.order).toEqual([{ column: "created_at", ascending: true }]);
    expect(keyLookupCalls[0]?.limit).toBe(mod.KEY_LOOKUP_LIMIT);
  });

  it("compares a row against at most MAX_KEPT_TITLES_PER_KEY stored matches, however many pile up", async () => {
    const { drop, supabase } = await importDropKey();
    const { MAX_KEPT_TITLES_PER_KEY } = (await import(
      "../../supabase/functions/ingest/index.ts"
    )) as { MAX_KEPT_TITLES_PER_KEY: number };
    storedArticlesByKey = Array.from({ length: 2000 }, (_, n) => ({
      id: `stored-${n}`,
      source_id: "s1",
      source_article_key: "1111111",
      url: `https://a.test/old-${n}-1111111`,
      title: `eski${n}kelime ${n}baska`,
    }));
    const row: KeyedRow = {
      source_id: "s1",
      url: "https://a.test/new-1111111",
      title: "tamamen farkli yeni baslik",
      source_article_key: "1111111",
    };

    const out = await drop(supabase, [row], SINCE);

    expect(jaccardWork.calls).toBeLessThanOrEqual(MAX_KEPT_TITLES_PER_KEY);
    expect(out.rows).toEqual([row]);
    expect(out.twins).toEqual([]);
    expect(out.keptDistinct).toBe(1);
  });

  it("bounds a whole slice of rows that share one key: at most rows x MAX comparisons", async () => {
    const { drop, supabase } = await importDropKey();
    const { MAX_KEPT_TITLES_PER_KEY } = (await import(
      "../../supabase/functions/ingest/index.ts"
    )) as { MAX_KEPT_TITLES_PER_KEY: number };
    storedArticlesByKey = Array.from({ length: 50 }, (_, n) => ({
      id: `stored-${n}`,
      source_id: "s1",
      source_article_key: "1111111",
      url: `https://a.test/old-${n}-1111111`,
      title: `eski${n}kelime ${n}baska`,
    }));
    const rows: KeyedRow[] = Array.from({ length: 400 }, (_, n) => ({
      source_id: "s1",
      url: `https://a.test/new-${n}-1111111`,
      title: `yeni${n}kelime ${n}farkli`,
      source_article_key: "1111111",
    }));

    const out = await drop(supabase, rows, SINCE);

    expect(jaccardWork.calls).toBeLessThanOrEqual(rows.length * MAX_KEPT_TITLES_PER_KEY);
    expect(out.rows).toHaveLength(400);
    expect(out.keptDistinct).toBe(400);
  });

  it("looks at the EARLIEST matches by created_at: a related earliest match wins whatever the array order", async () => {
    const { drop, supabase } = await importDropKey();
    const { MAX_KEPT_TITLES_PER_KEY } = (await import(
      "../../supabase/functions/ingest/index.ts"
    )) as { MAX_KEPT_TITLES_PER_KEY: number };
    // Newer unrelated matches first in the array, the related original last
    // (and the oldest): the sorted lookup must still reach it.
    const noise = Array.from({ length: MAX_KEPT_TITLES_PER_KEY + 4 }, (_, n) => ({
      id: `noise-${n}`,
      source_id: "s1",
      source_article_key: "1111111",
      url: `https://a.test/noise-${n}-1111111`,
      title: `gurultu${n}kelime ${n}baska`,
      created_at: `2026-10-20T1${n % 10}:00:00.000Z`,
    }));
    storedArticlesByKey = [
      ...noise,
      {
        id: "original",
        source_id: "s1",
        source_article_key: "1111111",
        url: "https://a.test/original-1111111",
        title: "Merkez Bankası faiz kararını duyurdu",
        created_at: "2026-10-19T00:00:00.000Z",
      },
    ];
    const edit: KeyedRow = {
      source_id: "s1",
      url: "https://a.test/edit-1111111",
      title: "Merkez Bankası faiz kararını açıkladı",
      source_article_key: "1111111",
    };

    const out = await drop(supabase, [edit], SINCE);

    expect(out.twins).toHaveLength(1);
    expect(out.twins[0]?.existing.id).toBe("original");
    expect(out.rows).toEqual([]);
  });

  it("a same-url match beyond the compared window still marks the row as a normal re-poll", async () => {
    const { drop, supabase } = await importDropKey();
    const { MAX_KEPT_TITLES_PER_KEY } = (await import(
      "../../supabase/functions/ingest/index.ts"
    )) as { MAX_KEPT_TITLES_PER_KEY: number };
    const sameUrl = "https://a.test/same-1111111";
    storedArticlesByKey = [
      ...Array.from({ length: MAX_KEPT_TITLES_PER_KEY }, (_, n) => ({
        id: `early-${n}`,
        source_id: "s1",
        source_article_key: "1111111",
        url: `https://a.test/early-${n}-1111111`,
        title: `Merkez Bankası faiz kararı ${n}`,
        created_at: `2026-10-18T0${n}:00:00.000Z`,
      })),
      {
        id: "own",
        source_id: "s1",
        source_article_key: "1111111",
        url: sameUrl,
        title: "Merkez Bankası faiz kararını duyurdu",
        created_at: "2026-10-20T00:00:00.000Z",
      },
    ];
    const row: KeyedRow = {
      source_id: "s1",
      url: sameUrl,
      title: "Merkez Bankası faiz kararını duyurdu",
      source_article_key: "1111111",
    };

    const out = await drop(supabase, [row], SINCE);

    expect(out.rows).toEqual([row]);
    expect(out.twins).toEqual([]);
    expect(out.keptDistinct).toBe(0);
  });

  it("treats a stored row without a usable title as unrelated (kept, fail-open)", async () => {
    const { drop, supabase } = await importDropKey();
    storedArticlesByKey = [
      { id: "blank", source_id: "s1", source_article_key: "1111111", url: "https://a.test/old-1111111", title: "" },
    ];
    const row: KeyedRow = { source_id: "s1", url: "https://a.test/new-1111111", title: "Yeni başlık", source_article_key: "1111111" };
    const out = await drop(supabase, [row], SINCE);
    expect(out.rows).toEqual([row]);
    expect(out.twins).toEqual([]);
    expect(out.keptDistinct).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Parse budget (twin-articles item, part B). A cycle that decoded, parsed and
// normalised every changed feed was killed on the platform CPU limit (HTTP 546,
// reason CPUTime) and lost everything it had fetched. Now at most
// MAX_PARSES_PER_CYCLE changed feeds (and PARSE_BUDGET_BYTES of body) are
// parsed per cycle; the rest are DEFERRED: no rows, no fetch-state write, the
// conditional cache put back, and they go first in the next cycle.
// ---------------------------------------------------------------------------
describe("parse budget: deferring changed feeds [parse budget]", () => {
  const ENV_KEYS = ["INGEST_MAX_PARSES_PER_CYCLE", "INGEST_PARSE_BUDGET_BYTES"] as const;
  // The default MAX_PARSES_PER_CYCLE (pinned by the constants test below).
  const CAP = 55;

  // The ingest module keeps the previous cycle's deferred ids in a module-level
  // set, and this file imports the module once. Every test here uses its own
  // source-id prefix, so ids left over from an earlier test never match.
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  function seedChanged(prefix: string, n: number, extra: Record<string, unknown> = {}): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `${prefix}-${String(i).padStart(3, "0")}`;
      const rssUrl = `https://${prefix}.test/${id}.rss`;
      fakeSources.push({
        id,
        name: id,
        slug: id,
        url: `https://${prefix}.test`,
        rss_url: rssUrl,
        active: true,
        fetch_etag: null,
        fetch_last_modified: null,
        fetch_body_hash: null,
        fetch_fail_streak: 0,
        ...extra,
      });
      fetcherItems[rssUrl] = [
        { title: `${id} benzersiz haber basligi ${i * 104729}`, link: `https://${prefix}.test/${id}/haber`, pubDate: "Fri, 23 Oct 2026 10:00:00 GMT" },
      ];
      fetcherResultOverrides[rssUrl] = { etag: `"${id}-new"`, bodyHash: `${id}-hash` };
      ids.push(id);
    }
    return ids;
  }

  function seedNotModified(prefix: string, n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `${prefix}-nm-${String(i).padStart(3, "0")}`;
      const rssUrl = `https://${prefix}.test/${id}.rss`;
      fakeSources.push({
        id,
        name: id,
        slug: id,
        url: `https://${prefix}.test`,
        rss_url: rssUrl,
        active: true,
        fetch_etag: 'W/"nm"',
        fetch_last_modified: null,
        fetch_body_hash: null,
        fetch_fail_streak: 0,
      });
      fetcherResultOverrides[rssUrl] = { notModified: true, status: 304 };
      ids.push(id);
    }
    return ids;
  }

  async function run() {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");
    const res = await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  const persistedIds = () => new Set(sourceFetchStateWrites.flatMap((w) => w.rows).map((r) => r.id as string));
  const upsertedSourceIds = () => new Set(upserted.map((r) => r.source_id as string));

  it("100 changed + 10 not-modified sources: exactly CAP are parsed, the rest are deferred without a fetch-state write", async () => {
    const changed = seedChanged("pb1", 100);
    const notModified = seedNotModified("pb1", 10);

    const body = await run();

    const parsed = upsertedSourceIds();
    expect(parsed.size).toBe(CAP);
    expect(upserted).toHaveLength(CAP);
    expect(body.fetched).toBe(CAP);
    expect(body.parseDeferred).toBe(100 - CAP);
    expect(body.notModified).toBe(10);
    expect(body.failed).toBe(0);

    const deferred = changed.filter((id) => !parsed.has(id));
    expect(deferred).toHaveLength(100 - CAP);
    const persisted = persistedIds();
    // A deferred source leaves NO trace in the fetch-state write: its old
    // validators, status and fail streak stay exactly as they were.
    for (const id of deferred) expect(persisted.has(id), `deferred ${id} must not be persisted`).toBe(false);
    // The 10 not-modified sources are written as usual; so are the CAP parsed.
    for (const id of notModified) expect(persisted.has(id), `not-modified ${id} is persisted`).toBe(true);
    for (const id of parsed) expect(persisted.has(id), `parsed ${id} is persisted`).toBe(true);
    expect(persisted.size).toBe(CAP + 10);
  });

  it("on the next invocation the deferred sources are fetched first", async () => {
    // 120 changed against CAP 55: 65 are deferred, more than one cycle's budget.
    const changed = seedChanged("pb2", 120);
    seedNotModified("pb2", 10);

    await run();
    const deferred = new Set(changed.filter((id) => !upsertedSourceIds().has(id)));
    expect(deferred.size).toBe(120 - CAP);

    fetchFeedCalls.length = 0;
    upserted.length = 0;
    sourceFetchStateWrites.length = 0;
    await run();

    const firstDeferred = fetchFeedCalls.slice(0, deferred.size).map((c) => c.sourceId);
    expect(new Set(firstDeferred)).toEqual(deferred);
    // They are also the ones that get the budget: CAP of the 65 are parsed.
    const parsed = upsertedSourceIds();
    expect(parsed.size).toBe(CAP);
    for (const id of parsed) expect(deferred.has(id)).toBe(true);
  });

  it("drains: with room in the budget the deferred sources are all parsed and nothing stays deferred", async () => {
    const changed = seedChanged("pb3", CAP + 20);

    const first = await run();
    expect(first.parseDeferred).toBe(20);

    process.env.INGEST_MAX_PARSES_PER_CYCLE = "1000";
    upserted.length = 0;
    const second = await run();
    expect(second.parseDeferred).toBe(0);
    expect(second.fetched).toBe(CAP + 20);

    // A third cycle (default budget again) has no priority set left over.
    delete process.env.INGEST_MAX_PARSES_PER_CYCLE;
    fetchFeedCalls.length = 0;
    const third = await run();
    expect(third.parseDeferred).toBe(20);
    expect(changed).toHaveLength(CAP + 20);
  });

  it("3 sources of 3,000,000 bytes with a 4,000,000 byte budget: 1 parsed, 2 deferred", async () => {
    process.env.INGEST_PARSE_BUDGET_BYTES = "4000000";
    const ids = seedChanged("pb4", 3);
    for (const id of ids) fetcherResultOverrides[`https://pb4.test/${id}.rss`]!.bodyBytes = 3_000_000;

    const body = await run();

    expect(body.fetched).toBe(1);
    expect(body.parseDeferred).toBe(2);
    expect(body.parsedBytes).toBe(3_000_000);
    expect(upsertedSourceIds().size).toBe(1);
    // The parsed-bytes figure is cycle JSON only.
    expect(Object.keys(ingestCycleInserts[0] ?? {})).not.toContain("parsed_bytes");
    expect(Object.keys(ingestCycleInserts[0] ?? {})).not.toContain("parse_deferred");
  });

  it("a feed bigger than the budget cannot starve: deferred once, it goes first next cycle and is parsed even over budget", async () => {
    process.env.INGEST_PARSE_BUDGET_BYTES = "4000000";
    const ids = seedChanged("pb5", 3);
    for (const id of ids) fetcherResultOverrides[`https://pb5.test/${id}.rss`]!.bodyBytes = 3_000_000;

    await run();
    const deferred = ids.filter((id) => !upsertedSourceIds().has(id));
    expect(deferred).toHaveLength(2);

    fetchFeedCalls.length = 0;
    upserted.length = 0;
    const second = await run();

    expect(new Set(fetchFeedCalls.slice(0, 2).map((c) => c.sourceId))).toEqual(new Set(deferred));
    // First deferred one: first parse of the cycle. Second deferred one: it
    // is priority, so it may overshoot the byte budget once. The third source
    // is not priority and loses.
    expect(second.fetched).toBe(2);
    expect(second.parseDeferred).toBe(1);
    for (const id of upsertedSourceIds()) expect(deferred).toContain(id);
  });

  it("restores the conditional cache of a deferred source and keeps its stored validators", async () => {
    process.env.INGEST_MAX_PARSES_PER_CYCLE = "1";
    const [a, b] = seedChanged("pb6", 2, { fetch_etag: 'W/"old"', fetch_body_hash: "stored-hash" });
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    const body = await run();
    expect(body.parseDeferred).toBe(1);
    const deferredId = [a!, b!].find((id) => !upsertedSourceIds().has(id))!;
    // Nothing about the deferred source was written to the database.
    expect(persistedIds().has(deferredId)).toBe(false);

    // The (mock) fetcher stamped '"<id>-new"' on the cache and left it there;
    // the worker must put the previous validators back.
    fetchFeedCalls.length = 0;
    process.env.INGEST_MAX_PARSES_PER_CYCLE = "1000";
    await run();
    const call = fetchFeedCalls.find((c) => c.sourceId === deferredId);
    expect(call?.cached?.etag).toBe('W/"old"');
  });

  it("deletes the conditional cache entry of a deferred source that had none", async () => {
    process.env.INGEST_MAX_PARSES_PER_CYCLE = "1";
    const [a, b] = seedChanged("pb7", 2);

    await run();
    const deferredId = [a!, b!].find((id) => !upsertedSourceIds().has(id))!;

    fetchFeedCalls.length = 0;
    process.env.INGEST_MAX_PARSES_PER_CYCLE = "1000";
    await run();
    expect(fetchFeedCalls.find((c) => c.sourceId === deferredId)?.cached).toBeUndefined();
  });

  it("checks parseDeferred BEFORE error and notModified", async () => {
    const [id] = seedChanged("pb8", 1);
    const rssUrl = `https://pb8.test/${id}.rss`;
    fetcherResultOverrides[rssUrl] = { parseDeferred: true, notModified: true, error: "ignored", status: 200 };

    const body = await run();

    expect(body.parseDeferred).toBe(1);
    expect(body.notModified).toBe(0);
    expect(body.failed).toBe(0);
    expect(persistedIds().has(id!)).toBe(false);
    expect(upserted).toHaveLength(0);
  });

  it("a deferred source is not counted as failed and does not advance its fail streak or quarantine", async () => {
    process.env.INGEST_MAX_PARSES_PER_CYCLE = "1";
    const ids = seedChanged("pb9", 2, { fetch_fail_streak: 19 });

    const body = await run();

    expect(body.failed).toBe(0);
    expect(body.quarantined).toBe(0);
    const deferredId = ids.find((id) => !upsertedSourceIds().has(id))!;
    expect(persistedIds().has(deferredId)).toBe(false);
  });

  it("falls back to the default for anything but a positive integer in INGEST_MAX_PARSES_PER_CYCLE", async () => {
    for (const bad of ["abc", "0", "-5", "1.5", "", "12abc", " 7 ", "1e1", "0x10"]) {
      fakeSources.length = 0;
      for (const k of Object.keys(fetcherItems)) delete fetcherItems[k];
      for (const k of Object.keys(fetcherResultOverrides)) delete fetcherResultOverrides[k];
      upserted.length = 0;
      process.env.INGEST_MAX_PARSES_PER_CYCLE = bad;
      seedChanged("pb10", CAP + 5);
      const body = await run();
      expect(body.fetched, `INGEST_MAX_PARSES_PER_CYCLE=${JSON.stringify(bad)} -> default ${CAP}`).toBe(CAP);
      expect(body.parseDeferred).toBe(5);
    }
  });

  it("honours a positive-integer INGEST_MAX_PARSES_PER_CYCLE and INGEST_PARSE_BUDGET_BYTES", async () => {
    process.env.INGEST_MAX_PARSES_PER_CYCLE = "7";
    seedChanged("pb11", 20);
    const body = await run();
    expect(body.fetched).toBe(7);
    expect(body.parseDeferred).toBe(13);
  });

  it("falls back to the default byte budget for a bad INGEST_PARSE_BUDGET_BYTES", async () => {
    // Default is 8 MB: four 3 MB bodies -> 3 MB, 6 MB parsed; the third would
    // reach 9 MB > 8 MB and is deferred, so 2 parsed, 2 deferred.
    for (const bad of ["abc", "0", "-1", "2.5"]) {
      fakeSources.length = 0;
      for (const k of Object.keys(fetcherItems)) delete fetcherItems[k];
      for (const k of Object.keys(fetcherResultOverrides)) delete fetcherResultOverrides[k];
      process.env.INGEST_PARSE_BUDGET_BYTES = bad;
      const ids = seedChanged("pb12", 4);
      for (const id of ids) fetcherResultOverrides[`https://pb12.test/${id}.rss`]!.bodyBytes = 3_000_000;
      const body = await run();
      expect(body.fetched, `INGEST_PARSE_BUDGET_BYTES=${JSON.stringify(bad)}`).toBe(2);
      expect(body.parseDeferred).toBe(2);
    }
  });

  it("reports parseDeferredMaxStreak: the longest run of consecutive cycles any feed has been deferred", async () => {
    process.env.INGEST_MAX_PARSES_PER_CYCLE = "1";
    seedChanged("pb14", 3);

    // Cycle 1: one feed parsed, two deferred once.
    const first = await run();
    expect(first.parseDeferred).toBe(2);
    expect(first.parseDeferredMaxStreak).toBe(1);

    // Cycle 2: the two deferred feeds go first; one is parsed, the other is
    // deferred a second time in a row, the third (parsed last time) once.
    const second = await run();
    expect(second.parseDeferred).toBe(2);
    expect(second.parseDeferredMaxStreak).toBe(2);

    // With room again everything drains and the streak counter resets.
    process.env.INGEST_MAX_PARSES_PER_CYCLE = "1000";
    const drained = await run();
    expect(drained.parseDeferred).toBe(0);
    expect(drained.parseDeferredMaxStreak).toBe(0);

    process.env.INGEST_MAX_PARSES_PER_CYCLE = "1";
    const fresh = await run();
    expect(fresh.parseDeferredMaxStreak, "a drained feed starts again at 1").toBe(1);
    // Summary and HTTP JSON only: there is no ingest_cycles column for it.
    expect(Object.keys(ingestCycleInserts[0] ?? {})).not.toContain("parse_deferred_max_streak");
  });

  it("an on-budget cycle is unchanged: nothing deferred, parsedBytes sums the bodies", async () => {
    seedChanged("pb13", 5);
    const body = await run();
    expect(body.fetched).toBe(5);
    expect(body.parseDeferred).toBe(0);
    expect(body.parseDeferredMaxStreak).toBe(0);
    expect(body.parsedBytes).toBe(5000);
    expect(upserted).toHaveLength(5);
  });
});

describe("parse budget constants and env parsing [parse budget]", () => {
  // Why 55 and not a round 40: ingest_cycles, 3 days to 2026-10-23 (1,328
  // finished cycles; `fetched` = changed feeds parsed): p50 45, p90 55, p99
  // 71, max 78; hours 06-08 UTC p50 52, p90 68. A cap of 40 would have deferred
  // 74% of the cycles (6.8 feeds on average, 14.4 at 06-08 UTC where every
  // cycle exceeds it), so deferral would be the steady state. 55 defers about
  // 10% of the cycles (0.8 feeds on average, 2.6 at 06-08 UTC) and still
  // trims the tail above p90, where most of the 546 kills cluster (hours 07-09
  // and 13 UTC: 15 to 33% of the expected cycles missing).
  it("exports MAX_PARSES_PER_CYCLE = 55 and a PARSE_BUDGET_BYTES between 0.5 MB and 8 MB on a 0.5 MB step", async () => {
    const mod = (await import("../../supabase/functions/ingest/index.ts")) as {
      MAX_PARSES_PER_CYCLE: number;
      PARSE_BUDGET_BYTES: number;
    };
    expect(mod.MAX_PARSES_PER_CYCLE).toBe(55);
    expect(mod.PARSE_BUDGET_BYTES).toBeGreaterThanOrEqual(500_000);
    expect(mod.PARSE_BUDGET_BYTES).toBeLessThanOrEqual(8_000_000);
    expect(mod.PARSE_BUDGET_BYTES % 500_000).toBe(0);
  });

  it("positiveIntEnv accepts only plain positive integers", async () => {
    const mod = (await import("../../supabase/functions/ingest/index.ts")) as {
      positiveIntEnv: (raw: string | undefined, fallback: number) => number;
    };
    expect(mod.positiveIntEnv("7", 40)).toBe(7);
    expect(mod.positiveIntEnv("4000000", 1)).toBe(4_000_000);
    for (const bad of [undefined, "", " ", "0", "-3", "1.5", "abc", "7x", "x7", "1e3", "0x10", "+5", " 7", "7 "]) {
      expect(mod.positiveIntEnv(bad, 40), JSON.stringify(bad)).toBe(40);
    }
    // Beyond Number.MAX_SAFE_INTEGER a digit string is not a usable budget.
    expect(mod.positiveIntEnv("99999999999999999999", 40)).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Headline-less items (hunt-10 C-entity-only-titles). A feed item whose title
// is only entity residue / punctuation ('&amp;nbsp', '-', '…') used to be
// stored as a story: /cluster/46467982-... rendered "&amp;nbsp — Tayf" and was
// indexable. normalizeItem now drops it; the cycle reports how many in the
// summary line and the HTTP JSON (`contentlessTitlesDropped`) and logs one
// count-only line per source. No ingest_cycles column.
// ---------------------------------------------------------------------------
describe("headline-less items are dropped and counted [hunt-10 C-entity-only-titles]", () => {
  const SRC = {
    id: "src-contentless",
    name: "Boş Başlık Gazetesi",
    slug: "bos-baslik",
    url: "https://bos-baslik.example",
    rss_url: "https://bos-baslik.example/rss.xml",
  };
  const REAL_URL = "https://bos-baslik.example/haber/gercek-1";
  const JUNK_URL = "https://bos-baslik.example/advertorial/junk-1";
  const REAL_TITLE = "Gerçek bir başlık";

  function seed(feed: MockFeedItem[]): void {
    fakeSources.push({
      ...SRC,
      active: true,
      fetch_etag: null,
      fetch_last_modified: null,
      fetch_body_hash: null,
      fetch_fail_streak: 0,
    });
    fetcherItems[SRC.rss_url] = feed;
  }

  async function runLogged() {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      return { body, calls: logSpy.mock.calls.slice(), lines: logSpy.mock.calls.map((a) => a.join(" ")) };
    } finally {
      logSpy.mockRestore();
    }
  }

  const upsertedUrls = () => articlesUpsertCalls.flat().map((r) => r.url);

  it("drops the entity-only item, upserts only the real row, and reports contentlessTitlesDropped 1", async () => {
    seed([
      { title: "&amp;nbsp", link: JUNK_URL, pubDate: "Sun, 01 Nov 2026 09:00:00 GMT" },
      { title: REAL_TITLE, link: REAL_URL, pubDate: "Sun, 01 Nov 2026 09:05:00 GMT" },
    ]);

    const { body } = await runLogged();

    expect(body.contentlessTitlesDropped).toBe(1);
    expect(body.itemsNormalized).toBe(1);
    expect(upsertedUrls()).toEqual([REAL_URL]);
    expect(articlesUpsertCalls.flat().map((r) => r.title)).toEqual([REAL_TITLE]);
  });

  it("totals the junk items of a feed: '&nbsp', '-', '…' and a whitespace-only title", async () => {
    seed([
      { title: "&nbsp", link: "https://bos-baslik.example/a", pubDate: "Sun, 01 Nov 2026 09:00:00 GMT" },
      { title: "-", link: "https://bos-baslik.example/b", pubDate: "Sun, 01 Nov 2026 09:01:00 GMT" },
      { title: "…", link: "https://bos-baslik.example/c", pubDate: "Sun, 01 Nov 2026 09:02:00 GMT" },
      { title: "   ", link: "https://bos-baslik.example/d", pubDate: "Sun, 01 Nov 2026 09:03:00 GMT" },
      { title: REAL_TITLE, link: REAL_URL, pubDate: "Sun, 01 Nov 2026 09:05:00 GMT" },
    ]);

    const { body } = await runLogged();

    expect(body.contentlessTitlesDropped).toBe(4);
    expect(upsertedUrls()).toEqual([REAL_URL]);
  });

  it("logs one count-only line for the source: slug and count, never a title or a url", async () => {
    seed([
      { title: "&amp;nbsp", link: JUNK_URL, pubDate: "Sun, 01 Nov 2026 09:00:00 GMT" },
      { title: "-", link: "https://bos-baslik.example/advertorial/junk-2", pubDate: "Sun, 01 Nov 2026 09:01:00 GMT" },
      { title: REAL_TITLE, link: REAL_URL, pubDate: "Sun, 01 Nov 2026 09:05:00 GMT" },
    ]);

    const { lines } = await runLogged();

    expect(lines.filter((l) => l === "[ingest] bos-baslik: 2 item(s) dropped: no headline text")).toHaveLength(1);
    expect(lines.filter((l) => l.includes("no headline text"))).toHaveLength(1);
    for (const l of lines) {
      expect(l).not.toContain("advertorial");
      expect(l).not.toContain("junk-");
      expect(l).not.toContain("&nbsp");
      expect(l).not.toContain(REAL_TITLE);
    }
  });

  it("puts the count in the '[ingest] cycle' summary line and not in an ingest_cycles column", async () => {
    seed([
      { title: "&amp;nbsp", link: JUNK_URL, pubDate: "Sun, 01 Nov 2026 09:00:00 GMT" },
      { title: REAL_TITLE, link: REAL_URL, pubDate: "Sun, 01 Nov 2026 09:05:00 GMT" },
    ]);

    const { calls } = await runLogged();

    const cycleCall = calls.find((args) => args[0] === "[ingest] cycle") as
      | [string, string]
      | undefined;
    expect(cycleCall).toBeDefined();
    const summary = JSON.parse(cycleCall?.[1] ?? "{}") as { contentlessTitlesDropped?: number };
    expect(summary.contentlessTitlesDropped).toBe(1);
    expect(ingestCycleInserts).toHaveLength(1);
    const json = JSON.stringify(ingestCycleInserts);
    expect(json).not.toContain("contentless");
    expect(Object.keys(ingestCycleInserts[0] ?? {})).not.toContain("contentless_titles_dropped");
  });

  it("a normal feed reports 0 and logs no 'no headline text' line", async () => {
    seed([
      { title: REAL_TITLE, link: REAL_URL, pubDate: "Sun, 01 Nov 2026 09:05:00 GMT" },
      { title: "AT&T hisseleri yükseldi", link: "https://bos-baslik.example/haber/att", pubDate: "Sun, 01 Nov 2026 09:06:00 GMT" },
    ]);

    const { body, lines } = await runLogged();

    expect(body.contentlessTitlesDropped).toBe(0);
    expect(upsertedUrls()).toHaveLength(2);
    expect(lines.filter((l) => l.includes("no headline text"))).toEqual([]);
  });

  it("counts per cycle: a second cycle over the same junk feed reports its own count, not a running total", async () => {
    seed([
      { title: "&nbsp", link: JUNK_URL, pubDate: "Sun, 01 Nov 2026 09:00:00 GMT" },
      { title: REAL_TITLE, link: REAL_URL, pubDate: "Sun, 01 Nov 2026 09:05:00 GMT" },
    ]);

    const first = await runLogged();
    const second = await runLogged();

    expect(first.body.contentlessTitlesDropped).toBe(1);
    expect(second.body.contentlessTitlesDropped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A-ingest-cpu (hunt-11): per-item work spent on items that are never inserted.
//
// 2026-11-01 prod, 10:00-14:00 UTC: 252,949 items fully normalised against
// 1,860 inserted (0.74%). Ingest now does the cheap part of normalisation
// (link, cleaned title, absolute url) first, asks the database once per feed
// which of those urls are already stored, and runs the heavy part (legal
// notice, canonical url, description, image, date, hash, category) only for
// the rest. An item whose url is stored for the same source under the same
// headline is "known": it is counted (itemsKnownSkipped) and nothing else.
// ---------------------------------------------------------------------------

type LookupStoredByUrlFn = (
  supabase: unknown,
  urls: readonly string[],
  slug?: string,
) => Promise<{
  byUrl: Map<string, { id: string; title: string; source_id: string }>;
  ok: boolean;
}>;

describe("known-url skip before the heavy normalisation [hunt-11 A-ingest-cpu]", () => {
  const PUB = "Fri, 23 Oct 2026 10:00:00 GMT";

  function mkSource(tag: string) {
    return {
      id: `src-ks-${tag}`,
      name: `Known skip ${tag}`,
      slug: `ks-${tag}`,
      url: `https://${tag}.known.example`,
      rss_url: `https://${tag}.known.example/rss.xml`,
    };
  }
  type Src = ReturnType<typeof mkSource>;
  const urlOf = (src: Src, i: number | string) => `${src.url}/haber/konu-${i}`;

  function seed(src: Src, feed: MockFeedItem[], extra: Record<string, unknown> = {}): string {
    fakeSources.push({
      ...src,
      active: true,
      fetch_etag: null,
      fetch_last_modified: null,
      fetch_body_hash: null,
      fetch_fail_streak: 0,
      ...extra,
    });
    fetcherItems[src.rss_url] = feed;
    return src.rss_url;
  }

  function store(src: Src, item: MockFeedItem, over: Partial<{ id: string; title: string; source_id: string }> = {}) {
    storedArticlesByUrl[item.link] = {
      id: over.id ?? `art-${item.link}`,
      title: over.title ?? item.title,
      source_id: over.source_id ?? src.id,
    };
  }

  async function run() {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");
    const res = await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  async function runLogged() {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const body = await run();
      return { body, lines: logSpy.mock.calls.map((args) => args.join(" ")) };
    } finally {
      logSpy.mockRestore();
    }
  }

  const upsertedUrls = () => articlesUpsertCalls.flat().map((r) => r.url as string);
  const lookedUpUrls = () => articlesUrlLookupCalls.flatMap((c) => c.urls);
  const persisted = (id: string) =>
    sourceFetchStateWrites.flatMap((w) => w.rows).find((r) => r.id === id);

  it("an all-known feed: nothing is fully normalised, nothing is upserted, the validators are committed", async () => {
    const src = mkSource("allknown");
    const items: MockFeedItem[] = Array.from({ length: 20 }, (_, i) => ({
      title: `Bilinen haber başlığı numara ${i}`,
      link: urlOf(src, i),
      pubDate: PUB,
    }));
    const rssUrl = seed(src, items, { fetch_etag: 'W/"old"', fetch_body_hash: "stored-hash" });
    fetcherResultOverrides[rssUrl] = { etag: '"new"', bodyHash: "hash-new" };
    for (const it of items) store(src, it);

    const body = await run();

    expect(heavyWork.fingerprints).toBe(0);
    expect(body.itemsNormalized).toBe(0);
    expect(body.itemsKnownSkipped).toBe(20);
    expect(body.knownUrlLookupErrors).toBe(0);
    expect(body.inserted).toBe(0);
    expect(articlesUpsertCalls).toHaveLength(0);
    expect(prefilterLookupCalls).toHaveLength(0);
    expect(keyLookupCalls).toHaveLength(0);
    expect(titleVersionInsertCalls).toHaveLength(0);
    expect(titleEditRpcCalls).toHaveLength(0);
    // One batched select for the whole feed, naming every url once, in feed order.
    expect(articlesUrlLookupCalls).toHaveLength(1);
    expect(articlesUrlLookupCalls[0]?.urls).toEqual(items.map((i) => i.link));

    // No row to lose: the validators commit right away.
    expect(body.validatorsWithheld).toBe(0);
    const row = persisted(src.id);
    expect(row?.fetch_etag).toBe('"new"');
    expect(row?.fetch_body_hash).toBe("hash-new");
    expect(row?.fetch_fail_streak).toBe(0);
  });

  it("looks the feed's urls up in batches of 100, each url once", async () => {
    const src = mkSource("batches");
    const items: MockFeedItem[] = Array.from({ length: 250 }, (_, i) => ({
      title: `Toplu haber başlığı numara ${i}`,
      link: urlOf(src, i),
      pubDate: PUB,
    }));
    // The same link twice in one feed is looked up once.
    items.push({ ...items[0]! });
    seed(src, items);
    for (const it of items) store(src, it);

    const body = await run();

    expect(articlesUrlLookupCalls.map((c) => c.urls.length).sort((a, b) => b - a)).toEqual([100, 100, 50]);
    expect(lookedUpUrls().sort()).toEqual(items.slice(0, 250).map((i) => i.link).sort());
    expect(body.itemsKnownSkipped).toBe(251);
    expect(body.itemsNormalized).toBe(0);
    expect(heavyWork.fingerprints).toBe(0);
  });

  it("a known url with a changed headline still records one title version and one write-back, selected once", async () => {
    const src = mkSource("changed");
    const same: MockFeedItem[] = [0, 1].map((i) => ({
      title: `Aynı kalan haber başlığı ${i}`,
      link: urlOf(src, i),
      pubDate: PUB,
    }));
    const edited: MockFeedItem = {
      title: "Yeni başlıkla yeniden yayımlandı",
      link: urlOf(src, "edited"),
      pubDate: PUB,
    };
    seed(src, [same[0]!, edited, same[1]!]);
    for (const it of same) store(src, it);
    store(src, edited, { id: "art-edited", title: "Eski başlıkla ilk yayımlandı" });

    const body = await run();

    expect(body.titleVersions).toBe(1);
    expect(body.titleWriteBacks).toBe(1);
    expect(titleVersionInsertCalls).toEqual([
      [
        {
          article_id: "art-edited",
          source_id: src.id,
          old_title: "Eski başlıkla ilk yayımlandı",
          new_title: "Yeni başlıkla yeniden yayımlandı",
        },
      ],
    ]);
    expect(titleEditRpcCalls).toEqual([
      [
        {
          article_id: "art-edited",
          old_title: "Eski başlıkla ilk yayımlandı",
          new_title: "Yeni başlıkla yeniden yayımlandı",
        },
      ],
    ]);
    // Heavy path, as today: only the changed one is fully normalised and sent.
    expect(heavyWork.fingerprints).toBe(1);
    expect(body.itemsNormalized).toBe(1);
    expect(body.itemsKnownSkipped).toBe(2);
    expect(upsertedUrls()).toEqual([edited.link]);
    // The edited url is selected exactly once in the whole cycle: by phase 1.
    expect(lookedUpUrls().filter((u) => u === edited.link)).toHaveLength(1);
    expect(articlesUrlLookupCalls).toHaveLength(1);
  });

  it("a headline that differs only by surrounding whitespace is unchanged; a case change is a change", async () => {
    const src = mkSource("trim");
    const spaced: MockFeedItem = { title: "Boşluklu başlık", link: urlOf(src, "spaced"), pubDate: PUB };
    const cased: MockFeedItem = { title: "Büyük harfli BAŞLIK", link: urlOf(src, "cased"), pubDate: PUB };
    seed(src, [spaced, cased]);
    store(src, spaced, { title: "  Boşluklu başlık \n" });
    store(src, cased, { id: "art-cased", title: "Büyük harfli başlık" });

    const body = await run();

    expect(body.itemsKnownSkipped).toBe(1);
    expect(body.itemsNormalized).toBe(1);
    expect(body.titleVersions).toBe(1);
    expect(upsertedUrls()).toEqual([cased.link]);
  });

  it("a mixed feed upserts exactly the unknown urls, each row identical to the normaliser's output", async () => {
    const src = mkSource("mixed");
    const known: MockFeedItem[] = [0, 1, 2].map((i) => ({
      title: `Zaten kayıtlı haber ${i}`,
      link: urlOf(src, `k${i}`),
      pubDate: PUB,
      contentSnippet: `<p>Kayıtlı özet ${i}</p>`,
    }));
    const fresh: MockFeedItem[] = [0, 1, 2].map((i) => ({
      title: `Yepyeni haber ${i} &amp; ayrıntılar`,
      link: urlOf(src, `n${i}`),
      pubDate: "Sat, 24 Oct 2026 08:3" + i + ":00 +0300",
      contentSnippet: `<p>Yeni özet ${i}</p><img src="https://x/y.jpg">`,
    }));
    seed(src, [known[0]!, fresh[0]!, known[1]!, fresh[1]!, fresh[2]!, known[2]!]);
    for (const it of known) store(src, it);

    const body = await run();

    expect(heavyWork.fingerprints).toBe(3);
    expect(body.itemsNormalized).toBe(3);
    expect(body.itemsKnownSkipped).toBe(3);
    expect(body.inserted).toBe(3);
    expect(upsertedUrls().sort()).toEqual(fresh.map((i) => i.link).sort());

    const expected = normalizeArticles(src, fresh, Date.now()).map((row) => ({
      ...row,
      canonical_url: canonicalizeUrl(row.url, src.slug),
      source_article_key: sourceArticleKeyFor(src.slug, row.url),
    }));
    const sent = [...upserted].sort((a, b) => String(a.url).localeCompare(String(b.url)));
    expect(sent).toEqual([...expected].sort((a, b) => a.url.localeCompare(b.url)));
    // A fresh url is never selected a second time by the title-version path.
    expect(articlesUrlLookupCalls).toHaveLength(1);
    expect(articlesUrlLookupCalls[0]?.urls).toHaveLength(6);
  });

  it("a known url stored under ANOTHER source_id takes the heavy path, as before", async () => {
    const src = mkSource("othersrc");
    const item: MockFeedItem = { title: "Başka kaynağın haberi", link: urlOf(src, "x"), pubDate: PUB };
    seed(src, [item]);
    store(src, item, { id: "art-other", source_id: "src-somebody-else" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = await run();

      expect(body.itemsKnownSkipped).toBe(0);
      expect(body.itemsNormalized).toBe(1);
      expect(heavyWork.fingerprints).toBe(1);
      expect(upsertedUrls()).toEqual([item.link]);
      // Never attributed to the other outlet's article.
      expect(titleVersionInsertCalls).toHaveLength(0);
      expect(titleEditRpcCalls).toHaveLength(0);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("matched a different source_id")),
      ).toBe(true);
      // The cross-source row came from phase 1; the title-version path does not select it again.
      expect(lookedUpUrls().filter((u) => u === item.link)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a failing phase-1 lookup fails open: every item takes the heavy path, rows identical to before", async () => {
    const src = mkSource("lookuperr");
    const items: MockFeedItem[] = [0, 1, 2].map((i) => ({
      title: `Arama hatası haberi ${i}`,
      link: urlOf(src, i),
      pubDate: PUB,
    }));
    seed(src, items);
    store(src, items[0]!); // would be known if the lookup worked
    forcedTitleLookupError = "simulated select failure";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = await run();

      expect(body.knownUrlLookupErrors).toBe(1);
      expect(body.itemsKnownSkipped).toBe(0);
      expect(body.itemsNormalized).toBe(3);
      expect(body.inserted).toBe(3);
      expect(heavyWork.fingerprints).toBe(3);
      const expected = normalizeArticles(src, items, Date.now()).map((row) => ({
        ...row,
        canonical_url: canonicalizeUrl(row.url, src.slug),
        source_article_key: sourceArticleKeyFor(src.slug, row.url),
      }));
      expect(upserted).toEqual(expected);
      // The log names the source and the message, never a url.
      const line = err.mock.calls
        .map((c) => c.map(String).join(" "))
        .find((l) => l.includes("known-url lookup"));
      expect(line).toBeDefined();
      expect(line).toContain(src.slug);
      expect(line).toContain("simulated select failure");
      expect(line).not.toContain("known.example");
    } finally {
      err.mockRestore();
    }
  });

  it("contentless titles are still counted and logged, and their urls are not looked up", async () => {
    const src = mkSource("contentless");
    const good: MockFeedItem = { title: "Gerçek bir haber başlığı", link: urlOf(src, "good"), pubDate: PUB };
    const junk1: MockFeedItem = { title: "&nbsp", link: urlOf(src, "junk1"), pubDate: PUB };
    const junk2: MockFeedItem = { title: "   ", link: urlOf(src, "junk2"), pubDate: PUB };
    const known: MockFeedItem = { title: "Kayıtlı başlık", link: urlOf(src, "known"), pubDate: PUB };
    seed(src, [junk1, good, junk2, known]);
    store(src, known);
    // Stored under a headline: a contentless feed title must still be dropped, not skipped as known.
    store(src, junk1, { title: "Eskiden bir başlığı vardı" });

    const { body, lines } = await runLogged();

    expect(body.contentlessTitlesDropped).toBe(2);
    expect(lines).toContain(`[ingest] ${src.slug}: 2 item(s) dropped: no headline text`);
    expect(body.itemsKnownSkipped).toBe(1);
    expect(body.itemsNormalized).toBe(1);
    expect(upsertedUrls()).toEqual([good.link]);
    expect(lookedUpUrls().sort()).toEqual([good.link, known.link].sort());
  });

  it("an intra-feed twin behind a known item is still dropped as a twin", async () => {
    const src = { ...mkSource("twin"), slug: "ks-twin", url: "https://twin.known.example" };
    const URL_OLD = `${src.url}/guncel/eski-slug/haber-1708664`;
    const URL_NEW = `${src.url}/guncel/yeni-slug/haber-1708664`;
    const TITLE_OLD = "Bakan Güler'den Mekke ittifakı vurgusu";
    const TITLE_NEW = "Bakan Güler Mekke ittifakı vurgusu yaptı";
    const first: MockFeedItem = { title: TITLE_OLD, link: URL_OLD, pubDate: PUB };
    const twin: MockFeedItem = { title: TITLE_NEW, link: URL_NEW, pubDate: PUB };
    const other: MockFeedItem = { title: "Tamamen başka bir konu", link: urlOf(src, "other"), pubDate: PUB };
    seed(src, [first, twin, other]);
    store(src, first);

    const { body, lines } = await runLogged();

    // The known item is skipped, yet the unknown one with the same article key and a
    // similar headline is still recognised as its twin and not inserted.
    expect(body.itemsKnownSkipped).toBe(1);
    expect(body.twinsDroppedIntraFeed).toBe(1);
    expect(body.twinsDropped).toBe(1);
    expect(upsertedUrls()).toEqual([other.link]);
    expect(lines.filter((l) => l.includes("intra-feed twin"))).toEqual([
      `[ingest] ${src.slug}: 1 intra-feed twin(s)`,
    ]);
  });

  it("a known item behind an unknown one is dropped by the twin registry: same counters as when both were normalised", async () => {
    const src = { ...mkSource("twin2"), slug: "ks-twin2", url: "https://twin2.known.example" };
    const URL_A = `${src.url}/guncel/slug-a/haber-1708664`;
    const URL_B = `${src.url}/guncel/slug-b/haber-1708664`;
    const a: MockFeedItem = { title: "Bakan Güler'den Mekke ittifakı vurgusu", link: URL_A, pubDate: PUB };
    const b: MockFeedItem = { title: "Bakan Güler Mekke ittifakı vurgusu yaptı", link: URL_B, pubDate: PUB };
    seed(src, [a, b]);
    store(src, b);

    const body = await run();

    // b is known: it is counted as skipped and never completed, but it still goes
    // through the registry, finds a's headline and is counted as an intra-feed twin.
    expect(body.itemsKnownSkipped).toBe(1);
    expect(body.itemsNormalized).toBe(1);
    expect(body.twinsDroppedIntraFeed).toBe(1);
    expect(body.twinsDropped).toBe(1);
    expect(upsertedUrls()).toEqual([URL_A]);
  });

  it("a skipped item with an unrelated headline still takes its place in the per-id registry", async () => {
    const src = { ...mkSource("twin3"), slug: "ks-twin3", url: "https://twin3.known.example" };
    const URL_A = `${src.url}/guncel/slug-a/haber-1708664`;
    const URL_B = `${src.url}/guncel/slug-b/haber-1708664`;
    const a: MockFeedItem = { title: "Borsa güne yükselişle başladı", link: URL_A, pubDate: PUB };
    const b: MockFeedItem = { title: "Deprem sonrası arama kurtarma çalışması", link: URL_B, pubDate: PUB };
    seed(src, [a, b]);
    store(src, a);

    const body = await run();

    // Same id, unrelated headlines: the CMS reused the id. The unknown one is kept
    // (counted in twinsKeptDistinct), exactly as with two fully normalised items.
    expect(body.itemsKnownSkipped).toBe(1);
    expect(body.twinsDroppedIntraFeed).toBe(0);
    expect(body.twinsKeptDistinct).toBe(1);
    expect(upsertedUrls()).toEqual([URL_B]);
  });

  it("a bootstrap whose body is the stored one pushes nothing and looks nothing up", async () => {
    const src = mkSource("bootstrap");
    const items: MockFeedItem[] = [0, 1].map((i) => ({
      title: `Bootstrap haberi ${i}`,
      link: urlOf(src, i),
      pubDate: PUB,
    }));
    const rssUrl = seed(src, items, { fetch_items_count: null, fetch_body_hash: "same-hash" });
    fetcherResultOverrides[rssUrl] = { bodyHash: "same-hash" };

    const body = await run();

    expect(articlesUrlLookupCalls).toHaveLength(0);
    expect(heavyWork.fingerprints).toBe(0);
    expect(body.itemsNormalized).toBe(0);
    expect(body.itemsKnownSkipped).toBe(0);
    expect(articlesUpsertCalls).toHaveLength(0);
  });

  it("keeps the new counters out of the ingest_cycles row", async () => {
    const src = mkSource("cols");
    const item: MockFeedItem = { title: "Sütun denemesi haberi", link: urlOf(src, 1), pubDate: PUB };
    seed(src, [item]);
    store(src, item);

    await run();

    expect(ingestCycleInserts).toHaveLength(1);
    const keys = Object.keys(ingestCycleInserts[0] ?? {});
    for (const k of ["items_known_skipped", "known_url_lookup_errors", "isolate_items_used"]) {
      expect(keys).not.toContain(k);
    }
  });
});

describe("lookupStoredByUrl [hunt-11 A-ingest-cpu]", () => {
  async function importLookup(): Promise<LookupStoredByUrlFn> {
    const mod = (await import("../../supabase/functions/ingest/index.ts")) as unknown as {
      lookupStoredByUrl: LookupStoredByUrlFn;
    };
    return mod.lookupStoredByUrl;
  }

  function client(
    answer: (urls: string[]) => unknown | Promise<unknown>,
  ): { supabase: unknown; selects: string[]; ins: Array<{ column: string; urls: string[] }>; tables: string[] } {
    const selects: string[] = [];
    const ins: Array<{ column: string; urls: string[] }> = [];
    const tables: string[] = [];
    return {
      selects,
      ins,
      tables,
      supabase: {
        from: (table: string) => {
          tables.push(table);
          return {
            select: (columns: string) => {
              selects.push(columns);
              return {
                in: async (column: string, urls: string[]) => {
                  ins.push({ column, urls: [...urls] });
                  return await answer(urls);
                },
              };
            },
          };
        },
      },
    };
  }

  const manyUrls = (n: number) => Array.from({ length: n }, (_, i) => `https://l.example/a/${i}`);

  it("selects id, url, title, source_id from articles by url in batches of 100, unique urls only", async () => {
    const lookup = await importLookup();
    const urls = manyUrls(230);
    const c = client((batch) => ({
      data: batch
        .filter((u) => u.endsWith("/7") || u.endsWith("/229"))
        .map((u) => ({ id: `id-${u}`, url: u, title: `T ${u}`, source_id: "s1" })),
      error: null,
    }));

    const res = await lookup(c.supabase, [...urls, urls[0]!, urls[5]!]);

    expect(res.ok).toBe(true);
    expect(c.tables.every((t) => t === "articles")).toBe(true);
    expect(c.selects.every((s) => s === "id, url, title, source_id")).toBe(true);
    expect(c.ins.every((i) => i.column === "url")).toBe(true);
    expect(c.ins.map((i) => i.urls.length).sort((a, b) => b - a)).toEqual([100, 100, 30]);
    expect(c.ins.flatMap((i) => i.urls).sort()).toEqual([...urls].sort());
    expect([...res.byUrl.keys()].sort()).toEqual(["https://l.example/a/229", "https://l.example/a/7"]);
    expect(res.byUrl.get("https://l.example/a/7")).toEqual({
      id: "id-https://l.example/a/7",
      title: "T https://l.example/a/7",
      source_id: "s1",
    });
  });

  it("makes no call for an empty url list", async () => {
    const lookup = await importLookup();
    const c = client(() => ({ data: [], error: null }));
    const res = await lookup(c.supabase, []);
    expect(res.ok).toBe(true);
    expect(res.byUrl.size).toBe(0);
    expect(c.ins).toHaveLength(0);
  });

  it("reports ok=false on an error envelope, and never throws", async () => {
    const lookup = await importLookup();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const c = client(() => ({ data: null, error: { message: "statement timeout" } }));
      const res = await lookup(c.supabase, manyUrls(150));
      expect(res.ok).toBe(false);
      expect(res.byUrl.size).toBe(0);
    } finally {
      err.mockRestore();
    }
  });

  it("reports ok=false when one of several batches fails", async () => {
    const lookup = await importLookup();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // PERSISTENT failure: every request that carries the marked url fails.
      // A one-shot failure no longer fails the lookup -- the slice is retried
      // once as two halves and recovers (see the byte cap block below).
      const urls = manyUrls(250);
      const marked = urls[120]!; // lives in the second batch of 100
      const c = client((batch) =>
        batch.includes(marked)
          ? { data: null, error: { message: "boom" } }
          : { data: [{ id: "x", url: batch[0], title: "t", source_id: "s" }], error: null },
      );
      const res = await lookup(c.supabase, urls);
      expect(res.ok).toBe(false);
    } finally {
      err.mockRestore();
    }
  });

  it("reports ok=false when the client throws or rejects, without leaking a url", async () => {
    const lookup = await importLookup();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const thrower = client(() => {
        throw new Error("network down for https://secret.example/x?token=1");
      });
      const a = await lookup(thrower.supabase, ["https://secret.example/x"]);
      expect(a.ok).toBe(false);

      const broken = {
        from: () => {
          throw new Error("synchronous failure");
        },
      };
      const b = await lookup(broken, ["https://secret.example/x"]);
      expect(b.ok).toBe(false);

      const logged = err.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(logged).not.toContain("secret.example");
    } finally {
      err.mockRestore();
    }
  });

  it("treats a null data envelope as no rows", async () => {
    const lookup = await importLookup();
    const c = client(() => ({ data: null, error: null }));
    const res = await lookup(c.supabase, manyUrls(3));
    expect(res.ok).toBe(true);
    expect(res.byUrl.size).toBe(0);
  });
});

describe("lookupStoredByUrl byte cap [h14-ingest-1]", () => {
  // 2026-11-01 prod: a changed evrensel feed (urls average 175 chars, max 235)
  // sent 100 urls in ONE `url=in.(...)` GET, ~19-20 kB percent-encoded, and the
  // request died with an http2 stream error on every cycle (9 log lines), so the
  // known-url skip silently degraded to full normalisation. Slices are now cut
  // by encoded bytes as well as by count, and a failed slice is retried once as
  // two halves before the lookup gives up (fail-open, unchanged).
  type PlanFn = (urls: readonly string[], maxCount?: number, maxBytes?: number) => string[][];
  type Mod = {
    lookupStoredByUrl: LookupStoredByUrlFn;
    planUrlLookupSlices: PlanFn;
    URL_LOOKUP_MAX_BYTES: number;
  };
  async function importMod(): Promise<Mod> {
    return (await import("../../supabase/functions/ingest/index.ts")) as unknown as Mod;
  }

  // Same fake as the block above, copied rather than shared so the two blocks
  // stay independent. `in` is async, so an `answer` that returns a rejected
  // promise (or throws) surfaces as a rejection from `.in(...)`, which is what
  // supabase-js does when fetch itself fails.
  function client(answer: (urls: string[]) => unknown | Promise<unknown>) {
    const ins: Array<{ column: string; urls: string[] }> = [];
    return {
      ins,
      supabase: {
        from: () => ({
          select: () => ({
            in: async (column: string, urls: string[]) => {
              ins.push({ column, urls: [...urls] });
              return await answer(urls);
            },
          }),
        }),
      },
    };
  }

  const rowFor = (u: string) => ({ id: `id-${u}`, url: u, title: `T ${u}`, source_id: "s1" });
  const allRows = (batch: string[]) => ({ data: batch.map(rowFor), error: null });
  // The rejecting variant: a fetch-layer failure, as a rejected promise.
  const reject = (message: string) => Promise.reject(new TypeError(message));
  const encodedLen = (slice: readonly string[]) => encodeURIComponent(`in.(${slice.join(",")})`).length;
  const shortUrls = (n: number) => Array.from({ length: n }, (_, i) => `https://l.example/a/${i}`);

  // evrensel-shaped urls: 180-235 chars, Turkish letters in the slug (6 encoded
  // bytes each), unique by the numeric id.
  const TR_SLUG = "işçiler-ücret-zammı-için-çalışma-şartları-öğretmenler-görev-ğ-";
  function evrenselUrls(n: number): string[] {
    return Array.from({ length: n }, (_, i) => {
      const head = `https://www.evrensel.net/haber/5${String(i).padStart(5, "0")}/`;
      const target = 180 + ((i * 37) % 56); // 180..235 inclusive
      let tail = "";
      while (head.length + tail.length < target) tail += TR_SLUG;
      return (head + tail).slice(0, target);
    });
  }

  // Independent greedy minimum: extend the open slice while the REAL encoded
  // query value still fits, cut otherwise. Contiguous order-preserving slices
  // cannot be fewer than this.
  function greedyMinimum(urls: readonly string[], maxBytes: number, maxCount = 100): number {
    let count = 0;
    let open: string[] = [];
    for (const u of urls) {
      if (open.length > 0 && (open.length >= maxCount || encodedLen([...open, u]) > maxBytes)) {
        count++;
        open = [];
      }
      open.push(u);
    }
    return open.length > 0 ? count + 1 : count;
  }

  it("the fixture really is the failing shape: 100 urls of 180-235 chars with Turkish letters, far over the budget in one request", async () => {
    const { URL_LOOKUP_MAX_BYTES } = await importMod();
    const urls = evrenselUrls(100);
    expect(new Set(urls).size).toBe(100);
    for (const u of urls) {
      expect(u.length).toBeGreaterThanOrEqual(180);
      expect(u.length).toBeLessThanOrEqual(235);
      expect(u).toMatch(/[çğıöşü]/);
    }
    expect(encodedLen(urls)).toBeGreaterThan(URL_LOOKUP_MAX_BYTES * 2);
  });

  it("(1) cuts 100 long Turkish urls into slices under the byte budget, each url once, in order, with the greedy-minimum slice count", async () => {
    const { lookupStoredByUrl, URL_LOOKUP_MAX_BYTES } = await importMod();
    expect(URL_LOOKUP_MAX_BYTES).toBe(6_000);
    const urls = evrenselUrls(100);
    const c = client((batch) => allRows(batch));

    const res = await lookupStoredByUrl(c.supabase, urls, "evrensel");

    expect(res.ok).toBe(true);
    expect(res.byUrl.size).toBe(100);
    for (const call of c.ins) {
      expect(call.urls.length).toBeLessThanOrEqual(100);
      expect(encodedLen(call.urls)).toBeLessThanOrEqual(URL_LOOKUP_MAX_BYTES);
    }
    // Every url looked up exactly once.
    const seen = c.ins.flatMap((i) => i.urls);
    expect(seen).toHaveLength(100);
    expect(new Set(seen).size).toBe(100);
    // Order preserved: the slices are contiguous runs of the input order.
    const reassembled = [...c.ins]
      .sort((a, b) => urls.indexOf(a.urls[0]!) - urls.indexOf(b.urls[0]!))
      .flatMap((i) => i.urls);
    expect(reassembled).toEqual(urls);
    // No wasted requests.
    expect(c.ins).toHaveLength(greedyMinimum(urls, URL_LOOKUP_MAX_BYTES));
  });

  describe("planUrlLookupSlices", () => {
    it("gives a url longer than the whole budget its own slice and never drops it", async () => {
      const { planUrlLookupSlices } = await importMod();
      const huge = `https://huge.example/${"ü".repeat(2000)}`; // ~12 kB encoded
      const urls = ["https://a.example/1", "https://a.example/2", huge, "https://a.example/3"];
      const slices = planUrlLookupSlices(urls);
      expect(slices).toEqual([[urls[0], urls[1]], [huge], [urls[3]]]);
      expect(slices.flat()).toEqual(urls);
    });

    it("a lone surrogate does not throw and is still planned (conservative cost)", async () => {
      const { planUrlLookupSlices } = await importMod();
      const bad = "https://a.example/\uD800";
      expect(() => encodeURIComponent(bad)).toThrow(); // the hazard is real
      const urls = ["https://a.example/1", bad, "https://a.example/2"];
      expect(() => planUrlLookupSlices(urls)).not.toThrow();
      expect(planUrlLookupSlices(urls).flat()).toEqual(urls);
      // The fallback cost is 9 bytes per UTF-16 unit (>= the 6 an encoded
      // pair needs per unit), so under a tight budget it is isolated, not
      // waved through as free.
      expect(planUrlLookupSlices([bad, "https://a.example/1"], 100, 150)).toEqual([
        [bad],
        ["https://a.example/1"],
      ]);
    });

    it("returns nothing for nothing, and honours the count cap for short urls", async () => {
      const { planUrlLookupSlices } = await importMod();
      expect(planUrlLookupSlices([])).toEqual([]);
      expect(planUrlLookupSlices(shortUrls(250)).map((s) => s.length)).toEqual([100, 100, 50]);
      expect(planUrlLookupSlices(shortUrls(5), 2).map((s) => s.length)).toEqual([2, 2, 1]);
    });

    it("cost is exactly the encoded length of the `in.(...)` value: fits at the limit, splits one byte under", async () => {
      const { planUrlLookupSlices } = await importMod();
      const urls = ["https://l.example/a/1", "https://l.example/a/2", "https://l.example/a/3"];
      const exact = encodedLen(urls);
      expect(planUrlLookupSlices(urls, 100, exact)).toEqual([urls]);
      expect(planUrlLookupSlices(urls, 100, exact - 1)).toEqual([[urls[0], urls[1]], [urls[2]]]);
      // A Turkish url costs its percent-encoded length, not its code-unit length.
      const tr = ["https://l.example/ş", "https://l.example/ç"];
      expect(planUrlLookupSlices(tr, 100, encodedLen(tr))).toEqual([tr]);
      expect(planUrlLookupSlices(tr, 100, encodedLen(tr) - 1)).toEqual([[tr[0]], [tr[1]]]);
    });

    it("never exceeds the budget with more than one url, never loses or reorders, on a mixed-length feed", async () => {
      const { planUrlLookupSlices } = await importMod();
      const mixed = Array.from({ length: 400 }, (_, i) => {
        const pad = (i * 53) % 380;
        const slug = i % 3 === 0 ? TR_SLUG : "plain-ascii-slug-";
        return `https://m.example/${i}/${slug.repeat(Math.ceil(pad / slug.length) || 1).slice(0, pad)}`;
      });
      for (const budget of [900, 2_500, 6_000]) {
        const slices = planUrlLookupSlices(mixed, 100, budget);
        expect(slices.flat()).toEqual(mixed);
        for (const s of slices) {
          expect(s.length).toBeLessThanOrEqual(100);
          if (s.length > 1) expect(encodedLen(s)).toBeLessThanOrEqual(budget);
        }
        expect(slices).toHaveLength(greedyMinimum(mixed, budget));
      }
    });
  });

  it("(3) retries a rejected slice once as two halves; when the halves succeed the lookup is ok with every row and no error line", async () => {
    const { lookupStoredByUrl, planUrlLookupSlices } = await importMod();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const urls = evrenselUrls(100);
      const slices = planUrlLookupSlices(urls);
      const first = slices[0]!;
      expect(first.length).toBeGreaterThan(1);
      let failed = false;
      const c = client((batch) => {
        if (!failed && batch[0] === first[0]) {
          failed = true;
          return reject("http2 error: stream error detected");
        }
        return allRows(batch);
      });

      const res = await lookupStoredByUrl(c.supabase, urls, "evrensel");

      expect(res.ok).toBe(true);
      expect(res.byUrl.size).toBe(100);
      expect([...res.byUrl.keys()].sort()).toEqual([...urls].sort());
      // slices + the failed attempt's two halves (the failed attempt itself is one of `slices`)
      expect(c.ins).toHaveLength(slices.length + 2);
      const mid = Math.ceil(first.length / 2);
      expect(c.ins.map((i) => i.urls)).toEqual(
        expect.arrayContaining([first.slice(0, mid), first.slice(mid)]),
      );
      expect(err).not.toHaveBeenCalled();
      // One recovery notice: slug only, never a url.
      expect(warn).toHaveBeenCalledTimes(1);
      const note = warn.mock.calls[0]!.map(String).join(" ");
      expect(note).toBe("[ingest] evrensel: known-url lookup recovered after split retry");
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  });

  it("(3b) an error envelope on the first attempt recovers the same way", async () => {
    const { lookupStoredByUrl } = await importMod();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const urls = shortUrls(100);
      let calls = 0;
      const c = client((batch) =>
        ++calls === 1 ? { data: null, error: { message: "canceling statement due to statement timeout" } } : allRows(batch),
      );
      const res = await lookupStoredByUrl(c.supabase, urls, "s");
      expect(res.ok).toBe(true);
      expect(res.byUrl.size).toBe(100);
      expect(c.ins.map((i) => i.urls.length)).toEqual([100, 50, 50]);
      expect(err).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  });

  it("(3c) a one-url slice is retried once as is, recovering or failing on that second try", async () => {
    const { lookupStoredByUrl } = await importMod();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const url = "https://l.example/only";
      let calls = 0;
      const transient = client((batch) => (++calls === 1 ? reject("stream error detected") : allRows(batch)));
      const ok = await lookupStoredByUrl(transient.supabase, [url], "s");
      expect(ok.ok).toBe(true);
      expect(transient.ins.map((i) => i.urls)).toEqual([[url], [url]]);

      const persistent = client(() => reject("stream error detected"));
      const bad = await lookupStoredByUrl(persistent.supabase, [url], "s");
      expect(bad.ok).toBe(false);
      expect(persistent.ins).toHaveLength(2); // once more, not a retry loop
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  });

  it("(4) a persistent failure fails open: ok=false, never throws, ONE error line with the slug and no url", async () => {
    const { lookupStoredByUrl } = await importMod();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const urls = evrenselUrls(100);
      const marked = urls[57]!;
      const c = client((batch) =>
        batch.includes(marked)
          ? // fetch errors embed the request url; the log line must not.
            reject(`error sending request for url (${marked}): stream error detected`)
          : allRows(batch),
      );

      const res = await lookupStoredByUrl(c.supabase, urls, "feedslug");

      expect(res.ok).toBe(false);
      expect(err).toHaveBeenCalledTimes(1);
      const line = err.mock.calls[0]!.map(String).join(" ");
      expect(line.startsWith("[ingest] feedslug: known-url lookup failed: ")).toBe(true);
      for (const forbidden of ["http", "evrensel", "/haber/", "işçiler", "%C5%9F", marked.slice(-30)]) {
        expect(line).not.toContain(forbidden);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  });

  it("(4b) when every request fails there is still exactly one error line and the promise resolves", async () => {
    const { lookupStoredByUrl } = await importMod();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const urls = evrenselUrls(100);
      const c = client((batch) => reject(`error sending request for url (${batch[0]}): stream error detected`));
      await expect(lookupStoredByUrl(c.supabase, urls, "feedslug")).resolves.toMatchObject({ ok: false });
      expect(err).toHaveBeenCalledTimes(1);
      expect(err.mock.calls[0]!.map(String).join(" ")).not.toContain("http");
    } finally {
      err.mockRestore();
    }
  });

  it("(5) a short-url feed keeps 100 urls per request: one request, no extra slices", async () => {
    const { lookupStoredByUrl } = await importMod();
    const urls = shortUrls(100);
    const c = client((batch) => allRows(batch));
    const res = await lookupStoredByUrl(c.supabase, urls, "short");
    expect(res.ok).toBe(true);
    expect(c.ins).toHaveLength(1);
    expect(c.ins[0]!.urls).toEqual(urls);
  });

  it("builds its slices with planUrlLookupSlices, not a count-only loop", () => {
    const src = readFileSync(resolvePath(__dirname, "../../supabase/functions/ingest/index.ts"), "utf8");
    const fn = /export async function lookupStoredByUrl\([\s\S]*?\n\}\n/.exec(src);
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(body).toContain("planUrlLookupSlices(");
    expect(body).not.toMatch(/\+=\s*TITLE_LOOKUP_BATCH/);
    expect(body).not.toMatch(/\.slice\(\s*j\s*,\s*j\s*\+/);
  });
});

describe("recordTitleVersions knownAbsent [hunt-11 A-ingest-cpu]", () => {
  type Fn = (
    supabase: unknown,
    chunk: ReadonlyArray<RecordTitleVersionsChunkRow>,
    preResolved?: ReadonlyMap<string, { id: string; title: string; source_id: string }>,
    knownAbsent?: ReadonlySet<string>,
  ) => Promise<{ titleVersions: number; titleWriteBacks: number }>;

  async function importFn(): Promise<{ fn: Fn; supabase: unknown }> {
    const { recordTitleVersions, supabase } = await importRecordTitleVersions();
    return { fn: recordTitleVersions as unknown as Fn, supabase };
  }

  const row = (n: number, title = "Yeni") => ({
    url: `https://abs.example/${n}`,
    title,
    source_id: "source-1",
  });

  it("does not select urls the caller already confirmed absent", async () => {
    const { fn, supabase } = await importFn();
    storedArticlesByUrl[row(3).url] = { id: "art-3", title: "Eski", source_id: "source-1" };

    const res = await fn(supabase, [row(1), row(2), row(3)], undefined, new Set([row(1).url, row(2).url]));

    expect(articlesUrlLookupCalls).toHaveLength(1);
    expect(articlesUrlLookupCalls[0]?.urls).toEqual([row(3).url]);
    expect(res.titleVersions).toBe(1);
  });

  it("makes no select at all when every url is known absent", async () => {
    const { fn, supabase } = await importFn();

    const res = await fn(supabase, [row(1), row(2)], undefined, new Set([row(1).url, row(2).url]));

    expect(articlesUrlLookupCalls).toHaveLength(0);
    expect(res).toEqual({ titleVersions: 0, titleWriteBacks: 0 });
  });

  it("pre-resolved rows win over the absent set, and are still compared", async () => {
    const { fn, supabase } = await importFn();
    const preResolved = new Map([[row(1).url, { id: "art-1", title: "Eski", source_id: "source-1" }]]);

    const res = await fn(supabase, [row(1)], preResolved, new Set([row(1).url]));

    expect(articlesUrlLookupCalls).toHaveLength(0);
    expect(res.titleVersions).toBe(1);
    expect(titleVersionInsertCalls[0]).toEqual([
      { article_id: "art-1", source_id: "source-1", old_title: "Eski", new_title: "Yeni" },
    ]);
  });

  it("with two or three arguments (or an empty set) behaves as before: every url is selected", async () => {
    const { fn, supabase } = await importFn();
    await fn(supabase, [row(1), row(2)]);
    await fn(supabase, [row(1), row(2)], new Map());
    await fn(supabase, [row(1), row(2)], new Map(), new Set());
    expect(articlesUrlLookupCalls.map((c) => c.urls)).toEqual([
      [row(1).url, row(2).url],
      [row(1).url, row(2).url],
      [row(1).url, row(2).url],
    ]);
  });
});

// ---------------------------------------------------------------------------
// A-ingest-cpu (hunt-11): the platform's 2 s CPU allowance is cumulative per
// isolate (reused isolates were shut down with CPUTime on their 2nd request).
// Ingest keeps an item budget per isolate in module state: a feed whose
// estimated item count (body bytes / 1500) does not fit what is left is
// deferred through the existing parse-deferral path.
// ---------------------------------------------------------------------------

describe("isolate item budget across cycles on one isolate [hunt-11 A-ingest-cpu]", () => {
  const PUB = "Fri, 23 Oct 2026 10:00:00 GMT";
  const CYCLE = 180_000;
  const small = {
    id: "src-iso-a-small",
    name: "Iso small",
    slug: "iso-a-small",
    url: "https://small.iso.example",
    rss_url: "https://small.iso.example/rss.xml",
  };
  const big = {
    id: "src-iso-b-big",
    name: "Iso big",
    slug: "iso-b-big",
    url: "https://big.iso.example",
    rss_url: "https://big.iso.example/rss.xml",
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  function seedBoth(extra: Record<string, unknown> = {}) {
    const row = { active: true, fetch_etag: null, fetch_last_modified: null, fetch_body_hash: null, fetch_fail_streak: 0, ...extra };
    // small first, big second: with offset 0 the base order is the fetch order.
    fakeSources.push({ ...small, ...row }, { ...big, ...row });
    fetcherItems[small.rss_url] = [{ title: "Küçük kaynağın tek haberi", link: `${small.url}/haber/tek`, pubDate: PUB }];
    fetcherItems[big.rss_url] = Array.from({ length: 45 }, (_, i) => ({
      title: `Büyük kaynağın haberi numara ${i}`,
      link: `${big.url}/haber/konu-${i}`,
      pubDate: PUB,
    }));
  }

  async function cycle(): Promise<Record<string, unknown>> {
    fetchFeedCalls.length = 0;
    upserted.length = 0;
    articlesUpsertCalls.length = 0;
    sourceFetchStateWrites.length = 0;
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");
    const res = await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  // A rotation offset of 0 for two sources: floor(t / CYCLE) is even.
  const evenSlot = (() => {
    const slot = Math.floor(Date.parse("2026-10-27T10:00:00Z") / CYCLE);
    return slot % 2 === 0 ? slot : slot + 1;
  })();
  const at = (cycleIndex: number) => (evenSlot + 2 * cycleIndex) * CYCLE;

  it("defers a feed that no longer fits, restores its validators, puts it first next cycle, and a fresh isolate parses it", async () => {
    process.env.INGEST_ISOLATE_ITEM_BUDGET = "60";
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    seedBoth();

    // --- cycle 1: a fresh isolate. 1 + 45 items fit under 60.
    vi.setSystemTime(at(0));
    fetcherResultOverrides[small.rss_url] = { bodyBytes: 1500, etag: '"s1"', bodyHash: "sh1" };
    fetcherResultOverrides[big.rss_url] = { bodyBytes: 45 * 1500, etag: '"b1"', bodyHash: "bh1" };
    const c1 = await cycle();
    expect(fetchFeedCalls.map((c) => c.sourceId)).toEqual([small.id, big.id]);
    expect(c1.parseDeferred).toBe(0);
    expect(c1.isolateBudgetDeferred).toBe(0);
    expect(c1.inserted).toBe(46);
    expect(c1.isolateItemsUsed).toBe(46);
    expect(c1.isolateCycles).toBe(1);

    // --- cycle 2: same isolate, the big feed changed. 46 + 45 > 60.
    vi.setSystemTime(at(1));
    fetcherResultOverrides[small.rss_url] = { notModified: true, status: 304 };
    fetcherResultOverrides[big.rss_url] = { bodyBytes: 45 * 1500, etag: '"b2"', bodyHash: "bh2" };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let c2: Record<string, unknown>;
    let lines2: string[];
    try {
      c2 = await cycle();
      lines2 = logSpy.mock.calls.map((a) => a.join(" "));
    } finally {
      logSpy.mockRestore();
    }
    expect(c2.parseDeferred).toBe(1);
    expect(c2.isolateBudgetDeferred).toBe(1);
    expect(c2.parseDeferredMaxStreak).toBe(1);
    expect(c2.fetched).toBe(0);
    expect(c2.inserted).toBe(0);
    expect(articlesUpsertCalls).toHaveLength(0);
    // A feed the isolate budget refused never reached the per-cycle parse budget.
    expect(c2.parsedBytes).toBe(0);
    expect(c2.isolateItemsUsed).toBe(46);
    expect(c2.isolateCycles).toBe(2);
    // The deferred feed leaves no trace in the fetch-state write.
    expect(sourceFetchStateWrites.flatMap((w) => w.rows).map((r) => r.id)).not.toContain(big.id);
    // One count-only line, no url and no headline.
    const budgetLines = lines2.filter((l) => l.includes("isolate item budget"));
    expect(budgetLines).toHaveLength(1);
    expect(budgetLines[0]).toContain("deferred 1 changed feed(s)");
    expect(budgetLines[0]).not.toContain("iso.example");

    // --- cycle 3: same isolate. The deferred feed is fetched FIRST, with the
    // validators it had before cycle 2 stamped its own, and is deferred again.
    vi.setSystemTime(at(2));
    fetcherResultOverrides[big.rss_url] = { bodyBytes: 45 * 1500, etag: '"b3"', bodyHash: "bh3" };
    const c3 = await cycle();
    expect(fetchFeedCalls[0]?.sourceId).toBe(big.id);
    expect(fetchFeedCalls[0]?.cached).toEqual({ etag: '"b1"' });
    expect(c3.parseDeferred).toBe(1);
    expect(c3.isolateBudgetDeferred).toBe(1);
    expect(c3.parseDeferredMaxStreak).toBe(2);
    expect(articlesUpsertCalls).toHaveLength(0);
    expect(c3.isolateItemsUsed).toBe(46);
    expect(c3.isolateCycles).toBe(3);

    // --- a new isolate: nothing used yet, so the feed is parsed.
    vi.resetModules();
    vi.setSystemTime(at(3));
    fetcherResultOverrides[big.rss_url] = { bodyBytes: 45 * 1500, etag: '"b4"', bodyHash: "bh4" };
    const c4 = await cycle();
    expect(c4.parseDeferred).toBe(0);
    expect(c4.isolateBudgetDeferred).toBe(0);
    expect(c4.fetched).toBe(1);
    expect(c4.inserted).toBe(45);
    expect(upserted).toHaveLength(45);
    expect(c4.isolateItemsUsed).toBe(45);
    expect(c4.isolateCycles).toBe(1);
  });

  it("settles a booking to the real item count: a feed smaller than its estimate gives the difference back", async () => {
    process.env.INGEST_ISOLATE_ITEM_BUDGET = "60";
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(0));
    seedBoth();
    // Both bodies claim 45 items by size, but carry 1 and 45 real ones.
    fetcherResultOverrides[small.rss_url] = { bodyBytes: 45 * 1500, etag: '"s1"', bodyHash: "sh1" };
    fetcherResultOverrides[big.rss_url] = { bodyBytes: 10 * 1500, etag: '"b1"', bodyHash: "bh1" };

    const c1 = await cycle();

    // small: est 45, real 1 -> 1. big: 1 + est 10 = 11 fits, real 45 -> 46.
    expect(c1.parseDeferred).toBe(0);
    expect(c1.isolateItemsUsed).toBe(46);
  });

  it("the very first feed of a fresh isolate is admitted whatever its size; the next one must fit", async () => {
    process.env.INGEST_ISOLATE_ITEM_BUDGET = "5";
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(0));
    seedBoth();
    // big goes first this cycle (it is the only feed that changed), then small.
    fetcherResultOverrides[big.rss_url] = { bodyBytes: 45 * 1500, etag: '"b1"', bodyHash: "bh1" };
    fetcherResultOverrides[small.rss_url] = { notModified: true, status: 304 };

    const c1 = await cycle();
    // Estimated 45 items against a limit of 5, yet admitted: nothing was used yet.
    expect(c1.isolateBudgetDeferred).toBe(0);
    expect(c1.inserted).toBe(45);
    expect(c1.isolateItemsUsed).toBe(45);

    // The same isolate, one more changed feed: even a one-item feed no longer fits.
    vi.setSystemTime(at(1));
    fetcherResultOverrides[big.rss_url] = { notModified: true, status: 304 };
    fetcherResultOverrides[small.rss_url] = { bodyBytes: 1500, etag: '"s2"', bodyHash: "sh2" };
    const c2 = await cycle();
    expect(c2.isolateBudgetDeferred).toBe(1);
    expect(c2.parseDeferred).toBe(1);
    expect(c2.inserted).toBe(0);
  });

  it("falls back to the default budget for a malformed INGEST_ISOLATE_ITEM_BUDGET", async () => {
    process.env.INGEST_ISOLATE_ITEM_BUDGET = "0x10";
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(0));
    seedBoth();
    fetcherResultOverrides[small.rss_url] = { bodyBytes: 1500, etag: '"s1"', bodyHash: "sh1" };
    fetcherResultOverrides[big.rss_url] = { bodyBytes: 45 * 1500, etag: '"b1"', bodyHash: "bh1" };

    const c1 = await cycle();

    // 5000 by default: nothing is deferred.
    expect(c1.isolateBudgetDeferred).toBe(0);
    expect(c1.inserted).toBe(46);
  });
});
