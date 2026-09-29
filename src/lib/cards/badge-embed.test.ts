import { describe, it, expect } from "vitest";
import { buildEmbedSnippet } from "./badge-embed";

const ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";
const ORIGIN = "https://tayf.test";

describe("buildEmbedSnippet", () => {
  it("returns the exact html with &amp; in the href, fixed alt and dimensions", () => {
    const s = buildEmbedSnippet(ORIGIN, ID)!;
    expect(s.html).toBe(
      `<a href="https://tayf.test/cluster/${ID}?utm_source=embed&amp;utm_medium=badge&amp;utm_campaign=cluster"><img src="https://tayf.test/rozet/${ID}.svg" alt="Tayf yelpazesi: bu haberi hangi medya bölgeleri yazdı" width="320" height="48" loading="lazy"></a>`,
    );
  });
  it("markdown variant wraps the image in the link", () => {
    const s = buildEmbedSnippet(ORIGIN, ID)!;
    expect(s.markdown).toBe(
      `[![Tayf yelpazesi: bu haberi hangi medya bölgeleri yazdı](https://tayf.test/rozet/${ID}.svg)](https://tayf.test/cluster/${ID}?utm_source=embed&utm_medium=badge&utm_campaign=cluster)`,
    );
  });
  it("is null for non-uuid ids", () => {
    expect(buildEmbedSnippet(ORIGIN, "../x")).toBeNull();
    expect(buildEmbedSnippet(ORIGIN, "")).toBeNull();
    expect(buildEmbedSnippet(ORIGIN, `${ID}"><script>`)).toBeNull();
  });
});
