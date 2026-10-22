import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AlertTriangle } from "lucide-react";

import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { PageHero } from "@/components/ui/page-hero";
import { RetryButton } from "@/components/ui/retry-button";
import { ZONE_META } from "@/lib/bias/config";
import {
  getClusterDetailOrThrow,
  type ClusterDetail,
} from "@/lib/clusters/cluster-detail-query";
import {
  compareHref,
  parseCompareParams,
  type ParsedSide,
} from "@/lib/compare/compare-params";
import {
  formatIstanbulDateTime,
  toSideState,
  type SideState,
} from "@/lib/compare/compare-view";
import type { MediaDnaZone } from "@/types";

// A shareable view of two clusters: noindex (the URL space is unbounded and
// the page is a tool, not content) but follow, with a fixed canonical so the
// query string never forks it into duplicates.
export const metadata: Metadata = {
  title: "Karşılaştır",
  description:
    "İki hikâyeyi yan yana görün: kaynak dağılımı, taraf yelpazesi, ilk yayın zamanı.",
  alternates: { canonical: "/karsilastir" },
  robots: { index: false, follow: true },
};

type SearchParams = { a?: string | string[]; b?: string | string[] };

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

// Static shell. Reading `searchParams` is request-time data, so under
// cacheComponents it has to sit inside <Suspense>; the shell (container,
// hero, skeleton) stays prerenderable.
export default function KarsilastirPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl space-y-5">
      <PageHero
        kicker="Yan yana"
        title="Karşılaştır"
        subtitle="İki hikâyenin kaynak dağılımını yan yana görün."
      />
      <Suspense fallback={<CompareSkeleton />}>
        <CompareBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function CompareSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2" aria-hidden="true">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-border/60 bg-card/40 p-5 space-y-4 animate-pulse"
        >
          <div className="h-6 w-3/4 rounded bg-muted/70" />
          <div className="h-3 w-1/2 rounded bg-muted/40" />
          <div className="h-2 w-full rounded-full bg-muted/40" />
          <div className="h-16 w-full rounded bg-muted/30" />
        </div>
      ))}
    </div>
  );
}

// Resolves null for a side that has nothing to fetch. Declared async so a
// synchronous throw inside the fetcher still becomes a rejection that
// allSettled can contain.
async function loadSide(side: ParsedSide): Promise<ClusterDetail | null> {
  if (side.kind !== "id") return null;
  return getClusterDetailOrThrow(side.id);
}

// Exported (besides the default page) so the test can render the data-bound
// body without a Suspense-aware renderer. Never 404s, never throws: every
// failure is reported on the side it belongs to, so the page is always a 200.
export async function CompareBody({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const parsed = parseCompareParams(await searchParams);

  if (parsed.a.kind !== "id" && parsed.b.kind !== "id") {
    return Picker({
      anyInvalid: parsed.a.kind === "invalid" || parsed.b.kind === "invalid",
    });
  }

  // Both reads start in the same tick, on the existing reader client; one
  // slow or failing side must not delay or fail the other.
  const [settledA, settledB] = await Promise.allSettled([
    loadSide(parsed.a),
    loadSide(parsed.b),
  ]);
  const stateA = toSideState(parsed.a, settledA);
  const stateB = toSideState(parsed.b, settledB);

  // SideColumn and Picker are hookless, so they are invoked as plain
  // functions: the returned tree carries their markup directly (testable by a
  // simple tree walk) instead of opaque component elements.
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {SideColumn({
        state: stateA,
        otherId: parsed.b.kind === "id" ? parsed.b.id : null,
      })}
      {SideColumn({
        state: stateB,
        otherId: parsed.a.kind === "id" ? parsed.a.id : null,
      })}
    </div>
  );
}

