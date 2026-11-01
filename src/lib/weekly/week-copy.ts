import { formatCountTr } from "@/lib/format/number-tr";

// Reader-facing copy for the weekly sections (/hafta and /hafta/<week>).
//
// Three variants (WeekCopyVariant):
//   rolling  /hafta, a trailing 7-day window. It is not a calendar week, so it
//            says "son 7 gün", never "bu hafta" (h15-tz-1: /hafta and
//            /hafta/<current ISO week> both said "Bu hafta" with different
//            totals).
//   live     /hafta/<current ISO week>, still in progress ("Bu hafta ...").
//   closed   /hafta/<finished week> ("O hafta ...").
//
// Why this is one pure module: a closed week has no live source health. The
// per-zone "kaynak haber verdi" counts and the 72 h basis footnote describe
// the present, so on an archived week they were either empty ("payda
// bilinmiyor") or a present-tense claim about a week that is over, and the
// footnote leaked internal terms (payda, veto) to readers. Closed weeks
// therefore drop those lines entirely and read like a finished record
// ("O hafta ..."), while the live wording stays exactly what the in-progress
// week has always shown. Keeping every string here, behind one variant, lets
// tests/guards/week-archive-copy.test.ts forbid stray literals in the
// components, and week-copy.test.ts sweep the closed wording for jargon.

/** Which wording a weekly page uses: see the header above. */
export type WeekCopyVariant = "rolling" | "live" | "closed";

export interface WeekCopy {
  /** `<h2>` of the per-zone share section. */
  zoneHeading: string;
  /** Empty state of "En geniş yelpaze". */
  noSharedStory: string;
  /** Empty state of "Kör noktalar". */
  noBlindspot: string;
  /** Whole-page empty state (no clusters in the window). */
  empty: string;
  /** Whole-page failure state (the cluster read failed). */
  unavailable: string;
  /** Page-level note under the hero (archive page only). */
  note: string;
  /** What the zone percentages are divided by. */
  percentBasis(total: number): string;
  /**
   * What the per-zone source counts measure; `null` when the page does not
   * show them (closed weeks).
   */
  sourceBasis(feedStatus: { delivering: number; total: number } | null): string | null;
  /** Caveat shown when a zone's feeds are degraded; `null` for closed weeks. */
  degradedCaveat: string | null;
  /** Whether the per-zone "N kaynak haber verdi" span is rendered. */
  showSourceCounts: boolean;
  /** Whether the link to the live source-status page is rendered. */
  showStatusLink: boolean;
  /** Text of the archive nav link back to the rolling weekly page. */
  latestLinkText: string;
  /** Empty state of "Etiket değişiklikleri" (no source changed its label). */
  labelUnchanged: string;
  /** Per-zone-row suffix naming the total the row's share is part of. */
  zoneRowTotal(total: number): string;
}

const UNAVAILABLE =
  "Haftanın özeti şu anda hesaplanamıyor. Birkaç dakika içinde tekrar deneyin.";
const LATEST_LINK_TEXT = "Güncel haftalık özet";

// Shared by every variant: sourceBasis describes the last 72 h of source
// health, which is the same fact whatever window the page covers.
const LIVE_SOURCE_BASIS: WeekCopy["sourceBasis"] = (feedStatus) => {
  const known = feedStatus !== null && feedStatus.total > 0;
  return `Bölge satırlarındaki kaynak sayıları son 72 saatte en az bir haber veren tüm kaynakları (toplayıcı / niş dahil) gösterir${
    known
      ? `; spektruma sayılan kaynaklardan ${feedStatus.delivering} / ${feedStatus.total} tanesi haber verdi.`
      : "; spektruma sayılan kaynakların durumu şu anda bilinmiyor."
  }`;
};

