import { describe, it, expect } from "vitest";

import { weekCopy, type WeekCopy } from "./week-copy";

// Reader-facing copy for the weekly sections. `weekCopy(false)` is the live
// (/hafta and the in-progress /hafta/<week>) wording and must stay equal to
// the literals the pages shipped with; `weekCopy(true)` is the closed-week
// wording, which must read like a finished record: no present tense, no
// developer terms, no live source health.

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

  it("keeps the percent basis sentence, grouped the Turkish way", () => {
    expect(live.percentBasis(3005)).toBe(
      "Yüzdeler bu haftanın toplam 3.005 haberi üzerinden hesaplanır.",
    );
    expect(live.percentBasis(10)).toBe(
      "Yüzdeler bu haftanın toplam 10 haberi üzerinden hesaplanır.",
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
      "Yüzdeler o haftanın toplam 3.005 haberi üzerinden hesaplanır.",
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

describe("weekCopy shape", () => {
  it("exposes exactly the documented fields (a new field must be added to the jargon sweep above)", () => {
    expect(Object.keys(weekCopy(true)).sort()).toEqual(
      [
        "degradedCaveat",
        "empty",
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
      ].sort(),
    );
  });

  it("is pure: repeated calls return equal copy and do not share mutable state", () => {
    expect(allStrings(weekCopy(true))).toEqual(allStrings(weekCopy(true)));
    expect(allStrings(weekCopy(false))).toEqual(allStrings(weekCopy(false)));
  });

  it("formats non-finite totals as 0 instead of NaN", () => {
    expect(weekCopy(false).percentBasis(Number.NaN)).toBe(
      "Yüzdeler bu haftanın toplam 0 haberi üzerinden hesaplanır.",
    );
  });
});
