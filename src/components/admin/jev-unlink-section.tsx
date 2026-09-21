import { getJevUnlinkCandidates } from "@/lib/admin/jev-cluster";
import { JevUnlinkActions } from "@/components/admin/jev-unlink-actions";

// Pack A ("Jev canlı küme", migration 064) — the /admin "Küme dışı adaylar"
// section: Jev's outlier-ejection queue. Nothing here is unlinked
// automatically; a human presses "Ayır" or "Kalsın" for each row.
//
// Plain async SERVER component, no "use cache" — /admin is cookie-gated
// and dynamic, same rationale as every other section on this page.
// getJevUnlinkCandidates never throws, so this section can never 500 the
// page: null degrades to the Turkish read-failure sentence, [] to the
// empty-queue sentence.

export async function JevUnlinkSection() {
  const candidates = await getJevUnlinkCandidates();

  return (
    <section className="space-y-2">
      <h2 className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">
        Küme dışı adaylar
      </h2>
      <p className="font-mono text-[12px] text-muted-foreground">
        Jev bu haberlerin kümeye ait olmadığını düşünüyor. Karar insanın: hiçbir şey otomatik ayrılmaz.
      </p>
      {candidates === null ? (
        <p className="font-mono text-[12px] text-muted-foreground">Küme dışı adaylar okunamadı.</p>
      ) : candidates.length === 0 ? (
        <p className="font-mono text-[12px] text-muted-foreground">Bekleyen aday yok.</p>
      ) : (
        <table className="w-full font-mono text-[12px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-normal">Küme</th>
              <th className="py-1 pr-3 font-normal">Haber</th>
              <th className="py-1 pr-3 font-normal">Kaynak</th>
              <th className="py-1 pr-3 font-normal">Jev olasılığı</th>
              <th className="py-1 pr-3 font-normal">Eklendi</th>
              <th className="py-1 font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((row) => (
              <tr key={row.id} className="border-t border-border">
                <td className="py-1 pr-3 text-foreground">{row.clusterTitle}</td>
                <td className="py-1 pr-3 text-foreground">{row.articleTitle}</td>
                <td className="py-1 pr-3 text-muted-foreground">{row.sourceSlug ?? "—"}</td>
                <td className="py-1 pr-3 text-foreground">{row.jevProb.toFixed(2)}</td>
                <td className="py-1 pr-3 text-muted-foreground">
                  {new Date(row.createdAt).toLocaleString("tr-TR")}
                </td>
                <td className="py-1">
                  <JevUnlinkActions id={row.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
