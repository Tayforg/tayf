import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildClusterCollectionPage,
  buildRegistryDataset,
  buildSiteJsonLd,
  buildTayfOrganization,
  serializeJsonLd,
} from "./json-ld";

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

describe("buildClusterCollectionPage", () => {
  it("builds a CollectionPage with an absolute url, the WebSite it belongs to and an ItemList", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";

    expect(
      buildClusterCollectionPage({
        name: "Erdoğan haberleri",
        path: "/gundem/erdogan",
        items: [
          { name: "Birinci küme", path: "/cluster/c1" },
          { name: "İkinci küme", path: "/cluster/c2" },
          { name: "Üçüncü küme", path: "/cluster/c3" },
        ],
      }),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "Erdoğan haberleri",
      url: "https://tayf.test/gundem/erdogan",
      isPartOf: { "@type": "WebSite", name: "Tayf", url: "https://tayf.test" },
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: 3,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Birinci küme", url: "https://tayf.test/cluster/c1" },
          { "@type": "ListItem", position: 2, name: "İkinci küme", url: "https://tayf.test/cluster/c2" },
          { "@type": "ListItem", position: 3, name: "Üçüncü küme", url: "https://tayf.test/cluster/c3" },
        ],
      },
    });
  });

  it("follows NEXT_PUBLIC_SITE_URL (every url is absolute against siteUrl())", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://other.example";
    const page = buildClusterCollectionPage({
      name: "Gündemdeki adlar",
      path: "/gundem",
      items: [{ name: "CHP", path: "/gundem/chp" }],
    }) as {
      url: string;
      isPartOf: { url: string };
      mainEntity: { itemListElement: Array<{ url: string }> };
    };

    expect(page.url).toBe("https://other.example/gundem");
    expect(page.isPartOf.url).toBe("https://other.example");
    expect(page.mainEntity.itemListElement.map((i) => i.url)).toEqual([
      "https://other.example/gundem/chp",
    ]);
  });

  it("numbers positions 1..n in the given order and counts numberOfItems", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
    const items = Array.from({ length: 62 }, (_, i) => ({
      name: `Ad ${i}`,
      path: `/gundem/k${i}`,
    }));
    const page = buildClusterCollectionPage({ name: "x", path: "/gundem", items }) as {
      mainEntity: {
        numberOfItems: number;
        itemListElement: Array<{ position: number; name: string }>;
      };
    };

    expect(page.mainEntity.numberOfItems).toBe(62);
    expect(page.mainEntity.itemListElement.map((i) => i.position)).toEqual(
      Array.from({ length: 62 }, (_, i) => i + 1),
    );
    expect(page.mainEntity.itemListElement.map((i) => i.name)).toEqual(items.map((i) => i.name));
  });

  it("an empty item list is numberOfItems 0 with no ListItems", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
    const page = buildClusterCollectionPage({ name: "Boş", path: "/gundem/ysk", items: [] }) as {
      mainEntity: { numberOfItems: number; itemListElement: unknown[] };
    };

    expect(page.mainEntity.numberOfItems).toBe(0);
    expect(page.mainEntity.itemListElement).toEqual([]);
  });

  it("does not mutate its input", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
    const items = [{ name: "A", path: "/cluster/a" }];
    const snapshot = JSON.stringify(items);
    buildClusterCollectionPage({ name: "x", path: "/gundem", items });

    expect(JSON.stringify(items)).toBe(snapshot);
  });

  it("a name containing '</script' cannot close the script element once serialized", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
    const evil = "Başlık </script><script>alert(1)</script>";
    const page = buildClusterCollectionPage({
      name: evil,
      path: "/gundem/x",
      items: [{ name: evil, path: "/cluster/c1" }],
    });

    const json = serializeJsonLd(page);

    expect(json.toLowerCase()).not.toContain("</script");
    expect(json).not.toContain("<");
    const parsed = JSON.parse(json) as {
      name: string;
      mainEntity: { itemListElement: Array<{ name: string }> };
    };
    expect(parsed.name).toBe(evil);
    expect(parsed.mainEntity.itemListElement[0]!.name).toBe(evil);
  });
});

describe("buildRegistryDataset", () => {
  it("passes a supplied dateModified through untouched", () => {
    const ds = buildRegistryDataset({ dateModified: "2026-10-20T08:00:00.000Z" });

    expect(ds.dateModified).toBe("2026-10-20T08:00:00.000Z");
  });

  it("omits the dateModified key when the change time is null", () => {
    const ds = buildRegistryDataset({ dateModified: null });

    expect("dateModified" in ds).toBe(false);
  });

  it("omits the dateModified key when none is given", () => {
    const ds = buildRegistryDataset({});

    expect("dateModified" in ds).toBe(false);
  });

  it("omits the dateModified key for an empty string rather than emitting a blank date", () => {
    const ds = buildRegistryDataset({ dateModified: "" });

    expect("dateModified" in ds).toBe(false);
  });

  it("keeps the rest of the Dataset shape whether or not a date is known", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
    for (const options of [{ dateModified: "2026-10-20T08:00:00.000Z" }, {}]) {
      const ds = buildRegistryDataset(options);

      expect(ds["@context"]).toBe("https://schema.org");
      expect(ds["@type"]).toBe("Dataset");
      expect(ds.name).toBe("Tayf Kaynak Kaydı");
      expect(ds.license).toBe("https://creativecommons.org/licenses/by-sa/4.0/");
      expect(ds.distribution["@type"]).toBe("DataDownload");
      expect(ds.distribution.encodingFormat).toBe("application/json");
      expect(ds.distribution.contentUrl).toBe("https://tayf.test/api/sources");
      expect(ds.distribution.contentUrl.endsWith("/api/sources")).toBe(true);
    }
  });

  it("never reads the clock: the output is identical under two different system times", () => {
    vi.useFakeTimers();
    try {
      const options = { dateModified: "2026-10-20T08:00:00.000Z" };
      vi.setSystemTime(Date.parse("2026-11-01T09:30:00.000Z"));
      const first = JSON.stringify(buildRegistryDataset(options));
      vi.setSystemTime(Date.parse("2027-03-05T17:45:00.000Z"));
      const second = JSON.stringify(buildRegistryDataset(options));

      expect(second).toBe(first);

      vi.setSystemTime(Date.parse("2026-11-01T09:30:00.000Z"));
      const unknownFirst = JSON.stringify(buildRegistryDataset({ dateModified: null }));
      vi.setSystemTime(Date.parse("2027-03-05T17:45:00.000Z"));
      const unknownSecond = JSON.stringify(buildRegistryDataset({ dateModified: null }));

      expect(unknownSecond).toBe(unknownFirst);
      expect(unknownFirst).not.toContain("2026-11-01");
    } finally {
      vi.useRealTimers();
    }
  });
});
