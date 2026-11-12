import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// next/image needs the App Router image pipeline, absent when a component
// function is rendered in isolation; a plain <img> keeps the card's own JSX
// under test (same harness as cluster-card-time.test.tsx).
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

import { BALANCE_MIN_SOURCES } from "@/lib/bias/balance";
import { ENGLISH_ONLY_SPECTRUM_LINE } from "@/lib/sources/source-language";
import type { BiasDistribution } from "@/types";

import {
  ClusterCard,
  type ClusterCardArticle,
  type ClusterCardCluster,
  type ClusterCardSource,
} from "./cluster-card";

// h151-home-1: every ClusterCard that is not the home feed (the archive search,
// /konu/<slug>, /gundem/<key>, /blindspots) can show a cluster whose every
// member is an English outlet. Its bar read "İktidar %100" with no "not compared
// with Turkish sources" qualifier, next to a Denge chip and, if flagged, a "Kör
// nokta" badge. The card now takes the cluster page's own predicate
// (isLanguageIsolatedCluster) and prints ENGLISH_ONLY_SPECTRUM_LINE under the
// bar; the chip and the badge are left off. Sources carry names only (no slug),
// as the card projection does.

const ENGLISH_NAMES = [
  "Daily Sabah",
  "TRT World",
  "A News",
  "Hürriyet Daily News",
  "Türkiye Today",
  "MFA Türkiye",
];
const TURKISH_NAMES = ["Sabah", "A Haber", "Star", "Yeni Şafak", "Takvim", "Akşam"];

const ZERO_DISTRIBUTION: BiasDistribution = {
  pro_government: 0,
  gov_leaning: 0,
  state_media: 0,
  center: 0,
  opposition_leaning: 0,
  opposition: 0,
  nationalist: 0,
  islamist_conservative: 0,
  pro_kurdish: 0,
  international: 0,
};

const FIRST_PUBLISHED = new Date(Date.UTC(2026, 10, 10, 9, 0, 0)).toISOString();
const DEFAULT_CLUSTER_ID = "92742df8-0000-4000-8000-000000000001";

function clusterOf(
  voters: number,
  over: Partial<ClusterCardCluster> = {},
): ClusterCardCluster {
  return {
    id: DEFAULT_CLUSTER_ID,
    title_tr: "Erdoğan Antalya'da dünya liderleriyle görüştü",
    summary_tr: "Özet",
    // Every voter is pro_government: the "İktidar %100" bar of the report.
    bias_distribution: { ...ZERO_DISTRIBUTION, pro_government: voters },
    is_blindspot: false,
    blindspot_side: null,
    article_count: voters,
    first_published: FIRST_PUBLISHED,
    updated_at: FIRST_PUBLISHED,
    ...over,
  };
}

/** One article + one source per name, the first `count` names of `names`. */
function membersOf(
  names: readonly string[],
  count: number = BALANCE_MIN_SOURCES,
): { articles: ClusterCardArticle[]; sources: ClusterCardSource[] } {
  if (names.length < count) throw new Error("fixture needs more source names");
  const sources = names.slice(0, count).map((name, i) => ({
    id: `src-${i}`,
    name,
    bias: "pro_government" as const,
  }));
  return {
    sources,
    articles: sources.map((s, i) => ({
      id: `art-${i}`,
      title: `Headline number ${i}`,
      url: `https://example.test/${i}`,
      published_at: FIRST_PUBLISHED,
      source_id: s.id,
    })),
  };
}

function render(props: {
  cluster: ClusterCardCluster;
  articles: ClusterCardArticle[];
  sources: ClusterCardSource[];
}): string {
  return renderToStaticMarkup(<ClusterCard {...props} index={3} />);
}

/** Number of non-overlapping occurrences of `needle` (no regex, no replace). */
function countOf(haystack: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n += 1;
    from = at + needle.length;
  }
}

