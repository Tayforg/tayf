import {
  getJevShadowStatus,
  type JevAgreementRow,
  type JevRunRow,
} from "@/lib/admin/jev-shadow-status";
import { JevReviewActions } from "@/components/admin/jev-shadow-review-actions";

// Pack JEV (migration 061) — the /admin "Jev gölge" section. Gölge mod:
// nothing this reads is reader-facing (jev_shadow_* tables are
// service_role-only), and this section only ever measures agreement with
// an unvalidated baseline — never call an agreement rate an accuracy
// figure (see pack.md's "AGREEMENT IS NOT ACCURACY").
//
// Plain async SERVER component, no "use cache" — /admin is cookie-gated
// and dynamic, same rationale as the Arşiv section on this page.

// Duplicates the order of JEV_TASKS in supabase/functions/_shared/jev.ts.
// That module is Deno-adjacent (imported by the jev-shadow Edge Function)
// and must never be pulled into the Next.js bundle, so the order and the
// Turkish labels are re-declared here rather than imported.
const JEV_TASK_ORDER = [
  "politics",
  "topic",
  "opinion",
  "clickbait",
  "framing",
  "sensational",
  "cluster_member",
  "pair_negative",
  "kap_class",
  "kap_materiality",
  "title_meaning",
  "title_edit_kind",
] as const;

const JEV_TASK_LABELS_TR: Record<string, string> = {
  politics: "Siyaset mi?",
  topic: "Konu",
  opinion: "Köşe yazısı mı?",
  clickbait: "Tık tuzağı",
  framing: "Çerçeveleme",
  sensational: "Sansasyon",
  cluster_member: "Küme üyeliği",
  pair_negative: "Yanlış eşleşme",
  kap_class: "KAP sınıfı",
  kap_materiality: "KAP önemlilik",
  title_meaning: "Başlık anlamı",
  title_edit_kind: "Başlık düzenleme türü",
};

const JEV_RUN_STATUS_LABELS_TR: Record<string, string> = {
  running: "çalışıyor",
  ok: "tamam",
  partial: "kısmi",
  rate_limited: "hız sınırı",
  budget_exceeded: "bütçe doldu",
  error: "hata",
};

function taskLabel(task: string): string {
  return JEV_TASK_LABELS_TR[task] ?? task;
}

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `%${Math.round(rate * 100)}`;
}

interface AgreementByTask {
  task: string;
  rate24h: number | null;
  rate7d: number | null;
  total: number;
  undecided: number;
}

/**
 * One row per task present in either window, union-ordered by JEV_TASK_ORDER.
 * `total`/`undecided` read the 7-day row when present: it is the wider
 * window over the same predictions table, so it is the more complete
 * "how many were compared / uncomparable" count for the task, falling back
 * to the 24h row for a task that has only just started producing rows.
 */
function buildAgreementRows(
  agreement24h: JevAgreementRow[],
  agreement7d: JevAgreementRow[],
): AgreementByTask[] {
  const map24 = new Map(agreement24h.map((row) => [row.task, row]));
  const map7 = new Map(agreement7d.map((row) => [row.task, row]));
  const tasks = new Set<string>([...map24.keys(), ...map7.keys()]);

  const ordered: string[] = JEV_TASK_ORDER.filter((task) => tasks.has(task));
  for (const task of tasks) {
    if (!ordered.includes(task)) ordered.push(task);
  }

  return ordered.map((task) => {
    const row24 = map24.get(task);
    const row7 = map7.get(task);
    return {
      task,
      rate24h: row24?.rate ?? null,
      rate7d: row7?.rate ?? null,
      total: row7?.total ?? row24?.total ?? 0,
      undecided: row7?.undecided ?? row24?.undecided ?? 0,
    };
  });
}

