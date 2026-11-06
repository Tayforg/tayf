import { describe, it, expect } from "vitest";

import { blindspotTallyLine, weekCopy, weekCopyFor, type WeekCopy } from "./week-copy";

// Reader-facing copy for the weekly sections. `weekCopy(false)` is the live
// wording of the in-progress ISO week (/hafta/<current week>) and must stay
// equal to the literals the pages shipped with; `weekCopy(true)` is the
// closed-week wording, which must read like a finished record: no present
// tense, no developer terms, no live source health. `weekCopyFor("rolling")`
// is /hafta, a trailing 7-day window that is not a calendar week, so it must
// never say "bu hafta" / "o hafta" (h15-tz-1).

const KNOWN = { delivering: 72, total: 113 };

const DEGRADED_CAVEAT_TODAY =
  "Bazı bölgelerde kaynaklara ulaşılamıyor; bu haftanın kör nokta listesi eksik olabilir.";

/** Every reader-visible string a copy object can produce. */
function allStrings(copy: WeekCopy): string[] {
  const out: string[] = [];
  const push = (v: string | null) => {
    if (v !== null) out.push(v);
  };
  push(copy.zoneHeading);
  push(copy.noSharedStory);
  push(copy.noBlindspot);
  push(copy.empty);
  push(copy.unavailable);
  push(copy.note);
  push(copy.percentBasis(3005));
  push(copy.sourceBasis(null));
  push(copy.sourceBasis(KNOWN));
  push(copy.sourceBasis({ delivering: 0, total: 0 }));
  push(copy.degradedCaveat);
  push(copy.latestLinkText);
  push(copy.labelUnchanged);
  push(copy.zoneRowTotal(1234));
  return out;
}

describe("weekCopy(false) — live wording is unchanged", () => {
  const live = weekCopy(false);

  it("keeps today's headings and empty states", () => {
    expect(live.zoneHeading).toBe("Bu hafta kim neyi öne çıkardı");
    expect(live.noSharedStory).toBe(
      "Bu hafta birden fazla bölgenin birlikte gördüğü haber olmadı.",
    );
    expect(live.noBlindspot).toBe("Bu hafta kör nokta yok.");
    expect(live.empty).toBe("Bu hafta yeterli küme oluşmadı.");
    expect(live.unavailable).toBe(
      "Haftanın özeti şu anda hesaplanamıyor. Birkaç dakika içinde tekrar deneyin.",
    );
    expect(live.note).toBe("Bu hafta sürüyor; sayılar hafta bitene kadar değişir.");
  });

  it("states the percent basis as source records of multi-source clusters, grouped the Turkish way", () => {
    expect(live.percentBasis(3005)).toBe(
      "Yüzdeler bu haftanın çok kaynaklı kümelerindeki 3.005 kaynak kaydı üzerinden hesaplanır.",
    );
    expect(live.percentBasis(10)).toBe(
      "Yüzdeler bu haftanın çok kaynaklı kümelerindeki 10 kaynak kaydı üzerinden hesaplanır.",
    );
  });

  it("keeps the 72 h source-count basis with the known clause", () => {
    expect(live.sourceBasis(KNOWN)).toBe(
      "Bölge satırlarındaki kaynak sayıları son 72 saatte en az bir haber veren tüm kaynakları (toplayıcı / niş dahil) gösterir; spektruma sayılan kaynaklardan 72 / 113 tanesi haber verdi.",
    );
  });

  it("keeps the unknown clause when the feed status is null or empty", () => {
    const unknown =
      "Bölge satırlarındaki kaynak sayıları son 72 saatte en az bir haber veren tüm kaynakları (toplayıcı / niş dahil) gösterir; spektruma sayılan kaynakların durumu şu anda bilinmiyor.";
    expect(live.sourceBasis(null)).toBe(unknown);
    expect(live.sourceBasis({ delivering: 0, total: 0 })).toBe(unknown);
  });

  it("keeps today's degraded caveat and the live-only affordances", () => {
    expect(live.degradedCaveat).toBe(DEGRADED_CAVEAT_TODAY);
    expect(live.showSourceCounts).toBe(true);
    expect(live.showStatusLink).toBe(true);
  });

  it("names the current-summary link in reader language", () => {
    expect(live.latestLinkText).toBe("Güncel haftalık özet");
  });

  it("says 'Bu hafta etiket değişmedi.' and counts the row total in source records", () => {
    expect(live.labelUnchanged).toBe("Bu hafta etiket değişmedi.");
    expect(live.zoneRowTotal(10)).toBe("(haftanın 10 kaynak kaydı içinde)");
    expect(live.zoneRowTotal(1234)).toBe("(haftanın 1.234 kaynak kaydı içinde)");
  });
});

