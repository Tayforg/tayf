import type { Metadata } from "next";
import Link from "next/link";
import { Compass } from "lucide-react";

// Real 404s (browser-qa-5 / seo-1): src/middleware.ts rewrites malformed
// /konu, /ekonomi and /cluster segments here so Next renders this page with
// the site's own chrome and a genuine 404 status. Without this metadata,
// Next's error-convention metadata resolver (resolve-metadata.js's
// collectMetadata()) would still merge the root layout's `alternates.
// canonical: "/"` and default `robots: index,follow` into the streamed
// 404 — this must never look like a duplicate of the homepage.
// `openGraph` deliberately carries no `url` key: an inherited/merged one
// would claim the homepage as this page's canonical social URL.
export const metadata: Metadata = {
  title: "Sayfa bulunamadı",
  description: "Aradığınız sayfa bulunamadı.",
  robots: { index: false, follow: true },
  alternates: { canonical: null },
  openGraph: {
    title: "Sayfa bulunamadı — Tayf",
    siteName: "Tayf",
    locale: "tr_TR",
    type: "website",
  },
};

export default function NotFound() {
  return (
    <div className="container mx-auto px-4 py-24 max-w-lg">
      <div className="flex flex-col items-center text-center space-y-4">
        <div className="h-14 w-14 rounded-full border border-border/60 bg-muted/40 flex items-center justify-center">
          <Compass className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Sayfa bulunamadı</h1>
        <p className="text-sm text-muted-foreground leading-relaxed max-w-md">
          Aradığınız sayfa taşınmış, silinmiş veya hiç var olmamış olabilir.
          Haberlere dönüp devam edin.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-full bg-foreground text-background px-4 py-2 text-sm font-medium hover:bg-foreground/90 transition-colors"
        >
          Ana sayfaya dön
        </Link>
      </div>
    </div>
  );
}
