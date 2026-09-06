import Link from "next/link";

const NAV_LINKS = [
  { href: "/", label: "Haberler" },
  { href: "/blindspots", label: "Kör Noktalar" },
  { href: "/sources", label: "Kaynaklar" },
  { href: "/timeline", label: "Zaman Akışı" },
  { href: "/trends", label: "Trendler" },
  { href: "/metodoloji", label: "Metodoloji" },
  { href: "/metodoloji#duzeltme", label: "İletişim" },
] as const;

export function Footer() {
  return (
    <footer className="border-t border-border/30 mt-16">
      <div className="container mx-auto px-4 sm:px-6 py-10 max-w-5xl">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          {/* Brand block */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex gap-[2px] h-5 items-end">
                <div className="w-[2px] h-2 rounded-full bg-red-500/50" />
                <div className="w-[2px] h-3.5 rounded-full bg-brand/60" />
                <div className="w-[2px] h-2.5 rounded-full bg-emerald-500/50" />
              </div>
              <span className="font-serif text-base tracking-tight text-foreground/80">
                Tayf
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground/60 max-w-xs leading-relaxed">
              Aynı haber, farklı dünyalar. 144 Türk kaynağından otomatik
              kümelenmiş politika haberleri ve medya yanlılığı analizi.
            </p>
          </div>

          {/* Navigation */}
          <nav className="flex flex-wrap gap-x-5 gap-y-2">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-[11px] text-muted-foreground/50 hover:text-foreground transition-colors"
              >
                {link.label}
              </Link>
            ))}
            <Link
              href="/rss.xml"
              className="text-[11px] text-muted-foreground/50 hover:text-brand transition-colors"
            >
              RSS
            </Link>
          </nav>
        </div>

        {/* Bottom rule */}
        <div className="mt-8 pt-5 border-t border-border/20 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/40">
            2026 Tayf
          </span>
          <div className="h-[1px] flex-1 mx-6 bg-gradient-to-r from-red-500/10 via-brand/15 to-emerald-500/10" />
          <span className="text-[10px] text-muted-foreground/40 font-mono">
            144 kaynak
          </span>
        </div>
      </div>
    </footer>
  );
}