/** Visible text of a markup string: a character walk, never a regex. */
function textOf(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

// The qualifier <p> carries kart-dil-<cluster id> (react-a11y-2): the card link's
// aria-describedby lists it on an all-English card.
const QUALIFIER_P = `<p id="kart-dil-${DEFAULT_CLUSTER_ID}" class="text-[11px] leading-snug text-muted-foreground">${ENGLISH_ONLY_SPECTRUM_LINE}</p>`;

describe("ClusterCard, an all-English cluster (h151-home-1)", () => {
  const members = membersOf(ENGLISH_NAMES);
  const html = render({ cluster: clusterOf(members.articles.length), ...members });

  it("prints the not-compared qualifier exactly once", () => {
    expect(countOf(html, ENGLISH_ONLY_SPECTRUM_LINE)).toBe(1);
    expect(countOf(html, QUALIFIER_P)).toBe(1);
  });

  it("keeps the zone bar (the bar truthfully shows the English outlets' zones)", () => {
    expect(html).toContain("İktidar");
    expect(html).toContain("spectrum-glow");
  });

  it("puts the qualifier after the bar and before the member list", () => {
    const glow = html.indexOf("spectrum-glow");
    const note = html.indexOf(QUALIFIER_P);
    const list = html.indexOf("<ul");
    expect(glow).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(glow);
    expect(list).toBeGreaterThan(note);
    // Directly after the bar's wrapper closes: nothing but the wrapper's end tags.
    const between = html.slice(glow, note);
    expect(between.endsWith("</div></div>")).toBe(true);
    // And the visible text reads bar first, qualifier second.
    const text = textOf(html);
    expect(text.indexOf(ENGLISH_ONLY_SPECTRUM_LINE)).toBeGreaterThan(text.indexOf("İktidar"));
  });

  it("draws no Denge (balance) chip, not even as an aria-label", () => {
    expect(html).not.toContain("Denge");
  });
});

describe("ClusterCard, the same distribution with Turkish outlets (h151-home-1)", () => {
  const members = membersOf(TURKISH_NAMES);
  const html = render({ cluster: clusterOf(members.articles.length), ...members });

  it("carries no qualifier and no note between the bar and the member list", () => {
    expect(html).not.toContain(ENGLISH_ONLY_SPECTRUM_LINE);
    const glow = html.indexOf("spectrum-glow");
    const list = html.indexOf("<ul");
    expect(glow).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(glow);
    expect(html.slice(glow, list)).not.toContain("<p");
  });

  it("still draws the Denge chip, so the English case above is not vacuous", () => {
    expect(textOf(html)).toContain("Denge");
  });
});

describe("ClusterCard, the Kör nokta badge (h151-home-1)", () => {
  it("is left off an all-English cluster even when it is flagged", () => {
    const members = membersOf(ENGLISH_NAMES);
    const html = render({
      cluster: clusterOf(members.articles.length, {
        is_blindspot: true,
        blindspot_side: "pro_government",
      }),
      ...members,
    });
    expect(html).not.toContain("Kör nokta");
    expect(countOf(html, ENGLISH_ONLY_SPECTRUM_LINE)).toBe(1);
  });

  it("stays on a flagged Turkish cluster", () => {
    const members = membersOf(TURKISH_NAMES);
    const html = render({
      cluster: clusterOf(members.articles.length, {
        is_blindspot: true,
        blindspot_side: "pro_government",
      }),
      ...members,
    });
    expect(countOf(html, "Kör nokta")).toBe(1);
    expect(html).not.toContain(ENGLISH_ONLY_SPECTRUM_LINE);
  });
});

describe("ClusterCard, clusters that are not language-isolated (h151-home-1)", () => {
  it("(d) a mixed cluster (Daily Sabah + Sözcü) has no qualifier and keeps its chip", () => {
    const members = membersOf([...ENGLISH_NAMES.slice(0, BALANCE_MIN_SOURCES - 1), "Sözcü"]);
    const html = render({ cluster: clusterOf(members.articles.length), ...members });
    expect(html).not.toContain(ENGLISH_ONLY_SPECTRUM_LINE);
    expect(textOf(html)).toContain("Denge");
  });

  it("(e) an English cluster with one unresolvable member is not isolated", () => {
    const members = membersOf(ENGLISH_NAMES);
    // The last article's source is not in `sources` and the article carries no
    // source_name: unknown, not English (politics-query.ts's rule).
    const last = members.articles.length - 1;
    members.articles[last] = { ...members.articles[last]!, source_id: "ghost-source" };
    const html = render({ cluster: clusterOf(members.articles.length), ...members });
    expect(html).not.toContain(ENGLISH_ONLY_SPECTRUM_LINE);
  });

  it("(f) an empty article list is not isolated", () => {
    const html = render({
      cluster: clusterOf(BALANCE_MIN_SOURCES),
      articles: [],
      sources: [],
    });
    expect(html).not.toContain(ENGLISH_ONLY_SPECTRUM_LINE);
  });

  it("a Turkish source_name on an article beats an English name in `sources`", () => {
    const members = membersOf(ENGLISH_NAMES);
    members.articles[0] = { ...members.articles[0]!, source_name: "Sözcü" };
    const html = render({ cluster: clusterOf(members.articles.length), ...members });
    expect(html).not.toContain(ENGLISH_ONLY_SPECTRUM_LINE);
  });

  it("a non-empty slug decides on its own: {slug: 'sozcu', name: 'Daily Sabah'} is Turkish", () => {
    const members = membersOf(ENGLISH_NAMES);
    members.sources[0] = { ...members.sources[0]!, slug: "sozcu" };
    const html = render({ cluster: clusterOf(members.articles.length), ...members });
    expect(html).not.toContain(ENGLISH_ONLY_SPECTRUM_LINE);
  });
});

describe("ClusterCard, how a member's name is resolved for the predicate (h151-home-1)", () => {
  it("takes an article's own source_name when its source row is missing", () => {
    const members = membersOf(ENGLISH_NAMES);
    const last = members.articles.length - 1;
    members.articles[last] = {
      ...members.articles[last]!,
      source_id: "ghost-source",
      source_name: "Daily Sabah",
    };
    const html = render({ cluster: clusterOf(members.articles.length), ...members });
    expect(countOf(html, ENGLISH_ONLY_SPECTRUM_LINE)).toBe(1);
  });

  it("judges every member, not only the first four the card lists", () => {
    // Five English outlets, then a sixth Turkish one: the fifth and sixth rows
    // are folded into "+N başka kaynak", but they still make the cluster mixed.
    const members = membersOf([...ENGLISH_NAMES.slice(0, 5), "Sözcü"], 6);
    const html = render({ cluster: clusterOf(members.articles.length), ...members });
    expect(html).toContain("+2 başka kaynak");
    expect(html).not.toContain(ENGLISH_ONLY_SPECTRUM_LINE);
  });
});

// ---------------------------------------------------------------------------
// h162-a11yname-1: the card link is named by the headline alone
// (aria-labelledby), so a voice-control user could not say the visible first
// words "Kör nokta" and a screen reader never read the source count, the age or
// the Denge line. The name is now the badge (when it is drawn) plus the
// headline, and the meta pills and the bar are the link's description. Every
// helper below walks the markup character by character: no regex strips tags,
// and every text rewrite is replaceAll.
// ---------------------------------------------------------------------------

/** The opening tag (`<a ...>`) that starts at `start`; React escapes `>` inside values. */
function openingTagAt(html: string, start: number): string {
  const end = html.indexOf(">", start);
  if (end === -1) throw new Error("unterminated tag");
  return html.slice(start, end + 1);
}

/** The value of attribute `name` inside one opening tag, or undefined. */
function attrOf(tag: string, name: string): string | undefined {
  const needle = ` ${name}="`;
  const at = tag.indexOf(needle);
  if (at === -1) return undefined;
  const from = at + needle.length;
  const to = tag.indexOf('"', from);
  return to === -1 ? undefined : tag.slice(from, to);
}

/** The card link's opening tag: the only `<a ` in a card (the article tag is `<article`). */
function cardLinkTag(html: string): string {
  const at = html.indexOf("<a ");
  if (at === -1) throw new Error("no link in the card");
  return openingTagAt(html, at);
}

/** Inner markup of the element carrying id="`id`", found by depth counting. */
function innerOfId(html: string, id: string): string {
  const at = html.indexOf(` id="${id}"`);
  if (at === -1) throw new Error(`no element with id ${id}`);
  const openEnd = html.indexOf(">", at);
  let depth = 1;
  let i = openEnd + 1;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const tag = openingTagAt(html, lt);
    if (tag.startsWith("</")) {
      depth -= 1;
      if (depth === 0) return html.slice(openEnd + 1, lt);
    } else if (!tag.endsWith("/>") && !tag.startsWith("<!")) {
      depth += 1;
    }
    i = lt + tag.length;
  }
  throw new Error(`element ${id} is not closed`);
}

