import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// House pattern: see src/components/story/read-across-spectrum.test.tsx.
// The band is a plain server component (no client hooks), so
// renderToStaticMarkup needs no mocking.
import { SilenceDigestBand } from "./silence-digest-band";
import type { SilenceDigest } from "@/lib/clusters/silence-digest";

const DIGEST: SilenceDigest = {
  windowTotal: 2,
  rows: [
    {
      zone: "iktidar",
      silentCount: 2,
      byDominant: [{ zone: "muhalefet", count: 2 }],
    },
    { zone: "bagimsiz", silentCount: 0, byDominant: [] },
    {
      zone: "muhalefet",
      silentCount: 1,
      byDominant: [{ zone: "iktidar", count: 1 }],
    },
  ],
};

describe("SilenceDigestBand", () => {
  it("renders nothing when no story fell in the window", () => {
    const markup = renderToStaticMarkup(
      <SilenceDigestBand digest={{ ...DIGEST, windowTotal: 0 }} />,
    );
    expect(markup).toBe("");
  });

  it("renders a labelled section with exactly 3 list items and the heading", () => {
    const markup = renderToStaticMarkup(<SilenceDigestBand digest={DIGEST} />);
    expect(markup).toContain('aria-label="Son 24 saatte yer verilmeyen hikâyeler"');
    expect(markup).toContain("Son 24 saat: kim yer vermedi?");
    expect(markup.match(/<li[ >]/g)).toHaveLength(3);
  });

  it("renders the footnote with the window total", () => {
    const markup = renderToStaticMarkup(<SilenceDigestBand digest={DIGEST} />);
    expect(markup).toContain("son 24 saatte güncellenen 2 hikâye");
  });

  it("renders each row's sentence", () => {
    const markup = renderToStaticMarkup(<SilenceDigestBand digest={DIGEST} />);
    expect(markup).toContain(
      "İktidara yakın kaynaklar 2 hikâyeye yer vermedi (2 muhalefet ağırlıklı)",
    );
    expect(markup).toContain(
      "Merkez ve bağımsız kaynaklar: yer vermedikleri hikâye yok",
    );
    expect(markup).toContain(
      "Muhalefete yakın kaynaklar 1 hikâyeye yer vermedi (1 iktidar ağırlıklı)",
    );
  });

  it("hides the decorative zone dots from assistive tech and uses the zone dot tokens", () => {
    const markup = renderToStaticMarkup(<SilenceDigestBand digest={DIGEST} />);
    expect(markup.match(/aria-hidden="true"/g)).toHaveLength(3);
    expect(markup).toContain("bg-red-500");
    expect(markup).toContain("bg-zinc-400");
    expect(markup).toContain("bg-emerald-500");
  });

  it("mutes only the zero row", () => {
    const markup = renderToStaticMarkup(<SilenceDigestBand digest={DIGEST} />);
    const items = markup.match(/<li[^>]*>/g) ?? [];
    expect(items).toHaveLength(3);
    const muted = items.filter((li) => li.includes("text-muted-foreground"));
    expect(muted).toHaveLength(1);
  });

  it("never uses accusatory wording", () => {
    const markup = renderToStaticMarkup(<SilenceDigestBand digest={DIGEST} />);
    expect(markup).not.toContain("görmezden");
    expect(markup).not.toContain("sustu");
    expect(markup).not.toContain("gizledi");
  });
});
