import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ENGLISH_ONLY_SPECTRUM_LINE } from "@/lib/sources/source-language";

import {
  EMPTY_SPECTRUM_NON_VOTING,
  EMPTY_SPECTRUM_UNCLASSIFIED,
  ogSpectrumState,
} from "./og-spectrum";

// h64-ogcards-3. A cluster whose every source is a toplayıcı / niş source has
// an all-zero bias_distribution. The OG card drew an empty bar and three
// "%0 · 0" tiles for it while the page, the embed, the rozet and the share text
// all say "sınıflandırılmış kaynak yok". ogSpectrumState() decides which of the
// two the card shows; it is pure so the decision is testable without Satori.

const ZERO = { iktidar: 0, bagimsiz: 0, muhalefet: 0 } as const;

describe("the empty-spectrum lines", () => {
  it("pins the two Turkish lines", () => {
    expect(EMPTY_SPECTRUM_NON_VOTING).toBe(
      "Bu kümede sınıflandırılan kaynak yok — yalnızca toplayıcı / niş kaynaklar yazdı",
    );
    expect(EMPTY_SPECTRUM_UNCLASSIFIED).toBe("Bu kümede henüz sınıflandırılan kaynak yok");
  });

  it("keeps the non-voting line identical to the caption the cluster page prints (no second wording)", () => {
    const page = readFileSync(join(process.cwd(), "src/app/cluster/[id]/page.tsx"), "utf8");
    // Either the page still carries the literal, or it reads the shared constant.
    const sameWording =
      page.includes(EMPTY_SPECTRUM_NON_VOTING) || page.includes("EMPTY_SPECTRUM_NON_VOTING");
    expect(sameWording).toBe(true);
  });
});

describe("ogSpectrumState", () => {
  it("says the sources are toplayıcı / niş when the zones are empty and two non-voting sources wrote", () => {
    expect(ogSpectrumState({ ...ZERO }, 2)).toEqual({
      kind: "empty",
      line: EMPTY_SPECTRUM_NON_VOTING,
    });
  });

  it("says 'henüz' when the zones are empty and no non-voting source is known either", () => {
    expect(ogSpectrumState({ ...ZERO }, 0)).toEqual({
      kind: "empty",
      line: EMPTY_SPECTRUM_UNCLASSIFIED,
    });
  });

  it("shows the tiles when any zone has a source", () => {
    expect(ogSpectrumState({ iktidar: 7, bagimsiz: 0, muhalefet: 0 }, 0)).toEqual({ kind: "tiles" });
    expect(ogSpectrumState({ iktidar: 0, bagimsiz: 1, muhalefet: 0 }, 3)).toEqual({ kind: "tiles" });
    expect(ogSpectrumState({ iktidar: 0, bagimsiz: 0, muhalefet: 2 }, 0)).toEqual({ kind: "tiles" });
  });

  it("keeps the tiles at a total of exactly 1 (the smallest non-empty spectrum)", () => {
    expect(ogSpectrumState({ iktidar: 1, bagimsiz: 0, muhalefet: 0 }, 0)).toEqual({ kind: "tiles" });
  });

  it("never lets non-voting sources turn a non-empty spectrum into the empty box", () => {
    expect(ogSpectrumState({ iktidar: 4, bagimsiz: 2, muhalefet: 1 }, 9)).toEqual({ kind: "tiles" });
  });

  it("treats a non-positive or NaN non-voting count as none, and any positive count as some", () => {
    expect(ogSpectrumState({ ...ZERO }, -1)).toEqual({ kind: "empty", line: EMPTY_SPECTRUM_UNCLASSIFIED });
    expect(ogSpectrumState({ ...ZERO }, Number.NaN)).toEqual({ kind: "empty", line: EMPTY_SPECTRUM_UNCLASSIFIED });
    expect(ogSpectrumState({ ...ZERO }, 1)).toEqual({ kind: "empty", line: EMPTY_SPECTRUM_NON_VOTING });
  });

  it("does not mutate its input", () => {
    const zones = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
    ogSpectrumState(zones, 2);
    expect(zones).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 0 });
  });
});

// h118-shares-1: an all-English cluster has voting sources (3/0/0) yet the card
// printed "İktidar %100 · 3 / Bağımsız %0 · 0 / Muhalefet %0 · 0", the zone-absence
// claim its page and Manşet Kartı deliberately do not make. With languageIsolated
// the slot prints one line instead, ahead of every other branch.
describe("ogSpectrumState for a language-isolated (all-English) cluster (h118-shares-1)", () => {
  it("prints the English line instead of the tiles for 3/0/0 (92742df8)", () => {
    expect(ogSpectrumState({ iktidar: 3, bagimsiz: 0, muhalefet: 0 }, 0, true)).toEqual({
      kind: "empty",
      line: ENGLISH_ONLY_SPECTRUM_LINE,
    });
  });

  it("prints it for 2/0/0 too (2dab7e87), and for a spread-out tally", () => {
    expect(ogSpectrumState({ iktidar: 2, bagimsiz: 0, muhalefet: 0 }, 0, true)).toEqual({
      kind: "empty",
      line: ENGLISH_ONLY_SPECTRUM_LINE,
    });
    expect(ogSpectrumState({ iktidar: 1, bagimsiz: 1, muhalefet: 1 }, 0, true)).toEqual({
      kind: "empty",
      line: ENGLISH_ONLY_SPECTRUM_LINE,
    });
  });

  it("wins over the non-voting and the unclassified lines when nothing voted", () => {
    expect(ogSpectrumState({ ...ZERO }, 2, true)).toEqual({ kind: "empty", line: ENGLISH_ONLY_SPECTRUM_LINE });
    expect(ogSpectrumState({ ...ZERO }, 0, true)).toEqual({ kind: "empty", line: ENGLISH_ONLY_SPECTRUM_LINE });
  });

  it("keeps the tiles when the flag is omitted or false (every other cluster is unchanged)", () => {
    expect(ogSpectrumState({ iktidar: 3, bagimsiz: 0, muhalefet: 0 }, 0)).toEqual({ kind: "tiles" });
    expect(ogSpectrumState({ iktidar: 3, bagimsiz: 0, muhalefet: 0 }, 0, false)).toEqual({ kind: "tiles" });
    expect(ogSpectrumState({ ...ZERO }, 2, false)).toEqual({ kind: "empty", line: EMPTY_SPECTRUM_NON_VOTING });
    expect(ogSpectrumState({ ...ZERO }, 0, false)).toEqual({ kind: "empty", line: EMPTY_SPECTRUM_UNCLASSIFIED });
  });
});
