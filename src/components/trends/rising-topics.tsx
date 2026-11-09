import Link from "next/link";

import { formatCountTr } from "@/lib/format/number-tr";
import { dayLabelTr } from "@/lib/trends/day-label";
import type { RisingResult } from "@/lib/trends/rising";

// "Yükselen Konular" card at the top of /trends (migration 112). Pure
// presentation over what `getRisingEntities()` returns: a ranked list, an
// honest "nothing rising" line, a "not enough history yet" line, or (null) a
// "could not compute" line, so a failed read never takes the chart down.
// Text colours use the full muted-foreground / brand tokens only (WCAG 1.4.3,
// tests/guards/text-contrast-tokens.test.ts).
//
// The ranked day is named by its date ("7 Kasım"), never "Bugün"/"Dün": the
// result sits in a cache entry served up to an hour (longer after an idle
// spell) past Istanbul midnight, so a relative word would label the finished
// day "Bugün" (h63-timezones-1). The date is derived from `data.day` and so is
// always true of the count printed next to it.
//
// Scope (h90-trends-1, migration 182). The count behind a row is politika and
// son_dakika headlines only, the same scope as the /gundem hub the row links to
// (isPoliticsMember), so the caption says so. The vocabulary is not only people,
// institutions and countries (enflasyon, faiz, dolar, borsa, asgari ücret are in
// it), hence "konular". The count goes through formatCountTr, never a bare
// toLocaleString("tr-TR") (some ICU builds print "1234").

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
        Siyaset ve son dakika başlıklarında son 7 günün ortalamasından belirgin biçimde fazla
        geçen kişi, kurum, ülke ve konular · yalnızca spektruma sayılan kaynaklar · saatte bir
        güncellenir
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
        <p className="text-sm text-muted-foreground">
          {`${dayLabelTr(data.day)} sayımında belirgin bir yükseliş yok.`}
        </p>
      ) : (
        <ol className="grid gap-2 sm:grid-cols-2">
          {data.items.map((item) => (
            <li key={item.key} className="text-sm">
              {/* A row whose hub is thin links to the home search (rising.ts
                  withHubLinks). That route is request-time and DB-backed, so it
                  is not prefetched; a /gundem hub is prerendered and is. */}
              <Link
                href={item.href}
                prefetch={item.href.startsWith("/gundem/") ? undefined : false}
                className="font-semibold text-foreground underline decoration-dotted underline-offset-2 hover:text-brand"
              >
                {item.label}
              </Link>
              <span className="block text-[12px] text-muted-foreground">
                {`${dayLabelTr(data.day)}: ${formatCountTr(item.count)} haber · ${
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
