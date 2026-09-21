import { createServerClient } from "@/lib/supabase/server";

// Pack "Sinyaller" (migration 065) — the /admin "Kaynak sapması" + "Uyarılar"
// sections' reader and vocabulary. Mirrors src/lib/admin/jev-shadow-status.ts's
// and src/lib/admin/jev-gold.ts's rationale: /admin is cookie-gated and
// dynamic, so this is a plain async fetcher, NOT "use cache". Never throws:
// a missing migration, a Supabase hiccup, or a bad row shape all render as a
// status sentence on the page, never a 500. `null` means "could not read".

// Pinned against migration 065's jev_alerts.kind CHECK list by the SIG-A1
// cross-worker guard in tests/migrations/jev-signals-parity.test.ts (W1) —
// keep this a single-line array literal so the regex finds it.
export const JEV_ALERT_KINDS = ["source_drift", "kap_class_canary"] as const;
export type JevAlertKind = (typeof JEV_ALERT_KINDS)[number];

export const SOURCE_DRIFT_DAYS = 7;
export const JEV_ALERT_LIMIT = 20;

export interface SourceDriftRow {
  source_id: string;
  source_slug: string;
  source_name: string;
  day: string;
  n: number;
  politics_share: number | null;
  baseline_politics_share: number | null;
  drift_score: number | null;
}

export interface JevAlertRow {
  id: number;
  kind: string;
  day: string;
  subject: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface JevSignalsStatus {
  drift: SourceDriftRow[];
  alerts: JevAlertRow[];
  /**
   * The exact unacknowledged-alert count from PostgREST (`{ count: "exact" }`),
   * not `alerts.length` -- `alerts` is capped at JEV_ALERT_LIMIT, so on a day
   * a cohort of sources flags at once the page must still say how many are
   * actually queued, not how many happen to fit on the page.
   */
  alertsTotal: number;
}

interface RawSourceEmbed {
  slug?: string | null;
  name?: string | null;
}

interface RawBaseline {
  politics_share?: number | string | null;
}

interface RawSourceDriftRow {
  source_id?: string | null;
  day?: string | null;
  n?: number | string | null;
  politics_share?: number | string | null;
  drift_score?: number | string | null;
  baseline?: RawBaseline | null;
  source?: RawSourceEmbed | RawSourceEmbed[] | null;
}

interface RawJevAlertRow {
  id?: number | string | null;
  kind?: string | null;
  day?: string | null;
  subject?: string | null;
  payload?: Record<string, unknown> | null;
  created_at?: string | null;
}

// PostgREST may send numerics as strings -- coerce every one, the same
// discipline as jev-shadow-status.ts's toAgreementRows/toQueueRows and
// jev-gold.ts's toNum/toRate. A non-number reaching a `.toFixed()` render
// call site would throw OUTSIDE this module's try/catch and 500 the whole
// cookie-gated /admin page -- the exact hazard toQueueRows's docblock names.
function toNullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The source:sources(slug, name) embed may come back as a plain object, a
// one-element array, or null -- the same shape PostgREST sends for
// mapArticle's `source` embed in supabase/functions/_shared/archive.ts.
function flattenSourceEmbed(
  source: RawSourceEmbed | RawSourceEmbed[] | null | undefined,
): RawSourceEmbed | null {
  if (Array.isArray(source)) return source[0] ?? null;
  return source ?? null;
}

export function toSourceDriftRows(data: unknown): SourceDriftRow[] {
  const rows = Array.isArray(data) ? (data as RawSourceDriftRow[]) : [];
  return rows.map((row) => {
    const src = flattenSourceEmbed(row.source);
    const n = Number(row.n);
    return {
      source_id: String(row.source_id ?? ""),
      // A row whose source embed is missing keeps source_slug/source_name
      // as the empty string -- never drop the row.
      source_slug: src?.slug ? String(src.slug) : "",
      source_name: src?.name ? String(src.name) : "",
      day: String(row.day ?? ""),
      n: Number.isFinite(n) ? n : 0,
      politics_share: toNullableNum(row.politics_share),
      baseline_politics_share: toNullableNum(row.baseline?.politics_share),
      drift_score: toNullableNum(row.drift_score),
    };
  });
}

export function toAlertRows(data: unknown): JevAlertRow[] {
  const rows = Array.isArray(data) ? (data as RawJevAlertRow[]) : [];
  return rows.map((row) => ({
    id: Number(row.id),
    kind: String(row.kind ?? ""),
    day: String(row.day ?? ""),
    subject: String(row.subject ?? ""),
    payload: row.payload && typeof row.payload === "object" ? row.payload : {},
    created_at: String(row.created_at ?? ""),
  }));
}

export async function getJevSignalsStatus(): Promise<JevSignalsStatus | null> {
  try {
    const supabase = createServerClient();
    // The day bound for the drift table's `day` column, UTC, YYYY-MM-DD.
    const since = new Date(Date.now() - SOURCE_DRIFT_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const [driftRes, alertsRes] = await Promise.all([
      supabase
        .from("source_drift_daily")
        .select("source_id, day, n, politics_share, drift_score, baseline, source:sources(slug, name)")
        .eq("flagged", true)
        .gte("day", since)
        .order("day", { ascending: false })
        .limit(50),
      supabase
        .from("jev_alerts")
        .select("id, kind, day, subject, payload, created_at", { count: "exact" })
        .is("acknowledged_at", null)
        .order("created_at", { ascending: false })
        .limit(JEV_ALERT_LIMIT),
    ]);

    for (const res of [driftRes, alertsRes]) {
      if (res.error) {
        console.error(`[admin] jev signals unavailable: ${res.error.message}`);
        return null;
      }
    }

    const alerts = toAlertRows(alertsRes.data);
    return {
      drift: toSourceDriftRows(driftRes.data),
      alerts,
      alertsTotal: alertsRes.count ?? alerts.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev signals unavailable: ${message}`);
    return null;
  }
}
