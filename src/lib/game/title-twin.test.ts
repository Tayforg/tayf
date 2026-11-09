import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { crossZoneTwinKeys, twinKey } from "./title-twin";
import { expectLinear, rep } from "../../../tests/_helpers/linear-time";
import type { MediaDnaZone } from "@/types";

const member = (title: string, zone: MediaDnaZone) => ({ title, zone });

describe("twinKey", () => {
  it("gives the same key for a title that differs only in case, apostrophe and final punctuation (Turkish İ/I)", () => {
    // Without the tr-TR lower-casing, "CUMHURBAŞKANI" would fold to
    // "cumhurbaşkani" (dotted i) and never meet the "ı" of the lower-case form.
    expect(twinKey("Cumhurbaşkanı Erdoğan Azerbaycan’a gitti")).toBe(
      twinKey("CUMHURBAŞKANI ERDOĞAN AZERBAYCAN'A GİTTİ."),
    );
  });

  it("keeps the diacritics and drops everything that is not a letter or a number", () => {
    expect(twinKey("Çiğ köfte: 3 kişi 'gözaltına' alındı!")).toBe("çiğköfte3kişigözaltınaalındı");
  });

  it("strips one leading 'SON DAKİKA' prefix, whichever way the I is typed", () => {
    expect(twinKey("SON DAKİKA: Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("SON DAKIKA: Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("Son Dakika | Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("son dakika - Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("SON DAKİKA – Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("SON DAKİKA — Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("SON DAKİKA! Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
  });

  it("strips a leading 'FLAŞ' prefix, with or without the cedilla", () => {
    expect(twinKey("FLAŞ: Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("Flaş! Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("FLAS | Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
  });

  it("strips only ONE prefix and only at the start", () => {
    expect(twinKey("SON DAKİKA: FLAŞ: X haberi")).toBe("flaşxhaberi");
    expect(twinKey("Meclis'ten SON DAKİKA: kararı")).toBe("meclistensondakikakararı");
  });

  it("does not treat a longer word that starts like the prefix as the prefix", () => {
    expect(twinKey("Son dakikada gelen haber")).toBe("sondakikadagelenhaber");
    expect(twinKey("Flaşlar patladı")).toBe("flaşlarpatladı");
    // No separator at all: not a prefix either.
    expect(twinKey("SONDAKİKA haberi")).toBe("sondakikahaberi");
  });

  it("returns '' for an empty or blank title, a title of only punctuation, and a bare prefix", () => {
    expect(twinKey("")).toBe("");
    expect(twinKey("   ")).toBe("");
    expect(twinKey("!!! … ??? —")).toBe("");
    expect(twinKey("SON DAKİKA:")).toBe("");
    expect(twinKey("FLAŞ! ")).toBe("");
  });

  it("keeps digits and treats emoji as separators", () => {
    expect(twinKey("🔴 Dolar 34,50 oldu 🔴")).toBe("dolar3450oldu");
    expect(twinKey("TBMM'de 2. tur oylaması")).toBe("tbmmde2turoylaması");
  });

  it("is not fooled by SQL-looking or markup-looking text", () => {
    expect(twinKey("'; DROP TABLE articles; --")).toBe("droptablearticles");
    expect(twinKey("<b>Meclis</b> kapandı")).toBe("bmeclisbkapandı");
  });

  it("is linear on a very long title (CPU time over a size ladder, not a wall-clock budget)", () => {
    expect(twinKey(rep("halk ", "", "tv")(250_000)).endsWith("tv")).toBe(true);
    expectLinear(rep("halk ", "", "tv"), (title) => twinKey(title), { n: 250_000, ceilingMs: 2_000 });
    // The prefix strip is anchored: a long run of separators after the prefix is linear too.
    expectLinear(rep(" ", "SON DAKİKA:"), (title) => twinKey(title), { n: 250_000, ceilingMs: 2_000 });
  });
});

describe("crossZoneTwinKeys", () => {
  it("returns no key when one zone carries a text twice", () => {
    const keys = crossZoneTwinKeys([
      member("Meclis tatile girdi", "iktidar"),
      member("MECLİS TATİLE GİRDİ.", "iktidar"),
    ]);
    expect(keys.size).toBe(0);
  });

  it("returns the key when two distinct zones carry the same text", () => {
    const keys = crossZoneTwinKeys([
      member("Meclis tatile girdi", "iktidar"),
      member("MECLİS TATİLE GİRDİ.", "muhalefet"),
    ]);
    expect([...keys]).toEqual([twinKey("Meclis tatile girdi")]);
  });

  it("returns one key per twinned text and leaves a text of one zone out", () => {
    const keys = crossZoneTwinKeys([
      member("Birinci haber metni", "iktidar"),
      member("Birinci haber metni", "bagimsiz"),
      member("İkinci haber metni", "bagimsiz"),
      member("İkinci haber metni", "muhalefet"),
      member("Üçüncü haber metni", "muhalefet"),
    ]);
    expect(keys).toEqual(new Set([twinKey("Birinci haber metni"), twinKey("İkinci haber metni")]));
  });

  it("counts three zones as one key", () => {
    const keys = crossZoneTwinKeys([
      member("Aynı metin", "iktidar"),
      member("Aynı metin", "bagimsiz"),
      member("Aynı metin", "muhalefet"),
    ]);
    expect(keys.size).toBe(1);
  });

  it("sees through a breaking-news prefix", () => {
    const keys = crossZoneTwinKeys([
      member("SON DAKİKA: Meclis tatile girdi", "iktidar"),
      member("Meclis tatile girdi", "bagimsiz"),
    ]);
    expect(keys.has(twinKey("Meclis tatile girdi"))).toBe(true);
  });

  it("never adds the empty key, even when two zones both carry an empty-looking title", () => {
    const keys = crossZoneTwinKeys([
      member("", "iktidar"),
      member("   ", "muhalefet"),
      member("SON DAKİKA:", "bagimsiz"),
      member("!!!", "iktidar"),
    ]);
    expect(keys.has("")).toBe(false);
    expect(keys.size).toBe(0);
  });

  it("returns an empty set for no members", () => {
    expect(crossZoneTwinKeys([]).size).toBe(0);
  });

  it("accepts any iterable (a generator, a Set)", () => {
    function* members() {
      yield member("Aynı metin burada", "iktidar");
      yield member("Aynı metin burada", "muhalefet");
    }
    expect(crossZoneTwinKeys(members()).size).toBe(1);
    expect(crossZoneTwinKeys(new Set([member("Tek", "iktidar")])).size).toBe(0);
  });

  it("handles 10,000 members: every twinned text is found, and the cost grows linearly", () => {
    const zones: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];
    // i and i + half share a text but sit in zones (i % 3) and ((i + half) % 3);
    // half = 5000 gives 5000 % 3 = 2, so they always differ.
    const members = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        member(`Haber başlığı numara ${i % (n / 2)}`, zones[i % 3] as MediaDnaZone),
      );

    expect(crossZoneTwinKeys(members(10_000)).size).toBe(5_000);
    expectLinear(members, (list) => crossZoneTwinKeys(list), { n: 10_000, ceilingMs: 4_000 });
  });
});

describe("title-twin source guard", () => {
  const source = readFileSync(resolve(__dirname, "title-twin.ts"), "utf8");

  // Like outlet-leak.ts: nothing in here may pull a server module into a bundle.
  it("imports types only", () => {
    for (const line of source.split("\n")) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("import ")) {
        expect(trimmed.startsWith("import type "), line).toBe(true);
      }
    }
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });
});
