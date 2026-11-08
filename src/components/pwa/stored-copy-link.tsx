"use client";

import { useEffect, useState, type MouseEvent } from "react";

import {
  findStoredCopy,
  markStoredCopyOpen,
  type CacheStorageLike,
  type PutCacheStorageLike,
} from "@/lib/pwa/offline-items";
import { formatTurkishTimeAgo } from "@/lib/time";

// "This device holds a copy of the story" offer for the cluster error boundary (h69-pwa-1).
//
// Why it lives in the client boundary: the cluster route answers HTTP 200 and sends its headers from the
// prerendered shell BEFORE the database-backed read runs, so during a database brownout the service worker sees a
// healthy response (its 3 s timer and its 5xx branch never fire) and the failure only ever surfaces as
// ./error.tsx. That boundary is the one place that knows the read failed, so it asks Cache Storage whether this
// device has the story (a pinned copy, or a visited copy younger than 14 days) and offers it.
//
// The link is a PLAIN anchor to /cluster/<id>?kopya=1 on purpose: only a full navigation reaches the worker, and
// the worker answers a navigation carrying kopya=1 from storage before it tries the network (sw-source.ts
// handleCluster). next/link would soft-navigate over RSC, which the worker never sees.
//
// The answer is ONE-SHOT. The url alone does not unlock it: a plain click first writes a short-lived mark into
// Cache Storage (markStoredCopyOpen), then navigates, and the worker takes (deletes) the mark when it answers. So a
// reload, Back/Forward, a restored session or a link from another site (which cannot write this origin's Cache
// Storage) takes the normal network-first path: no reload trap, and nothing for another site to time. A modified
// click (new tab, new window, download) or a non-primary button keeps the browser's own behaviour, which is also
// network-first.
//
// Hydration: the server render and the first client render output nothing; the lookup runs in an effect, after
// mount, and the state it sets arrives later (a promise callback, not the effect body). The ages are computed
// there too, with the reader's clock, so the render body never reads one.

interface Offer {
  href: string;
  /** "3 saat önce", or "" when the copy carries no usable stamp. */
  savedAgo: string;
}

function cacheStorage(): (CacheStorageLike & PutCacheStorageLike) | undefined {
  try {
    return typeof caches === "undefined" ? undefined : caches;
  } catch {
    // Firefox throws SecurityError for blocked storage.
    return undefined;
  }
}

/** The click of a plain primary press: prevent the default (synchronously), leave the mark, then navigate. */
async function openStoredCopy(event: MouseEvent<HTMLAnchorElement>, clusterId: string, href: string): Promise<void> {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  // Never throws: when the mark cannot be written the navigation still happens and is simply network-first.
  await markStoredCopyOpen(cacheStorage(), location.origin, clusterId, Date.now());
  location.assign(href);
}

/** The markup, separate from the lookup so it renders (and tests) without a browser. */
export function StoredCopyView({
  href,
  savedAgo,
  onClick,
}: Offer & { onClick?: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  // One string, one text node: "(… kaydedildi)" stays a single piece of text for screen readers.
  const sentence =
    savedAgo === ""
      ? "Bu hikâyenin bu cihazda kayıtlı bir kopyası var."
      : `Bu hikâyenin bu cihazda kayıtlı bir kopyası var (${savedAgo} kaydedildi).`;
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-sm text-muted-foreground leading-relaxed max-w-md">{sentence}</p>
      <a
        href={href}
        onClick={onClick}
        className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-4 py-2 text-sm font-medium text-foreground transition-colors"
      >
        Kayıtlı kopyayı aç
      </a>
    </div>
  );
}

export function StoredCopyLink({ clusterId }: { clusterId: string }) {
  const [offer, setOffer] = useState<Offer | null>(null);

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    void findStoredCopy(cacheStorage(), location.origin, clusterId, now).then((copy) => {
      if (cancelled || copy === null) return;
      setOffer({
        href: copy.href,
        // A bare date before "kaydedildi" would need a locative suffix, so the age stays relative (same choice as
        // stale-copy-notice.tsx); a pin never expires, so it can be months old.
        savedAgo:
          copy.cachedAt === null
            ? ""
            : formatTurkishTimeAgo(copy.cachedAt, { now, absoluteAfterMs: Number.POSITIVE_INFINITY }),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [clusterId]);

  if (offer === null) return null;
  const { href, savedAgo } = offer;
  return (
    <StoredCopyView
      href={href}
      savedAgo={savedAgo}
      onClick={(event) => {
        void openStoredCopy(event, clusterId, href);
      }}
    />
  );
}
