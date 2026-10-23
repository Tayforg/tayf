import Link from "next/link";

import { BalanceChip } from "@/components/story/balance-chip";
import { BLINDSPOT, ZONE_META } from "@/lib/bias/config";
import { nearSharePercent } from "@/lib/clusters/near-blindspot-rule";
import type { NearBlindspotItem } from "@/lib/clusters/near-blindspots-query";

// "Kör noktaya yakın" band under the /blindspots feed: stories where one zone
// owns most of the voting sources but stays below the blindspot threshold.
// Server-safe on purpose (no 'use client', no hooks). `null` (fetch failed)
// and `[]` both hide the section: a failure must never read as "nothing is
// near a blindspot", and an empty band is not worth a heading.
//
// Strings that mix text and numbers are built as ONE template literal so the
// server markup keeps them contiguous (JSX would split them with comment nodes).
export function NearBlindspotList({ items }: { items: NearBlindspotItem[] | null }) {
  if (items === null || items.length === 0) return null;

  const thresholdPct = Math.round(BLINDSPOT.dominantShare * 100);

  return (
    <section
      aria-labelledby="kor-noktaya-yakin"
      className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4 sm:p-5"
    >
      <h2 id="kor-noktaya-yakin" className="font-serif text-sm font-semibold">
        Kör noktaya yakın
      </h2>
      <p className="max-w-[65ch] text-xs text-muted-foreground leading-relaxed">
        {`Bir bölgenin ağırlıkta olduğu ama kör nokta eşiğinin (%${thresholdPct}) altında kalan haberler. Kör nokta sayılmazlar; yukarıdaki listeye ve “Bu listede kim yer vermedi?” özetine katılmazlar.`}
      </p>
      <ul className="divide-y divide-border/40">
        {items.map((item) => {
          const meta = ZONE_META[item.dominantZone];
          return (
            <li
              key={item.id}
              className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <Link
                href={`/cluster/${item.id}`}
                className="min-w-0 font-serif text-sm font-medium text-foreground underline-offset-2 hover:underline"
              >
                {item.title}
              </Link>
              <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px]">
                <span
                  className={`inline-flex items-center rounded-full ${meta.chipBg} ${meta.chipBorder} border px-2.5 py-0.5 font-serif font-semibold ${meta.chipText}`}
                >
                  {`%${nearSharePercent(item.dominantShare)} ${meta.label}`}
                </span>
                <BalanceChip balance={item.balance} variant="compact" />
                <span className="text-muted-foreground">
                  {`${item.votingTotal} kaynak`}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        <Link
          href="/metodoloji#kor-noktaya-yakin"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Nasıl seçiliyor?
        </Link>
      </p>
    </section>
  );
}
