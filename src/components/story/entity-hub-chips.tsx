import Link from "next/link";

import { entityByKey } from "@/lib/entities/entity-hub";

// "Bu haberdeki gündem başlıkları": the /gundem entity hubs a story's headline
// names (h136-roadmap-1), as a row of small links under the spectrum. The keys
// come from clusterHubKeysFromDetail (src/lib/entities/cluster-hub-keys.ts), the
// hub's own matching rule, already capped (five) and in curated order.
//
// A hookless server component: no client directive, no state, no effect, so it adds
// no client JavaScript. It returns null for no keys, so no empty heading is ever
// painted; a key with no curated hub is skipped and a repeated key is listed
// once. The copy says what the story NAMES, never that the hub LISTS it: a hub
// shows the newest 20 stories of the last 14 days, so an older story's chip can
// lead to a hub that no longer lists it.
//
// No link prefetches, as in RelatedStories: a hub is a DB-backed read of up to 20
// clusters, and five chips per story view would pull five of them. The row wraps
// (flex-wrap) so it grows downward on a phone instead of scrolling or clipping,
// and each chip is 44 px tall on a phone (max-sm:min-h-11) and 24 px from sm up
// (WCAG 2.5.8), a fixed height, so nothing shifts once the page has painted.
// Tailwind classes are literal strings so the JIT sees them, and no text colour
// carries an opacity (WCAG 1.4.3, tests/guards/text-contrast-tokens.test.ts).

const HEADING_ID = "entity-hub-chips-heading";

export function EntityHubChips({ keys }: { keys: readonly string[] }) {
  const entities = [...new Set(keys)]
    .map((key) => entityByKey(key))
    .filter((entity) => entity !== null);
  if (entities.length === 0) return null;

  return (
    <div>
      <h2
        id={HEADING_ID}
        className="text-[11px] font-semibold text-muted-foreground"
      >
        Bu haberdeki gündem başlıkları
      </h2>
      <ul aria-labelledby={HEADING_ID} className="mt-1.5 flex flex-wrap gap-2">
        {entities.map((entity) => (
          <li key={entity.key}>
            <Link
              href={`/gundem/${entity.key}`}
              prefetch={false}
              className="inline-flex items-center min-h-6 max-sm:min-h-11 rounded-full border border-border/60 bg-muted/50 px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {entity.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
