import Link from "next/link";
import type { JevUnlinkCandidateView, JevUnlinkTriageView } from "@/lib/admin/jev-cluster";
import {
  AdminSection,
  EmptyState,
  FieldLabel,
  StatusBadge,
  toneTextClass,
  type Tone,
} from "@/components/admin/admin-ui";
import { fmtDateTime, fmtInt, fmtPct, fmtRelative } from "@/lib/admin/format";
import { JevUnlinkActions } from "@/components/admin/jev-unlink-actions";
import { JevUnlinkBulkKeep } from "@/components/admin/jev-unlink-bulk-keep";
import { JEV_UNLINK_SKIP_REASON_LABELS, type JevUnlinkSkipReason } from "@/lib/admin/jev-unlink-triage";

// Pack A ("Jev canlı küme", migration 064) — the /admin "Küme dışı adaylar"
// section: Jev's outlier-ejection queue. Nothing here is unlinked
// automatically; a human presses "Ayır" or "Kalsın" for each row.
//
// Migration 075 adds the triage layer on top: a 'likely_unlink' band that
// sorts first (getJevUnlinkCandidates already orders by band then jev_prob,
// so this component does not re-sort), a bulk "Kalsın" for band 'review'
// rows only, and a read-only dry-run block showing what a guarded
// auto-unlink WOULD do — never changing membership itself.
//
// Plain SYNCHRONOUS server component (no "use cache", no fetch):
// `candidates`/`now`/`triage` are read once in page.tsx and passed in as
// props. null degrades to the Turkish read-failure sentence, [] to the
// empty-queue sentence — this component itself can never throw.

const CANDIDATE_PREVIEW_COUNT = 5;

function probTone(prob: number): Tone {
  if (prob < 0.2) return "bad";
  if (prob < 0.4) return "warn";
  return "neutral";
}

function CandidateCard({
  row,
  now,
}: {
  row: JevUnlinkCandidateView;
  now: number;
}) {
  return (
    <li className="min-w-0 space-y-2 py-3 break-words">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <FieldLabel>Küme</FieldLabel>
          <p className="text-sm text-muted-foreground">{row.clusterTitle}</p>
        </div>
        <Link
          href={`/cluster/${row.clusterId}`}
          className="text-xs text-brand hover:underline"
        >
          Kümeyi aç
        </Link>
      </div>
      <div>
        <FieldLabel>Aday haber</FieldLabel>
        <p className="text-base font-medium text-foreground">{row.articleTitle}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {row.band === "likely_unlink" && (
          <StatusBadge tone="bad">Muhtemelen ayrılmalı</StatusBadge>
        )}
        <StatusBadge tone="muted">{row.sourceSlug ?? "—"}</StatusBadge>
        <span className={toneTextClass(probTone(row.jevProb))}>
          Kümeye ait olma olasılığı: {fmtPct(row.jevProb)}
        </span>
        {row.titleJaccard !== null && row.titleJaccard !== undefined && (
          <span
            className="text-muted-foreground"
            title="Haber başlığı ile küme başlığındaki ortak kelime oranı"
          >
            Başlık benzerliği: {fmtPct(row.titleJaccard)}
          </span>
        )}
        <span
          className="text-muted-foreground"
          title={fmtDateTime(row.createdAt)}
        >
          {fmtRelative(row.createdAt, now)}
        </span>
      </div>
      <JevUnlinkActions id={row.id} />
    </li>
  );
}

function BandLine({ triage }: { triage: JevUnlinkTriageView }) {
  return (
    <p className="text-sm text-muted-foreground">
      {fmtInt(triage.bands.likelyUnlink)} muhtemelen ayrılmalı · {fmtInt(triage.bands.review)} inceleme
      · {fmtInt(triage.bands.untriaged)} henüz sınıflanmadı
    </p>
  );
}

function DryRunRow({
  row,
}: {
  row: {
    candidateId: number;
    articleTitle: string;
    clusterTitle: string;
    jevProb: number;
    titleJaccard: number | null;
    wouldUnlink: boolean;
    skipReasons: JevUnlinkSkipReason[];
  };
}) {
  return (
    <li className="min-w-0 space-y-1 py-2 text-sm break-words">
      <p className="font-medium text-foreground">{row.articleTitle}</p>
      <p className="text-muted-foreground">Küme: {row.clusterTitle}</p>
      <p className="text-muted-foreground">
        p: {fmtPct(row.jevProb)} · Jaccard: {fmtPct(row.titleJaccard)}
      </p>
      {row.wouldUnlink ? (
        <p className={toneTextClass("bad")}>Ayırırdı</p>
      ) : (
        <p className="text-muted-foreground">
          {row.skipReasons.map((r) => JEV_UNLINK_SKIP_REASON_LABELS[r]).join(", ") || "—"}
        </p>
      )}
    </li>
  );
}

