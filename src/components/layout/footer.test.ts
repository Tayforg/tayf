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
// ahead of the "Düzeltme ve iletişim" entry that closes the list.
describe("footer.tsx Sistem durumu link", () => {
  const src = readFileSync(join(__dirname, "footer.tsx"), "utf8");

  it("links /durum with the label Sistem durumu", () => {
    expect(src).toContain('href: "/durum"');
    expect(src).toContain('{ href: "/durum", label: "Sistem durumu" }');
  });

  it("sits in NAV_LINKS before Düzeltme ve iletişim, and only once", () => {
    const nav = src.slice(src.indexOf("const NAV_LINKS"), src.indexOf("] as const"));
    expect(nav.indexOf('href: "/durum"')).toBeGreaterThan(-1);
    expect(nav.indexOf('href: "/durum"')).toBeLessThan(nav.indexOf('label: "Düzeltme ve iletişim"'));
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

// h138-roadmap2-2: /takip (the follow feature's "yeni since last visit" return
// loop) and /diyetim had no inbound link from the header, the footer or the
// home; /takip was reachable only through small print on /saved. The header
// gets no fifth item (h73-breakpoints-2 fixed its 640-767 px wrapping), so the
// footer, the only site-wide nav with room, lists both right after /gundem.
describe("footer.tsx Takip ettiklerim and Haber diyetim links (h138-roadmap2-2)", () => {
  const src = readFileSync(join(__dirname, "footer.tsx"), "utf8");
  const nav = src.slice(src.indexOf("const NAV_LINKS"), src.indexOf("] as const"));
  const entries = [...nav.matchAll(/\{ href: "([^"]+)", label: "([^"]+)" \}/g)].map((m) => ({
    href: m[1],
    label: m[2],
  }));
  const GUNDEM = '{ href: "/gundem", label: "Gündem" },';
  const TAKIP = '{ href: "/takip", label: "Takip ettiklerim" },';
  const DIYETIM = '{ href: "/diyetim", label: "Haber diyetim" },';

  it("lists /takip as Takip ettiklerim and /diyetim as Haber diyetim, once each", () => {
    expect(entries).toContainEqual({ href: "/takip", label: "Takip ettiklerim" });
    expect(entries).toContainEqual({ href: "/diyetim", label: "Haber diyetim" });
    expect(entries.filter((e) => e.href === "/takip")).toHaveLength(1);
    expect(entries.filter((e) => e.href === "/diyetim")).toHaveLength(1);
  });

  it("keeps every footer href unique", () => {
    expect(entries.length).toBeGreaterThan(0);
    const hrefs = entries.map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("places the two entries directly after Gündem, Takip ettiklerim first", () => {
    expect(nav).toContain(`${GUNDEM}\n  ${TAKIP}\n  ${DIYETIM}`);
    const i = entries.findIndex((e) => e.href === "/gundem");
    expect(entries[i + 1]).toEqual({ href: "/takip", label: "Takip ettiklerim" });
    expect(entries[i + 2]).toEqual({ href: "/diyetim", label: "Haber diyetim" });
  });
});

// h138-roadmap2-2: /saved used to fold both links into one sentence, "Hangi
// taraftan ne kadar okuduğunuzu görmek için: Haber diyetim · Takip ettiklerim",
// which framed following as a reading diet. Source guard, not a render test
// (CLAUDE.md: no render tests of server components): one <p> per link.
describe("saved/page.tsx link lines (h138-roadmap2-2)", () => {
  const src = readFileSync(join(__dirname, "../../app/saved/page.tsx"), "utf8");
  const paragraphs = [...src.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  const linkOf = (p: string) => /<Link\b[^>]*href="([^"]+)"/.exec(p)?.[1];

  it("no longer joins the two links with a middle dot in one sentence", () => {
    expect(src).not.toContain('{" · "}');
  });

  it("gives /diyetim its own <p> with the reading-diet sentence", () => {
    const p = paragraphs.filter((x) => linkOf(x) === "/diyetim");
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("Hangi taraftan ne kadar okuduğunuzu görmek için:");
    expect(p[0]).not.toContain("/takip");
  });

  it("gives /takip its own <p> with the follow sentence", () => {
    const p = paragraphs.filter((x) => linkOf(x) === "/takip");
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("Takip ettiğiniz konu, kişi ve kelimelerdeki yeni haberler:");
    expect(p[0]).not.toContain("/diyetim");
    expect(p[0]).not.toContain("okuduğunuz");
  });

  it("keeps the link classes on both links", () => {
    const classes = [...src.matchAll(/<Link\b[^>]*className="([^"]*)"/g)].map((m) => m[1]);
    expect(classes).toHaveLength(2);
    for (const c of classes) {
      expect(c).toBe("underline decoration-dotted underline-offset-2 hover:text-foreground");
    }
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
