import { getLlmBudgetStatus } from "@/lib/admin/llm-budget-status";

// Migration 069 (B7) — /admin "Başlık LLM bütçesi" section. Modeled on
// src/components/admin/jev-shadow-section.tsx: plain async SERVER
// component, no "use cache" (this page is cookie-gated and dynamic), no
// props. Turkish copy is verbatim from the pack's shared contract — do not
// paraphrase.

export async function LlmBudgetSection() {
  const status = await getLlmBudgetStatus();

  return (
    <section className="space-y-2">
      <h2 className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">
        Başlık LLM bütçesi
      </h2>
      {status === null ? (
        <p className="font-mono text-[12px] text-muted-foreground">
          Başlık LLM bütçesi okunamadı.
        </p>
      ) : (
        <>
          {status.calls === 0 ? (
            <p className="font-mono text-[12px] text-muted-foreground">
              Bugün başlık LLM çağrısı yok.
            </p>
          ) : (
            <p className="font-mono text-[12px] text-foreground">
              {`Bugün: ${status.calls} çağrı · ≈${status.usd.toFixed(4)} $ · sınır ${status.cap.toFixed(2)} $ (%${status.pct})`}
              {status.exceeded && (
                <span className="text-destructive">
                  {" "}
                  — günlük bütçe doldu, çağrılar durduruldu.
                </span>
              )}
            </p>
          )}
          <p className="font-mono text-[12px] text-muted-foreground">
            {status.eligibleShare === null
              ? "Uygun küme: henüz ölçülmedi."
              : `Uygun küme: ${status.eligibleN}/${status.eligibleN + status.ineligibleN} (%${Math.round(status.eligibleShare * 100)})`}
          </p>
          <p className="font-mono text-[12px] text-muted-foreground">
            Uygunluk kapısı Jev gölge tahminlerinden hesaplanır; ölçüm yoksa küme çıkarımsal yola düşer.
          </p>
        </>
      )}
    </section>
  );
}
