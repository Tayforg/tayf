import { describe, it, expect } from "vitest";
import { renderSpectrumBadgeSvg } from "./badge-svg";

const zones = (i: number, b: number, m: number) => ({ iktidar: i, bagimsiz: b, muhalefet: m });

function barWidths(svg: string): number[] {
  return [...svg.matchAll(/<rect[^>]*data-seg="[^"]*"[^>]*width="(\d+)"/g)].map((m) => Number(m[1]));
}

describe("renderSpectrumBadgeSvg", () => {
  it("has a well-formed root with xmlns, dimensions, role and title", () => {
    const svg = renderSpectrumBadgeSvg({ zones: zones(2, 1, 1), sourceCount: 4 });
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="320"');
    expect(svg).toContain('height="48"');
    expect(svg).toContain('viewBox="0 0 320 48"');
    expect(svg).toContain('role="img"');
    expect(svg).toContain("<title>Tayf yelpazesi: İktidar %50, Bağımsız %25, Muhalefet %25 · 4 kaynak</title>");
    expect(svg).toContain('aria-label="Tayf yelpazesi: İktidar %50, Bağımsız %25, Muhalefet %25 · 4 kaynak"');
    expect(svg).toContain(">Tayf</text>");
    expect(svg).toContain("4 kaynak · %50/%25/%25");
    for (const c of ["#0a0a0a", "#ef4444", "#a1a1aa", "#10b981"]) expect(svg).toContain(c);
  });

  it("segment widths sum to 176 even when rounding is awkward", () => {
    for (const z of [zones(1, 1, 1), zones(7, 3, 1), zones(0, 0, 5), zones(1, 0, 0), zones(13, 29, 3)]) {
      const w = barWidths(renderSpectrumBadgeSvg({ zones: z, sourceCount: 3 }));
      expect(w.length).toBe(3);
      expect(w.reduce((a, b) => a + b, 0)).toBe(176);
    }
  });

  it("zero voting total renders one grey bar and the empty label", () => {
    const svg = renderSpectrumBadgeSvg({ zones: zones(0, 0, 0), sourceCount: 0 });
    expect(svg).toContain("Tayf yelpazesi: sınıflandırılmış kaynak yok");
    expect(barWidths(svg)).toEqual([176]);
    expect(svg).not.toContain("#ef4444");
    expect(svg).not.toContain("#10b981");
  });

  // h44-consistency-1: the percents are over the classified sources only, so
  // a member count above the classified total is qualified, in the wording of
  // sourceCountHead (share text / RSS / Telegram).
  it("names the classified basis when only 8 of 9 members vote (prod b34a5fe0 cached copy: 1/4/3)", () => {
    const svg = renderSpectrumBadgeSvg({ zones: zones(1, 4, 3), sourceCount: 9 });
    const label = "Tayf yelpazesi: İktidar %13, Bağımsız %50, Muhalefet %37 · 9 kaynak (8 sınıflandırılmış)";
    expect(svg).toContain(`aria-label="${label}"`);
    expect(svg).toContain(`<title>${label}</title>`);
    expect(svg).toContain(">9 kaynak (8 sınıflandırılmış) · %13/%50/%37</text>");
  });

  it("is byte-identical to the old label and caption when every member is classified", () => {
    const svg = renderSpectrumBadgeSvg({ zones: zones(5, 2, 9), sourceCount: 16 });
    expect(svg).toContain('aria-label="Tayf yelpazesi: İktidar %31, Bağımsız %13, Muhalefet %56 · 16 kaynak"');
    expect(svg).toContain(">16 kaynak · %31/%13/%56</text>");
    expect(svg).not.toContain("sınıflandırılmış)");
  });

  it("keeps the bare count when a stale tally exceeds the member count", () => {
    const svg = renderSpectrumBadgeSvg({ zones: zones(2, 1, 1), sourceCount: 3 });
    expect(svg).toContain(">3 kaynak · %50/%25/%25</text>");
    expect(svg).not.toContain("sınıflandırılmış)");
  });

  it("leaves the empty badge's caption unchanged", () => {
    const svg = renderSpectrumBadgeSvg({ zones: zones(0, 0, 0), sourceCount: 2 });
    expect(svg).toContain("Tayf yelpazesi: sınıflandırılmış kaynak yok");
    expect(svg).toContain(">2 kaynak</text>");
    expect(svg).not.toContain("(0 sınıflandırılmış)");
  });

  it("uses the shared helper's wording (same string as the share text / RSS head)", async () => {
    const { sourceCountHead } = await import("@/lib/feeds/zone-line");
    const head = sourceCountHead(9, { iktidar: 1, bagimsiz: 4, muhalefet: 3 });
    const svg = renderSpectrumBadgeSvg({ zones: zones(1, 4, 3), sourceCount: 9 });
    expect(svg).toContain(`${head} · %13/%50/%37`);
  });

  it("never emits raw <script or an unescaped ampersand", () => {
    const svg = renderSpectrumBadgeSvg({ zones: zones(2, 1, 1), sourceCount: 4 });
    expect(svg).not.toContain("<script");
    expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("is deterministic", () => {
    const a = renderSpectrumBadgeSvg({ zones: zones(5, 2, 9), sourceCount: 16 });
    const b = renderSpectrumBadgeSvg({ zones: zones(5, 2, 9), sourceCount: 16 });
    expect(a).toBe(b);
  });
});
