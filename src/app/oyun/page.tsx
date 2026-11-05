import type { Metadata } from "next";
import { connection } from "next/server";
import Link from "next/link";

import { PageHero } from "@/components/ui/page-hero";
import { OyunModes } from "@/components/game/oyun-modes";
import { loadGameHeadlines, sampleHeadlines } from "@/lib/game/headline-pool";
import { GAME_SESSION_SIZE } from "@/lib/game/round-size";
import { getDailyPuzzle } from "@/lib/game/daily-query";
import { istanbulDateKey, resolvePuzzleDateWithReason } from "@/lib/game/daily-set";
import { currentTimeMs } from "@/lib/time";
import { staticPageMetadata } from "@/lib/seo/page-metadata";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
// staticPageMetadata also sets its own og:* / twitter:* url, title and image.
//
// h36-journeys-3: the hero and the description are shared by all three modes, so
// they name no per-mode numbers. "60 saniye" and "10 manşet" belong to Bölge
// alone (its idle line in zone-guess-game.tsx) and Günün Tayf'ı is 5 headlines
// with no timer; the per-mode explainer lives in oyun-modes.tsx.
export const metadata: Metadata = staticPageMetadata({
  title: "Tarafı tahmin et",
  description:
    "Manşetleri oku, hangi taraftan bir kaynağın yazdığını tahmin et: 60 saniyelik Bölge turu, Çerçeve oylaması ve herkes için aynı 5 manşetlik Günün Tayf\u2019ı.",
  path: "/oyun",
});

/**
 * The mode-neutral masthead copy above the mode switch (exported for the unit
 * test). The H1 stays a literal `title="..."` on the <PageHero> below, not a
 * field here: tests/app/page-title-sentence-case.test.ts reads that literal to
 * keep the H1 and the <title> in agreement.
 */
export const OYUN_HERO = {
  kicker: "Oyun",
  subtitle:
    "Manşeti oku, hangi taraftaki bir kaynağın yazdığını tahmin et. Üç mod: Bölge, Çerçeve ve Günün Tayf\u2019ı.",
} as const;

// /oyun — three games behind one mode switch (OyunModes, "use client"),
// picked from a Server Component that fetches the Bölge headline pool
// (loadGameHeadlines: the cached pool plus one live retry, sampled per
// request; `null` means the fetch failed, `[]` means nothing qualifies) and
// the Günün Tayf'ı daily puzzle (getDailyPuzzle, cached for days per date
// key) and hands both down as props.
//
// THE COOKIE/STORAGE SPLIT (read this before assuming "no cookies" covers
// the whole page — it no longer does):
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
//   - Günün Tayf'ı (gunun-tayfi, daily): sets NO cookie either. Each guess
//     POSTs to the SAME `POST /api/oyun` route Bölge uses (the SAME
//     `zone_guesses` table, migration 057) — nothing new is stored
//     server-side. The only new persistence is a client-only localStorage
//     streak/result store (daily-share.ts's `tayf-gunun-tayfi-v1` key),
//     which never leaves the browser.
//
// The server sends each Bölge headline's source name/bias/zone down WITH
// the headline (ZoneGuessGame needs it for the reveal step) — hiding it
// client-side would be theatre, not security. The client-side score is
// NOT authoritative: POST /api/oyun recomputes `correct` server-side from
// `sources.bias` and its response is never even read by the client, so a
// tampered client only ever corrupts its own local score. Do not later
// "optimise" the API by trusting a client-supplied `correct` value. The
// same rule applies to Günün Tayf'ı's guesses — same route, same
// server-side recompute.
export default async function OyunPage({
  searchParams,
}: {
  searchParams: Promise<{ mod?: string; gun?: string | string[] }>;
}) {
  // connection() signals to PPR that this must run at request time; the
  // root `src/app/loading.tsx` Suspense boundary provides the shell while
  // this streams in (this route has no more specific loading.tsx).
  await connection();

  const sp = await searchParams;
  // currentTimeMs() (src/lib/time.ts), never a direct `Date.now()` here —
  // this repo's react-hooks/purity lint forbids reading the clock directly
  // in a Server Component body. The daily puzzle fetch below (getDailyPuzzle)
  // is itself a "use cache" function that reads NO clock at all — every
  // date it touches is derived from `dateKey`, computed here, once, from
  // this one request-time read.
  const todayKey = istanbulDateKey(currentTimeMs());
  const { dateKey, fellBack } = resolvePuzzleDateWithReason(sp.gun, todayKey);
  const initialMode = sp.mod === "gunluk" || sp.gun ? "gunluk" : "bolge";

  const [headlines, daily] = await Promise.all([
    loadGameHeadlines().then((pool) =>
      pool === null ? null : sampleHeadlines(pool, GAME_SESSION_SIZE),
    ),
    getDailyPuzzle(dateKey),
  ]);

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl space-y-6">
      <PageHero kicker={OYUN_HERO.kicker} title="Tarafı tahmin et" subtitle={OYUN_HERO.subtitle} />

      <OyunModes
        headlines={headlines}
        daily={daily}
        todayKey={todayKey}
        dailyFellBack={fellBack}
        initialMode={initialMode}
      />

      {/* Register exception (h19-copy-2): /oyun keeps the informal sen register
          on purpose; the game talks to the player. The rest of the site uses siz. */}
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
      </div>
    </div>
  );
}
