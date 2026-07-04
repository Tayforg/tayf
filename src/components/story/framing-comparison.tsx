import { ExternalLink } from "lucide-react";

import { ZONE_META } from "@/lib/bias/config";
import { groupMembersByZone } from "@/lib/clusters/framing";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import { formatTurkishTimeAgo } from "@/lib/time";
import type { MediaDnaZone } from "@/types";

/**
 * "Aynı Haber, Farklı Dünyalar" — the framing comparison.
 *
 * The product's core promise, rendered literally: three parallel front
 * pages (İktidar / Bağımsız / Muhalefet), each listing its outlets' OWN
 * headlines for this story, newest first. The reader compares the actual
 * editorial voices side by side instead of decoding an abstract bias bar.
 *
 * Server Component, zero client JS: overflow beyond VISIBLE_PER_ZONE is
 * disclosed via native <details>/<summary>. An empty zone renders an
 * explicit "silence" state — on a bias-transparency site, the absence of
 * coverage IS content.
 *
 * Replaces the degraded ClusterStance chip grid (which showed only source
 * names as outbound chips).
 */

interface FramingComparisonProps {
  members: ClusterDetailMember[];
}

// Spectrum order, matching the bias bar left-to-right.
const ZONE_ORDER: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

// Headlines shown per zone before the <details> disclosure takes over.
// Keeps 100+ member mega-clusters from turning the page into a wall.
const VISIBLE_PER_ZONE = 4;

// Zone-tinted underline on headline hover. Full literal class strings
// (NOT derived from ZONE_META) per the config.ts rule: Tailwind's JIT
// only picks up classes it can see verbatim in source.
const HOVER_DECORATION: Record<MediaDnaZone, string> = {
  iktidar: "group-hover/entry:decoration-red-500/60",
  bagimsiz: "group-hover/entry:decoration-zinc-400/60",
  muhalefet: "group-hover/entry:decoration-emerald-500/60",
};

function HeadlineEntry({
  member,
  zone,
}: {
  member: ClusterDetailMember;
  zone: MediaDnaZone;
}) {
  const meta = ZONE_META[zone];
  return (
    <li className="border-b border-border/30 last:border-0">
      <a
        href={member.article.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group/entry block py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      >
        <span className="flex items-center gap-1.5">
          {member.source.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={member.source.logo_url}
              alt=""
              width={14}
              height={14}
              className="h-3.5 w-3.5 rounded shrink-0"
              loading="lazy"
            />
          ) : (
            <span
              className={`h-1.5 w-1.5 rounded-full shrink-0 ${meta.dot}`}
            />
          )}
          <span className="font-mono text-[10px] uppercase tracking-wider text-foreground/80">
            {member.source.name}
          </span>
          <ExternalLink className="h-2.5 w-2.5 text-muted-foreground/50 opacity-0 transition-opacity group-hover/entry:opacity-100" />
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/70">
            {formatTurkishTimeAgo(member.article.published_at)}
          </span>
        </span>
        <span
          className={`mt-1 block font-serif text-sm font-medium leading-snug text-foreground/90 decoration-2 underline-offset-2 group-hover/entry:underline ${HOVER_DECORATION[zone]}`}
        >
          {member.article.title}
        </span>
      </a>
    </li>
  );
}

export function FramingComparison({ members }: FramingComparisonProps) {
  const byZone = groupMembersByZone(members);
  const total = members.length;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-serif text-base font-bold tracking-tight">
          Aynı Haber, Farklı Dünyalar
        </h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {total} kaynağın kendi manşetleri, yan yana — her sütun bir
          medya dünyası.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {ZONE_ORDER.map((zone) => {
          const meta = ZONE_META[zone];
          const zoneMembers = byZone[zone];
          const visible = zoneMembers.slice(0, VISIBLE_PER_ZONE);
          const overflow = zoneMembers.slice(VISIBLE_PER_ZONE);

          return (
            <section
              key={zone}
              aria-label={meta.label}
              className={`border-t-2 ${meta.zoneBorder} pt-2.5 min-w-0`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className={`text-sm font-semibold ${meta.zoneLabel}`}>
                  {meta.label}
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {zoneMembers.length} manşet
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground/70">
                {meta.description}
              </p>

              {zoneMembers.length === 0 ? (
                <div className="mt-3 rounded-lg border border-dashed border-border/50 px-3 py-6 text-center">
                  <span className="text-[11px] italic text-muted-foreground/60">
                    — bu tarafta sessizlik —
                  </span>
                </div>
              ) : (
                <>
                  <ul className="mt-1.5">
                    {visible.map((member) => (
                      <HeadlineEntry
                        key={member.article.id}
                        member={member}
                        zone={zone}
                      />
                    ))}
                  </ul>
                  {overflow.length > 0 && (
                    <details className="group/more">
                      <summary
                        className={`inline-flex cursor-pointer select-none items-center rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors list-none [&::-webkit-details-marker]:hidden ${meta.chipBg} ${meta.chipHover} ${meta.chipText} ${meta.chipBorder}`}
                      >
                        <span className="group-open/more:hidden">
                          +{overflow.length} başlık daha
                        </span>
                        <span className="hidden group-open/more:inline">
                          Daha az göster
                        </span>
                      </summary>
                      <ul>
                        {overflow.map((member) => (
                          <HeadlineEntry
                            key={member.article.id}
                            member={member}
                            zone={zone}
                          />
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
