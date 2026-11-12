import type { Metadata } from "next";
import Link from "next/link";

import { SavedList } from "@/components/bookmark/saved-list";
import { ListTransferPanel } from "@/components/transfer/list-transfer-panel";
import { noindexPageMetadata } from "@/lib/seo/page-metadata";

// Server shell around the client SavedList. Bookmarks live in
// localStorage, so all data work happens client-side; this wrapper exists
// to own the route metadata (a "use client" page can't export it).
// Per-user page — nothing for crawlers here (noindex, nofollow).
export const metadata: Metadata = noindexPageMetadata({
  title: "Kaydedilenler",
  description: "Kaydettiğiniz hikâyeler.",
  path: "/saved",
  follow: false,
});

export default function SavedPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight mb-4">
        Kaydedilenler
      </h1>
      <p className="-mt-2 mb-1 text-[12px] text-muted-foreground">
        Hangi taraftan ne kadar okuduğunuzu görmek için:{" "}
        <Link
          href="/diyetim"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Haber diyetim
        </Link>
      </p>
      <p className="mb-4 text-[12px] text-muted-foreground">
        Takip ettiğiniz konu, kişi ve kelimelerdeki yeni haberler:{" "}
        <Link
          href="/takip"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Takip ettiklerim
        </Link>
      </p>
      <ListTransferPanel />
      <SavedList />
    </div>
  );
}
