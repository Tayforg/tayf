import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// House pattern (see silence-digest-band.test.tsx): the card has no hooks, so
// renderToStaticMarkup needs no mocking.
import { SavedMixCard } from "./saved-mix-card";

type Row = { bias_distribution: unknown };

const OK_ROWS: Row[] = [
  { bias_distribution: { pro_government: 2 } },
  { bias_distribution: { center: 1, opposition: 1 } },
  { bias_distribution: { opposition: 3 } },
];

// {2,1,4} of 7 -> 29 / 14 / 57 (largest remainder), total 7.
const SCORED_ROWS: Row[] = [
  { bias_distribution: { pro_government: 3 } },
  { bias_distribution: { center: 3 } },
  { bias_distribution: {} },
];

function html(rows: Row[]): string {
  return renderToStaticMarkup(<SavedMixCard rows={rows} />);
}

describe("SavedMixCard hint states", () => {
  it("renders the exact hint for 2 rows", () => {
    expect(html(OK_ROWS.slice(0, 2))).toBe(
      '<p class="mb-3 text-xs text-muted-foreground">En az 3 hikâye kaydedince okuma diyetin burada görünür.</p>',
    );
  });

  it("renders the hint for 0 rows", () => {
    expect(html([])).toContain("En az 3 hikâye kaydedince okuma diyetin burada görünür.");
  });

  it("renders the no-votes message for 3 rows without classified sources", () => {
    const out = html([{ bias_distribution: {} }, { bias_distribution: null }, { bias_distribution: "x" }]);
    expect(out).toBe(
      '<p class="mb-3 text-xs text-muted-foreground">Kaydettiğin hikâyelerde henüz sınıflandırılmış kaynak yok; okuma diyetin hesaplanamıyor.</p>',
    );
  });
});

describe("SavedMixCard ok state", () => {
  const out = html(OK_ROWS);

  it("renders the labelled section and heading", () => {
    expect(out).toContain('aria-labelledby="okuma-diyetin"');
    expect(out).toContain('<h2 id="okuma-diyetin" class="font-serif text-sm font-semibold">Okuma diyetin</h2>');
  });

  it("renders the subtitle with the story and source numbers", () => {
    expect(out).toContain("Kaydettiğin 3 hikâyeyi yazan 7 sınıflandırılmış kaynağın dağılımı");
  });

  it("renders the legend with all three zones in spectrum order", () => {
    expect(out).toContain("İktidar %29 · Bağımsız %14 · Muhalefet %57");
  });

  it("carries all three percents in the bar's aria-label", () => {
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="İktidar %29, Bağımsız %14, Muhalefet %57"');
  });

  it("draws one proportional segment per non-zero zone with the zone dot classes", () => {
    expect(out).toContain("bg-red-500");
    expect(out).toContain("bg-zinc-400");
    expect(out).toContain("bg-emerald-500");
    expect(out).toMatch(/width:\s*28\.57\d*%/);
    expect(out).toMatch(/width:\s*14\.28\d*%/);
    expect(out).toMatch(/width:\s*57\.14\d*%/);
  });

  it("omits zero-count segments from the bar but keeps them in the legend", () => {
    const two = html([{ bias_distribution: { pro_government: 2 } }, { bias_distribution: { opposition: 2 } }, { bias_distribution: {} }]);
    expect(two).not.toContain("bg-zinc-400");
    expect(two).toContain("İktidar %50 · Bağımsız %0 · Muhalefet %50");
  });

  it("renders the privacy footer", () => {
    expect(out).toContain("Bu özet yalnızca bu cihazda hesaplanır; hiçbir yere gönderilmez.");
  });

  it("omits the balance line when fewer than 5 classified sources voted", () => {
    const four = html([
      { bias_distribution: { pro_government: 2 } },
      { bias_distribution: { center: 1 } },
      { bias_distribution: { opposition: 1 } },
    ]);
    expect(four).toContain("Kaydettiğin 3 hikâyeyi yazan 4 sınıflandırılmış kaynağın dağılımı");
    expect(four).not.toContain("Denge puanı");
  });

  it("renders the balance line with score, label and the methodology link", () => {
    const scored = html(SCORED_ROWS);
    expect(out).toContain("Denge puanı");
    expect(scored).toContain("Denge puanı 63/100");
    expect(scored).toContain("Tek tarafa yakın");
    expect(scored).toContain('href="/metodoloji#denge-puani"');
    expect(scored).toContain("Denge puanı nedir?");
  });

  it("keeps copy neutral (no advice)", () => {
    expect(out).not.toMatch(/daha fazla/i);
    expect(out).not.toMatch(/\boku\b/i);
  });
});

describe("SavedMixCard contrast rules", () => {
  it.each([
    ["too-few", OK_ROWS.slice(0, 1)],
    ["no-votes", [{ bias_distribution: {} }, { bias_distribution: {} }, { bias_distribution: {} }]],
    ["ok", OK_ROWS],
    ["ok with balance", SCORED_ROWS],
  ] as const)("%s markup has no opacity-* and no alpha muted text", (_name, input) => {
    const out = html([...input]);
    expect(out).not.toContain("opacity-");
    expect(out).not.toContain("text-muted-foreground/");
  });
});
