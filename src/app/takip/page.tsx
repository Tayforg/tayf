import type { Metadata } from "next";
import Link from "next/link";

import { FollowFeed } from "@/components/follow/follow-feed";

// Server shell around the client FollowFeed. Follows live in localStorage, so
// all data work happens client-side (via GET /api/takip); this wrapper exists
// to own the route metadata (a "use client" page can't export it). Same shape
// as /saved.
//
// Privacy note: the LIST lives in localStorage, but on every visit each
// followed keyword / topic is sent to the server (GET /api/takip?q=...) to
// fetch its matches. The route neither logs nor stores it, yet platform
// request logs can still see the URL -- so the copy must not say "only on this
// device" (compare /diyetim, which really never leaves the device).
export const metadata: Metadata = {
  title: "Takip ettiklerim",
  description: "Takip ettiğiniz konu ve anahtar kelimelerle eşleşen hikâyeler.",
  alternates: { canonical: "/takip" },
  // Per-user page — nothing for crawlers here.
  robots: { index: false, follow: false },
};

export default function TakipPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight mb-4">
        Takip ettiklerim
      </h1>
      <p className="-mt-2 mb-4 text-[12px] text-muted-foreground">
        Takip listeniz bu cihazda saklanır; eşleşen hikâyeleri getirmek için takip
        ettiğiniz anahtar kelimeler ve konular Tayf sunucusuna gönderilir.
        Veritabanına yazılmaz, bir hesapla ilişkilendirilmez.{" · "}
        <Link
          href="/saved"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Kaydedilenler
        </Link>
      </p>
      <FollowFeed />
    </div>
  );
}
