import { repairEntityResidue } from "../../../supabase/functions/_shared/rss/entities";
import { isOpinionUrl } from "@/lib/articles/opinion-url";
import { backOffOpenQuote, tidySummaryText, trimDanglingEnd } from "@/lib/articles/summary-tidy";
import { normalizeSourceKind } from "@/lib/bias/config";
import { findAgreeingMember } from "./summary-agreement";
import { textComponentsOf, type WireSignal } from "./wire";
import type { BiasCategory, SourceKind } from "@/types";

// clusters.summary_tr is the seed article's raw RSS description — one
// outlet's words, not Tayf's. It must be attributed to that outlet or
// hidden entirely (blank, or a wire dispatch every member just copied).
// The seed is found by matching the stored text against member
// descriptions; first_published is min(published_at) over all members and
// moves when an older article joins late, so it is not used for attribution.
//
// Read-time repair for double-encoded feed residue: some stored descriptions
// (and so summary_tr, which copies them) carry a literal "&quot;", "&#39;" or
// "&amp;" that the single-pass ingest decoder left behind. Every function here
// runs the summary through `repairEntityResidue`, and seed detection repairs
// the member description the same way, so the comparison still holds whether
// the stored text is raw, already clean, or one of each. The repair is
// idempotent and can never create '<' or '>'.
//
// Read-time tidy for feed residue (glued sentences, "Devamı için tıklayınız"
// tails, widget heading lines, raw newlines): `tidySummaryText` is applied
// ONLY to the `text` placed in the returned SummaryAttribution. Matching
// (`holdersOf`, `findSeedMember`), the BL-13 rights gate and the wire
// majority check all compare the repaired but UNTIDIED text, because that is
// what a member's stored description looks like; comparing tidied text would
// let a rights-blocked or wire-copied description slip past those checks.
// Tidied text that comes out empty (the summary was only a CTA or a widget
// heading) hides the summary, like a blank one.
//
// Title agreement (h31-reader-3 v2), OPT-IN: the seed's description is written
// once, when the cluster is created, so on a developing story it can contradict
// the headline on the same page (6e19dd5a: "seçimi önde götürüyor" under "Senato'ya
// seçilen ilk Müslüman oldu"). A caller that passes `agreeWithTitle` (the
// cluster's current neutral title) keeps the seed while it agrees with that title
// and otherwise gets the member whose description agrees best, attributed to that
// member (`findAgreeingMember` in summary-agreement.ts has the whole rule). It
// runs AFTER every gate above (blank, rights-blocked, wire majority,
// tidied-empty), so those are untouched, and the shown text is always a member's
// own description, tidied for display. Only the cluster page passes it (body,
// generateMetadata and JSON-LD alike, so the three never disagree); rss.xml, the
// digest and the home/list cards, which have no member rows or no title to
// compare, keep the seed. Without `agreeWithTitle` the result is byte-identical
// to what it was before.
//
// Opinion columns (h54-editorial-3): a member whose article `url` is an opinion path
// (`isOpinionUrl`: /yazarlar/..., /kose-yazilari/..., /opinion/...) is an outlet's
// columnist, not its news desk. As the seed it counts as malformed and as a
// candidate it never replaces anything (summary-agreement.ts). When the member the
// summary is attributed to is such a column, the attribution carries `opinion: true`
// and the cluster page labels it with `summaryLabel` ("Özet — Hürriyet · köşe
// yazısı"). The flag is present only when true, so every other result is unchanged.
// A member without a `url` (the RSS members) is never an opinion member.
//
// Who is credited (h95-summaries-2): the text is matched against member descriptions,
// and several members often hold the SAME words (Anadolu Ajansı's lead, copied by an
// aggregator that stamped it nine minutes earlier). The earliest stamp used to win
// whatever the source was, so "Özet — Haberler.com" stood over a state agency's lead
// (27 of 1,591 clusters). Among members with the identical text the credit now goes by
// source kind first: a wire, then an outlet or a niche source (a missing kind reads as an
// outlet), then an aggregator; the earliest stamp settles members of one rank. The BL-13
// rights gate is unchanged (a member with `excerpt_allowed === false` is skipped, and
// when every holder is blocked the Özet is hidden). Only the CREDIT moves: whether the
// text is hidden as a wire copy is still decided on the earliest-published member that
// holds it and may be shown (`inTimeOrder`, today's seed), and the choice of a
// replacement by title agreement (`findAgreeingMember`) keeps that member as its seed.
//
// h95-summaries-1 also moves the tidy step (a Peki / İşte tail and an unmarked 400 / 500
// character cut, summary-tidy.ts), so the text itself differs from what was stored for
// those two shapes with or without `agreeWithTitle`.

