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
import { NavLinks } from "./nav-links";

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
