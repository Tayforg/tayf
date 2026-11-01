import { describe, it, expect } from "vitest";
import {
  headlineLane,
  isMatch,
  score,
} from "../../../supabase/functions/_shared/cluster/ensemble.ts";
import { headlineTokens } from "../../../supabase/functions/_shared/cluster/fingerprint.ts";
import {
  HEADLINE_LANE_MIN_SHARED,
  HEADLINE_LIVE_TITLE_MAX_HOURS,
  HEADLINE_SHORT_MIN_TOKENS,
} from "../../../supabase/functions/_shared/cluster/constants.ts";

// h12-cluster-3: same-story pairs the headline lane missed, with the verbatim
// production titles of 2026-10-30..11-01 (scratchpad ana/pairs.mjs). Each
// "MUST FIRE" pair was a real split (two live clusters for one story), each
// "MUST NOT FIRE" pair is a lookalike that is a different development or a
// different story and must stay apart.

const lane = (a: string, b: string, hours = 1) =>
  headlineLane(headlineTokens(a), headlineTokens(b), hours);

const noFp = { strict: null, signature: null };

describe("headline lane: real same-story pairs fire", () => {
  it("Bahçeli '100 il 1000 ilçe' vs '19 yeni il ve 78 ilçe': a numeral class shift, containment", () => {
    const a = "Bahçeli'den 100 il 1000 ilçe çıkışı! Türkiye'nin idari haritası değişebilir";
    const b = "Türkiye'nin idari haritası değişebilir! Bahçeli'den 19 yeni il ve 78 ilçe önerisi";
    const r = lane(a, b);
    expect(r.fired).toBe(true);
    expect(r.kind).toBe("containment");
    expect(r.containment).toBeGreaterThanOrEqual(0.85);
    // The numerals differ ({100,1000} vs {19,78}) and are not a single-slot change.
    expect(headlineTokens(a).numbers).toEqual(new Set(["100", "1000"]));
    expect(headlineTokens(b).numbers).toEqual(new Set(["19", "78"]));
    // The pair is carried through the full scorer with no entity or text help.
    const full = score(noFp, noFp, [], [], 0.2, 1, { aTitle: a, bTitle: b });
    expect(full.components.headlineKind).toBe("containment");
    expect(isMatch(full)).toBe(true);
  });

  it("Bakırköy 39a still fires (Jaccard)", () => {
    const r = lane(
      "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı",
      "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı",
    );
    expect(r.fired).toBe(true);
    expect(r.kind).toBe("jaccard");
  });

  it("Bakırköy 39b fires: belediyesi / Belediyesine and soruşturmada / soruşturma share a stem", () => {
    const a = "Bakırköy Belediyesi'ne soruşturmada 39 kişiye tutuklama";
    const b = "Bakırköy Belediyesine yönelik soruşturmada 39 tutuklama";
    const r = lane(a, b);
    expect(r.fired).toBe(true);
    expect(r.shared).toBeGreaterThanOrEqual(HEADLINE_LANE_MIN_SHARED);
    expect(isMatch(score(noFp, noFp, [], [], 0.25, 1, { aTitle: a, bTitle: b }))).toBe(true);
  });

  it("two 'CANLI | Cumhurbaşkanı Erdoğan konuşuyor' from different outlets inside 10 minutes join as live-title", () => {
    const t = "CANLI | Cumhurbaşkanı Erdoğan konuşuyor";
    // Every word is wire boilerplate, so the headline reduces to no tokens.
    expect(headlineTokens(t).tokens.size).toBe(0);
    const r = lane(t, t, 0.1);
    expect(r.fired).toBe(true);
    expect(r.kind).toBe("live-title");
    // The lane's usual score formula, with no shared-token similarity.
    expect(r.score).toBeCloseTo(0.5 + 0.5 * r.sim, 12);
    const full = score(noFp, noFp, [], [], 0.1, 0.1, { aTitle: t, bTitle: t });
    expect(full.components.headlineKind).toBe("live-title");
    expect(full.components.headlineLane).toBe(true);
    expect(isMatch(full)).toBe(true);
  });

  it("the live-title window is HEADLINE_LIVE_TITLE_MAX_HOURS: fires at the limit, not 0.5 h", () => {
    const a = "CANLI | Cumhurbaşkanı Erdoğan konuşuyor";
    const b = "Canlı: Cumhurbaşkanı Erdoğan konuşuyor";
    expect(HEADLINE_LIVE_TITLE_MAX_HOURS).toBeCloseTo(10 / 60, 12);
    expect(lane(a, b, HEADLINE_LIVE_TITLE_MAX_HOURS).kind).toBe("live-title");
    expect(lane(a, b, HEADLINE_LIVE_TITLE_MAX_HOURS + 0.01).fired).toBe(false);
    const late = lane(a, a, 0.5);
    expect(late.fired).toBe(false);
    expect(late.kind).toBeNull();
    expect(late.score).toBe(0);
  });

  it("short identical headlines join: Zelenskiy / Zelenski alias plus Zelenskiy'i / Zelenski'yi", () => {
    const a = "Erdoğan, Zelenskiy'i kabul etti";
    const b = "Erdoğan Zelenski'yi kabul etti";
    const ha = headlineTokens(a);
    const hb = headlineTokens(b);
    expect(ha.tokens.size).toBeGreaterThanOrEqual(HEADLINE_SHORT_MIN_TOKENS);
    expect(ha.tokens.size).toBeLessThan(HEADLINE_LANE_MIN_SHARED);
    expect(ha.tokens).toEqual(hb.tokens);
    const r = lane(a, b);
    expect(r.fired).toBe(true);
    expect(r.kind).toBe("jaccard");
    // ...but not outside the 6 h window.
    expect(lane(a, b, 7).fired).toBe(false);
  });
});