/**
 * Every element opening tag in `html`, in order, with two facts a character walk
 * can know: whether the element has no content at all (its end tag follows at
 * once, as the bar segments do), and whether any ancestor within `html` carries
 * aria-hidden="true".
 */
function tagsWithContext(
  html: string,
): Array<{ tag: string; empty: boolean; hiddenAncestor: boolean }> {
  const out: Array<{ tag: string; empty: boolean; hiddenAncestor: boolean }> = [];
  const open: boolean[] = []; // one entry per open element: is it aria-hidden?
  let from = 0;
  for (;;) {
    const lt = html.indexOf("<", from);
    if (lt === -1) return out;
    const tag = openingTagAt(html, lt);
    from = lt + tag.length;
    if (tag.startsWith("</")) {
      open.pop();
      continue;
    }
    if (tag.startsWith("<!")) continue;
    out.push({
      tag,
      empty: html.startsWith("</", from),
      hiddenAncestor: open.some((hidden) => hidden),
    });
    if (!tag.endsWith("/>")) open.push(attrOf(tag, "aria-hidden") === "true");
  }
}

/** Every id="..." in a markup string, in order. */
function allIds(html: string): string[] {
  const ids: string[] = [];
  let from = 0;
  for (;;) {
    const lt = html.indexOf("<", from);
    if (lt === -1) return ids;
    const tag = openingTagAt(html, lt);
    const id = attrOf(tag, "id");
    if (id !== undefined) ids.push(id);
    from = lt + tag.length;
  }
}

