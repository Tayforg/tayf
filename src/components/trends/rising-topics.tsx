import Link from "next/link";

import type { RisingResult } from "@/lib/trends/rising";

// "Yükselen Konular" card at the top of /trends (migration 112). Pure
// presentation over what `getRisingEntities()` returns: a ranked list, an
// honest "nothing rising" line, a "not enough history yet" line, or (null) a
// "could not compute" line, so a failed read never takes the chart down.
// Text colours use the full muted-foreground / brand tokens only (WCAG 1.4.3,
// tests/guards/text-contrast-tokens.test.ts).

export function RisingTopics({ data }: { data: RisingResult | null }) {
  return (
    <section
      aria-labelledby="yukselen-konular"
      className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-6 space-y-3"
    >
      <h2 id="yukselen-konular" className="font-serif text-lg font-semibold">
        Yükselen Konular
      </h2>
      <p className="text-xs text-muted-foreground">
        Başlıklarda son 7 günün ortalamasından belirgin biçimde fazla geçen kişi, kurum ve
        ülkeler · yalnızca spektruma sayılan kaynaklar · saatte bir güncellenir
      </p>

      {data === null ? (
        <p className="text-sm text-muted-foreground">
          Yükselen konular şu anda hesaplanamıyor.
        </p>
      ) : data.status === "insufficient" ? (
        <p className="text-sm text-muted-foreground">
          Yükselen konular için yeterli geçmiş veri henüz yok.
        </p>
      ) : data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Bugün belirgin bir yükseliş yok.</p>
      ) : (
        <ol className="grid gap-2 sm:grid-cols-2">
          {data.items.map((item) => (
            <li key={item.key} className="text-sm">
              <Link
                href={item.href}
                className="font-semibold text-foreground underline decoration-dotted underline-offset-2 hover:text-brand"
              >
                {item.label}
              </Link>
              <span className="block text-[12px] text-muted-foreground">
                {`${data.dayLabel} ${item.count.toLocaleString("tr-TR")} haber · ${
                  item.isNew
                    ? "geçen hafta neredeyse hiç yoktu"
                    : `7 günlük ortalamanın ${item.ratioIsLowerBound ? "en az " : ""}${item.ratioLabel} katı`
                }`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
