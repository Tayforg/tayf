import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repairKapApostrophe } from "../../../supabase/functions/_shared/kap-text.ts";
import { expectLinear, rep } from "../../_helpers/linear-time";

// ---------------------------------------------------------------------------
// h81-textclean-1: KAP's own feed loses the apostrophe of a Turkish suffix and
// leaves a literal '?' ("Irak Cumhuriyeti?ndeki", "ABD?deki", "A.Ş.?nin"). 845 of
// 210,954 stored kap_disclosures.summary rows carry it. Ingest and the raw
// payload stay verbatim; repairKapApostrophe runs at READ time.
//
// The repair is deliberately narrow: a '?' glued to a letter, a digit, a '.' or a
// '%' on the left and to a short lowercase word on the right. A real question
// mark ('Neden?', 'Ne oldu? Evet', '??', a URL query string) is never touched.
// ---------------------------------------------------------------------------

describe("repairKapApostrophe: the lost suffix apostrophe becomes U+2019", () => {
  it.each([
    ["Irak Cumhuriyeti?ndeki Satış", "Irak Cumhuriyeti’ndeki Satış"],
    ["ABD?deki İştirakimizin", "ABD’deki İştirakimizin"],
    ["Tarfin Tarım A.Ş.?nin hizmet", "Tarfin Tarım A.Ş.’nin hizmet"],
    ["Ali Hepşen?in Görevden", "Ali Hepşen’in Görevden"],
    ["Başlıklı 6?ncı Maddesinin", "Başlıklı 6’ncı Maddesinin"],
    ["%15?e", "%15’e"],
    ["A.Ş.?nin" + " ".repeat(70) + "sermaye artırımı hk", "A.Ş.’nin sermaye artırımı hk"],
  ])("%j -> %j", (input, expected) => {
    expect(repairKapApostrophe(input)).toBe(expected);
  });

  // Real stored summaries (kap_disclosures, 2026-11-08 replay): each shape of the 53 distinct
  // suffix runs that follow the '?', across the three left-hand classes.
  it.each([
    ["Moody?s kredi derecelendirme", "Moody’s kredi derecelendirme"],
    ["ilk 3,95 MW?lık kısmının", "ilk 3,95 MW’lık kısmının"],
    ["198 Ada, 6 No?lu Parsel", "198 Ada, 6 No’lu Parsel"],
    ["mevcut GMP?li üretim", "mevcut GMP’li üretim"],
    ["Sunulan VUK?a göre", "Sunulan VUK’a göre"],
    ["Whirlpool Corp.?ın MENA bölgesi", "Whirlpool Corp.’ın MENA bölgesi"],
    ["Kategoride Türkiye 1?inciliği Hk.", "Kategoride Türkiye 1’inciliği Hk."],
    ["Piyasası Kurulu?nca onaylanması", "Piyasası Kurulu’nca onaylanması"],
    ["Eurobond?u (XS2926261426)", "Eurobond’u (XS2926261426)"],
    ["Bildirimi?mizde", "Bildirimi’mizde"],
  ])("real row %j -> %j", (input, expected) => {
    expect(repairKapApostrophe(input)).toBe(expected);
  });

  it("repairs every glued apostrophe in one text and leaves a real question mark in the same text", () => {
    expect(repairKapApostrophe("Neden? Ali?nin ve Veli?nin payı. Sonuç ne?")).toBe("Neden? Ali’nin ve Veli’nin payı. Sonuç ne?");
  });

  it("is idempotent", () => {
    const once = repairKapApostrophe("Irak Cumhuriyeti?ndeki Satış ve A.Ş.?nin payı");
    expect(repairKapApostrophe(once)).toBe(once);
  });

  it("keeps a typographic or straight apostrophe that is already there", () => {
    expect(repairKapApostrophe("Türkiye’de ve Limited'in")).toBe("Türkiye’de ve Limited'in");
  });
});