// Structural subset of ClusterDetailMember (cluster-detail-query.ts): the
// cluster page's members satisfy this shape as-is, and lighter callers
// (e.g. an RSS-only member projection) can satisfy it without fetching or
// typing the full Source/article shape the detail page needs.
export interface SummaryMember {
  source: {
    name: string;
    bias: BiasCategory;
    /**
     * Source kind and slug, read only by the title-agreement choice (wire and
     * aggregator members never replace the seed; an English outlet's text is not
     * put under a Turkish story). Absent on lighter projections (the RSS
     * members): a missing kind reads as an outlet and a missing slug falls back
     * to the display name (`sourceLang`).
     */
    kind?: SourceKind | null;
    slug?: string | null;
    /**
     * BL-13 per-source rights flag (migration 047): `false` when this
     * outlet has asked Tayf not to reuse its article text. `undefined`
     * (a fixture/caller predating the column) is treated as `true`
     * (allowed) — see `findSeedMember` below.
     */
    excerpt_allowed?: boolean;
  };
  article: {
    published_at: string;
    content_hash: string | null;
    /**
     * The article's headline, read only by the title-agreement choice to tell a
     * description that merely repeats it (an echo, h95-summaries-1) from a summary.
     * Absent on lighter projections (the RSS members): a missing title is never an echo.
     */
    title?: string | null;
    description?: string | null;
    /**
     * The article's URL, read only to tell an opinion column from news
     * (`isOpinionUrl`, h54-editorial-3). Absent on lighter projections: a missing
     * url is a news article.
     */
    url?: string | null;
  };
}

/**
 * Credit order of the members that hold the same text (h95-summaries-2): a wire
 * agency first (its own dispatch), then an outlet or a niche source (a missing kind is
 * an outlet), then an aggregator (it republishes). Lower is credited first.
 */
function creditRank(m: SummaryMember): number {
  const kind = normalizeSourceKind(m.source.kind);
  if (kind === "wire") return 0;
  if (kind === "aggregator") return 2;
  return 1;
}

function publishedAtMs(m: SummaryMember): number {
  return new Date(m.article.published_at).getTime();
}

/**
 * Members whose article description equals the summary text after both have
 * been through `repairEntityResidue` (`text` is expected to be repaired
 * already), in the members' own order. Internal helper: the rights-blocked-entirely
 * detection of `summaryAttribution` reads the whole set, and the two orders below
 * are made from it.
 */
function holdersOf(members: SummaryMember[], text: string): SummaryMember[] {
  return members.filter((m) => repairEntityResidue(m.article.description ?? "").trim() === text);
}

/**
 * The holders in credit order (h95-summaries-2): source kind first ({@link creditRank}:
 * wire, outlet or niche, aggregator), then earliest-published (equal stamps keep the
 * members' order; `Array.prototype.sort` is stable).
 */
function inCreditOrder(holders: readonly SummaryMember[]): SummaryMember[] {
  return [...holders].sort((a, b) => creditRank(a) - creditRank(b) || publishedAtMs(a) - publishedAtMs(b));
}

/**
 * The holders earliest-published first, equal stamps in the members' order: the order
 * the credit followed before h95-summaries-2. Today's seed (the member the cluster's
 * summary came from) is the first of these that may be shown, so the wire-majority
 * hide and the title agreement keep deciding on exactly the member they decided on.
 */
