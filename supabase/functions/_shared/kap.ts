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
