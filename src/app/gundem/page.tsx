import type { Metadata } from "next";
import Link from "next/link";

import { PageHero } from "@/components/ui/page-hero";
import { staticPageMetadata } from "@/lib/seo/page-metadata";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";

// /gundem — index of the entity hubs (/gundem/[key]). Pure vocabulary: it reads
// nothing from the database, so it prerenders fully static and can never show
// an unavailable state. The per-hub cluster counts live on the hubs themselves.

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

export default function GundemIndexPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-6">
      <PageHero
        kicker="Gündem"
        title="Gündemdeki adlar"
        subtitle="Kişi, parti, kurum ve ülkelere göre son 14 günün haberleri."
      />

      <ul className="flex flex-wrap gap-2">
        {RISING_ENTITIES.map((e) => (
          <li key={e.key}>
            {/* prefetch off: the page links 62 hubs, and each prefetch would be
                an RSC payload for a DB-backed route nobody may open. */}
            <Link prefetch={false} href={`/gundem/${e.key}`} className={chipClass}>
              {e.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
