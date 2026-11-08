import { afterEach, describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";

// ---------------------------------------------------------------------------
// seo-error-states A.1: every route error boundary renders a failed state, so
// each must tell crawlers not to index it. React 19 hoists the <meta> into
// <head>; Google applies the most restrictive directive, which beats the root
// layout's `index,follow`. The raw error digest is also kept out of the
// visible copy (it was thin, repeated "Hata kodu: ..." text on a failed page)
// and exposed as a `data-digest` attribute for support/debugging instead.
//
// h41-resilience-1: "Tekrar dene" must actually re-fetch. Next 16.4.5 hands
// the error component `{ error, reset, retry }`. `reset()` only clears the
// boundary state and re-renders the same rejected RSC payload (no request is
// made, the error card just comes back); `retry()` is
// `startTransition(() => { router.refresh(); reset(); })`, which re-fetches
// the segment. Every boundary's button must therefore call `retry`.
// ---------------------------------------------------------------------------

// The boundaries call useEffect (console.error logging). Neutralise it so the
// components can also be invoked as plain functions to inspect their element
// tree — React hoists <meta> out of the tree in rendered markup, so the
// "first child of the outer div" contract is only observable on the tree.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: () => undefined };
});

// The boundaries render <RetryButton>, which reads the router, and the cluster
// boundary reads its route id (h69-pwa-1). renderToStaticMarkup has no app
// router, so give it an inert one.
const routeParams = vi.hoisted(() => ({ value: { id: "0f8fad5b-d9cb-469f-a165-70867728950e" } as Record<string, string | string[]> }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useParams: () => routeParams.value,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { RetryButton } from "@/components/ui/retry-button";
import { StoredCopyLink } from "@/components/pwa/stored-copy-link";
import GlobalError from "./error";
import EkonomiError from "./ekonomi/error";
import ClusterError from "./cluster/[id]/error";
import TrendsError from "./trends/error";

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
  retry: () => void;
};

const BOUNDARIES: ReadonlyArray<[string, (props: ErrorProps) => ReactElement]> = [
  ["src/app/error.tsx", GlobalError],
  ["src/app/ekonomi/error.tsx", EkonomiError],
  ["src/app/cluster/[id]/error.tsx", ClusterError],
  ["src/app/trends/error.tsx", TrendsError],
];

const ROBOTS_NOINDEX = /<meta name="robots" content="noindex"\s*\/?>/;

function withDigest(digest?: string): Error & { digest?: string } {
  const err = new Error("x") as Error & { digest?: string };
  if (digest !== undefined) err.digest = digest;
  return err;
}

// Element-tree walk: the boundaries return plain host elements (plus the
// mocked next/link function component, whose props.children we still visit),
// so no renderer is needed to find the button and invoke its handler.
function childrenOf(el: ReactElement): ReactNode[] {
  const children = (el.props as { children?: ReactNode }).children;
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children : [children];
}

function findElements(
  node: ReactNode,
  match: (el: ReactElement) => boolean,
): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((n) => findElements(n, match));
  if (!isValidElement(node)) return [];
  const el = node as ReactElement;
  return [
    ...(match(el) ? [el] : []),
    ...childrenOf(el).flatMap((c) => findElements(c, match)),
  ];
}