describe("repairKapApostrophe: a real question mark is never touched", () => {
  it.each([
    ["Neden?"],
    ["Ne oldu? Evet"],
    ["Pay işlem sırası kapatılması?"],
    ["X?Y Holding"],
    ["Neden?? Evet"],
    ["Neden??nin"],
    ["Peki?"],
    ["?"],
    ["? evet"],
    ["sonuç ?nin"],
  ])("%j comes out unchanged", (input) => {
    expect(repairKapApostrophe(input)).toBe(input);
  });

  it("returns the empty string for the empty string and null for null", () => {
    expect(repairKapApostrophe("")).toBe("");
    expect(repairKapApostrophe(null)).toBeNull();
  });

  it("does not touch a URL query string, but still repairs the text around it", () => {
    expect(repairKapApostrophe("https://www.kap.org.tr/tr/Bildirim/1?id=5")).toBe("https://www.kap.org.tr/tr/Bildirim/1?id=5");
    expect(repairKapApostrophe("bkz www.kap.org.tr/x?utm_source=a ve http://a.com/b?q=c")).toBe(
      "bkz www.kap.org.tr/x?utm_source=a ve http://a.com/b?q=c",
    );
    expect(repairKapApostrophe("Bkz https://a.com/x?id=5 Limanı?nda yeni")).toBe("Bkz https://a.com/x?id=5 Limanı’nda yeni");
    expect(repairKapApostrophe("HTTPS://A.COM/x?id=5")).toBe("HTTPS://A.COM/x?id=5");
  });

  it("needs a lowercase word of at most 12 letters that ends where the word ends", () => {
    expect(repairKapApostrophe("A?abcdefghijkl")).toBe("A’abcdefghijkl"); // 12 letters
    expect(repairKapApostrophe("A?abcdefghijklm")).toBe("A?abcdefghijklm"); // 13 letters
    expect(repairKapApostrophe("A?de2")).toBe("A?de2"); // a digit continues the word
    expect(repairKapApostrophe("A?deX")).toBe("A?deX"); // so does a capital
    expect(repairKapApostrophe("A?de.")).toBe("A’de."); // a full stop ends it
  });

  // The left-hand class is [letter, digit, '.', '%']. These shapes appear in the stored rows
  // and are left alone on purpose: each is a different loss (spacing, a closing bracket, an
  // all-capitals suffix), and guessing it would risk touching a real question mark.
  it.each([
    ["Yatırım Bankası A.Ş ?nin 31 Aralık"],
    ["GSD Varlık Yönetim A.Ş.? nin faaliyet"],
    ["Fiyat Tespit Raporu (II-52.1)?nin 12. Maddesi"],
    ["KURULU?NUN ÇALIŞMA ESAS"],
    ["KATAR?DA Tripy Mobility"],
    ["01.01.2023 ? 31.12.2023 Hesap"],
    ["dönüşüm talebi ?Pay Satış Bilgi Formu? olacak şekilde"],
  ])("the known out-of-class shape %j stays as KAP sent it", (input) => {
    expect(repairKapApostrophe(input)).toBe(input);
  });
});

describe("repairKapApostrophe: whitespace", () => {
  it("collapses runs of spaces and tabs to one space", () => {
    expect(repairKapApostrophe("a  b   c\t\td \t e")).toBe("a b c d e");
  });

  it("keeps a single space, a newline and the text around a newline", () => {
    expect(repairKapApostrophe("Limanı?nda\nYeni Terminal")).toBe("Limanı’nda\nYeni Terminal");
    expect(repairKapApostrophe("SERMAYE PİYASASI KURULU?NUN\nII-14.1 SAYILI")).toBe("SERMAYE PİYASASI KURULU?NUN\nII-14.1 SAYILI");
  });
});

describe("repairKapApostrophe: the module is portable and linear", () => {
  it("has no imports, so Deno and Next both load it unchanged", () => {
    const src = readFileSync(new URL("../../../supabase/functions/_shared/kap-text.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });

  const hostile: Array<[string, (n: number) => string]> = [
    ["a long run of repairable pairs", rep("a?de ")],
    ["a '?' that is never followed by a word end", rep("a?", "", "b".repeat(5))],
    ["a thirteen-letter lowercase word after every '?'", rep("a?abcdefghijklm ")],
    ["question marks only", rep("?")],
    ["space padding", rep(" ", "A.Ş.?nin", "x")],
    ["a URL token with query marks", rep("a?b", "https://a.com/")],
    ["a lone 'h' before every '?'", rep("h?x ")],
  ];
  for (const [label, gen] of hostile) {
    it(`scales linearly: ${label}`, () => {
      expectLinear(gen, (s) => repairKapApostrophe(s), { n: 400_000, ceilingMs: 6_000 });
    });
  }
});
