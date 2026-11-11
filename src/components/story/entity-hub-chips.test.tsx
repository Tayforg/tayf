import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EntityHubChips } from "./entity-hub-chips";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, "entity-hub-chips.tsx"), "utf8");

function html(keys: string[]): string {
  return renderToStaticMarkup(<EntityHubChips keys={keys} />);
}

describe("EntityHubChips", () => {
  it("links each key to its /gundem hub under a Turkish heading", () => {
    const out = html(["chp", "akp"]);
    expect(out).toContain('href="/gundem/chp"');
    expect(out).toContain('href="/gundem/akp"');
    expect(out).toContain(">CHP</a>");
    expect(out).toContain(">AK Parti</a>");
    expect(out).toContain("Bu haberdeki gündem başlıkları");
    // The links keep the order they were given.
    expect(out.indexOf("/gundem/chp")).toBeLessThan(out.indexOf("/gundem/akp"));
  });

  it("is a labelled list: the heading names the ul and each chip is one li", () => {
    const out = html(["chp", "akp", "tcmb"]);
    const headingId = /<h2 id="([^"]+)"/.exec(out)?.[1];
    expect(headingId).toBeTruthy();
    expect(out).toContain(`<ul aria-labelledby="${headingId}"`);
    expect(out.match(/<li\b/g)).toHaveLength(3);
    expect(out).toContain(">Merkez Bankası</a>");
  });

  it("renders nothing for no keys, so no empty heading appears", () => {
    expect(html([])).toBe("");
  });

  it("skips a key that has no hub and renders nothing when none is left", () => {
    expect(html(["no-such-hub"])).toBe("");
    expect(html(["__proto__", "constructor", "toString"])).toBe("");
    const out = html(["no-such-hub", "chp"]);
    expect(out).toContain('href="/gundem/chp"');
    expect(out).not.toContain("no-such-hub");
  });

  it("lists a repeated key once", () => {
    expect(html(["chp", "chp"]).match(/<li\b/g)).toHaveLength(1);
  });

  it("does not claim the story is listed on the hub (the hub shows only the newest 20 of 14 days)", () => {
    const out = html(["chp", "akp"]);
    expect(out).not.toContain("listelendiği");
    expect(out).not.toContain("listelenir");
    expect(out).not.toContain("listelen");
  });

  it("keeps the phone tap target, a visible focus ring and a wrapping row, in literal classes", () => {
    const out = html(["chp"]);
    expect(out).toContain("max-sm:min-h-11");
    expect(out).toContain("focus-visible:ring-2");
    expect(out).toContain("flex-wrap");
    // No computed class names: every className is a string literal.
    expect(SOURCE).not.toMatch(/className=\{/);
  });

  it("does not prefetch the hubs (a story page would otherwise pull up to five hub reads)", () => {
    // next/link renders a plain <a> on the server, so the prop is only visible in the source.
    expect(SOURCE).toContain("prefetch={false}");
  });

  it("is a server component: no 'use client', no hooks", () => {
    expect(SOURCE).not.toMatch(/["']use client["']/);
    expect(SOURCE).not.toMatch(/\buse(State|Effect|Id|Ref|Memo|Callback)\b/);
  });

  it("uses no opacity-modified text token (WCAG 1.4.3, tests/guards/text-contrast-tokens.test.ts)", () => {
    expect(SOURCE).not.toMatch(/text-[a-z-]+\/\d+/);
  });
});
