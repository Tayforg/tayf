import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cacheLife, cacheTag } from "next/cache";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { BiasBadge } from "@/components/story/bias-badge";
import { BIAS_LABELS } from "@/lib/bias/config";
import { formatTurkishTimeAgo } from "@/lib/time";
import { createServerClient } from "@/lib/supabase/server";
import type { Source } from "@/types";

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
// Data layer is wrapped in `unstable_cache` so warm hits skip the round-trip
// to Supabase. Cache TTL matches the route segment `revalidate` so the SSR
// shell and the data evict together.

interface PageProps {
  // Next.js 16: dynamic-route `params` is a Promise.
  params: Promise<{ slug: string }>;
}

interface ArticleRow {
  id: string;
  title: string;
  description: string | null;
  url: string;
  image_url: string | null;
  published_at: string;
}

interface SourceProfile {
  source: Source;
  articleCount7d: number;
  articles: ArticleRow[];
}

async function getSourceProfile(slug: string): Promise<SourceProfile | null> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("sources", "articles");

  const supabase = createServerClient();

    const { data: sourceRow, error: sourceError } = await supabase
      .from("sources")
      .select("id, name, slug, url, rss_url, bias, logo_url, active, image_allowed, excerpt_allowed")
      .eq("slug", slug)
      .maybeSingle();

    // `maybeSingle` returns null (not an error) when no row matches; only a
    // genuine query failure should throw. notFound() is handled by the page.
    if (sourceError) {
      throw new Error(`source query failed: ${sourceError.message}`);
    }
    if (!sourceRow) return null;

    const source = sourceRow as Source;

    // Two read-only fetches that depend only on source.id — fire in parallel.
    // The 7-day count uses head/exact to avoid pulling row bodies; the
    // recent-articles list is capped at 20 to keep the payload small.
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const [countResult, articlesResult] = await Promise.all([
      supabase
        .from("articles")
        .select("id", { count: "exact", head: true })
        .eq("source_id", source.id)
        .gte("published_at", sevenDaysAgo),
      supabase
        .from("articles")
        .select("id, title, description, url, image_url, published_at")
        .eq("source_id", source.id)
        .order("published_at", { ascending: false })
        .limit(20),
    ]);

    if (countResult.error) {
      throw new Error(`count query failed: ${countResult.error.message}`);
    }
    if (articlesResult.error) {
      throw new Error(
        `articles query failed: ${articlesResult.error.message}`,
      );
    }

  return {
    source,
    articleCount7d: countResult.count ?? 0,
    articles: (articlesResult.data ?? []) as ArticleRow[],
  };
}

// Dynamic SEO metadata. Per Next.js 16, dynamic-route metadata must be
// produced by an exported async `generateMetadata` (the static `metadata`
// object can't access `params`). The fetch goes through the same cached
// `getSourceProfile` the page uses, so it's effectively free on warm hits.
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const profile = await getSourceProfile(slug);

  if (!profile) {
    // The root layout's `title.template` is `%s — Tayf`, so we return just
    // the page-specific part here and let the template add the suffix.
    return { title: "Kaynak bulunamadı" };
  }

  const { source, articleCount7d } = profile;
  const biasLabel = BIAS_LABELS[source.bias];
  const description = `${source.name} (${biasLabel}) — son 7 günde ${articleCount7d} haber. Tayf üzerinden bu Türk haber kaynağının son haberlerini ve siyasi duruşunu görün.`;

  return {
    // Plain title — root layout's `title.template = "%s — Tayf"` adds suffix.
    title: source.name,
    description,
    openGraph: {
      title: source.name,
      description,
      type: "profile",
      url: `/source/${source.slug}`,
      images: source.logo_url ? [{ url: source.logo_url }] : [],
      locale: "tr_TR",
      siteName: "Tayf",
    },
    twitter: {
      card: "summary",
      title: source.name,
      description,
      images: source.logo_url ? [source.logo_url] : [],
    },
    alternates: {
      canonical: `/source/${source.slug}`,
    },
  };
}

export default async function SourceProfilePage({ params }: PageProps) {
  const { slug } = await params;

  const profile = await getSourceProfile(slug);
  if (!profile) notFound();

  const { source, articleCount7d, articles } = profile;

  return (
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
              src={source.logo_url}
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
                  {article.image_url && source.image_allowed !== false ? (
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
                    {source.excerpt_allowed !== false && article.description ? (
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
  );
}
