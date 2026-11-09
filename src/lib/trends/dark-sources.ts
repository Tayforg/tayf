import { isVotingKind } from "@/lib/bias/config";
import type { SourceFeedStatus } from "@/lib/sources/feed-status";
import type { MediaDnaZone } from "@/types";

// Voting sources that went dark INSIDE the /trends window (h90-trends-2).
//
// The 30-day zone chart counts articles per zone and day. When a voting outlet
// stops delivering mid-window (a feed outage, not an editorial change) its zone's
// share drops from that day on, and a reader sees the drift as editorial. On
// 2026-11-09 seven voting sources had gone silent between 15 and 25 Oct (the five
// largest carried the whole visible shift). The page cannot say why a source is
// silent (that is the feed-status page's job), but it can say that some voting
// source delivered inside the window and then stopped, which is what moves the
// shares.
//
// Which sources count: kind outlet or wire (the voting kinds, src/lib/sources/
// kind.ts), `silent` (no item for 72 h, computed inside getSourceFeedStatuses'
// own cache scope, so this module and the page never read a clock), a
// silenceReason of 'erisim_yok', and a last item that is NOT before the window
// start: it delivered inside the window and then stopped.
//
// Only voting sources whose feed Tayf cannot fetch count. That is erisim yok
// (quarantined, a failure streak, or a last status that is not 2xx/304), the
// classifier /kaynaklar/durum shows. A feed that answers but has no new item
// (akis donmus, sessiz) can be a normal low-cadence outlet, for example Bianet,
// which delivers in weekly batches while its feed returns 304: it goes silent
// between batches and would otherwise be reported as an outage every week. It is
// not listed. A source dark since before the window, or one that never
// delivered, was absent every day of the chart and moves no share; aggregator and
// niche sources never vote.
//
// Pure: no I/O, no clock, never throws.

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

export interface DarkZoneGroup {
  zone: MediaDnaZone;
  /** Source names of the zone, sorted with the Turkish collation. */
  names: string[];
}

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 00:00 Europe/Istanbul of a `YYYY-MM-DD` day, as a UTC ISO instant
 * ("2026-10-10" -> "2026-10-09T21:00:00.000Z"). Istanbul is a fixed UTC+3 (no
 * daylight saving since 2016; src/lib/finance/queries.ts writes the same literal
 * offset). Anything that is not a real calendar day returns "", which
 * `darkVotingSourcesInWindow` reads as "window unknown" and lists nothing for.
 */
export function istanbulDayStartIso(day: string): string {
  const m = DAY_KEY_RE.exec(day);
  if (m === null) return "";
  const ms = Date.parse(`${day}T00:00:00+03:00`);
  if (!Number.isFinite(ms)) return "";
  // Date.parse rolls "2026-02-31" over in some engines and rejects it in others;
  // a day that does not survive the round trip is not a day.
  const back = new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);
  if (back !== day) return "";
  return new Date(ms).toISOString();
}

/**
 * The voting sources that delivered inside the window and then went silent,
 * grouped by zone in ZONES order (iktidar, bagimsiz, muhalefet), names sorted
 * with `localeCompare(..., "tr")`, zones without a name omitted.
 *
 * Instants are compared as instants (Date.parse), never as strings: PostgREST
 * writes `+00:00`, a fixture may write `Z` or `+03:00`. A `lastItemAt` or a
 * `windowStartIso` that does not parse excludes the source (resp. lists nothing).
 */
export function darkVotingSourcesInWindow(
  statuses: readonly SourceFeedStatus[],
  windowStartIso: string,
): DarkZoneGroup[] {
  const windowStartMs = Date.parse(windowStartIso);
  if (!Number.isFinite(windowStartMs)) return [];

  const byZone = new Map<MediaDnaZone, string[]>();
  for (const s of statuses) {
    if (!isVotingKind(s.kind) || s.silent !== true || s.silenceReason !== "erisim_yok") continue;
    if (s.lastItemAt === null) continue;
    const lastMs = Date.parse(s.lastItemAt);
    if (!Number.isFinite(lastMs) || lastMs < windowStartMs) continue;
    const names = byZone.get(s.zone);
    if (names === undefined) byZone.set(s.zone, [s.name]);
    else names.push(s.name);
  }

  const out: DarkZoneGroup[] = [];
  for (const zone of ZONES) {
    const names = byZone.get(zone);
    if (names === undefined || names.length === 0) continue;
    out.push({ zone, names: [...names].sort((a, b) => a.localeCompare(b, "tr")) });
  }
  return out;
}
