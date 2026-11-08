"use client";

import Link from "next/link";

import { useReadingDiet } from "./use-reading-diet";
import { ZONE_META } from "@/lib/bias/config";
import { nudgeZones, type DietZone } from "@/lib/diet/diet";
import type { DietSuggestion, ZoneSuggestions } from "@/lib/diet/suggestions";
import { ZONE_SOURCES_GENITIVE, zoneNewsCount } from "@/lib/diet/zone-copy";

interface LeastReadNudgeProps {
  lists: ZoneSuggestions | null;
}

// Client nudge fed by the server-fetched suggestion lists (`lists`); the
// least-read side(s) are picked here, client-side, from the device-local
// diet — so the server never learns which zone a reader is short on.
//
// `nudgeZones` decides who is named: nothing below the page's own 10-click
// floor (DietSummary's "Az veri var" line is the only guidance there), every
// side that is still tied instead of whichever comes first on the spectrum,
// and nothing when all three sides are level.
//
// Zone phrases come from zone-copy, never ZONE_META label plus a suffix:
// "Bağımsız" is an adjective ("Bağımsız kaynakların", "3 Bağımsız haber"), see
// src/lib/weekly/zone-media-label.ts.
export function LeastReadNudge({ lists }: LeastReadNudgeProps) {
  const { hydrated, available, summary } = useReadingDiet();

  if (!hydrated || !available || !lists) return null;

  const tied = nudgeZones(summary);

  // The server builds one list per zone, so the same story can appear in two
  // tied sides' lists. Show each story once, under the side where it carries
  // more of the coverage (larger zoneCount); on a tie the earlier side in
  // spectrum order keeps it. The server lists stay per-zone and unchanged, so
  // the dedupe has to happen here, where the tied sides are known.
  const owner = new Map<string, { zone: DietZone; zoneCount: number }>();
  for (const zone of tied) {
    for (const item of lists[zone]) {
      const current = owner.get(item.id);
      if (current === undefined || item.zoneCount > current.zoneCount) {
        owner.set(item.id, { zone, zoneCount: item.zoneCount });
      }
    }
  }

  const sections = tied
    .map((zone) => ({
      zone,
      items: lists[zone].filter((item) => owner.get(item.id)?.zone === zone),
    }))
    .filter((section) => section.items.length > 0);

  const first = sections[0];
  if (!first) return null;

  // Tied sides share the same 7-day count, so one number serves them all.
  const clickCount = summary.counts[first.zone];

  if (sections.length === 1) {
    const label = ZONE_META[first.zone].label;
    const items = first.items;

    return (
      <section className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4">
        <div>
          <h2 className="text-sm font-semibold">
            {`Bu hafta en az okuduğunuz taraftan ${items.length} güncel başlık`}
          </h2>
          <p className="text-sm text-muted-foreground">
            En az okuduğunuz taraf: {label} ({clickCount} tıklama). {ZONE_SOURCES_GENITIVE[first.zone]}{" "}
            ağırlıkta olduğu, birden çok kaynağın yazdığı güncel hikâyeler; sayfada diğer tarafların
            başlıkları da yan yana.
          </p>
        </div>
        <HeadlineList zone={first.zone} items={items} />
      </section>
    );
  }

  const labels = sections.map((section) => ZONE_META[section.zone].label).join(" ve ");

  return (
    <section className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4">
      <div>
        <h2 className="text-sm font-semibold">
          Bu hafta en az okuduğunuz iki taraftan güncel başlıklar
        </h2>
        <p className="text-sm text-muted-foreground">
          {`En az okuduğunuz taraflar: ${labels} (ikisi de ${clickCount} tıklama). ` +
            "Her taraf için o tarafın kaynaklarının ağırlıkta olduğu, birden çok kaynağın yazdığı güncel hikâyeler; " +
            "sayfada diğer tarafların başlıkları da yan yana."}
        </p>
      </div>
      {sections.map((section) => (
        <div key={section.zone} className="space-y-2">
          <h3 className="text-sm font-medium">{ZONE_META[section.zone].label}</h3>
          <HeadlineList zone={section.zone} items={section.items} />
        </div>
      ))}
    </section>
  );
}

function HeadlineList({ zone, items }: { zone: DietZone; items: readonly DietSuggestion[] }) {
  return (
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
            {zoneNewsCount(item.zoneCount, zone)} · toplam {item.totalCount} haber
          </p>
        </li>
      ))}
    </ul>
  );
}
