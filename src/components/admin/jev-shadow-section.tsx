import Link from "next/link";
import type {
  JevAgreementRow,
  JevRunRow,
  JevShadowStatus,
} from "@/lib/admin/jev-shadow-status";
import {
  AdminSection,
  DataTable,
  EmptyState,
  FieldLabel,
  KpiTile,
  Meter,
  StatusBadge,
  Td,
  Th,
  Tr,
  toneTextClass,
  type Tone,
} from "@/components/admin/admin-ui";
import {
  fmtDateTime,
  fmtInt,
  fmtPct,
  fmtRelative,
  fmtUsd,
  parseStatePreview,
  rateTone,
} from "@/lib/admin/format";
import { JevReviewActions } from "@/components/admin/jev-shadow-review-actions";

// Pack JEV (migration 061) — the /admin "Jev gölge" section. Gölge mod:
// nothing this reads is reader-facing (jev_shadow_* tables are
// service_role-only), and this section only ever measures agreement with
// an unvalidated baseline — never call an agreement rate an accuracy
// figure (see pack.md's "AGREEMENT IS NOT ACCURACY").
//
// Plain SYNCHRONOUS server components (no "use cache", no fetch): data is
// read once in page.tsx and passed in as `status`/`now` props. Rendering a
// null/empty status is the caller's read-failure/empty-state path, not
// this component's — see the AdminSection null branches below.

