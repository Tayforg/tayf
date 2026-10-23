"use client";

import { useEffect } from "react";

import { readBookmarkIds } from "@/lib/pwa/offline-pins";
import {
  registerServiceWorker,
  type CacheStorageLike,
  type SwContainerLike,
} from "@/lib/pwa/register";
import { SW_KILL } from "@/lib/pwa/sw-contract";

// Mounted once in the root layout, behind a production check there. The
// checks below repeat it so the component is inert on its own in dev/test.
// Registration waits for the window load event so the worker's install-time
// precache never competes with the page's own critical requests.
//
// Once per document: every run posts a sync, and each sync can make the worker
// render up to three cluster pages on the server. Soft navigations and
// router.refresh() (which re-renders this subtree) must not repeat it, so the
// effect has an empty dependency array and `started` outlives remounts.
let started = false;

export function SwRegistrar(): null {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    let container: SwContainerLike | undefined;
    try {
      container = navigator.serviceWorker as unknown as SwContainerLike;
    } catch {
      // Firefox can throw a SecurityError when storage/cookies are blocked.
      return;
    }

    let cachesLike: CacheStorageLike | undefined;
    try {
      cachesLike = typeof caches === "undefined" ? undefined : caches;
    } catch {
      // Blocked storage can throw on access; the kill switch then only unregisters.
    }

    const run = () => {
      if (started) return;
      started = true;
      void registerServiceWorker({
        nodeEnv: process.env.NODE_ENV,
        container,
        kill: SW_KILL,
        readIds: () => readBookmarkIds(),
        cachesLike,
      });
    };

    if (document.readyState === "complete") {
      run();
      return;
    }
    window.addEventListener("load", run, { once: true });
    return () => window.removeEventListener("load", run);
  }, []);

  return null;
}
