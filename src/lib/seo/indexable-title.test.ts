import { describe, expect, it } from "vitest";

import { hasIndexableTitle, servedClusterTitle } from "./indexable-title";

// The title the cluster page serves is `title_tr_neutral` when it has text and
// `title_tr` otherwise (cluster-detail-query.ts). The page keeps a cluster whose
// served title is a question or an SEO explainer out of the index (h34-reader-2);
// the sitemaps and IndexNow must apply the same test to the same title, or they
// submit URLs that answer `noindex` ("Submitted URL marked noindex").

describe("servedClusterTitle", () => {
  it("is the neutral title when it has text", () => {
    expect(servedClusterTitle({ title_tr: "Ham", title_tr_neutral: "Tarafsız" })).toBe("Tarafsız");
  });

  it.each([null, undefined, "", "   ", "\n\t"])("falls back to title_tr for a blank neutral title (%j)", (neutral) => {
    expect(servedClusterTitle({ title_tr: "Ham", title_tr_neutral: neutral })).toBe("Ham");
  });

  it("is an empty string when the row carries no title at all", () => {
    expect(servedClusterTitle({})).toBe("");
    expect(servedClusterTitle({ title_tr: null, title_tr_neutral: null })).toBe("");
  });

  it("ignores a non-string title instead of throwing", () => {
    expect(servedClusterTitle({ title_tr: 7 as unknown as string, title_tr_neutral: {} as unknown as string })).toBe("");
  });
});

describe("hasIndexableTitle", () => {
  it("is true for an ordinary headline", () => {
    expect(hasIndexableTitle({ title_tr: "Merkez Bankası faizi sabit tuttu", title_tr_neutral: null })).toBe(true);
  });

  it.each([
    "Saniye Caran kimdir? Kaç yaşında, nereli?",
    "Merkez Bankası faizi düşürecek mi?",
    "Saniye Caran kimdir kaç yaşında nereli",
    "Seçim ne zaman yapılacak",
  ])("is false when the served title is a question or an explainer: %s", (title) => {
    expect(hasIndexableTitle({ title_tr: title, title_tr_neutral: null })).toBe(false);
  });

  it("tests the SERVED title: a question in the neutral title is not indexable", () => {
    expect(hasIndexableTitle({ title_tr: "Faiz kararı açıklandı", title_tr_neutral: "Faiz ne olacak?" })).toBe(false);
  });

  it("tests the SERVED title: a plain neutral title over a question seed is indexable (the page serves the neutral one)", () => {
    expect(hasIndexableTitle({ title_tr: "Saniye Caran kimdir?", title_tr_neutral: "Saniye Caran CHP'den istifa etti" })).toBe(true);
  });

  it("a blank neutral title leaves title_tr in charge", () => {
    expect(hasIndexableTitle({ title_tr: "Saniye Caran kimdir?", title_tr_neutral: "  " })).toBe(false);
  });

  it("is true for a row with no title (nothing to judge; the article-count gate decides)", () => {
    expect(hasIndexableTitle({})).toBe(true);
    expect(hasIndexableTitle({ title_tr: null, title_tr_neutral: null })).toBe(true);
  });

  it("is the same verdict the cluster page uses: isQuestionTitle on the served title", async () => {
    const { isQuestionTitle } = await import("@/lib/clusters/neutral-title");
    for (const t of ["Düz başlık", "Soru mu?", "Bu kimdir", "Seçim ne zaman"]) {
      expect(hasIndexableTitle({ title_tr: t })).toBe(!isQuestionTitle(t));
    }
  });
});
