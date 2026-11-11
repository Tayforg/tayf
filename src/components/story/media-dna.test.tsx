import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { MEDIA_DNA_EMPTY_CLASS, MediaDna, mediaDnaChipClass } from "./media-dna";
import { toMediaDnaSources, type MediaDnaSource } from "./media-dna-sources";
import { ZONE_META } from "@/lib/bias/config";
import { SOURCE_KIND_META } from "@/lib/sources/kind";
import type { Source } from "@/types";

// The repo has no jsdom/testing-library (see cluster-merge-actions.test.tsx), so
// the 'Tüm N kaynağı göster' click cannot go through a DOM. `useState` is swapped
// for a tiny slot store that is only ARMED inside the click-driven describe below:
// the component function is called directly, its element tree is walked for the
// toggle button, onClick is invoked, and the component is rendered again. Unarmed
// (every other test in this file) it is the real hook under renderToStaticMarkup.
const hooks = vi.hoisted(() => ({ armed: false, slots: [] as unknown[], cursor: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      if (!hooks.armed) return (actual.useState as (i: unknown) => unknown)(init);
      const i = hooks.cursor++;
      if (!(i in hooks.slots)) hooks.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        hooks.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks.slots[i]) : v;
      };
      return [hooks.slots[i], set];
    },
  };
});

function source(overrides: Partial<Source>): Source {
  return {
    id: overrides.id ?? overrides.slug ?? "src",
    name: overrides.name ?? "Kaynak",
    slug: overrides.slug ?? "kaynak",
    url: "https://example.com",
    rss_url: "https://example.com/rss",
    bias: overrides.bias ?? "center",
    logo_url: null,
    active: true,
    trustee_since: null,
    trustee_note: null,
    ...overrides,
  };
}

describe("MediaDna screen-reader detail", () => {
  const outlet = source({ id: "1", slug: "outlet-a", name: "Outlet A", bias: "center", kind: "outlet" });
  const aggregator = source({ id: "2", slug: "agg-a", name: "Agg A", bias: "center", kind: "aggregator" });
  const highlightSlugs = new Set(["outlet-a", "agg-a"]);

  const html = renderToStaticMarkup(
    <MediaDna sources={[outlet, aggregator]} highlightSlugs={highlightSlugs} />,
  );

  it("gives the non-voting (aggregator) chip a sr-only note that it does not count toward the bias distribution", () => {
    expect(html).toContain("yanlılık dağılımına sayılmaz");
    // The sr-only note text sits right after the source name, inside a
    // class="sr-only" span, distinct from the always-visible title attribute.
    expect(html).toMatch(/class="sr-only"[^>]*>[^<]*yanlılık dağılımına sayılmaz/);
  });

  it("gives the voting (outlet) chip its bias label in sr-only text, without the non-voting note", () => {
    // Extract the sr-only span that immediately follows "Outlet A".
    const idx = html.indexOf("Outlet A");
    expect(idx).toBeGreaterThan(-1);
    const after = html.slice(idx, idx + 400);
    const srMatch = after.match(/class="sr-only"[^>]*>([^<]*)</);
    expect(srMatch).toBeTruthy();
    expect(srMatch![1]).not.toContain("yanlılık dağılımına sayılmaz");
  });
});

// WCAG 1.4.3: chips and their kind labels used to be faded with opacity-50 /
// opacity-30 / opacity-70, which measures 2.0-3.25:1. Non-voting chips are now
// told apart by a dashed border, expanded-mode non-participants by dropping
// the tint, and nothing carries an opacity utility any more.
describe("mediaDnaChipClass (no opacity fading)", () => {
  const meta = ZONE_META.bagimsiz;
  // A bare opacity-NN / opacity-[x] utility; variant forms (hover:, disabled:,
  // group-hover/x:) are not text fading and are skipped, like the guard test.
  const BARE_OPACITY = /(?<![\w:\/-])opacity-/;

  it("voting + highlighted: zone tint, text and border, solid border", () => {
    const cls = mediaDnaChipClass(meta, { isVoting: true, isHighlighted: true });
    expect(cls).toContain(meta.chipBg);
    expect(cls).toContain(meta.chipText);
    expect(cls).toContain(meta.chipBorder);
    expect(cls).not.toContain("border-dashed");
  });

  it("non-voting + highlighted: zone tint and full-strength text on a dashed border", () => {
    const cls = mediaDnaChipClass(meta, { isVoting: false, isHighlighted: true });
    expect(cls).toContain("border-dashed");
    expect(cls).toContain(meta.chipBg);
    expect(cls).toContain(meta.chipText);
  });

  it("voting + not highlighted: tint dropped, text and border kept", () => {
    const cls = mediaDnaChipClass(meta, { isVoting: true, isHighlighted: false });
    expect(cls).toContain("bg-transparent");
    expect(cls).not.toContain(meta.chipBg);
    expect(cls).toContain(meta.chipText);
    expect(cls).toContain(meta.chipBorder);
    expect(cls).not.toContain("border-dashed");
  });

  it("non-voting + not highlighted: dashed border and no tint", () => {
    const cls = mediaDnaChipClass(meta, { isVoting: false, isHighlighted: false });
    expect(cls).toContain("border-dashed");
    expect(cls).toContain("bg-transparent");
    expect(cls).not.toContain(meta.chipBg);
    expect(cls).toContain(meta.chipText);
  });

  it("never carries an opacity utility, in any combination or zone", () => {
    for (const zoneMeta of Object.values(ZONE_META)) {
      for (const isVoting of [true, false]) {
        for (const isHighlighted of [true, false]) {
          const cls = mediaDnaChipClass(zoneMeta, { isVoting, isHighlighted });
          expect(cls).not.toMatch(BARE_OPACITY);
          expect(cls).not.toContain("transition-opacity");
        }
      }
    }
  });
});

