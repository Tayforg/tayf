import Link from "next/link";

import { risingHint, type RisingItem } from "@/lib/trends/rising";
import { linkRisingHubs } from "@/lib/trends/rising-links";
import { getRisingEntities } from "@/lib/trends/rising-query";

// h170-roadmap-3: the compact "Yükselen konular" rail on page 1 of the plain home feed, a row of
// chips under the first story section: the label of each rising topic and the same hint /trends
// prints ("7 günlük ortalamanın 5,0 katı"), then a trailing "Tümü" link to /trends.
//
// Same data and same links as /trends, not a second computation: getRisingEntities is the very
// cache entry /trends reads (both pages show identical numbers inside one cache window) and
// linkRisingHubs settles each href the way /trends does (a /gundem hub when it is indexable, the
// /?q= search otherwise). Only the first RAIL_MAX rows are linked, so at most that many hubs are
// read. The ranked day and the count stay on /trends: the entry is served up to an hour past
// Istanbul midnight, so the rail names no day (never "Bugün") and prints no count.
//
// Two pieces. loadRisingRail does the reads and RisingRail awaits its promise and paints. HomeFeed
// calls loadRisingRail BEFORE it awaits the feed read and hands the promise down as `data`: a rail
// that began reading only once HomeFeed had returned usually finished after the feed's boundary had
// been revealed, and was then inserted (no sooner than 300 ms later, React's reveal throttle) after
// the first story section, shifting the teaser and every card below it. Started beside the feed, the
// rows are ready by the time the rail renders. The feed never awaits it.
//
// Nothing rejects and nothing throws: loadRisingRail resolves null for a null read, anything but
// status "ok", no rows, or a thrown read (a hub read can reject), and RisingRail renders nothing for
// null or an empty list, so nothing reaches the error boundary and no empty heading is painted. The
// page mounts it in a Suspense of its own with a null fallback, so a slow rising read cannot delay
// the feed either. A hookless server component: no client JavaScript.
//
// Layout. One row that wraps (flex-wrap), growing downward on a phone instead of scrolling. Each
// chip is the class of EntityHubChips: 44 px tall on a phone (max-sm:min-h-11), 24 px from sm up
// (WCAG 2.5.8). No link prefetches (#291): a hub is a DB-backed read, and this rail sits on the
// most-visited page, so a prefetch per chip would be paid by every visit. Colours are the full
// tokens only (WCAG 1.4.3, tests/guards/text-contrast-tokens.test.ts); the classes are literal.

/** Chips shown at most; the page this rides on is the heaviest one, so the rail stays compact. */
export const RISING_RAIL_MAX = 6;

const CHIP_CLASS =
  "inline-flex items-center gap-1.5 min-h-6 max-sm:min-h-11 rounded-full border border-border/60 bg-muted/50 px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The rail's rows: the rising list of the shared cached entry, cut to RISING_RAIL_MAX and linked
 * (a hub href or the /?q= search), or null when there is nothing to show. Never rejects: a thrown
 * read (the rising read or a hub read) is logged once and is null. The read starts when this is
 * called, so call it as early as the page can and hand the promise to RisingRail.
 */
export async function loadRisingRail(): Promise<RisingItem[] | null> {
  try {
    const read = await getRisingEntities();
    // `!read`, not `=== null`: a missing answer is "nothing to show", never a TypeError to log.
    if (!read || read.status !== "ok" || read.items.length === 0) return null;
    const linked = await linkRisingHubs({ ...read, items: read.items.slice(0, RISING_RAIL_MAX) });
    if (linked === null || linked.status !== "ok" || linked.items.length === 0) return null;
    return linked.items;
  } catch (err) {
    console.warn("[home] rising rail unavailable:", err);
    return null;
  }
}

export async function RisingRail({ data }: { data: Promise<RisingItem[] | null> }) {
  const items = await data;
  if (items === null || items.length === 0) return null;

  return (
    <aside aria-label="Yükselen konular" className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="font-serif text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Yükselen konular
        </h2>
        <div className="h-px flex-1 bg-gradient-to-r from-brand/30 to-transparent" />
      </div>
      <ul className="flex flex-wrap items-center gap-2">
        {items.map((item) => (
          <li key={item.key}>
            <Link href={item.href} prefetch={false} className={CHIP_CLASS}>
              {`${item.label} `}
              <span className="font-normal text-muted-foreground">{risingHint(item)}</span>
            </Link>
          </li>
        ))}
        <li>
          <Link href="/trends" prefetch={false} className={CHIP_CLASS}>
            Tümü<span className="sr-only"> yükselen konular</span>
          </Link>
        </li>
      </ul>
    </aside>
  );
}
