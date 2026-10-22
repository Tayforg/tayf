import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// House pattern: see silence-digest-band.test.tsx. The list is a plain server
// component (no client hooks), so renderToStaticMarkup needs no mocking.
import { NearBlindspotList } from "./near-blindspot-section";
import { balanceFromZoneCounts } from "@/lib/bias/balance";
import { BLINDSPOT, ZONE_META } from "@/lib/bias/config";
import type { NearBlindspotItem } from "@/lib/clusters/near-blindspots-query";

function mkItem(overrides: Partial<NearBlindspotItem> = {}): NearBlindspotItem {
  return {
    id: "c1",
    title: "Örnek yakın haber",
    dominantZone: "iktidar",
    dominantShare: 0.7,
    votingTotal: 10,
    balance: balanceFromZoneCounts({ iktidar: 7, bagimsiz: 0, muhalefet: 3 }),
    updatedAt: "2026-10-21T10:00:00.000Z",
    ...overrides,
  };
}

const THRESHOLD_PCT = Math.round(BLINDSPOT.dominantShare * 100);

describe("NearBlindspotList", () => {
  it("renders nothing for null (the fetch failed: the section is hidden)", () => {
    expect(renderToStaticMarkup(<NearBlindspotList items={null} />)).toBe("");
  });

  it("renders nothing for an empty list", () => {
    expect(renderToStaticMarkup(<NearBlindspotList items={[]} />)).toBe("");
  });

  it("renders a labelled section with the heading", () => {
    const markup = renderToStaticMarkup(<NearBlindspotList items={[mkItem()]} />);
    expect(markup).toContain('<section aria-labelledby="kor-noktaya-yakin"');
    expect(markup).toContain('id="kor-noktaya-yakin"');
    expect(markup).toContain("Kör noktaya yakın");
  });

  it("states the blindspot threshold from the BLINDSPOT contract and that these are not blindspots", () => {
    const markup = renderToStaticMarkup(<NearBlindspotList items={[mkItem()]} />);
    expect(markup).toContain(
      `Bir bölgenin ağırlıkta olduğu ama kör nokta eşiğinin (%${THRESHOLD_PCT}) altında kalan haberler.`,
    );
    expect(markup).toContain("%80");
    expect(markup).toContain("Kör nokta sayılmazlar;");
    expect(markup).toContain("Bu listede kim yer vermedi?");
    expect(markup).toContain("özetine katılmazlar.");
  });

  it("renders the zone chip with the share and the zone label", () => {
    const markup = renderToStaticMarkup(<NearBlindspotList items={[mkItem()]} />);
    expect(markup).toContain(`%70 ${ZONE_META.iktidar.label}`);
  });

  it("styles the chip with the dominant zone's ZONE_META tokens", () => {
    const markup = renderToStaticMarkup(
      <NearBlindspotList
        items={[mkItem({ id: "m1", dominantZone: "muhalefet", dominantShare: 0.75 })]}
      />,
    );
    const meta = ZONE_META.muhalefet;
    expect(markup).toContain(`%75 ${meta.label}`);
    expect(markup).toContain(meta.chipBg);
    expect(markup).toContain(meta.chipBorder);
    expect(markup).toContain(meta.chipText);
  });

  it("floors the share: 0.799 reads %79 and never %80 on a chip", () => {
    const markup = renderToStaticMarkup(
      <NearBlindspotList items={[mkItem({ dominantShare: 0.799 })]} />,
    );
    expect(markup).toContain(`%79 ${ZONE_META.iktidar.label}`);
    expect(markup).not.toContain(`%80 ${ZONE_META.iktidar.label}`);
  });

  it("shows the compact balance chip and the voting source count", () => {
    const markup = renderToStaticMarkup(<NearBlindspotList items={[mkItem()]} />);
    const balance = balanceFromZoneCounts({ iktidar: 7, bagimsiz: 0, muhalefet: 3 });
    expect(markup).toContain(`Denge ${balance?.score}`);
    expect(markup).toContain("10 kaynak");
  });

  it("omits the balance chip when the cluster has no score", () => {
    const markup = renderToStaticMarkup(
      <NearBlindspotList items={[mkItem({ balance: null })]} />,
    );
    expect(markup).not.toContain("Denge ");
    expect(markup).toContain("10 kaynak");
  });

  it("links each title to its cluster page", () => {
    const markup = renderToStaticMarkup(
      <NearBlindspotList
        items={[
          mkItem({ id: "c1", title: "Birinci haber" }),
          mkItem({ id: "c2", title: "İkinci haber" }),
        ]}
      />,
    );
    expect(markup).toContain('href="/cluster/c1"');
    expect(markup).toContain('href="/cluster/c2"');
    expect(markup).toContain("Birinci haber");
    expect(markup).toContain("İkinci haber");
    expect(markup.match(/<li\b/g)).toHaveLength(2);
  });

  it("links the footer to the methodology anchor", () => {
    const markup = renderToStaticMarkup(<NearBlindspotList items={[mkItem()]} />);
    expect(markup).toContain('href="/metodoloji#kor-noktaya-yakin"');
    expect(markup).toContain("Nasıl seçiliyor?");
  });

  it("escapes a hostile title instead of injecting markup", () => {
    const markup = renderToStaticMarkup(
      <NearBlindspotList
        items={[mkItem({ title: '<script>alert("x")</script> & "tırnak"' })]}
      />,
    );
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });
});
