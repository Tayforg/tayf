import type { JevRegressionStatus } from "@/lib/admin/jev-regression";
import {
  AdminSection,
  DataTable,
  EmptyState,
  KpiTile,
  StatusBadge,
  Td,
  Th,
  Tr,
  toneTextClass,
  type Tone,
} from "@/components/admin/admin-ui";
import { fmtDateTime, fmtInt, fmtPct, fmtRelative } from "@/lib/admin/format";
import { JevRegressionActions } from "@/components/admin/jev-regression-actions";

// Pack B2 "Metodoloji regresyonu" (migration 066) — the /admin section for
// the frozen regression set that jev-shadow (mode: "regression") replays
// weekly against the CURRENT question set, plus the two admin buttons
// that (re-)freeze the set and trigger an on-demand run.
//
// The note below is the honest caveat, not decoration: the same question
// set replayed against a frozen input means a moved answer is the model
// or the question moving, never the news.
//
// Plain SYNCHRONOUS server component (no "use cache", no fetch): `status`
// and `now` are read once in page.tsx and passed in as props. null
// degrades to the Turkish read-failure sentence, an empty runs array to
// the empty-runs sentence — this component itself can never throw.

const STATUS_LABELS: Record<string, string> = {
  running: "çalışıyor",
  ok: "tamam",
  partial: "kısmi",
  error: "hata",
};

const STATUS_TONE: Record<string, Tone> = {
  running: "neutral",
  ok: "ok",
  partial: "warn",
  error: "bad",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? "neutral";
}

/**
 * Flip-rate colouring is intentionally stricter than the shared
 * rateTone() thresholds (which assume "higher is better"): here a HIGHER
 * flip rate is worse, so this local helper flips the comparison and uses
 * its own thresholds (>=0.05 warn, >=0.15 bad).
 */
function flipRateTone(rate: number | null): Tone {
  if (rate === null) return "muted";
  if (rate >= 0.15) return "bad";
  if (rate >= 0.05) return "warn";
  return "ok";
}

export function JevRegressionSection({
  status,
  now,
}: {
  status: JevRegressionStatus | null;
  now: number;
}) {
  return (
    <AdminSection
      id="regresyon"
      title="Metodoloji regresyonu"
      help="Haftada bir, dondurulmuş aynı haber setine aynı sorular yeniden sorulur. Haberler değişmediği için bir cevabın değişmesi (kayma) model ya da soru değişikliği demektir."
      action="Kayma belirgin yükseldiyse son model veya soru değişikliğini gözden geçirin."
      headerRight={<JevRegressionActions />}
    >
      {status === null ? (
        <EmptyState kind="error">Metodoloji regresyonu okunamadı.</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <KpiTile label="Donmuş haber" value={fmtInt(status.counts.articles)} />
            <KpiTile label="Donmuş eşleşme" value={fmtInt(status.counts.pairs)} />
            <KpiTile label="Altın kümede" value={fmtInt(status.counts.inGold)} />
          </div>
          {status.runs.length === 0 ? (
            <EmptyState>Henüz regresyon çalışması yok.</EmptyState>
          ) : (
            <details open className="scroll-mt-28">
              <summary className="cursor-pointer text-sm text-brand">
                Çalışma geçmişi ({fmtInt(status.runs.length)})
              </summary>
              <div className="mt-2">
                <DataTable minWidth="lg">
                  <thead>
                    <Tr>
                      <Th>Soru seti</Th>
                      <Th>Başladı</Th>
                      <Th>Durum</Th>
                      <Th numeric>Öğe</Th>
                      <Th numeric>Çağrı</Th>
                      <Th
                        numeric
                        title="Önceki çalışmaya göre cevabı değişen öğelerin payı"
                      >
                        Kayma
                      </Th>
                      <Th numeric>Değişen: Siyaset</Th>
                      <Th numeric>Değişen: Konu</Th>
                      <Th numeric>Değişen: Eşleşme</Th>
                      <Th
                        numeric
                        title="Jev siyaset cevabının 0,70 eşiğinde altın etiketlerle aynı olma oranı"
                      >
                        Altına uyum (≥0,70)
                      </Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {status.runs.map((run) => (
                      <Tr key={run.id}>
                        <Td>{run.questionSet}</Td>
                        <Td>
                          <span title={fmtDateTime(run.startedAt)}>
                            {fmtRelative(run.startedAt, now)}
                          </span>
                        </Td>
                        <Td>
                          <StatusBadge tone={statusTone(run.status)}>
                            {statusLabel(run.status)}
                          </StatusBadge>
                        </Td>
                        <Td numeric>{fmtInt(run.items)}</Td>
                        <Td numeric>{fmtInt(run.calls)}</Td>
                        <Td numeric>
                          {run.firstRun ? (
                            "ilk çalışma"
                          ) : (
                            <span className={toneTextClass(flipRateTone(run.flipRate))}>
                              {fmtPct(run.flipRate)}
                            </span>
                          )}
                        </Td>
                        <Td numeric>{fmtInt(run.flips.politics)}</Td>
                        <Td numeric>{fmtInt(run.flips.topic)}</Td>
                        <Td numeric>{fmtInt(run.flips.pair)}</Td>
                        <Td numeric>{fmtPct(run.goldPolitics070)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </DataTable>
              </div>
            </details>
          )}
        </>
      )}
    </AdminSection>
  );
}
