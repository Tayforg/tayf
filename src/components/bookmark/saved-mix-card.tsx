import Link from "next/link";

import { savedMix, type SavedMixRow } from "@/components/bookmark/saved-mix";
import { ZONE_META } from "@/lib/bias/config";
import type { MediaDnaZone } from "@/types";

// Spectrum order: government-leaning, independent, opposition-leaning.
const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

const HINT_CLASS = "mb-3 text-xs text-muted-foreground";

/**
 * "Okuma diyetin" -- the zone mix of the saved stories. Hook-free; rendered by
 * the client SavedList from rows it already holds. Copy stays descriptive: no
 * advice about what to read next.
 */
export function SavedMixCard({ rows }: { rows: ReadonlyArray<SavedMixRow> }) {
  const mix = savedMix(rows);

  if (mix.status === "too-few") {
    return <p className={HINT_CLASS}>En az 3 hikâye kaydedince okuma diyetin burada görünür.</p>;
  }
  if (mix.status === "no-votes") {
    return (
      <p className={HINT_CLASS}>
        Kaydettiğin hikâyelerde henüz sınıflandırılmış kaynak yok; okuma diyetin hesaplanamıyor.
      </p>
    );
  }

  const { stories, total, counts, percents, balance } = mix;
  const legend = ZONES.map((z) => `${ZONE_META[z].label} %${percents[z]}`);

  return (
    <section
      aria-labelledby="okuma-diyetin"
      className="mb-4 rounded-xl border border-border/60 bg-card/40 p-4 space-y-2"
    >
      <h2 id="okuma-diyetin" className="font-serif text-sm font-semibold">
        Okuma diyetin
      </h2>
      <p className="text-[12px] text-muted-foreground">
        {`Kaydettiğin ${stories} hikâyeyi yazan ${total} sınıflandırılmış kaynağın dağılımı`}
      </p>
      <div
        role="img"
        aria-label={legend.join(", ")}
        className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-muted"
      >
        {ZONES.filter((z) => counts[z] > 0).map((z) => (
          <div
            key={z}
            className={ZONE_META[z].dot}
            style={{ width: `${(counts[z] / total) * 100}%` }}
          />
        ))}
      </div>
      <p className="text-[12px] text-foreground">{legend.join(" · ")}</p>
      {balance && (
        <p className="text-[12px] text-muted-foreground">
          {`Denge puanı ${balance.score}/100 · ${balance.label} · `}
          <Link
            href="/metodoloji#denge-puani"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            Denge puanı nedir?
          </Link>
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Bu özet yalnızca bu cihazda hesaplanır; hiçbir yere gönderilmez.
      </p>
    </section>
  );
}
