import { describe, expect, it } from "vitest";

import { chartKapMarkers, type ChartMarkerDisclosure } from "@/lib/finance/chart-markers";
import { istToday } from "@/lib/finance/format";

// h144-ekonomi-3: /ekonomi/GLRMK drew "▲ 18:10 KAP: SPK İşlem Yasağı Nedeniyle Pay Duyurusu" on the company's own
// chart. That is MKK's list of 100 shares under a trading ban (stock_codes empty, so the page's `stockCodes` fell
// back to the related shares): it names GLRMK, it is not news about GLRMK. Only a company's own filing (or an
// agency's rating of it) is a marker. Rows below are the real shapes of 2026-11-09..11.

const SESSION = "2026-11-11";
/** 15:10Z is 18:10 in Istanbul: inside SESSION. */
const ON_SESSION = "2026-11-11T15:10:44+00:00";
const DAY_BEFORE = "2026-11-10T15:10:44+00:00";

const row = (over: Partial<ChartMarkerDisclosure> = {}): ChartMarkerDisclosure => ({
  publishedAt: ON_SESSION,
  subject: "Özel Durum Açıklaması (Genel)",
  filerCodes: ["THYAO"],
  stockCodes: ["THYAO"],
  agencyFiled: false,
  ...over,
});

const markers = (rows: readonly ChartMarkerDisclosure[], ticker = "THYAO", day: string | null = SESSION) =>
  chartKapMarkers(rows, ticker, day, istToday);

