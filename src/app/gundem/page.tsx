import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";

import { PageHero } from "@/components/ui/page-hero";
import { ENTITY_HUB_WINDOW_DAYS } from "@/lib/entities/entity-hub";
import { formatCountTr } from "@/lib/format/number-tr";
import {
  buildBreadcrumbs,
  buildClusterCollectionPage,
  serializeJsonLd,
} from "@/lib/seo/json-ld";
import { readAllEntityHubs } from "@/lib/seo/hub-sitemap";
import { staticPageMetadata } from "@/lib/seo/page-metadata";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";

// /gundem — index of the entity hubs (/gundem/[key]).
//
// h43-entities-3. The index used to link all 62 hubs from the static
// vocabulary, but 8 of them were noindex and 4 were empty ("Son 14 günde bu
// konuda küme yok."), so a reader (and a crawler) was sent to dead ends. It now
// reads every hub through readAllEntityHubs (the 62 per-key cache entries the
// hubs share with /gundem/[key] and the hubs sitemap, so a warm page costs no
// extra query):
//   * a hub with at least one cluster stays a link and shows the count
//     ("DEVA · 17 küme"); a thin hub (1-2 clusters, noindex) is still worth
//     opening, it just is not in the sitemap;
//   * a hub with none is plain text ("Hamas · son 14 günde küme yok"), no link.
//     The hub counts only multi-source live clusters (entity_cluster_ids_v3, or v2 as its fallback:
//     not archived, not merged, article_count >= 2, updated in the window), so
//     "küme" is the honest unit; "haber yok" would deny the single-source
//     stories that may exist. (Deliberately not the literal "haber yok" copy of
//     the h43-entities-3 spec.)
//   * if ANY read failed (null, or a rejection) the whole page falls back to
//     today's static list of 62 plain links, so a reader outage can never
//     hide a hub that has news. "Failed" is never read as "empty".
// The reads happen at page level, outside any "use cache" function
// (tests/guards/cache-retry-prerender.test.ts): getEntityHub's live retry awaits
// connection(), which fails `next build` inside a cache body.
//
// The CollectionPage JSON-LD lists the hubs the page links (all 62 on the
// fail-open list), so the structured data never names a page the visible list
// does not offer. The index itself is always indexable.

// staticPageMetadata also sets its own og:* / twitter:* url, title and image.
export const metadata: Metadata = staticPageMetadata({
  title: "Gündem",
  description:
    "Kişi, parti, kurum ve ülkelere göre son 14 günün haber kümeleri.",
  path: "/gundem",
});

// Literal class string (Tailwind 4 has no runtime scanner). min-h-8 keeps each
// chip's target at 32 px, above the 24 px floor of WCAG 2.5.8.
const chipClass =
  "inline-flex min-h-8 items-center rounded-full border border-border/60 bg-card/60 px-3 py-1 text-sm font-medium text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
// A hub with no cluster: not interactive, so no hover/focus styles; the full
// muted-foreground token keeps the text above the WCAG 1.4.3 contrast floor
// (tests/guards/text-contrast-tokens.test.ts forbids alpha text tokens).
const emptyChipClass =
  "inline-flex min-h-8 items-center rounded-full border border-dashed border-border/60 px-3 py-1 text-sm text-muted-foreground";

/**
 * Cluster total per hub key, or null when any hub could not be read (the page
 * then renders its static list). A key the reader never got to (it stops after
 * the first batch holding a failure) counts as failed too.
 */
async function readHubTotals(): Promise<ReadonlyMap<string, number> | null> {
  let hubs: Awaited<ReturnType<typeof readAllEntityHubs>>;
  try {
    hubs = await readAllEntityHubs();
  } catch (err) {
    // Fail open on a data error, but never swallow Next's own control flow
    // (a prerender postponement, for one).
    unstable_rethrow(err);
    return null;
  }

  const totals = new Map<string, number>();
  for (const entity of RISING_ENTITIES) {
    const hub = hubs.get(entity.key);
    if (hub === undefined || hub === null) return null;
    totals.set(entity.key, hub.total);
  }
  return totals;
}

export default async function GundemIndexPage() {
  const totals = await readHubTotals();
  // With totals: only hubs that have news. Without (a failed read): all of them.
  const linked = RISING_ENTITIES.filter(
    (e) => totals === null || (totals.get(e.key) ?? 0) >= 1,
  );

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd([
            buildClusterCollectionPage({
              name: "Gündemdeki adlar",
              path: "/gundem",
              items: linked.map((e) => ({
                name: e.label,
                path: `/gundem/${e.key}`,
              })),
            }),
            buildBreadcrumbs([
              { name: "Anasayfa", path: "/" },
              { name: "Gündem", path: "/gundem" },
            ]),
          ]),
        }}
      />

      <PageHero
        kicker="Gündem"
        title="Gündemdeki adlar"
        subtitle="Kişi, parti, kurum ve ülkelere göre son 14 günün haberleri."
      />

      <ul className="flex flex-wrap gap-2">
        {RISING_ENTITIES.map((e) => {
          const total = totals?.get(e.key);
          if (total !== undefined && !(total >= 1)) {
            return (
              <li key={e.key}>
                <span className={emptyChipClass}>
                  {`${e.label} · son ${ENTITY_HUB_WINDOW_DAYS} günde küme yok`}
                </span>
              </li>
            );
          }
          return (
            <li key={e.key}>
              {/* prefetch off: the page links up to 62 hubs, and each prefetch
                  would be an RSC payload for a DB-backed route nobody may open. */}
              <Link prefetch={false} href={`/gundem/${e.key}`} className={chipClass}>
                {total === undefined ? e.label : `${e.label} · ${formatCountTr(total)} küme`}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
