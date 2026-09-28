import Link from "next/link";

interface DailyGameTeaserProps {
  /** When given, appended to the title as " #N" (the puzzle number). */
  puzzleNumber?: number;
}

/**
 * A static Server Component teaser for "Günün Tayf'ı", meant for the home
 * page. NOT mounted anywhere yet (mounting src/app/page.tsx is out of
 * scope for this file set — see the daily-game (gunun-tayfi) spec's file
 * ownership list, which does not include page.tsx). A future pass wires
 * this into the home page.
 */
export function DailyGameTeaser({ puzzleNumber }: DailyGameTeaserProps) {
  const title =
    typeof puzzleNumber === "number" ? `Günün Tayf'ı #${puzzleNumber}` : "Günün Tayf'ı";

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4 space-y-2">
      <p className="font-serif text-lg">{title}</p>
      <p className="text-sm text-muted-foreground">5 manşet, 3 taraf. Hangisi hangi bölgeden?</p>
      <Link
        href="/oyun?mod=gunluk"
        className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        Oyna
      </Link>
    </div>
  );
}
