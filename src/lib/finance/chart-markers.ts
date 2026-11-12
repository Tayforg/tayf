// Which KAP notices are drawn on a company's intraday chart.
//
// h144-ekonomi-3: /ekonomi/GLRMK's chart caption listed "KAP: SPK İşlem Yasağı Nedeniyle Pay Duyurusu", MKK's
// list of 100 shares under a trading ban: it names GLRMK, it is not news about the company. The page built a
// marker from every disclosure of the session day, while its KAP list (and h108's rules) already tell a
// company's own filing from a notice that only names the share. A chart marker is a claim that something
// happened to THIS company, so only its own filings count. One exception: Borsa Istanbul's trading halt of a
// single share ("Pay İşlem Sırası Kapatma / Açma"). It has no filer (the share is only in related_stocks) but it
// is a claim about that one company, and on a 5-minute chart it explains why trading starts mid-session
// (ANELE, 2026-06-15: closed 09:35, reopened 12:38), so it is drawn when the share is the notice's only code
// (h145 review TS-4).
//
// Pure: no I/O, no clock (the Istanbul-day function is passed in, like the page does with format.ts's istToday).

/** The columns of queries.ts's Disclosure the rule reads. */
export interface ChartMarkerDisclosure {
  publishedAt: string;
  subject: string | null;
  /** `stock_codes` as KAP wrote it: the filer(s). Empty for a notice tagged only in related_stocks (MKK, Takasbank, SPK lists). */
  filerCodes: readonly string[];
  /** The chips: the filers, the rated company of an agency's notice, or (when stock_codes is empty) the related shares. */
  stockCodes: readonly string[];
  /** A rating agency filed this for a company it rated: `filerCodes` is the agency, `stockCodes` the rated company. */
  agencyFiled: boolean;
}

export interface KapChartMarker {
  ts: string;
  label: string;
}

/**
 * The notice is about this company: it filed it (`filerCodes`), an agency rated it (`agencyFiled` and the
 * rated company in `stockCodes`), or Borsa Istanbul halted or reopened this share alone (no filer, the ticker
 * the only code, and the subject holds "işlem sırası", the test latestTradingHalt in queries.ts uses).
 * A notice that only names the share (stock_codes empty, or another filer's insider-trade or list notice, or
 * a halt notice that names several shares) is not.
 */
function isAboutTicker(d: ChartMarkerDisclosure, ticker: string): boolean {
  if (d.filerCodes.includes(ticker)) return true;
  if (d.agencyFiled && d.stockCodes.includes(ticker)) return true;
  return (
    d.filerCodes.length === 0 &&
    d.stockCodes.length === 1 &&
    d.stockCodes[0] === ticker &&
    (d.subject ?? "").toLocaleLowerCase("tr-TR").includes("işlem sırası")
  );
}

/**
 * The "KAP: <subject>" markers of `ticker`'s chart for the session day `sessionDay` (an Istanbul YYYY-MM-DD),
 * in the order given. `istToday` turns an epoch time into that day (format.ts's istToday); a row whose time
 * does not parse is skipped. No session day (no intraday bars): no markers.
 */
export function chartKapMarkers(
  disclosures: readonly ChartMarkerDisclosure[],
  ticker: string,
  sessionDay: string | null,
  istToday: (ms: number) => string,
): KapChartMarker[] {
  if (!sessionDay) return [];
  const markers: KapChartMarker[] = [];
  for (const d of disclosures) {
    const ms = Date.parse(d.publishedAt);
    if (!Number.isFinite(ms) || istToday(ms) !== sessionDay) continue;
    if (!isAboutTicker(d, ticker)) continue;
    markers.push({ ts: d.publishedAt, label: `KAP: ${d.subject ?? "bildirim"}` });
  }
  return markers;
}
