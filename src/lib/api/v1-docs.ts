import { API_TIER_LIMITS, type ApiTier } from "@/lib/api/keys";
import {
  V1_DEFAULT_LIMIT,
  V1_MAX_LIMIT,
  V1_MAX_SINCE_DAYS,
  V1_POLITICS_THRESHOLD,
} from "@/lib/api/v1-clusters";
import { V1_PICKUP_DEFAULT_DAYS, V1_PICKUP_MAX_DAYS } from "@/lib/api/v1-kap-pickup";
import { PICKUP_WINDOW_HOURS } from "@/lib/finance/kap-pickup";

/**
 * Pack `gelistirici` — the single typed source of truth for the keyed
 * `/api/v1` surface's developer-facing description. BOTH `/gelistirici`
 * (src/app/gelistirici/page.tsx) and the OpenAPI 3.1 builder
 * (src/lib/api/openapi.ts) read `V1_ENDPOINTS` / `API_PLANS` from here —
 * neither hand-retypes a limit, a path or a param bound, so the page, the
 * machine-readable spec and the actual route handlers can never silently
 * drift apart (see tests/api/v1-openapi-contract.test.ts, which reads the
 * route sources directly and fails if this module falls out of sync).
 */

export interface V1ParamDoc {
  name: string;
  in: "query" | "path";
  required: boolean;
  schema: {
    type: "string" | "integer";
    format?: "date-time" | "uuid";
    minimum?: number;
    maximum?: number;
    default?: number;
  };
  descriptionTr: string;
  descriptionEn: string;
}

export interface V1ResponseDoc {
  status: number;
  descriptionTr: string;
  descriptionEn: string;
  schema?:
    | "ClusterListResponse"
    | "ClusterItemResponse"
    | "SourceListResponse"
    | "KapPickupResponse"
    | "Error";
}

export interface V1EndpointDoc {
  method: "GET" | "OPTIONS";
  path: string;
  auth: "bearer" | "none";
  summaryTr: string;
  summaryEn: string;
  notesTr: string[];
  params: V1ParamDoc[];
  responses: V1ResponseDoc[];
}

// Reused across every 4xx/5xx response below — none of these hand-retype
// the English error strings requireApiKey()/the routes actually return;
// see docs/api.md's "Response codes" table, which this mirrors.
const RESP_400: V1ResponseDoc = {
  status: 400,
  descriptionTr: "Geçersiz istek parametresi.",
  descriptionEn: "The request parameters failed validation.",
  schema: "Error",
};
const RESP_401: V1ResponseDoc = {
  status: 401,
  descriptionTr: "Authorization başlığı eksik, biçimsiz veya bilinmeyen bir anahtar.",
  descriptionEn: "Missing/malformed Authorization header, or an unknown key.",
  schema: "Error",
};
const RESP_403: V1ResponseDoc = {
  status: 403,
  descriptionTr: "Anahtar iptal edilmiş.",
  descriptionEn: "The presented API key has been revoked.",
  schema: "Error",
};
const RESP_404_CLUSTER: V1ResponseDoc = {
  status: 404,
  descriptionTr: "Küme bulunamadı veya arşivlenmiş.",
  descriptionEn: "Unknown or archived cluster id.",
  schema: "Error",
};
const RESP_429: V1ResponseDoc = {
  status: 429,
  descriptionTr:
    "Anonim taban, dakikalık veya günlük sınır aşıldı; details.retryAfterMs taşır.",
  descriptionEn:
    "Anonymous floor, per-minute or daily cap exceeded; carries details.retryAfterMs.",
  schema: "Error",
};
const RESP_500: V1ResponseDoc = {
  status: 500,
  descriptionTr: "Beklenmeyen sunucu hatası.",
  descriptionEn: "Unexpected server error.",
  schema: "Error",
};