function precisionLine(bucket: {
  decided: number;
  unlinked: number;
  kept: number;
  pending: number;
  precision: number | null;
}): string {
  const certainty =
    bucket.precision === null
      ? `henüz yok (n=${bucket.decided})`
      : fmtPct(bucket.precision);
  return `${fmtInt(bucket.unlinked)} ayrıldı · ${fmtInt(bucket.kept)} kaldı · ${fmtInt(
    bucket.pending,
  )} bekliyor · kesinlik ${certainty}`;
}

function DryRunBlock({ triage }: { triage: JevUnlinkTriageView | null }) {
  if (triage === null) {
    return (
      <AdminSection
        id="unlink-dryrun"
        title="Otomatik ayırma provası (dry-run)"
        help="Bu prova hiçbir haberi kümeden çıkarmaz."
      >
        <EmptyState kind="error">Prova kaydı okunamadı.</EmptyState>
      </AdminSection>
    );
  }

  const dryRun = triage.dryRun;
  const reasonEntries = (Object.keys(JEV_UNLINK_SKIP_REASON_LABELS) as JevUnlinkSkipReason[])
    .map((reason) => `${JEV_UNLINK_SKIP_REASON_LABELS[reason]}: ${fmtInt(dryRun.reasons[reason])}`)
    .join(" · ");

  return (
    <AdminSection
      id="unlink-dryrun"
      title="Otomatik ayırma provası (dry-run)"
      help="Kural: Jev olasılığı %10'un altında, küme en az 4 haber, haber kümenin ilk haberi değil, Jev başka bir üyeyle 'aynı olay' demiyor (≥ %50), başlık küme başlığıyla aynı değil. Bu prova hiçbir haberi kümeden çıkarmaz."
    >
      <p className="text-sm text-foreground/80">
        Değerlendirilen: {fmtInt(dryRun.evaluated)} · Ayırırdı: {fmtInt(dryRun.wouldUnlink)} · Korumaya
        takıldı: {fmtInt(dryRun.guarded)}
      </p>
      <p className="text-sm text-muted-foreground">{reasonEntries}</p>
      <p className="text-sm text-muted-foreground">
        Senin kararınla karşılaştırma (ayırırdı denenler): {precisionLine(dryRun.policyA)}
      </p>
      <p className="text-sm text-muted-foreground">
        Başlık benzerliği &lt; %20 de şart olsaydı: {precisionLine(dryRun.policyB)}
      </p>
      {dryRun.recent.length > 0 && (
        <ul className="divide-y divide-border/60">
          {dryRun.recent.map((row) => (
            <DryRunRow key={row.candidateId} row={row} />
          ))}
        </ul>
      )}
    </AdminSection>
  );
}

export function JevUnlinkSection({
  candidates,
  now,
  triage,
}: {
  candidates: JevUnlinkCandidateView[] | null;
  now: number;
  triage?: JevUnlinkTriageView | null;
}) {
  const list = candidates ?? [];
  const visible = list.slice(0, CANDIDATE_PREVIEW_COUNT);
  const rest = list.slice(CANDIDATE_PREVIEW_COUNT);
  const reviewRows = list
    .filter((row) => row.band === "review")
    .map((row) => ({
      id: row.id,
      articleTitle: row.articleTitle,
      clusterTitle: row.clusterTitle,
      jevProb: row.jevProb,
    }));

  return (
    <>
      <AdminSection
        id="kume-disi"
        title="Küme dışı adaylar"
        help="Küme: aynı olayı anlatan haberlerin grubu. Jev'e göre bu haberler bulundukları kümeye ait olmayabilir."
        action="Ayır: haber kümeden çıkarılır ve okuyucu sayfaları güncellenir. Kalsın: haber kümede kalır, aday listeden düşer. 'Muhtemelen ayrılmalı' olanlar önce gelir. Hiçbir şey otomatik ayrılmaz; prova yalnızca kayıt tutar."
        count={list.length}
        tone={list.length > 0 ? "warn" : "neutral"}
      >
        {candidates === null ? (
          <EmptyState kind="error">Küme dışı adaylar okunamadı.</EmptyState>
        ) : list.length === 0 ? (
          <EmptyState>Bekleyen aday yok.</EmptyState>
        ) : (
          <>
            {triage && <BandLine triage={triage} />}
            <JevUnlinkBulkKeep rows={reviewRows} />
            <ul className="divide-y divide-border/60">
              {visible.map((row) => (
                <CandidateCard key={row.id} row={row} now={now} />
              ))}
            </ul>
            {rest.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm text-brand">
                  Kalan {rest.length} öğeyi göster
                </summary>
                <ul className="divide-y divide-border/60">
                  {rest.map((row) => (
                    <CandidateCard key={row.id} row={row} now={now} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </AdminSection>
      {triage !== undefined && <DryRunBlock triage={triage} />}
    </>
  );
}
