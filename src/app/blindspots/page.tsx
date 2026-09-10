import type { Metadata } from "next";
import { connection } from "next/server";
import { Eye } from "lucide-react";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
export const metadata: Metadata = {
  title: "Kör Noktalar",
  description:
    "Bir tarafın haberi verdiği, diğerlerinin görmezden geldiği hikâyeler. Türk medyasındaki kör noktaları tek ekranda görün.",
  alternates: { canonical: "/blindspots" },
};

import { ClusterCard } from "@/components/story/cluster-card";
import { NewsletterForm } from "@/components/newsletter/newsletter-form";
import { PageHero } from "@/components/ui/page-hero";
import { isMailConfigured } from "@/lib/email/resend";
import { ZONE_META } from "@/lib/bias/config";
import {
  getBlindspots,
  type BlindspotBundle,
} from "@/lib/clusters/blindspots-query";

// /blindspots — Tayf's "Kör Noktalar" feed. The fetch/filter/tally logic
// lives in blindspots-query.ts (see that file for the BLINDSPOT contract,
// dedupe, and quality-filter rationale) so it can be unit-tested and reused
// (e.g. by the weekly digest cron) without rendering JSX.
export default async function BlindspotsPage() {
  // connection() signals to PPR that the code below must run at request
  // time (Date.now() is non-deterministic). The loading.tsx Suspense
  // boundary provides the static shell while this streams in.
  await connection();

  const { bundles } = await getBlindspots();

  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-5">
      <PageHero
        kicker="Sadece bir tarafın gördüğü"
        title="Kör Noktalar"
        subtitle="Bir tarafın haberi verdiği, diğerlerinin görmezden geldiği hikâyeler. Diğer kaynaklar neden susuyor?"
      />

      {bundles.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Şu an için belirgin bir kör nokta yok. Her taraftan haberler dengeli
            dağılmış.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {bundles.map((b, i) => {
            const hoursAgo =
              (nowMs - new Date(b.cluster.updated_at).getTime()) / 3_600_000;
            const prevZone = i > 0 ? bundles[i - 1]?.dominantZone ?? null : null;
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
    </div>
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