function inTimeOrder(holders: readonly SummaryMember[]): SummaryMember[] {
  return [...holders].sort((a, b) => publishedAtMs(a) - publishedAtMs(b));
}

/** True for a member whose source has not asked Tayf to keep its text (`undefined`, a legacy row without the column, is allowed). */
function mayShowExcerpt(m: SummaryMember): boolean {
  return m.source.excerpt_allowed !== false;
}

/**
 * Member whose article description equals the summary, in credit order: a wire
 * agency before an outlet or a niche source before an aggregator, the earliest stamp
 * within a rank (h95-summaries-2); null otherwise.
 *
 * BL-13 rights gate: a member whose source has `excerpt_allowed === false`
 * is skipped in favor of the next matching member — that outlet's text
 * must never be attributed or rendered as its own. `undefined` (older
 * fakes / legacy rows without the column) is treated as allowed.
 */
export function findSeedMember(
  members: SummaryMember[],
  summary: string,
): SummaryMember | null {
  const text = repairEntityResidue(summary).trim();
  if (text.length === 0) return null;
  return inCreditOrder(holdersOf(members, text)).find(mayShowExcerpt) ?? null;
}

export interface SummaryAttribution {
  text: string;
  source: SummaryMember["source"] | null;
  /**
   * Present, and true, only when the member the text is attributed to is an
   * opinion column (its article URL is an opinion path, h54-editorial-3). Absent
   * otherwise, never `false`. Read by {@link summaryLabel}.
   */
  opinion?: true;
}

/** The cue that follows an outlet's name when the summary is its columnist's, not its news desk's. */
const OPINION_CUE = "köşe yazısı";

/**
 * The cluster page's summary heading: "Özet — <Outlet>", "Özet — <Outlet> · köşe
 * yazısı" when the summary is an opinion column's, or "Özet — Kaynak açıklaması"
 * when no member holds the text. Pure.
 */
export function summaryLabel(attribution: SummaryAttribution): string {
  if (!attribution.source) return "Özet — Kaynak açıklaması";
  const label = `Özet — ${attribution.source.name}`;
  return attribution.opinion === true ? `${label} · ${OPINION_CUE}` : label;
}

/** The attribution of `text` to `member`, flagged when that member is an opinion column. */
function attributedTo(text: string, member: SummaryMember | null): SummaryAttribution {
  const out: SummaryAttribution = { text, source: member ? member.source : null };
  if (member && isOpinionUrl(member.article.url)) out.opinion = true;
  return out;
}

/** What a wire redistribution copied: the members of its largest text(s), and their content hashes. */
interface WireMajority {
  /** The members whose text is (one of) the largest, ties included. Compared by identity. */
  members: ReadonlySet<SummaryMember>;
  /** The non-null content hashes of `members`, for the title-agreement choice. */
  hashes: ReadonlySet<string>;
}

const NO_WIRE_MAJORITY: WireMajority = { members: new Set(), hashes: new Set() };

/**
 * The dispatch a wire redistribution copied: the members of the largest
 * text(s), ties included, where a text is a component of "same content_hash
 * or same agency lead" (`textComponentsOf`, the rule the wire flag itself is
 * computed with; h139 ts-3). Counting content hashes alone mis-hid an
 * independent seed when every hash was distinct (all tie at one) and showed a
 * copied lead when two unrelated members happened to share a hash. The seed is
 * hidden when it is one of these members (by identity, so a seed with no hash
 * is covered); the title-agreement choice skips a candidate that holds one of
 * their hashes. Empty without a wire redistribution, or when no text is held
 * by at least two members (there is no copy to hide).
 */
function wireMajority(
  members: SummaryMember[],
  wire: Pick<WireSignal, "isWireRedistribution">,
): WireMajority {
  if (!wire.isWireRedistribution) return NO_WIRE_MAJORITY;
  const roots = textComponentsOf(
    members.map((m, i) => ({
      id: String(i),
      content_hash: m.article.content_hash,
      description: m.article.description,
    })),
  );
  const sizes = new Map<number, number>();
  for (const root of roots) sizes.set(root, (sizes.get(root) ?? 0) + 1);
  const bestSize = Math.max(0, ...sizes.values());
  if (bestSize < 2) return NO_WIRE_MAJORITY;
  const majorityMembers = new Set<SummaryMember>();
  const hashes = new Set<string>();
  members.forEach((m, i) => {
    if (sizes.get(roots[i]!) !== bestSize) return;
    majorityMembers.add(m);
    if (m.article.content_hash !== null) hashes.add(m.article.content_hash);
  });
  return { members: majorityMembers, hashes };
}

