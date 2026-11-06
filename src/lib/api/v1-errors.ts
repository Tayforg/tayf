/**
 * The error strings of the keyed /api/v1 surface, in one place.
 *
 * Two things read this module: `keys.ts` (the shared key, method and not-found
 * refusals, so their wire text is written once) and the /gelistirici "Hatalar"
 * table (src/app/gelistirici/page.tsx renders `V1_ERROR_ROWS`). The v1 route
 * files keep their own literals ("Invalid cursor", "Cluster not found", ...):
 * an error string reads best next to the check that raises it.
 * src/lib/api/v1-errors.test.ts scans those files and fails when a message the
 * API sends is missing from the row for its status, or a catalogued message is
 * never sent, so the docs cannot drift from the code.
 *
 * Zero imports and no clock: the page that renders it must stay static.
 */

/** Wire messages shared by more than one call site. Never reword: clients match on them. */
export const V1_ERROR = {
  missingKey: "Missing or invalid API key",
  keyRevoked: "API key revoked",
  tooManyRequests: "Too many requests",
  dailyLimit: "Daily limit exceeded",
  methodNotAllowed: "Method not allowed",
  notFound: "Not found",
  internal: "Internal server error",
} as const;

export interface V1ErrorRow {
  status: number;
  /**
   * The `error` strings sent with this status. A validator message such as
   * "Invalid limit: must be an integer 1..100" is catalogued by its stable
   * prefix before the first ':'.
   */
  messages: readonly string[];
  meaningTr: string;
}

/** Statuses strictly ascending (the page renders them in this order). */
export const V1_ERROR_ROWS: readonly V1ErrorRow[] = [
  {
    status: 301,
    messages: ["Cluster merged"],
    meaningTr: "Küme başka bir kümeyle birleştirildi; details.merged_into yeni kümenin kimliğini verir.",
  },
  {
    status: 400,
    messages: [
      "Invalid since",
      "Invalid limit",
      "Invalid cursor",
      "Invalid format",
      "Invalid cluster id",
      "Invalid slug",
      "Invalid ticker",
    ],
    meaningTr: "İstek parametresi geçersiz.",
  },
  {
    status: 401,
    messages: [V1_ERROR.missingKey],
    meaningTr: "Authorization başlığı eksik, biçimsiz veya bilinmeyen anahtar.",
  },
  {
    status: 403,
    messages: [V1_ERROR.keyRevoked],
    meaningTr: "Anahtar iptal edilmiş.",
  },
  {
    status: 404,
    messages: ["Cluster not found", "Source not found", V1_ERROR.notFound],
    meaningTr: "Küme ya da kaynak yok, arşivlenmiş ya da yol bilinmiyor.",
  },
  {
    status: 405,
    messages: [V1_ERROR.methodNotAllowed],
    meaningTr: "Bu uç nokta yalnızca GET, HEAD ve OPTIONS kabul eder.",
  },
  {
    status: 429,
    messages: [V1_ERROR.tooManyRequests, V1_ERROR.dailyLimit],
    meaningTr: "Anonim taban, dakikalık veya günlük sınır aşıldı.",
  },
  {
    status: 500,
    messages: [V1_ERROR.internal],
    meaningTr: "Beklenmeyen sunucu hatası.",
  },
  {
    status: 503,
    messages: ["Service temporarily unavailable"],
    meaningTr:
      "Veritabanı geçici olarak yanıt vermiyor. Yanıtta code: upstream_unavailable alanı ve Retry-After: 30 (saniye) başlığı bulunur; bir süre bekleyip yeniden deneyin.",
  },
];
