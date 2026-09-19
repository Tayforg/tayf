// supabase/functions/_shared/kap.ts
//
// Pure helpers for the kap-ingest Edge Function: request bodies, row
// mapping, Turkish folding and the auto-alias rule. No Deno globals, so
// vitest can import this file directly (tests/functions/kap-ingest.test.ts).
//
// KAP facts these encode (verified 2026-09-13 against www.kap.org.tr):
//   - list endpoint: POST /tr/api/disclosure/members/byCriteria, JSON body
//     below, newest first, hard cap 2000 rows per response.
//   - publishDate is "DD.MM.YYYY HH:mm:ss" in Europe/Istanbul (fixed +03:00).
//   - stockCodes / relatedStocks are comma-separated strings or null.
//   - the company list is embedded as an escaped RSC payload in the HTML of
//     /tr/bildirim-sorgu (one JSON object per KAP member, kapMemberOid first).

export const KAP_BASE = "https://www.kap.org.tr";
export const KAP_LIST_PATH = "/tr/api/disclosure/members/byCriteria";
export const KAP_COMPANIES_PATH = "/tr/bildirim-sorgu";
export const KAP_PAGE_CAP = 2000;
export const KAP_CLASSES = ["ODA", "DKB", "DG", "FR"] as const;

// Honest, contactable bot identity (SEC-06/TS-03) — replaces the fabricated
// desktop-Chrome UA kap-ingest and quotes-ingest used to send. Reuses the
// identity the repo already publishes and that already resolves
// (_shared/og-image.ts:62, _shared/rss/fetcher.ts:161,174 — tayf.app is a
// live site) rather than a new `+https://www.tayfhaber.com/bot` URL that
// 404s (src/app/ has no `bot` route). Shared by both Edge Functions so the
// string only needs to be right in one place.
export const TAYF_BOT_UA =
  "Mozilla/5.0 (compatible; Tayf/1.0; +https://tayf.app) finance-edge";

// ---------------------------------------------------------------------------
// Retry/backoff wrapper (SEC-07) — used by kap-ingest's fetchDay and
// quotes-ingest's fetchChart so both polite-scraping surfaces (kap.org.tr,
// Yahoo) back off on 429/503 instead of replaying the same block every
// 2-5 min forever, and give up immediately — no retry — on 403 so a real
// block doesn't get hammered 720x/day by kap-drain. Deliberately NOT the
// persisted `kap_blocked_until` breaker the review also floated: that needs
// a table and is explicitly deferred for this pack.
// ---------------------------------------------------------------------------

export interface FetchRetryOptions {
  /** Extra attempts after the first, only for 429/503. Default 2. */
  retries?: number;
  /** Ceiling for both the Retry-After header and the backoff fallback. */
  maxBackoffMs?: number;
  /** Injectable for tests; defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Per-attempt fetch timeout. `AbortSignal.timeout()` starts counting at
   * construction, so a caller-supplied `init.signal` built once outside the
   * retry loop has its budget burned by the backoff sleep itself — a
   * `Retry-After` longer than what's left aborts the retried fetch instantly
   * and turns a legible 429 into an opaque AbortError. When set, a fresh
   * timeout signal is built for every attempt instead (merged with
   * `init.signal` if the caller also passed one).
   */
  timeoutMs?: number;
}

const DEFAULT_MAX_BACKOFF_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a `Retry-After` header — delta-seconds ("2") or an HTTP-date — into
 * milliseconds. Returns null when absent or unparseable so the caller can
 * fall back to its own backoff schedule.
 */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return null;
}

/**
 * `fetch()` with bounded retry for 429/503 and an immediate, non-retried
 * stop on 403. Every other outcome (2xx, or any 4xx/5xx other than
 * 429/403/503) is returned on the first attempt. Callers keep their
 * existing `if (!res.ok) throw ...` handling — a 403 or an exhausted
 * 429/503 still surfaces as a failure the caller records, it just isn't
 * replayed against a host that already told us to stop.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs;

  for (let attempt = 0; ; attempt++) {
    // Fresh per-attempt signal (SEC-07): reusing a single AbortSignal.timeout()
    // built once outside this loop means the backoff sleep eats into that
    // signal's own budget, so a retried attempt can abort before it even
    // starts.
    const signal = timeoutMs === undefined
      ? init.signal
      : init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const res = await fetch(url, { ...init, signal });
    if (res.ok || res.status === 403) return res;
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const headerMs = parseRetryAfterMs(res.headers.get("retry-after"));
      const backoffMs = Math.min(headerMs ?? 1000 * 2 ** attempt, maxBackoffMs);
      await sleep(backoffMs);
      continue;
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker (SEC-07 follow-up, migration 059) -- pure predicate and
// error type only. The persisted state (kap_fetch_state) is read/written
// by kap-ingest/index.ts's runCycle, which owns the Supabase client; this
// file stays Deno-free so vitest can exercise the trip decision directly.
// ---------------------------------------------------------------------------

/** How long a tripped breaker stays open before the next tick tries again. */
export const KAP_BREAKER_BLOCK_MS = 6 * 60 * 60 * 1000;

