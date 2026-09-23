import type { JevBlindspotSuspectView } from "@/lib/admin/jev-cluster";
import { AdminSection, EmptyState, FieldLabel, StatusBadge } from "@/components/admin/admin-ui";
import { fmtDateTime, fmtPct, fmtRelative } from "@/lib/admin/format";

// Pack A ("Jev canlı küme", migration 064) — the /admin "Şüpheli kör
// noktalar" section: clusters the 'blindspot_recall' shadow stage thinks
// are more likely a clustering miss than an editorial silence (the
// SILENT media zone appears to have published the same event after all).
// Read-only — no actions, no writer lives here; /blindspots itself is
// untouched by this pack, see shared_contract.
//
// Plain SYNCHRONOUS server component (no "use cache", no fetch):
// `suspects`/`now` are read once in page.tsx and passed in as props.
// null degrades to the Turkish read-failure sentence, [] to the empty
// sentence — this component itself can never throw.

export function JevBlindspotSection({
  suspects,
  now,
}: {
  suspects: JevBlindspotSuspectView[] | null;
  now: number;
}) {
  return (
    <AdminSection
      id="kor-nokta"
      title="Şüpheli kör noktalar"
      help="Kör nokta: bir olayı yalnızca bir tarafın medyasının yazdığı küme. Jev burada susan tarafın da aynı olayı yazdığını buldu; yani bu kör nokta aslında bir eşleştirme hatası olabilir. Son 7 gün."
      action="Bulunan haberin gerçekten aynı olay olup olmadığına bakın."
      collapsible
    >
      {suspects === null ? (
        <EmptyState kind="error">Şüpheli kör noktalar okunamadı.</EmptyState>
      ) : suspects.length === 0 ? (
        <EmptyState>Şüpheli kör nokta yok.</EmptyState>
      ) : (
        <ul className="divide-y divide-border/60">
          {suspects.map((row) => (
            <li key={row.clusterId} className="min-w-0 space-y-2 py-3 break-words">
              <div>
                <FieldLabel>Kör nokta kümesi</FieldLabel>
                <p className="text-sm text-muted-foreground">{row.clusterTitle}</p>
              </div>
              <div>
                <FieldLabel>Susan taraftan bulunan haber</FieldLabel>
                <p className="text-base font-medium text-foreground">
                  {row.topArticleTitle ?? "—"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StatusBadge tone="muted">{row.topSourceSlug ?? "—"}</StatusBadge>
                <span className="text-foreground">
                  Aynı olay olasılığı: {row.topProb !== null ? fmtPct(row.topProb) : "—"}
                </span>
                <span className="text-muted-foreground">
                  Kontrol:{" "}
                  {row.checkedAt ? (
                    <span title={fmtDateTime(row.checkedAt)}>{fmtRelative(row.checkedAt, now)}</span>
                  ) : (
                    "—"
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </AdminSection>
  );
}
