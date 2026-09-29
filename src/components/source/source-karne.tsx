import Link from "next/link";

import { ZONE_META } from "@/lib/bias/config";
import { formatDdMmYyyy } from "@/lib/format/date-tr";
import { buildKarneView, type SourceKarne } from "@/lib/sources/karne";

// "Kapsama karnesi" card on /source/[slug], under the Etiket kartı.
// Server Component, plain props, no Supabase. Neutral wording only: never
// claims a source "skipped" or "ignored" anything (see docs/source-karne.md).

export interface SourceKarneCardProps {
  karne: SourceKarne | null;
  slug: string;
}

const FOOTNOTE_BODY =
  "Yalnızca Tayf'ın kümelediği (siyaset ve son dakika) haberler sayılır. Eşleştirilemeyen bir haber, başka kaynakların o olayı yazmadığı anlamına gelmez; farklı dildeki yayınlar ve eşleştirme hataları bu oranı etkiler. Karşı taraftan aynı olayı anlatan haber bulunan kümeler kör nokta sayısına dahil değildir.";

export function SourceKarneCard({ karne, slug }: SourceKarneCardProps) {
  if (!karne) return null;

  const view = buildKarneView(karne);
  const subtitle = `Son ${karne.windowDays} gün · ${formatDdMmYyyy(karne.windowStart)}–${formatDdMmYyyy(karne.windowEnd)} · n = ${karne.nClusters} haber kümesi`;

  return (
    <section className="space-y-4 rounded-xl border border-border/60 bg-card/40 p-5 sm:p-6">
      <div className="space-y-1">
        <h2 className="font-serif text-lg font-semibold tracking-tight">
          Kapsama karnesi
        </h2>
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>
      </div>

      {view.state === "insufficient" ? (
        <p className="rounded-lg border border-dashed border-border/60 bg-card/40 p-4 text-center text-sm text-muted-foreground">
          {`Son ${karne.windowDays} günde karne için yeterli haber yok (n = ${view.n}, en az 20 gerekir).`}
        </p>
      ) : (
        <>
          <dl className="space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">
                Başka kaynakların da yazdığı haberler
              </dt>
              <dd className="font-medium text-foreground">{view.multiText}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">
                Tayf&apos;ın başka bir kaynakla eşleştiremediği haberler
              </dt>
              <dd className="font-medium text-foreground">{view.soloText}</dd>
            </div>
          </dl>

          <div className="space-y-2">
            {view.zones ? (
              <>
                <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {view.zoneHeader}
                </h3>
                <ul className="space-y-1.5 text-sm">
                  {view.zones.map((row) => (
                    <li
                      key={row.zone}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="inline-flex items-center gap-2 text-muted-foreground">
                        <span
                          className={`h-2 w-2 rounded-full ${ZONE_META[row.zone].dot}`}
                          aria-hidden="true"
                        />
                        {row.label}
                      </span>
                      <span className="font-medium text-foreground">{row.text}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] text-muted-foreground">{view.zoneNote}</p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {view.zonesInsufficientText}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <p className="text-foreground">{view.blindspotText}</p>
            <Link
              href="/blindspots"
              className="text-xs font-medium text-brand hover:underline"
            >
              Kör noktalar →
            </Link>
          </div>
        </>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {`${FOOTNOTE_BODY} Son hesaplama: ${formatDdMmYyyy(karne.computedAt)}.`}
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link
          href="/metodoloji#kaynaklar"
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors brand-underline"
        >
          Nasıl hesaplanıyor?
        </Link>
        <Link
          href={`/metodoloji?source=${encodeURIComponent(slug)}#duzeltme`}
          className="inline-flex items-center text-xs font-medium text-brand hover:underline"
        >
          Bu sayılara itiraz et
        </Link>
      </div>
    </section>
  );
}
