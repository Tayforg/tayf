import { getJevSignalsStatus, type JevAlertRow } from "@/lib/admin/jev-signals";
import { JevAlertActions } from "@/components/admin/jev-alert-actions";

// Pack "Sinyaller" (migration 065) — the /admin "Kaynak sapması" + "Uyarılar"
// sections. Nothing this reads is reader-facing (source_drift_daily and
// jev_alerts are service_role-only), and drift is measured against a
// 14-day per-source baseline, not "correctness" -- see pack.md's
// "AGREEMENT IS NOT ACCURACY" and "DRIFT NEEDS 14 DAYS OF HISTORY".
//
// Plain async SERVER component, no "use cache" — /admin is cookie-gated
// and dynamic, same rationale as the Jev gölge section on this page.

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

export async function JevSignalsSection() {
  const status = await getJevSignalsStatus();

  return (
    <section className="space-y-2">
      <h2 className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">
        Kaynak sapması
      </h2>
      <p className="font-mono text-[12px] text-muted-foreground">
        Son 7 gün: günlük etiket dağılımı 14 günlük tabanından sapan kaynaklar. Ölçüm gölge tahminlerden türetilir,
        okuyucuya hiçbir şey gösterilmez.
      </p>
      {status === null ? (
        <p className="font-mono text-[12px] text-muted-foreground">Kaynak sapması okunamadı.</p>
      ) : status.drift.length === 0 ? (
        <p className="font-mono text-[12px] text-muted-foreground">Son 7 günde işaretlenen kaynak yok.</p>
      ) : (
        <table className="w-full font-mono text-[12px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-normal">Kaynak</th>
              <th className="py-1 pr-3 font-normal">Gün</th>
              <th className="py-1 pr-3 font-normal">Sapma</th>
              <th className="py-1 pr-3 font-normal">Siyaset payı</th>
              <th className="py-1 pr-3 font-normal">Taban</th>
              <th className="py-1 font-normal">n</th>
            </tr>
          </thead>
          <tbody>
            {status.drift.map((row) => (
              <tr key={`${row.source_id}-${row.day}`} className="border-t border-border">
                <td className="py-1 pr-3 text-foreground">{row.source_name || row.source_slug || "—"}</td>
                <td className="py-1 pr-3 text-foreground">{row.day}</td>
                <td className="py-1 pr-3 text-foreground">{fmtScore(row.drift_score)}</td>
                <td className="py-1 pr-3 text-foreground">{fmtShare(row.politics_share)}</td>
                <td className="py-1 pr-3 text-foreground">{fmtShare(row.baseline_politics_share)}</td>
                <td className="py-1 text-foreground">{row.n.toLocaleString("tr-TR")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">
        Uyarılar{status === null ? " (—)" : ` (${status.alertsTotal})`}
      </h2>
      {status === null ? (
        <p className="font-mono text-[12px] text-muted-foreground">Uyarılar okunamadı.</p>
      ) : status.alerts.length === 0 ? (
        <p className="font-mono text-[12px] text-muted-foreground">Onay bekleyen uyarı yok.</p>
      ) : (
        <ul className="space-y-3">
          {status.alerts.map((row) => (
            <li key={row.id} className="border-t border-border pt-2">
              <p className="font-mono text-[12px] text-muted-foreground">
                {kindLabel(row.kind)} · {new Date(row.created_at).toLocaleString("tr-TR")}
              </p>
              <p className="text-foreground">{alertSummary(row)}</p>
              <JevAlertActions id={row.id} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