/**
 * True only for the two statuses fetchWithRetry's retry ladder can exhaust
 * on and call "the origin told us to stop": 403 (immediate, no retry) and
 * 429 (retried up to `retries` times, then still 429). Any other outcome
 * -- a 5xx, or a thrown network/timeout error that never reaches this
 * predicate at all -- is transient and must NOT trip the breaker.
 */
export function isBreakerTripStatus(status: number): boolean {
  return status === 403 || status === 429;
}

/**
 * Thrown by index.ts's fetchDay when KAP returns a non-ok status after
 * fetchWithRetry's ladder finishes. Carries the final HTTP status so the
 * caller can decide `isBreakerTripStatus(status)` without re-parsing the
 * error message.
 */
export class KapFetchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "KapFetchError";
    this.status = status;
  }
}

export interface KapListItem {
  publishDate: string;
  kapTitle: string | null;
  disclosureClass: string | null;
  disclosureType: string | null;
  disclosureCategory: string | null;
  summary: string | null;
  subject: string | null;
  relatedStocks: string | null;
  year: string | number | null;
  ruleType: string | null;
  period: string | null;
  disclosureIndex: number;
  isLate: boolean | null;
  stockCodes: string | null;
  attachmentCount: number | null;
  modifyStatus: string | null;
  [k: string]: unknown;
}

export interface KapDisclosureRow {
  disclosure_index: number;
  published_at: string;
  kap_title: string | null;
  stock_codes: string[];
  related_stocks: string[];
  disclosure_class: string | null;
  disclosure_type: string | null;
  disclosure_category: string | null;
  subject: string | null;
  summary: string | null;
  is_late: boolean | null;
  year: string | null;
  period: string | null;
  rule_type: string | null;
  attachment_count: number | null;
  modify_status: string | null;
  raw: KapListItem;
}

export interface BistCompanyRow {
  kap_member_oid: string;
  mkk_member_oid: string | null;
  tickers: string[];
  title: string;
  city: string | null;
  kap_state: string | null;
  member_type: string | null;
  shares_traded: boolean;
}

export function kapQueryBody(fromDate: string, toDate: string, disclosureClass = ""): Record<string, unknown> {
  return {
    fromDate,
    toDate,
    memberType: "IGS",
    mkkMemberOidList: [],
    inactiveMkkMemberOidList: [],
    disclosureClass,
    subjectList: [],
    isLate: "",
    mainSector: "",
    sector: "",
    subSector: "",
    marketOid: "",
    index: "",
    bdkReview: "",
    bdkMemberOidList: [],
    year: "",
    term: "",
    ruleType: "",
    period: "",
    fromSrc: false,
    srcCategory: "",
    disclosureIndexList: [],
  };
}

