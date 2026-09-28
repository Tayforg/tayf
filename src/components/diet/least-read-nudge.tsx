"use client";

import Link from "next/link";

import { useReadingDiet } from "./use-reading-diet";
import { ZONE_META } from "@/lib/bias/config";
import type { ZoneSuggestions } from "@/lib/diet/suggestions";

interface LeastReadNudgeProps {
  lists: ZoneSuggestions | null;
}

// Client nudge fed by the server-fetched suggestion lists (`lists`); the
// least-read zone itself is picked here, client-side, from the
// device-local diet — so the server never learns which zone a reader is
// short on.
export function LeastReadNudge({ lists }: LeastReadNudgeProps) {
  const { hydrated, available, summary } = useReadingDiet();

  if (!hydrated || !available || !summary.leastRead || !lists) return null;

  const zone = summary.leastRead;
  const items = lists[zone];
  if (items.length === 0) return null;

  const label = ZONE_META[zone].label;
  const clickCount = summary.counts[zone];

  return (
    <section className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4">
      <div>
        <h2 className="text-sm font-semibold">Bu hafta en az okuduğun taraftan 3 güncel başlık</h2>
        <p className="text-sm text-muted-foreground">
          En az okuduğun taraf: {label} ({clickCount} tıklama). {label} kaynaklarının ağırlıkta
          olduğu, birden çok kaynağın yazdığı güncel hikâyeler; sayfada diğer tarafların
          başlıkları da yan yana.
        </p>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={`/cluster/${item.id}`}
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              {item.title}
            </Link>
            <p className="text-[12px] text-muted-foreground">
              {item.zoneCount} {label} haberi · toplam {item.totalCount} haber
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
