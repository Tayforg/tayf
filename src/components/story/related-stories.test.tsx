import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  selectRelatedClusters,
  type RelatedCandidate,
  type RelatedCluster,
} from "@/lib/clusters/related-clusters";
import { TOPIC_LABELS_TR } from "@/lib/clusters/topic-query";

import { RelatedStories } from "./related-stories";

// RelatedStories is a hookless server component, so it renders directly with
// react-dom/server. The wider block tests (links, escaping, byte budget, the
// source file guards) live in src/app/cluster/[id]/cluster-page.test.tsx; this
// file pins the h34-reader-3 part: the heading says what the list is.

const ITEMS: RelatedCluster[] = [
  { id: "11111111-1111-4111-8111-111111111111", title: "Faiz kararı açıklandı", sourceCount: 12, lang: undefined },
  { id: "22222222-2222-4222-8222-222222222222", title: "Central bank holds rates", sourceCount: 3, lang: "en" },
];

function render(over: Partial<Parameters<typeof RelatedStories>[0]> = {}): string {
  return renderToStaticMarkup(
    <RelatedStories
      items={ITEMS}
      topicLabel="Ekonomi"
      hubHref="/konu/ekonomi"
      hubLabel="Tüm Ekonomi haberleri"
      {...over}
    />,
  );
}

/** What the page hands over for a pool nothing in which relates to the current story. */
function latestSelection() {
  const bundles: RelatedCandidate[] = [
    {
      cluster: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        title_tr: "Mekke Anlaşması'nın ilk maddesi kabul edildi",
        article_count: 5,
        updated_at: "2026-11-04T10:00:00.000Z",
      },
    },
    {
      cluster: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        title_tr: "Bakan Çiftçi, İtalyan mevkidaşı ile bir araya geldi",
        article_count: 4,
        updated_at: "2026-11-04T11:00:00.000Z",
      },
    },
  ];
  return selectRelatedClusters({
    currentId: "self",
    currentTitle: "Korkuteli Belediye Başkanı Saniye Caran, CHP'den istifa etti",
    topic: "politika",
    bundles,
  });
}

describe("RelatedStories — mode 'related'", () => {
  it("is the default for a plain array (the legacy call shape): 'İlgili haberler' and the topic line", () => {
    const html = render();
    expect(html).toContain(">İlgili haberler</h2>");
    expect(html).toContain("Ekonomi konusunda son haberler");
    expect(html).not.toContain("gündeminde son haberler");
  });

  it("says 'İlgili haberler' for an explicit mode='related' too", () => {
    const html = render({ mode: "related" });
    expect(html).toContain(">İlgili haberler</h2>");
    expect(html).not.toContain("gündeminde son haberler");
  });
});

describe("RelatedStories — mode 'latest'", () => {
  it("renders the honest '<Konu> gündeminde son haberler' heading and never 'İlgili haberler'", () => {
    const html = render({ mode: "latest" });
    expect(html).toContain(">Ekonomi gündeminde son haberler</h2>");
    expect(html).not.toContain("İlgili");
    // The topic line under the heading would repeat it.
    expect(html).not.toContain("konusunda son haberler");
  });

  it("is still one labelled nav: the heading is the nav's name", () => {
    const html = render({ mode: "latest" });
    expect(html).toContain('<nav aria-labelledby="related-stories-heading"');
    expect(html).toContain('<h2 id="related-stories-heading"');
    expect(html.split("<h2").length - 1).toBe(1);
  });

  it("keeps the list, the counts, the language marks and the hub link", () => {
    const html = render({ mode: "latest" });
    expect(html.split("<li").length - 1).toBe(2);
    expect(html).toContain('href="/cluster/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain("12 kaynak");
    expect(html.split('lang="en"').length - 1).toBe(1);
    expect(html).toContain('href="/konu/ekonomi"');
    expect(html).toContain("Tüm Ekonomi haberleri");
  });

  it("uses the topic label it is given, 'Politika' included", () => {
    expect(render({ mode: "latest", topicLabel: "Politika", hubHref: "/", hubLabel: "Tüm Politika haberleri" })).toContain(
      ">Politika gündeminde son haberler</h2>",
    );
    expect(render({ mode: "latest", topicLabel: "Dünya" })).toContain(">Dünya gündeminde son haberler</h2>");
  });

  // "Genel gündeminde" would parse as "in the agenda of Genel": 'genel' is an
  // adjective ("general"), not a name, so its heading takes the plain locative.
  it("reads 'Genel gündemde son haberler' for the genel feed, never 'Genel gündeminde'", () => {
    const html = render({ mode: "latest", topicLabel: "Genel", hubHref: "/konu/genel", hubLabel: "Tüm Genel haberleri" });
    expect(html).toContain(">Genel gündemde son haberler</h2>");
    expect(html).not.toContain("gündeminde");
    expect(html).not.toContain("İlgili");
  });

  it("labels the genel feed the way the heading expects (TOPIC_LABELS_TR.genel)", () => {
    expect(TOPIC_LABELS_TR.genel).toBe("Genel");
  });

  it("every other topic label keeps '<Konu> gündeminde son haberler'", () => {
    for (const [slug, label] of Object.entries(TOPIC_LABELS_TR)) {
      if (slug === "genel") continue;
      expect(render({ mode: "latest", topicLabel: label }), slug).toContain(`>${label} gündeminde son haberler</h2>`);
    }
    expect(render({ mode: "latest", topicLabel: "Politika" })).toContain(">Politika gündeminde son haberler</h2>");
  });

  it("the genel heading comes through the selector's marker too, with no mode prop", () => {
    const html = render({ items: latestSelection(), topicLabel: "Genel" });
    expect(html).toContain(">Genel gündemde son haberler</h2>");
  });

  it("'İlgili haberler' mode reads 'Genel gündemde son haberler' for the genel feed, never 'Genel konusunda'", () => {
    const html = render({ mode: "related", topicLabel: "Genel" });
    expect(html).toContain(">İlgili haberler</h2>");
    expect(html).toContain("Genel gündemde son haberler");
    expect(html).not.toContain("Genel konusunda");
  });

  it("escapes the topic label instead of injecting it", () => {
    const html = render({ mode: "latest", topicLabel: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("stays under the 3500-byte budget for 5 rows of 100-character Turkish titles", () => {
    const title =
      "Merkez Bankası politika faizini yüzde kırk beşte sabit tuttu, piyasalarda dalgalanma sürüyor ve dolar".slice(
        0,
        100,
      );
    const five = Array.from({ length: 5 }, (_, i) => ({
      id: `0000000${i}-aaaa-4bbb-8ccc-dddddddddddd`,
      title,
      sourceCount: 12,
      lang: undefined,
    }));
    expect(Buffer.byteLength(render({ mode: "latest", items: five }), "utf8")).toBeLessThan(3500);
  });
});

describe("RelatedStories — the mode rides on the selector's return value", () => {
  it("renders the 'latest' heading for what selectRelatedClusters marked 'latest', with no mode prop", () => {
    const items = latestSelection();
    expect(items.mode).toBe("latest");
    expect(items).toHaveLength(2);
    const html = render({ items });
    expect(html).toContain(">Ekonomi gündeminde son haberler</h2>");
    expect(html).not.toContain("İlgili haberler");
  });

  it("an explicit mode prop wins over the marker on the list", () => {
    const items = latestSelection();
    expect(render({ items, mode: "related" })).toContain(">İlgili haberler</h2>");
  });

  it("a copy of the list loses the marker and reads as the legacy 'related'", () => {
    const html = render({ items: [...latestSelection()] });
    expect(html).toContain(">İlgili haberler</h2>");
  });
});
