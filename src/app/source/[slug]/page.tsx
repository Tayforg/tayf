import type { Metadata } from "next";
import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { BiasBadge } from "@/components/story/bias-badge";
import { BIAS_LABELS } from "@/lib/bias/config";
import { firstPartyLogoUrl } from "@/lib/images/image-url";
import { formatTurkishTimeAgo } from "@/lib/time";
import { articleExcerptEligible, articleImageEligible } from "@/lib/sources/rights";
import { LabelCard } from "@/components/source/label-card";
import { ClickbaitKarneLine } from "@/components/source/clickbait-karne";
import { SourceKarneCard } from "@/components/source/source-karne";
import { getSourceKarne } from "@/lib/sources/karne";
import { getSourceProfile } from "@/lib/sources/source-profile-query";
import { getSourceAgreement } from "@/lib/game/agreement";
import { buildBreadcrumbs, serializeJsonLd } from "@/lib/seo/json-ld";
import {
  CLICKBAIT_PRECISION_CHECK,
  getClickbaitKarne,
  isClickbaitPublic,
} from "@/lib/sources/clickbait";

// /source/[slug] — single-source profile page.
//
// Server Component. Loads a source by slug, its 7-day article count, and the
// 20 most recent articles. Used for SEO landing pages and as the destination
// for source-chip clicks elsewhere in the UI.
//
// Per Next.js 16 conventions:
//   - `params` is a Promise<{ slug }> and must be awaited
//   - dynamic SEO must come from an exported `generateMetadata` (not the
//     static `metadata` object — it can't see params)
//
// The data layer lives in src/lib/sources/source-profile-query.ts: a cached,
// never-throwing read under the 4 s reader cap. `getSourceProfile` returns
// null ONLY for "no such source"; a sustained read failure throws, so a cold
// database renders the root error boundary (noindex, "Tekrar dene") and
// never a 404 for a real source.

interface PageProps {
  // Next.js 16: dynamic-route `params` is a Promise.
  params: Promise<{ slug: string }>;
}

// Dynamic SEO metadata. Per Next.js 16, dynamic-route metadata must be
// produced by an exported async `generateMetadata` (the static `metadata`
// object can't access `params`). The fetch goes through the same
// `getSourceProfile` the page uses (React `cache` dedupes it within the
// request), so it's effectively free.
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  let profile: Awaited<ReturnType<typeof getSourceProfile>>;
  try {
    profile = await getSourceProfile(slug);
  } catch (err) {
    // Next control-flow signals (dynamic-usage bailouts, postpone) must keep
    // propagating; only a genuine read failure is handled below.
    unstable_rethrow(err);
    // A sustained read failure (cold database). The page body re-throws the
    // same (request-memoised) error and the error boundary renders; the
    // metadata must not claim the source is missing, must not be indexed, and
    // must not advertise the homepage canonical.
    return {
      title: "Kaynak şu anda yüklenemiyor",
      robots: { index: false, follow: true },
      alternates: { canonical: null },
    };
  }

  if (!profile) {
    // A4: a missing source still streams a 200 shell here (notFound() runs
    // later in the page body, after PPR has flushed), so this soft-404
    // must carry honest metadata: no homepage canonical, no index,follow.
    return {
      title: "Kaynak bulunamadı",
      robots: { index: false, follow: true },
      alternates: { canonical: null },
    };
  }

  const { source, articleCount7d } = profile;
  const biasLabel = BIAS_LABELS[source.bias];
  const description = `${source.name} (${biasLabel}) — son 7 günde ${articleCount7d} haber. Tayf üzerinden bu Türk haber kaynağının son haberlerini ve siyasi duruşunu görün.`;

  return {
    // Plain title — root layout's `title.template = "%s — Tayf"` adds suffix.
    title: source.name,
    description,
    // seo-9: no own `images` key on openGraph/twitter — the logo_url used to
    // be pointed at here is typically a 64px Google favicon (s2/favicons),
    // a low-res, blurry, un-branded social card. Omitting `images` entirely
    // (not even `[]`) lets Next's file-convention opengraph-image.tsx /
    // twitter-image.tsx (both re-exporting the root's generated 1200x630
    // Tayf card) wire in automatically instead.
    openGraph: {
      title: source.name,
      description,
      type: "profile",
      url: `/source/${source.slug}`,
      locale: "tr_TR",
      siteName: "Tayf",
    },
    twitter: {
      card: "summary_large_image",
      title: source.name,
      description,
    },
    alternates: {
      canonical: `/source/${source.slug}`,
    },
  };
}

