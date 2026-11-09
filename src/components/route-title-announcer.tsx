"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// After a client-side navigation a screen reader must hear the NEW page's name.
//
// Next's own announcer (node_modules/next/dist/client/components/
// app-router-announcer.js) reads `document.title` once per tree change, falls
// back to `querySelector("h1")` when the title is empty, and speaks the result
// through an assertive region. Our <title> is streamed ~500 ms after the tree
// commits, so at that single look the title is '' and the first h1 in the DOM
// is the one of the page just left, kept hidden by Activity. The reader hears
// the previous page's name and is never corrected.
//
// This component waits for the title to settle, announces it once through one
// polite region, and sets aria-hidden on Next's announcer so only one voice
// speaks. It never writes into Next's shadow DOM (React owns that text node)
// and nothing in node_modules is patched.
//
// What does NOT announce: UI chatter that is not a page change. Typing in the
// search box navigates with router.replace (a debounced ?q=...), and the home
// page gives every query its own title, so announcing each one would repeat
// SearchStatus, the page's one live region for the search. A query change on
// the same pathname is "the search box talking" (the same rule as
// focus-feed-on-page-change.tsx), including the ?page drop search-nav does while
// typing. ?q and ?bulten (the newsletter banner deletes it on dismiss) are
// therefore left out of the route key. A pathname change always announces, also
// when it arrives with a query ("/konu/dunya" to "/?q=a").
//
// The one exception is the query going from non-empty to '' on the same pathname
// (h90-livearia-1): the search box, "Aramayı temizle", the logo, "Haberler", g h
// and Back all land there. SearchStatus empties itself (there is no query left to
// describe), so without this the reader hears nothing and the page changed under
// them. The region says SEARCH_CLEARED_ANNOUNCEMENT, politely, once. A query that
// becomes another non-empty one stays silent, SearchStatus speaks the new result.
//
// The logic lives in small exported functions so it can be tested without a DOM
// library (see route-title-announcer.test.tsx).

/** How often the title is sampled. */
const POLL_MS = 100;
/** Equal, non-empty samples in a row before the title counts as settled (300 ms). */
const STABLE_POLLS = 3;
/** After this long without a settled title, use the first visible h1 instead. */
const GIVE_UP_MS = 4000;

/** What the region says when a search is cleared (the home feed is back, in full). */
export const SEARCH_CLEARED_ANNOUNCEMENT = "Arama temizlendi. Tüm haberler gösteriliyor.";
/**
 * The clear text is set this long after the navigation commits, not inside the
 * effect: SearchStatus empties in the same commit, and a delayed write keeps the
 * two regions from changing in one frame. It also lets a keystroke that follows
 * at once cancel it.
 */
const CLEARED_ANNOUNCE_MS = 100;

const SITE_NAME = "Tayf";
const EM_DASH = "—";
const NEXT_ANNOUNCER_TAG = "next-route-announcer";

/** An h1 matching this, or inside something that does, is not exposed to AT. */
const HIDDEN_FROM_AT_SELECTOR = '[hidden], [inert], [aria-hidden="true"]';

const isSpace = (ch: string | undefined): boolean => ch !== undefined && ch.trim() === "";

/**
 * `title` without the trailing " — Tayf" the metadata template appends. An em
 * dash inside the page title ("Dünya haberleri — Sayfa 2") stays. Scanned by
 * character, so a long whitespace run in a title cannot make it slow.
 */
export function stripSiteSuffix(title: string): string {
  const text = title.trim();
  if (!text.endsWith(SITE_NAME)) return text;
  const brandAt = text.length - SITE_NAME.length;
  let i = brandAt;
  while (i > 0 && isSpace(text[i - 1])) i--;
  // Needs whitespace between the dash and the name, then the dash itself.
  if (i === brandAt || text[i - 1] !== EM_DASH) return text;
  const dashAt = i - 1;
  let j = dashAt;
  while (j > 0 && isSpace(text[j - 1])) j--;
  // And whitespace before the dash.
  if (j === dashAt) return text;
  return text.slice(0, j);
}

/** Search params that change without a page change: the search box's query and the newsletter banner's status. */
const UI_CHATTER_PARAMS = ["q", "bulten"] as const;

/**
 * One key per page a visitor can land on: a path change or a search-only change
 * (?sayfa=2) both count, the search box's ?q and the newsletter banner's ?bulten
 * do not.
 */
export function routeKey(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  for (const name of UI_CHATTER_PARAMS) params.delete(name);
  return `${pathname}?${params.toString()}`;
}

/**
 * True when the visitor stayed on the same pathname and the query went from
 * non-empty to ''. A pathname change is a page change and has its own rule.
 */
export function searchWasCleared(
  before: { pathname: string; query: string },
  now: { pathname: string; query: string },
): boolean {
  return before.pathname === now.pathname && before.query !== "" && now.query === "";
}

/** The slice of an Element the heading fallback reads (a structural type so tests can fake it). */
export interface HeadingNode {
  textContent: string | null;
  closest(selectors: string): unknown;
  parentElement: HeadingNode | null;
}

function isHiddenFromAt(heading: HeadingNode, getStyle: (el: HeadingNode) => { display: string }): boolean {
  if (heading.closest(HIDDEN_FROM_AT_SELECTOR)) return true;
  for (let node: HeadingNode | null = heading; node; node = node.parentElement) {
    if (getStyle(node).display === "none") return true;
  }
  return false;
}

/**
 * The text of the first <h1> that is not inside [hidden], [inert],
 * [aria-hidden="true"] or an ancestor with computed display:none, with inner
 * whitespace collapsed. '' when there is none. Left routes stay in the DOM
 * hidden, so a bare `querySelector("h1")` finds the wrong page.
 */