// Duplicates the order of JEV_TASKS in supabase/functions/_shared/jev.ts.
// That module is Deno-adjacent (imported by the jev-shadow Edge Function)
// and must never be pulled into the Next.js bundle, so the order and the
// Turkish labels are re-declared here rather than imported.
const JEV_TASK_ORDER = [
  "politics",
  "topic",
  "topic7",
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
  topic7: "Konu (7)",
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

const JEV_RUN_STATUS_TONE: Record<string, Tone> = {
  ok: "ok",
  partial: "warn",
  rate_limited: "warn",
  budget_exceeded: "bad",
  error: "bad",
  running: "neutral",
};

function taskLabel(task: string): string {
  return JEV_TASK_LABELS_TR[task] ?? task;
}

function runStatusLabel(status: string): string {
  return JEV_RUN_STATUS_LABELS_TR[status] ?? status;
}

function runStatusTone(status: string): Tone {
  return JEV_RUN_STATUS_TONE[status] ?? "neutral";
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

function monthTone(month: JevShadowStatus["month"]): Tone {
  if (month.exceeded || month.pct >= 100) return "bad";
  if (month.pct >= 80) return "warn";
  return "neutral";
}

function lastRunHint(lastRun: JevRunRow): string {
  return `${fmtInt(lastRun.calls)} çağrı · ${fmtInt(lastRun.errors)} hata`;
}

/**
 * "Jev gölge ölçümü": monthly budget KPIs, the last run, and the
 * per-task agreement table. `status`/`now` are read once in page.tsx and
 * passed in — this component itself does no I/O and no Date.now().
 */
export function JevShadowSection({
  status,
  now,
}: {
  status: JevShadowStatus | null;
  now: number;
}) {
  return (
    <AdminSection
      id="jev-golge"
      title="Jev gölge ölçümü"
      help="Jev, haberleri arka planda ikinci bir gözle etiketleyen dil modeli. Gölge modda çalışır: sonuçları okuyucuya gösterilmez, yalnızca mevcut sistemle karşılaştırılır."
      action="Uyum oranı birden düşerse ya da son çalışma hata verdiyse Jev ayarlarını kontrol edin."
      headerRight={
        <Link
          href="/admin/jev-altin"
          className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline"
        >
          Altın küme: etiketleme ve karne
        </Link>
      }
    >
      {status === null ? (
        <EmptyState kind="error">Jev gölge durumu okunamadı.</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="space-y-2">
              <KpiTile
                label="Bu ay jeton"
                value={fmtInt(status.month.inputTokens)}
                hint={`sınır ${fmtInt(status.month.cap)} (%${status.month.pct})`}
                tone={monthTone(status.month)}
              />
              <Meter
                pct={status.month.pct}
                tone={monthTone(status.month)}
                label="Aylık jeton kullanımı"
              />
            </div>
            <KpiTile label="Tahmini maliyet" value={fmtUsd(status.month.usd)} />
            <KpiTile
              label="Çağrı / çalışma"
              value={`${fmtInt(status.month.calls)} / ${fmtInt(status.month.runs)}`}
            />
            <KpiTile
              label="Son çalışma"
              value={
                status.lastRun === null ? (
                  "Henüz çalışma yok"
                ) : (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <span title={fmtDateTime(status.lastRun.started_at)}>
                      {fmtRelative(status.lastRun.started_at, now)}
                    </span>
                    <StatusBadge tone={runStatusTone(status.lastRun.status)}>
                      {runStatusLabel(status.lastRun.status)}
                    </StatusBadge>
                  </span>
                )
              }
              hint={status.lastRun === null ? undefined : lastRunHint(status.lastRun)}
              tone={status.lastRun === null ? "muted" : runStatusTone(status.lastRun.status)}
            />
          </div>
          {status.month.exceeded && (
            <p className="text-sm text-destructive">
              — bütçe doldu, çağrılar durduruldu.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Uyum doğruluk değildir: yalnızca Jev ile mevcut sistemin aynı cevabı verme oranıdır.
          </p>
          {(() => {
            const agreementRows = buildAgreementRows(status.agreement24h, status.agreement7d);
            return agreementRows.length === 0 ? (
              <EmptyState>Henüz gölge tahmin yok.</EmptyState>
            ) : (
              <DataTable minWidth="md">
                <thead>
                  <Tr>
                    <Th>Görev</Th>
                    <Th numeric>Uyum 24 saat</Th>
                    <Th numeric>Uyum 7 gün</Th>
                    <Th numeric title="Jev'in ve sistemin cevap verdiği tahmin sayısı">
                      Karşılaştırılan (7 gün)
                    </Th>
                    <Th numeric title="Jev'in net cevap vermediği, karşılaştırılamayan tahminler">
                      Kararsız
                    </Th>
                  </Tr>
                </thead>
                <tbody>
                  {agreementRows.map((row) => (
                    <Tr key={row.task}>
                      <Td>{taskLabel(row.task)}</Td>
                      <Td numeric>
                        <span
                          className={toneTextClass(rateTone(row.rate24h))}
                          title={row.rate24h === null ? "Bu pencerede karşılaştırma yok" : undefined}
                        >
                          {fmtPct(row.rate24h)}
                        </span>
                      </Td>
                      <Td numeric>
                        <span
                          className={toneTextClass(rateTone(row.rate7d))}
                          title={row.rate7d === null ? "Bu pencerede karşılaştırma yok" : undefined}
                        >
                          {fmtPct(row.rate7d)}
                        </span>
                      </Td>
                      <Td numeric>{fmtInt(row.total)}</Td>
                      <Td numeric>{fmtInt(row.undecided)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </DataTable>
            );
          })()}
        </>
      )}
    </AdminSection>
  );
}

/**
 * "Anlaşmazlık kuyruğu": the newest disagreements between Jev and the
 * baseline (capped upstream at JEV_QUEUE_LIMIT). Each row's free-text
 * `state_preview` is rendered as text nodes only — never HTML — either as
 * labelled fields via parseStatePreview, or as a plain whitespace-pre-wrap
 * fallback when it doesn't parse.
 */
export function JevDisagreementQueue({
  status,
  now,
}: {
  status: JevShadowStatus | null;
  now: number;
}) {
  const queue = status?.queue ?? [];
  return (
    <AdminSection
      id="anlasmazlik"
      title="Anlaşmazlık kuyruğu"
      help="Jev ile mevcut sistemin aynı haber için farklı cevap verdiği örnekler (en yeni 30)."
      action="Metni okuyun ve hangisinin doğru olduğunu seçin. Kararınız okuyucu sayfalarını değiştirmez; yalnızca Jev'i değerlendirmek için saklanır."
      count={queue.length}
      tone={queue.length > 0 ? "warn" : "neutral"}
    >
      {status === null ? (
        <EmptyState kind="error">Jev gölge durumu okunamadı.</EmptyState>
      ) : queue.length === 0 ? (
        <EmptyState>İncelenecek anlaşmazlık yok.</EmptyState>
      ) : (
        <ul className="divide-y divide-border/60">
          {queue.map((row) => {
            const fields = parseStatePreview(row.state_preview);
            return (
              <li key={row.id} className="min-w-0 space-y-2 py-3 break-words">
                <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                  <StatusBadge tone="neutral">{taskLabel(row.task)}</StatusBadge>
                  <span title={fmtDateTime(row.created_at)}>{fmtRelative(row.created_at, now)}</span>
                </p>
                {fields ? (
                  <dl className="space-y-1">
                    {fields.map((field, index) => (
                      <div key={field.label}>
                        <FieldLabel>{field.label}</FieldLabel>
                        <dd
                          className={
                            index === 0
                              ? "text-base font-medium text-foreground"
                              : "text-sm text-foreground"
                          }
                        >
                          {field.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="text-sm whitespace-pre-wrap text-foreground">{row.state_preview}</p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-border p-2">
                    <FieldLabel>Sistem</FieldLabel>
                    <p className="text-sm text-foreground">{row.baseline_answer}</p>
                  </div>
                  <div className="rounded-lg border border-border p-2">
                    <FieldLabel>Jev</FieldLabel>
                    <p className="text-sm text-foreground">
                      {row.jev_choice ?? (row.jev_prob != null ? fmtPct(row.jev_prob) : "—")}
                    </p>
                  </div>
                </div>
                <JevReviewActions id={row.id} />
              </li>
            );
          })}
        </ul>
      )}
    </AdminSection>
  );
}
