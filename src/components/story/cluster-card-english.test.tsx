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

function clusterOf(
  voters: number,
  over: Partial<ClusterCardCluster> = {},
): ClusterCardCluster {
  return {
    id: "92742df8-0000-4000-8000-000000000001",
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

const QUALIFIER_P = `<p class="text-[11px] leading-snug text-muted-foreground">${ENGLISH_ONLY_SPECTRUM_LINE}</p>`;

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
