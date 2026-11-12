import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Suspense, createElement } from "react";
import { preload } from "react-dom";
import { prerender } from "react-dom/static";
import { describe, expect, it } from "vitest";

import { mobileBannerPreload } from "@/components/story/cluster-card";

// ---------------------------------------------------------------------------
// Permanent CI guard (h160-1): the home page preloads the first card's mobile
// banner from the PRERENDERED SHELL.
//
// Why: HomeFeed awaits searchParams, so the feed (and the first card's <img>
// with its preload) streams in behind a Suspense hole. On a hard load of "/"
// the browser used to see the image preload about 40 KB (on the wire) into the
// document, in <body>, 4.5 KB ahead of the <img> itself: no lead time, a 0.84 s
// load delay on a phone. HomeLcpPreload reads the same cached feed the page
// reads and calls react-dom's preload() for card 0's banner while the shell
// renders, so React writes it into <head> before the inline <style>.
//
// Three things must stay true, and this file pins each:
//
//   1. WIRING (source text, indexOf / includes only): the component sits in its
//      OWN <Suspense fallback={null}>, a sibling BEFORE the page container and
//      outside the HomeFeed boundary. Without that boundary a postponed read
//      would drop the whole page to src/app/loading.tsx.
//   2. NO REQUEST DATA: the component never reads search params, cookies,
//      headers, the connection or a clock. Any of those would make it dynamic
//      and move the preload out of the shell, which is the whole point.
//   3. HEAD ORDER: react-dom writes a preload() hint made while the shell
//      renders between <meta viewport> and the first precedence <style>.
//
// Source is read with indexOf / includes only (no regex over source or HTML),
// so nothing here can backtrack.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

/**
 * `text` with JSX comments (`{/* ... *\/}`) removed. One forward scan with
 * indexOf, so it is linear and cannot backtrack.
 */
function withoutJsxComments(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("{/*", at);
    if (open < 0) return out + text.slice(at);
    const close = text.indexOf("*/}", open);
    if (close < 0) return out + text.slice(at);
    out += text.slice(at, open);
    at = close + "*/}".length;
  }
}

describe("page.tsx wires HomeLcpPreload as the first sibling (h160-1)", () => {
  const page = read("src/app/page.tsx");
  const home = page.indexOf("export default function HomePage");

  it("imports the component from components/home", () => {
    expect(page).toContain(
      'import { HomeLcpPreload } from "@/components/home/home-lcp-preload";',
    );
  });

  it("renders it exactly once, directly inside <Suspense fallback={null}>", () => {
    expect(home).toBeGreaterThan(-1);
    const tag = "<HomeLcpPreload />";
    const open = "<Suspense fallback={null}>";
    const at = page.indexOf(tag, home);
    expect(at).toBeGreaterThan(home);
    expect(page.indexOf(tag, at + 1)).toBe(-1);

    const openAt = page.lastIndexOf(open, at);
    expect(openAt).toBeGreaterThan(home);
    // Nothing between the opening tag and the element, nor between the element
    // and the closing tag: the boundary wraps this one component.
    expect(page.slice(openAt + open.length, at).trim()).toBe("");
    const closeAt = page.indexOf("</Suspense>", at);
    expect(closeAt).toBeGreaterThan(at);
    expect(page.slice(at + tag.length, closeAt).trim()).toBe("");
  });

  it("the boundary is the first thing HomePage returns, inside a fragment", () => {
    const returnAt = page.indexOf("return (", home);
    expect(returnAt).toBeGreaterThan(home);
    const fragmentAt = page.indexOf("<>", returnAt);
    const boundaryAt = page.indexOf("<Suspense fallback={null}>", home);
    expect(page.slice(returnAt + "return (".length, fragmentAt).trim()).toBe("");
    // Only a JSX comment may sit between the fragment and the boundary.
    expect(
      withoutJsxComments(page.slice(fragmentAt + "<>".length, boundaryAt)).trim(),
    ).toBe("");
  });

  it("sits before HomePage's container and outside the HomeFeed boundary", () => {
    const lcp = page.indexOf("<HomeLcpPreload />", home);
    const closeAt = page.indexOf("</Suspense>", lcp);
    const container = page.indexOf('className="container', home);
    const feed = page.indexOf("<HomeFeed", home);
    expect(container).toBeGreaterThan(closeAt);
    expect(feed).toBeGreaterThan(container);
    expect(page.indexOf("</>", home)).toBeGreaterThan(feed);
  });

  it("HomePage stays a plain function and does not touch search params itself", () => {
    expect(page).not.toContain("export default async function HomePage");
    // The component gets no props: the boundary must not depend on the request.
    expect(page.split("<HomeLcpPreload").length).toBe(
      page.split("<HomeLcpPreload />").length,
    );
  });
});

