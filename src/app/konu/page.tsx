import type { Metadata } from "next";
import Link from "next/link";

import { PageHero } from "@/components/ui/page-hero";
import {
  getTopicCounts,
  TOPIC_LABELS_TR,
  TOPIC_NOTE_LINK_LABEL,
  TOPIC_NOTE_PREFIX,
  TOPIC_SLUGS,
} from "@/lib/clusters/topic-query";

// /konu — Pack C ("Konu") index. Lists the six reader-facing topic hubs
// (politika is deliberately absent — it's a valid clusters.topic7 value but
// its hub IS the home feed) with a 7-day cluster count beside each, or "?"
// copy when the count read failed. No `export const dynamic` / `revalidate`:
// under cacheComponents every fetcher is a "use cache" function that
// resolves to null on error, so this page prerenders into its honest
// unavailable state rather than failing the build.

export const metadata: Metadata = {
  title: "Konular",
  description:
    "Tayf kümelerini konuya göre gezin: dünya, ekonomi, spor, yaşam, teknoloji, genel. Konu etiketleri otomatik atanır.",
  alternates: { canonical: "/konu" },
};

// Shared class tokens — literal strings only (Tailwind 4 has no runtime
// scanner). Mirrors /hafta's token set.
const cardClass = "rounded-xl ring-1 ring-border/60 bg-card/60 p-4 sm:p-6";
const rowClass =
  "flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg ring-1 ring-border/50 bg-muted/20 p-3";
const linkClass =
  "text-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary";
const metaClass = "text-xs text-muted-foreground";
const noteClass = "text-xs text-muted-foreground";

const COUNTS_UNAVAILABLE_COPY = "Konu sayıları şu anda okunamıyor.";

export default async function TopicIndexPage() {
  const counts = await getTopicCounts();

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-6">
      <PageHero
        kicker="Konu"
        title="Konular"
        subtitle="Son 7 günün kümeleri konu başlıklarına göre. Siyaset haberleri ana sayfada kalır."
      />

      <section className={`${cardClass} space-y-3`}>
        <ul className="space-y-2">
          {TOPIC_SLUGS.map((slug) => (
            <li key={slug} className={rowClass}>
              <Link href={`/konu/${slug}`} className={linkClass}>
                {TOPIC_LABELS_TR[slug]}
              </Link>
              {counts !== null ? (
                <span className={metaClass}>{`son 7 günde ${counts[slug]} küme`}</span>
              ) : null}
            </li>
          ))}
        </ul>
        {counts === null ? (
          <p className={metaClass}>{COUNTS_UNAVAILABLE_COPY}</p>
        ) : null}
      </section>

      <p className={noteClass}>
        {TOPIC_NOTE_PREFIX}
        <Link
          href="/metodoloji#konu"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          {TOPIC_NOTE_LINK_LABEL}
        </Link>
      </p>
    </div>
  );
}