const SINCE_PARAM: V1ParamDoc = {
  name: "since",
  in: "query",
  required: false,
  schema: { type: "string", format: "date-time" },
  descriptionTr: `updated_at için alt sınır, tam ISO 8601 zaman damgası (T ve saniye ile). Varsayılan: şimdi−24 saat. ${V1_MAX_SINCE_DAYS} günden eski değerler sessizce ${V1_MAX_SINCE_DAYS} güne çekilir.`,
  descriptionEn: `Lower bound on updated_at, a full ISO 8601 timestamp (with T and seconds). Default: now−24h. Values older than ${V1_MAX_SINCE_DAYS} days are silently clamped to ${V1_MAX_SINCE_DAYS} days.`,
};

const LIMIT_PARAM: V1ParamDoc = {
  name: "limit",
  in: "query",
  required: false,
  schema: {
    type: "integer",
    minimum: 1,
    maximum: V1_MAX_LIMIT,
    default: V1_DEFAULT_LIMIT,
  },
  descriptionTr: `Döndürülecek en çok küme sayısı, 1–${V1_MAX_LIMIT} arası tam sayı (varsayılan ${V1_DEFAULT_LIMIT}).`,
  descriptionEn: `Maximum number of clusters to return, an integer 1–${V1_MAX_LIMIT} (default ${V1_DEFAULT_LIMIT}).`,
};

const ID_PARAM: V1ParamDoc = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
  descriptionTr: "Küme UUID'si.",
  descriptionEn: "The cluster's UUID.",
};

const TICKER_PARAM: V1ParamDoc = {
  name: "ticker",
  in: "query",
  required: true,
  schema: { type: "string" },
  descriptionTr: "2–6 büyük harf/rakamdan oluşan hisse kodu (girişte büyük harfe çevrilir).",
  descriptionEn: "A 2–6 character uppercase-alphanumeric ticker (input is normalized to upper).",
};

const PICKUP_SINCE_PARAM: V1ParamDoc = {
  name: "since",
  in: "query",
  required: false,
  schema: { type: "string", format: "date-time" },
  descriptionTr: `KAP bildirimi için alt sınır, tam ISO 8601 zaman damgası. Varsayılan: ${V1_PICKUP_DEFAULT_DAYS} gün önce. Gelecekteki bir değer reddedilir (400); ${V1_PICKUP_MAX_DAYS} günden eski değerler sessizce ${V1_PICKUP_MAX_DAYS} güne çekilir.`,
  descriptionEn: `Lower bound on the KAP disclosure timestamp, a full ISO 8601 timestamp. Default: ${V1_PICKUP_DEFAULT_DAYS} days ago. A future value is rejected (400); values older than ${V1_PICKUP_MAX_DAYS} days are silently clamped to ${V1_PICKUP_MAX_DAYS} days.`,
};

const PICKUP_LIMIT_PARAM: V1ParamDoc = {
  ...LIMIT_PARAM,
  descriptionTr: `Döndürülecek en çok bildirim sayısı, 1–${V1_MAX_LIMIT} arası tam sayı (varsayılan ${V1_DEFAULT_LIMIT}), en yeniden en eskiye.`,
  descriptionEn: `Maximum number of disclosures to return, an integer 1–${V1_MAX_LIMIT} (default ${V1_DEFAULT_LIMIT}), most recent first.`,
};

