import { preload } from "react-dom";

import {
  cardHeroCandidates,
  mobileBannerPreload,
} from "@/components/story/cluster-card";
import {
  getPoliticsClusters,
  type PoliticsClustersResult,
} from "@/lib/clusters/politics-query";
import { homeFirstCard } from "@/lib/home/first-card";

// h160-1: preloads the first card's mobile banner from the prerendered shell.
//
// On a hard load of "/" the feed streams in behind a Suspense hole (HomeFeed
// awaits the page's search params), so the first card's <img> and its own
// preload arrived about 40 KB (wire) into the document, in <body>, right next
// to the <img>: no lead time (a 0.84 s load delay on a phone). This component
// renders nothing; it only calls react-dom's preload() for the banner of the
// card the page will show first. While the shell renders, React collects that
// call and writes the <link> into <head>, ahead of the inline stylesheet.
//
// It reads the same cached feed HomeFeed reads (the default profile, so the same
// cache key) and nothing from the request: no search params, no cookies or
// headers, no connection, no clock. That is what lets it sit in the static
// shell. For a search or a later page the hint can name a card that is not
// first; that wastes one small image fetch, and the card's own preload,
// eager loading and priority stay as they were for those pages (React drops the
// card's duplicate when its key matches this one).
//
// A feed that cannot be read must never reach the page: the failure is
// swallowed and nothing is preloaded. During a prerender a failed cache read
// does not throw but leaves a promise that never settles; that postpones only
// this boundary, which page.tsx wraps in its own Suspense with a null fallback,
// so the rest of the shell is unaffected.
export async function HomeLcpPreload(): Promise<null> {
  let feed: PoliticsClustersResult;
  try {
    feed = await getPoliticsClusters();
  } catch {
    return null;
  }

  const card = homeFirstCard(feed);
  const src = card ? cardHeroCandidates(card.articles, card.sources)[0] : undefined;
  if (src) {
    const { href, options } = mobileBannerPreload(src);
    preload(href, options);
  }
  return null;
}
