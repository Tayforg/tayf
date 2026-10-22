import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { DM_Serif_Display, Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { Header, HeaderFallback } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";
import { KbdShortcuts } from "@/components/kbd-shortcuts";
import { Analytics } from "@vercel/analytics/next";
import { siteUrl } from "@/lib/site-url";
import { buildSiteJsonLd, serializeJsonLd } from "@/lib/seo/json-ld";
import "./globals.css";

// Editorial serif for headlines — authoritative, warm character.
// DM Serif Display has excellent Turkish glyph coverage (İ/ı/ğ/ş/ç/ö/ü).
const serif = DM_Serif_Display({
  variable: "--font-serif",
  subsets: ["latin", "latin-ext"],
  weight: "400",
  display: "swap",
});

// Humanist sans for body — geometric but friendly. Excellent readability
// at small sizes and full Turkish coverage.
const sans = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

// Monospace for data labels and badges.
const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

export const metadata: Metadata = {
  // Same origin the newsletter/digest links are built from (src/lib/site-url.ts).
  metadataBase: new URL(siteUrl()),
  title: {
    default: "Tayf — Türkiye Haber Analizi",
    template: "%s — Tayf",
  },
  description:
    "Aynı haber, farklı dünyalar. Türk haber kaynaklarından otomatik kümelenmiş politika haberleri, medya yanlılığı analizi ve kör nokta tespiti.",
  keywords: [
    "haber",
    "türkiye",
    "politika",
    "medya",
    "yanlılık",
    "kör nokta",
    "haber analizi",
  ],
  authors: [{ name: "Tayf" }],
  creator: "Tayf",
  openGraph: {
    type: "website",
    locale: "tr_TR",
    url: "/",
    siteName: "Tayf",
    title: "Tayf — Türkiye Haber Analizi",
    description:
      "Aynı haber, farklı dünyalar. Türk medyasının aynı habere bakışını tek ekranda görün.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Tayf — Türkiye Haber Analizi",
    description: "Aynı haber, farklı dünyalar.",
  },
  robots: {
    index: true,
    follow: true,
    "max-image-preview": "large",
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
    },
  },
  // Search-console ownership verification. Each env var is optional — an
  // unset one drops its key entirely (Next omits `undefined` metadata
  // fields) instead of emitting an empty/placeholder verification tag.
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
    yandex: process.env.YANDEX_VERIFICATION || undefined,
    other: process.env.BING_VERIFICATION
      ? { "msvalidate.01": process.env.BING_VERIFICATION }
      : undefined,
  },
  alternates: {
    canonical: "/",
    types: {
      "application/rss+xml": [
        { url: "/rss.xml", title: "Tayf — Haberler RSS" },
      ],
    },
  },
  // browser-qa-13: no hard-coded `icons` key — favicon.ico, icon.svg and
  // the apple-touch-icon route under src/app/ are file-convention routes
  // Next.js 16 wires into <link> tags automatically. The old hard-coded
  // apple-icon entry pointed at a plain SVG, which iOS's "Add to Home
  // Screen" cannot route as an apple-touch-icon at all.
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Dark-only site (<html class="dark">): one theme-color, no media split.
  // #0c0806 is --background oklch(0.14 0.008 60) as measured by Lighthouse.
  themeColor: "#0c0806",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="tr"
      className={`${serif.variable} ${sans.variable} ${mono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col">
        {/* seo-4/seo-5: sitewide Organization + WebSite graph, once per
            page load — gives every page a stable entity to hang
            NewsArticle.publisher (cluster/[id]/page.tsx) off of, and lets
            Google attach a Sitelinks search box / knowledge panel to the
            site itself. Same script-injection-safety rationale as the
            per-page NewsArticle/BreadcrumbList blocks: `serializeJsonLd`
            escapes every "<" so this can never terminate the element early
            (buildSiteJsonLd's inputs are all static/env-derived, but the
            escape costs nothing and keeps the pattern uniform). */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(buildSiteJsonLd()) }}
        />
        {/* Header no longer suspends (only <HeaderNav> inside it does), so
            this fallback is a safety net that reserves the header's 59px. */}
        <Suspense fallback={<HeaderFallback />}>
          <Header />
        </Suspense>
        {/* id is the skip-link target (header.tsx); tabIndex={-1} makes it programmatically focusable so Safari actually moves focus, not just scroll.
            min-h reserves one small viewport minus the 59px header (keep in
            sync with HeaderFallback in header.tsx; layout-main.test.ts pins
            both). Under a short loading.tsx skeleton the footer therefore
            starts below the first viewport instead of painting inside it and
            being pushed off-screen when content streams in — moving an
            off-screen element is not counted as CLS (browser-2: 0.27 on
            /sources desktop). Genuinely short pages (404, error boundary)
            keep their content at the top with the footer just below the fold. */}
        <main id="main" tabIndex={-1} className="flex-1 min-h-[calc(100svh-59px)]">
          {children}
        </main>
        <Footer />
        <KbdShortcuts />
        {/* Dev builds would load va.vercel-scripts.com, which the CSP script-src blocks. */}
        {process.env.NODE_ENV === "production" ? <Analytics /> : null}
      </body>
    </html>
  );
}
