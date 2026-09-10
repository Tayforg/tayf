import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { DM_Serif_Display, Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";
import { KbdShortcuts } from "@/components/kbd-shortcuts";
import { Analytics } from "@vercel/analytics/next";
import { siteUrl } from "@/lib/site-url";
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
  },
  alternates: {
    canonical: "/",
    types: {
      "application/rss+xml": [
        { url: "/rss.xml", title: "Tayf — Haberler RSS" },
      ],
    },
  },
  icons: {
    icon: "/icon.svg",
    apple: "/apple-icon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
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
        <Suspense>
          <Header />
        </Suspense>
        {/* id is the skip-link target (header.tsx); tabIndex={-1} makes it programmatically focusable so Safari actually moves focus, not just scroll */}
        <main id="main" tabIndex={-1} className="flex-1">
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