export const V1_ENDPOINTS: V1EndpointDoc[] = [
  {
    method: "GET",
    path: "/api/v1/clusters",
    auth: "bearer",
    summaryTr: "Haber kümelerini listele",
    summaryEn: "List news clusters",
    notesTr: [
      `Yalnızca üyelerinin en az %${Math.round(V1_POLITICS_THRESHOLD * 100)}'ı politika/son dakika kategorisinde olan kümeler döner; ekonomi ve spor kümeleri bu uç noktada yoktur.`,
      `since, updated_at için alt sınırdır; ${V1_MAX_SINCE_DAYS} günden eski değerler sessizce ${V1_MAX_SINCE_DAYS} güne çekilir.`,
      "Yanıt, limit'ten az küme içerebilir: en yeni en çok 300 aday arasından süzülür.",
      "title, özgün başlığa geri düşebilir; bu durumda başlığın hakları ilgili yayın kuruluşuna aittir.",
      "blindspot_side, haberi YAPAN tarafın kategorisidir — sessiz kalan taraf değil.",
      "is_blindspot, sitenin kör nokta geri çağırma (recall veto) kuralını uygular.",
      "sources listesi toplayıcı ve niş türündeki kaynakları da içerir.",
    ],
    params: [SINCE_PARAM, LIMIT_PARAM],
    responses: [
      {
        status: 200,
        descriptionTr: "Küme listesi.",
        descriptionEn: "The cluster list.",
        schema: "ClusterListResponse",
      },
      RESP_400,
      RESP_401,
      RESP_403,
      RESP_429,
      RESP_500,
    ],
  },
  {
    method: "OPTIONS",
    path: "/api/v1/clusters",
    auth: "none",
    summaryTr: "CORS ön-uçuş isteği",
    summaryEn: "CORS preflight request",
    notesTr: [],
    params: [],
    responses: [
      {
        status: 204,
        descriptionTr: "Anahtarsız ön-uçuş yanıtı, gövde yok.",
        descriptionEn: "Keyless preflight response, no body.",
      },
    ],
  },
  {
    method: "GET",
    path: "/api/v1/clusters/{id}",
    auth: "bearer",
    summaryTr: "Tek bir kümeyi getir",
    summaryEn: "Get a single cluster",
    notesTr: [
      "Tek küme okumasında siyaset süzgeci uygulanmaz; arşivlenmiş kümeler 404 döner.",
    ],
    params: [ID_PARAM],
    responses: [
      {
        status: 200,
        descriptionTr: "Küme kaydı.",
        descriptionEn: "The cluster record.",
        schema: "ClusterItemResponse",
      },
      RESP_400,
      RESP_401,
      RESP_403,
      RESP_404_CLUSTER,
      RESP_429,
      RESP_500,
    ],
  },
  {
    method: "OPTIONS",
    path: "/api/v1/clusters/{id}",
    auth: "none",
    summaryTr: "CORS ön-uçuş isteği",
    summaryEn: "CORS preflight request",
    notesTr: [],
    params: [],
    responses: [
      {
        status: 204,
        descriptionTr: "Anahtarsız ön-uçuş yanıtı, gövde yok.",
        descriptionEn: "Keyless preflight response, no body.",
      },
    ],
  },
  {
    method: "GET",
    path: "/api/v1/sources",
    auth: "bearer",
    summaryTr: "Kaynak kaydını listele",
    summaryEn: "List the source registry",
    notesTr: ["Yalnızca etkin kaynaklar döner, isme göre sıralı."],
    params: [],
    responses: [
      {
        status: 200,
        descriptionTr: "Kaynak listesi.",
        descriptionEn: "The source list.",
        schema: "SourceListResponse",
      },
      RESP_401,
      RESP_403,
      RESP_429,
      RESP_500,
    ],
  },
  {
    method: "OPTIONS",
    path: "/api/v1/sources",
    auth: "none",
    summaryTr: "CORS ön-uçuş isteği",
    summaryEn: "CORS preflight request",
    notesTr: [],
    params: [],
    responses: [
      {
        status: 204,
        descriptionTr: "Anahtarsız ön-uçuş yanıtı, gövde yok.",
        descriptionEn: "Keyless preflight response, no body.",
      },
    ],
  },
  {
    method: "GET",
    path: "/api/v1/kap/pickup",
    auth: "bearer",
    summaryTr: "KAP bildirimlerinin medyada yankısı",
    summaryEn: "Media pickup of a ticker's KAP disclosures",
    notesTr: [
      `"/ekonomi/[ticker]" sayfasındaki "Medyada yankı" panelinin anahtarlı yansımasıdır: her KAP bildirimi için, bildirimden sonraki ${PICKUP_WINDOW_HOURS} saat içinde hangi bölgeden (iktidar/bağımsız/muhalefet) ne kadar basın yankısı oluştuğunu döner.`,
      "Pencere kuralı harfiyendir: her bildirim, kendi [bildirim_zamanı, bildirim_zamanı+48s) penceresinde yayınlanan her haberi sayar; bildirimden önceki bir haber asla yankı sayılmaz. İki bildirim 48 saat içine düşerse aynı haber her ikisine de sayılabilir — bu, her kayıttaki overlapping_disclosures alanıyla görünür kılınır, sessizce tekilleştirilmez.",
      "relevance_filter: Jev'in ticker_relevance gölge modelinin 0.2 altında puanladığı haberler dışlanır (ör. aynı adlı bir siyasi parti-hisse kodu çakışması); puanlanmamış haberler her zaman tutulur. İlgi puanı sorgusu başarısız olursa uç nokta 500 dönmek yerine relevance_filter.applied: false ile açık başarısız olur.",
      "disclosure_coverage görünümü asla sorgulanmaz (üretimde 60 saniyede zaman aşımına uğradı); sorgu her zaman kap_disclosures / article_tickers üzerinden hisse kodu ve zaman sınırlıdır.",
    ],
    params: [TICKER_PARAM, PICKUP_SINCE_PARAM, PICKUP_LIMIT_PARAM],
    responses: [
      {
        status: 200,
        descriptionTr: "Bildirim yankı listesi.",
        descriptionEn: "The disclosure pickup list.",
        schema: "KapPickupResponse",
      },
      RESP_400,
      RESP_401,
      RESP_403,
      RESP_429,
      RESP_500,
    ],
  },
  {
    method: "OPTIONS",
    path: "/api/v1/kap/pickup",
    auth: "none",
    summaryTr: "CORS ön-uçuş isteği",
    summaryEn: "CORS preflight request",
    notesTr: [],
    params: [],
    responses: [
      {
        status: 204,
        descriptionTr: "Anahtarsız ön-uçuş yanıtı, gövde yok.",
        descriptionEn: "Keyless preflight response, no body.",
      },
    ],
  },
  {
    method: "GET",
    path: "/api/v1/openapi.json",
    auth: "none",
    summaryTr: "OpenAPI 3.1 tanımı",
    summaryEn: "OpenAPI 3.1 description",
    notesTr: [],
    params: [],
    responses: [
      {
        status: 200,
        descriptionTr: "Bu belgenin kendisi, statik OpenAPI 3.1 JSON.",
        descriptionEn: "This document itself, static OpenAPI 3.1 JSON.",
      },
    ],
  },
];

export interface ApiPlan {
  tier: ApiTier;
  labelTr: string;
  perMinute: number;
  perDay: number;
  priceTr: string | null;
  howTr: string;
}

export const API_PLANS: ApiPlan[] = [
  {
    tier: "free",
    labelTr: "Ücretsiz",
    perMinute: API_TIER_LIMITS.free.perMinute,
    perDay: API_TIER_LIMITS.free.perDay,
    priceTr: null,
    howTr: "E-postayla başvurun; anahtar elle verilir.",
  },
  {
    tier: "partner",
    labelTr: "Ortak",
    perMinute: API_TIER_LIMITS.partner.perMinute,
    perDay: API_TIER_LIMITS.partner.perDay,
    priceTr: null,
    howTr: "Yüksek hacim ve toplu erişim için yazın.",
  },
];

// Pinned against the identical literals in
// src/app/api/v1/clusters/route.ts (CANDIDATE_MULTIPLIER / CANDIDATE_CAP)
// by tests/api/v1-openapi-contract.test.ts, which reads that route's
// source with readFileSync — the route is NOT edited by this pack, so
// these constants must be hand-kept equal to it, not imported from it.
export const V1_CANDIDATE_MULTIPLIER = 3;
export const V1_CANDIDATE_CAP = 300;
