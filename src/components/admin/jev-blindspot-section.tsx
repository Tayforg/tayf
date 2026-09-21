import { getJevBlindspotSuspects } from "@/lib/admin/jev-cluster";

// Pack A ("Jev canlı küme", migration 064) — the /admin "Şüpheli kör
// noktalar" section: clusters the 'blindspot_recall' shadow stage thinks
// are more likely a clustering miss than an editorial silence (the
// SILENT media zone appears to have published the same event after all).
// Read-only — no actions, no writer lives here; /blindspots itself is
// untouched by this pack, see shared_contract.
//
// Plain async SERVER component, no "use cache" — /admin is cookie-gated
// and dynamic, same rationale as every other section on this page.
// getJevBlindspotSuspects never throws, so this section can never 500 the
// page: null degrades to the Turkish read-failure sentence, [] to the
// empty sentence.

export async function JevBlindspotSection() {
  const suspects = await getJevBlindspotSuspects();

  return (
    <section className="space-y-2">
      <h2 className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">
        Şüpheli kör noktalar
      </h2>
      <p className="font-mono text-[12px] text-muted-foreground">
        Son 7 gün: Jev, kör nokta sayılan kümede susan tarafın aynı olayı yazdığını söylüyor.
      </p>
      {suspects === null ? (
        <p className="font-mono text-[12px] text-muted-foreground">Şüpheli kör noktalar okunamadı.</p>
      ) : suspects.length === 0 ? (
        <p className="font-mono text-[12px] text-muted-foreground">Şüpheli kör nokta yok.</p>
      ) : (
        <table className="w-full font-mono text-[12px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-normal">Küme</th>
              <th className="py-1 pr-3 font-normal">Bulunan haber</th>
              <th className="py-1 pr-3 font-normal">Kaynak</th>
              <th className="py-1 pr-3 font-normal">Jev olasılığı</th>
              <th className="py-1 font-normal">Kontrol</th>
            </tr>
          </thead>
          <tbody>
            {suspects.map((row) => (
              <tr key={row.clusterId} className="border-t border-border">
                <td className="py-1 pr-3 text-foreground">{row.clusterTitle}</td>
                <td className="py-1 pr-3 text-foreground">{row.topArticleTitle ?? "—"}</td>
                <td className="py-1 pr-3 text-muted-foreground">{row.topSourceSlug ?? "—"}</td>
                <td className="py-1 pr-3 text-foreground">
                  {row.topProb !== null ? row.topProb.toFixed(2) : "—"}
                </td>
                <td className="py-1 text-muted-foreground">
                  {row.checkedAt ? new Date(row.checkedAt).toLocaleString("tr-TR") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
