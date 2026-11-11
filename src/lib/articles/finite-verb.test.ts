import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { expectLinear } from "../../../tests/_helpers/linear-time";
import type { Gen } from "../../../tests/_helpers/linear-time";
import { hasFiniteVerb as hasFiniteVerbViaAgreement } from "../clusters/summary-agreement";
import { endsWithFiniteVerb, hasFiniteVerb } from "./finite-verb";

// h112-ozetregress-1: hasFiniteVerb moved out of clusters/summary-agreement.ts so that
// summary-tidy.ts can use it. summary-agreement.test.ts keeps the full behaviour tables
// (it imports the name through the re-export); this file pins the move itself.
describe("finite-verb.ts (moved out of summary-agreement.ts, h112-ozetregress-1)", () => {
  it("summary-agreement re-exports the very same function", () => {
    expect(hasFiniteVerbViaAgreement).toBe(hasFiniteVerb);
  });

  it.each([
    ["past", "Bakan açıklama yaptı"],
    ["progressive", "Fiyatlar yükseliyor"],
    ["future", "Bakan yarın açıklama yapacak"],
    ["existential", "Saldırılara karşı taviz yok"],
    ["a lower-case verb behind capitalised names", "Numan Kurtulmuş ve Cevdet Yılmaz toplantıya katıldı"],
  ])("a finite verb: %s", (_label, text) => {
    expect(hasFiniteVerb(text)).toBe(true);
  });

  it.each([
    ["a noun phrase", "İşte kamuoyuna açıklanan önemli isimler ve görevleri."],
    ["a name that ends like a reported past", "TBMM Başkanı Numan Kurtulmuş, Cumhurbaşkanı Yardımcısı Cevdet Yılmaz"],
    ["Suudi Arabistan", "Suudi Arabistan ve Hindi kedi"],
    ["an apostrophe suffix", "Washington'dı"],
    ["empty", ""],
  ])("no finite verb: %s", (_label, text) => {
    expect(hasFiniteVerb(text)).toBe(false);
  });

  it("is false for a non-string and never throws", () => {
    expect(hasFiniteVerb(undefined as unknown as string)).toBe(false);
    expect(hasFiniteVerb(null as unknown as string)).toBe(false);
    expect(hasFiniteVerb(42 as unknown as string)).toBe(false);
  });

  it("imports from neither summary-tidy nor summary-agreement (summary-agreement imports summary-tidy: a cycle otherwise)", () => {
    const source = readFileSync(new URL("./finite-verb.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of specifiers) {
      expect(spec, spec).not.toMatch(/summary-(?:tidy|agreement)/);
    }
  });
});

// h113 correctness-2: summary-tidy.ts asks whether a SENTENCE ends in a finite verb. Turkish puts the
// predicate last, so a participle in front of a noun ("yapılacak zam oranı") or a word that ends like a
// past tense ("kendi", "yedi") does not make a statement. hasFiniteVerb (any word) stays as it was:
// summary-agreement.ts reads whole texts with it.
describe("endsWithFiniteVerb (h113 correctness-2)", () => {
  it.each([
    ["progressive", "Eyalette yaşanıyor."],
    ["past", "Bakan açıklama yaptı"],
    ["future", "Bakan yarın açıklama yapacak."],
    ["a verb behind participles", "İşte uygulanacak yeni kurallar bugün yürürlüğe girdi."],
    ["closing marks behind the verb", "Karar açıklandı.”"],
    ["a closing bracket behind the verb", "(Bakanlık duyurdu.)"],
    ["a single word that is a verb", "Yaşanıyor."],
    ["an all-caps headline ends in a verb", "ERDOĞAN GÜNEY KORE'DEN AYRILDI"],
    ["existential predicate", "Saldırılara karşı taviz yok."],
  ])("a finite verb is the last word: %s", (_label, text) => {
    expect(endsWithFiniteVerb(text)).toBe(true);
  });

  it.each([
    ["a participle in front of nouns", "İşte uygulanacak yeni kurallar."],
    ["a future participle, then nouns", "İşte asgari ücrete yapılacak zam oranı."],
    ["a participle, then a noun phrase", "İşte emeklilere verilecek bayram ikramiyesi miktarı."],
    ["'kendi' in the middle", "İşte kendi ilinizin durumu."],
    ["'yedi' in the middle", "İşte ilk yedi madde."],
    ["a verb followed by a noun", "Bakan açıklama yaptı bugün."],
    ["a capitalised name that ends like a reported past", "Toplantıya TBMM Başkanı Numan Kurtulmuş"],
    ["Suudi Arabistan", "Yarın Suudi Arabistan"],
    ["an apostrophe suffix on the last word", "Washington'dı"],
    ["a noun phrase", "İşte COP31 Başkanı hakkında bilinenler."],
    ["no word at all", "…?!"],
    ["empty", ""],
    ["blank", "   "],
  ])("the last word is not a finite verb: %s", (_label, text) => {
    expect(endsWithFiniteVerb(text)).toBe(false);
  });

  it("the two cases of the finding", () => {
    expect(endsWithFiniteVerb("İşte uygulanacak yeni kurallar.")).toBe(false);
    expect(endsWithFiniteVerb("Eyalette yaşanıyor.")).toBe(true);
    // hasFiniteVerb still reads the participle as a verb: it is unchanged
    expect(hasFiniteVerb("İşte uygulanacak yeni kurallar.")).toBe(true);
  });

  it("a lone capitalised word at the start of the text is read, one behind a word is a name", () => {
    expect(endsWithFiniteVerb("Kazandı")).toBe(true);
    expect(endsWithFiniteVerb("Bakan açıkladı: Kazandık")).toBe(true);
    expect(endsWithFiniteVerb("Bakan Kurtulmuş")).toBe(false);
  });

  it("is false for a non-string and never throws", () => {
    expect(endsWithFiniteVerb(undefined as unknown as string)).toBe(false);
    expect(endsWithFiniteVerb(null as unknown as string)).toBe(false);
    expect(endsWithFiniteVerb(42 as unknown as string)).toBe(false);
  });

  it("is linear: a long sentence is read in one pass, whether it ends in a verb or not", () => {
    const verb: Gen = (n) => "kelime ".repeat(Math.ceil(n / 7)) + "yaşanıyor.";
    const noun: Gen = (n) => "kelime ".repeat(Math.ceil(n / 7)) + "sonuç.";
    for (const gen of [verb, noun]) {
      expectLinear(gen, (s) => endsWithFiniteVerb(s), { n: 100_000, ceilingMs: 2_000 });
    }
  });
});
