import { describe, expect, it } from "vitest";

import { correctionChains, disclosureCorrectionChains, supersededDisclosureIndexes, supersededIndexes } from "./kap-corrections";

// h108-kapdisclosures-3: KAP files a correction as a NEW disclosure (modify_status
// DUZENLENEN) with the same subject and summary as the notice it replaces. The original
// is flagged DUZELTILEN only when the daily replay happened to cover it, so most are
// found by matching: same issuer, same subject/summary/year/period, the correction at
// most 14 days later. Real rows from 2026-11-04..10 are used below.

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-06T15:10:24Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const row = (over: Record<string, unknown> = {}) => ({
  disclosure_index: 1,
  published_at: at(0),
  stock_codes: ["OTTO"] as string[] | null,
  subject: "Sorumluluk Beyanı (Konsolide)" as string | null,
  summary: "Otto Holding A.Ş. 3. Aylık Finansal Durum Raporu Ve Ekleri Sorumluluk Beyanı" as string | null,
  year: "2026" as string | null,
  period: "3" as string | null,
  modify_status: null as string | null,
  ...over,
});

describe("supersededIndexes", () => {
  it("the OTTO pair: 1694030 (flagged DUZELTILEN) is superseded, its correction 1694331 is not", () => {
    const rows = [
      row({ disclosure_index: 1694331, published_at: "2026-11-06T15:48:38+00:00", modify_status: "DUZENLENEN" }),
      row({ disclosure_index: 1694030, published_at: "2026-11-06T15:10:24+00:00", modify_status: "DUZELTILEN" }),
    ];
    expect([...supersededIndexes(rows)]).toEqual([1694030]);
  });

  it("the ATEKS pair, one day apart and the original unflagged, supersedes 1695283", () => {
    const summary = "30.09.2026 Sorumluluk Beyanı";
    const rows = [
      row({ disclosure_index: 1695283, stock_codes: ["ATEKS"], published_at: "2026-11-09T15:12:19+00:00", summary }),
      row({ disclosure_index: 1696599, stock_codes: ["ATEKS"], published_at: "2026-11-10T15:10:48+00:00", summary, modify_status: "DUZENLENEN" }),
    ];
    expect([...supersededIndexes(rows)]).toEqual([1695283]);
  });

  it("the TTKOM pair (null summary on both, same year and period) supersedes 1692808", () => {
    const base = { stock_codes: ["TTKOM"], subject: "Finansal Rapor", summary: null, year: "2026", period: "3" };
    const rows = [
      row({ ...base, disclosure_index: 1692808, published_at: "2026-11-04T17:03:12+00:00" }),
      row({ ...base, disclosure_index: 1694263, published_at: "2026-11-06T15:27:08+00:00", modify_status: "DUZENLENEN" }),
    ];
    expect([...supersededIndexes(rows)]).toEqual([1692808]);
  });

  it("the DOFRB pair, whatever order the rows come in", () => {
    const base = { stock_codes: ["DOFRB"], subject: "Faaliyet Raporu (Konsolide)", summary: "Dof Robotics San A.Ş. 2026 3.Dönem Yönetim Kurulu Faaliyet Raporu" };
    const original = row({ ...base, disclosure_index: 1694519, published_at: "2026-11-07T13:02:27+00:00" });
    const correction = row({ ...base, disclosure_index: 1695246, published_at: "2026-11-09T15:10:12+00:00", modify_status: "DUZENLENEN" });
    expect([...supersededIndexes([original, correction])]).toEqual([1694519]);
    expect([...supersededIndexes([correction, original])]).toEqual([1694519]);
  });

  it("two 'Özel Durum Açıklaması (Genel)' rows with different summaries are not merged", () => {
    const rows = [
      row({ disclosure_index: 1, subject: "Özel Durum Açıklaması (Genel)", summary: "Genel kurul tarihi", year: null, period: null }),
      row({ disclosure_index: 2, subject: "Özel Durum Açıklaması (Genel)", summary: "Pay geri alımı", year: null, period: null, published_at: at(DAY), modify_status: "DUZENLENEN" }),
    ];
    expect(supersededIndexes(rows).size).toBe(0);
  });

  it("an unflagged later twin is not a correction: only DUZENLENEN supersedes", () => {
    const rows = [row({ disclosure_index: 1 }), row({ disclosure_index: 2, published_at: at(DAY) })];
    expect(supersededIndexes(rows).size).toBe(0);
  });

  it("a twin 15 days earlier is not merged; one exactly 14 days earlier is", () => {
    const correction = row({ disclosure_index: 9, published_at: at(20 * DAY), modify_status: "DUZENLENEN" });
    expect(supersededIndexes([row({ disclosure_index: 1, published_at: at(5 * DAY) }), correction]).size).toBe(0);
    expect([...supersededIndexes([row({ disclosure_index: 1, published_at: at(6 * DAY) }), correction])]).toEqual([1]);
    // 14 days and 1 ms: outside.
    expect(supersededIndexes([row({ disclosure_index: 1, published_at: at(6 * DAY - 1) }), correction]).size).toBe(0);
  });

  it("a different issuer is not merged, an overlapping issuer list is", () => {
    const correction = row({ disclosure_index: 2, published_at: at(DAY), modify_status: "DUZENLENEN" });
    expect(supersededIndexes([row({ disclosure_index: 1, stock_codes: ["ZOREN"] }), correction]).size).toBe(0);
    expect([...supersededIndexes([row({ disclosure_index: 1, stock_codes: ["ISATR", "OTTO"] }), correction])]).toEqual([1]);
  });

  it("rows with no stock_codes never match (nothing overlaps)", () => {
    const correction = row({ disclosure_index: 2, stock_codes: [], published_at: at(DAY), modify_status: "DUZENLENEN" });
    expect(supersededIndexes([row({ disclosure_index: 1, stock_codes: [] }), correction]).size).toBe(0);
    expect(supersededIndexes([row({ disclosure_index: 1, stock_codes: null }), { ...correction, stock_codes: null }]).size).toBe(0);
  });

  it("a different year, period or subject is not merged; a null subject never matches", () => {
    const correction = row({ disclosure_index: 2, published_at: at(DAY), modify_status: "DUZENLENEN" });
    expect(supersededIndexes([row({ disclosure_index: 1, year: "2025" }), correction]).size).toBe(0);
    expect(supersededIndexes([row({ disclosure_index: 1, period: "6" }), correction]).size).toBe(0);
    expect(supersededIndexes([row({ disclosure_index: 1, period: null }), correction]).size).toBe(0);
    expect(supersededIndexes([row({ disclosure_index: 1, subject: "Faaliyet Raporu" }), correction]).size).toBe(0);
    const nullSubject = { subject: null, summary: null };
    expect(supersededIndexes([row({ disclosure_index: 1, ...nullSubject }), { ...correction, ...nullSubject }]).size).toBe(0);
  });

  it("null year and period on both sides are equal, and numeric year/period compare like their text", () => {
    const correction = row({ disclosure_index: 2, year: null, period: null, published_at: at(DAY), modify_status: "DUZENLENEN" });
    expect([...supersededIndexes([row({ disclosure_index: 1, year: null, period: null }), correction])]).toEqual([1]);
    const numeric = row({ disclosure_index: 4, year: 2026 as unknown as string, period: 3 as unknown as string, published_at: at(DAY), modify_status: "DUZENLENEN" });
    expect([...supersededIndexes([row({ disclosure_index: 3 }), numeric])]).toEqual([3]);
  });

  it("a lone DUZELTILEN row is superseded even without its correction in the list", () => {
    expect([...supersededIndexes([row({ disclosure_index: 7, modify_status: "DUZELTILEN" })])]).toEqual([7]);
  });

  it("a correction does not supersede itself, nor anything published after it or at the same instant", () => {
    const correction = row({ disclosure_index: 2, modify_status: "DUZENLENEN" });
    expect(supersededIndexes([correction]).size).toBe(0);
    // Same instant: not 'later'.
    expect(supersededIndexes([row({ disclosure_index: 1 }), correction]).size).toBe(0);
    // The twin is NEWER than the correction: the correction does not replace it.
    expect(supersededIndexes([row({ disclosure_index: 3, published_at: at(DAY) }), correction]).size).toBe(0);
  });

  it("a correction of a correction: both earlier versions are superseded, the last is not", () => {
    const rows = [
      row({ disclosure_index: 1, published_at: at(0) }),
      row({ disclosure_index: 2, published_at: at(DAY), modify_status: "DUZENLENEN" }),
      row({ disclosure_index: 3, published_at: at(2 * DAY), modify_status: "DUZENLENEN" }),
    ];
    expect([...supersededIndexes(rows)].sort()).toEqual([1, 2]);
  });

  it("unreadable dates and empty input are tolerated, and the input is not changed", () => {
    expect(supersededIndexes([]).size).toBe(0);
    const rows = [
      row({ disclosure_index: 1, published_at: "not a date" }),
      row({ disclosure_index: 2, published_at: at(DAY), modify_status: "DUZENLENEN" }),
    ];
    const copy = JSON.stringify(rows);
    expect(supersededIndexes(rows).size).toBe(0);
    expect(JSON.stringify(rows)).toBe(copy);
  });

  it("scales to a full page of 60 rows without trouble", () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ disclosure_index: i + 1, stock_codes: [`T${i}`], published_at: at(i * 1000), modify_status: i % 2 ? "DUZENLENEN" : null }),
    );
    expect(supersededIndexes(rows).size).toBe(0);
  });
});

