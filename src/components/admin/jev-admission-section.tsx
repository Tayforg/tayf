import type { JevAdmissionStatus } from "@/lib/admin/jev-admission";
import {
  JEV_ADMISSION_OUTCOME_LABELS,
  JEV_ADMISSION_REVIEW_TARGET,
  JEV_ADMISSION_UNDECIDED_LABEL,
  wilson,
  zoneShares,
} from "@/lib/admin/jev-admission";
import { AdminSection, EmptyState, FieldLabel, KpiTile, Meter, StatusBadge } from "@/components/admin/admin-ui";
import { fmtInt, fmtPct } from "@/lib/admin/format";
import { JevAdmissionReviewActions } from "@/components/admin/jev-admission-review-actions";

// Migration 089 ("ADMIT") — the /admin "Jev siyaset kabulü" section (group
// "Jev kalite", id "jev-kabul"). Plain SYNCHRONOUS server component (no
// "use cache", no fetch): `status` is read once in page.tsx and passed in
// as a prop. Ships with the flag off, so this section is mostly zeros
// until an operator flips JEV_POLITICS_ADMISSION to shadow.

const G1_TARGET = 0.7;

export function JevAdmissionSection({ status }: { status: JevAdmissionStatus | null }) {
  const helpText =
    "Jev'in siyaset dışı görünen haberleri siyasi kümelemeye kabul etmesi. Bayrak açıkken bile önce gölge modda dener; okurlar hiçbir şey görmez.";

  if (status === null) {
    return (
      <AdminSection id="jev-kabul" title="Jev siyaset kabulü" help={helpText} collapsible>
        <EmptyState kind="error">Siyaset kabulü okunamadı.</EmptyState>
      </AdminSection>
    );
  }

  const { stats48, stats168, mode, reviewBatch, reviewedByCategory, reviewedByZone, reviewedCount } = status;

  if (mode === "Kapalı ya da aday yok" && stats168.claims === 0) {
    return (
      <AdminSection id="jev-kabul" title="Jev siyaset kabulü" help={helpText} collapsible>
        <EmptyState>Henüz kabul talebi yok (bayrak kapalı).</EmptyState>
      </AdminSection>
    );
  }

  const admittedShares = zoneShares(stats168.admittedBias);
  const baselineShares = zoneShares(stats168.baselineBias);
  const reviewedRelevant =
    (reviewedByCategory.domestic ?? 0) + (reviewedByCategory.policy_adjacent ?? 0);
  const wilsonBound = wilson(reviewedRelevant, reviewedCount);

  return (
    <AdminSection id="jev-kabul" title="Jev siyaset kabulü" help={helpText} collapsible>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile label="Mod" value={mode} />
        <KpiTile label="Talepler (48 sa)" value={fmtInt(stats48.claims)} />
        <KpiTile label="Talepler (7 gün)" value={fmtInt(stats168.claims)} />
        <KpiTile label="Günlük talep" value={stats168.claimsPerDay.toFixed(1)} />
      </div>

      <div className="mt-4 space-y-1">
        <FieldLabel>Sonuç dağılımı</FieldLabel>
        <ul className="flex flex-wrap gap-2 text-sm">
          {Object.entries(stats168.outcomes).length === 0 ? (
            <StatusBadge tone="muted">{JEV_ADMISSION_UNDECIDED_LABEL}</StatusBadge>
          ) : (
            Object.entries(stats168.outcomes).map(([outcome, n]) => (
              <StatusBadge key={outcome} tone="muted">
                {JEV_ADMISSION_OUTCOME_LABELS[outcome as keyof typeof JEV_ADMISSION_OUTCOME_LABELS] ??
                  outcome}
                : {fmtInt(n)}
              </StatusBadge>
            ))
          )}
        </ul>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <KpiTile label="Mevcut kümelere katılım" value={fmtInt(stats168.joinExisting)} />
        <KpiTile label="Kabulle açılan kümelere katılım" value={fmtInt(stats168.joinAdmissionSeeded)} />
        <KpiTile label="Çok kaynaklı kümelere katılım" value={fmtInt(stats168.joinedMultiSource)} />
        <KpiTile label="Kümeye yeni bölge ekledi" value={fmtInt(stats168.zoneAddedExisting)} />
        <KpiTile
          label="Kör nokta: kalktı / oluştu"
          value={`${fmtInt(stats168.blindspotWithdrawn)} / ${fmtInt(stats168.blindspotCreated)}`}
        />
        <KpiTile
          label="Taze puanlama (60 dk içinde)"
          value={
            stats48.freshScored60mShare === null ? "—" : fmtPct(stats48.freshScored60mShare)
          }
          hint={`G1 hedefi: ≥ ${fmtPct(G1_TARGET)}`}
          tone={
            stats48.freshScored60mShare !== null && stats48.freshScored60mShare >= G1_TARGET
              ? "ok"
              : "warn"
          }
        />
        <KpiTile
          label="Talep gecikmesi (p50, dk)"
          value={stats48.claimLagP50Min === null ? "—" : stats48.claimLagP50Min.toFixed(1)}
        />
      </div>

      <div className="mt-4 space-y-2">
        <FieldLabel>Bölge dağılımı: kabul edilenler / temel</FieldLabel>
        <div className="space-y-1 text-sm">
          <div className="flex items-center gap-2">
            <span className="w-20 text-xs text-muted-foreground">İktidar</span>
            <Meter pct={admittedShares.iktidar * 100} label="İktidar payı (kabul)" />
            <span className="w-12 text-right text-xs">{fmtPct(admittedShares.iktidar)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-20 text-xs text-muted-foreground">Bağımsız</span>
            <Meter pct={admittedShares.bagimsiz * 100} label="Bağımsız payı (kabul)" />
            <span className="w-12 text-right text-xs">{fmtPct(admittedShares.bagimsiz)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-20 text-xs text-muted-foreground">Muhalefet</span>
            <Meter pct={admittedShares.muhalefet * 100} label="Muhalefet payı (kabul)" />
            <span className="w-12 text-right text-xs">{fmtPct(admittedShares.muhalefet)}</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Temel: iktidar {fmtPct(baselineShares.iktidar)}, bağımsız {fmtPct(baselineShares.bagimsiz)},
          muhalefet {fmtPct(baselineShares.muhalefet)}.
        </p>
      </div>

      <div className="mt-4 space-y-1">
        <FieldLabel>
          İnceleme: {fmtInt(reviewedCount)} / {JEV_ADMISSION_REVIEW_TARGET}
        </FieldLabel>
        <Meter
          pct={(reviewedCount / JEV_ADMISSION_REVIEW_TARGET) * 100}
          label="İnceleme ilerlemesi"
        />
        <p className="text-xs text-muted-foreground">
          Siyasetle ilgili: {fmtPct(reviewedCount > 0 ? reviewedRelevant / reviewedCount : 0)} (Wilson alt
          sınırı {fmtPct(wilsonBound.lower)})
        </p>
        <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {Object.entries(reviewedByCategory).map(([cat, n]) => (
            <li key={cat}>
              {cat || "—"}: {fmtInt(n)}
            </li>
          ))}
        </ul>
        {reviewedByZone && (
          <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <li>İktidar: {fmtInt(reviewedByZone.iktidar)}</li>
            <li>Bağımsız: {fmtInt(reviewedByZone.bagimsiz)}</li>
            <li>Muhalefet: {fmtInt(reviewedByZone.muhalefet)}</li>
          </ul>
        )}
      </div>

      <div className="mt-4 space-y-2">
        <FieldLabel>İnceleme kuyruğu</FieldLabel>
        {reviewBatch.length === 0 ? (
          <EmptyState>İncelenecek talep yok.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/60">
            {reviewBatch.map((row) => (
              <li key={row.articleId} className="min-w-0 space-y-2 py-3 break-words">
                <div>
                  <FieldLabel>{row.category || "—"}</FieldLabel>
                  <p className="text-sm font-medium text-foreground">{row.title ?? "—"}</p>
                </div>
                <JevAdmissionReviewActions articleId={row.articleId} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminSection>
  );
}
