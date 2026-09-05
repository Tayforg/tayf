import type { Metadata } from "next";

import { SavedList } from "@/components/bookmark/saved-list";

// Server shell around the client SavedList. Bookmarks live in
// localStorage, so all data work happens client-side; this wrapper exists
// to own the route metadata (a "use client" page can't export it).
export const metadata: Metadata = {
  title: "Kaydedilenler",
  description: "Kaydettiğiniz hikâyeler.",
  alternates: { canonical: "/saved" },
  // Per-user page — nothing for crawlers here.
  robots: { index: false, follow: false },
};

export default function SavedPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight mb-4">
        Kaydedilenler
      </h1>
      <SavedList />
    </div>
  );
}