export function firstVisibleHeadingText(
  root: { querySelectorAll(selectors: string): ArrayLike<HeadingNode> },
  getStyle: (el: HeadingNode) => { display: string },
): string {
  const headings = root.querySelectorAll("h1");
  for (let k = 0; k < headings.length; k++) {
    const heading = headings[k];
    if (!heading || isHiddenFromAt(heading, getStyle)) continue;
    const text = (heading.textContent ?? "").split(/\s+/).filter(Boolean).join(" ");
    if (text !== "") return text;
  }
  return "";
}

export interface TitlePollDeps {
  /** The current `document.title`. */
  readTitle(): string;
  /** The first visible h1's text, used when the title never settles. */
  readFallback(): string;
  /** Called at most once, with a non-empty, suffix-free page name. */
  onSettled(text: string): void;
}

/**
 * Samples the title every 100 ms and settles once it is non-empty and
 * unchanged for 3 samples in a row, so the old title, the empty gap and a
 * title that is still changing are never announced. Gives up at 4000 ms and
 * settles on the first visible h1. Returns a cancel function.
 */
export function startTitlePoll(deps: TitlePollDeps): () => void {
  let polls = 0;
  let last = "";
  let streak = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const cancel = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const settle = (text: string) => {
    cancel();
    if (text !== "") deps.onSettled(text);
  };

  timer = setInterval(() => {
    polls++;
    const title = deps.readTitle().trim();
    if (title === "") {
      last = "";
      streak = 0;
    } else if (title === last) {
      streak++;
    } else {
      last = title;
      streak = 1;
    }
    if (streak >= STABLE_POLLS) settle(stripSiteSuffix(title));
    else if (polls * POLL_MS >= GIVE_UP_MS) settle(deps.readFallback());
  }, POLL_MS);

  return cancel;
}

interface AnnouncerElement {
  setAttribute(name: string, value: string): void;
}

interface ObserverLike<Root> {
  observe(target: Root, options: MutationObserverInit): void;
  disconnect(): void;
}

/**
 * Sets aria-hidden="true" on every <next-route-announcer> under `root` (the
 * host element, so its shadow content leaves the accessibility tree too) and
 * keeps doing so when Next creates or recreates it. Next appends the element
 * straight to <body>, so the observer watches the root's children only, not
 * its subtree. Returns a cleanup function.
 */
export function hideNextRouteAnnouncer<Root extends { querySelectorAll(selectors: string): ArrayLike<AnnouncerElement> }>(
  root: Root,
  Observer: new (callback: () => void) => ObserverLike<NoInfer<Root>>,
): () => void {
  const hideAll = () => {
    for (const el of Array.from(root.querySelectorAll(NEXT_ANNOUNCER_TAG))) {
      el.setAttribute("aria-hidden", "true");
    }
  };
  hideAll();
  const observer = new Observer(hideAll);
  observer.observe(root, { childList: true });
  return () => observer.disconnect();
}

interface Announcement {
  key: string;
  /**
   * The search the text was made for. The key leaves ?q out, so the component
   * empties the region whenever the query changes; a later return to the same
   * query ('') cannot restore an older text.
   */
  query: string;
  text: string;
}

export function RouteTitleAnnouncer() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const key = routeKey(pathname, searchParams.toString());

  const [announced, setAnnounced] = useState<Announcement | null>(null);
  // ?q is not part of the route key, so an announcement stored for "/?" would
  // match again when the query returns to '' ("/konu/dunya" to "/" to "/?q=a" to
  // "/"): the region would read the old page title at the clear commit, with no
  // delay and no keystroke cancel. Any query change therefore empties the region,
  // adjusted during render (React's "adjust state when a prop changes" pattern, as
  // follow-feed.tsx does for seenSnapshot) because a synchronous setState in an
  // effect is a react-hooks/set-state-in-effect error.
  const [searchSeen, setSearchSeen] = useState(query);
  if (searchSeen !== query) {
    setSearchSeen(query);
    setAnnounced(null);
  }
  // The URL the page loaded on: no announcement for it, a screen reader reads
  // a fresh page load by itself.
  const previous = useRef({ key, pathname, query });

  useEffect(() => hideNextRouteAnnouncer(document.body, MutationObserver), []);

  useEffect(() => {
    const before = previous.current;
    previous.current = { key, pathname, query };
    // First, because ?q is not part of the key: "/?q=x" to "/" leaves it unchanged.
    if (searchWasCleared(before, { pathname, query })) {
      const timer = setTimeout(
        () => setAnnounced({ key, query, text: SEARCH_CLEARED_ANNOUNCEMENT }),
        CLEARED_ANNOUNCE_MS,
      );
      return () => clearTimeout(timer);
    }
    if (before.key === key) return;
    // The same pathname with a different query is the search box talking, also
    // when search-nav dropped ?page on the way ("/?page=2" to "/?q=a").
    if (before.pathname === pathname && before.query !== query) return;
    return startTitlePoll({
      readTitle: () => document.title,
      readFallback: () => firstVisibleHeadingText(document, (el) => getComputedStyle(el as Element)),
      onSettled: (text) => setAnnounced({ key, query, text }),
    });
  }, [key, pathname, query]);

  // The announcement belongs to the URL and the search it was made for. After a
  // navigation the region therefore reads '' until the new title settles, so a
  // title that repeats (?sayfa=2 then ?sayfa=3) still changes the live region's
  // content. The same goes for the clear text: the region is emptied whenever the
  // query changes (the render-time reset above), so a later return to '' cannot
  // restore old text and clearing again later is a change, spoken again.
  const text =
    announced !== null && announced.key === key && announced.query === query ? announced.text : "";

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </div>
  );
}