export default async function SourceProfilePage({ params }: PageProps) {
  const { slug } = await params;

  // null = no such source -> 404. A sustained read failure THROWS and
  // propagates to the root error boundary (never a 404 for a real source).
  const profile = await getSourceProfile(slug);
  if (!profile) notFound();

  const { source, articleCount7d, articles, zoneHistory } = profile;

  // The three side lookups are independent - one round-trip, not three
  // sequential ones (each is capped at 4 s, so serial reads could stack).
  //   - reader agreement (U-03 follow-through): cached separately from the
  //     profile (its own "use cache" entry keyed by source id) so a busy /oyun
  //     ledger never slows the profile down; never throws, `null` renders the
  //     label card's "Henüz yeterli tahmin yok".
  //   - "Kapsama karnesi" (migration 096): one cached point lookup; null (no
  //     row or outage) renders nothing.
  //   - "tık tuzağı karnesi" (migration 078): same gate as /sources.
  const [readerAgreement, sourceKarne, karne] = await Promise.all([
    getSourceAgreement(source.id),
    getSourceKarne(source.id),
    isClickbaitPublic() ? getClickbaitKarne() : Promise.resolve(null),
  ]);

  // S-17: BreadcrumbList JSON-LD (Anasayfa → Kaynaklar → this source).
  const breadcrumbs = buildBreadcrumbs([
    { name: "Anasayfa", path: "/" },
    { name: "Kaynaklar", path: "/sources" },
    { name: source.name, path: `/source/${source.slug}` },
  ]);

  return (
    <>
      {/* Same script-injection-safety rationale as cluster/[id]/page.tsx's
          NewsArticle block: `serializeJsonLd` escapes every "<" so a
          hostile source name can never terminate the script element
          early. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(breadcrumbs) }}
      />
      <div className="container mx-auto px-4 py-8 max-w-4xl space-y-8">
      {/* Back nav — keeps the user grounded inside Tayf when they arrived
          via a source chip on a cluster or via /sources. */}
      <nav>
        <Link
          href="/sources"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Tüm kaynaklar
        </Link>
      </nav>

      {/* Header card: logo, name, bias, 7-day count, and an outbound link to
          the publisher's homepage. Mirrors the visual rhythm of the cluster
          detail hero so the two profile-style pages feel related. */}
      <header className="rounded-xl border border-border/60 bg-card/40 p-5 sm:p-6">
        <div className="flex items-start gap-4 sm:gap-5">
          {source.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={firstPartyLogoUrl(source.logo_url, 128) ?? source.logo_url}
              alt=""
              className="h-16 w-16 sm:h-20 sm:w-20 rounded-lg shrink-0 object-contain bg-background ring-1 ring-brand/20"
              loading="eager"
            />
          ) : (
            <div className="h-16 w-16 sm:h-20 sm:w-20 rounded-lg shrink-0 bg-muted/60 ring-1 ring-brand/20" />
          )}

          <div className="min-w-0 flex-1 space-y-2">
            <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight leading-tight truncate">
              {source.name}
            </h1>
            <div className="flex flex-wrap items-center gap-3">
              <BiasBadge bias={source.bias} />
              <span className="font-mono text-[11px] text-brand">
                son 7 günde {articleCount7d} haber
              </span>
            </div>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors brand-underline"
            >
              {new URL(source.url).hostname.replace(/^www\./, "")}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </header>

      {/* Etiket kartı (S-20/M-04) — zone/bias reconciliation, rationale,
          ownership, trustee status, zone-change history and dispute link.
          Sits between the header and the recent-articles list so it reads
          as the source's evidence dossier before its output. */}
      <LabelCard
        slug={source.slug}
        bias={source.bias}
        zoneRationale={source.zone_rationale}
        zoneRationaleAt={source.zone_rationale_at}
        trusteeSince={source.trustee_since}
        trusteeNote={source.trustee_note}
        history={zoneHistory}
        readerAgreement={readerAgreement}
      />

      <SourceKarneCard karne={sourceKarne} slug={source.slug} />

      {karne ? (
        <ClickbaitKarneLine karne={karne} slug={source.slug} check={CLICKBAIT_PRECISION_CHECK} />
      ) : null}

      {/* Recent articles list. Capped at 20 by the data layer; the empty
          state covers brand-new sources or temporarily inactive feeds. */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-serif text-lg font-semibold tracking-tight">
            Son haberler
          </h2>
          <span className="text-[11px] text-muted-foreground">
            {articles.length} haber
          </span>
        </div>

        {articles.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 bg-card/40 p-6 text-center text-sm text-muted-foreground">
            Bu kaynaktan henüz haber görmedik.
          </p>
        ) : (
          <ul className="space-y-2">
            {articles.map((article, i) => (
              <li
                key={article.id}
                className={`animate-fade-up stagger-${Math.min(i + 1, 8)} rounded-lg ring-1 ring-border/60 hover:ring-border bg-card/60 hover:bg-card/80 transition-all hover-lift`}
              >
                <a
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-3 p-3 sm:p-4"
                >
                  {articleImageEligible(article, source) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={article.image_url}
                      alt=""
                      className="h-16 w-16 sm:h-20 sm:w-20 rounded shrink-0 object-cover bg-muted"
                      loading="lazy"
                    />
                  ) : (
                    <div className="h-16 w-16 sm:h-20 sm:w-20 rounded shrink-0 bg-muted/60" />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-semibold leading-snug line-clamp-2 group-hover:text-foreground">
                      {article.title}
                    </p>
                    {articleExcerptEligible(article, source) ? (
                      <p className="text-xs text-muted-foreground leading-snug line-clamp-2">
                        {article.description}
                      </p>
                    ) : null}
                    <p className="font-mono text-[10px] text-muted-foreground/70">
                      {formatTurkishTimeAgo(article.published_at)}
                    </p>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      </div>
    </>
  );
}