// h109 review fixes: one correction replaces ONE filing. TABGD files the same buyback notice
// ("Payların Geri Alınmasına İlişkin Bildirim / Pay Geri Alım İşlemleri", year and period null)
// every working day, and one DUZENLENEN row on 23 Oct used to supersede all eight earlier days.
describe("supersededIndexes: one correction replaces at most one original", () => {
  const TABGD = {
    stock_codes: ["TABGD"],
    related_stocks: [] as string[],
    subject: "Payların Geri Alınmasına İlişkin Bildirim",
    summary: "Pay Geri Alım İşlemleri",
    year: null,
    period: null,
  };
  const daily = [
    [1680838, "2026-10-13T14:17:20Z"],
    [1681873, "2026-10-14T12:47:32Z"],
    [1682650, "2026-10-15T13:36:04Z"],
    [1683184, "2026-10-16T13:11:37Z"],
    [1683866, "2026-10-19T14:20:10Z"],
    [1684569, "2026-10-20T15:14:16Z"],
    [1685208, "2026-10-21T14:25:14Z"],
    [1686092, "2026-10-22T19:06:55Z"],
  ].map(([disclosure_index, published_at]) => row({ ...TABGD, disclosure_index, published_at }));
  const tabgdCorrection = row({ ...TABGD, disclosure_index: 1686985, published_at: "2026-10-23T15:40:58Z", modify_status: "DUZENLENEN" });

  it("the TABGD series with one DUZENLENEN row supersedes exactly its nearest earlier twin, 1686092", () => {
    expect([...supersededIndexes([...daily, tabgdCorrection])]).toEqual([1686092]);
  });

  it("the same series with the correction listed first (or the rows reversed) gives the same answer", () => {
    expect([...supersededIndexes([tabgdCorrection, ...daily])]).toEqual([1686092]);
    expect([...supersededIndexes([...daily].reverse().concat(tabgdCorrection))]).toEqual([1686092]);
  });

  it("a second correction claims the newest unclaimed twin, which is the first correction: the days before stay", () => {
    const second = { ...tabgdCorrection, disclosure_index: 1687500, published_at: "2026-10-24T15:00:00Z" };
    expect([...supersededIndexes([...daily, tabgdCorrection, second])].sort()).toEqual([1686092, 1686985]);
  });

  it("two corrections of two different filings each claim their own original", () => {
    const q3 = { subject: "Finansal Rapor", summary: null, year: "2026", period: "3" };
    const q2 = { ...q3, period: "2" };
    const rows = [
      row({ ...q3, disclosure_index: 1, published_at: at(0) }),
      row({ ...q2, disclosure_index: 2, published_at: at(1000) }),
      row({ ...q3, disclosure_index: 3, published_at: at(DAY), modify_status: "DUZENLENEN" }),
      row({ ...q2, disclosure_index: 4, published_at: at(DAY + 1000), modify_status: "DUZENLENEN" }),
    ];
    expect([...supersededIndexes(rows)].sort()).toEqual([1, 2]);
  });

  it("a correction with no earlier twin at all claims nothing", () => {
    expect(supersededIndexes([row({ disclosure_index: 2, modify_status: "DUZENLENEN" })]).size).toBe(0);
  });

  it("a tie on the publication instant goes to the higher disclosure_index", () => {
    const a = row({ disclosure_index: 10, published_at: at(0) });
    const b = row({ disclosure_index: 11, published_at: at(0) });
    const c = row({ disclosure_index: 20, published_at: at(DAY), modify_status: "DUZENLENEN" });
    expect([...supersededIndexes([a, b, c])]).toEqual([11]);
    expect([...supersededIndexes([c, b, a])]).toEqual([11]);
  });

  it("a DUZELTILEN-flagged twin is a candidate like any other, and is superseded either way", () => {
    const flagged = row({ disclosure_index: 1, published_at: at(0), modify_status: "DUZELTILEN" });
    const older = row({ disclosure_index: 2, published_at: at(-DAY) });
    const correction = row({ disclosure_index: 3, published_at: at(DAY), modify_status: "DUZENLENEN" });
    // The flagged row is the nearest twin: the correction claims it and leaves the older, unflagged row alone.
    expect([...supersededIndexes([older, flagged, correction])]).toEqual([1]);
  });

  describe("related_stocks must match too (a rating agency files one subject for many companies)", () => {
    const rating = {
      stock_codes: ["JCRAV"],
      subject: "Kredi Derecelendirmesi",
      summary: "KREDİ DERECELENDİRME BİLDİRİMİ",
      year: null,
      period: null,
    };
    const akbnk = row({ ...rating, disclosure_index: 1, published_at: at(0), related_stocks: ["AKBNK"] });
    const garan = row({ ...rating, disclosure_index: 2, published_at: at(1000), related_stocks: ["GARAN"] });
    const correction = (related: string[] | null | undefined) =>
      row({ ...rating, disclosure_index: 3, published_at: at(DAY), related_stocks: related, modify_status: "DUZENLENEN" });

    it("a correction about a third company supersedes nothing", () => {
      expect(supersededIndexes([akbnk, garan, correction(["THYAO"])]).size).toBe(0);
    });

    it("a correction about GARAN supersedes only the GARAN row", () => {
      expect([...supersededIndexes([akbnk, garan, correction(["GARAN"])])]).toEqual([2]);
    });

    it("related_stocks compare as sets, in any order, and null equals an empty list", () => {
      const pair = row({ ...rating, disclosure_index: 4, published_at: at(0), related_stocks: ["AKBNK", "GARAN"] });
      expect([...supersededIndexes([pair, correction(["GARAN", "AKBNK"])])]).toEqual([4]);
      const bare = row({ ...rating, disclosure_index: 5, published_at: at(0), related_stocks: null });
      expect([...supersededIndexes([bare, correction([])])]).toEqual([5]);
      expect([...supersededIndexes([bare, correction(undefined)])]).toEqual([5]);
      expect(supersededIndexes([bare, correction(["GARAN"])]).size).toBe(0);
    });
  });
});

