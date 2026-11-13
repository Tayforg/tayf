import type { Metadata } from "next";
import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { BiasBadge } from "@/components/story/bias-badge";
import { SourceLogo } from "@/components/source/source-logo";
import { formatTurkishTimeAgo } from "@/lib/time";
import { formatCountTr } from "@/lib/format/number-tr";
import { formatDdMmYyyy } from "@/lib/format/date-tr";
import { sourceExcerpt } from "@/lib/articles/source-excerpt";
import { articleExcerptEligible, articleImageEligible } from "@/lib/sources/rights";
import { sourceLang } from "@/lib/sources/source-language";
import { optimizedThumbSrcSet } from "@/lib/images/image-url";
import { LabelCard } from "@/components/source/label-card";
import { ClickbaitKarneLine } from "@/components/source/clickbait-karne";
import { SourceKarneCard } from "@/components/source/source-karne";
import { SourceReliabilityCard } from "@/components/source/source-reliability";
import { getSourceKarne } from "@/lib/sources/karne";
import { getSourceReliability } from "@/lib/sources/reliability";
import { getSourceProfile } from "@/lib/sources/source-profile-query";
import { getSourceAgreement } from "@/lib/game/agreement";
import { buildBreadcrumbs, serializeJsonLd } from "@/lib/seo/json-ld";
import { isThinSource } from "@/lib/seo/thin-source";
import { NewTabHint } from "@/components/ui/new-tab-hint";
import { sourceMetaDescription } from "@/lib/sources/source-meta-description";
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