describe("weekCopy(true) — closed week reads as a finished record", () => {
  const closed = weekCopy(true);

  it("switches the week reference from 'bu' to 'o'", () => {
    expect(closed.zoneHeading).toBe("O hafta kim neyi öne çıkardı");
    expect(closed.noSharedStory).toBe(
      "O hafta birden fazla bölgenin birlikte gördüğü haber olmadı.",
    );
    expect(closed.noBlindspot).toBe("O hafta kör nokta çıkmadı.");
    expect(closed.empty).toBe("O hafta yeterli küme oluşmadı.");
    expect(closed.percentBasis(3005)).toBe(
      "Yüzdeler o haftanın çok kaynaklı kümelerindeki 3.005 kaynak kaydı üzerinden hesaplanır.",
    );
  });

  it("explains blindspots in reader language", () => {
    expect(closed.note).toBe(
      "Kör noktalar o hafta işaretlenen haberlerdir; sonradan geri alınan işaretler listede yer almaz.",
    );
  });

  it("shares the unavailable line with live weeks", () => {
    expect(closed.unavailable).toBe(weekCopy(false).unavailable);
  });

  it("drops everything that describes live source health", () => {
    expect(closed.sourceBasis(KNOWN)).toBeNull();
    expect(closed.sourceBasis(null)).toBeNull();
    expect(closed.degradedCaveat).toBeNull();
    expect(closed.showSourceCounts).toBe(false);
    expect(closed.showStatusLink).toBe(false);
  });

  it("uses the same neutral link text as live weeks", () => {
    expect(closed.latestLinkText).toBe("Güncel haftalık özet");
  });

  it("says 'O hafta etiket değişmedi.' and counts the row total in source records", () => {
    expect(closed.labelUnchanged).toBe("O hafta etiket değişmedi.");
    expect(closed.zoneRowTotal(10)).toBe("(haftanın 10 kaynak kaydı içinde)");
    expect(closed.zoneRowTotal(1234)).toBe("(haftanın 1.234 kaynak kaydı içinde)");
  });

  it("contains no developer jargon, present tense or live-health term in any string", () => {
    const banned = [
      "payda",
      "veto",
      "72 saat",
      "bu hafta",
      "şu anda bilinmiyor",
      "sürüyor",
      "/kaynaklar/durum",
    ];
    const strings = allStrings(closed);
    // Non-vacuous: every text field plus percentBasis is reachable.
    expect(strings.length).toBeGreaterThanOrEqual(8);
    for (const s of strings) {
      const lower = s.toLocaleLowerCase("tr-TR");
      for (const term of banned) {
        expect(lower, `"${s}" must not contain "${term}"`).not.toContain(term);
      }
    }
  });

  it("the ban list is not vacuous: the live wording does use those terms", () => {
    const live = allStrings(weekCopy(false)).join(" ").toLocaleLowerCase("tr-TR");
    for (const term of ["72 saat", "bu hafta", "şu anda bilinmiyor", "sürüyor"]) {
      expect(live).toContain(term);
    }
  });
});