describe.each(BOUNDARIES)("%s", (_label, Boundary) => {
  it("emits <meta name=robots content=noindex> and exposes the digest as data-digest only", () => {
    const markup = renderToStaticMarkup(
      <Boundary error={withDigest("d123")} reset={() => {}} retry={() => {}} />,
    );

    expect(markup).toMatch(ROBOTS_NOINDEX);
    expect(markup).toContain('data-digest="d123"');
    expect(markup).not.toContain("Hata kodu");
    expect(markup).not.toContain(">d123<");
  });

  it("makes the noindex meta the first child of the outer div (element tree)", () => {
    const tree = Boundary({
      error: withDigest("d123"),
      reset: () => {},
      retry: () => {},
    }) as ReactElement<{
      "data-digest"?: string;
      children: ReactElement<{ name?: string; content?: string }>[];
    }>;

    expect(tree.type).toBe("div");
    expect(tree.props["data-digest"]).toBe("d123");
    const first = tree.props.children[0];
    expect(first?.type).toBe("meta");
    expect(first?.props).toEqual({ name: "robots", content: "noindex" });
  });

  it("omits the data-digest prop (undefined) when the error has no digest (element tree)", () => {
    const tree = Boundary({
      error: withDigest(),
      reset: () => {},
      retry: () => {},
    }) as ReactElement<{ "data-digest"?: string }>;

    expect(tree.props["data-digest"]).toBeUndefined();
  });

  it("still noindexes and omits data-digest when the error has no digest", () => {
    const markup = renderToStaticMarkup(
      <Boundary error={withDigest()} reset={() => {}} retry={() => {}} />,
    );

    expect(markup).toMatch(ROBOTS_NOINDEX);
    expect(markup).not.toContain("data-digest");
    expect(markup).not.toContain("Hata kodu");
  });

  it("keeps the retry button", () => {
    const markup = renderToStaticMarkup(
      <Boundary error={withDigest("d123")} reset={() => {}} retry={() => {}} />,
    );

    expect(markup).toContain("Tekrar dene");
  });

  it("announces the pending refresh: the retry button carries a polite status region and aria-disabled", () => {
    // retry() is startTransition(refresh + reset): the error card stays on
    // screen, unchanged, until the RSC refresh resolves. RetryButton is what
    // gives the reader a pending state, an ignored double click and a live region.
    const markup = renderToStaticMarkup(
      <Boundary error={withDigest("d123")} reset={() => {}} retry={() => {}} />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-disabled="false"');
    expect(markup).toContain("Tekrar dene");
  });

  it("'Tekrar dene' is a <RetryButton onRetry={retry}>: calling onRetry runs retry() once and never reset() (element tree)", () => {
    const resetSpy = vi.fn();
    const retrySpy = vi.fn();
    const tree = Boundary({
      error: withDigest("d123"),
      reset: resetSpy,
      retry: retrySpy,
    });

    const buttons = findElements(tree, (el) => el.type === RetryButton);
    expect(buttons).toHaveLength(1);
    // No raw <button> beside it: the only retry control is the shared one.
    expect(findElements(tree, (el) => el.type === "button")).toHaveLength(0);

    const onRetry = (buttons[0]?.props as { onRetry?: unknown }).onRetry;
    expect(typeof onRetry).toBe("function");
    (onRetry as () => void)();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it("keeps the label and the boundary's own button styling on the shared button", () => {
    const tree = Boundary({
      error: withDigest("d123"),
      reset: () => {},
      retry: () => {},
    });

    const [button] = findElements(tree, (el) => el.type === RetryButton);
    const props = button?.props as { label?: string; className?: string };
    // Default label ("Tekrar dene") is kept.
    expect(props.label ?? "Tekrar dene").toBe("Tekrar dene");
    expect(props.className).toContain("rounded-full");
    expect(props.className).toContain("bg-foreground");
    expect(props.className).toContain("aria-disabled:opacity-60");
  });
});

// h69-pwa-1: the cluster route answers 200 and flushes its headers before the database read, so a read failure
// reaches the client boundary and nothing else. Only the boundary can offer the copy this device holds.
describe("src/app/cluster/[id]/error.tsx stored copy", () => {
  const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const props = { error: withDigest("d1"), reset: () => {}, retry: () => {} };

  afterEach(() => {
    routeParams.value = { id: ID };
  });

  it("renders <StoredCopyLink> for the id of the route, after the existing buttons", () => {
    const tree = ClusterError(props);
    const links = findElements(tree, (el) => el.type === StoredCopyLink);
    expect(links).toHaveLength(1);
    expect((links[0]?.props as { clusterId?: string }).clusterId).toBe(ID);

    const order: string[] = [];
    const walk = (node: ReactNode) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!isValidElement(node)) return;
      const el = node as ReactElement;
      if (el.type === RetryButton) order.push("retry");
      if (el.type === StoredCopyLink) order.push("copy");
      childrenOf(el).forEach(walk);
    };
    walk(tree);
    expect(order).toEqual(["retry", "copy"]);
  });

  it("takes the first value when the router hands the id over as an array", () => {
    routeParams.value = { id: [ID, "x"] };
    const links = findElements(ClusterError(props), (el) => el.type === StoredCopyLink);
    expect((links[0]?.props as { clusterId?: string }).clusterId).toBe(ID);
  });

  it("renders no link without a route id", () => {
    routeParams.value = {};
    expect(findElements(ClusterError(props), (el) => el.type === StoredCopyLink)).toHaveLength(0);
  });

  it("still renders the failed state first-pass markup unchanged: no copy offer before mount", () => {
    const markup = renderToStaticMarkup(<ClusterError {...props} />);
    expect(markup).toContain("Hikâye yüklenemedi");
    expect(markup).toContain("Tekrar dene");
    expect(markup).toContain("Tüm haberler");
    expect(markup).not.toContain("kopya");
  });
});

describe("error boundaries — source guard", () => {
  const APP_DIR = resolve(__dirname);

  function findErrorFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...findErrorFiles(full));
      else if (name === "error.tsx") out.push(full);
    }
    return out.sort();
  }

  const files = findErrorFiles(APP_DIR);

  it("finds at least the four known route boundaries (the guard is not vacuous)", () => {
    expect(files.map((f) => relative(APP_DIR, f))).toEqual(
      expect.arrayContaining([
        "cluster/[id]/error.tsx",
        "ekonomi/error.tsx",
        "error.tsx",
        "trends/error.tsx",
      ]),
    );
  });

  it.each(files.map((f) => [relative(APP_DIR, f), f] as const))(
    "%s wires 'Tekrar dene' to retry, not reset",
    (_rel, file) => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/onClick=\{reset\}/);
      expect(source).not.toMatch(/onRetry=\{reset\}/);
      expect(source).toMatch(/\bretry\b/);
      // A raw <button onClick={retry}> gives no pending state; use the shared one.
      expect(source).not.toMatch(/<button\b/);
      expect(source).toMatch(/import \{ RetryButton \} from "@\/components\/ui\/retry-button";/);
      expect(source).toMatch(/<RetryButton\b[^>]*\bonRetry=\{retry\}/);
    },
  );
});
