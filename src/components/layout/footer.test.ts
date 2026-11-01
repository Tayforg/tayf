import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source guard: footer.tsx claimed "Çerez kullanmıyoruz" (no cookies) while
// /api/oyun/cerceve/next sets a 30-day session cookie. The copy must own
// that cookie truthfully instead of denying it.
describe("footer.tsx cookie copy", () => {
  const src = readFileSync(join(__dirname, "footer.tsx"), "utf8");

  it("no longer claims no cookies are used", () => {
    expect(src).not.toContain("Çerez kullanmıyoruz");
  });

  it("truthfully names the Çerçeve session cookie's 30-day retention and Vercel Web Analytics", () => {
    expect(src).toContain("30 gün");
    expect(src).toContain("Çerçeve");
    expect(src).toContain("Vercel Web Analytics");
  });
});

// a11y-1: the footer copy used text-muted-foreground at 40/50/60% alpha, which
// measured 1.77-2.62:1 against the page background (WCAG AA needs 4.5:1 for
// small text). Full-strength muted-foreground clears it; the 10px/11px sizes
// stay so the footer keeps its quiet hierarchy.
describe("footer.tsx contrast + landmarks", () => {
  const src = readFileSync(join(__dirname, "footer.tsx"), "utf8");

  it("uses no alpha-reduced text-muted-foreground (low-contrast copy)", () => {
    expect(src).not.toContain("text-muted-foreground/");
  });

  it("labels the footer <nav> landmark so it is distinguishable from the header's", () => {
    expect(src).toContain('<nav aria-label="Alt menü"');
  });
});

// /durum ("Sistem durumu") is a public transparency page; the footer is the
// only site-wide nav that links to it, placed with the other trust links and
// ahead of the "İletişim" entry that closes the list.
describe("footer.tsx Sistem durumu link", () => {
  const src = readFileSync(join(__dirname, "footer.tsx"), "utf8");

  it("links /durum with the label Sistem durumu", () => {
    expect(src).toContain('href: "/durum"');
    expect(src).toContain('{ href: "/durum", label: "Sistem durumu" }');
  });

  it("sits in NAV_LINKS before İletişim, and only once", () => {
    const nav = src.slice(src.indexOf("const NAV_LINKS"), src.indexOf("] as const"));
    expect(nav.indexOf('href: "/durum"')).toBeGreaterThan(-1);
    expect(nav.indexOf('href: "/durum"')).toBeLessThan(nav.indexOf('label: "İletişim"'));
    expect(src.split('href: "/durum"')).toHaveLength(2);
  });
});

// /gundem hubs discoverability: the 62 /gundem/<key> hubs were only reachable
// through /trends links. The footer is the only site-wide nav, so the /gundem
// index sits there, right after the /konu topic index it parallels.
describe("footer.tsx Gündem link", () => {
  const src = readFileSync(join(__dirname, "footer.tsx"), "utf8");
  const nav = src.slice(src.indexOf("const NAV_LINKS"), src.indexOf("] as const"));
  const KONU = '{ href: "/konu", label: "Konular" },';
  const GUNDEM = '{ href: "/gundem", label: "Gündem" },';

  it("lists /gundem with the label Gündem exactly once", () => {
    expect(nav.split(GUNDEM)).toHaveLength(2);
    expect(src.split('href: "/gundem"')).toHaveLength(2);
  });

  it("sits immediately after the Konular entry", () => {
    expect(nav).toContain(`${KONU}\n  ${GUNDEM}`);
  });
});

// h16-mobile-2: every footer link was ~13 px tall on a phone (text-[11px] with
// no padding). Below sm each link is lifted to a 44 px row; sm and up keeps the
// exact current classes, so the desktop footer does not move.
describe("footer.tsx mobile tap targets (h16-mobile-2)", () => {
  const src = readFileSync(join(__dirname, "footer.tsx"), "utf8");
  const MOBILE = ["max-sm:inline-flex", "max-sm:min-h-11", "max-sm:items-center"];

  const classOf = (tag: string | undefined) =>
    (/\bclassName="([^"]*)"/.exec(tag ?? "")?.[1] ?? "").split(/\s+/).filter(Boolean);
  const navLinkTag = /<Link\b[^>]*>/.exec(src)?.[0];
  const rssTag = /<a\b[^>]*href="\/rss\.xml"[^>]*>/.exec(src)?.[0];

  it("finds the NAV_LINKS <Link> and the RSS <a>", () => {
    expect(navLinkTag).toBeDefined();
    expect(rssTag).toBeDefined();
  });

  it("gives every NAV_LINKS <Link> the three max-sm tap-target tokens", () => {
    const tokens = classOf(navLinkTag);
    for (const token of MOBILE) expect(tokens).toContain(token);
  });

  it("gives the RSS <a> the three max-sm tap-target tokens", () => {
    const tokens = classOf(rssTag);
    for (const token of MOBILE) expect(tokens).toContain(token);
  });

  it("keeps the current desktop classes of both links unchanged", () => {
    expect(classOf(navLinkTag).filter((t) => !t.startsWith("max-sm:"))).toEqual([
      "text-[11px]",
      "text-muted-foreground",
      "hover:text-foreground",
      "transition-colors",
    ]);
    expect(classOf(rssTag).filter((t) => !t.startsWith("max-sm:"))).toEqual([
      "text-[11px]",
      "text-muted-foreground",
      "hover:text-brand",
      "transition-colors",
    ]);
  });

  it("drops the nav's row gap on mobile (the 44 px rows already separate) and keeps it from sm up", () => {
    const navLine = src.split("\n").find((line) => line.includes('<nav aria-label="Alt menü"'));
    expect(navLine).toBeDefined();
    const tokens = classOf(navLine);
    for (const token of ["flex", "flex-wrap", "gap-x-5", "gap-y-2", "max-sm:gap-y-0"]) {
      expect(tokens).toContain(token);
    }
  });
});
