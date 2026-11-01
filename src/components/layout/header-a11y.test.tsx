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
      ["/blindspots", "Kör Noktalar"],
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
  const MOBILE_TOKENS = ["max-sm:min-h-11", "max-sm:min-w-11", "max-sm:justify-center"];
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
