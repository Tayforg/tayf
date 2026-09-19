import { describe, it, expect } from "vitest";

import { buildBreadcrumbs, buildRegistryDataset, serializeJsonLd } from "./json-ld";

describe("serializeJsonLd", () => {
  it("escapes < so a hostile string cannot break out of the script tag", () => {
    const input = { headline: "a </script><script>alert(1)</script> b" };
    const out = serializeJsonLd(input);

    expect(out.includes("<")).toBe(false);
    expect(out).toContain("\\u003c");
    expect(JSON.parse(out).headline).toBe(input.headline);
  });

  it("round-trips ordinary values losslessly", () => {
    const input = { a: 1, b: ["x"], c: null };
    expect(JSON.parse(serializeJsonLd(input))).toEqual(input);
  });

  it("escapes < inside nested objects and arrays too", () => {
    const out = serializeJsonLd({ author: [{ name: "<b>X</b>" }] });
    expect(out.includes("<")).toBe(false);
  });
});

describe("buildRegistryDataset (S-17)", () => {
  const NOW = "2026-04-17T12:00:00.000Z";

  it("builds a Dataset with name, description, licence, distribution and dateModified", () => {
    const dataset = buildRegistryDataset({ dateModified: NOW });

    expect(dataset["@context"]).toBe("https://schema.org");
    expect(dataset["@type"]).toBe("Dataset");
    expect(typeof dataset.name).toBe("string");
    expect(dataset.name.length).toBeGreaterThan(0);
    expect(typeof dataset.description).toBe("string");
    expect(dataset.description.length).toBeGreaterThan(0);
    // CC BY-SA 4.0, exact URL — this is the licence Tayf actually publishes
    // under (see /metodoloji), not a placeholder.
    expect(dataset.license).toBe(
      "https://creativecommons.org/licenses/by-sa/4.0/",
    );
    expect(dataset.distribution["@type"]).toBe("DataDownload");
    expect(dataset.distribution.contentUrl.endsWith("/api/sources")).toBe(
      true,
    );
    expect(dataset.dateModified).toBe(NOW);
    // Genuinely parseable as a date, not just any string.
    expect(Number.isNaN(new Date(dataset.dateModified).getTime())).toBe(
      false,
    );
  });

  it("round-trips through serializeJsonLd without a stray <", () => {
    const dataset = buildRegistryDataset({ dateModified: NOW });
    const out = serializeJsonLd(dataset);

    expect(out.includes("<")).toBe(false);
    expect(JSON.parse(out)).toEqual(dataset);
  });
});

describe("buildBreadcrumbs (S-17)", () => {
  it("builds a BreadcrumbList with 3 positioned, absolute-URL items", () => {
    const breadcrumbs = buildBreadcrumbs([
      { name: "Anasayfa", path: "/" },
      { name: "Kaynaklar", path: "/sources" },
      { name: "Sabah", path: "/source/sabah" },
    ]);

    expect(breadcrumbs["@context"]).toBe("https://schema.org");
    expect(breadcrumbs["@type"]).toBe("BreadcrumbList");
    expect(breadcrumbs.itemListElement).toHaveLength(3);

    const [first, second, third] = breadcrumbs.itemListElement;
    expect(first).toMatchObject({
      "@type": "ListItem",
      position: 1,
      name: "Anasayfa",
    });
    expect(second).toMatchObject({
      "@type": "ListItem",
      position: 2,
      name: "Kaynaklar",
    });
    expect(third).toMatchObject({
      "@type": "ListItem",
      position: 3,
      name: "Sabah",
    });
    expect(third.item.endsWith("/source/sabah")).toBe(true);
  });

  it("round-trips through serializeJsonLd without a stray <, even with a hostile crumb name", () => {
    const breadcrumbs = buildBreadcrumbs([
      { name: "Anasayfa", path: "/" },
      { name: "Kaynaklar", path: "/sources" },
      { name: "</script><script>alert(1)</script>", path: "/source/x" },
    ]);
    const out = serializeJsonLd(breadcrumbs);

    expect(out.includes("<")).toBe(false);
    expect(JSON.parse(out)).toEqual(breadcrumbs);
  });
});
