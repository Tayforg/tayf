import {
  formatGoldShare,
  getFramingVoteStatus,
} from "@/lib/admin/framing-votes";

// T11 (migration 068) — the /admin "Çerçeve oyları" section: plain async
// SERVER component, no "use cache" (same rationale as the Arşiv / Jev gölge
// sections on this page — /admin is cookie-gated and dynamic).

// Deliberate local duplicate of FRAMING_VOTE_LABELS_TR (src/lib/game/framing.ts,
// owned by a different worker) — same precedent as JEV_TASK_ORDER in
// jev-shadow-section.tsx: this component must never import across worker
// file sets, so the Turkish labels are re-declared here rather than shared.
const FRAMING_VOTE_LABELS_TR: Record<string, string> = {
  iktidar: "İktidar lehine",
  muhalefet: "Muhalefet lehine",
  none: "Tarafsız",
};

function voteLabel(vote: string): string {
  return FRAMING_VOTE_LABELS_TR[vote] ?? vote;
}

export async function FramingVotesSection() {
  const status = await getFramingVoteStatus();

  return (
    <section className="space-y-2">
      <h2 className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">
        Çerçeve oyları
      </h2>
      {status === null ? (
        <p className="font-mono text-[12px] text-muted-foreground">
          Çerçeve oyu durumu okunamadı.
        </p>
      ) : (
        <>
          <p className="font-mono text-[12px] text-foreground">
            {status.totalVotes === null
              ? "Oy sayısı okunamadı."
              : `Toplam oy: ${status.totalVotes.toLocaleString("tr-TR")}`}
          </p>
          {status.candidates.length === 0 ? (
            <p className="font-mono text-[12px] text-muted-foreground">
              Henüz altın etiket adayı yok.
            </p>
          ) : (
            <table className="w-full font-mono text-[12px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">Başlık</th>
                  <th className="py-1 pr-3 font-normal">Çoğunluk</th>
                  <th className="py-1 pr-3 font-normal">Oy</th>
                  <th className="py-1 font-normal">Pay</th>
                </tr>
              </thead>
              <tbody>
                {status.candidates.map((row) => (
                  <tr key={row.article_id} className="border-t border-border">
                    <td className="py-1 pr-3 max-w-[28rem] truncate text-foreground">
                      {row.title}
                    </td>
                    <td className="py-1 pr-3 text-foreground">
                      {voteLabel(row.vote)}
                    </td>
                    <td className="py-1 pr-3 text-foreground">
                      {row.n.toLocaleString("tr-TR")}
                    </td>
                    <td className="py-1 text-foreground">
                      {formatGoldShare(row.share)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
