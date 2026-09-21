import { createServerClient } from "@/lib/supabase/server";

// Pack "Sinyaller" (migration 065) — the /admin/ekonomi "KAP önemlilik"
// panel's reader. Mirrors src/lib/admin/jev-gold.ts's and
// src/lib/admin/jev-shadow-status.ts's rationale: /admin is cookie-gated
// and dynamic, so this is a plain async fetcher, NOT "use cache". Never
// throws: a missing migration, a Supabase hiccup, or a bad row shape all
// render as a status sentence on the page, never a 500. `null` means
// "could not read".

export const KAP_SIGNALS_LIMIT = 30;

export type KapMaterialityLevel = "düşük" | "orta" | "yüksek";

const KAP_MATERIALITY_LEVELS: ReadonlySet<string> = new Set(["düşük", "orta", "yüksek"]);

export interface KapDisclosureSignal {
  disclosure_index: number;
  kap_title: string;
  subject: string | null;
  disclosure_class: string | null;
  published_at: string;
  materiality: number | null;
  materiality_level: KapMaterialityLevel | null;
  class_agree: boolean | null;
  question_set: string | null;
}

export interface KapCanaryStatus {
  day: string;
  n: number;
  disagreements: number;
  rate: number | null;
  overThreshold: boolean;
}

export interface KapSignals {
  disclosures: KapDisclosureSignal[];
  canary: KapCanaryStatus | null;
}

interface RawDisclosureRow {
  disclosure_index?: number | string | null;
  kap_title?: string | null;
  subject?: string | null;
  disclosure_class?: string | null;
  published_at?: string | null;
}

interface RawSignalRow {
  disclosure_index?: number | string | null;
  materiality?: number | string | null;
  materiality_level?: string | null;
  class_agree?: boolean | null;
  question_set?: string | null;
}

interface RawCanaryRow {
  kap_n?: number | string | null;
  disagreements?: number | string | null;
  disagreement_rate?: number | string | null;
  over_threshold?: boolean | null;
}

// PostgREST may send numerics as strings -- coerce every one, the same
// discipline as jev-shadow-status.ts's toAgreementRows/toQueueRows and
// jev-gold.ts's toNum/toRate. A non-number reaching a `.toFixed()` /
// `.toLocaleString()` render call site would throw OUTSIDE this module's
// try/catch and 500 the whole cookie-gated /admin/ekonomi page.
function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toNullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Narrow to the three known DB-declared levels -- never render a raw DB
// string we did not expect.
function toMaterialityLevel(v: unknown): KapMaterialityLevel | null {
  return typeof v === "string" && KAP_MATERIALITY_LEVELS.has(v) ? (v as KapMaterialityLevel) : null;
}

/**
 * Pure left-join: preserves `disclosures` ordering (published_at desc, as
 * queried) and attaches the matching `kap_disclosure_signals_for` row by
 * numeric disclosure_index. A disclosure with no matching prediction row
 * (not yet scored by jev-shadow, or filtered by the RPC's 200-element
 * clamp) yields null materiality/level/class_agree/question_set rather
 * than being dropped.
 */
export function toKapSignalRows(disclosures: unknown, signals: unknown): KapDisclosureSignal[] {
  const disclosureRows = Array.isArray(disclosures) ? (disclosures as RawDisclosureRow[]) : [];
  const signalRows = Array.isArray(signals) ? (signals as RawSignalRow[]) : [];

  const byIndex = new Map<number, RawSignalRow>();
  for (const row of signalRows) {
    const idx = toNullableNum(row.disclosure_index);
    if (idx !== null) byIndex.set(idx, row);
  }

  return disclosureRows.map((row) => {
    const idx = toNum(row.disclosure_index);
    const signal = byIndex.get(idx);
    return {
      disclosure_index: idx,
      kap_title: String(row.kap_title ?? ""),
      subject: row.subject === null || row.subject === undefined ? null : String(row.subject),
      disclosure_class:
        row.disclosure_class === null || row.disclosure_class === undefined ? null : String(row.disclosure_class),
      published_at: String(row.published_at ?? ""),
      materiality: signal ? toNullableNum(signal.materiality) : null,
      materiality_level: signal ? toMaterialityLevel(signal.materiality_level) : null,
      class_agree: signal && typeof signal.class_agree === "boolean" ? signal.class_agree : null,
      question_set: signal && signal.question_set != null ? String(signal.question_set) : null,
    };
  });
}

export async function getKapSignals(limit: number = KAP_SIGNALS_LIMIT): Promise<KapSignals | null> {
  try {
    const supabase = createServerClient();

    const disclosuresRes = await supabase
      .from("kap_disclosures")
      .select("disclosure_index, kap_title, subject, disclosure_class, published_at")
      .order("published_at", { ascending: false })
      .limit(limit);

    if (disclosuresRes.error) {
      console.error(`[admin] kap signals unavailable: ${disclosuresRes.error.message}`);
      return null;
    }

    const disclosureRows = Array.isArray(disclosuresRes.data) ? (disclosuresRes.data as RawDisclosureRow[]) : [];
    const indexes = disclosureRows
      .map((row) => Number(row.disclosure_index))
      .filter((n) => Number.isFinite(n));

    // An empty disclosure list skips the signals RPC's disclosure join
    // (nothing to look up), but jev_kap_canary_status still runs -- the
    // canary measures the whole day's KAP feed, not this page's disclosure
    // window.
    const [signalsRes, canaryRes] = await Promise.all([
      indexes.length > 0
        ? supabase.rpc("kap_disclosure_signals_for", { p_indexes: indexes })
        : Promise.resolve({ data: [], error: null }),
      supabase.rpc("jev_kap_canary_status"),
    ]);

    if (signalsRes.error) {
      console.error(`[admin] kap signals unavailable: ${signalsRes.error.message}`);
      return null;
    }
    if (canaryRes.error) {
      console.error(`[admin] kap signals unavailable: ${canaryRes.error.message}`);
      return null;
    }

    const canaryRows = Array.isArray(canaryRes.data)
      ? (canaryRes.data as RawCanaryRow[])
      : canaryRes.data
        ? [canaryRes.data as RawCanaryRow]
        : [];
    const canaryRow = canaryRows[0];

    // The SQL default (yesterday, UTC) is the single source of truth for
    // WHICH day jev_kap_canary_status measured -- this is only a display
    // label computed client-side, not authoritative.
    const canary: KapCanaryStatus | null = canaryRow
      ? {
          day: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
          n: toNum(canaryRow.kap_n),
          disagreements: toNum(canaryRow.disagreements),
          rate: toNullableNum(canaryRow.disagreement_rate),
          overThreshold: Boolean(canaryRow.over_threshold),
        }
      : null;

    return {
      disclosures: toKapSignalRows(disclosureRows, signalsRes.data),
      canary,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] kap signals unavailable: ${message}`);
    return null;
  }
}
