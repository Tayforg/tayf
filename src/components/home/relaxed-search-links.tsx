"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { SEARCH_SORT_NEW, type SearchSort } from "@/lib/search/search-sort";

import { focusTarget } from "./clear-search-link";

// "Kelimeleri tek tek deneyin": one chip per word of a multi-word search that
// found nothing (h185-roadmap2-1). The archive ANDs every typed word, so a long
// question matches nothing while each of its words has results; the chips let the
// reader widen the search in one tap. relaxedSearchWords (src/lib/search) picks
// the words from the canonical query, the page passes them in.
//
// Each chip is a plain search link (?q=word), the word encoded by URLSearchParams
// and rendered as a React child, so a word cannot add a parameter or markup. In the
// newest-first order (`sort` "yeni", h191) the chip keeps it: ?q=word&sirala=yeni; any
// other value, or none, is the plain chip it always was.
// prefetch={false}: every target is a DB-backed search, and up to six chips must
// not fire six RPCs when the card scrolls into view (the reason SearchIntentRow
// and the compact /cluster rows opt out too). scroll={false} keeps the reader
// where they are.
//
// Focus works as in ClearSearchLink (h90-livearia-1, WCAG 2.4.3): the card that
// holds the chips unmounts when the navigation commits, so the focused chip
// would vanish and focus would fall to <body>. A chip remembers it was activated
// and hands focus to the feed container (`targetId`, tabIndex -1, see page.tsx)
// once the query in the URL changes; when the card goes in the same commit as
// the query change (the usual case, the new search has results) the unmount
// cleanup does it, after the new DOM is in place. Whichever runs first spends the
// flag. The flag hangs off `onNavigate`, not `onClick`: Link calls it right before
// an in-app navigation and never for a modified click (Cmd/Ctrl/Shift/Alt) or a
// new-tab target, so those do not arm it. An editable active element is left
// alone (focusTarget). Without JavaScript the chips are still plain links.
//
// Kept free of `cn` / tailwind-merge: the class strings are literals
// (tests/guards/public-client-weight.test.ts).

// The chip class of SearchIntentRow in page.tsx: 24 px tall, 44 px on a phone.
const CHIP_CLASS =
  "inline-flex items-center min-h-6 max-sm:min-h-11 rounded-full border border-border/60 bg-muted/50 px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

// The address of one chip: the word, then sirala=yeni in the newest-first order only.
function chipHref(word: string, sort: SearchSort | null | undefined): string {
  const params = new URLSearchParams({ q: word });
  if (sort === SEARCH_SORT_NEW) params.set("sirala", SEARCH_SORT_NEW);
  return `/?${params.toString()}`;
}

export function RelaxedSearchLinks({
  words,
  targetId,
  sort,
}: {
  words: readonly string[];
  targetId: string;
  /** The order the search was asked for (h191): "yeni" is kept on every chip; absent is the ranked order. */
  sort?: SearchSort | null;
}) {
  const query = useSearchParams().get("q") ?? "";
  const pending = useRef(false);

  // The chips are still mounted when the query changes.
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    focusTarget(targetId);
  }, [query, targetId]);

  // The card is removed together with the query change.
  useEffect(
    () => () => {
      if (!pending.current) return;
      pending.current = false;
      focusTarget(targetId);
    },
    [targetId],
  );

  if (words.length === 0) return null;

  return (
    <div className="flex min-w-0 max-w-full flex-col items-center gap-2">
      <p className="text-xs text-muted-foreground">Kelimeleri tek tek deneyin:</p>
      {/* A word is at most 64 characters: [overflow-wrap:anywhere] lets a chip wrap
          instead of outgrowing a 390 px card (it is inherited, and unlike break-words
          it lowers the min-content width the flex item shrinks to). */}
      <ul className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-2 [overflow-wrap:anywhere]">
        {words.map((word) => (
          <li key={word} className="min-w-0 max-w-full">
            <Link
              href={chipHref(word, sort)}
              prefetch={false}
              scroll={false}
              className={CHIP_CLASS}
              onNavigate={() => {
                pending.current = true;
              }}
            >
              {word}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