/** "11.09.2026 23:33:31" -> "2026-09-11T23:33:31+03:00". Throws on garbage. */
export function parseKapDate(s: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`[kap] bad publishDate: ${JSON.stringify(s)}`);
  const [, d, mo, y, h, mi, se] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}+03:00`;
}

export function splitCodes(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
}

// Exchange-filed notices (circuit breakers, market announcements) carry no
// stockCodes; the paper is named at the start of the summary as "CODE.E".
const SUMMARY_CODE = /^([A-Z0-9]{3,6})\.E\b/;

export function mapDisclosure(r: KapListItem): KapDisclosureRow {
  let stockCodes = splitCodes(r.stockCodes);
  if (stockCodes.length === 0) {
    const m = SUMMARY_CODE.exec((r.summary ?? "").trim());
    if (m) stockCodes = [m[1]!];
  }
  return {
    disclosure_index: r.disclosureIndex,
    published_at: parseKapDate(r.publishDate),
    kap_title: r.kapTitle ?? null,
    stock_codes: stockCodes,
    related_stocks: splitCodes(r.relatedStocks),
    disclosure_class: r.disclosureClass ?? null,
    disclosure_type: r.disclosureType ?? null,
    disclosure_category: r.disclosureCategory ?? null,
    subject: r.subject?.trim() ?? null,
    summary: r.summary?.trim() ?? null,
    is_late: r.isLate ?? null,
    year: r.year == null ? null : String(r.year),
    period: r.period ?? null,
    rule_type: r.ruleType ?? null,
    attachment_count: r.attachmentCount ?? null,
    modify_status: r.modifyStatus ?? null,
    raw: r,
  };
}

/** Istanbul calendar date (fixed UTC+3, no DST) as YYYY-MM-DD, shifted by offsetDays. */
export function istanbulDate(offsetDays = 0, now = Date.now()): string {
  return new Date(now + (3 * 3600 + offsetDays * 86400) * 1000).toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD strings from `from` to `to`. */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Turkish folding — mirror of public.fold_tr() in migration 049. Keep in sync.
// ---------------------------------------------------------------------------

const FOLD_FROM = "ŞĞÇÖÜİIşğçöüıÂÎÛâîû";
const FOLD_TO = "SGCOUIIsgcouiAIUaiu";

export function foldTr(s: string): string {
  let out = "";
  for (const ch of s) {
    const i = FOLD_FROM.indexOf(ch);
    out += i === -1 ? ch : FOLD_TO[i];
  }
  return out.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Tokens that carry no identity: legal forms and sector nouns.
const LEGAL = new Set([
  "a", "s", "t", "as", "tas", "anonim", "sirketi", "ltd", "sti", "ve",
  "sanayi", "sanayii", "ticaret", "holding", "yatirim", "yatirimlari",
  "ortakligi", "gayrimenkul", "menkul", "degerler", "kiymetler", "bankasi",
  "katilim", "finans", "finansal", "faktoring", "kiralama", "elektrik",
  "uretim", "enerji", "insaat", "turizm", "gida", "tekstil", "kimya",
  "dagitim", "pazarlama", "ihracat", "ithalat", "san", "tic", "urunleri",
  "hizmetleri", "teknoloji", "entegre", "cimento", "madencilik", "otomotiv",
  "sigorta", "hayat", "emeklilik", "portfoy", "yonetimi", "varlik", "grubu",
  "grup", "girisim", "sermayesi", "endustri", "endustrisi", "isletmeleri",
  "isletmesi", "tesisleri", "fabrikasi", "fabrikalari", "genel",
]);

// First tokens too common to be a name on their own; these companies need a
// manual alias in bist_aliases (migration 049 seeds the large caps).
const GENERIC = new Set([
  "turk", "turkiye", "anadolu", "istanbul", "ankara", "izmir", "ak", "is",
  "yapi", "dogan", "milli", "global", "net", "smart", "royal", "bir", "pay",
  "ata", "ulusal", "avrupa", "ege", "marmara", "kar", "kaya", "gunes", "bati",
  "dogu", "kuzey", "guney", "yeni", "ilk", "son", "buyuk", "kucuk", "ozel",
  "ortak", "dunya", "meta", "alfa", "beta", "birlik", "birlesik", "orta",
  "ana", "kent", "sehir", "deniz", "hava", "kara", "yol", "para", "altin",
  "gumus", "demir", "celik", "bakir", "petrol", "gaz", "su", "un", "sut",
  "et", "seker", "tarim", "orman", "toprak", "tas", "cam", "kagit", "plastik",
]);

/**
 * One folded alias per company: the first title token that is not a legal
 * form, at least 4 chars, and not generic. Returns null when the rule has
 * nothing safe to say (then only the ticker code and manual aliases match).
 *
 * ponytail: single-token rule. Two-token names ("yapi kredi", "turk hava
 * yollari") come from the manual seed; widen the rule when the manual list
 * stops keeping up.
 */
export function autoAlias(title: string): string | null {
  const first = foldTr(title).split(" ").find((t) => !LEGAL.has(t));
  if (!first || first.length < 4 || GENERIC.has(first) || /^\d+$/.test(first)) return null;
  return first;
}

// ---------------------------------------------------------------------------
// Company list scraped from the RSC payload of /tr/bildirim-sorgu.
// ---------------------------------------------------------------------------

interface KapMember {
  kapMemberOid: string;
  mkkMemberOid?: string | null;
  kapMemberTitle?: string | null;
  kapMemberType?: string | null;
  kapMemberState?: string | null;
  payIslemDurumu?: string | null;
  stockCode?: string | null;
  cityName?: string | null;
}

export function parseCompanies(html: string): BistCompanyRow[] {
  const un = html.replace(/\\"/g, '"');
  const seen = new Map<string, KapMember>();
  const key = '"kapMemberOid":';
  let i = 0;
  while ((i = un.indexOf(key, i)) !== -1) {
    const start = un.lastIndexOf("{", i);
    const end = un.indexOf("}", i);
    if (start === -1 || end === -1) break;
    try {
      const o = JSON.parse(un.slice(start, end + 1)) as KapMember;
      if (o.kapMemberOid) seen.set(o.kapMemberOid, { ...(seen.get(o.kapMemberOid) ?? {}), ...o });
    } catch {
      // not a member object (nested payload noise) — skip
    }
    i = end;
  }
  const rows: BistCompanyRow[] = [];
  for (const o of seen.values()) {
    const tickers = splitCodes(o.stockCode).filter((c) => c !== "-");
    if (tickers.length === 0 || !o.kapMemberTitle) continue;
    rows.push({
      kap_member_oid: o.kapMemberOid,
      mkk_member_oid: o.mkkMemberOid ?? null,
      tickers,
      title: o.kapMemberTitle,
      city: o.cityName ?? null,
      kap_state: o.kapMemberState ?? null,
      member_type: o.kapMemberType ?? null,
      shares_traded: o.kapMemberState === "A" && o.payIslemDurumu === "1",
    });
  }
  return rows;
}