describe("MediaDna collapsed render (contrast + zone count)", () => {
  const gov = source({ id: "g", slug: "gov", name: "Gov Outlet", bias: "pro_government", kind: "outlet" });
  const mid = source({ id: "c", slug: "mid", name: "Mid Outlet", bias: "center", kind: "outlet" });
  const opp = source({ id: "o", slug: "opp", name: "Opp Outlet", bias: "opposition", kind: "outlet" });
  const agg = source({ id: "a", slug: "agg", name: "Agg Outlet", bias: "center", kind: "aggregator" });
  const html = renderToStaticMarkup(
    <MediaDna
      sources={[gov, mid, opp, agg]}
      highlightSlugs={new Set(["gov", "mid", "opp", "agg"])}
    />,
  );

  it("carries no opacity-NN utility anywhere in the markup", () => {
    expect(html).not.toMatch(/opacity-\d/);
  });

  it("gives the non-voting (aggregator) chip a dashed border", () => {
    const m = html.match(/<span title="Agg Outlet[^"]*" class="([^"]*)"/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain("border-dashed");
    // A voting chip next to it keeps the solid border.
    const voting = html.match(/<span title="Mid Outlet[^"]*" class="([^"]*)"/);
    expect(voting).toBeTruthy();
    expect(voting![1]).not.toContain("border-dashed");
  });

  it("renders the kind label at 10px with no opacity", () => {
    const label = SOURCE_KIND_META.aggregator.label;
    const m = html.match(new RegExp(`<span class="([^"]*)">${label}</span>`));
    expect(m).toBeTruthy();
    expect(m![1]).toBe("ml-0.5 text-[10px] uppercase tracking-wider");
  });

  it("explains non-voting chips with the dashed-border legend, not the old 'Soluk' copy", () => {
    expect(html).toContain(
      "Kesikli çerçeveyle gösterilen toplayıcı / niş kaynaklar kümelerde listelenir ama yanlılık dağılımına sayılmaz.",
    );
    expect(html).not.toContain("Soluk");
  });

  it("renders each zone's 'N kaynak' count as ONE text node in the zone label colour", () => {
    const matches = [...html.matchAll(/<span class="([^"]*)">(\d+) kaynak<\/span>/g)];
    // muhalefet, bagimsiz, iktidar (ZONE_ORDER).
    expect(matches).toHaveLength(3);
    const zones = ["muhalefet", "bagimsiz", "iktidar"] as const;
    zones.forEach((zone, i) => {
      const [, cls] = matches[i]!;
      expect(cls).toContain(ZONE_META[zone].zoneLabel);
      expect(cls).toContain("text-[10px]");
      expect(cls).not.toContain("text-muted-foreground");
    });
    // Count semantics unchanged: members in the current (collapsed) view.
    expect(matches.map((m) => m[2])).toEqual(["1", "2", "1"]);
  });
});

// WCAG 1.4.3: the empty-zone label ("Hiç kaynak yok") was 11 px italic
// text-muted-foreground on a tinted zone card (bg-<hue>-500/10..20 over the
// card), which measured below 4.5:1 on the zinc zone in dark mode. It now uses
// the foreground token at 80 %, measured in tests/guards/text-contrast-tokens.
describe("MEDIA_DNA_EMPTY_CLASS (empty-zone label contrast)", () => {
  it("drops text-muted-foreground and keeps the italic 11px label", () => {
    expect(MEDIA_DNA_EMPTY_CLASS).not.toContain("text-muted-foreground");
    expect(MEDIA_DNA_EMPTY_CLASS).toContain("text-foreground/80");
    expect(MEDIA_DNA_EMPTY_CLASS).toContain("italic");
    expect(MEDIA_DNA_EMPTY_CLASS).toContain("text-[11px]");
  });

  it("renders 'Hiç kaynak yok' in the two zones that have no participating source", () => {
    const only = source({ id: "m", slug: "only-mid", name: "Only Mid", bias: "center", kind: "outlet" });
    const html = renderToStaticMarkup(
      <MediaDna sources={[only]} highlightSlugs={new Set(["only-mid"])} />,
    );
    const empties = [...html.matchAll(/<span class="([^"]*)">Hiç kaynak yok<\/span>/g)];
    // muhalefet + iktidar are empty; bagimsiz holds the one source.
    expect(empties).toHaveLength(2);
    for (const [, cls] of empties) expect(cls).toBe(MEDIA_DNA_EMPTY_CLASS);
  });

  it("renders no empty label when every zone has a participating source", () => {
    const html = renderToStaticMarkup(
      <MediaDna
        sources={[
          source({ id: "g", slug: "gov", bias: "pro_government" }),
          source({ id: "c", slug: "mid", bias: "center" }),
          source({ id: "o", slug: "opp", bias: "opposition" }),
        ]}
        highlightSlugs={new Set(["gov", "mid", "opp"])}
      />,
    );
    expect(html).not.toContain("Hiç kaynak yok");
  });
});

// The cluster page projects the directory with toMediaDnaSources, so the client
// component only ever receives these four fields (name, slug, bias, kind). This file is .tsx, so tsc
// checks the type-level assertion (the .test.ts files are excluded from it).
describe("MediaDna narrowed sources", () => {
  it("accepts exactly the MediaDnaSource projection", () => {
    expectTypeOf<ComponentProps<typeof MediaDna>["sources"]>().toEqualTypeOf<MediaDnaSource[]>();
  });

  it("renders the same chips from the projection as from the full rows", () => {
    const rows = [
      source({ id: "g", slug: "gov", name: "Gov Outlet", bias: "pro_government", kind: "outlet" }),
      source({ id: "c", slug: "mid", name: "Mid Outlet", bias: "center", kind: "aggregator" }),
      source({ id: "o", slug: "opp", name: "Opp Outlet", bias: "opposition" }),
    ];
    const highlight = new Set(["gov", "mid"]);
    const full = renderToStaticMarkup(<MediaDna sources={rows} highlightSlugs={highlight} />);
    const narrow = renderToStaticMarkup(
      <MediaDna sources={toMediaDnaSources(rows)} highlightSlugs={highlight} />,
    );
    expect(narrow).toBe(full);
    expect(narrow).toContain("Tüm 3 kaynağı göster");
  });
});

// WCAG 2.5.8 (h21-a11y-2): the 'Tüm N kaynağı göster' toggle is a standalone
// button, not inline text, and measured 117x17 px with only `text-[11px]`. It
// needs a 24 px box on desktop (min-h-6) and the 44 px size on narrow screens
// like the share chips. The copy itself is unchanged.
describe("MediaDna show-all toggle (target size)", () => {
  const rows = [
    source({ id: "g", slug: "gov", name: "Gov Outlet", bias: "pro_government", kind: "outlet" }),
    source({ id: "c", slug: "mid", name: "Mid Outlet", bias: "center", kind: "outlet" }),
    source({ id: "o", slug: "opp", name: "Opp Outlet", bias: "opposition", kind: "outlet" }),
  ];

  /** Class tokens and label of the one <button> in `html` (character scan, no tag-stripping regex). */
  function toggleOf(html: string): { tokens: string[]; label: string } {
    const open = html.indexOf("<button");
    expect(open).toBeGreaterThanOrEqual(0);
    const close = html.indexOf(">", open);
    const tag = html.slice(open, close + 1);
    const classAt = tag.indexOf('class="');
    expect(classAt).toBeGreaterThanOrEqual(0);
    const classEnd = tag.indexOf('"', classAt + 'class="'.length);
    const tokens = tag
      .slice(classAt + 'class="'.length, classEnd)
      .split(" ")
      .filter((t) => t !== "");
    const label = html.slice(close + 1, html.indexOf("</button>", close));
    return { tokens, label };
  }

  it("is a 24 px (desktop) / 44 px (mobile) box with the label centred", () => {
    const html = renderToStaticMarkup(<MediaDna sources={rows} highlightSlugs={new Set(["gov"])} />);
    const { tokens, label } = toggleOf(html);
    for (const t of ["inline-flex", "items-center", "min-h-6", "max-sm:min-h-11", "text-[11px]"]) {
      expect(tokens).toContain(t);
    }
    expect(label).toBe("Tüm 3 kaynağı göster");
  });

  it("renders no toggle when there is no highlight filter to collapse to", () => {
    const html = renderToStaticMarkup(<MediaDna sources={rows} />);
    expect(html).not.toContain("<button");
  });
});

// h27-resilience-2: the cluster page passes `allSources: []` when the source
// directory read failed (a live directory is never empty). The chart must say
// so instead of printing "Hiç kaynak yok" three times and "Tüm 0 kaynağı göster".
describe("MediaDna with an unavailable source directory", () => {
  const html = renderToStaticMarkup(
    <MediaDna sources={[]} highlightSlugs={new Set(["gov", "mid"])} />,
  );

  it("keeps the header and says the source information could not be loaded", () => {
    expect(html).toContain("Medya DNA&#x27;sı");
    expect(html).toContain(
      "Kaynak bilgisi şu an alınamadı. Sayfayı birkaç dakika sonra yenileyebilirsiniz.",
    );
  });

  it("never shows the empty-zone label or the show-all toggle", () => {
    expect(html).not.toContain("Hiç kaynak yok");
    expect(html).not.toContain("kaynağı göster");
    expect(html).not.toContain("<button");
  });

  it("renders none of the bar, the zone cards or the legend", () => {
    expect(html).not.toContain("bg-emerald-500");
    expect(html).not.toContain("bg-zinc-400");
    expect(html).not.toContain("bg-red-500");
    expect(html).not.toContain("0 kaynak");
    expect(html).not.toContain("Kesikli çerçeveyle");
    for (const zone of Object.values(ZONE_META)) {
      expect(html).not.toContain(zone.label);
    }
  });

  it("is the same without a highlight set", () => {
    const bare = renderToStaticMarkup(<MediaDna sources={[]} />);
    expect(bare).toContain("Kaynak bilgisi şu an alınamadı");
    expect(bare).not.toContain("Hiç kaynak yok");
    expect(bare).not.toContain("kaynağı göster");
  });

  it("still renders the normal chart for a non-empty directory", () => {
    const normal = renderToStaticMarkup(
      <MediaDna sources={[source({ id: "m", slug: "mid", bias: "center" })]} />,
    );
    expect(normal).not.toContain("Kaynak bilgisi şu an alınamadı");
    expect(normal).toContain("bg-zinc-400");
  });
});

// h99-clientjs-2: the id was only ever the React key of a chip. The projection
// no longer carries it, so the chips are keyed by `slug` (UNIQUE in `sources`).
describe("MediaDna chip keys (h99-clientjs-2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Literals typed as the projection itself: no id anywhere.
  const rows: MediaDnaSource[] = [
    { name: "Gov Outlet", slug: "gov", bias: "pro_government", kind: "outlet" },
    { name: "Mid Outlet", slug: "mid", bias: "center", kind: "outlet" },
    { name: "Mid Agg", slug: "mid-agg", bias: "center", kind: "aggregator" },
    { name: "Opp Outlet", slug: "opp", bias: "opposition", kind: "outlet" },
  ];

  it("renders an id-less projection without a React key warning", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToStaticMarkup(
      <MediaDna sources={rows} highlightSlugs={new Set(["gov", "mid", "mid-agg", "opp"])} />,
    );
    expect(errors).not.toHaveBeenCalled();
    for (const r of rows) expect(html).toContain(r.name);
  });

  it("keeps the chips in zone order and the highlightSlugs / voting / non-voting rendering unchanged", () => {
    const html = renderToStaticMarkup(
      <MediaDna sources={rows} highlightSlugs={new Set(["mid", "mid-agg"])} />,
    );
    // Collapsed view: only the two participants, voting chip solid, aggregator dashed.
    expect(html).not.toContain("Gov Outlet");
    expect(html).not.toContain("Opp Outlet");
    const voting = html.match(/<span title="Mid Outlet[^"]*" class="([^"]*)"/);
    const nonVoting = html.match(/<span title="Mid Agg[^"]*" class="([^"]*)"/);
    expect(voting?.[1]).not.toContain("border-dashed");
    expect(nonVoting?.[1]).toContain("border-dashed");
    expect(html.indexOf("Mid Outlet")).toBeLessThan(html.indexOf("Mid Agg"));
    expect(html).toContain("Tüm 4 kaynağı göster");
  });

  it("emits no source id: the markup is the same whatever ids the full rows had", () => {
    const withIds = (ids: string[]) =>
      renderToStaticMarkup(
        <MediaDna
          sources={toMediaDnaSources(
            rows.map((r, i) => source({ ...r, id: ids[i] ?? "x" })),
          )}
          highlightSlugs={new Set(["mid"])}
        />,
      );
    expect(withIds(["1", "2", "3", "4"])).toBe(withIds(["a", "b", "c", "d"]));
  });

  it("keys chips by slug in the source, not by an id field", () => {
    const comp = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "media-dna.tsx"), "utf8");
    expect(comp).toContain("key={source.slug}");
    expect(comp).not.toMatch(/\bsource\.id\b/);
  });

  it("names no hard-coded directory size in its doc comments", () => {
    const comp = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "media-dna.tsx"), "utf8");
    const sourcesModule = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "media-dna-sources.ts"),
      "utf8",
    );
    expect(comp).not.toMatch(/\b144\b/);
    expect(sourcesModule).not.toMatch(/\b118\b/);
  });
});

