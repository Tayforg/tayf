import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

// ---------------------------------------------------------------------------
// seo-error-states A.1: every route error boundary renders a failed state, so
// each must tell crawlers not to index it. React 19 hoists the <meta> into
// <head>; Google applies the most restrictive directive, which beats the root
// layout's `index,follow`. The raw error digest is also kept out of the
// visible copy (it was thin, repeated "Hata kodu: ..." text on a failed page)
// and exposed as a `data-digest` attribute for support/debugging instead.
// ---------------------------------------------------------------------------

// The boundaries call useEffect (console.error logging). Neutralise it so the
// components can also be invoked as plain functions to inspect their element
// tree — React hoists <meta> out of the tree in rendered markup, so the
// "first child of the outer div" contract is only observable on the tree.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: () => undefined };
});

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

import GlobalError from "./error";
import EkonomiError from "./ekonomi/error";
import ClusterError from "./cluster/[id]/error";
import TrendsError from "./trends/error";

type ErrorProps = { error: Error & { digest?: string }; reset: () => void };

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

describe.each(BOUNDARIES)("%s", (_label, Boundary) => {
  it("emits <meta name=robots content=noindex> and exposes the digest as data-digest only", () => {
    const markup = renderToStaticMarkup(
      <Boundary error={withDigest("d123")} reset={() => {}} />,
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
    }) as ReactElement<{ "data-digest"?: string }>;

    expect(tree.props["data-digest"]).toBeUndefined();
  });

  it("still noindexes and omits data-digest when the error has no digest", () => {
    const markup = renderToStaticMarkup(
      <Boundary error={withDigest()} reset={() => {}} />,
    );

    expect(markup).toMatch(ROBOTS_NOINDEX);
    expect(markup).not.toContain("data-digest");
    expect(markup).not.toContain("Hata kodu");
  });

  it("keeps the retry button", () => {
    const markup = renderToStaticMarkup(
      <Boundary error={withDigest("d123")} reset={() => {}} />,
    );

    expect(markup).toContain("Tekrar dene");
  });
});
