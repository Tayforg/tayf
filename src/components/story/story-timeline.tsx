import { ZONE_META } from "@/lib/bias/config";
import { TrackedLink } from "@/components/ui/tracked-link";
import type { StoryTimeline as StoryTimelineData } from "@/lib/clusters/story-timeline";

/**
 * "Kim önce yazdı?" — one horizontal line with a dot per source, the
 * shareable summary sentence, and the full order behind a <details> tap
 * target. Server Component: the only client JS is the existing TrackedLink
 * island on each outbound link. All times and positions come precomputed
 * from `buildStoryTimeline` (src/lib/clusters/story-timeline.ts), so this
 * never reads the clock — the axis spans first → last point, not "now".
 *
 * Rendered in page.tsx under the spectrum, before <OwnershipLine>.
 */
export function StoryTimeline({ timeline }: { timeline: StoryTimelineData }) {
  const { points, summary } = timeline;
  // `buildStoryTimeline` never returns fewer than 3 points.
  const last = points[points.length - 1] ?? timeline.first;
  // "09:12" vs "27 Eyl 09:12" — literal classes so Tailwind's JIT sees both.
  const clockWidth = timeline.crossesMidnight ? "w-[12ch]" : "w-[6.5ch]";

  return (
    <section aria-labelledby="kim-once-yazdi" className="space-y-1.5">
      <h2
        id="kim-once-yazdi"
        className="font-serif text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80"
      >
        Kim önce yazdı?
      </h2>

      <div role="img" aria-label={summary} className="relative h-5">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {points.map((p) => (
          <span
            key={`${p.sourceName}-${p.t}`}
            title={`${p.sourceName} · ${ZONE_META[p.zone].label} · ${p.clock} · ${p.title}`}
            className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background ${ZONE_META[p.zone].dot}`}
            style={{ left: `${p.offsetPct}%` }}
          />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground/70"
      >
        <span>{timeline.first.clock}</span>
        {last.t !== timeline.first.t && <span>{last.clock}</span>}
      </div>

      <p className="text-[12px] leading-relaxed text-muted-foreground">{summary}</p>

      <details className="group">
        <summary className="inline-flex min-h-[44px] cursor-pointer touch-manipulation list-none items-center text-[12px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">
          Tüm sıra ({points.length} kaynak)
        </summary>
        <ol className="space-y-0.5 border-l border-border/60 pl-3">
          {points.map((p) => (
            <li key={`${p.sourceName}-${p.t}`}>
              <TrackedLink
                event="outbound"
                data={{ zone: p.zone, kind: "timeline" }}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-[32px] items-center gap-2 rounded-sm text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className={`${clockWidth} shrink-0 font-mono text-[10px] tabular-nums`}>
                  {p.clock}
                </span>
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${ZONE_META[p.zone].dot}`}
                />
                {/* The dot above is color-only; name the zone for screen readers. */}
                <span className="sr-only">{ZONE_META[p.zone].label}</span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-foreground/80">
                  {p.sourceName}
                </span>
                <span className="min-w-0 truncate">{p.title}</span>
              </TrackedLink>
            </li>
          ))}
        </ol>
      </details>

      <p className="text-[10px] text-muted-foreground/70">
        Saatler yayıncının RSS tarihine göredir; Tayf haberi daha önce gördüyse o an kullanılır.
      </p>
    </section>
  );
}