// The /kaynaklar/durum link of the two feed-state lines (feedDown, feedFrozen).
// One literal string, so Tailwind sees every class.
const STATUS_LINK_CLASS =
  "font-medium text-rose-800 dark:text-rose-300 underline decoration-dotted underline-offset-2 hover:decoration-solid";

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
  // A source with no article in the last 7 days is thin: the page says nothing
  // a searcher wants, so it is `noindex, follow` and drops the "0 haber" count
  // from the snippet. sources.xml skips the same slugs (src/lib/seo/thin-source.ts).
  const thin = isThinSource(articleCount7d);
  // An aggregator / niche source does not vote, so its snippet names the kind
  // instead of a political stance (source-meta-description.ts).
  const description = sourceMetaDescription(source, articleCount7d);

  return {
    // Plain title — root layout's `title.template = "%s — Tayf"` adds suffix.
    title: source.name,
    description,
    ...(thin ? { robots: { index: false, follow: true } } : {}),
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

  const {
    source,
    articleCount7d,
    articles,
    zoneHistory,
    historyUnavailable,
    quarantined,
    feedFrozen: feedFrozenVerdict,
    newestFeedItemAt,
    windowOverflowRecent,
  } = profile;

  // h47-sources-1: a profile used to look the same whether the source is still
  // monitored or not. `active` is the registry flag; `quarantined` is the feed
  // verdict stamped when the profile was read (no clock here). An inactive
  // source shows only the inactive line: a quarantine left over from before it
  // was switched off says nothing true any more. The "articles below" clause of
  // that line appears only when there are articles (most inactive sources never
  // delivered one, and the empty list below says so itself). `=== false`, so a
  // row that somehow lacks the column never reads as inactive.
  const inactive = source.active === false;
  const feedDown = !inactive && quarantined;
  // h74-sourcepages-3: the third state. The feed answers but is frozen (the
  // `classifySilence` verdict the data layer stamped, the same rule
  // /kaynaklar/durum labels 'akış donmuş' with). Inactive and feedDown win, so
  // a profile shows exactly one status line. The date is the newest item the
  // feed itself reports; none (an empty feed, or a date that does not parse)
  // reads as "içinde haber yok".
  const feedFrozen = !inactive && !feedDown && feedFrozenVerdict;
  const frozenNewest = newestFeedItemAt ? formatDdMmYyyy(newestFeedItemAt) : "";

  // The four side lookups are independent - one round-trip, not four
  // sequential ones (each is capped at 4 s, so serial reads could stack).
  //   - reader agreement (U-03 follow-through): cached separately from the
  //     profile (its own "use cache" entry keyed by source id) so a busy /oyun
  //     ledger never slows the profile down; never throws, `null` renders the
  //     label card's "Henüz yeterli tahmin yok".
  //   - "Kapsama karnesi" (migration 096): one cached point lookup; null (no
  //     row or outage) renders nothing.
  //   - "Kaynak göstergeleri" (migration 111): same shape, its own table; null
  //     renders nothing. Its blindspot row reuses the karne above.
  //   - "tık tuzağı karnesi" (migration 078): same gate as /sources.
  const [readerAgreement, sourceKarne, sourceReliability, karne] =
    await Promise.all([
      getSourceAgreement(source.id),
      getSourceKarne(source.id),
      getSourceReliability(source.id),
      isClickbaitPublic() ? getClickbaitKarne() : Promise.resolve(null),
    ]);

  // WCAG 3.1.2: the English outlets' headlines and excerpts are marked
  // lang="en" so a screen reader does not read them with Turkish phonetics;
  // undefined (every other source) renders no attribute and inherits "tr".
  const articleLang = sourceLang({ slug: source.slug, name: source.name });

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
      {/* Back link — keeps the user grounded inside Tayf when they arrived
          via a source chip on a cluster or via /sources. A plain div, not a
          navigation landmark: one back link is not a navigation region, and
          an unnamed landmark would sit next to the named "Ana menü" and
          "Alt menü". */}
      <div>
        {/* No prefetch: /sources is a 362 KB-decoded static payload that most
            search-entry readers never open. The click is still a soft navigation:
            this stays next/link, not a plain <a>, so it does not re-download the
            125 KB inline stylesheet (h166-perf-2). */}
        <Link
          href="/sources"
          prefetch={false}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Tüm kaynaklar
        </Link>
      </div>

      {/* Header card: logo, name, bias, 7-day count, and an outbound link to
          the publisher's homepage. Mirrors the visual rhythm of the cluster
          detail hero so the two profile-style pages feel related. */}
      <header className="rounded-xl border border-border/60 bg-card/40 p-5 sm:p-6">
        <div className="flex items-start gap-4 sm:gap-5">
          <SourceLogo
            logoUrl={source.logo_url}
            name={source.name}
            width={128}
            loading="eager"
            className="h-16 w-16 sm:h-20 sm:w-20 rounded-lg shrink-0 object-contain bg-background ring-1 ring-brand/20"
            fallback="square"
            fallbackClassName="h-16 w-16 sm:h-20 sm:w-20 rounded-lg shrink-0 bg-muted/60 ring-1 ring-brand/20 text-2xl sm:text-3xl"
          />

          <div className="min-w-0 flex-1 space-y-2">
            <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight leading-tight text-balance break-words">
              {source.name}
            </h1>
            <div className="flex flex-wrap items-center gap-3">
              <BiasBadge bias={source.bias} />
              <span className="font-mono text-[11px] text-brand">
                son 7 günde {formatCountTr(articleCount7d)} haber
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
              <NewTabHint />
            </a>
            {inactive ? (
              <p className="text-xs text-muted-foreground">
                {articles.length > 0
                  ? "Bu kaynak artık izlenmiyor; aşağıdaki haberler izleme durdurulmadan önce toplandı."
                  : "Bu kaynak artık izlenmiyor."}
              </p>
            ) : feedDown ? (
              <p className="text-xs text-muted-foreground">
                <Link href="/kaynaklar/durum" className={STATUS_LINK_CLASS}>
                  Akış şu anda alınamıyor
                </Link>
                {" "}
                — Tayf bu beslemeyi art arda çekemedi, bu yüzden geçici olarak atlıyor.
              </p>
            ) : feedFrozen ? (
              <p className="text-xs text-muted-foreground">
                <Link href="/kaynaklar/durum" className={STATUS_LINK_CLASS}>
                  Akış donmuş
                </Link>
                {" "}
                {frozenNewest
                  ? `— besleme yanıt veriyor ama yeni haber gelmiyor (beslemedeki en yeni öğe: ${frozenNewest}).`
                  : "— besleme yanıt veriyor ama içinde haber yok."}
              </p>
            ) : null}
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
        historyUnavailable={historyUnavailable === true}
        readerAgreement={readerAgreement}
        kind={source.kind}
      />

      <SourceKarneCard karne={sourceKarne} slug={source.slug} kind={source.kind} />

      {/* Migration 212: the feed window overflowed in the last 7 days (decided by
          the profile read, no clock here), so the daily rate is a floor. */}
      <SourceReliabilityCard
        reliability={sourceReliability}
        karne={sourceKarne}
        slug={source.slug}
        windowOverflowRecent={windowOverflowRecent === true}
      />

      {karne ? (
        <ClickbaitKarneLine karne={karne} slug={source.slug} check={CLICKBAIT_PRECISION_CHECK} />
      ) : null}

      {/* Recent articles list. Capped at 20 by the data layer; the empty
          state covers brand-new sources, a feed in quarantine and (with its
          own wording) a source that is no longer monitored. */}
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
            {inactive
              ? "Bu kaynaktan haber alınmıyor."
              : "Bu kaynaktan henüz haber görmedik."}
          </p>
        ) : (
          <ul className="space-y-2">
            {articles.map((article, i) => {
              // The thumbnail is served by our own /_next/image at the slot
              // size (80 px slot: 128/160/256 w), never as the publisher's
              // full-size original. optimizedThumbSrcSet also heals stored
              // spellings (doubled slash, protocol-relative, posta's glued
              // ObjectIds); null (unusable, gif or a logo/'son dakika'
              // placeholder) falls back to the neutral block instead of a
              // broken image. A plain img, not next/image: this is a server
              // component and the image is decorative (the title is the link
              // text), so it avoids 20 client boundaries.
              const thumb = articleImageEligible(article, source)
                ? optimizedThumbSrcSet(article.image_url)
                : null;
              // The excerpt line (h48-ingest-1, h52-sources-1). sourceExcerpt
              // runs the same read-time tidy as a cluster summary: the leading
              // style sheet of Elips Haber's notices, then the feed residue
              // ("Devamı için tıklayınız" on Sabah / A Haber / Yeni Asır, the
              // "<headline> dd.mm.yyyy Diken" lead and "The post ... appeared
              // first on" footer, Medyascope's echoed headline + site name,
              // Serbestiyet's "yazısı ilk önce" footer, glued sentences). What
              // is left is shown only when it is a summary: not empty, not an
              // RSS call-to-action or "Ayrıntılar geliyor..." stub, not
              // punctuation, and not the card's own headline again (Korkusuz
              // ships the title as the description, CNN Türk half of the
              // time); sourceExcerpt returns "" for all of those. Read-time
              // only; the stored description is untouched.
              const excerpt = articleExcerptEligible(article, source)
                ? sourceExcerpt(article.title, article.description)
                : "";
              const showExcerpt = excerpt !== "";
              return (
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
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumb.src}
                        srcSet={thumb.srcSet}
                        sizes="(min-width: 640px) 80px, 64px"
                        width={80}
                        height={80}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-16 w-16 sm:h-20 sm:w-20 rounded shrink-0 object-cover bg-muted"
                      />
                    ) : (
                      <div className="h-16 w-16 sm:h-20 sm:w-20 rounded shrink-0 bg-muted/60" />
                    )}
                    <div className="min-w-0 flex-1 space-y-1">
                      <p
                        lang={articleLang}
                        className="text-sm font-semibold leading-snug line-clamp-2 group-hover:text-foreground"
                      >
                        {article.title}
                      </p>
                      {/* RSS call-to-action stubs ("Click to continue",
                          "Devamını oku", "Ayrıntılar geliyor..."), a
                          description that is only the title, and a leaked
                          style sheet are not summaries: hide them. */}
                      {showExcerpt ? (
                        <p
                          lang={articleLang}
                          className="text-xs text-muted-foreground leading-snug line-clamp-2"
                        >
                          {excerpt}
                        </p>
                      ) : null}
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {formatTurkishTimeAgo(article.published_at)}
                      </p>
                    </div>
                    <NewTabHint />
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      </div>
    </>
  );
}
