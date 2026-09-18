import Link from "next/link";

// The single place the "denominator" footnote wording lives. Every
// share-of-coverage claim on Tayf (yanlılık dağılımı, kör nokta) is computed
// against sources that (1) vote — only outlet/wire kinds, never
// aggregator/niche (src/lib/sources/kind.ts) — AND (2) actually delivered
// an article in the trailing 72 h — not the full active-source count
// (src/lib/sources/feed-status.ts, src/lib/clusters/feed-health.ts). A-H1:
// `delivering`/`total` must be the voting-kind intersection (e.g. 59/96 in
// production), not the all-kinds count (72/118) — neither of those is the
// real share denominator. This note says so wherever a share is shown
// (/sources, /blindspots) and links to the row-level evidence at
// /kaynaklar/durum.
//
// Fail-open on the reader side too: when either number is unknown (the
// upstream fetch returned null — see the fail-open contracts on
// getFeedStatusSummary / getZoneFeedHealth), OR `total` is 0 (A-M1 — a
// successful-but-empty response is not "known", since publishing "0/0
// kaynak" as an authoritative claim is exactly the fabricated-figure this
// note exists to avoid), this degrades to the wording without numbers
// rather than a fabricated figure or a blank line.

interface DenominatorNoteProps {
  delivering: number | null;
  total: number | null;
}

export function DenominatorNote({ delivering, total }: DenominatorNoteProps) {
  const knownFigures = delivering !== null && total !== null && total > 0;

  return (
    <p className="text-xs text-muted-foreground">
      {knownFigures ? (
        <>
          Paylar, yanlılık dağılımına sayılan ve son 72 saatte en az bir
          haber veren <span className="font-mono">{delivering}</span>/
          <span className="font-mono">{total}</span> kaynak üzerinden
          hesaplanır.{" "}
        </>
      ) : (
        <>
          Paylar, yanlılık dağılımına sayılan ve son 72 saatte en az bir
          haber veren kaynaklar üzerinden hesaplanır.{" "}
        </>
      )}
      <Link
        href="/kaynaklar/durum"
        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        Kaynak durumu →
      </Link>
    </p>
  );
}
