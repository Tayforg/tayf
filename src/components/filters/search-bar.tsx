"use client";

import { useEffect, useId, useRef, useState, startTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { track } from "@/lib/track";
import { externalQueryChange, searchNavTarget } from "./search-nav";
import { isSearchShortcut } from "./search-shortcut";
// Its own line: tests/guards/search-announce.test.ts pins the line above verbatim.
import { isSearchArrivalHash } from "./search-shortcut";
// Also its own line, for the same reason.
import { registerSearchBar } from "./search-shortcut";

export function SearchBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [value, setValue] = useState(searchParams.get("q") ?? "");
  // One "search" event per empty→non-empty transition, none on landing with ?q=.
  const searchedRef = useRef(Boolean(searchParams.get("q")));
  // The query the bar last wrote to the URL or adopted from it. A ?q that
  // differs from this was changed from outside (logo, "Aramayı temizle", g h,
  // Back/forward): the URL wins, see the effect below.
  const lastWrittenRef = useRef(searchParams.get("q") ?? "");

  // Global `/` shortcut focuses the input (not while typing elsewhere, not
  // with Ctrl/Cmd/Alt: see isSearchShortcut). The registration tells
  // KbdShortcuts this bar is listening; its cleanup runs on unmount and when
  // Next hides the page in <Activity mode="hidden"> (DOM kept, listener gone).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isSearchShortcut(e)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    const unregister = registerSearchBar();
    return () => {
      window.removeEventListener("keydown", handler);
      unregister();
    };
  }, []);

  // Arriving from the "/" shortcut on another page (KbdShortcuts pushes
  // "/#ara"): focus the input once, then drop the hash so a reload or a shared
  // link does not steal focus. replaceState adds no history entry. The state
  // argument is null on purpose: Next's patched replaceState then copies its
  // own tree into the new entry and syncs the router's canonicalUrl. Passing
  // history.state, which carries __NA, would bypass that sync and leave
  // canonicalUrl at "/#ara"; the next same-URL router update (for example
  // RetryButton's router.refresh()) would write the hash back.
  useEffect(() => {
    if (!isSearchArrivalHash(window.location.hash)) return;
    inputRef.current?.focus();
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  // The URL is the source of truth whenever it changes from outside this
  // component. `value` is seeded from ?q only once, and a navigation that
  // changes just the search params keeps this component mounted, so without
  // this the debounced effect below would write the old text straight back
  // (h60-forms-1: "/" bounced to "/?q=<old>" a moment after the logo click).
  useEffect(() => {
    const urlQ = searchParams.get("q") ?? "";
    const next = externalQueryChange({ urlQ, lastWritten: lastWrittenRef.current });
    if (next === null) return;
    lastWrittenRef.current = next;
    searchedRef.current = next.trim().length > 0;
    setValue(next);
  }, [searchParams]);

  // Debounced URL update (300ms)
  useEffect(() => {
    const t = setTimeout(() => {
      // The URL already reflects the text (landing, our own write, or a value
      // adopted from the URL above): nothing to write or to count.
      if (value.trim() === lastWrittenRef.current.trim()) return;
      const q = value.trim();
      if (q && !searchedRef.current) track("search");
      searchedRef.current = q.length > 0;
      const target = searchNavTarget({ value, pathname, search: searchParams.toString() });
      if (target === null) return;
      lastWrittenRef.current = q;
      startTransition(() => {
        router.replace(target, { scroll: false });
      });
    }, 300);
    return () => clearTimeout(t);
  }, [value, pathname, router, searchParams]);

  return (
    <div id="ara" role="search" className="relative flex items-center">
      <label htmlFor={inputId} className="sr-only">
        Haberlerde ara
      </label>
      <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" />
      <input
        ref={inputRef}
        id={inputId}
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Haberlerde ara..."
        maxLength={200}
        className="h-10 w-full rounded-full bg-muted/50 border border-input pl-9 pr-12 text-base sm:text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:bg-background transition-colors"
      />
      <kbd
        aria-hidden="true"
        className="absolute right-3 hidden sm:inline-flex items-center justify-center rounded border border-border/60 bg-muted/40 px-1.5 text-[10px] text-muted-foreground font-mono"
      >
        /
      </kbd>
    </div>
  );
}
