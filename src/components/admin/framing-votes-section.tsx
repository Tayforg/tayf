import {
  AdminSection,
  DataTable,
  EmptyState,
  KpiTile,
  StatusBadge,
  Td,
  Th,
  Tr,
  type Tone,
} from "@/components/admin/admin-ui";
import {
  FRAMING_GOLD_MIN_SHARE,
  FRAMING_GOLD_MIN_VOTES,
  formatGoldShare,
  type FramingVoteAdminStatus,
} from "@/lib/admin/framing-votes";

// T11 (migration 068) — the /admin "Çerçeve oyları" section
// (group #sinyaller). Non-async SERVER component: /admin's page.tsx now
// reads getFramingVoteStatus() once (the shared Promise.all) and passes
// the result down as a prop, so this file no longer fetches on its own.
// No "use cache" here — there is nothing left to cache, the data arrives
// as a prop.

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

// The majority tone only tells iktidar/muhalefet/none apart — it is not
// an ok/bad judgement of the vote itself, hence the explicit title on the
// badge below. Exported so this mapping has a pure unit test instead of a
// render test (AGENTS.md: no render tests of server components — this
// file has no "use client").
export function majorityTone(vote: string): Tone {
  if (vote === "iktidar") return "bad";
  if (vote === "muhalefet") return "ok";
  return "muted";
}

const HELP = `Okuyucular çerçeve oyununda bir başlığın kimin lehine yazıldığını oyluyor. En az ${FRAMING_GOLD_MIN_VOTES} oy alan ve oyların en az %${Math.round(FRAMING_GOLD_MIN_SHARE * 100)}'i aynı cevapta birleşen başlıklar altın etiket adayıdır.`;

export function FramingVotesSection({
  status,
}: {
  status: FramingVoteAdminStatus | null;
}) {
  return (
    <AdminSection id="cerceve" title="Çerçeve oyları" help={HELP} collapsible>
      {status === null ? (
        <EmptyState kind="error">Çerçeve oyu durumu okunamadı.</EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <KpiTile
              label="Toplam oy"
              value={
                status.totalVotes === null
                  ? "—"
                  : status.totalVotes.toLocaleString("tr-TR")
              }
              hint={status.totalVotes === null ? "Oy sayısı okunamadı." : undefined}
              tone={status.totalVotes === null ? "muted" : "neutral"}
            />
          </div>

          {status.candidates.length === 0 ? (
            <EmptyState>Henüz altın etiket adayı yok.</EmptyState>
          ) : (
            <DataTable minWidth="md">
              <thead>
                <Tr>
                  <Th>Başlık</Th>
                  <Th>Çoğunluk</Th>
                  <Th numeric>Oy</Th>
                  <Th numeric>Pay</Th>
                </Tr>
              </thead>
              <tbody>
                {status.candidates.map((row) => (
                  <Tr key={row.article_id}>
                    <Td className="max-w-[28rem] truncate">
                      <span title={row.title}>{row.title}</span>
                    </Td>
                    <Td>
                      <StatusBadge
                        tone={majorityTone(row.vote)}
                        title="Renk yalnızca tarafı ayırt eder, iyi/kötü anlamı taşımaz"
                      >
                        {voteLabel(row.vote)}
                      </StatusBadge>
                    </Td>
                    <Td numeric>{row.n.toLocaleString("tr-TR")}</Td>
                    <Td numeric>{formatGoldShare(row.share)}</Td>
                  </Tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </div>
      )}
    </AdminSection>
  );
}
