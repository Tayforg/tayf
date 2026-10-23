"use client";

import { useEffect, useState } from "react";

import { readOfflineItems, type OfflineItem } from "@/lib/pwa/offline-items";
import { formatTurkishTimeAgo } from "@/lib/time";

// undefined = still loading (and the prerendered state), null = this browser
// has no Cache Storage, otherwise the stories the worker saved on this device.
type ListState = OfflineItem[] | null | undefined;

const SKELETON_ROWS = [0, 1, 2];

export function OfflineSavedList() {
  const [items, setItems] = useState<ListState>(undefined);

  useEffect(() => {
    let cancelled = false;
    void readOfflineItems(typeof caches === "undefined" ? undefined : caches).then((result) => {
      if (!cancelled) setItems(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="mb-8 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Yeniden dene
        </button>
        {/* Plain anchor on purpose: a full navigation is answered by the
            service worker, a soft one would need RSC over the network. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium text-foreground ring-1 ring-border/60 transition-colors hover:bg-card/80 hover:ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Ana sayfa
        </a>
      </div>

      <section aria-labelledby="offline-saved-heading">
        <h2
          id="offline-saved-heading"
          className="mb-3 font-serif text-lg font-semibold tracking-tight"
        >
          Çevrimdışı okunabilir kayıtlı hikâyeler
        </h2>

        {items === undefined ? (
          <ul className="space-y-2" aria-busy="true">
            {SKELETON_ROWS.map((n) => (
              <li
                key={n}
                className="h-16 animate-pulse rounded-lg bg-card/60 ring-1 ring-border/60"
              />
            ))}
          </ul>
        ) : items === null ? (
          <p className="text-sm text-muted-foreground">
            Bu tarayıcı çevrimdışı okumayı desteklemiyor.
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Bu cihazda çevrimdışı okunabilecek kayıtlı hikâye yok. Bir hikâyeyi kaydettiğinde,
            bağlantın varken bu cihaza indirilir ve burada listelenir.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id}>
                <a
                  href={item.href}
                  className="block rounded-lg ring-1 ring-border/60 hover:ring-border bg-card/60 hover:bg-card/80 transition-all p-4"
                >
                  <span className="block font-serif text-sm sm:text-base font-semibold leading-snug text-foreground line-clamp-2">
                    {item.title}
                  </span>
                  {item.cachedAt !== null && (
                    <span className="mt-1.5 block text-[11px] text-muted-foreground">
                      Çevrimdışı kopya: {formatTurkishTimeAgo(item.cachedAt)}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
