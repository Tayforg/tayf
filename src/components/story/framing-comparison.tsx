import { ExternalLink } from "lucide-react";

import { ZONE_META } from "@/lib/bias/config";
import { SPECTRUM_ABSENT_QUALIFIED } from "@/lib/bias/zone-summary";
import { SourceLogo } from "@/components/source/source-logo";
import { TrackedLink } from "@/components/ui/tracked-link";
import { NewTabHint } from "@/components/ui/new-tab-hint";
import { groupMembersByZone } from "@/lib/clusters/framing";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import {
  ENGLISH_ONLY_EMPTY_COLUMN,
  sourceLang,
} from "@/lib/sources/source-language";
import { RelativeTime } from "@/components/story/relative-time";
import type { MediaDnaZone } from "@/types";

/**
 * "Aynı Haber, Farklı Dünyalar" — the framing comparison.
 *
 * The product's core promise, rendered literally: three parallel front
 * pages (İktidar / Bağımsız / Muhalefet), each listing its outlets' OWN
 * headlines for this story, newest first. The reader compares the actual
 * editorial voices side by side instead of decoding an abstract bias bar.
 *
 * Server Component (headline anchors are TrackedLink client islands, and each
 * row's age a RelativeTime one): overflow beyond VISIBLE_PER_ZONE is
 * disclosed via native <details>/<summary>. An empty zone renders an
 * explicit "silence" state — on a bias-transparency site, the absence of
 * coverage IS content. The state says only what the column shows: when a
 * toplayıcı / niş source of that zone covered the story (`nonVotingZones`) the
 * line is "spektruma sayılan kaynaklardan haber yok", the Manşet Kartı's wording
 * (SPECTRUM_ABSENT_QUALIFIED), and only a zone nobody wrote in keeps "bu tarafta
 * sessizlik" (h58-postship-2). Wording only: no count, vote or "N manşet" moves.
 *
 * h59-english-1: when every member is an English-language outlet
 * (`languageIsolated`) the story never met the Turkish zones, so an empty column
 * is not a finding: it reads "— Türkçe kaynaklarla karşılaştırılmadı —"
 * (ENGLISH_ONLY_EMPTY_COLUMN). Neither wording above applies then. This block
 * prints no note of its own: the read-across slot above carries the one
 * ENGLISH_ONLY_NOTE (copy-2 / react-h59-3), so the page says it exactly once.
 *
 * h47-time-1: ages are measured against `nowMs`, the page's per-request render
 * stamp, and RelativeTime re-bases them to the reader's clock after mount, so a
 * service-worker copy of the page does not show frozen ages. The server text is
 * the one the plain formatter printed.
 *
 * Replaces the degraded ClusterStance chip grid (which showed only source
 * names as outbound chips).
 */

interface FramingComparisonProps {
  // Voting members only: page.tsx passes `votingMembers` (partitionByVote), so
  // every row's `zone` below is a real vote (/diyetim counts the click) and no
  // toplayıcı / niş source can fill a column.
  members: ClusterDetailMember[];
  // The instant the server rendered the page (epoch ms), taken once per request
  // in page.tsx. Required: a caller that forgets it would print frozen ages.
  nowMs: number;
  // The zones a toplayıcı / niş (non-voting) member of this cluster sits in,
  // from `nonVotingMembers` in page.tsx. Required, like nowMs, so no caller can
  // forget it and print "sessizlik" over a column such a source covered. It only
  // changes the words of an EMPTY column; nothing is counted from it.
  nonVotingZones: ReadonlySet<MediaDnaZone>;
  // h59-english-1: every member is an English-language outlet
  // (`isLanguageIsolatedCluster`, computed once in page.tsx). Optional (false):
  // the only caller is the cluster page, which always passes it.
  languageIsolated?: boolean;
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
  nowMs,
}: {
  member: ClusterDetailMember;
  zone: MediaDnaZone;
  nowMs: number;
}) {
  const meta = ZONE_META[zone];
  // WCAG 3.1.2: English outlets' names and headlines inside <html lang="tr">.
  // The name span is CSS-uppercased, and under lang=tr that renders 'Daily
  // Sabah' as 'DAİLY SABAH'; lang="en" fixes the glyphs as well.
  const lang = sourceLang({ slug: member.source.slug, name: member.source.name });
  return (
    <li className="border-b border-border/30 last:border-0">
      <TrackedLink
        event="outbound"
        data={{ zone, kind: "member" }}
        href={member.article.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group/entry block py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      >
        <span className="flex items-center gap-1.5">
          {member.source.logo_url ? (
            <SourceLogo
              logoUrl={member.source.logo_url}
              name={member.source.name}
              size={14}
              className="h-3.5 w-3.5 rounded shrink-0"
              fallback="initials"
              fallbackClassName="inline-flex h-3.5 w-3.5 items-center justify-center rounded bg-muted text-[8px] font-bold text-muted-foreground shrink-0"
            />
          ) : (
            <span
              className={`h-1.5 w-1.5 rounded-full shrink-0 ${meta.dot}`}
            />
          )}
          <span
            lang={lang}
            className="font-mono text-[10px] uppercase tracking-wider text-foreground/80"
          >
            {member.source.name}
          </span>
          <ExternalLink
            aria-hidden="true"
            className="h-2.5 w-2.5 text-muted-foreground/50 opacity-0 transition-opacity group-hover/entry:opacity-100"
          />
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
            <RelativeTime iso={member.article.published_at} nowMs={nowMs} />
          </span>
        </span>
        <span
          lang={lang}
          className={`mt-1 block font-serif text-sm font-medium leading-snug text-foreground/90 decoration-2 underline-offset-2 group-hover/entry:underline ${HOVER_DECORATION[zone]}`}
        >
          {member.article.title}
        </span>
        <NewTabHint />
      </TrackedLink>
    </li>
  );
}

export function FramingComparison({
  members,
  nowMs,
  nonVotingZones,
  languageIsolated = false,
}: FramingComparisonProps) {
  const byZone = groupMembersByZone(members);
  const total = members.length;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-base font-bold tracking-tight">
          Aynı Haber, Farklı Dünyalar
        </h2>
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
              <p className="text-[10px] text-muted-foreground">
                {meta.description}
              </p>

              {zoneMembers.length === 0 ? (
                <div className="mt-3 rounded-lg border border-dashed border-border/50 px-3 py-6 text-center">
                  <span className="text-[11px] italic text-muted-foreground">
                    {languageIsolated
                      ? ENGLISH_ONLY_EMPTY_COLUMN
                      : nonVotingZones.has(zone)
                        ? `— ${SPECTRUM_ABSENT_QUALIFIED} —`
                        : "— bu tarafta sessizlik —"}
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
                        nowMs={nowMs}
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
                            nowMs={nowMs}
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