/** Entities React writes in text, decoded; `&amp;` last so nothing is decoded twice. */
function decodeEntities(text: string): string {
  return text
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Whitespace runs become one space and the ends are trimmed (a character walk). */
function squash(text: string): string {
  let out = "";
  let pending = false;
  for (const ch of text) {
    if (ch.trim() === "") {
      pending = true;
      continue;
    }
    if (pending && out !== "") out += " ";
    pending = false;
    out += ch;
  }
  return out;
}

/** Text of one element by id, entities decoded and whitespace squashed. */
function textOfId(html: string, id: string): string {
  return squash(decodeEntities(textOf(innerOfId(html, id))));
}

/** The accessible name the link's aria-labelledby resolves to: target texts joined by one space. */
function resolvedName(html: string): string {
  const ids = (attrOf(cardLinkTag(html), "aria-labelledby") ?? "").split(" ").filter((s) => s !== "");
  return ids.map((id) => textOfId(html, id)).join(" ");
}

const TITLE = "COP31 Zirvesi. Bakan Kurum'dan açıklamalar";
const CLUSTER_ID = DEFAULT_CLUSTER_ID;
const SIX_TURKISH = membersOf(TURKISH_NAMES, 6);
const SIX_ENGLISH = membersOf(ENGLISH_NAMES, 6);

function nameCard(
  members: ReturnType<typeof membersOf>,
  over: Partial<ClusterCardCluster> = {},
): string {
  return render({
    cluster: clusterOf(6, { id: CLUSTER_ID, title_tr: TITLE, ...over }),
    ...members,
  });
}

describe("card link name (h162-a11yname-1)", () => {
  it("a flagged Turkish card names its link by the badge, then the headline", () => {
    const html = nameCard(SIX_TURKISH, { is_blindspot: true, blindspot_side: "pro_government" });
    expect(attrOf(cardLinkTag(html), "aria-labelledby")).toBe(
      `kart-rozet-${CLUSTER_ID} kart-baslik-${CLUSTER_ID}`,
    );
    expect(textOfId(html, `kart-rozet-${CLUSTER_ID}`)).toBe("Kör nokta");
    // The badge is drawn before the headline, so the name reads like the card.
    const badgeAt = html.indexOf(` id="kart-rozet-${CLUSTER_ID}"`);
    const headingAt = html.indexOf(` id="kart-baslik-${CLUSTER_ID}"`);
    expect(badgeAt).toBeGreaterThan(-1);
    expect(headingAt).toBeGreaterThan(badgeAt);
    // WCAG 2.5.3: the name starts with the visible label; and stays short
    // (no member headlines, no meta line).
    expect(resolvedName(html).startsWith(`Kör nokta ${TITLE}`)).toBe(true);
    expect(resolvedName(html)).toBe(`Kör nokta ${TITLE}`);
  });

  it("an unflagged card keeps the headline as its whole name and draws no badge id", () => {
    const html = nameCard(SIX_TURKISH);
    expect(attrOf(cardLinkTag(html), "aria-labelledby")).toBe(`kart-baslik-${CLUSTER_ID}`);
    expect(html).not.toContain("kart-rozet-");
    expect(resolvedName(html)).toBe(TITLE);
  });

  it("a flagged all-English card draws no badge, so its name is the headline only", () => {
    const html = nameCard(SIX_ENGLISH, { is_blindspot: true, blindspot_side: "pro_government" });
    expect(html).not.toContain("Kör nokta");
    expect(html).not.toContain("kart-rozet-");
    expect(attrOf(cardLinkTag(html), "aria-labelledby")).toBe(`kart-baslik-${CLUSTER_ID}`);
    expect(resolvedName(html)).toBe(TITLE);
  });

  it("every labelledby target exists once, and inside the link", () => {
    const html = nameCard(SIX_TURKISH, { is_blindspot: true, blindspot_side: "pro_government" });
    const linkAt = html.indexOf("<a ");
    const linkEnd = html.indexOf("</a>");
    for (const id of [`kart-rozet-${CLUSTER_ID}`, `kart-baslik-${CLUSTER_ID}`]) {
      expect(countOf(html, ` id="${id}"`)).toBe(1);
      const at = html.indexOf(` id="${id}"`);
      expect(at).toBeGreaterThan(linkAt);
      expect(at).toBeLessThan(linkEnd);
    }
  });
});

describe("card link description (h162-a11yname-1)", () => {
  const META = `kart-meta-${CLUSTER_ID}`;
  const SPECTRUM = `kart-spektrum-${CLUSTER_ID}`;

  it("points aria-describedby at the meta line, then the spectrum bar", () => {
    const html = nameCard(SIX_TURKISH);
    expect(attrOf(cardLinkTag(html), "aria-describedby")).toBe(`${META} ${SPECTRUM}`);
    expect(countOf(html, ` id="${META}"`)).toBe(1);
    expect(countOf(html, ` id="${SPECTRUM}"`)).toBe(1);
    expect(html.indexOf(` id="${SPECTRUM}"`)).toBeGreaterThan(html.indexOf(` id="${META}"`));
  });

  it("the meta element holds the source count and the Denge line; the spectrum element holds the bar", () => {
    const html = nameCard(SIX_TURKISH);
    const meta = textOfId(html, META);
    expect(meta).toContain("6 kaynak");
    expect(meta).toContain("Denge");
    expect(textOfId(html, SPECTRUM)).toContain("İktidar");
  });

  it("the spectrum id sits on the existing spectrum-glow wrapper, not on a new element", () => {
    const html = nameCard(SIX_TURKISH);
    const at = html.indexOf(` id="${SPECTRUM}"`);
    const tag = openingTagAt(html, html.lastIndexOf("<", at));
    expect(attrOf(tag, "class")).toBe("spectrum-glow rounded");
    expect(tag.startsWith("<div ")).toBe(true);
  });

  it("the meta line carries no second 'Kör nokta' on a flagged card (the badge is in the name)", () => {
    const html = nameCard(SIX_TURKISH, { is_blindspot: true, blindspot_side: "pro_government" });
    expect(textOfId(html, META)).not.toContain("Kör nokta");
    expect(textOfId(html, SPECTRUM)).not.toContain("Kör nokta");
    expect(countOf(html, "Kör nokta")).toBe(1);
  });

  // react-a11y-2 (h163): on an all-English card the bar says "İktidar %100" and
  // the meta row has no Denge chip; the qualifier that tells a sighted user the
  // bar is not compared with Turkish sources sits in a sibling <p> outside both
  // targets. The <p> joins the description, so focus announces it too.
  it("an all-English card names its meta, spectrum and English-only note elements", () => {
    const html = nameCard(SIX_ENGLISH);
    const NOTE = `kart-dil-${CLUSTER_ID}`;
    expect(attrOf(cardLinkTag(html), "aria-describedby")).toBe(`${META} ${SPECTRUM} ${NOTE}`);
    expect(textOfId(html, META)).toContain("6 kaynak");
    expect(countOf(html, ` id="${NOTE}"`)).toBe(1);
    expect(textOfId(html, NOTE)).toBe(ENGLISH_ONLY_SPECTRUM_LINE);
    // The note sits inside the link it describes, after the spectrum target.
    const at = html.indexOf(` id="${NOTE}"`);
    expect(at).toBeGreaterThan(html.indexOf(` id="${SPECTRUM}"`));
    expect(at).toBeGreaterThan(html.indexOf("<a "));
    expect(at).toBeLessThan(html.indexOf("</a>"));
    // The id rides on the existing qualifier <p>, not on a new element.
    const tag = openingTagAt(html, html.lastIndexOf("<", at));
    expect(tag.startsWith("<p ")).toBe(true);
    expect(attrOf(tag, "class")).toBe("text-[11px] leading-snug text-muted-foreground");
  });

  it("a Turkish card still describes the link by meta and spectrum only, with no note id", () => {
    const html = nameCard(SIX_TURKISH);
    expect(attrOf(cardLinkTag(html), "aria-describedby")).toBe(`${META} ${SPECTRUM}`);
    expect(html).not.toContain("kart-dil-");
    expect(html).not.toContain(ENGLISH_ONLY_SPECTRUM_LINE);
  });

  // react-a11y-1 (h163): the bar's segments are empty divs with a title, which
  // accname step 2I turns into a name, so the description read every zone twice
  // (once from the bar, once from the legend). The bar container is aria-hidden.
  it("the empty titled bar segments inside the spectrum target sit under an aria-hidden element", () => {
    // 4 İktidar + 2 Muhalefet: two bar segments and two legend spans carry a title.
    const html = nameCard(SIX_TURKISH, {
      bias_distribution: { ...ZERO_DISTRIBUTION, pro_government: 4, opposition: 2 },
    });
    const inner = innerOfId(html, SPECTRUM);
    const tags = tagsWithContext(inner);
    const titled = tags.filter((t) => attrOf(t.tag, "title") !== undefined);
    expect(titled).toHaveLength(4);

    const segments = titled.filter((t) => t.empty);
    const legend = titled.filter((t) => !t.empty);
    expect(segments).toHaveLength(2);
    expect(legend).toHaveLength(2);
    // Every text-less segment has an aria-hidden ancestor; no legend span does.
    for (const s of segments) expect(s.hiddenAncestor).toBe(true);
    for (const l of legend) expect(l.hiddenAncestor).toBe(false);

    // The simpler form of the same fact: the compact root's first child <div>
    // is the aria-hidden bar, and both segment titles come after it, before the
    // legend's first title.
    const hiddenAt = inner.indexOf(' aria-hidden="true"');
    expect(hiddenAt).toBeGreaterThan(-1);
    const firstTitle = inner.indexOf(' title="');
    expect(firstTitle).toBeGreaterThan(hiddenAt);
    // Nothing the screen reader should read is hidden: the legend text is not.
    const text = textOfId(html, SPECTRUM);
    expect(text).toContain("İktidar");
    expect(text).toContain("Muhalefet");
    expect(text).toContain("%67");
    expect(text).toContain("%33");
  });

  it("the spectrum target holds exactly one aria-hidden element: the bar container", () => {
    const html = nameCard(SIX_TURKISH, {
      bias_distribution: { ...ZERO_DISTRIBUTION, pro_government: 4, opposition: 2 },
    });
    const inner = innerOfId(html, SPECTRUM);
    expect(countOf(inner, ' aria-hidden="true"')).toBe(1);
  });
});

describe("card ids on a page with several cards (h162-a11yname-1)", () => {
  it("two different clusters rendered side by side never share an id", () => {
    const a = clusterOf(6, {
      id: "aaaaaaaa-0000-4000-8000-00000000000a",
      is_blindspot: true,
      blindspot_side: "pro_government",
    });
    const b = clusterOf(6, { id: "bbbbbbbb-0000-4000-8000-00000000000b" });
    const html = renderToStaticMarkup(
      <>
        <ClusterCard cluster={a} {...SIX_TURKISH} index={0} />
        <ClusterCard cluster={b} {...SIX_TURKISH} index={1} />
      </>,
    );
    const ids = allIds(html);
    // Flagged card: rozet, baslik, meta, spektrum. Unflagged card: three.
    expect(ids.filter((id) => id.startsWith("kart-"))).toHaveLength(7);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
