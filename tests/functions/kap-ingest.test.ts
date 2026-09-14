import { describe, expect, it } from "vitest";
import {
  autoAlias,
  dayRange,
  foldTr,
  istanbulDate,
  mapDisclosure,
  parseCompanies,
  parseKapDate,
} from "../../supabase/functions/_shared/kap.ts";

// Pure-helper contract for the kap-ingest Edge Function. The I/O layer
// (fetch + upsert) is thin and mirrors ingest/index.ts; what can silently
// rot is the KAP row mapping, the Turkish fold (which must match
// public.fold_tr in migration 049) and the RSC company-list parse.

describe("kap helpers", () => {
  it("parses KAP publishDate as Istanbul time", () => {
    expect(parseKapDate("11.09.2026 23:33:31")).toBe("2026-09-11T23:33:31+03:00");
    expect(() => parseKapDate("2026-09-11")).toThrow();
  });

  it("maps a list item to a kap_disclosures row", () => {
    const row = mapDisclosure({
      publishDate: "11.09.2026 20:45:05",
      kapTitle: "ORZAKS İLAÇ VE KİMYA SANAYİ TİCARET A.Ş.",
      disclosureClass: "ODA",
      disclosureType: "ODA",
      disclosureCategory: "ODA",
      summary: "Özbekistan hk.\n",
      subject: "Özel Durum Açıklaması (Genel)",
      relatedStocks: "ABH, ABM",
      year: null,
      ruleType: "-",
      period: null,
      disclosureIndex: 1662124,
      isLate: false,
      stockCodes: "ORZAK",
      attachmentCount: 0,
      modifyStatus: null,
    });
    expect(row.disclosure_index).toBe(1662124);
    expect(row.stock_codes).toEqual(["ORZAK"]);
    expect(row.related_stocks).toEqual(["ABH", "ABM"]);
    expect(row.summary).toBe("Özbekistan hk.");
    expect(row.raw.disclosureIndex).toBe(1662124);
  });

  it("lifts the paper code out of an exchange-filed summary", () => {
    const row = mapDisclosure({
      publishDate: "14.09.2026 15:57:00",
      kapTitle: "BORSA İSTANBUL BISTECH DEVRE KESİCİ UYGULAMASI",
      disclosureClass: "DKB",
      disclosureType: "DUY",
      disclosureCategory: null,
      summary: "BETAE.E işlem sırasında Pay Bazında Devre Kesici Uygulaması devreye girmiştir",
      subject: "Pay Bazında Devre Kesici Bildirimi",
      relatedStocks: null,
      year: null,
      ruleType: "-",
      period: null,
      disclosureIndex: 1662400,
      isLate: false,
      stockCodes: null,
      attachmentCount: 0,
      modifyStatus: null,
    });
    expect(row.stock_codes).toEqual(["BETAE"]);
  });

  it("folds Turkish like public.fold_tr", () => {
    expect(foldTr("Türk Hava Yolları'nın")).toBe("turk hava yollari nin");
    expect(foldTr("ŞİŞECAM, Iğdır & İstanbul")).toBe("sisecam igdir istanbul");
  });

  it("derives one safe auto alias or none", () => {
    expect(autoAlias("VESTEL ELEKTRONİK SANAYİ VE TİCARET A.Ş.")).toBe("vestel");
    expect(autoAlias("AKBANK T.A.Ş.")).toBe("akbank");
    expect(autoAlias("TÜRKİYE İŞ BANKASI A.Ş.")).toBeNull();
    expect(autoAlias("AK YATIRIM MENKUL DEĞERLER A.Ş.")).toBeNull();
  });

  it("parses the escaped RSC company payload, merging duplicates", () => {
    const html = String.raw`x[{\"kapMemberOid\":\"OID1\",\"kapMemberType\":\"IGS\",\"kapMemberState\":\"A\",\"payIslemDurumu\":\"1\",\"mkkMemberOid\":\"M1\",\"kapMemberTitle\":\"VESTEL ELEKTRONİK SANAYİ VE TİCARET A.Ş.\",\"stockCode\":\"VESTL\",\"cityName\":\"MANİSA\"},{\"kapMemberOid\":\"OID2\",\"kapMemberState\":\"P\",\"payIslemDurumu\":\"0\",\"kapMemberTitle\":\"X A.Ş.\",\"stockCode\":\"XA, XB\"},{\"kapMemberOid\":\"OID3\",\"kapMemberTitle\":\"NO CODE A.Ş.\",\"stockCode\":null}]`;
    const rows = parseCompanies(html);
    expect(rows.map((r) => r.kap_member_oid)).toEqual(["OID1", "OID2"]);
    expect(rows[0]).toMatchObject({ tickers: ["VESTL"], shares_traded: true, city: "MANİSA" });
    expect(rows[1]).toMatchObject({ tickers: ["XA", "XB"], shares_traded: false });
  });

  it("walks day ranges and Istanbul dates", () => {
    expect(dayRange("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    // 22:30 UTC is already the next day in Istanbul.
    expect(istanbulDate(0, Date.parse("2026-09-12T22:30:00Z"))).toBe("2026-09-13");
    expect(istanbulDate(-1, Date.parse("2026-09-12T22:30:00Z"))).toBe("2026-09-12");
  });
});
