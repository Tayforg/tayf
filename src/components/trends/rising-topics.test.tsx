import { describe, it, expect } from "vitest";
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

function ok(items: RisingItem[], dayLabel: "Bugün" | "Dün" = "Bugün"): RisingResult {
  return { status: "ok", dayLabel, day: "2026-10-23", items };
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

  it("shows the day label, count and the ratio against the 7-day mean", () => {
    const html = render(ok([item()]));
    expect(html).toContain("Bugün 15 haber · 7 günlük ortalamanın 5,0 katı");
  });

  it("uses 'Dün' when the result ranks yesterday", () => {
    const html = render(ok([item()], "Dün"));
    expect(html).toContain("Dün 15 haber · 7 günlük ortalamanın 5,0 katı");
  });

  it("says 'en az' when the ratio is only a lower bound (baseline below the floor)", () => {
    // Mean 1,4/day, 13 today: the true multiple is 9,1 but the ranking floor
    // shows 6,5, so the copy must not state it as the exact multiple.
    const html = render(
      ok([item({ count: 13, baseline: 1.4, ratio: 6.5, ratioLabel: "6,5", ratioIsLowerBound: true })]),
    );
    expect(html).toContain("Bugün 13 haber · 7 günlük ortalamanın en az 6,5 katı");
  });

  it("does not say 'en az' for an exact ratio", () => {
    const html = render(ok([item()]));
    expect(html).not.toContain("en az");
  });

  it("describes a brand-new topic instead of quoting a ratio", () => {
    const html = render(
      ok([item({ isNew: true, baseline: 0, count: 14, ratioLabel: "7,0", ratioIsLowerBound: true })]),
    );
    expect(html).toContain("Bugün 14 haber · geçen hafta neredeyse hiç yoktu");
    expect(html).not.toContain("katı");
    expect(html).not.toContain("en az");
  });

  it("formats big counts with the Turkish thousands separator", () => {
    const html = render(ok([item({ count: 1234 })]));
    expect(html).toContain("Bugün 1.234 haber");
  });

  it("ok with no items: honest 'no spike' copy and no list", () => {
    const html = render(ok([]));
    expect(html).toContain("Bugün belirgin bir yükseliş yok.");
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
