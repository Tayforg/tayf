import { describe, it, expect, afterEach } from "vitest";
import { buildTayfOrganization, buildSiteJsonLd } from "./json-ld";

const ORIGINAL_SITE_URL_ENV = process.env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  if (ORIGINAL_SITE_URL_ENV === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_SITE_URL_ENV;
});

describe("buildTayfOrganization", () => {
  it("builds the sitewide Tayf Organization node with a logo pointing at /apple-icon", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
    expect(buildTayfOrganization()).toEqual({
      "@type": "Organization",
      "@id": "https://tayf.test/#organization",
      name: "Tayf",
      url: "https://tayf.test",
      logo: {
        "@type": "ImageObject",
        url: "https://tayf.test/apple-icon",
        width: 180,
        height: 180,
      },
    });
  });
});

describe("buildSiteJsonLd", () => {
  it("builds an @graph with the Organization and a WebSite pointing at it", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
    const graph = buildSiteJsonLd();

    expect(graph["@context"]).toBe("https://schema.org");
    expect(graph["@graph"]).toEqual([
      buildTayfOrganization(),
      {
        "@type": "WebSite",
        "@id": "https://tayf.test/#website",
        name: "Tayf",
        url: "https://tayf.test",
        inLanguage: "tr-TR",
        publisher: { "@id": "https://tayf.test/#organization" },
      },
    ]);
  });
});