// ---------------------------------------------------------------------------
// h126-a11y-1: in the opt-in expanded view ('Tüm N kaynağı göster', story set
// present) the outlets that covered the story were marked ONLY by the chip tint
// (about 1.2:1 against the zone card): WCAG 1.4.1 (colour alone) and 1.3.1
// (nothing programmatic; a screen reader heard N identical chips). The covering
// chips now carry a '✓' glyph plus sr-only 'bu haberde var', the others sr-only
// 'bu haberde yok', one legend line explains the mark, the zone count reads
// 'covering/total kaynak', and the toggle exposes aria-expanded.
// ---------------------------------------------------------------------------

type DnaProps = ComponentProps<typeof MediaDna>;

const LEGEND_COPY = "Onay işaretli (✓) kaynaklar bu haberi yazdı; işaretsiz olanlar yazmadı.";
const LEGEND_P = `<p class="text-[10px] text-muted-foreground">${LEGEND_COPY}</p>`;
/** The covering-chip glyph element: `<span ... aria-hidden="true" ...>✓</span>`. */
const GLYPH = /<span[^>]*aria-hidden="true"[^>]*>✓<\/span>/g;

afterEach(() => {
  hooks.armed = false;
  hooks.slots.length = 0;
  hooks.cursor = 0;
});

