import Link from "next/link";
import type { JevUnlinkCandidateView } from "@/lib/admin/jev-cluster";
import {
  AdminSection,
  EmptyState,
  FieldLabel,
  StatusBadge,
  toneTextClass,
  type Tone,
} from "@/components/admin/admin-ui";
import { fmtDateTime, fmtPct, fmtRelative } from "@/lib/admin/format";
import { JevUnlinkActions } from "@/components/admin/jev-unlink-actions";

// Pack A ("Jev canlı küme", migration 064) — the /admin "Küme dışı adaylar"
// section: Jev's outlier-ejection queue. Nothing here is unlinked
// automatically; a human presses "Ayır" or "Kalsın" for each row.
//
// Plain SYNCHRONOUS server component (no "use cache", no fetch):
// `candidates`/`now` are read once in page.tsx and passed in as props.
// null degrades to the Turkish read-failure sentence, [] to the
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
        <StatusBadge tone="muted">{row.sourceSlug ?? "—"}</StatusBadge>
        <span className={toneTextClass(probTone(row.jevProb))}>
          Kümeye ait olma olasılığı: {fmtPct(row.jevProb)}
        </span>
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

export function JevUnlinkSection({
  candidates,
  now,
}: {
  candidates: JevUnlinkCandidateView[] | null;
  now: number;
}) {
  const list = candidates ?? [];
  const visible = list.slice(0, CANDIDATE_PREVIEW_COUNT);
  const rest = list.slice(CANDIDATE_PREVIEW_COUNT);

  return (
    <AdminSection
      id="kume-disi"
      title="Küme dışı adaylar"
      help="Küme: aynı olayı anlatan haberlerin grubu. Jev'e göre bu haberler bulundukları kümeye ait olmayabilir."
      action="Ayır: haber kümeden çıkarılır ve okuyucu sayfaları güncellenir. Kalsın: haber kümede kalır, aday listeden düşer. Hiçbir şey otomatik ayrılmaz."
      count={list.length}
      tone={list.length > 0 ? "warn" : "neutral"}
    >
      {candidates === null ? (
        <EmptyState kind="error">Küme dışı adaylar okunamadı.</EmptyState>
      ) : list.length === 0 ? (
        <EmptyState>Bekleyen aday yok.</EmptyState>
      ) : (
        <>
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
  );
}
