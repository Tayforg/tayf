import type { Metadata } from "next";

import { OfflineSavedList } from "@/components/pwa/offline-saved-list";
import { noindexPageMetadata } from "@/lib/seo/page-metadata";

// Offline fallback served by the service worker when a navigation fails. It is
// precached at install, so this module must stay a fully static shell: no data
// fetch, no Supabase, no request-time APIs (connection()/cookies()). The list
// of saved stories is read on the client from the worker's own cache.
// Per-device page, nothing for crawlers (noindex, nofollow) and not in the sitemaps.
export const metadata: Metadata = noindexPageMetadata({
  title: "Çevrimdışı",
  description: "Bağlantı yokken bu cihazdaki kayıtlı hikâyeler.",
  path: "/offline",
  follow: false,
});

export default function OfflinePage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight mb-2">
        Çevrimdışısın
      </h1>
      <p className="text-sm text-muted-foreground mb-4">
        Şu an internete bağlı değilsin ya da bağlantın çok yavaş. Bağlantı geri geldiğinde sayfayı
        yenileyebilirsin.
      </p>
      <OfflineSavedList />
    </div>
  );
}
