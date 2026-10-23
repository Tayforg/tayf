import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { StatusView } from "@/components/status/status-view";
import { PageHero } from "@/components/ui/page-hero";
import { getPublicStatus } from "@/lib/status/public-status";
import { buildStatusView } from "@/lib/status/verdict";
import { staticPageMetadata } from "@/lib/seo/page-metadata";

// /durum ("Sistem durumu") — a public, plain-language answer to "is Tayf
// keeping up?": how fresh the newest article, cluster and classification are,
// and how many sources have gone quiet. It shows only summary numbers from
// public.public_status_snapshot() (migration 110); the operator view stays in
// ops_health_report(), which is not public.
//
// Own metadata so the page does not inherit the root layout's title and
// `canonical: "/"`. It is indexable on purpose (listed in the static sitemap);
// the "snapshot unavailable" state adds its own `noindex` meta, so an outage
// is never indexed as the page's content.
// staticPageMetadata also sets its own og:* / twitter:* url, title and image.
export const metadata: Metadata = staticPageMetadata({
  title: "Sistem durumu",
  description:
    "Tayf’ın haber toplama, kümeleme ve sınıflandırma adımlarının ne kadar güncel olduğu — yaklaşık dakikada bir güncellenir.",
  path: "/durum",
});

// Synchronous static shell (hero + skeleton) so it prerenders; the data read
// streams in behind <Suspense>.
export default function DurumPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl space-y-6">
      <PageHero
        kicker="Şeffaflık"
        title="Sistem durumu"
        subtitle="Tayf’ın haberleri ne kadar güncel topladığını, kümelediğini ve sınıflandırdığını gösterir. Sayılar yaklaşık dakikada bir yenilenir; birkaç dakikalık fark olağandır."
      />
      <Suspense fallback={<DurumSkeleton />}>
        <DurumBody />
      </Suspense>
    </div>
  );
}

function DurumSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="h-28 rounded-xl border border-border/60 bg-card/40" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="h-24 rounded-xl border border-border/60 bg-card/40" />
        <div className="h-24 rounded-xl border border-border/60 bg-card/40" />
        <div className="h-24 rounded-xl border border-border/60 bg-card/40" />
      </div>
      <p className="sr-only">Sistem durumu yükleniyor.</p>
    </div>
  );
}

// Named export so page.test.tsx can drive the null / snapshot branches without
// a renderer that resolves async Server Components. connection() marks the
// read as request-time: the cached snapshot is at most a few minutes old (the
// `status` cacheLife profile), but the page must not be frozen into the
// build-time shell.
export async function DurumBody() {
  await connection();
  const s = await getPublicStatus();
  return <StatusView view={s ? buildStatusView(s) : null} />;
}