/**
 * Null hides the summary: blank text, or a wire copy the seed source didn't
 * write. `agreeWithTitle` (opt-in, the cluster page only; see the header) swaps
 * a seed that disagrees with that title for the member that agrees best.
 */
export function summaryAttribution({
  summary,
  members,
  wire,
  agreeWithTitle,
}: {
  summary: string;
  members: SummaryMember[];
  wire: Pick<WireSignal, "isWireRedistribution">;
  agreeWithTitle?: string;
}): SummaryAttribution | null {
  const text = repairEntityResidue(summary).trim();
  if (text.length === 0) return null;

  // BL-13 rights gate: every member whose description literally matches
  // this excerpt has a source that has asked Tayf not to reuse its text —
  // the excerpt IS that outlet's copy verbatim, so merely hiding
  // attribution (falling through to the generic "Kaynak açıklaması"
  // label below) would still publish it. Hide the excerpt entirely
  // instead. When there's no literal match at all (the common case —
  // `summary` wasn't copied verbatim from any current member), this does
  // not apply; that's the pre-existing "attribute to no one" path below.
  const literalMatches = holdersOf(members, text);
  if (
    literalMatches.length > 0 &&
    literalMatches.every((m) => m.source.excerpt_allowed === false)
  ) {
    return null;
  }

  // h95-summaries-2: whose words the text is (`credited`: a wire before an earlier
  // outlet before an earlier aggregator) is not which article seeded the cluster
  // (`seedMember`: the earliest-published match that may be shown, as before). The hide
  // below and the title agreement go by the seed; only the label goes by the credit.
  const credited = inCreditOrder(literalMatches).find(mayShowExcerpt) ?? null;
  const seedMember = inTimeOrder(literalMatches).find(mayShowExcerpt) ?? null;

  const majority = wireMajority(members, wire);
  // Tie-safe: hide when the seed is one of the members of the largest text(s).
  if (seedMember && majority.members.has(seedMember)) return null;

  const shown = tidySummaryText(text);
  if (shown.length === 0) return null;

  // "Kaynak açıklaması" (no member holds the text) has no seed outlet to compare
  // a language or a rights flag against: it stays as stored.
  if (agreeWithTitle !== undefined && seedMember) {
    const better = findAgreeingMember({
      members,
      seed: seedMember,
      seedShown: shown,
      title: agreeWithTitle,
      wireMajorityHashes: majority.hashes,
    });
    if (better) return attributedTo(better.text, better.member);
  }
  return attributedTo(shown, credited);
}

const ELLIPSIS = "…";

/**
 * A quote back-off must keep at least this many characters of the attribution
 * text (after the "N kaynak. Outlet: " prefix), or the description is the one
 * without an attribution (h30-live-1). "Yılmaz, "<200-character quote>" dedi."
 * backed off to "4 kaynak. Anadolu Ajansı: Yılmaz…": a speaker's name is not a
 * description, and the title sentence is.
 */
const MIN_KEPT_AFTER_BACK_OFF = 60;

/**
 * What is left of a text after {@link backOffOpenQuote} ended it in front of a
 * quotation, as the description's final shape. `kept` null stays null (no cut
 * is long enough). A back-off that keeps fewer than `minKeptAfterBackOff`
 * characters after `floor` is null too (h30-live-1: what is left is a stub).
 * An existing "…" is kept; any other end gets one, after dangling ", ; : – — -"
 * and blanks are dropped ("açıkladı." keeps its stop: "açıkladı.…").
 */
