// Fact-check publisher registry (migration 080's `fact_checks.publisher`
// CHECK constraint mirrors `FACT_CHECK_PUBLISHER_KEYS` verbatim -- parity is
// pinned by tests/migrations/080-fact-checks.test.ts and by
// normalize.test.ts's feeds.ts parity check).
//
// Step 0 verification (2026-09-28, see docs/fact-checks.md for the full
// table): each candidate URL was fetched with
// `curl -sS -L -m 15 -A "TayfBot/1.0 (fact-check link checker)"` and kept
// only if it returned 200, parsed as RSS/Atom XML, had >=1 item, and every
// item link's host belonged to the publisher (AA additionally required
// `/teyithatti/` in the path).
export const FACT_CHECK_PUBLISHER_KEYS = [
  "teyit",
  "dogrulukpayi",
  "malumatfurus",
  "aa-teyit",
] as const;

export type FactCheckPublisherKey = (typeof FACT_CHECK_PUBLISHER_KEYS)[number];

export interface FactCheckPublisher {
  key: FactCheckPublisherKey;
  label: string;
  hosts: readonly string[];
  pathIncludes?: string;
  feedUrl: string | null;
}

export const FACT_CHECK_PUBLISHERS: Record<
  FactCheckPublisherKey,
  FactCheckPublisher
> = {
  teyit: {
    key: "teyit",
    label: "Teyit",
    hosts: ["teyit.org", "www.teyit.org"],
    // curl: 200 text/xml; charset=utf-8, 8744 bytes, 10 <item>s, newest
    // pubDate Mon, 28 Sep 2026 19:35:02 +0300. Kept.
    feedUrl: "https://teyit.org/feed",
  },
  dogrulukpayi: {
    key: "dogrulukpayi",
    label: "Doğruluk Payı",
    hosts: ["www.dogrulukpayi.com", "dogrulukpayi.com"],
    // curl https://www.dogrulukpayi.com/rss -> 404 text/html (skipped).
    // curl https://www.dogrulukpayi.com/feed -> 404 text/html (skipped).
    // curl https://www.dogrulukpayi.com/rss.xml -> 200 text/xml, 8902
    // bytes, 12 <item>s, newest pubDate Mon, 28 Sep 2026 16:59:58 +0300,
    // every <link> hosted on www.dogrulukpayi.com. Kept.
    feedUrl: "https://www.dogrulukpayi.com/rss.xml",
  },
  malumatfurus: {
    key: "malumatfurus",
    label: "Malumatfuruş",
    hosts: ["www.malumatfurus.org", "malumatfurus.org"],
    // curl https://www.malumatfurus.org/feed/ -> 200
    // application/rss+xml; charset=UTF-8, 30866 bytes, 20 <item>s, newest
    // pubDate Mon, 28 Sep 2026 11:09:29 +0000, every <link> hosted on
    // www.malumatfurus.org. https://malumatfurus.org/feed redirects
    // (-L) to the same URL/body. Kept, canonical www host.
    feedUrl: "https://www.malumatfurus.org/feed/",
  },
  "aa-teyit": {
    key: "aa-teyit",
    label: "AA Teyit Hattı",
    hosts: ["www.aa.com.tr", "aa.com.tr"],
    pathIncludes: "/teyithatti/",
    // curl https://www.aa.com.tr/tr/rss/default?cat=teyithatti -> 404.
    // The teyithatti HTML page (https://www.aa.com.tr/tr/teyithatti) only
    // advertises one <link rel="alternate" type="application/rss+xml">,
    // href="/rss/" -- AA's single site-wide feed, not a teyithatti-scoped
    // one. curl https://www.aa.com.tr/rss/ additionally timed out (15s)
    // behind a redirect loop, and even a working site-wide feed would not
    // satisfy the `/teyithatti/` path rule on its item links. No feed
    // qualifies; skipped (shadow-disabled via feedUrl: null).
    feedUrl: null,
  },
};

export const FACT_CHECK_FEEDS: FactCheckPublisher[] = FACT_CHECK_PUBLISHER_KEYS.map(
  (key) => FACT_CHECK_PUBLISHERS[key],
).filter((p): p is FactCheckPublisher & { feedUrl: string } => p.feedUrl !== null);
