// The transfer code of "Başka bir tarayıcıya taşı" on /saved and /takip: ONE line
// of plain JSON that holds both device-local lists (saved story ids and follows),
// its strict parser, and the Turkish copy of the panel.
//
// Pure module: no "use client", no browser API, no storage, no request. It is
// unit-tested directly (list-transfer.test.ts), and a source guard keeps every
// network and storage API out of it and out of the panel.
//
// Code format, written by JSON.stringify with the keys in this order:
//   {"format":"tayf-liste","v":1,"saved":["<lower-case uuid>",...],
//    "follows":[{"kind":"q","value":"asgari ücret"},...]}
// saved   storage order (oldest first), uuid-shaped ids only, lower-cased and
//         de-duplicated, at most the newest SAVED_MAX_IDS (the tail).
// follows only kind and value, never the stamps or the seen state: the importing
//         browser starts a fresh baseline through addFollow. At most MAX_FOLLOWS.
//
// The parser is all-or-nothing: one bad entry rejects the whole code and nothing is
// merged. Its only regex is the existing anchored UUID_RE.

import { normaliseBookmarkId, normaliseBookmarkIds } from "@/components/bookmark/bookmark-ids";
import { SAVED_MAX_IDS, UUID_RE } from "@/components/bookmark/saved-lookup";
import {
  canonicalFollow,
  followKey,
  MAX_FOLLOWS,
  type Follow,
  type FollowKind,
} from "@/lib/follows/follows";
import { formatCountTr } from "@/lib/format/number-tr";

export const TRANSFER_FORMAT = "tayf-liste";
export const TRANSFER_VERSION = 1;

/**
 * Longest pasted text that is read at all (UTF-16 length of the raw text, checked
 * before trimming or parsing). The largest legitimate code is about 42,100
 * characters: 1,000 ids at 39 each, plus 20 follows of about 151 each (a 64
 * code point value is at most 128 JSON characters, because only the double quote
 * and the backslash are escaped and Cc / Cs / Cf are already banned or stripped
 * by the keyword check), plus about 50 for the envelope. A test pins this.
 */
export const TRANSFER_MAX_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const TRANSFER_SUMMARY_TEXT = "Başka bir tarayıcıya taşı";
export const TRANSFER_INTRO_TEXT =
  "Kaydedilenleri ve takip listenizi başka bir tarayıcıya ya da cihaza taşımak için burada bir kod oluşturun, sonra kodu orada aynı bölüme yapıştırın.";
export const EXPORT_BUTTON_TEXT = "Dışa aktar";
export const EXPORT_CODE_LABEL = "Aktarma kodu";
export const IMPORT_LABEL_TEXT = "Diğer tarayıcıda oluşturduğunuz kodu yapıştırın";
export const IMPORT_HINT_TEXT =
  "İçe aktarmak bu tarayıcıdaki listelerden hiçbir şey silmez; yalnızca eksik olanları ekler.";
export const IMPORT_BUTTON_TEXT = "İçe aktar";
export const EXPORT_EMPTY_TEXT = "Bu tarayıcıda aktarılacak kayıtlı hikâye ya da takip yok.";
export const EXPORT_COPY_FAILED_TEXT = "Otomatik kopyalanamadı — kutudaki metni seçip kopyalayın.";
export const IMPORT_NOT_STORED_TEXT = "Kaydedilemedi: tarayıcı yerel depolamaya yazmaya izin vermiyor.";
export const IMPORT_NOTHING_TEXT = "Kodda aktarılacak bir şey yok.";
export const IMPORT_ALL_PRESENT_TEXT = "Koddaki her şey zaten listenizde.";

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export type BuiltTransfer = {
  code: string;
  /** How many saved ids the code holds. */
  saved: number;
  /** How many follows the code holds. */
  follows: number;
  /** How many valid saved ids there were before the newest-1000 cut. */
  savedTotal: number;
};

/**
 * The code for the given lists. `bookmarkIds` is the stored list (oldest first, so
 * its tail is the newest); anything that is not a uuid-shaped string is left out.
 */
export function buildTransferCode(
  bookmarkIds: readonly unknown[],
  follows: ReadonlyArray<Pick<Follow, "kind" | "value">>,
): BuiltTransfer {
  const ids = normaliseBookmarkIds(bookmarkIds).filter((id) => UUID_RE.test(id));
  const saved = ids.slice(-SAVED_MAX_IDS);
  const kept = follows.slice(0, MAX_FOLLOWS).map((f) => ({ kind: f.kind, value: f.value }));
  const code = JSON.stringify({
    format: TRANSFER_FORMAT,
    v: TRANSFER_VERSION,
    saved,
    follows: kept,
  });
  return { code, saved: saved.length, follows: kept.length, savedTotal: ids.length };
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export type TransferPayload = {
  saved: string[];
  follows: { kind: FollowKind; value: string }[];
};

export type TransferRejectReason = "empty" | "too-large" | "invalid";

export type TransferParse =
  | { ok: true; payload: TransferPayload }
  | { ok: false; reason: TransferRejectReason };

const TOP_KEYS = ["format", "v", "saved", "follows"] as const;
const FOLLOW_KEYS = ["kind", "value"] as const;

const INVALID: TransferParse = { ok: false, reason: "invalid" };
const TOO_LARGE: TransferParse = { ok: false, reason: "too-large" };

/** A non-null, non-array object whose own keys are exactly `keys` (so an own "__proto__" fails). */
function hasExactKeys(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  return (
    Object.keys(v).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(v, key))
  );
}

