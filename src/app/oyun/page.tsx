import type { Metadata } from "next";
import { connection } from "next/server";
import Link from "next/link";

import { PageHero } from "@/components/ui/page-hero";
import { OyunModes } from "@/components/game/oyun-modes";
import { getGameHeadlines, sampleHeadlines } from "@/lib/game/headline-pool";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
export const metadata: Metadata = {
  title: "Tarafı Tahmin Et",
  description:
    "60 saniyede 10 manşet: hangi taraf yazdı, tahmin et. Tayf'ın 118 kaynak etiketi için oyuncuların ilk dış çapraz kontrolü.",
  alternates: { canonical: "/oyun" },
};

// /oyun — two games behind one mode switch (OyunModes, "use client"),
// picked from a Server Component that fetches the Bölge headline pool
// (getGameHeadlines, cached + rotating) and hands it down as a prop.
//
// THE COOKIE SPLIT (read this before assuming "no cookies" covers the
// whole page — it no longer does):
//   - Bölge (zone-guess, unchanged): still sets NO cookie and collects NO
//     identifier of any kind, on this page or from the client. Its POST
//     /api/oyun response is never even read by the client — see
//     zone-guess-game.tsx's doc comment.
//   - Çerçeve (framing-vote, R10): its two API routes
//     (api/oyun/cerceve/{next,route}.ts) DO set one first-party, HttpOnly,
//     opaque-random cookie (`tayf_cerceve_sid`) so a reader's crowd vote
//     can be deduplicated per headline. Only that cookie's sha256 ever
//     reaches the database — never an IP, never a user agent, never a
//     login. The raw cookie value never leaves the browser.
//
// The server sends each Bölge headline's source name/bias/zone down WITH
// the headline (ZoneGuessGame needs it for the reveal step) — hiding it
// client-side would be theatre, not security. The client-side score is
// NOT authoritative: POST /api/oyun recomputes `correct` server-side from
// `sources.bias` and its response is never even read by the client, so a
// tampered client only ever corrupts its own local score. Do not later
// "optimise" the API by trusting a client-supplied `correct` value.
export default async function OyunPage() {
  // connection() signals to PPR that this must run at request time; the
  // root `src/app/loading.tsx` Suspense boundary provides the shell while
  // this streams in (this route has no more specific loading.tsx).
  await connection();

  const headlines = sampleHeadlines(await getGameHeadlines());

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl space-y-6">
      <PageHero
        kicker="60 saniyelik oyun"
        title="Tarafı Tahmin Et"
        subtitle="10 manşet, 3 seçenek: İktidar, Bağımsız, Muhalefet. Hangi kaynağın hangi tarafta yazdığını tahmin et."
      />

      <div className="rounded-xl border border-border/60 bg-card/40 p-4 text-[13px] text-muted-foreground leading-relaxed space-y-2">
        <p>
          Bir tahmin bir hüküm değildir. Burada doğru bilme oranın, bir
          kaynağın &ldquo;gerçekte&rdquo; nasıl yazdığının kanıtı değildir —
          sadece oyuncuların o kaynağı nasıl algıladığının bir ölçüsüdür.
          Oyuncular yaş, şehir ve siyasi görüş açısından rastgele bir
          örneklem değildir; bu yüzden toplu bir sonuç her zaman
          &ldquo;oyuncuların %N&rsquo;i&rdquo; diye okunmalı, hiçbir zaman bir
          kaynak hakkında bir hüküm diye değil.
        </p>
        <p>
          Tayf&rsquo;ın kaynakları nasıl sınıflandırdığını{" "}
          <Link
            href="/metodoloji"
            className="underline underline-offset-2 hover:text-foreground"
          >
            metodoloji sayfasında
          </Link>{" "}
          okuyabilirsin.
        </p>
        <p>
          Çerçeve modunda ise kaynağı değil, başlığın kendisini
          değerlendiriyorsun: bu başlık kimin lehine yazılmış?
        </p>
      </div>

      <OyunModes headlines={headlines} />
    </div>
  );
}