describe("correctionChains: where a surviving correction's filing first appeared", () => {
  it("the TTKOM pair: the correction 1694263 maps to its original 1692808", () => {
    const base = { stock_codes: ["TTKOM"], subject: "Finansal Rapor", summary: null, year: "2026", period: "3" };
    const rows = [
      row({ ...base, disclosure_index: 1692808, published_at: "2026-11-04T17:03:12+00:00" }),
      row({ ...base, disclosure_index: 1694263, published_at: "2026-11-06T15:27:08+00:00", modify_status: "DUZENLENEN" }),
    ];
    const chains = correctionChains(rows);
    expect([...chains.keys()]).toEqual([1694263]);
    expect(chains.get(1694263)).toEqual({ earliestIndex: 1692808, earliestPublishedAt: "2026-11-04T17:03:12+00:00" });
  });

  it("a correction of a correction: 1 <- 2 <- 3 maps the last, 3, to the first, 1", () => {
    const rows = [
      row({ disclosure_index: 3, published_at: at(2 * DAY), modify_status: "DUZENLENEN" }),
      row({ disclosure_index: 1, published_at: at(0) }),
      row({ disclosure_index: 2, published_at: at(DAY), modify_status: "DUZENLENEN" }),
    ];
    const chains = correctionChains(rows);
    expect([...chains.keys()]).toEqual([3]);
    expect(chains.get(3)).toMatchObject({ earliestIndex: 1, earliestPublishedAt: at(0) });
  });

  it("only surviving corrections are keys: no row of supersededIndexes is one", () => {
    const rows = [
      row({ disclosure_index: 1, published_at: at(0) }),
      row({ disclosure_index: 2, published_at: at(DAY), modify_status: "DUZENLENEN" }),
      row({ disclosure_index: 3, published_at: at(2 * DAY), modify_status: "DUZENLENEN" }),
    ];
    const superseded = supersededIndexes(rows);
    for (const key of correctionChains(rows).keys()) expect(superseded.has(key)).toBe(false);
  });

  it("a correction that found no original, a lone DUZELTILEN row and an empty list make no chain", () => {
    expect(correctionChains([row({ disclosure_index: 2, modify_status: "DUZENLENEN" })]).size).toBe(0);
    expect(correctionChains([row({ disclosure_index: 7, modify_status: "DUZELTILEN" })]).size).toBe(0);
    expect(correctionChains([]).size).toBe(0);
  });

  it("the TABGD series: 1686985 maps to 1686092 only, the other seven days are not part of the chain", () => {
    const TABGD = { stock_codes: ["TABGD"], subject: "Payların Geri Alınmasına İlişkin Bildirim", summary: "Pay Geri Alım İşlemleri", year: null, period: null };
    const rows = [
      row({ ...TABGD, disclosure_index: 1685208, published_at: "2026-10-21T14:25:14Z" }),
      row({ ...TABGD, disclosure_index: 1686092, published_at: "2026-10-22T19:06:55Z" }),
      row({ ...TABGD, disclosure_index: 1686985, published_at: "2026-10-23T15:40:58Z", modify_status: "DUZENLENEN" }),
    ];
    expect([...correctionChains(rows)]).toEqual([[1686985, { earliestIndex: 1686092, earliestPublishedAt: "2026-10-22T19:06:55Z" }]]);
  });

  it("the page-side wrapper reads the same chain off Disclosure rows (filerCodes, relatedCodes)", () => {
    const d = (over: Record<string, unknown>) => ({
      disclosureIndex: 1,
      publishedAt: at(0),
      filerCodes: ["OTTO"],
      subject: "Sorumluluk Beyanı (Konsolide)",
      summary: "Otto Holding A.Ş. 3. Aylık Finansal Durum Raporu Ve Ekleri Sorumluluk Beyanı",
      year: "2026",
      period: "3",
      modifyStatus: null as string | null,
      ...over,
    });
    const chains = disclosureCorrectionChains([
      d({ disclosureIndex: 2, publishedAt: at(DAY), modifyStatus: "DUZENLENEN" }),
      d({ disclosureIndex: 1 }),
    ]);
    expect(chains.get(2)).toEqual({ earliestIndex: 1, earliestPublishedAt: at(0) });
  });
});