function isFollowKind(v: unknown): v is FollowKind {
  return v === "q" || v === "konu" || v === "gundem";
}

/**
 * Reads a pasted code. Checked in this order, stopping at the first failure:
 * not a string, longer than TRANSFER_MAX_CHARS (before trimming or parsing),
 * blank, not JSON (any throw, RangeError included), the wrong envelope, the
 * wrong format or version, saved / follows not arrays, too many entries, then
 * every entry. Never throws.
 */
export function parseTransferCode(raw: unknown): TransferParse {
  if (typeof raw !== "string") return INVALID;
  if (raw.length > TRANSFER_MAX_CHARS) return TOO_LARGE;
  if (raw.trim() === "") return { ok: false, reason: "empty" };

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return INVALID;
  }

  if (!hasExactKeys(data, TOP_KEYS)) return INVALID;
  if (data.format !== TRANSFER_FORMAT || data.v !== TRANSFER_VERSION) return INVALID;
  const { saved, follows } = data;
  if (!Array.isArray(saved) || !Array.isArray(follows)) return INVALID;
  if (saved.length > SAVED_MAX_IDS || follows.length > MAX_FOLLOWS) return TOO_LARGE;

  const ids = new Set<string>();
  for (const entry of saved) {
    // Anchored, no trim: a uuid with a trailing newline is not a uuid.
    if (typeof entry !== "string" || !UUID_RE.test(entry)) return INVALID;
    const id = normaliseBookmarkId(entry);
    if (id === null) return INVALID;
    ids.add(id);
  }

  const seen = new Set<string>();
  const out: TransferPayload["follows"] = [];
  for (const entry of follows) {
    if (!hasExactKeys(entry, FOLLOW_KEYS)) return INVALID;
    const { kind, value } = entry;
    if (!isFollowKind(kind) || typeof value !== "string") return INVALID;
    const canonical = canonicalFollow(kind, value);
    if (canonical === null) return INVALID;
    const key = followKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }

  return { ok: true, payload: { saved: Array.from(ids), follows: out } };
}

// ---------------------------------------------------------------------------
// Status text
// ---------------------------------------------------------------------------

function exportCountsText(built: Pick<BuiltTransfer, "saved" | "follows" | "savedTotal">): string {
  const follows = formatCountTr(built.follows);
  return built.savedTotal > built.saved
    ? `en yeni ${formatCountTr(built.saved)} kayıtlı hikâye (toplam ${formatCountTr(built.savedTotal)}), ${follows} takip`
    : `${formatCountTr(built.saved)} kayıtlı hikâye, ${follows} takip`;
}

/** The status after "Dışa aktar": what the code holds, and whether it reached the clipboard. */
export function exportSummaryText(
  built: Pick<BuiltTransfer, "saved" | "follows" | "savedTotal">,
  copied: boolean,
): string {
  const counts = exportCountsText(built);
  return copied
    ? `Kod kopyalandı: ${counts}.`
    : `Kod oluşturuldu: ${counts}. ${EXPORT_COPY_FAILED_TEXT}`;
}

/** The status when a pasted code is refused. */
export function importErrorText(reason: TransferRejectReason): string {
  if (reason === "empty") return "Önce bir aktarma kodu yapıştırın.";
  if (reason === "too-large") {
    return `Kod çok uzun: en fazla ${formatCountTr(SAVED_MAX_IDS)} kayıtlı hikâye ve ${formatCountTr(MAX_FOLLOWS)} takip aktarılabilir.`;
  }
  return "Kod okunamadı. Kodu eksiksiz kopyaladığınızdan emin olun.";
}

export type ImportCounts = { added: number; existing: number; skipped: number };

/** The status after a merge. The first matching rule wins. */
export function importSummaryText(result: {
  saved: ImportCounts;
  follows: ImportCounts;
  stored: boolean;
}): string {
  const { saved: s, follows: f } = result;
  if (!result.stored) return IMPORT_NOT_STORED_TEXT;
  if (s.added + s.existing + s.skipped + f.added + f.existing + f.skipped === 0) {
    return IMPORT_NOTHING_TEXT;
  }
  if (s.added === 0 && s.skipped === 0 && f.added === 0 && f.skipped === 0) {
    return IMPORT_ALL_PRESENT_TEXT;
  }
  let text = `${formatCountTr(s.added)} hikâye ve ${formatCountTr(f.added)} takip eklendi.`;
  if (s.existing + f.existing > 0) {
    text += ` Zaten listenizde olan ${formatCountTr(s.existing + f.existing)} kayıt atlandı.`;
  }
  if (s.skipped > 0) {
    text += ` ${formatCountTr(s.skipped)} hikâye eklenmedi: liste ${formatCountTr(SAVED_MAX_IDS)} kayda ulaştı.`;
  }
  if (f.skipped > 0) {
    text += ` ${formatCountTr(f.skipped)} takip eklenmedi: en fazla ${formatCountTr(MAX_FOLLOWS)} takip olabilir.`;
  }
  return text;
}