function monthLine(status: {
  runs: number;
  calls: number;
  inputTokens: number;
  usd: number;
  cap: number;
  pct: number;
}): string {
  return (
    `Bu ay: ${status.runs.toLocaleString("tr-TR")} çalışma · ` +
    `${status.calls.toLocaleString("tr-TR")} çağrı · ` +
    `${status.inputTokens.toLocaleString("tr-TR")} jeton · ` +
    `≈${status.usd.toFixed(2)} $ · ` +
    `sınır ${status.cap.toLocaleString("tr-TR")} jeton (%${status.pct})`
  );
}

function lastRunLine(lastRun: JevRunRow | null): string {
  if (lastRun === null) return "Henüz çalışma yok";
  const statusLabel = JEV_RUN_STATUS_LABELS_TR[lastRun.status] ?? lastRun.status;
  return (
    `Son çalışma: ${new Date(lastRun.started_at).toLocaleString("tr-TR")} · ` +
    `${statusLabel} · ${lastRun.calls.toLocaleString("tr-TR")} çağrı · ` +
    `${lastRun.errors.toLocaleString("tr-TR")} hata`
  );
}

export async function JevShadowSection() {
  const status = await getJevShadowStatus();

  return (
    <section className="space-y-2">
      <h2 className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">
        Jev gölge
      </h2>
      <p className="font-mono text-[12px] text-muted-foreground">
        Gölge mod: hiçbir Jev çıktısı okuyucuya gösterilmez, yalnızca ölçüm için saklanır.
      </p>
      {status === null ? (
        <p className="font-mono text-[12px] text-muted-foreground">Jev gölge durumu okunamadı.</p>
      ) : (
        <>
          <p className="font-mono text-[12px] text-foreground">
            {monthLine(status.month)}
            {status.month.exceeded && (
              <span className="text-destructive"> — bütçe doldu, çağrılar durduruldu.</span>
            )}
          </p>
          <p className="font-mono text-[12px] text-muted-foreground">
            {lastRunLine(status.lastRun)}
          </p>
          {(() => {
            const agreementRows = buildAgreementRows(status.agreement24h, status.agreement7d);
            return agreementRows.length === 0 ? (
              <p className="font-mono text-[12px] text-muted-foreground">Henüz gölge tahmin yok.</p>
            ) : (
              <table className="w-full font-mono text-[12px]">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-normal">Görev</th>
                    <th className="py-1 pr-3 font-normal">Uyum 24s</th>
                    <th className="py-1 pr-3 font-normal">Uyum 7g</th>
                    <th className="py-1 pr-3 font-normal">Karşılaştırılan</th>
                    <th className="py-1 font-normal">Ölçülemeyen</th>
                  </tr>
                </thead>
                <tbody>
                  {agreementRows.map((row) => (
                    <tr key={row.task} className="border-t border-border">
                      <td className="py-1 pr-3 text-foreground">{taskLabel(row.task)}</td>
                      <td className="py-1 pr-3 text-foreground">{formatRate(row.rate24h)}</td>
                      <td className="py-1 pr-3 text-foreground">{formatRate(row.rate7d)}</td>
                      <td className="py-1 pr-3 text-foreground">
                        {row.total.toLocaleString("tr-TR")}
                      </td>
                      <td className="py-1 text-foreground">
                        {row.undecided.toLocaleString("tr-TR")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
          <h3 className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">
            Anlaşmazlık kuyruğu ({status.queue.length})
          </h3>
          {status.queue.length === 0 ? (
            <p className="font-mono text-[12px] text-muted-foreground">İncelenecek anlaşmazlık yok.</p>
          ) : (
            <ul className="space-y-3">
              {status.queue.map((row) => (
                <li key={row.id} className="border-t border-border pt-2">
                  <p className="font-mono text-[12px] text-muted-foreground">
                    {taskLabel(row.task)} · {new Date(row.created_at).toLocaleString("tr-TR")}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-foreground">{row.state_preview}</p>
                  <p className="font-mono text-[12px] text-muted-foreground">
                    Sistem: {row.baseline_answer} · Jev:{" "}
                    {row.jev_choice ?? (row.jev_prob != null ? row.jev_prob.toFixed(2) : "—")}
                  </p>
                  <JevReviewActions id={row.id} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