describe('weekCopyFor("rolling") — /hafta is a trailing 7-day window', () => {
  const rolling = weekCopyFor("rolling");

  it("names the window in days, never the calendar week", () => {
    expect(rolling.zoneHeading).toBe("Son 7 günde kim neyi öne çıkardı");
    expect(rolling.empty).toBe("Son 7 günde yeterli küme oluşmadı.");
    expect(rolling.labelUnchanged).toBe("Son 7 günde etiket değişmedi.");
    expect(rolling.noSharedStory).toBe(
      "Son 7 günde birden fazla bölgenin birlikte gördüğü haber olmadı.",
    );
    expect(rolling.noBlindspot).toBe("Son 7 günde kör nokta yok.");
    expect(rolling.note).toBe("Son 7 günün özeti; sayılar yeni haberlerle değişir.");
  });

  it("states the percent basis over the last seven days, grouped the Turkish way", () => {
    expect(rolling.percentBasis(6989)).toBe(
      "Yüzdeler son 7 günün çok kaynaklı kümelerindeki 6.989 kaynak kaydı üzerinden hesaplanır.",
    );
    expect(rolling.percentBasis(10)).toBe(
      "Yüzdeler son 7 günün çok kaynaklı kümelerindeki 10 kaynak kaydı üzerinden hesaplanır.",
    );
  });

  it("prints the per-zone total against the last seven days", () => {
    expect(rolling.zoneRowTotal(1234)).toBe("(son 7 günün 1.234 kaynak kaydı içinde)");
    expect(rolling.zoneRowTotal(10)).toBe("(son 7 günün 10 kaynak kaydı içinde)");
  });

  it("keeps the degraded caveat, but about the last seven days", () => {
    expect(rolling.degradedCaveat).toBe(
      "Bazı bölgelerde kaynaklara ulaşılamıyor; son 7 günün kör nokta listesi eksik olabilir.",
    );
  });

  it("keeps the live source-health affordances of /hafta", () => {
    const live = weekCopy(false);
    expect(rolling.showSourceCounts).toBe(true);
    expect(rolling.showStatusLink).toBe(true);
    expect(rolling.latestLinkText).toBe("Güncel haftalık özet");
    expect(rolling.unavailable).toBe(live.unavailable);
    expect(rolling.sourceBasis(KNOWN)).toBe(live.sourceBasis(KNOWN));
    expect(rolling.sourceBasis(null)).toBe(live.sourceBasis(null));
    expect(rolling.sourceBasis({ delivering: 0, total: 0 })).toBe(
      live.sourceBasis({ delivering: 0, total: 0 }),
    );
  });

  it("contains no 'bu hafta' or 'o hafta' in any string", () => {
    const strings = allStrings(rolling);
    // Non-vacuous: every text field plus percentBasis / zoneRowTotal is reachable.
    expect(strings.length).toBeGreaterThanOrEqual(10);
    for (const s of strings) {
      const lower = s.toLocaleLowerCase("tr-TR");
      for (const term of ["bu hafta", "o hafta"]) {
        expect(lower, `"${s}" must not contain "${term}"`).not.toContain(term);
      }
    }
  });

  it("formats non-finite totals as 0 instead of NaN", () => {
    expect(rolling.percentBasis(Number.NaN)).toBe(
      "Yüzdeler son 7 günün çok kaynaklı kümelerindeki 0 kaynak kaydı üzerinden hesaplanır.",
    );
    expect(rolling.zoneRowTotal(Number.NaN)).toBe("(son 7 günün 0 kaynak kaydı içinde)");
  });
});

describe("count labels say what they count (h18-numbers-1)", () => {
  // The /hafta percentages are taken over the voting-source entries of the
  // multi-source clusters: source records, not articles and not a grand total.
  it.each(["rolling", "live", "closed"] as const)(
    "%s: percentBasis and zoneRowTotal call the unit 'kaynak kaydı' and never 'toplam' or 'haberi'",
    (variant) => {
      const copy = weekCopyFor(variant);
      for (const s of [copy.percentBasis(6973), copy.zoneRowTotal(6973)]) {
        expect(s).toContain("6.973");
        expect(s).toContain("kaynak kaydı");
        expect(s).not.toContain("toplam");
        expect(s).not.toContain("haberi");
      }
    },
  );
});

describe("weekCopyFor dispatch", () => {
  it("'live' and 'closed' are the very objects weekCopy(false) / weekCopy(true) return", () => {
    expect(weekCopyFor("live")).toBe(weekCopy(false));
    expect(weekCopyFor("closed")).toBe(weekCopy(true));
  });

  it("'rolling' is a third, distinct set of wording", () => {
    expect(weekCopyFor("rolling")).not.toBe(weekCopy(false));
    expect(weekCopyFor("rolling")).not.toBe(weekCopy(true));
    expect(weekCopyFor("rolling")).toBe(weekCopyFor("rolling"));
  });

  it("returns frozen objects so no caller can edit shared copy", () => {
    for (const v of ["rolling", "live", "closed"] as const) {
      expect(Object.isFrozen(weekCopyFor(v)), v).toBe(true);
    }
  });
});

describe("weekCopy shape", () => {
  const SHAPE = [
    "degradedCaveat",
    "empty",
    "labelUnchanged",
    "latestLinkText",
    "noBlindspot",
    "noSharedStory",
    "note",
    "percentBasis",
    "showSourceCounts",
    "showStatusLink",
    "sourceBasis",
    "unavailable",
    "zoneHeading",
    "zoneRowTotal",
  ].sort();

  it("exposes exactly the documented fields on every variant (a new field must be added to allStrings and the jargon sweep above)", () => {
    for (const v of ["rolling", "live", "closed"] as const) {
      expect(Object.keys(weekCopyFor(v)).sort(), v).toEqual(SHAPE);
    }
  });

  it("is pure: repeated calls return equal copy and do not share mutable state", () => {
    expect(allStrings(weekCopy(true))).toEqual(allStrings(weekCopy(true)));
    expect(allStrings(weekCopy(false))).toEqual(allStrings(weekCopy(false)));
    expect(allStrings(weekCopyFor("rolling"))).toEqual(
      allStrings(weekCopyFor("rolling")),
    );
  });

  it("formats non-finite totals as 0 instead of NaN", () => {
    expect(weekCopy(false).percentBasis(Number.NaN)).toBe(
      "Yüzdeler bu haftanın çok kaynaklı kümelerindeki 0 kaynak kaydı üzerinden hesaplanır.",
    );
  });
});

