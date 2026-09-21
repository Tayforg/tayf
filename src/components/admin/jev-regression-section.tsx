import { getJevRegressionStatus } from "@/lib/admin/jev-regression";
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
// Plain async SERVER component, no cache directive — /admin is
// cookie-gated and dynamic, same rationale as every other section on
// this page.
// getJevRegressionStatus never throws, so this section can never 500 the
// page: null degrades to the Turkish read-failure sentence, an empty
// runs array to the empty-runs sentence.

const STATUS_LABELS: Record<string, string> = {
  running: "çalışıyor",
  ok: "tamam",
  partial: "kısmi",
  error: "hata",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `%${Math.round(rate * 100)}`;
}

function formatInt(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("tr-TR");
}

export async function JevRegressionSection() {
  const status = await getJevRegressionStatus();

  return (
    <section className="space-y-2">
      <h2 className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">
        Metodoloji regresyonu
      </h2>
      <p className="font-mono text-[12px] text-muted-foreground">
        Aynı soru seti ile tekrar: kayma = model veya soru değişti
      </p>
      {status === null ? (
        <p className="font-mono text-[12px] text-muted-foreground">Metodoloji regresyonu okunamadı.</p>
      ) : (
        <>
          <p className="font-mono text-[12px] text-muted-foreground">
            {`Donmuş set: ${status.counts.articles.toLocaleString("tr-TR")} haber · ${status.counts.pairs.toLocaleString("tr-TR")} eşleşme · ${status.counts.inGold.toLocaleString("tr-TR")} altın`}
          </p>
          <JevRegressionActions />
          {status.runs.length === 0 ? (
            <p className="font-mono text-[12px] text-muted-foreground">Henüz regresyon çalışması yok.</p>
          ) : (
            <table className="w-full font-mono text-[12px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">Soru seti</th>
                  <th className="py-1 pr-3 font-normal">Başlangıç</th>
                  <th className="py-1 pr-3 font-normal">Durum</th>
                  <th className="py-1 pr-3 font-normal">Öğe</th>
                  <th className="py-1 pr-3 font-normal">Çağrı</th>
                  <th className="py-1 pr-3 font-normal">Kayma</th>
                  <th className="py-1 pr-3 font-normal">Siyaset</th>
                  <th className="py-1 pr-3 font-normal">Konu</th>
                  <th className="py-1 pr-3 font-normal">Eşleşme</th>
                  <th className="py-1 font-normal">Altın (0.7)</th>
                </tr>
              </thead>
              <tbody>
                {status.runs.map((run) => (
                  <tr key={run.id} className="border-t border-border">
                    <td className="py-1 pr-3 text-foreground">{run.questionSet}</td>
                    <td className="py-1 pr-3 text-foreground">
                      {new Date(run.startedAt).toLocaleString("tr-TR")}
                    </td>
                    <td className="py-1 pr-3 text-foreground">{statusLabel(run.status)}</td>
                    <td className="py-1 pr-3 text-foreground">{run.items.toLocaleString("tr-TR")}</td>
                    <td className="py-1 pr-3 text-foreground">{run.calls.toLocaleString("tr-TR")}</td>
                    <td className="py-1 pr-3 text-foreground">
                      {run.firstRun ? "ilk çalışma" : formatRate(run.flipRate)}
                    </td>
                    <td className="py-1 pr-3 text-foreground">{formatInt(run.flips.politics)}</td>
                    <td className="py-1 pr-3 text-foreground">{formatInt(run.flips.topic)}</td>
                    <td className="py-1 pr-3 text-foreground">{formatInt(run.flips.pair)}</td>
                    <td className="py-1 text-foreground">{formatRate(run.goldPolitics070)}</td>
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
