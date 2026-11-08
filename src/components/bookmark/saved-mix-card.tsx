import Link from "next/link";

import { savedMix, type SavedMixRow } from "@/components/bookmark/saved-mix";
import { ZONE_META } from "@/lib/bias/config";
import type { MediaDnaZone } from "@/types";

// Spectrum order: government-leaning, independent, opposition-leaning.
const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

const HINT_CLASS = "mb-3 text-xs text-muted-foreground";

/**
 * "Okuma diyetiniz" -- the zone mix of the saved stories. Hook-free; rendered by
 * the client SavedList from rows it already holds. Copy stays descriptive: no
 * advice about what to read next.
 */
export function SavedMixCard({ rows }: { rows: ReadonlyArray<SavedMixRow> }) {
  const mix = savedMix(rows);

  if (mix.status === "too-few") {
    return <p className={HINT_CLASS}>En az 3 hikâye kaydedince okuma diyetiniz burada görünür.</p>;
  }
  if (mix.status === "no-votes") {
    return (
      <p className={HINT_CLASS}>
        Kaydettiğiniz hikâyelerde henüz sınıflandırılmış kaynak yok; okuma diyetiniz hesaplanamıyor.
      </p>
    );
  }

  const { stories, total, counts, percents, balance } = mix;
  const legend = ZONES.map((z) => `${ZONE_META[z].label} %${percents[z]}`);

  return (
    <section
      aria-labelledby="okuma-diyetiniz"
      className="mb-4 rounded-xl border border-border/60 bg-card/40 p-4 space-y-2"
    >
      <h2 id="okuma-diyetiniz" className="font-serif text-sm font-semibold">
        Okuma diyetiniz
      </h2>
      <p className="text-[12px] text-muted-foreground">
        {`Kaydettiğiniz ${stories} hikâyeyi yazan ${total} sınıflandırılmış kaynağın dağılımı`}
      </p>
      {/* Decoration for assistive tech: the legend <p> below prints the same
          percents, so it is the one text alternative (h67-landmarks-2). */}
      <div
        aria-hidden="true"
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