describe("supersededDisclosureIndexes (the same rule on the page's Disclosure rows)", () => {
  const disclosure = (over: Record<string, unknown> = {}) => ({
    disclosureIndex: 1,
    publishedAt: at(0),
    filerCodes: ["OTTO"],
    subject: "Sorumluluk Beyanı (Konsolide)" as string | null,
    summary: "Otto Holding A.Ş. 3. Aylık Finansal Durum Raporu Ve Ekleri Sorumluluk Beyanı" as string | null,
    year: "2026" as string | null,
    period: "3" as string | null,
    modifyStatus: null as string | null,
    ...over,
  });

  it("matches on filerCodes (stock_codes), not on the chips", () => {
    const original = disclosure({ disclosureIndex: 1 });
    const correction = disclosure({ disclosureIndex: 2, publishedAt: at(DAY), modifyStatus: "DUZENLENEN" });
    expect([...supersededDisclosureIndexes([correction, original])]).toEqual([1]);
    expect(supersededDisclosureIndexes([original, { ...correction, filerCodes: ["ZOREN"] }]).size).toBe(0);
  });

  it("a DUZELTILEN row is superseded on its own", () => {
    expect([...supersededDisclosureIndexes([disclosure({ disclosureIndex: 5, modifyStatus: "DUZELTILEN" })])]).toEqual([5]);
  });

  it("relatedCodes must match too: a rating agency's correction about GARAN leaves the AKBNK notice alone", () => {
    const rating = { filerCodes: ["JCRAV"], subject: "Kredi Derecelendirmesi", summary: "KREDİ DERECELENDİRME BİLDİRİMİ", year: null, period: null };
    const akbnk = disclosure({ ...rating, disclosureIndex: 1, relatedCodes: ["AKBNK"] });
    const garan = disclosure({ ...rating, disclosureIndex: 2, publishedAt: at(1000), relatedCodes: ["GARAN"] });
    const correction = disclosure({ ...rating, disclosureIndex: 3, publishedAt: at(DAY), relatedCodes: ["GARAN"], modifyStatus: "DUZENLENEN" });
    expect([...supersededDisclosureIndexes([akbnk, garan, correction])]).toEqual([2]);
  });

  it("tolerates a row without the correction fields (an older fixture or a narrow select)", () => {
    const bare = { disclosureIndex: 1, publishedAt: at(0), filerCodes: ["OTTO"], subject: "X", summary: null };
    expect(supersededDisclosureIndexes([bare, { ...bare, disclosureIndex: 2 }]).size).toBe(0);
  });
});
