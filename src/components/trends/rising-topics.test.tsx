import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import type { RisingItem, RisingResult } from "@/lib/trends/rising";

import { RisingTopics } from "./rising-topics";

// ---------------------------------------------------------------------------
// "Yükselen Konular" card on /trends. Pure presentation over the
// RisingResult | null the cached reader returns: ok with items, ok without
// items, insufficient history, and null (fetch failed).
// ---------------------------------------------------------------------------

function item(over: Partial<RisingItem> = {}): RisingItem {
  return {
    key: "erdogan",
    label: "Erdoğan",
    href: "/?q=Erdo%C4%9Fan",
    count: 15,
    baseline: 3,
    ratio: 5,
    ratioLabel: "5,0",
    ratioIsLowerBound: false,
    isNew: false,
    ...over,
  };
}

function ok(items: RisingItem[], day = "2026-10-23"): RisingResult {
  return { status: "ok", day, items };
}

const render = (data: RisingResult | null) =>
  renderToStaticMarkup(<RisingTopics data={data} />);

describe("<RisingTopics>", () => {
  it("renders the labelled section, heading and caption in every state", () => {
    for (const data of [ok([item()]), ok([]), { status: "insufficient" } as const, null]) {
      const html = render(data);
      expect(html).toContain('<section aria-labelledby="yukselen-konular"');
      expect(html).toContain('<h2 id="yukselen-konular"');
      expect(html).toContain("Yükselen Konular");
      expect(html).toContain(
        "Başlıklarda son 7 günün ortalamasından belirgin biçimde fazla geçen kişi, kurum ve ülkeler · yalnızca spektruma sayılan kaynaklar · saatte bir güncellenir",
      );
    }
  });

  it("lists each rising entity as a link to the home search", () => {
    const html = render(
      ok([item(), item({ key: "chp", label: "CHP", href: "/?q=CHP", count: 30, ratioLabel: "2,5" })]),
    );
    expect(html).toContain("<ol");
    expect(html).toContain('href="/?q=Erdo%C4%9Fan"');
    expect(html).toContain(">Erdoğan</a>");
    expect(html).toContain('href="/?q=CHP"');
    expect((html.match(/<li/g) ?? []).length).toBe(2);
  });

  it("shows the ranked date, count and the ratio against the 7-day mean", () => {
    const html = render(ok([item()]));
    expect(html).toContain("23 Ekim: 15 haber · 7 günlük ortalamanın 5,0 katı");
  });

  // h63-timezones-1: the result sits in a cache entry served past Istanbul
  // midnight, so a baked-in "Bugün"/"Dün" goes stale; the date of the ranked
  // day never does.
  it("names the ranked day by its date and never says 'Bugün' or 'Dün'", () => {
    const html = render(ok([item({ count: 63, ratioLabel: "3,2" })], "2026-11-07"));
    expect(html).toContain("7 Kasım: 63 haber · 7 günlük ortalamanın 3,2 katı");
    expect(html).not.toContain("Bugün");
    expect(html).not.toContain("Dün");
  });

  it("prints the date of whichever day the result ranked (yesterday's fallback too)", () => {
    const today = render(ok([item()], "2026-11-08"));
    const yesterday = render(ok([item()], "2026-11-07"));
    expect(today).toContain("8 Kasım: 15 haber");
    expect(yesterday).toContain("7 Kasım: 15 haber");
  });

  it("says 'en az' when the ratio is only a lower bound (baseline below the floor)", () => {
    // Mean 1,4/day, 13 today: the true multiple is 9,1 but the ranking floor
    // shows 6,5, so the copy must not state it as the exact multiple.
    const html = render(
      ok([item({ count: 13, baseline: 1.4, ratio: 6.5, ratioLabel: "6,5", ratioIsLowerBound: true })]),
    );
    expect(html).toContain("23 Ekim: 13 haber · 7 günlük ortalamanın en az 6,5 katı");
  });

  it("does not say 'en az' for an exact ratio", () => {
    const html = render(ok([item()]));
    expect(html).not.toContain("en az");
  });

  it("describes a brand-new topic instead of quoting a ratio", () => {
    const html = render(
      ok([item({ isNew: true, baseline: 0, count: 14, ratioLabel: "7,0", ratioIsLowerBound: true })]),
    );
    expect(html).toContain("23 Ekim: 14 haber · geçen hafta neredeyse hiç yoktu");
    expect(html).not.toContain("katı");
    expect(html).not.toContain("en az");
  });

  it("an isNew row reads '7 Kasım: 12 haber · geçen hafta neredeyse hiç yoktu'", () => {
    const html = render(
      ok([item({ isNew: true, baseline: 0, count: 12, ratioLabel: "6,0", ratioIsLowerBound: true })], "2026-11-07"),
    );
    expect(html).toContain("7 Kasım: 12 haber · geçen hafta neredeyse hiç yoktu");
    expect(html).not.toContain("Bugün");
    expect(html).not.toContain("Dün");
  });

  it("formats big counts with the Turkish thousands separator", () => {
    const html = render(ok([item({ count: 1234 })]));
    expect(html).toContain("23 Ekim: 1.234 haber");
  });

  it("ok with no items: honest 'no spike' copy naming the counted day, and no list", () => {
    const html = render(ok([], "2026-11-08"));
    expect(html).toContain("8 Kasım sayımında belirgin bir yükseliş yok.");
    expect(html).not.toContain("Bugün");
    expect(html).not.toContain("Dün");
    expect(html).not.toContain("<ol");
  });

  it("insufficient history copy", () => {
    const html = render({ status: "insufficient" });
    expect(html).toContain("Yükselen konular için yeterli geçmiş veri henüz yok.");
    expect(html).not.toContain("<ol");
  });

  it("null (fetch failed) copy", () => {
    const html = render(null);
    expect(html).toContain("Yükselen konular şu anda hesaplanamıyor.");
    expect(html).not.toContain("<ol");
  });

  it("uses no element opacity and no alpha text tokens (WCAG 1.4.3 guards)", () => {
    const html = render(ok([item(), item({ key: "chp", label: "CHP", isNew: true })]));
    expect(html).not.toMatch(/(?<![\w:/-])opacity-/);
    expect(html).not.toMatch(/\btext-(?:muted-foreground|brand)\/\d+/);
    expect(html).toContain("text-muted-foreground");
  });

  it("escapes label text (labels come from a vocabulary, but stay safe)", () => {
    const html = render(ok([item({ label: "<b>x</b>", href: "/?q=%3Cb%3Ex%3C%2Fb%3E" })]));
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

// h43-entities-3: a row whose hub is thin links to the home search (/?q=...).
// That route is request-time and DB-backed, so next/link must not prefetch it
// for every row in view (the hub footer uses a plain anchor for the same
// reason); a /gundem hub is a prerendered page and keeps the default prefetch.
describe("<RisingTopics> link prefetch", () => {
  type El = { type?: unknown; props?: { href?: unknown; prefetch?: unknown; children?: unknown } };

  function links(data: RisingResult): El[] {
    const out: El[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        const el = node as El;
        if (typeof el.props?.href === "string") out.push(el);
        if (el.props?.children !== undefined) walk(el.props.children);
      }
    };
    walk(RisingTopics({ data }));
    return out;
  }

  it("does not prefetch a home-search link", () => {
    const [link] = links(ok([item({ href: "/?q=Merkez%20Bankas%C4%B1" })]));
    expect(link?.props?.prefetch).toBe(false);
  });

  it("keeps the default prefetch for a /gundem hub link", () => {
    const [link] = links(ok([item({ key: "msb", label: "MSB", href: "/gundem/msb" })]));
    expect(link?.props?.href).toBe("/gundem/msb");
    expect(link?.props?.prefetch).toBeUndefined();
  });
});

// h63-timezones-1: the card is rendered from a cache entry that can be served
// past Istanbul midnight, so it must not carry a relative-day word. A literal
// "Bugün" or "Dün" anywhere in the component would come back as the same bug.
describe("rising-topics.tsx: source guard", () => {
  const source = readFileSync(resolve(__dirname, "rising-topics.tsx"), "utf8");
  // Strip comments so prose explaining the rule does not trip the guard.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("has no literal 'Bugün' or 'Dün'", () => {
    expect(code).not.toMatch(/Bugün/);
    expect(code).not.toMatch(/Dün/);
  });

  it("labels the day through the shared dayLabelTr helper", () => {
    expect(code).toMatch(/import\s*\{\s*dayLabelTr\s*\}\s*from\s*["']@\/lib\/trends\/day-label["']/);
  });
});
