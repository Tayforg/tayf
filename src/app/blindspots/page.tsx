import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Eye, EyeOff } from "lucide-react";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
export const metadata: Metadata = {
  title: "Kör Noktalar",
  description:
    "Bir tarafın haberi verdiği, diğerlerinin görmezden geldiği hikâyeler. Türk medyasındaki kör noktaları tek ekranda görün.",
  alternates: {
    canonical: "/blindspots",
    types: { "application/rss+xml": "/rss/kor-noktalar.xml" },
  },
};

import { ClusterCard } from "@/components/story/cluster-card";
import { NewsletterForm } from "@/components/newsletter/newsletter-form";
import { PageHero } from "@/components/ui/page-hero";
import { RetryButton } from "@/components/ui/retry-button";
import { DenominatorNote } from "@/components/source/denominator-note";
import { isMailConfigured } from "@/lib/email/resend";
import { ZONE_META } from "@/lib/bias/config";
import {
  getBlindspotsSafe,
  type BlindspotBundle,
} from "@/lib/clusters/blindspots-query";
import { getFeedStatusSummary } from "@/lib/sources/feed-status";

// /blindspots — Tayf's "Kör Noktalar" feed. The fetch/filter/tally logic
// lives in blindspots-query.ts (see that file for the BLINDSPOT contract,
// dedupe, and quality-filter rationale) so it can be unit-tested and reused
// (e.g. by the weekly digest cron) without rendering JSX.
//
// reader-queries D2: the page's static shell (container, PageHero, the RSS
// link) now renders synchronously so it's part of the prerendered shell;
// the data-dependent part streams in behind its own <Suspense> boundary as
// `BlindspotsFeed`, which never lets a Supabase failure reach the error
// boundary — `getBlindspotsSafe()` degrades to a retry affordance instead.
export default function BlindspotsPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-5">
      <PageHero
        kicker="Sadece bir tarafın gördüğü"
        title="Kör Noktalar"
        subtitle="Bir tarafın haberi verdiği, diğerlerinin görmezden geldiği hikâyeler. Diğer kaynaklar neden susuyor?"
      />

      <p className="text-xs text-muted-foreground">
        <Link
          href="/rss/kor-noktalar.xml"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          RSS
        </Link>
      </p>

      <Suspense fallback={<BlindspotsSkeleton />}>
        <BlindspotsFeed />
      </Suspense>
    </div>
  );
}

function BlindspotsSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl ring-1 ring-border/60 bg-card/60 p-5 flex gap-4 animate-pulse"
        >
          <div className="h-28 w-40 rounded-lg bg-muted/50 shrink-0" />
          <div className="flex-1 space-y-3">
            <div className="h-5 w-3/4 rounded bg-muted/70" />
            <div className="h-3 w-1/2 rounded bg-muted/40" />
            <div className="h-2 w-full rounded-full bg-muted/40" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Exported (in addition to the default page export) so tests can render
// the data-dependent body directly without needing a full Suspense-aware
// renderer — see page.test.tsx.
export async function BlindspotsFeed() {
  // connection() signals to PPR that the code below must run at request
  // time (Date.now() is non-deterministic). The static shell (page.tsx
  // above) already streamed; this boundary's own loading.tsx-style
  // fallback covers the wait.
  await connection();

  // PERF-01: fetched in parallel, not two serial awaits — neither depends
  // on the other. DenominatorNote wants one directory-wide, voting-kind
  // N/M pair, not a per-zone breakdown (a blindspot bundle can span either
  // pole), so this reads the cheap `getFeedStatusSummary()` existence-probe
  // from src/lib/sources/feed-status.ts rather than A1's
  // `getZoneFeedHealth()`/`zoneYieldDenominator`.
  const [result, feedSummary] = await Promise.all([
    getBlindspotsSafe(),
    getFeedStatusSummary(),
  ]);

  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  return (
    <>
      <DenominatorNote
        delivering={feedSummary?.delivering ?? null}
        total={feedSummary?.total ?? null}
      />

      {!result.ok ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border/60 bg-card/40 px-6 py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
            <EyeOff className="h-7 w-7" aria-hidden="true" />
          </div>
          <p className="font-serif text-sm font-medium text-foreground">
            Kör noktalar şu an yüklenemedi, birkaç dakika içinde tekrar
            deneyin.
          </p>
          <RetryButton />
        </div>
      ) : result.bundles.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Şu an için belirgin bir kör nokta yok. Her taraftan haberler dengeli
            dağılmış.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {result.bundles.map((b, i) => {
            const hoursAgo =
              (nowMs - new Date(b.cluster.updated_at).getTime()) / 3_600_000;
            const prevZone =
              i > 0 ? result.bundles[i - 1]?.dominantZone ?? null : null;
            const showDivider = i > 0 && b.dominantZone !== prevZone;
            return (
              <div key={b.cluster.id}>
                {showDivider && (
                  <div className="h-px bg-gradient-to-r from-transparent via-border/30 to-transparent my-6" />
                )}
                <div className={`animate-fade-up stagger-${i < 6 ? i + 1 : 6}`}>
                  <BlindspotCard
                    bundle={b}
                    index={i}
                    isAging={hoursAgo > 48}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isMailConfigured() && (
        <div className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-5 max-w-sm">
          <NewsletterForm />
        </div>
      )}
    </>
  );
}

interface BlindspotCardProps {
  bundle: BlindspotBundle;
  index: number;
  isAging?: boolean;
}

// Composes the existing <ClusterCard> with a "Sadece X yazdı" ribbon and a
// dominant-zone tint frame. We deliberately do NOT duplicate ClusterCard's
// markup — the ribbon sits above and the tint is a parent ring + bg layer
// so any future ClusterCard tweak (e.g. layout, image rules) is inherited
// for free.
function BlindspotCard({ bundle, index, isAging }: BlindspotCardProps) {
  const meta = ZONE_META[bundle.dominantZone];
  const pct = Math.round(bundle.dominantPct * 100);
  const pctLabel = `%${pct}`;
  const chipLabel = pct < 100 ? `${pctLabel} ${meta.label}` : `Sadece ${meta.label} yazdı`;

  return (
    <div
      className={`rounded-xl border ${meta.zoneBorder} ${meta.zoneBg} p-2 sm:p-3 space-y-2`}
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full ${meta.chipBg} ${meta.chipBorder} border px-2.5 py-1 text-[11px] font-serif font-semibold ${meta.chipText}`}
          >
            <Eye className="h-3 w-3" aria-hidden="true" />
            {chipLabel}
          </span>
          {pct === 100 && (
            <span className="text-[11px] text-muted-foreground">
              <span className="font-mono">{pctLabel}</span> tek tarafta
            </span>
          )}
        </div>
      </div>

      <ClusterCard
        cluster={bundle.cluster}
        articles={bundle.articles}
        sources={bundle.sources}
        index={index}
        isAging={isAging}
        isWireRedistribution={bundle.isWireRedistribution}
        effectiveArticleCount={bundle.effectiveArticleCount}
      />
    </div>
  );
}
