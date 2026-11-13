import Link from "next/link";

import type { SourceKarneRead } from "@/lib/sources/karne";
import {
  buildReliabilityView,
  reliabilityCountLine,
  type SourceReliabilityRead,
} from "@/lib/sources/reliability";

// "Kaynak göstergeleri" card on /source/[slug], right under the Kapsama
// karnesi. Server Component, plain props, no Supabase. Neutral wording only:
// four descriptive numbers about the published stream, never a trust or
// quality grade, and no direction ("who copied whom") is ever claimed.

export interface SourceReliabilityCardProps {
  reliability: SourceReliabilityRead | null;
  /** The karne row supplies the blindspot share; null shows its own note. */
  karne: SourceKarneRead | null;
  slug: string;
  /**
   * Migration 212: the feed window overflowed in the last 7 days, so the daily rate
   * is a floor ("en az") with a note. Decided by the profile read; absent = false.
   */
  windowOverflowRecent?: boolean;
}

const FOOTNOTE =
  "Bu göstergeler bir doğruluk ya da kalite notu değildir; yalnızca Tayf’ın gördüğü yayın akışını özetler. Ajans haberi kullanmak olağan bir yayıncılık pratiğidir.";

export function SourceReliabilityCard({
  reliability,
  karne,
  slug,
  windowOverflowRecent = false,
}: SourceReliabilityCardProps) {
  if (!reliability) return null;

  const rows = buildReliabilityView(reliability, karne, { windowOverflowRecent });

  return (
    <section className="space-y-4 rounded-xl border border-border/60 bg-card/40 p-5 sm:p-6">
      <div className="space-y-1">
        <h2 className="font-serif text-lg font-semibold tracking-tight">
          Kaynak göstergeleri
        </h2>
        {reliability.isStale ? (
          <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
            {`Son hesaplama ${reliability.ageDays} gün önce — veriler güncel değil`}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {reliabilityCountLine(reliability)}
          </p>
        )}
      </div>

      <dl className="space-y-3 text-sm">
        {rows.map((row) => (
          <div key={row.key} className="space-y-1">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="space-y-1">
              {row.value !== null ? (
                <p className="font-medium text-foreground">{row.value}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{row.note}</p>
              )}
              {row.value !== null && row.note !== null ? (
                <p className="text-[11px] text-muted-foreground">{row.note}</p>
              ) : null}
              {row.basis !== null ? (
                <p className="text-[11px] text-muted-foreground">{row.basis}</p>
              ) : null}
              <details>
                <summary className="text-[11px] cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
                  Nasıl hesaplanır?
                </summary>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {row.how}
                </p>
              </details>
            </dd>
          </div>
        ))}
      </dl>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {FOOTNOTE}
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link
          href="/metodoloji#kaynak-gostergeleri"
          prefetch={false}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors brand-underline"
        >
          Yöntem
        </Link>
        <Link
          href={`/metodoloji?source=${encodeURIComponent(slug)}#duzeltme`}
          rel="nofollow"
          prefetch={false}
          className="inline-flex items-center text-xs font-medium text-brand hover:underline"
        >
          Bu sayılara itiraz et
        </Link>
      </div>
    </section>
  );
}