describe("chartKapMarkers", () => {
  it("GLRMK: MKK's ban list that merely names the share is not a marker", () => {
    const related = ["GLRMK", ...Array.from({ length: 99 }, (_, i) => `TK${String(i).padStart(3, "0")}`)];
    const mkkList = row({
      subject: "SPK İşlem Yasağı Nedeniyle Pay Duyurusu",
      filerCodes: [],
      stockCodes: related, // queries.ts falls back to related_stocks when stock_codes is empty
    });

    expect(markers([mkkList], "GLRMK")).toEqual([]);
  });

  it("an own filing on the session day is a marker, labelled 'KAP: <subject>'", () => {
    const own = row({ publishedAt: ON_SESSION, subject: "Şirket Genel Bilgi Formu", filerCodes: ["MERIT"], stockCodes: ["MERIT"] });

    expect(markers([own], "MERIT")).toEqual([{ ts: ON_SESSION, label: "KAP: Şirket Genel Bilgi Formu" }]);
  });

  it("an own filing on another day is not a marker", () => {
    expect(markers([row({ publishedAt: DAY_BEFORE })])).toEqual([]);
  });

  it("a notice with no subject reads 'KAP: bildirim'", () => {
    expect(markers([row({ subject: null })])).toEqual([{ ts: ON_SESSION, label: "KAP: bildirim" }]);
  });

  it("an agency-filed rating whose rated company is the ticker is a marker", () => {
    // TRATE files "Kredi Derecelendirmesi" under its own code; the rated company is in related_stocks.
    const rating = row({ subject: "Kredi Derecelendirmesi", filerCodes: ["TRATE"], stockCodes: ["DNYVA"], agencyFiled: true });

    expect(markers([rating], "DNYVA")).toEqual([{ ts: ON_SESSION, label: "KAP: Kredi Derecelendirmesi" }]);
  });

  it("an agency's rating of another company is not a marker on this chart", () => {
    const rating = row({ subject: "Kredi Derecelendirmesi", filerCodes: ["TRATE"], stockCodes: ["DNYVA"], agencyFiled: true });

    expect(markers([rating], "THYAO")).toEqual([]);
  });

  it("MERIT: a Net Holding insider-trade filing that names MERIT is not a marker on MERIT", () => {
    const netHolding = row({
      subject: "Pay Alım Satım Bildirimi",
      filerCodes: ["NTHOL"],
      stockCodes: ["NTHOL"],
      agencyFiled: false,
    });

    expect(markers([netHolding], "MERIT")).toEqual([]);
    // It is Net Holding's own filing, so its own chart keeps it.
    expect(markers([netHolding], "NTHOL")).toHaveLength(1);
  });

  // h145 review TS-4: a Borsa Istanbul trading-halt notice of ONE share (no filer: stock_codes empty, the share only in
  // related_stocks) is a claim about that company, not a list that merely names it. ANELE's 2026-06-15 pair: closing at
  // 06:35Z (09:35 Istanbul), reopening at 09:38Z (12:38), both inside the chart's session window.
  describe("a Borsa Istanbul halt of this share alone (Pay İşlem Sırası Kapatma / Açma)", () => {
    const HALT = "Pay İşlem Sırası Kapatma / Açma";
    const SESSION_ANELE = "2026-06-15";
    const halt = (over: Partial<ChartMarkerDisclosure> = {}): ChartMarkerDisclosure =>
      row({ subject: HALT, filerCodes: [], stockCodes: ["ANELE"], agencyFiled: false, ...over });

    it("ANELE: the closing and the reopening on the session day are two markers", () => {
      const closing = halt({ publishedAt: "2026-06-15T06:35:00+00:00" });
      const reopening = halt({ publishedAt: "2026-06-15T09:38:00+00:00" });

      expect(markers([closing, reopening], "ANELE", SESSION_ANELE)).toEqual([
        { ts: "2026-06-15T06:35:00+00:00", label: `KAP: ${HALT}` },
        { ts: "2026-06-15T09:38:00+00:00", label: `KAP: ${HALT}` },
      ]);
    });

    it("the same subject naming ANELE among other shares is not a marker (a list, not one share's halt)", () => {
      const list = halt({ publishedAt: "2026-06-15T06:35:00+00:00", stockCodes: ["ANELE", "OTHER"] });

      expect(markers([list], "ANELE", SESSION_ANELE)).toEqual([]);
    });

    it("a halt of another share is not a marker on this chart", () => {
      const other = halt({ publishedAt: "2026-06-15T06:35:00+00:00", stockCodes: ["OTHER"] });

      expect(markers([other], "ANELE", SESSION_ANELE)).toEqual([]);
    });

    it("a halt of this share on another day is not a marker", () => {
      expect(markers([halt({ publishedAt: "2026-06-14T06:35:00+00:00" })], "ANELE", SESSION_ANELE)).toEqual([]);
    });

    it("the match reads the subject in Turkish lower case (İŞLEM SIRASI, İşlem Sırası)", () => {
      const upper = halt({ publishedAt: "2026-06-15T06:35:00+00:00", subject: "PAY İŞLEM SIRASI KAPATMA / AÇMA" });
      const mixed = halt({ publishedAt: "2026-06-15T09:38:00+00:00", subject: "Pay İşlem Sırası Kapatma / Açma" });

      expect(markers([upper, mixed], "ANELE", SESSION_ANELE)).toHaveLength(2);
    });

    it("a notice with a filer is judged by the filer rule, not by this exception", () => {
      // Same subject, but another company filed it and the ticker is only among its codes.
      const filed = halt({ publishedAt: "2026-06-15T06:35:00+00:00", filerCodes: ["OTHER"], stockCodes: ["OTHER"] });

      expect(markers([filed], "ANELE", SESSION_ANELE)).toEqual([]);
    });

    it("another no-filer notice of one share (a ban list naming it, a null subject) is still not a marker", () => {
      const ban = halt({ publishedAt: "2026-06-15T06:35:00+00:00", subject: "SPK İşlem Yasağı Nedeniyle Pay Duyurusu" });
      const noSubject = halt({ publishedAt: "2026-06-15T06:35:00+00:00", subject: null });
      const insider = halt({ publishedAt: "2026-06-15T06:35:00+00:00", subject: "Pay Alım Satım Bildirimi" });

      expect(markers([ban, noSubject, insider], "ANELE", SESSION_ANELE)).toEqual([]);
    });

    it("the GLRMK ban list and the MERIT insider-trade filing still give none", () => {
      const related = ["GLRMK", ...Array.from({ length: 99 }, (_, i) => `TK${String(i).padStart(3, "0")}`)];
      const mkkList = row({ subject: "SPK İşlem Yasağı Nedeniyle Pay Duyurusu", filerCodes: [], stockCodes: related });
      const netHolding = row({ subject: "Pay Alım Satım Bildirimi", filerCodes: ["NTHOL"], stockCodes: ["NTHOL"] });

      expect(markers([mkkList], "GLRMK")).toEqual([]);
      expect(markers([netHolding], "MERIT")).toEqual([]);
    });

    it("a halt notice that names a lone share which is not the ticker is not a marker, even with the subject in capitals", () => {
      const other = halt({ publishedAt: "2026-06-15T06:35:00+00:00", stockCodes: ["ANELEX"], subject: "PAY İŞLEM SIRASI KAPATMA" });

      expect(markers([other], "ANELE", SESSION_ANELE)).toEqual([]);
    });
  });

  it("a filing that names the ticker only among its codes is not enough without being the filer or the rated company", () => {
    // stockCodes carries the ticker (the related-shares fallback), filerCodes does not, and it is no agency notice.
    const byProxy = row({ filerCodes: ["NTHOL"], stockCodes: ["NTHOL", "MERIT"], agencyFiled: false });

    expect(markers([byProxy], "MERIT")).toEqual([]);
  });

  it("a joint filing counts for each of its filers", () => {
    const joint = row({ filerCodes: ["ISCTR", "ISATR"], stockCodes: ["ISCTR", "ISATR"] });

    expect(markers([joint], "ISATR")).toHaveLength(1);
    expect(markers([joint], "ISCTR")).toHaveLength(1);
    expect(markers([joint], "THYAO")).toEqual([]);
  });

  it("keeps only what matches among several rows, in the order given", () => {
    const rows = [
      row({ publishedAt: "2026-11-11T06:00:00+00:00", subject: "A" }),
      row({ publishedAt: "2026-11-11T07:00:00+00:00", subject: "B", filerCodes: [], stockCodes: ["THYAO", "PGSUS"] }),
      row({ publishedAt: "2026-11-10T07:00:00+00:00", subject: "C" }),
      row({ publishedAt: "2026-11-11T08:00:00+00:00", subject: "D" }),
    ];

    expect(markers(rows).map((m) => m.label)).toEqual(["KAP: A", "KAP: D"]);
  });

  it("the session day is the Istanbul day: 00:30 on the 11th (21:30Z on the 10th) is inside, 23:30 on the 11th is too, 00:30 on the 12th is not", () => {
    const inside = [row({ publishedAt: "2026-11-10T21:30:00+00:00" }), row({ publishedAt: "2026-11-11T20:30:00+00:00" })];
    const outside = [row({ publishedAt: "2026-11-11T21:30:00+00:00" }), row({ publishedAt: "2026-11-10T20:30:00+00:00" })];

    expect(markers(inside)).toHaveLength(2);
    expect(markers(outside)).toEqual([]);
  });

  it("no session day (no intraday bars) means no markers", () => {
    expect(markers([row()], "THYAO", null)).toEqual([]);
  });

  it("no rows, or a row whose time does not parse, gives no marker and does not throw", () => {
    expect(markers([])).toEqual([]);
    expect(markers([row({ publishedAt: "not a date" }), row({ publishedAt: "" })])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const rows = [row({ subject: "A" }), row({ subject: "B", filerCodes: ["OTHER"], stockCodes: ["OTHER"] })];
    const before = structuredClone(rows);

    markers(rows);

    expect(rows).toEqual(before);
  });

  it("ticker matching is exact: GARAN does not match GARANT", () => {
    expect(markers([row({ filerCodes: ["GARAN"], stockCodes: ["GARAN"] })], "GARANT")).toEqual([]);
  });

  it("handles a large list (10,000 rows) without trouble", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) =>
      row({ subject: `S${i}`, filerCodes: i % 100 === 0 ? ["THYAO"] : ["OTHER"], stockCodes: ["OTHER"] }),
    );

    expect(markers(rows)).toHaveLength(100);
  });
});