function Picker({ anyInvalid }: { anyInvalid: boolean }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-6 sm:p-8 space-y-4">
      <p className="max-w-prose text-sm text-muted-foreground leading-relaxed">
        İki hikâyeyi yan yana görmek için: bir haber sayfasında “Karşılaştır”a dokunun, ardından ikinci haberi açıp yine dokunun; “Karşılaştır (2)” bağlantısı sizi buraya getirir.
      </p>
      {anyInvalid && (
        <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
          Bağlantıdaki haber kimlikleri geçersiz.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Link
          href="/"
          className="inline-flex min-h-[44px] touch-manipulation items-center rounded-full border border-border/60 bg-background px-4 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          Haberlere git
        </Link>
        <Link
          href="/blindspots"
          className="inline-flex min-h-[44px] touch-manipulation items-center rounded-full border border-border/60 bg-background px-4 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          Kör noktalar
        </Link>
      </div>
    </div>
  );
}

const NOTICE_BOX =
  "rounded-xl border border-dashed border-border/60 bg-card/30 p-6 space-y-3";

function SideColumn({
  state,
  otherId,
}: {
  state: SideState;
  otherId: string | null;
}) {
  switch (state.kind) {
    case "missing":
      return (
        <div className={NOTICE_BOX}>
          <p className="text-sm text-muted-foreground">
            Bu taraf boş. Bir haber sayfasında “Karşılaştır”a dokunarak ekleyin.
          </p>
        </div>
      );
    case "invalid":
      return (
        <div className={NOTICE_BOX}>
          <p className="text-sm text-muted-foreground">
            Bu taraftaki bağlantı geçersiz.
          </p>
        </div>
      );
    case "duplicate":
      return (
        <div className={NOTICE_BOX}>
          <p className="text-sm text-muted-foreground">
            İki taraf aynı haber; başka bir haber seçin.
          </p>
        </div>
      );
    case "not_found":
      return (
        <div className={NOTICE_BOX}>
          <p className="text-sm text-muted-foreground">Bu haber bulunamadı.</p>
        </div>
      );
    case "unavailable":
      return (
        <div className={NOTICE_BOX}>
          <p className="text-sm text-muted-foreground">
            Bu haber şu an yüklenemedi; birkaç dakika içinde tekrar deneyin.
          </p>
          <RetryButton />
        </div>
      );
    case "merged":
      return (
        <div className={NOTICE_BOX}>
          <p className="text-sm text-muted-foreground">
            Bu haber başka bir kümeyle birleştirildi.
          </p>
          <Link
            href={compareHref(state.survivorId, otherId)}
            className="inline-flex min-h-[44px] items-center touch-manipulation text-sm font-medium text-brand underline decoration-dotted underline-offset-2"
          >
            Güncel haberle karşılaştır
          </Link>
        </div>
      );
    case "ok": {
      const { view } = state;
      const firstPublished = formatIstanbulDateTime(view.firstPublished);
      const meta = firstPublished
        ? `${view.sourceCount} kaynak · İlk yayın: ${firstPublished}`
        : `${view.sourceCount} kaynak`;
      return (
        <article className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-5 space-y-4 min-w-0">
          <h2 className="font-serif text-xl font-semibold leading-snug text-foreground">
            <Link
              href={`/cluster/${view.id}`}
              className="underline-offset-2 hover:underline"
            >
              {view.title}
            </Link>
          </h2>

          <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-muted-foreground">
            <span>{meta}</span>
            {view.isBlindspot && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2.5} />
                Kör nokta
              </span>
            )}
          </div>

          <BiasSpectrum distribution={view.distribution} compact />

          <div className="space-y-3">
            {ZONES.map((zone) => {
              const names = view.roster[zone];
              const zoneMeta = ZONE_META[zone];
              return (
                <div key={zone} className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`h-2 w-2 rounded-full ${zoneMeta.dot}`}
                      aria-hidden="true"
                    />
                    <span
                      className={`font-serif text-[11px] font-semibold uppercase tracking-wide ${zoneMeta.zoneLabel}`}
                    >
                      {zoneMeta.label}
                    </span>
                  </div>
                  {names.length > 0 ? (
                    <p className="text-[13px] text-foreground/90 leading-relaxed">
                      {names.join(", ")}
                    </p>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">
                      Bu bölgeden kaynak yok
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {view.nonVoting.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {`Toplayıcı / niş (spektruma sayılmaz): ${view.nonVoting.join(", ")}`}
            </p>
          )}

          <Link
            href={compareHref(otherId)}
            aria-label={`Bu tarafı kaldır: ${view.title}`}
            className="inline-flex min-h-[44px] items-center touch-manipulation text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            Bu tarafı kaldır
          </Link>
        </article>
      );
    }
  }
}
