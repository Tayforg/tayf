import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaDna } from "./media-dna";
import type { Source } from "@/types";

function source(overrides: Partial<Source>): Source {
  return {
    id: overrides.id ?? overrides.slug ?? "src",
    name: overrides.name ?? "Kaynak",
    slug: overrides.slug ?? "kaynak",
    url: "https://example.com",
    rss_url: "https://example.com/rss",
    bias: overrides.bias ?? "center",
    logo_url: null,
    active: true,
    trustee_since: null,
    trustee_note: null,
    ...overrides,
  };
}

describe("MediaDna screen-reader detail", () => {
  const outlet = source({ id: "1", slug: "outlet-a", name: "Outlet A", bias: "center", kind: "outlet" });
  const aggregator = source({ id: "2", slug: "agg-a", name: "Agg A", bias: "center", kind: "aggregator" });
  const highlightSlugs = new Set(["outlet-a", "agg-a"]);

  const html = renderToStaticMarkup(
    <MediaDna sources={[outlet, aggregator]} highlightSlugs={highlightSlugs} />,
  );

  it("gives the non-voting (aggregator) chip a sr-only note that it does not count toward the bias distribution", () => {
    expect(html).toContain("yanlılık dağılımına sayılmaz");
    // The sr-only note text sits right after the source name, inside a
    // class="sr-only" span, distinct from the always-visible title attribute.
    expect(html).toMatch(/class="sr-only"[^>]*>[^<]*yanlılık dağılımına sayılmaz/);
  });

  it("gives the voting (outlet) chip its bias label in sr-only text, without the non-voting note", () => {
    // Extract the sr-only span that immediately follows "Outlet A".
    const idx = html.indexOf("Outlet A");
    expect(idx).toBeGreaterThan(-1);
    const after = html.slice(idx, idx + 400);
    const srMatch = after.match(/class="sr-only"[^>]*>([^<]*)</);
    expect(srMatch).toBeTruthy();
    expect(srMatch![1]).not.toContain("yanlılık dağılımına sayılmaz");
  });
});