describe("home-lcp-preload.tsx reads nothing from the request (h160-1)", () => {
  const rel = "src/components/home/home-lcp-preload.tsx";
  const source = read(rel);

  it("is a Server Component: no 'use client' directive", () => {
    expect(source).not.toContain('"use client"');
    expect(source).not.toContain("'use client'");
  });

  it('imports preload from "react-dom" and calls it', () => {
    expect(source).toContain('import { preload } from "react-dom";');
    expect(source).toContain("preload(href, options)");
  });

  it.each([
    "searchParams",
    "cookies(",
    "headers(",
    "connection(",
    "Date.now",
    "currentTimeMs",
  ])("never mentions %s", (token) => {
    expect(source.includes(token), `${token} in ${rel}`).toBe(false);
  });

  it("is not a cache scope and is not given a dynamic route flag", () => {
    expect(source).not.toContain("use cache");
    expect(source).not.toContain("unstable_noStore");
    expect(source).not.toContain("export const dynamic");
  });

  it("reads the default-profile feed (the call HomeFeed makes) and swallows its failure", () => {
    expect(source).toContain("await getPoliticsClusters()");
    // Every call is argument-less, so the cache key is the page's own.
    const calls = source.split("getPoliticsClusters(").length - 1;
    const bare = source.split("getPoliticsClusters()").length - 1;
    expect(calls).toBeGreaterThan(0);
    expect(bare).toBe(calls);
    const tryAt = source.indexOf("try {");
    const catchAt = source.indexOf("} catch {", tryAt);
    const returnAt = source.indexOf("return null", catchAt);
    expect(tryAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(tryAt);
    expect(returnAt).toBeGreaterThan(catchAt);
  });

  it("picks the card through homeFirstCard and the hero through cardHeroCandidates", () => {
    expect(source).toContain("homeFirstCard(feed)");
    expect(source).toContain("cardHeroCandidates(card.articles, card.sources)");
    expect(source).toContain("mobileBannerPreload(");
  });
});

describe("first-card.ts reads no clock (h160-1)", () => {
  const source = read("src/lib/home/first-card.ts");

  it.each(["Date.now", "currentTimeMs", "new Date()", "performance.now"])(
    "never mentions %s",
    (token) => {
      expect(source.includes(token), token).toBe(false);
    },
  );
});

describe("cluster-card.tsx feeds the preload from the banner's own values (h160-1)", () => {
  const card = read("src/components/story/cluster-card.tsx");

  it("the mobile banner uses MOBILE_BANNER_WIDTH / MOBILE_BANNER_HEIGHT and the hero helper", () => {
    expect(card).toContain("export const MOBILE_BANNER_WIDTH = 640;");
    expect(card).toContain("export const MOBILE_BANNER_HEIGHT = 360;");
    expect(card).toContain("width={MOBILE_BANNER_WIDTH}");
    expect(card).toContain("height={MOBILE_BANNER_HEIGHT}");
    expect(card).toContain("export function cardHeroCandidates(");
    expect(card).toContain("cardHeroCandidates(articles, sources)");
  });
});

// ---------------------------------------------------------------------------
// Head order: the claim the whole change rests on. A preload() made while the
// shell renders is written by React into <head>, before the first precedence
// <style> (the 125 KB of inline Tailwind on the real page). Rendered with
// react-dom/static, the same prerender Next runs for the shell.
// ---------------------------------------------------------------------------

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

const PHOTO = "https://example.com/photo.jpg";

// Render order, so the head-order test can pin its own premise (see below).
const order: string[] = [];

function Hint() {
  order.push("hint");
  const { href, options } = mobileBannerPreload(PHOTO);
  preload(href, options);
  return null;
}

async function AsyncHint() {
  // A real read awaits (the cached feed). One turn of the event loop stands in.
  await Promise.resolve();
  const { href, options } = mobileBannerPreload(PHOTO);
  preload(href, options);
  return null;
}

function Css() {
  order.push("css");
  return createElement("style", { href: "/x.css", precedence: "next" }, "a{b:c}");
}

/** The first `<link rel="preload" as="image" ...>` tag of `html`, or "". */
function imagePreloadTag(html: string): string {
  const from = html.indexOf('<link rel="preload" as="image"');
  if (from < 0) return "";
  return html.slice(from, html.indexOf(">", from) + 1);
}

describe("the preload lands in <head> before the inline <style> (h160-1)", () => {
  it("a preload() made by a component in <body> is written before the precedence <style>", async () => {
    order.length = 0;
    const tree = createElement(
      "html",
      null,
      createElement("head"),
      // The stylesheet is rendered FIRST on purpose, as on the real page where
      // the layout's CSS is found before the home shell's hint. Source order
      // therefore cannot explain link-before-style; only React's preamble
      // ordering (image preloads before precedence styles) can.
      createElement("body", null, createElement(Css), createElement(Hint)),
    );
    const { prelude } = await prerender(tree);
    const html = await readAll(prelude);

    // The premise: the style was discovered before the hint.
    expect(order).toEqual(["css", "hint"]);

    const link = html.indexOf('<link rel="preload" as="image"');
    const style = html.indexOf("<style");
    expect(link).toBeGreaterThanOrEqual(0);
    expect(style).toBeGreaterThanOrEqual(0);
    expect(link).toBeLessThan(style);
    // In <head>, not <body>.
    expect(link).toBeLessThan(html.indexOf("</head>"));
    // Once.
    expect(html.indexOf('<link rel="preload" as="image"', link + 1)).toBe(-1);

    const tag = imagePreloadTag(html);
    expect(tag).toContain("imageSrcSet=");
    expect(tag).toContain("imageSizes=");
    expect(tag).toContain('fetchPriority="high"');
  });

  it("the same holds from inside its own <Suspense fallback={null}>, with a postponed sibling boundary", async () => {
    // The page's shape: [Suspense(null) -> hint] then [container -> Suspense(skeleton) -> never-resolving feed].
    const never = new Promise<never>(() => {});
    function Feed() {
      throw never;
    }
    const tree = createElement(
      "html",
      null,
      createElement("head"),
      createElement(
        "body",
        null,
        createElement(Suspense, { fallback: null }, createElement(AsyncHint)),
        createElement(
          "div",
          { className: "container" },
          createElement(
            Suspense,
            { fallback: createElement("p", null, "skeleton") },
            createElement(Feed),
          ),
        ),
        createElement(Css),
      ),
    );
    const controller = new AbortController();
    const pending = prerender(tree, {
      signal: controller.signal,
      onError: () => {},
    });
    // Let the async hint settle, then cut the render off like a PPR prerender
    // does: the feed stays a hole, the shell is what is returned.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const { prelude } = await pending;
    const html = await readAll(prelude);

    const link = html.indexOf('<link rel="preload" as="image"');
    const style = html.indexOf("<style");
    expect(html.indexOf("skeleton")).toBeGreaterThanOrEqual(0);
    expect(link).toBeGreaterThanOrEqual(0);
    expect(style).toBeGreaterThanOrEqual(0);
    expect(link).toBeLessThan(style);
    expect(link).toBeLessThan(html.indexOf("</head>"));
    const tag = imagePreloadTag(html);
    expect(tag).toContain("imageSrcSet=");
    expect(tag).toContain("imageSizes=");
    expect(tag).toContain('fetchPriority="high"');
  });
});