function finishBackOff(
  kept: string | null,
  floor: number,
  minKeptAfterBackOff: number,
): string | null {
  if (kept === null) return null;
  const text = kept.endsWith(ELLIPSIS) ? kept.slice(0, -ELLIPSIS.length) : kept;
  if (text.length - floor < minKeptAfterBackOff) return null;
  if (kept.endsWith(ELLIPSIS)) return kept;
  return kept.slice(0, trimDanglingEnd(kept, kept.length)) + ELLIPSIS;
}

/**
 * Word-boundary truncation shared by every `describeForMeta` branch.
 *
 * A cut that would end inside an open quotation (`Yılmaz, "İsrail'in … baskısına…`,
 * h29-regress-1) is backed off by {@link backOffOpenQuote}: to the last sentence
 * end or to the word in front of the opener, never to a cut that ends at or
 * before `floor` (the length of the leading sentence and the attribution label,
 * which are not the text). Null when no such cut exists; the caller then falls
 * back to the description without the text. h30-live-1: a back-off that keeps
 * fewer than `minKeptAfterBackOff` characters of text after `floor` is null too;
 * what is left is a stub.
 *
 * A balanced cut is cut as it always was, except that it no longer ends in
 * ", ; : – — -" in front of the ellipsis ("Demokratlar Partisi,…", h30-live-1)
 * and is null when that leaves nothing after `floor`. The minimum applies to a
 * back-off only: a plain word cut keeps what the limit allows.
 *
 * h32-livebk-2: a text that fits under `max` is not cut, but it can still leave
 * a quotation open (16f038d3: `Hamaney, "Basra Körfezi … yerle bir etti.` with no
 * closer). It gets the same back-off as a cut one, with the same `floor` and the
 * same minimum ({@link finishBackOff}); a balanced text is returned as it is, the
 * same string. A closing quote is never added: the source's words are not ours
 * to complete.
 */
function truncateWords(
  full: string,
  max: number,
  floor = 0,
  minKeptAfterBackOff = 0,
): string | null {
  if (full.length <= max) {
    const kept = backOffOpenQuote(full, { floor });
    if (kept === full) return full;
    return finishBackOff(kept, floor, minKeptAfterBackOff);
  }
  const truncated = full.slice(0, Math.max(0, max - 1));
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  const kept = backOffOpenQuote(cut, { floor });
  if (kept === null) return null;
  if (kept === cut) {
    // No quotation left open: a plain word cut. A double space at the boundary
    // would leave one blank in front of the ellipsis ("geçirilecek. …"), and a
    // dangling mark would read ",…".
    const end = trimDanglingEnd(cut, cut.length);
    return end <= floor ? null : cut.slice(0, end) + ELLIPSIS;
  }
  return finishBackOff(kept, floor, minKeptAfterBackOff);
}

/**
 * Meta/JSON-LD description: source count, plus attribution when present,
 * word-truncated to `max`. `base`, when supplied, replaces the default
 * "{count} kaynak." leading sentence — used by callers (e.g. the RSS feed)
 * that already compose their own honest count/wire-note prefix. `count` is
 * still required so `base`-less callers keep the original default; it is
 * ignored once `base` is present. `base` only overrides the leading
 * sentence, never the attribution prefix or the truncation behaviour.
 *
 * seo-2: when there's no attribution AND no `base` override, every such
 * cluster used to share the identical generic "{count} kaynak." meta
 * description — bad for unique-per-page SEO. `title`, when supplied, is
 * used instead to build a per-cluster fallback sentence. `base`-supplying
 * callers (rss.xml) are unaffected: the fallback only fires when `base` is
 * absent, so their own composed prefix always wins.
 *
 * h29-regress-1: the word cut never ends inside an open quotation (see
 * `truncateWords`). An attribution text that opens with the quotation has no
 * cut that does not, so the description is the one without an attribution (the
 * title sentence, else `head`).
 *
 * h30-live-1: the same description replaces an attribution whose quote back-off
 * keeps fewer than 60 characters of text (a speaker's name in front of a long
 * quotation, "Yılmaz…"; the title fallback itself is not held to that), a cut
 * never ends in ", ; : – — -" in front of the "…", and a cut that would end
 * inside the label ("N kaynak. Outlet:") has no text to show and falls back too.
 *
 * h32-livebk-2: the same back-off runs on a text that fits under `max` and
 * leaves a quotation open, so a short unclosed quotation (`Hamaney, "Basra
 * Körfezi … yerle bir etti.`) is not published as it is: it ends in front of the
 * opener when 60 characters or more survive, else the description is the one
 * without an attribution. The title fallback goes through the same rule with no
 * minimum (an uncut title that opens a quotation it never closes ends in front of
 * the opener, or gives `head` when it opens with it). No closing quote is added.
 */
