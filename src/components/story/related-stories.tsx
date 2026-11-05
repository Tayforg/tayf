import Link from "next/link";

import {
  relatedModeOf,
  type RelatedCluster,
  type RelatedMode,
} from "@/lib/clusters/related-clusters";

/** The label of the genel feed (TOPIC_LABELS_TR.genel, pinned by related-stories.test.tsx). */
const GENEL_LABEL = "Genel";

/**
 * The heading of a 'latest' list: "<Konu> gündeminde son haberler" ("the latest
 * in the <Konu> agenda"). 'Genel' is an adjective, not a name, so
 * "Genel gündeminde" would read as "in the agenda of Genel": the genel feed takes
 * the plain locative, "Genel gündemde son haberler" ("in the general agenda").
 */
function latestHeading(topicLabel: string): string {
  return topicLabel === GENEL_LABEL
    ? `${GENEL_LABEL} gündemde son haberler`
    : `${topicLabel} gündeminde son haberler`;
}

/**
 * "İlgili haberler": a hookless server component at the end of an indexable
 * cluster page. Up to five other recent multi-article clusters (neutral title
 * plus "N kaynak") and a "Tüm <Konu> haberleri" hub link, so a crawler reaches
 * sibling stories from here and a reader has a next step.
 *
 * The heading says what the list is (h34-reader-3). Mode 'related' (the
 * default: the stories scored as related to the page's own headline) is
 * headed "İlgili haberler". Mode 'latest' (fewer than two stories related, so
 * the list is the topic's newest, deduped, led by the one related story when
 * there is one) is headed "<Konu> gündeminde son haberler" and never claims
 * relatedness. The mode is the `mode` prop, else the
 * marker `selectRelatedClusters` puts on the list it returns (relatedModeOf),
 * else 'related' (a plain array, the shape callers had before the marker).
 *
 * No link prefetches: a cluster page is DB-backed, and prefetching the five
 * rows would cost five cold cluster-detail reads per view. No client
 * JS, no state. Tailwind classes are literal strings so the JIT picks them up,
 * and no text colour carries an opacity (WCAG 1.4.3,
 * tests/guards/text-contrast-tokens.test.ts).
 */
export function RelatedStories({
  items,
  topicLabel,
  hubHref,
  hubLabel,
  mode,
}: {
  items: RelatedCluster[];
  topicLabel: string;
  hubHref: string;
  hubLabel: string;
  /** Overrides the mode marked on `items`; absent: the marker, else 'related'. */
  mode?: RelatedMode;
}) {
  const latest = (mode ?? relatedModeOf(items)) === "latest";
  return (
    <nav
      aria-labelledby="related-stories-heading"
      className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-5"
    >
      <h2
        id="related-stories-heading"
        className="font-serif text-base font-semibold text-foreground"
      >
        {latest ? latestHeading(topicLabel) : "İlgili haberler"}
      </h2>
      {latest ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          {topicLabel} konusunda son haberler
        </p>
      )}
      <ul className="mt-3 space-y-1">
        {items.map((item) => (
          <li key={item.id} className="py-1 text-sm leading-snug">
            <Link
              href={`/cluster/${item.id}`}
              prefetch={false}
              lang={item.lang}
              className="rounded-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.title}
            </Link>
            <span className="ml-1.5 whitespace-nowrap text-xs text-muted-foreground">
              <span aria-hidden="true">· </span>
              {item.sourceCount} kaynak
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm">
        <Link
          href={hubHref}
          prefetch={false}
          className="inline-flex items-center min-h-6 max-sm:min-h-11 rounded-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {hubLabel}
        </Link>
      </p>
    </nav>
  );
}
