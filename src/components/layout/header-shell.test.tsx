import { describe, it, expect, vi, beforeEach } from "vitest";
import { Suspense, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// seo-error-states C: the header must be part of the static shell.
//
// Before: `Header` was async and awaited hasAdminSession() (cookies()), so the
// whole header — logo, nav, skip link — suspended behind the layout's bare
// <Suspense>. The late-arriving ~59px sticky header shifted everything below
// it (CLS). Now `Header` is synchronous; only the cookie read is isolated in
// <HeaderNav>, behind a <Suspense> whose fallback is the pathname-free
// <NavLinksView> (usePathname would itself suspend on fallback-param routes
// under cacheComponents, so the fallback must not call it).
// ---------------------------------------------------------------------------

const hasAdminSession = vi.fn(async () => false);
vi.mock("@/lib/admin/session", () => ({
  hasAdminSession: () => hasAdminSession(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/blindspots",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/track", () => ({ track: vi.fn() }));

import { Header, HeaderNav, HeaderFallback } from "./header";
import { NavLinks, NavLinksView } from "./nav-links";

type Elementish = { type?: unknown; props?: Record<string, unknown> };

/** Collects every element in the tree (props.children walked recursively). */
function collectElements(node: unknown, out: Elementish[] = []): Elementish[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) {
      collectElements(el.props.children, out);
    }
  }
  return out;
}

function findByHref(node: unknown, href: string): Elementish | undefined {
  return collectElements(node).find((el) => el.props?.href === href);
}

beforeEach(() => {
  hasAdminSession.mockReset();
  hasAdminSession.mockResolvedValue(false);
});

describe("Header — static shell", () => {
  it("is synchronous: Header() returns an element, not a Promise", () => {
    const result = Header();

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown }).then).toBe("undefined");
    expect(hasAdminSession).not.toHaveBeenCalled();
  });

  it("wraps the nav in a Suspense whose fallback is a pathname-free NavLinksView and whose child is HeaderNav", () => {
    const tree = Header();

    const suspenses = collectElements(tree).filter((el) => el.type === Suspense);
    const navSuspense = suspenses.find((el) => {
      const fallback = el.props?.fallback as Elementish | null | undefined;
      return fallback?.type === NavLinksView;
    });
    expect(navSuspense).toBeDefined();

    const fallback = navSuspense!.props!.fallback as Elementish;
    expect(fallback.props?.pathname).toBeNull();
    expect(fallback.props?.showAdmin).toBe(false);

    const child = navSuspense!.props!.children as Elementish;
    expect(child.type).toBe(HeaderNav);
  });

  it("does not render NavLinks (the usePathname client component) directly in the shell", () => {
    const tree = Header();

    expect(collectElements(tree).some((el) => el.type === NavLinks)).toBe(false);
  });

  it("keeps the skip link and logo in the synchronous shell", () => {
    const tree = Header();

    expect(findByHref(tree, "#main")).toBeDefined();
    expect(findByHref(tree, "/")).toBeDefined();
  });

  it("keeps the NewsletterStatusBanner behind its own Suspense with a null fallback", () => {
    const tree = Header();

    const bannerSuspense = collectElements(tree).find(
      (el) => el.type === Suspense && el.props?.fallback === null,
    );
    expect(bannerSuspense).toBeDefined();
  });
});

describe("HeaderNav — the only part that reads the session cookie", () => {
  it("renders NavLinks with showAdmin=true when hasAdminSession resolves true", async () => {
    hasAdminSession.mockResolvedValue(true);

    const el = (await HeaderNav()) as ReactElement<{ showAdmin: boolean }>;

    expect(el.type).toBe(NavLinks);
    expect(el.props.showAdmin).toBe(true);
  });

  it("renders NavLinks with showAdmin=false when there is no admin session", async () => {
    const el = (await HeaderNav()) as ReactElement<{ showAdmin: boolean }>;

    expect(el.type).toBe(NavLinks);
    expect(el.props.showAdmin).toBe(false);
  });
});

describe("HeaderFallback — layout-shift safety net", () => {
  it("reserves the header's 59px (2px accent + h-14 row + 1px border) with a matching border", () => {
    const el = HeaderFallback() as ReactElement<{
      className: string;
      "aria-hidden"?: string;
    }>;

    expect(el.props.className).toContain("h-[59px]");
    expect(el.props.className).toContain("border-b");
    expect(el.props.className).toContain("sticky");
    expect(el.props["aria-hidden"]).toBe("true");
  });
});

describe("NavLinksView — hook-free markup", () => {
  it("marks no link active when pathname is null", () => {
    const tree = NavLinksView({ pathname: null, showAdmin: true });

    const current = collectElements(tree).filter(
      (el) => el.props?.["aria-current"] === "page",
    );
    expect(current).toHaveLength(0);
  });

  it("hides the admin link by default", () => {
    const tree = NavLinksView({ pathname: null });

    expect(findByHref(tree, "/admin")).toBeUndefined();
  });

  it("marks the matching link active for a pathname", () => {
    const tree = NavLinksView({ pathname: "/blindspots/x", showAdmin: true });

    expect(findByHref(tree, "/blindspots")?.props?.["aria-current"]).toBe("page");
    expect(findByHref(tree, "/")?.props?.["aria-current"]).toBeUndefined();
    expect(findByHref(tree, "/admin")).toBeDefined();
  });

  it("NavLinks delegates to NavLinksView using usePathname (mocked /blindspots)", () => {
    const tree = NavLinks({ showAdmin: false });

    expect(findByHref(tree, "/blindspots")?.props?.["aria-current"]).toBe("page");
    expect(findByHref(tree, "/")?.props?.["aria-current"]).toBeUndefined();
  });
});

describe("root layout wiring", () => {
  it("wraps <Header /> in <Suspense fallback={<HeaderFallback />}>", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../app/layout.tsx"),
      "utf8",
    );

    expect(src).toMatch(
      /<Suspense fallback=\{<HeaderFallback \/>\}>\s*<Header \/>/,
    );
  });
});