export function describeForMeta(
  {
    count,
    attribution,
    base,
    title,
  }: {
    count: number;
    attribution: SummaryAttribution | null;
    base?: string;
    title?: string;
  },
  max = 160,
): string {
  const head = base ?? `${count} kaynak.`;
  // The description without an attribution: the title sentence, else the head.
  // An attribution whose text cannot be cut without ending inside a quotation
  // (it opens with the quotation) falls back to it.
  const withoutAttribution = (): string => {
    if (base === undefined && title && title.trim().length > 0) {
      const lead = `${count} kaynak, tek haber: `;
      return truncateWords(lead + title.trim(), max, lead.length) ?? head;
    }
    return head;
  };
  if (!attribution) return withoutAttribution();

  const prefix = attribution.source
    ? `${head} ${attribution.source.name}: `
    : `${head} Kaynak açıklaması: `;
  return (
    truncateWords(prefix + attribution.text, max, prefix.length, MIN_KEPT_AFTER_BACK_OFF) ??
    withoutAttribution()
  );
}

/**
 * Tri-state summary resolution shared by every caller with a batched,
 * possibly-failing members lookup (rss.xml, the digest cron).
 *
 * `lookupFailed` is the BL-13 fail-closed distinction this function exists
 * to centralize: `members` being absent for a cluster is ambiguous on its
 * own — it means either "the lookup ran and this cluster genuinely has no
 * attributable members" (safe to degrade via summaryAttributionWithoutMembers,
 * which can still show the generic label) or "the whole lookup failed"
 * (summaryAttributionWithoutMembers would then render clusters.summary_tr
 * verbatim with no excerpt_allowed check at all, since that gate only runs
 * inside summaryAttribution against real member rows). A source with
 * excerpt_allowed: false must never have its text rendered just because its
 * cluster's member lookup happened to error — so a failed lookup hides the
 * excerpt entirely instead of falling through to the degraded path.
 */
export function resolveSummaryAttribution({
  summary,
  members,
  lookupFailed,
  wire,
}: {
  summary: string;
  members: SummaryMember[] | undefined;
  lookupFailed: boolean;
  wire: Pick<WireSignal, "isWireRedistribution">;
}): SummaryAttribution | null {
  if (members) return summaryAttribution({ summary, members, wire });
  if (lookupFailed) return null;
  return summaryAttributionWithoutMembers({ summary, wire });
}

/**
 * DEGRADED fallback for callers with no member rows (feed surfaces, or a
 * lookup failure). Strictly more conservative than summaryAttribution: it
 * can never name an outlet (no members to run findSeedMember against), and
 * it hides the summary wholesale on any wire redistribution because the
 * per-seed wire-majority check (largest text, wireMajority) cannot run without members — so it
 * may hide a summary the member-aware path would show. That divergence is
 * intentional, not a bug to reconcile: the caller has strictly less
 * information, so it must be strictly less willing to publish someone
 * else's words as attributed or unattributed fact.
 */
export function summaryAttributionWithoutMembers({
  summary,
  wire,
}: {
  summary: string;
  members?: never;
  wire: Pick<WireSignal, "isWireRedistribution">;
}): SummaryAttribution | null {
  const text = repairEntityResidue(summary).trim();
  if (text.length === 0) return null;
  if (wire.isWireRedistribution) return null;
  const shown = tidySummaryText(text);
  if (shown.length === 0) return null;
  return { text: shown, source: null };
}
