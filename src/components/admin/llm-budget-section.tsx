import {
  AdminSection,
  EmptyState,
  KpiTile,
  Meter,
  toneTextClass,
  type Tone,
} from "@/components/admin/admin-ui";
import { fmtPct, fmtUsd } from "@/lib/admin/format";
import type { LlmBudgetStatus } from "@/lib/admin/llm-budget-status";

// Migration 069 (B7) — /admin "Başlık LLM bütçesi" section (group #is).
// Non-async SERVER component: /admin's page.tsx reads getLlmBudgetStatus()
// once (the shared Promise.all) and passes the result down as a prop. No
// "use cache" — there is nothing left to fetch here.
//
// The sentences below the KPI tiles are verbatim from the pack's shared
// contract — do not paraphrase, only add explanation around them.

const HELP =
  "Nötr başlık yazmak için kullanılan dil modelinin bugünkü (UTC) harcaması. Günlük sınır dolunca çağrılar ertesi güne kadar durur.";

function spendTone(status: LlmBudgetStatus): Tone {
  if (status.exceeded) return "bad";
  if (status.pct >= 80) return "warn";
  return "ok";
}

export function LlmBudgetSection({ status }: { status: LlmBudgetStatus | null }) {
  return (
    <AdminSection id="llm-butce" title="Başlık LLM bütçesi" help={HELP}>
      {status === null ? (
        <EmptyState kind="error">Başlık LLM bütçesi okunamadı.</EmptyState>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <KpiTile
              label="Bugünkü harcama"
              value={fmtUsd(status.usd, 4)}
              tone={spendTone(status)}
              hint={
                <Meter
                  pct={status.pct}
                  tone={spendTone(status)}
                  label="Günlük LLM bütçesi"
                />
              }
            />
            <KpiTile
              label="Uygun küme payı"
              value={fmtPct(status.eligibleShare)}
              hint="LLM ile nötr başlık yazılmaya uygun bulunan kümeler"
            />
          </div>

          {status.calls === 0 ? (
            <p className="text-sm text-muted-foreground">
              Bugün başlık LLM çağrısı yok.
            </p>
          ) : (
            <p className="text-sm text-foreground">
              {`Bugün: ${status.calls} çağrı · ≈${status.usd.toFixed(4)} $ · sınır ${status.cap.toFixed(2)} $ (%${status.pct})`}
              {status.exceeded && (
                <span className={toneTextClass("bad")}>
                  {" "}
                  — günlük bütçe doldu, çağrılar durduruldu.
                </span>
              )}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {status.eligibleShare === null
              ? "Uygun küme: henüz ölçülmedi."
              : `Uygun küme: ${status.eligibleN}/${status.eligibleN + status.ineligibleN} (%${Math.round(status.eligibleShare * 100)})`}
          </p>
          <p className="text-sm text-muted-foreground">
            Uygunluk kapısı Jev gölge tahminlerinden hesaplanır; ölçüm yoksa küme çıkarımsal yola düşer.
          </p>
        </div>
      )}
    </AdminSection>
  );
}