/** The `<button>` element with an onClick in a React element tree, null when absent. */
function findToggle(node: unknown): { props: { onClick?: () => void } } | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findToggle(n);
      if (f) return f;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const el = node as { type?: unknown; props?: { children?: unknown; onClick?: () => void } };
  if (el.type === "button" && typeof el.props?.onClick === "function") {
    return el as { props: { onClick?: () => void } };
  }
  return findToggle(el.props?.children);
}

/** Mounts MediaDna on the armed slot store. `html()` re-renders, `click()` presses the toggle. */
function mount(props: DnaProps) {
  hooks.armed = true;
  hooks.slots.length = 0;
  return {
    html(): string {
      hooks.cursor = 0;
      return renderToStaticMarkup(<MediaDna {...props} />);
    },
    click(): void {
      hooks.cursor = 0;
      const tree = (MediaDna as unknown as (p: DnaProps) => unknown)(props);
      const toggle = findToggle(tree);
      expect(toggle, "toggle button").not.toBeNull();
      toggle!.props.onClick!();
    },
  };
}

/** Markup after one press of the toggle. */
function expandedHtml(props: DnaProps): string {
  const m = mount(props);
  m.click();
  return m.html();
}

/** One whole chip `<span title="NAME — ...">...</span>`, nested spans included (depth scan). */
function chipOf(html: string, name: string): string {
  const start = html.indexOf(`<span title="${name} — `);
  expect(start, `chip ${name} is rendered`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < html.length; ) {
    if (html.startsWith("</span>", i)) {
      depth -= 1;
      i += "</span>".length;
      if (depth === 0) return html.slice(start, i);
    } else if (html.startsWith("<span", i) && (html[i + 5] === " " || html[i + 5] === ">")) {
      depth += 1;
      i += 5;
    } else {
      i += 1;
    }
  }
  throw new Error(`unterminated chip ${name}`);
}

