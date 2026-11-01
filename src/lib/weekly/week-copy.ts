import { formatCountTr } from "@/lib/format/number-tr";

// Reader-facing copy for the weekly sections (/hafta and /hafta/<week>).
//
// Why this is one pure module: a closed week has no live source health. The
// per-zone "kaynak haber verdi" counts and the 72 h basis footnote describe
// the present, so on an archived week they were either empty ("payda
// bilinmiyor") or a present-tense claim about a week that is over, and the
// footnote leaked internal terms (payda, veto) to readers. Closed weeks
// therefore drop those lines entirely and read like a finished record
// ("O hafta ..."), while the live wording stays exactly what /hafta has
// always shown. Keeping every string here, behind one flag, lets
// tests/guards/week-archive-copy.test.ts forbid stray literals in the
// components, and week-copy.test.ts sweep the closed wording for jargon.

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
}

const UNAVAILABLE =
  "Haftanın özeti şu anda hesaplanamıyor. Birkaç dakika içinde tekrar deneyin.";
const LATEST_LINK_TEXT = "Güncel haftalık özet";

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
  sourceBasis: (feedStatus) => {
    const known = feedStatus !== null && feedStatus.total > 0;
    return `Bölge satırlarındaki kaynak sayıları son 72 saatte en az bir haber veren tüm kaynakları (toplayıcı / niş dahil) gösterir${
      known
        ? `; spektruma sayılan kaynaklardan ${feedStatus.delivering} / ${feedStatus.total} tanesi haber verdi.`
        : "; spektruma sayılan kaynakların durumu şu anda bilinmiyor."
    }`;
  },
  degradedCaveat:
    "Bazı bölgelerde kaynaklara ulaşılamıyor; bu haftanın kör nokta listesi eksik olabilir.",
  showSourceCounts: true,
  showStatusLink: true,
  latestLinkText: LATEST_LINK_TEXT,
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
});

/** `closed` is true for a finished week; false for the current / rolling one. */
export function weekCopy(closed: boolean): WeekCopy {
  return closed ? CLOSED : LIVE;
}
