import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HERO_CANDIDATE_CAP, pickHeroCandidates } from "./hero-candidates";
import { GENERATED_IMAGE_HOSTS } from "./remote-image-hosts.data";
import { isAllowedRemoteImageUrl } from "./remote-image-hosts";

// h99-clientjs-1: a story card or the cluster hero used to hand EVERY member's
// image URL to the client component (up to 44 on the home page, plus a credits
// map of all of them on /cluster/<id>), which normalises and filters them again
// and never walks more than a handful. pickHeroCandidates does the same
// normalise + allowlist + dedupe on the server and keeps the first
// HERO_CANDIDATE_CAP, so the RSC payload carries only URLs that can be shown.

// An exact (non-wildcard) hostname straight from the generated allowlist, so
// the fixtures follow the list when it is regenerated.
const HOST = GENERATED_IMAGE_HOSTS.find((h) => !h.includes("*"));
if (HOST === undefined) throw new Error("no exact host in the generated list");

const OTHER_HOST = GENERATED_IMAGE_HOSTS.filter((h) => !h.includes("*"))[1];
if (OTHER_HOST === undefined) throw new Error("fewer than two exact hosts");

const img = (n: number | string, host: string = HOST) => `https://${host}/foto/${n}.jpg`;

describe("fixtures", () => {
  it("the fixture hosts are on the allowlist and the rejected shapes are not", () => {
    expect(isAllowedRemoteImageUrl(img(1))).toBe(true);
    expect(isAllowedRemoteImageUrl(img(1, OTHER_HOST))).toBe(true);
    expect(isAllowedRemoteImageUrl("https://not-listed.example/a.jpg")).toBe(false);
  });
});

describe("HERO_CANDIDATE_CAP", () => {
  it("is 8: the mobile banner and the cluster hero both skip candidates under 320 px, so 4 could run dry", () => {
    expect(HERO_CANDIDATE_CAP).toBe(8);
  });
});

describe("pickHeroCandidates", () => {
  it("keeps the first 8 of 20 distinct allowed URLs, in order", () => {
    const urls = Array.from({ length: 20 }, (_, i) => img(i));
    expect(pickHeroCandidates(urls)).toEqual(urls.slice(0, 8));
  });

  it("an input at or under the cap comes back whole and in order", () => {
    const urls = [img(3), img(1, OTHER_HOST), img(2)];
    expect(pickHeroCandidates(urls)).toEqual(urls);
    const eight = Array.from({ length: 8 }, (_, i) => img(i));
    expect(pickHeroCandidates(eight)).toEqual(eight);
  });

  it("honours an explicit cap", () => {
    const urls = Array.from({ length: 20 }, (_, i) => img(i));
    expect(pickHeroCandidates(urls, 3)).toEqual(urls.slice(0, 3));
    expect(pickHeroCandidates(urls, 1)).toEqual([urls[0]]);
    expect(pickHeroCandidates(urls, 0)).toEqual([]);
  });

  it("a protocol-relative URL on an allowed host becomes https", () => {
    expect(pickHeroCandidates([`//${HOST}/a.jpg`])).toEqual([`https://${HOST}/a.jpg`]);
  });

  it("drops an animated .gif and a host that is not on the allowlist", () => {
    const good = img("ok");
    expect(
      pickHeroCandidates([
        `https://${HOST}/placeholder.gif`,
        "https://not-listed.example/a.jpg",
        good,
      ]),
    ).toEqual([good]);
  });

  it("drops plain http, a fragment URL and non-http schemes", () => {
    const good = img("ok");
    expect(
      pickHeroCandidates([
        `http://${HOST}/a.jpg`,
        `https://${HOST}/a.jpg#frag`,
        "data:image/png;base64,AAAA",
        "javascript:alert(1)",
        "not a url",
        good,
      ]),
    ).toEqual([good]);
  });

  it("two spellings that differ only by a doubled leading path slash give one entry", () => {
    const clean = `https://${HOST}/fotogaleri/x.jpg`;
    const doubled = `https://${HOST}//fotogaleri/x.jpg`;
    expect(pickHeroCandidates([doubled, clean])).toEqual([clean]);
    expect(pickHeroCandidates([clean, doubled])).toEqual([clean]);
  });

  it("the first spelling wins its position when duplicates follow other URLs", () => {
    const a = img("a");
    const b = img("b");
    expect(pickHeroCandidates([a, b, a, `//${HOST}/foto/a.jpg`, b])).toEqual([a, b]);
  });

  it("drops null, undefined and the empty string", () => {
    const good = img("ok");
    expect(pickHeroCandidates([null, undefined, "", "   ", good])).toEqual([good]);
    expect(pickHeroCandidates([null, undefined, ""])).toEqual([]);
    expect(pickHeroCandidates([])).toEqual([]);
  });

  it("an unusable first URL does not use a slot: 9 inputs with 1 bad give 8", () => {
    const good = Array.from({ length: 8 }, (_, i) => img(i));
    const out = pickHeroCandidates(["https://not-listed.example/a.jpg", ...good]);
    expect(out).toEqual(good);
    expect(out).toHaveLength(8);
  });

  it("unusable URLs scattered through the list never use a slot", () => {
    const good = Array.from({ length: 12 }, (_, i) => img(i));
    const mixed: Array<string | null> = [];
    good.forEach((u, i) => {
      mixed.push(i % 2 === 0 ? null : `https://${HOST}/x${i}.gif`, u);
    });
    expect(pickHeroCandidates(mixed)).toEqual(good.slice(0, 8));
  });

  it("duplicates do not use a slot either", () => {
    const good = Array.from({ length: 9 }, (_, i) => img(i));
    const dup = good.flatMap((u) => [u, u, u]);
    expect(pickHeroCandidates(dup)).toEqual(good.slice(0, 8));
  });

  it("is idempotent: re-picking its own output changes nothing (the client filter is a no-op on it)", () => {
    const mixed = [
      `//${HOST}/a.jpg`,
      `https://${HOST}//b.jpg`,
      "https://not-listed.example/c.jpg",
      img("d"),
      null,
    ];
    const once = pickHeroCandidates(mixed);
    expect(pickHeroCandidates(once, 100)).toEqual(once);
    for (const u of once) expect(isAllowedRemoteImageUrl(u)).toBe(true);
  });

  it("does not mutate its input", () => {
    const urls = [img(1), `//${HOST}/foto/2.jpg`, null];
    const before = JSON.stringify(urls);
    pickHeroCandidates(urls);
    expect(JSON.stringify(urls)).toBe(before);
  });

  it("handles a large cluster (10k members) and still returns only the cap", () => {
    const urls = Array.from({ length: 10_000 }, (_, i) => img(i));
    const out = pickHeroCandidates(urls);
    expect(out).toHaveLength(HERO_CANDIDATE_CAP);
    expect(out).toEqual(urls.slice(0, HERO_CANDIDATE_CAP));
  });

  it("keeps Unicode and percent-escaped paths as they are", () => {
    const u = `https://${HOST}/görsel/%C3%A7ay-%F0%9F%8D%B5.jpg`;
    expect(pickHeroCandidates([u])).toEqual([u]);
  });
});

describe("hero-candidates.ts module", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "hero-candidates.ts"), "utf8");

  it("is a plain module (no 'use client'), so a Server Component gets the real function", () => {
    // A directive is a statement on a line of its own; the header prose may name it.
    expect(src).not.toMatch(/^\s*["']use client["']/m);
  });
});