describe("headline lane: lookalikes stay apart", () => {
  it("same slot, different number: '40 tutuklama talebi' vs '39 kişi tutuklandı'", () => {
    const r = lane(
      "Bakırköy Belediyesi soruşturmasında 40 tutuklama talebi",
      "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı",
    );
    expect(r.fired).toBe(false);
    expect(r.kind).toBeNull();
  });

  it("61 vs 39 suspects are different developments", () => {
    const r = lane(
      "Bakırköy Belediyesi soruşturmasında 61 kişi tutuklandı",
      "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı",
    );
    expect(r.fired).toBe(false);
  });

  it("a digit-length class shift needs at least one numeral on each side and no shared value", () => {
    // Shared value 39: a partial change, not a different cardinality class.
    expect(
      lane(
        "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı",
        "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı, 22 kişi adli kontrolle serbest",
      ).fired,
    ).toBe(false);
  });

  it("Lavrov vs Fidan (same Japanese counterpart, different foreign minister)", () => {
    const r = lane(
      "Lavrov, Japon mevkidaşı Motegi ile görüştü",
      "Fidan, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü",
    );
    expect(r.fired).toBe(false);
  });

  it("the Zelenskiy alias does not merge different counterparts", () => {
    const r = lane("Erdoğan Zelenskiy'i kabul etti", "Erdoğan Lavrov'u kabul etti");
    expect(r.fired).toBe(false);
    expect(r.kind).toBeNull();
  });

  it("a CANLI title vs a different zero-token title does not fire", () => {
    const a = "CANLI | Cumhurbaşkanı Erdoğan konuşuyor";
    const b = "CANLI | Erdoğan konuşuyor";
    expect(headlineTokens(a).tokens.size).toBe(0);
    expect(headlineTokens(b).tokens.size).toBe(0);
    expect(lane(a, b, 0.05).fired).toBe(false);
  });

  it("a zero-token title never matches a title that still has tokens", () => {
    const live = "CANLI | Cumhurbaşkanı Erdoğan konuşuyor";
    const other = "Cumhurbaşkanı Erdoğan konuşuyor: Ekonomi programı açıklandı";
    expect(lane(live, other, 0.05).fired).toBe(false);
    expect(lane(other, live, 0.05).fired).toBe(false);
  });

  it("two identical one-token headlines do not fire (below HEADLINE_SHORT_MIN_TOKENS)", () => {
    const t = "Deprem!";
    const h = headlineTokens(t);
    expect(h.tokens.size).toBe(1);
    expect(h.tokens.size).toBeLessThan(HEADLINE_SHORT_MIN_TOKENS);
    const r = lane(t, t, 0.01);
    expect(r.fired).toBe(false);
    expect(r.kind).toBeNull();
  });

  it("two identical empty headlines do not fire (no live key, no tokens)", () => {
    expect(lane("", "", 0.01).fired).toBe(false);
    expect(lane("son dakika", "son dakika", 0.01).fired).toBe(false);
  });

  it("short identical sets of different words do not fire", () => {
    expect(lane("Kabine toplandı", "Meclis toplandı").fired).toBe(false);
  });
});

describe("headline lane: lexically unreachable residuals (documented, not fixed)", () => {
  // These real same-story pairs share too few tokens for any lexical rule that
  // does not also admit unrelated pairs; the entity / tf-idf lanes or Jev have
  // to carry them. The token dumps document why.
  // "Karar Resmi Gazete'de: SPK Başkanlığına Muhsin Atcı atandı"
  // "Sermaye Piyasası Kurulu (SPK) Başkanı Muhsin Atcı oldu"
  it.todo("SPK paraphrase: sim 0.25, shared 3, containment 0.43; A=[karar resmi gazete spk baskanligi muhsin atci atan] B=[serma piyasa kurulu spk baskani muhsin atci]");
  // "Ukrayna Devlet Başkanı Zelenski İstanbul'a geldi"
  // "Zelenski İstanbul’a geldi: Erdoğan ile görüşecek"
  it.todo("Zelenski arrival (containment 3/4): sim 0.43, shared 3, containment 0.75; A=[ukray devlet baskani zelenski istanbul geldi] B=[zelenski istanbul geldi gorusecek]");
  // "Erdoğan ile Zelenskiy Dolmabahçe'de görüştü"
  // "Cumhurbaşkanı Erdoğan, Ukrayna Devlet Başkanı Zelenskiy ile görüştü"
  it.todo("Erdoğan-Zelenskiy Dolmabahçe (2 shared): sim 0.33, shared 2, containment 0.67; A=[zelenski dolmabahce gorustu] B=[ukray devlet baskani zelenski gorustu]");
  // "Cumhurbaşkanı Erdoğan, Güney Kore'ye gidiyor! Hedef 15 milyar dolar"
  // "Başkan Erdoğan, Güney Kore'yi ziyaret edecek! Hedef 15 milyar dolar"
  it.todo("Korea (containment 5/6): sim 0.60, shared 6, containment 0.83; A=[guney kore gidiyor hedef 15 milyar dolar] B=[baskan guney kore ziyaret edecek hedef 15 milyar dolar]");
  // "Bahçeli '100 il 1000 ilçe projesi'ni açıkladı"
  // "Bahçeli'den 19 yeni il ve 78 yeni ilçe kurulması önerisi"
  it.todo("Bahçeli 'projesi' variant (4 words): sim 0.17, shared 2, containment 0.50; A=[bahceli 100 1000 ilce proje acikla] B=[bahceli den 19 yeni 78 ilce kurulma oneri]");
});
