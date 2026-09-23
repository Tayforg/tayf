import Link from "next/link";
import type { JevAlertRow, JevSignalsStatus } from "@/lib/admin/jev-signals";
import {
  AdminSection,
  DataTable,
  EmptyState,
  StatusBadge,
  Td,
  Th,
  Tr,
} from "@/components/admin/admin-ui";
import { fmtDateTime, fmtInt, fmtRelative } from "@/lib/admin/format";
import { JevAlertActions } from "@/components/admin/jev-alert-actions";

// Pack "Sinyaller" (migration 065) — the /admin "Kaynak sapması" + "Uyarılar"
// sections. Nothing this reads is reader-facing (source_drift_daily and
// jev_alerts are service_role-only), and drift is measured against a
// 14-day per-source baseline, not "correctness" -- see pack.md's
// "AGREEMENT IS NOT ACCURACY" and "DRIFT NEEDS 14 DAYS OF HISTORY".
//
// Plain SYNCHRONOUS server components (no "use cache", no fetch): `status`
// (and `now` for the alerts section) are read once in page.tsx and passed
// in as props.

const JEV_ALERT_KIND_LABELS_TR: Record<string, string> = {
  source_drift: "Kaynak sapması",
  kap_class_canary: "KAP sınıfı kanaryası",
};

function kindLabel(kind: string): string {
  return JEV_ALERT_KIND_LABELS_TR[kind] ?? kind;
}

function fmtShare(value: number | null): string {
  return value === null ? "—" : `%${Math.round(value * 100)}`;
}

function fmtScore(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

// Plain-text summary only -- payload is never rendered as HTML/markup and
// never JSON.stringify'd into the page.
function alertSummary(row: JevAlertRow): string {
  if (row.kind === "source_drift") {
    const name = row.payload.source_name;
    const slug = row.payload.source_slug;
    const value = (typeof name === "string" && name) || (typeof slug === "string" && slug) || row.subject;
    return String(value);
  }
  return row.subject;
}

function deltaPoints(share: number | null, baseline: number | null): number | null {
  if (share === null || baseline === null) return null;
  return Math.round((share - baseline) * 100);
}

function deltaLabel(points: number | null): string {
  if (points === null) return "—";
  return `${points > 0 ? "+" : ""}${points} puan`;
}

function deltaToneClass(points: number | null): string {
  if (points === null) return "text-muted-foreground";
  const abs = Math.abs(points);
  if (abs >= 20) return "text-destructive";
  if (abs >= 10) return "text-amber-600 dark:text-amber-400";
  return "text-foreground";
}

/**
 * "Uyarılar": alerts the shadow measurements raised on their own (drift or
 * a KAP-class disagreement spike). "Onayla" only dismisses the alert row —
 * see jev-alert-actions.tsx — it never touches an article, source, or
 * cluster.
 */
export function JevAlertsSection({
  status,
  now,
}: {
  status: JevSignalsStatus | null;
  now: number;
}) {
  return (
    <AdminSection
      id="uyarilar"
      title="Uyarılar"
      help="Jev'in ölçümlerinde olağandışı bir şey görüldüğünde açılan uyarılar."
      action="Her birine göz atın. 'Onayla' uyarıyı listeden kaldırır; haberlere veya kaynaklara hiçbir şey yapılmaz."
      count={status?.alertsTotal ?? "—"}
      tone={status !== null && status.alertsTotal > 0 ? "bad" : "neutral"}
    >
      {status === null ? (
        <EmptyState kind="error">Uyarılar okunamadı.</EmptyState>
      ) : status.alerts.length === 0 ? (
        <EmptyState>Onay bekleyen uyarı yok.</EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-border/60">
            {status.alerts.map((row) => (
              <li key={row.id} className="min-w-0 space-y-2 py-3 break-words">
                <p className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge tone="bad">{kindLabel(row.kind)}</StatusBadge>
                  <span
                    className="text-sm text-muted-foreground"
                    title={fmtDateTime(row.created_at)}
                  >
                    {fmtRelative(row.created_at, now)}
                  </span>
                </p>
                <p className="text-base font-medium text-foreground">{alertSummary(row)}</p>
                {row.kind === "source_drift" ? (
                  <p className="text-sm text-muted-foreground">
                    Bu kaynağın siyaset haberi payı, son 14 günlük olağan düzeyinden belirgin
                    biçimde saptı. Ayrıntı:{" "}
                    <a href="#kaynak-sapmasi" className="text-brand hover:underline">
                      Kaynak sapması tablosu
                    </a>
                    .
                  </p>
                ) : row.kind === "kap_class_canary" ? (
                  <p className="text-sm text-muted-foreground">
                    Jev&apos;in KAP bildirim sınıfı tahmini ile KAP&apos;ın kendi sınıfı arasındaki
                    anlaşmazlık bu gün olağandışı yüksek. Ayrıntı:{" "}
                    <Link href="/admin/ekonomi" className="text-brand hover:underline">
                      Ekonomi paneli
                    </Link>
                    .
                  </p>
                ) : null}
                <JevAlertActions id={row.id} />
              </li>
            ))}
          </ul>
          {status.alertsTotal > status.alerts.length && (
            <p className="text-xs text-muted-foreground">
              İlk {fmtInt(status.alerts.length)} uyarı gösteriliyor.
            </p>
          )}
        </>
      )}
    </AdminSection>
  );
}

/**
 * "Kaynak sapması": the last 7 days of per-source, per-day politics-share
 * drift against each source's own 14-day baseline. Read-only — collapsed
 * by default since it is a diagnostic table, not a queue.
 */
export function SourceDriftSection({ status }: { status: JevSignalsStatus | null }) {
  return (
    <AdminSection
      id="kaynak-sapmasi"
      title="Kaynak sapması"
      help="Son 7 gün: bir kaynağın günlük siyaset haberi payı kendi 14 günlük olağan düzeyinden belirgin biçimde ayrıldığında burada görünür. Ölçüm gölge tahminlerden gelir, okuyucuya gösterilmez."
      collapsible
    >
      {status === null ? (
        <EmptyState kind="error">Kaynak sapması okunamadı.</EmptyState>
      ) : status.drift.length === 0 ? (
        <EmptyState>Son 7 günde işaretlenen kaynak yok.</EmptyState>
      ) : (
        <DataTable minWidth="md">
          <thead>
            <Tr>
              <Th>Kaynak</Th>
              <Th>Gün</Th>
              <Th numeric>Siyaset payı</Th>
              <Th numeric title="Olağan düzeyden uzaklık; yüksek = daha olağandışı. Üst sınırı yok.">
                Sapma puanı
              </Th>
              <Th numeric>Haber</Th>
            </Tr>
          </thead>
          <tbody>
            {status.drift.map((row) => {
              const points = deltaPoints(row.politics_share, row.baseline_politics_share);
              return (
                <Tr key={`${row.source_id}-${row.day}`}>
                  <Td>{row.source_name || row.source_slug || "—"}</Td>
                  <Td>{row.day}</Td>
                  <Td numeric>
                    <span className={deltaToneClass(points)}>{fmtShare(row.politics_share)}</span>
                    <br />
                    <span className="text-xs text-muted-foreground">
                      taban {fmtShare(row.baseline_politics_share)} · {deltaLabel(points)}
                    </span>
                  </Td>
                  <Td numeric>{fmtScore(row.drift_score)}</Td>
                  <Td numeric>{fmtInt(row.n)}</Td>
                </Tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </AdminSection>
  );
}
