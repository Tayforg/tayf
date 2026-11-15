"use client";

import { useEffect } from "react";

import { markStorySeen } from "@/components/bookmark/bookmark-snapshots";
import { useBookmarks } from "@/components/bookmark/use-bookmarks";

// Opening a saved story's page marks it seen on this device (h185-roadmap2-2), so the /saved badge
// "kaydettiğinizden beri yeni gelişme" can clear once the reader has read the story: markStorySeen stores a
// `seenUpdatedAt` in the story's existing snapshot entry, and the next /saved load rebaselines a story that has
// not changed since (reconcileSnapshots).
//
// Renders nothing: no layout shift, no live region, no copy. Client-only and synchronous: no request, no new
// storage key (an unsaved story's page writes nothing, markStorySeen needs a snapshot to exist).
//
// Takes the cluster id and the server stamp (`clusters.updated_at`) of the copy the page rendered, never a count
// and never the client clock. The stamp is what /saved compares with the cluster's current `updated_at`: the
// service worker can serve a saved story from a stale copy, and a stamp taken from the device clock would be
// later than the cluster's real change and clear a badge for news the reader never saw. The page's own source
// count is the wire-collapsed one, which is not the measure /saved compares (saved_clusters_v4, migration 192;
// known gap h139-followup-1), so no count and no member list is passed in and none is compared here.
//
// useBookmarks reads "not saved" on the server and during hydration, then the real list, so the effect keyed
// on that boolean runs once the store has answered, and again only if the story is saved again later.
// Same light imports as BookmarkButton (tests/guards/public-client-weight.test.ts).

export function SavedSeenMark({ clusterId, updatedAt }: { clusterId: string; updatedAt: string }) {
  const { has } = useBookmarks();
  const saved = has(clusterId);

  useEffect(() => {
    if (saved) markStorySeen(clusterId, updatedAt);
  }, [saved, clusterId, updatedAt]);

  return null;
}