// h52-weekly-2: the blindspot list shows the biggest claims of each side, not
// the five biggest overall, and the line under the heading says so. It is the
// same line on every variant (/hafta, the live week, a closed week), so it is
// a standalone function and not a WeekCopy field, and it names no time at all.
describe("blindspotTallyLine", () => {
  it("states the total, the İktidar and Muhalefet tallies and how the rows were chosen", () => {
    expect(blindspotTallyLine({ iktidar: 37, muhalefet: 9, bagimsiz: 0 })).toBe(
      "Toplam 46 kör nokta · İktidar tarafında 37 · Muhalefet tarafında 9. Her taraftan en büyükleri gösteriliyor.",
    );
  });

  it("returns null when there is no blindspot at all", () => {
    expect(blindspotTallyLine({ iktidar: 0, muhalefet: 0, bagimsiz: 0 })).toBeNull();
  });

  it("adds the Bağımsız segment only when it is above zero", () => {
    expect(blindspotTallyLine({ iktidar: 5, muhalefet: 2, bagimsiz: 3 })).toBe(
      "Toplam 10 kör nokta · İktidar tarafında 5 · Muhalefet tarafında 2 · Bağımsız tarafında 3. Her taraftan en büyükleri gösteriliyor.",
    );
    expect(blindspotTallyLine({ iktidar: 5, muhalefet: 2, bagimsiz: 0 })).not.toContain("Bağımsız");
  });

  it("still prints a zero side, so 'Muhalefet tarafında 0' is stated, not hidden", () => {
    expect(blindspotTallyLine({ iktidar: 4, muhalefet: 0, bagimsiz: 0 })).toBe(
      "Toplam 4 kör nokta · İktidar tarafında 4 · Muhalefet tarafında 0. Her taraftan en büyükleri gösteriliyor.",
    );
  });

  it("prints a Muhalefet-only week", () => {
    expect(blindspotTallyLine({ iktidar: 0, muhalefet: 3, bagimsiz: 0 })).toBe(
      "Toplam 3 kör nokta · İktidar tarafında 0 · Muhalefet tarafında 3. Her taraftan en büyükleri gösteriliyor.",
    );
  });

  it("a Bağımsız-only week still prints, with the Bağımsız segment", () => {
    expect(blindspotTallyLine({ iktidar: 0, muhalefet: 0, bagimsiz: 2 })).toBe(
      "Toplam 2 kör nokta · İktidar tarafında 0 · Muhalefet tarafında 0 · Bağımsız tarafında 2. Her taraftan en büyükleri gösteriliyor.",
    );
  });

  it("groups thousands the Turkish way", () => {
    expect(blindspotTallyLine({ iktidar: 1234, muhalefet: 1000, bagimsiz: 0 })).toBe(
      "Toplam 2.234 kör nokta · İktidar tarafında 1.234 · Muhalefet tarafında 1.000. Her taraftan en büyükleri gösteriliyor.",
    );
  });

  it("formats non-finite counts as 0 instead of NaN, and returns null when nothing is left", () => {
    expect(blindspotTallyLine({ iktidar: Number.NaN, muhalefet: 2, bagimsiz: 0 })).toBe(
      "Toplam 2 kör nokta · İktidar tarafında 0 · Muhalefet tarafında 2. Her taraftan en büyükleri gösteriliyor.",
    );
    expect(blindspotTallyLine({ iktidar: Number.NaN, muhalefet: Number.NaN, bagimsiz: 0 })).toBeNull();
  });

  it("names no time: not 'bu hafta', not 'o hafta', not 'son 7 gün', not a 'haftanın' (it prints on every variant)", () => {
    const line = blindspotTallyLine({ iktidar: 37, muhalefet: 9, bagimsiz: 4 })!.toLocaleLowerCase("tr-TR");

    for (const term of ["bu hafta", "o hafta", "son 7", "haftanın", "hafta", "gün", "şu anda", "bugün"]) {
      expect(line, term).not.toContain(term);
    }
  });

  it("carries none of the closed-week jargon either", () => {
    const line = blindspotTallyLine({ iktidar: 37, muhalefet: 9, bagimsiz: 4 })!.toLocaleLowerCase("tr-TR");

    for (const term of ["payda", "veto", "72 saat", "sürüyor", "/kaynaklar/durum"]) {
      expect(line, term).not.toContain(term);
    }
  });
});
