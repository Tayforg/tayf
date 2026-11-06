import { ZONE_META } from "@/lib/bias/config";
import {
  formatSilenceRow,
  silenceFootnote,
  type SilenceDigest,
} from "@/lib/clusters/silence-digest";

// Three-row band at the top of the /blindspots feed: per zone, how many of
// the blindspot stories on the page that zone gave no coverage at all
// (judged on voting sources only, see silence-digest.ts). Server-safe on
// purpose (no 'use client', no hooks); the digest is derived in the blindspots
// fetcher over every claim of the window, and its optional `scope` makes the
// footnote say how many of those are shown as full cards.
export function SilenceDigestBand({ digest }: { digest: SilenceDigest }) {
  if (digest.windowTotal === 0) return null;

  return (
    <section
      aria-label="Bu listedeki kör noktalarda yer verilmeyen hikâyeler"
      className="rounded-xl border border-border/60 bg-card/40 p-4 space-y-2"
    >
      <h2 className="font-serif text-sm font-semibold">
        Bu listede kim yer vermedi?
      </h2>
      <ul className="space-y-1 text-[13px]">
        {digest.rows.map((row) => (
          <li
            key={row.zone}
            className={
              row.silentCount === 0
                ? "flex items-start gap-2 text-muted-foreground"
                : "flex items-start gap-2"
            }
          >
            <span
              aria-hidden
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ZONE_META[row.zone].dot}`}
            />
            {formatSilenceRow(row)}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        {silenceFootnote(digest.windowTotal, digest.scope)}
      </p>
    </section>
  );
}