const ROLLING: WeekCopy = Object.freeze<WeekCopy>({
  zoneHeading: "Son 7 günde kim neyi öne çıkardı",
  noSharedStory: "Son 7 günde birden fazla bölgenin birlikte gördüğü haber olmadı.",
  noBlindspot: "Son 7 günde kör nokta yok.",
  empty: "Son 7 günde yeterli küme oluşmadı.",
  unavailable: UNAVAILABLE,
  note: "Son 7 günün özeti; sayılar yeni haberlerle değişir.",
  percentBasis: (total) =>
    `Yüzdeler son 7 günün toplam ${formatCountTr(total)} haberi üzerinden hesaplanır.`,
  sourceBasis: LIVE_SOURCE_BASIS,
  degradedCaveat:
    "Bazı bölgelerde kaynaklara ulaşılamıyor; son 7 günün kör nokta listesi eksik olabilir.",
  showSourceCounts: true,
  showStatusLink: true,
  latestLinkText: LATEST_LINK_TEXT,
  labelUnchanged: "Son 7 günde etiket değişmedi.",
  zoneRowTotal: (total) => `(son 7 günün ${formatCountTr(total)} haberi içinde)`,
});

const LIVE: WeekCopy = Object.freeze<WeekCopy>({
  zoneHeading: "Bu hafta kim neyi öne çıkardı",
  noSharedStory: "Bu hafta birden fazla bölgenin birlikte gördüğü haber olmadı.",
  noBlindspot: "Bu hafta kör nokta yok.",
  empty: "Bu hafta yeterli küme oluşmadı.",
  unavailable: UNAVAILABLE,
  note: "Bu hafta sürüyor; sayılar hafta bitene kadar değişir.",
  percentBasis: (total) =>
    `Yüzdeler bu haftanın toplam ${formatCountTr(total)} haberi üzerinden hesaplanır.`,
  // Two bases, stated explicitly (browser-qa-15): the rows count every source
  // that delivered in the last 72 h (toplayıcı / niş dahil), the spektruma
  // sayılan figure counts voting sources only.
  sourceBasis: LIVE_SOURCE_BASIS,
  degradedCaveat:
    "Bazı bölgelerde kaynaklara ulaşılamıyor; bu haftanın kör nokta listesi eksik olabilir.",
  showSourceCounts: true,
  showStatusLink: true,
  latestLinkText: LATEST_LINK_TEXT,
  labelUnchanged: "Bu hafta etiket değişmedi.",
  zoneRowTotal: (total) => `(haftanın ${formatCountTr(total)} haberi içinde)`,
});

const CLOSED: WeekCopy = Object.freeze<WeekCopy>({
  zoneHeading: "O hafta kim neyi öne çıkardı",
  noSharedStory: "O hafta birden fazla bölgenin birlikte gördüğü haber olmadı.",
  noBlindspot: "O hafta kör nokta çıkmadı.",
  empty: "O hafta yeterli küme oluşmadı.",
  unavailable: UNAVAILABLE,
  note: "Kör noktalar o hafta işaretlenen haberlerdir; sonradan geri alınan işaretler listede yer almaz.",
  percentBasis: (total) =>
    `Yüzdeler o haftanın toplam ${formatCountTr(total)} haberi üzerinden hesaplanır.`,
  sourceBasis: () => null,
  degradedCaveat: null,
  showSourceCounts: false,
  showStatusLink: false,
  latestLinkText: LATEST_LINK_TEXT,
  labelUnchanged: "O hafta etiket değişmedi.",
  zoneRowTotal: (total) => `(haftanın ${formatCountTr(total)} haberi içinde)`,
});

const BY_VARIANT: Readonly<Record<WeekCopyVariant, WeekCopy>> = Object.freeze({
  rolling: ROLLING,
  live: LIVE,
  closed: CLOSED,
});

/** The frozen copy for one variant: see the header for who uses which. */
export function weekCopyFor(variant: WeekCopyVariant): WeekCopy {
  return BY_VARIANT[variant];
}

/**
 * `closed` is true for a finished week; false for the in-progress ISO week.
 * Kept for /hafta/[hafta] (weekCopy(!isCurrentWeek)); /hafta, the rolling
 * window, asks for weekCopyFor("rolling") instead.
 */
export function weekCopy(closed: boolean): WeekCopy {
  return weekCopyFor(closed ? "closed" : "live");
}
