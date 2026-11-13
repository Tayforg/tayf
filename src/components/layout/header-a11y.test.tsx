import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/admin/session", () => ({
  hasAdminSession: vi.fn(async () => false),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/blindspots",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/track", () => ({ track: vi.fn() }));

import { Header } from "./header";
import { NavLinks, NavLinksView } from "./nav-links";

// ---------------------------------------------------------------------------
// Local tree walkers (house pattern — see ownership-line.test.tsx,
// cluster-page.test.tsx). These operate on the *element tree* returned by
// calling a component function directly, not on rendered DOM.
// ---------------------------------------------------------------------------

type Elementish = { props?: Record<string, unknown>; type?: unknown };

/** Collects every string/number leaf under a React element tree. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

/** Collects every `props.href` string found in the tree, in document order. */
function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (typeof el.props?.href === "string") out.push(el.props.href);
    if (el.props?.children !== undefined) collectHrefs(el.props.children, out);
  }
  return out;
}

/** Returns the first element in the tree whose `props.href` matches. */
function findByHref(node: unknown, href: string): Elementish | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByHref(child, href);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.props?.href === href) return el;
    if (el.props?.children !== undefined) {
      return findByHref(el.props.children, href);
    }
  }
  return undefined;
}

/** Collects every element whose `className` (stringified) includes `needle`. */
function collectByClassSubstring(
  node: unknown,
  needle: string,
  out: Elementish[] = [],
): Elementish[] {
  if (Array.isArray(node)) {
    for (const child of node) collectByClassSubstring(child, needle, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (
      typeof el.props?.className === "string" &&
      el.props.className.includes(needle)
    ) {
      out.push(el);
    }
    if (el.props?.children !== undefined) {
      collectByClassSubstring(el.props.children, needle, out);
    }
  }
  return out;
}

describe("Header — skip link", () => {
  it("renders 'İçeriğe atla' as the first focusable element, targeting #main", async () => {
    const tree = await Header();

    const hrefs = collectHrefs(tree);
    expect(hrefs[0]).toBe("#main");

    const skip = findByHref(tree, "#main");
    expect(skip).toBeDefined();
    expect(collectText(skip?.props?.children).join("")).toBe("İçeriğe atla");

    const cls = String(skip!.props!.className);
    expect(cls).toContain("sr-only");
    expect(cls).toContain("focus:not-sr-only");
  });
});

describe("NavLinks — accessible names", () => {
  it("labels the <nav> landmark 'Ana menü' (the footer's is 'Alt menü')", () => {
    const tree = NavLinks({}) as { type: unknown; props: Record<string, unknown> };
    expect(tree.type).toBe("nav");
    expect(tree.props["aria-label"]).toBe("Ana menü");
  });

  it("keeps the label on the header's static-shell fallback (pathname: null)", () => {
    const tree = NavLinksView({ pathname: null }) as {
      type: unknown;
      props: Record<string, unknown>;
    };
    expect(tree.type).toBe("nav");
    expect(tree.props["aria-label"]).toBe("Ana menü");
  });

  it("gives every nav link a name that survives the mobile icon-only layout", () => {
    const tree = NavLinks({ showAdmin: true });

    const cases: Array<[string, string]> = [
      ["/", "Haberler"],
      ["/blindspots", "Kör noktalar"],
      ["/saved", "Kaydedilenler"],
    ];

    for (const [href, label] of cases) {
      const link = findByHref(tree, href);
      expect(link).toBeDefined();

      const srOnlySpans = collectByClassSubstring(link, "sr-only");
      expect(srOnlySpans.length).toBeGreaterThan(0);

      const text = srOnlySpans
        .map((span) => collectText(span.props?.children).join(""))
        .join("");
      expect(text).toContain(label);

      for (const span of srOnlySpans) {
        expect(String(span.props?.className)).toContain("sm:hidden");
      }
    }

    const adminLink = findByHref(tree, "/admin");
    expect(adminLink).toBeDefined();
    const adminSrOnlySpans = collectByClassSubstring(adminLink, "sr-only");
    const adminText = adminSrOnlySpans
      .map((span) => collectText(span.props?.children).join(""))
      .join("");
    expect(adminText).toBe("Admin");
  });

  it("writes the visible and the screen-reader label of /blindspots in sentence case, like the footer (h19-copy-2)", () => {
    const link = findByHref(NavLinks({ showAdmin: false }), "/blindspots");
    expect(link).toBeDefined();
    const visible = collectByClassSubstring(link, "hidden sm:inline");
    expect(visible).toHaveLength(1);
    expect(collectText(visible[0]?.props?.children).join("")).toBe("Kör noktalar");
    const screenReader = collectByClassSubstring(link, "sr-only");
    expect(screenReader).toHaveLength(1);
    expect(collectText(screenReader[0]?.props?.children).join("")).toBe("Kör noktalar");
  });

  it("gives every nav link a visible focus ring", () => {
    const tree = NavLinks({ showAdmin: true });

    for (const href of ["/", "/blindspots", "/saved", "/admin"]) {
      const link = findByHref(tree, href);
      expect(link).toBeDefined();
      expect(String(link?.props?.className)).toContain("focus-visible:ring-2");
    }
  });
});

describe("NavLinks — 44 px touch targets on phones (h14-polish-5)", () => {
  // Below `sm` the labels are sr-only, so each link is a 14 px icon inside
  // px-2.5 / py-1.5: 34 x 26 px. WCAG 2.5.8 only asks for 24 px, but the rest
  // of the site uses 44 px; `max-sm:` lifts the floor without touching the
  // sm+ look (the header row is h-14, so its height does not change).
  // The floor is 44 px, written in px (h172-mobilelayout-1): `min-w-11` is
  // 2.75rem, which grew to 57 px at a 130% root font and pushed the row past a
  // 360 px viewport. See src/components/layout/header-fit.test.ts.
  const MOBILE_TOKENS = ["max-sm:min-h-[44px]", "max-sm:min-w-[44px]", "max-sm:justify-center"];
  const tokensOf = (el: Elementish | undefined) =>
    String(el?.props?.className).split(/\s+/).filter(Boolean);

  it.each(["/", "/blindspots", "/ekonomi", "/saved", "/admin"])(
    "%s link carries the three max-sm tokens and no unprefixed min-h-11 / min-w-11",
    (href) => {
      const link = findByHref(NavLinks({ showAdmin: true }), href);
      expect(link, `${href} link`).toBeDefined();

      const tokens = tokensOf(link);
      for (const token of MOBILE_TOKENS) expect(tokens).toContain(token);
      // The sm+ size must not change: no unprefixed (or sm:-leaking) floor.
      expect(tokens).not.toContain("min-h-11");
      expect(tokens).not.toContain("min-w-11");
      expect(tokens).not.toContain("min-h-[44px]");
      expect(tokens).not.toContain("min-w-[44px]");
      expect(tokens).not.toContain("justify-center");
    },
  );

  it.each(["/", "/blindspots", "/ekonomi", "/saved", "/admin"])(
    "%s link keeps its horizontal padding and focus ring",
    (href) => {
      const link = findByHref(NavLinks({ showAdmin: true }), href);
      const tokens = tokensOf(link);

      expect(tokens.some((t) => t === "px-2.5" || t === "px-2")).toBe(true);
      expect(tokens).toContain("focus-visible:ring-2");
    },
  );

  it("the hook-free static-shell fallback (pathname: null) has the same targets", () => {
    const tree = NavLinksView({ pathname: null, showAdmin: true });
    for (const href of ["/", "/blindspots", "/ekonomi", "/saved", "/admin"]) {
      const tokens = tokensOf(findByHref(tree, href));
      for (const token of MOBILE_TOKENS) expect(tokens, href).toContain(token);
    }
  });
});

describe("NavLinks — current-page cue is not colour or tint alone (h41-a11y-1)", () => {
  // The old cue was bg-foreground/10 (1.21:1 against the header) plus 80% vs
  // 100% icon opacity, and below `sm` the labels are sr-only so font-weight
  // cannot show either. WCAG 1.4.1 / 1.4.11: the active link now carries a
  // full-foreground 2 px bottom border. Every link reserves the same border in
  // `border-transparent`, so nothing shifts when the page changes. In
  // forced-colors mode a transparent border is repainted in the system colour
  // (LinkText), which would make every idle bar identical to the current one;
  // so idle links are pinned to Canvas there (`forced-colors:border-[Canvas]`)
  // and only the current link keeps a visible bar.
  const tokensOf = (el: Elementish | undefined) =>
    String(el?.props?.className).split(/\s+/).filter(Boolean);
  const ALL = ["/", "/blindspots", "/ekonomi", "/saved", "/admin"] as const;

  it("marks only the Ekonomi link with a full-foreground bottom border on /ekonomi", () => {
    const tree = NavLinksView({ pathname: "/ekonomi", showAdmin: true });
    const active = tokensOf(findByHref(tree, "/ekonomi"));
    expect(active).toContain("border-b-2");
    expect(active).toContain("border-foreground");
    expect(active).not.toContain("border-transparent");
    // The old tint and weight stay as supplements.
    expect(active).toContain("bg-foreground/10");
    expect(active).toContain("font-medium");
  });

  it("gives every other link the same border width in transparent (no layout shift)", () => {
    const tree = NavLinksView({ pathname: "/ekonomi", showAdmin: true });
    for (const href of ALL.filter((h) => h !== "/ekonomi")) {
      const tokens = tokensOf(findByHref(tree, href));
      expect(tokens, href).toContain("border-b-2");
      expect(tokens, href).toContain("border-transparent");
      expect(tokens, href).not.toContain("border-foreground");
    }
  });

  it("treats the admin link the same way when /admin is current", () => {
    const tree = NavLinksView({ pathname: "/admin", showAdmin: true });
    const admin = tokensOf(findByHref(tree, "/admin"));
    expect(admin).toContain("border-b-2");
    expect(admin).toContain("border-foreground");
    expect(admin).not.toContain("border-transparent");
    for (const href of ALL.filter((h) => h !== "/admin")) {
      const tokens = tokensOf(findByHref(tree, href));
      expect(tokens, href).toContain("border-transparent");
      expect(tokens, href).not.toContain("border-foreground");
    }
  });

  it.each(ALL)("each link is one of exactly {active, idle} border states: %s", (current) => {
    const tree = NavLinksView({ pathname: current, showAdmin: true });
    for (const href of ALL) {
      const tokens = tokensOf(findByHref(tree, href));
      const isCurrent = href === current;
      expect(tokens.includes("border-foreground"), `${href} on ${current}`).toBe(isCurrent);
      expect(tokens.includes("border-transparent"), `${href} on ${current}`).toBe(!isCurrent);
      // Forced-colors repaints transparent borders in LinkText; idle links are
      // pinned to Canvas so only the current link keeps a visible bar.
      expect(tokens.includes("forced-colors:border-[Canvas]"), `${href} on ${current}`).toBe(
        !isCurrent,
      );
      expect(tokens, `${href} on ${current}`).toContain("border-b-2");
    }
  });

  it("keeps aria-current='page' on the current link and nowhere else", () => {
    const tree = NavLinksView({ pathname: "/ekonomi", showAdmin: true });
    for (const href of ALL) {
      const link = findByHref(tree, href);
      expect(link?.props?.["aria-current"], href).toBe(href === "/ekonomi" ? "page" : undefined);
    }
    const admin = NavLinksView({ pathname: "/admin", showAdmin: true });
    expect(findByHref(admin, "/admin")?.props?.["aria-current"]).toBe("page");
    expect(findByHref(admin, "/")?.props?.["aria-current"]).toBeUndefined();
  });

  it("the static-shell fallback (pathname: null) marks no link active but reserves the border", () => {
    const tree = NavLinksView({ pathname: null, showAdmin: true });
    for (const href of ALL) {
      const link = findByHref(tree, href);
      const tokens = tokensOf(link);
      expect(link?.props?.["aria-current"], href).toBeUndefined();
      expect(tokens, href).not.toContain("border-foreground");
      expect(tokens, href).toContain("border-b-2");
      expect(tokens, href).toContain("border-transparent");
    }
  });

  it("does not use a ring or shadow for the cue (those are dropped in forced-colors mode)", () => {
    const tree = NavLinksView({ pathname: "/blindspots", showAdmin: true });
    const tokens = tokensOf(findByHref(tree, "/blindspots"));
    // The only ring on a link is the focus ring; the current-page cue adds none.
    expect(tokens.filter((t) => t.includes("ring") && !t.startsWith("focus-visible:"))).toEqual([]);
    expect(tokens.filter((t) => t.startsWith("shadow"))).toEqual([]);
  });
});

describe("Header — decorative dividers are hidden from assistive tech (h67-landmarks-3)", () => {
  // The 0 px dividers between the Ana menü links (and the one inside the logo
  // link) draw nothing, but as separator-role elements a screen reader announced
  // "separator" between nav items and split the logo link's reading in browse
  // mode. They are kept (their margin sets the spacing) but are aria-hidden
  // decoration, with the same literal classes, so the layout does not move.
  // `max-[24rem]:hidden` since h172-mobilelayout-1: below 24rem (384 px at the
  // default font size) the margins plus the two flex gaps around each divider
  // added 12 px between the icon links, which pushed the row past 276-306 px
  // viewports. Not `max-sm:`: that moved the nav at 390 px at 100% zoom. The
  // spans stay in the DOM.
  const NAV_DIVIDER_CLASS = "h-3 mx-0.5 shrink-0 bg-border max-[24rem]:hidden";
  // `md:` since h73-breakpoints-2: the tagline beside it moved to md so the nav
  // fits on one line from 640 px (tests/guards/header-nowrap.test.ts).
  const LOGO_DIVIDER_CLASS = "h-3.5 mx-0 hidden md:block shrink-0 bg-border/40";

  /** Attribute strings of every empty <span> in the markup that carries `cls` as its class attribute. */
  const dividerAttrs = (markup: string, cls: string): string[] =>
    [...markup.matchAll(/<span\b([^>]*)><\/span>/g)]
      .map((m) => m[1]!)
      .filter((attrs) => attrs.includes(`class="${cls}"`));
  const linkCount = (markup: string): number => (markup.match(/<a\b/g) ?? []).length;

  it.each([
    ["/", false, 4],
    ["/", true, 5],
    [null, false, 4],
    [null, true, 5],
  ] as const)(
    "nav at pathname %s (showAdmin %s, %i links): one aria-hidden divider between each pair, no separator role",
    (pathname, showAdmin, links) => {
      const markup = renderToStaticMarkup(NavLinksView({ pathname, showAdmin }));

      expect(markup).not.toContain('role="separator"');
      expect(markup).not.toContain("aria-orientation");
      expect(linkCount(markup)).toBe(links);

      const dividers = dividerAttrs(markup, NAV_DIVIDER_CLASS);
      expect(dividers).toHaveLength(links - 1);
      for (const attrs of dividers) {
        expect(attrs).toContain('aria-hidden="true"');
        expect(attrs).not.toContain("role=");
      }
    },
  );

  it("the live nav (NavLinks) renders the same hidden dividers", () => {
    const markup = renderToStaticMarkup(NavLinks({ showAdmin: true }));

    expect(markup).not.toContain('role="separator"');
    expect(dividerAttrs(markup, NAV_DIVIDER_CLASS)).toHaveLength(4);
  });

  it("the header shell (logo, skip link, nav fallback) has no separator role anywhere", () => {
    const markup = renderToStaticMarkup(<Header />);

    expect(markup).not.toContain('role="separator"');
    expect(markup).not.toContain("aria-orientation");
    // Logo divider + the 3 dividers of the Suspense-fallback nav.
    expect(dividerAttrs(markup, LOGO_DIVIDER_CLASS)).toHaveLength(1);
    expect(dividerAttrs(markup, NAV_DIVIDER_CLASS)).toHaveLength(3);
  });

  it("hides the divider inside the logo link, keeping the md+ divider classes and the two text spans", () => {
    const logo = findByHref(Header(), "/");
    expect(logo).toBeDefined();

    const [divider, ...others] = collectByClassSubstring(logo!.props!.children, "bg-border/40");
    expect(others).toEqual([]);
    expect(divider?.type).toBe("span");
    expect(divider?.props?.["aria-hidden"]).toBe("true");
    expect(divider?.props?.role).toBeUndefined();
    expect(divider?.props?.["aria-orientation"]).toBeUndefined();
    expect(divider?.props?.className).toBe(LOGO_DIVIDER_CLASS);

    // The link's name is unchanged: the brand and the tagline.
    expect(collectText(logo!.props!.children).join("")).toBe("TayfHaber Analizi");
  });
});

describe("SearchBar — labelled search input (best effort)", () => {
  it("renders role=search and a label wired to the input via id/htmlFor", async () => {
    const { SearchBar } = await import("@/components/filters/search-bar");
    const markup = renderToStaticMarkup(<SearchBar />);

    expect(markup).toContain('role="search"');

    const idMatch = markup.match(/<input[^>]*\sid="([^"]+)"/);
    expect(idMatch).not.toBeNull();
    const inputId = idMatch![1];

    expect(markup).toContain("<label");
    expect(markup).toContain(`for="${inputId}"`);
  });
});