/** The text of each zone header count (muhalefet, bagimsiz, iktidar), e.g. '1/2 kaynak'. */
function zoneCounts(html: string): string[] {
  return [...html.matchAll(/<span class="text-\[10px\] [^"]*">([^<]*) kaynak<\/span>/g)].map(
    (m) => `${m[1]} kaynak`,
  );
}

function toggleTag(html: string): string {
  const open = html.indexOf("<button");
  expect(open, "a toggle button is rendered").toBeGreaterThanOrEqual(0);
  return html.slice(open, html.indexOf(">", open) + 1);
}

describe("MediaDna expanded view marks which outlets covered the story (h126-a11y-1)", () => {
  // Two sources in the same (bagimsiz) zone; only 'a' covered the story.
  const a = source({ id: "a", slug: "a", name: "Alfa Gazete", bias: "center", kind: "outlet" });
  const b = source({ id: "b", slug: "b", name: "Beta Haber", bias: "center", kind: "outlet" });
  const props: DnaProps = { sources: [a, b], highlightSlugs: new Set(["a"]) };

  it("before the click: no 'bu haberde' text, no glyph, no legend, aria-expanded=false", () => {
    const html = mount(props).html();
    expect(html).not.toContain("bu haberde");
    expect(html).not.toContain("✓");
    expect(html).not.toContain(LEGEND_COPY);
    expect(toggleTag(html)).toContain('aria-expanded="false"');
    expect(html).toContain("Tüm 2 kaynağı göster");
    expect(zoneCounts(html)).toEqual(["0 kaynak", "1 kaynak", "0 kaynak"]);
  });

  it("after the click: the covering chip has the glyph and 'bu haberde var'", () => {
    const chip = chipOf(expandedHtml(props), "Alfa Gazete");
    expect(chip).toContain("✓");
    expect(chip).toContain("bu haberde var");
    expect(chip).not.toContain("bu haberde yok");
  });

  it("after the click: the other chip has 'bu haberde yok' and no glyph", () => {
    const chip = chipOf(expandedHtml(props), "Beta Haber");
    expect(chip).toContain("bu haberde yok");
    expect(chip).not.toContain("✓");
    expect(chip).not.toContain("bu haberde var");
  });

  it("after the click: the legend is present exactly once, as a 10px muted line", () => {
    const html = expandedHtml(props);
    expect(html).toContain(LEGEND_P);
    expect(html.split(LEGEND_COPY)).toHaveLength(2);
  });

  it("after the click: the legend sits under the zone cards and above the toggle", () => {
    const html = expandedHtml(props);
    const legendAt = html.indexOf(LEGEND_P);
    expect(legendAt).toBeGreaterThan(html.indexOf("Beta Haber"));
    expect(legendAt).toBeLessThan(html.indexOf("<button"));
    // The zone cards (the grid) are closed before the legend line starts.
    expect(html.slice(legendAt - "</div>".length, legendAt)).toBe("</div>");
  });

  it("after the click: the zone header reads '1/2 kaynak' (covering/total)", () => {
    expect(zoneCounts(expandedHtml(props))).toEqual(["0/0 kaynak", "1/2 kaynak", "0/0 kaynak"]);
  });

  it("after the click: the toggle has aria-expanded=true and offers the way back", () => {
    const html = expandedHtml(props);
    expect(toggleTag(html)).toContain('aria-expanded="true"');
    expect(html).toContain("Sadece bu haberdekileri göster");
    expect(html).not.toContain("Tüm 2 kaynağı göster");
  });

  it("after the click: the glyph is aria-hidden, in the zone chip text colour, before the name, with no opacity utility", () => {
    const html = expandedHtml(props);
    const chip = chipOf(html, "Alfa Gazete");
    const glyph = chip.match(/<span([^>]*)>✓<\/span>/);
    expect(glyph, "glyph element").toBeTruthy();
    expect(glyph![1]).toContain('aria-hidden="true"');
    const cls = glyph![1]!.match(/class="([^"]*)"/)?.[1] ?? "";
    expect(cls).toBe(ZONE_META.bagimsiz.chipText);
    // The name text node (not the title attribute) is followed by the sr-only span.
    const nameAt = chip.indexOf("Alfa Gazete<span");
    expect(nameAt).toBeGreaterThan(-1);
    expect(chip.indexOf("✓")).toBeLessThan(nameAt);
    expect(html).not.toMatch(/opacity-\d/);
    expect(html).not.toMatch(/opacity-\[/);
  });

  it("after the click: the cue is the glyph and the tint stays as it was (covering tinted, others transparent)", () => {
    const html = expandedHtml(props);
    const cls = (name: string) => chipOf(html, name).match(/^<span title="[^"]*" class="([^"]*)"/)![1]!;
    expect(cls("Alfa Gazete")).toContain(ZONE_META.bagimsiz.chipBg);
    expect(cls("Beta Haber")).toContain("bg-transparent");
    expect(cls("Beta Haber")).not.toContain(ZONE_META.bagimsiz.chipBg);
  });

  it("after the click: the sr-only note keeps the bias label and adds the coverage note", () => {
    const html = expandedHtml(props);
    expect(chipOf(html, "Alfa Gazete")).toMatch(/class="sr-only"> — Merkez — bu haberde var<\/span>/);
    expect(chipOf(html, "Beta Haber")).toMatch(/class="sr-only"> — Merkez — bu haberde yok<\/span>/);
  });

  it("a second click collapses back to exactly the first markup", () => {
    const m = mount(props);
    const first = m.html();
    m.click();
    expect(m.html()).not.toBe(first);
    m.click();
    expect(m.html()).toBe(first);
  });

  it("counts covering/total per zone across all three zones", () => {
    const html = expandedHtml({
      sources: [
        source({ id: "o", slug: "o", name: "Muh Bir", bias: "opposition", kind: "outlet" }),
        a,
        b,
        source({ id: "g", slug: "g", name: "Ikt Bir", bias: "pro_government", kind: "outlet" }),
      ],
      highlightSlugs: new Set(["a", "g"]),
    });
    // muhalefet 0 of 1, bagimsiz 1 of 2, iktidar 1 of 1.
    expect(zoneCounts(html)).toEqual(["0/1 kaynak", "1/2 kaynak", "1/1 kaynak"]);
    expect(chipOf(html, "Muh Bir")).toContain("bu haberde yok");
    expect(chipOf(html, "Ikt Bir")).toContain("bu haberde var");
  });

  it("marks a covering non-voting chip too, keeping its dashed border and kind label", () => {
    const agg = source({ id: "x", slug: "x", name: "Toplayici Bir", bias: "center", kind: "aggregator" });
    const html = expandedHtml({ sources: [a, agg], highlightSlugs: new Set(["x"]) });
    const chip = chipOf(html, "Toplayici Bir");
    expect(chip).toContain("border-dashed");
    expect(chip).toContain("✓");
    expect(chip).toContain("bu haberde var");
    expect(chip).toContain("yanlılık dağılımına sayılmaz");
    expect(chip).toContain(SOURCE_KIND_META.aggregator.label);
    expect(chipOf(html, "Alfa Gazete")).toContain("bu haberde yok");
  });

  it("ignores highlighted slugs that are not in the directory", () => {
    const html = expandedHtml({ sources: [a, b], highlightSlugs: new Set(["a", "ghost"]) });
    expect(zoneCounts(html)).toEqual(["0/0 kaynak", "1/2 kaynak", "0/0 kaynak"]);
    expect(html.match(GLYPH)).toHaveLength(1);
  });

  it("118 chips: exactly one glyph and one 'bu haberde var' per covering source", () => {
    const biases = ["opposition", "center", "pro_government"] as const;
    const many: MediaDnaSource[] = Array.from({ length: 118 }, (_, i) => ({
      name: `Kaynak ${i}`,
      slug: `k-${i}`,
      bias: biases[i % 3]!,
      kind: "outlet",
    }));
    const covering = new Set(many.slice(0, 11).map((s) => s.slug));
    const html = expandedHtml({ sources: many, highlightSlugs: covering });
    expect(html.match(/<span title="Kaynak /g)).toHaveLength(118);
    expect(html.match(GLYPH)).toHaveLength(11);
    expect(html.split("bu haberde var")).toHaveLength(11 + 1);
    expect(html.split("bu haberde yok")).toHaveLength(107 + 1);
    expect(html).toContain("Sadece bu haberdekileri göster");
    // Zone headers add up: 11 covering of 118 in total.
    const sums = zoneCounts(html).map((c) => c.split(" ")[0]!.split("/").map(Number));
    expect(sums.reduce((n, [cov]) => n + cov!, 0)).toBe(11);
    expect(sums.reduce((n, [, tot]) => n + tot!, 0)).toBe(118);
  });

  it("with no highlightSlugs none of the markers render (no toggle either)", () => {
    for (const noFilter of [undefined, new Set<string>()]) {
      const html = mount({ sources: [a, b], highlightSlugs: noFilter }).html();
      expect(html).not.toContain("bu haberde");
      expect(html).not.toContain("✓");
      expect(html).not.toContain(LEGEND_COPY);
      expect(html).not.toContain("aria-expanded");
      expect(html).not.toContain("<button");
      expect(zoneCounts(html)).toEqual(["0 kaynak", "2 kaynak", "0 kaynak"]);
    }
  });

  it("the directory-read-failure state renders none of it either", () => {
    const html = mount({ sources: [], highlightSlugs: new Set(["a"]) }).html();
    expect(html).not.toContain("bu haberde");
    expect(html).not.toContain("✓");
    expect(html).not.toContain("aria-expanded");
  });
});

// Markup captured from the component as it stood BEFORE h126-a11y-1 (4 sources: one per
// zone plus a non-voting aggregator in the middle zone), so the collapsed and no-filter
// views can be proven unchanged byte for byte. Pieces are just a readability split.
const TODAY_HEADER =
  `<div class="space-y-3"><div><h2 class="text-sm font-semibold">Medya DNA&#x27;sı</h2><p class="text-[11px] text-muted-foreground mt-0.5">Kaynakların hükümete göre temel duruşu. Haberden habere değişmez.</p></div>`;
const TODAY_BAR =
  `<div class="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"><div class="bg-emerald-500" style="width:25%"></div><div class="bg-zinc-400" style="width:50%"></div><div class="bg-red-500" style="width:25%"></div></div>`;
const TODAY_GRID_OPEN =
  `<div class="grid grid-cols-1 md:grid-cols-3 gap-3">`;
const TODAY_MUHALEFET =
  `<div class="rounded-lg border bg-emerald-500/10 border-emerald-500/30 p-3 space-y-2"><div class="flex items-center justify-between"><div class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true"></span><span class="text-[10px] font-semibold uppercase tracking-wider text-emerald-800 dark:text-emerald-400">Muhalefet</span></div><span class="text-[10px] text-emerald-800 dark:text-emerald-400">1 kaynak</span></div><div class="flex flex-wrap gap-1"><span title="Opp Outlet — Muhalefet" class="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border-emerald-500/20"><span class="h-1 w-1 rounded-full bg-emerald-500" aria-hidden="true"></span>Opp Outlet<span class="sr-only"> — Muhalefet</span></span></div></div>`;
const TODAY_BAGIMSIZ_COLLAPSED =
  `<div class="rounded-lg border bg-zinc-500/20 border-zinc-400/40 p-3 space-y-2"><div class="flex items-center justify-between"><div class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-zinc-400" aria-hidden="true"></span><span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-800 dark:text-zinc-400">Bağımsız</span></div><span class="text-[10px] text-zinc-800 dark:text-zinc-400">1 kaynak</span></div><div class="flex flex-wrap gap-1"><span title="Agg Outlet — Merkez · Toplayıcı · yanlılık dağılımına sayılmaz" class="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors bg-zinc-500/15 text-zinc-800 dark:text-zinc-400 border-zinc-500/30 border-dashed"><span class="h-1 w-1 rounded-full bg-zinc-400" aria-hidden="true"></span>Agg Outlet<span class="sr-only"> — Merkez · Toplayıcı · yanlılık dağılımına sayılmaz</span><span class="ml-0.5 text-[10px] uppercase tracking-wider">Toplayıcı</span></span></div></div>`;
const TODAY_BAGIMSIZ_ALL =
  `<div class="rounded-lg border bg-zinc-500/20 border-zinc-400/40 p-3 space-y-2"><div class="flex items-center justify-between"><div class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-zinc-400" aria-hidden="true"></span><span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-800 dark:text-zinc-400">Bağımsız</span></div><span class="text-[10px] text-zinc-800 dark:text-zinc-400">2 kaynak</span></div><div class="flex flex-wrap gap-1"><span title="Mid Outlet — Merkez" class="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors bg-zinc-500/15 text-zinc-800 dark:text-zinc-400 border-zinc-500/30"><span class="h-1 w-1 rounded-full bg-zinc-400" aria-hidden="true"></span>Mid Outlet<span class="sr-only"> — Merkez</span></span><span title="Agg Outlet — Merkez · Toplayıcı · yanlılık dağılımına sayılmaz" class="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors bg-zinc-500/15 text-zinc-800 dark:text-zinc-400 border-zinc-500/30 border-dashed"><span class="h-1 w-1 rounded-full bg-zinc-400" aria-hidden="true"></span>Agg Outlet<span class="sr-only"> — Merkez · Toplayıcı · yanlılık dağılımına sayılmaz</span><span class="ml-0.5 text-[10px] uppercase tracking-wider">Toplayıcı</span></span></div></div>`;
const TODAY_IKTIDAR_AND_GRID_CLOSE =
  `<div class="rounded-lg border bg-red-500/10 border-red-500/30 p-3 space-y-2"><div class="flex items-center justify-between"><div class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-red-500" aria-hidden="true"></span><span class="text-[10px] font-semibold uppercase tracking-wider text-red-800 dark:text-red-400">İktidar</span></div><span class="text-[10px] text-red-800 dark:text-red-400">1 kaynak</span></div><div class="flex flex-wrap gap-1"><span title="Gov Outlet — Hükümete Yakın" class="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors bg-red-500/15 text-red-800 dark:text-red-400 border-red-500/20"><span class="h-1 w-1 rounded-full bg-red-500" aria-hidden="true"></span>Gov Outlet<span class="sr-only"> — Hükümete Yakın</span></span></div></div></div>`;
const TODAY_NON_VOTING_LEGEND =
  `<p class="text-[10px] text-muted-foreground">Kesikli çerçeveyle gösterilen toplayıcı / niş kaynaklar kümelerde listelenir ama yanlılık dağılımına sayılmaz.</p>`;
const TODAY_TOGGLE =
  `<div class="flex justify-center mt-2"><button type="button" class="inline-flex min-h-6 items-center max-sm:min-h-11 text-[11px] text-muted-foreground hover:text-foreground transition-colors">Tüm 4 kaynağı göster</button></div>`;

const TODAY_COLLAPSED =
  TODAY_HEADER + TODAY_BAR + TODAY_GRID_OPEN + TODAY_MUHALEFET + TODAY_BAGIMSIZ_COLLAPSED +
  TODAY_IKTIDAR_AND_GRID_CLOSE + TODAY_NON_VOTING_LEGEND + TODAY_TOGGLE + "</div>";
const TODAY_NO_FILTER =
  TODAY_HEADER + TODAY_BAR + TODAY_GRID_OPEN + TODAY_MUHALEFET + TODAY_BAGIMSIZ_ALL +
  TODAY_IKTIDAR_AND_GRID_CLOSE + TODAY_NON_VOTING_LEGEND + "</div>";

describe("MediaDna collapsed and no-filter views render exactly as before (h126-a11y-1)", () => {
  const rows: MediaDnaSource[] = [
    { name: "Gov Outlet", slug: "gov", bias: "pro_government", kind: "outlet" },
    { name: "Mid Outlet", slug: "mid", bias: "center", kind: "outlet" },
    { name: "Agg Outlet", slug: "agg", bias: "center", kind: "aggregator" },
    { name: "Opp Outlet", slug: "opp", bias: "opposition", kind: "outlet" },
  ];

  it("collapsed: byte-identical to the old markup except aria-expanded=\"false\" on the toggle", () => {
    const html = renderToStaticMarkup(
      <MediaDna sources={rows} highlightSlugs={new Set(["gov", "agg", "opp"])} />,
    );
    // Exactly one new attribute, on the toggle, and nothing else moved.
    expect(html.split(' aria-expanded="false"')).toHaveLength(2);
    expect(toggleTag(html)).toContain(' aria-expanded="false"');
    expect(html.replace(' aria-expanded="false"', "")).toBe(TODAY_COLLAPSED);
  });

  it("no filter (highlightSlugs missing): byte-identical to the old markup", () => {
    expect(renderToStaticMarkup(<MediaDna sources={rows} />)).toBe(TODAY_NO_FILTER);
  });

  it("no filter (empty highlightSlugs): the old markup too, including its untinted chips", () => {
    // Pre-existing quirk kept on purpose (out of scope here): with an EMPTY Set, unlike
    // undefined, every chip falls back to bg-transparent although the view is show-all.
    const tinted = [
      ZONE_META.muhalefet.chipBg,
      ZONE_META.bagimsiz.chipBg,
      ZONE_META.iktidar.chipBg,
    ];
    const expected = tinted.reduce((s, chipBg) => s.replaceAll(` ${chipBg} `, " bg-transparent "), TODAY_NO_FILTER);
    expect(expected).not.toBe(TODAY_NO_FILTER);
    expect(renderToStaticMarkup(<MediaDna sources={rows} highlightSlugs={new Set()} />)).toBe(expected);
  });
});
