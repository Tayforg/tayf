import { describe, expect, it } from "vitest";

import { BLINDSPOT } from "@/lib/bias/config";
import { TICKER_RELEVANCE_MIN } from "@/lib/finance/kap-pickup";

import { API_PLANS, V1_COMMON_NOTES_TR, V1_ENDPOINTS } from "./v1-docs";

// h27/h29: the developer page and the OpenAPI document are Turkish copy, and
// Turkish writes a decimal with a comma ("0,2", not "0.2"). The kap pickup note
// printed the ticker_relevance cut-off as "0.2". The Turkish text now derives
// the number from TICKER_RELEVANCE_MIN through Intl.NumberFormat("tr-TR"); the
// English text and the JSON field values keep the ASCII point.

/** Every Turkish string the module exposes, tagged with where it sits. */
function turkishStrings(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const ep of V1_ENDPOINTS) {
    const at = `${ep.method} ${ep.path}`;
    out.push({ where: `${at} summaryTr`, text: ep.summaryTr });
    ep.notesTr.forEach((text, i) => out.push({ where: `${at} notesTr[${i}]`, text }));
    for (const p of ep.params) {
      out.push({ where: `${at} param ${p.name} descriptionTr`, text: p.descriptionTr });
    }
    for (const r of ep.responses) {
      out.push({ where: `${at} response ${r.status} descriptionTr`, text: r.descriptionTr });
    }
  }
  V1_COMMON_NOTES_TR.forEach((text, i) => out.push({ where: `V1_COMMON_NOTES_TR[${i}]`, text }));
  for (const plan of API_PLANS) {
    out.push({ where: `plan ${plan.tier} labelTr`, text: plan.labelTr });
    out.push({ where: `plan ${plan.tier} howTr`, text: plan.howTr });
    if (plan.priceTr !== null) out.push({ where: `plan ${plan.tier} priceTr`, text: plan.priceTr });
  }
  return out;
}

/**
 * ASCII `digit.digit` occurrences in a Turkish string, as the matched text with
 * its offset. A version token directly preceded by `OpenAPI ` or `RSS ` is not a
 * decimal and is allowed.
 */
function asciiDecimals(text: string): { match: string; index: number }[] {
  const found: { match: string; index: number }[] = [];
  for (const m of text.matchAll(/\d\.\d/g)) {
    const index = m.index ?? 0;
    const before = text.slice(0, index);
    if (before.endsWith("OpenAPI ") || before.endsWith("RSS ")) continue;
    found.push({ match: m[0], index });
  }
  return found;
}

const trNumber = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 });

describe("kap pickup relevance note (Turkish decimal)", () => {
  const pickup = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/kap/pickup");

  it("exists", () => {
    expect(pickup).toBeDefined();
  });

  it("writes the cut-off with a decimal comma", () => {
    const note = pickup!.notesTr.find((n) => n.startsWith("relevance_filter:"));
    expect(note).toBeDefined();
    expect(note).toContain("0,2 altında");
    expect(note).not.toContain("0.2");
  });

  it("derives the number from TICKER_RELEVANCE_MIN, so the constant and the copy cannot drift", () => {
    const note = pickup!.notesTr.find((n) => n.startsWith("relevance_filter:"))!;
    expect(TICKER_RELEVANCE_MIN).toBe(0.2);
    expect(note).toContain(`modelinin ${trNumber.format(TICKER_RELEVANCE_MIN)} altında puanladığı`);
  });

  it("keeps the English text free of a Turkish decimal comma", () => {
    expect(pickup!.summaryEn).not.toMatch(/\d,\d/);
    for (const r of pickup!.responses) expect(r.descriptionEn).not.toMatch(/\d,\d/);
    for (const p of pickup!.params) expect(p.descriptionEn).not.toMatch(/\d,\d/);
  });
});

// Review fix editorial-3: the site shows the "Kör nokta" pill BLINDSPOT.feedDelayHours
// after first_published on every gated surface; /api/v1/clusters returns the stored
// flag minus the recall veto without waiting. A consumer must not read the field as
// the site's pill.
describe("/api/v1/clusters is_blindspot notes (editorial-3)", () => {
  const clusters = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/clusters");

  it("exists", () => {
    expect(clusters).toBeDefined();
  });

  it("keeps the recall-veto note", () => {
    expect(clusters!.notesTr).toContain("is_blindspot, sitenin kör nokta geri çağırma (recall veto) kuralını uygular.");
  });

  it("adds a note that the site waits BLINDSPOT.feedDelayHours and this endpoint does not, pointing at the alerts feed", () => {
    expect(BLINDSPOT.feedDelayHours).toBe(24);
    const note = clusters!.notesTr.find((n) => n.startsWith("Site, kör nokta etiketini"));
    expect(note).toBe(
      `Site, kör nokta etiketini kartlarda ve haber sayfasında ilk yayından ${BLINDSPOT.feedDelayHours} saat sonra gösterir; bu uç nokta etiketi beklemeden döndürür (beklemeyi uygulayan liste: /api/v1/alerts/blindspots).`,
    );
  });

  it("puts the delay note right after the recall-veto note", () => {
    const notes = clusters!.notesTr;
    const veto = notes.findIndex((n) => n.startsWith("is_blindspot, sitenin kör nokta geri çağırma"));
    const wait = notes.findIndex((n) => n.startsWith("Site, kör nokta etiketini"));
    expect(veto).toBeGreaterThanOrEqual(0);
    expect(wait).toBe(veto + 1);
  });
});

// h47-reports-1: GET /api/v1/clusters floors a cluster at article_count >= 2
// (the site's own floor); the developer page has to say so, and say where the
// floor does not apply.
describe("/api/v1/clusters article_count floor note (h47-reports-1)", () => {
  const clusters = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/clusters");
  const FLOOR_NOTE =
    "Tek haberden oluşan kümeler (article_count < 2) bu listede yer almaz; tek küme okuması (GET /api/v1/clusters/{id}) bu süzgeci uygulamaz.";

  it("carries the Turkish floor sentence exactly once", () => {
    expect(clusters!.notesTr.filter((n) => n === FLOOR_NOTE)).toHaveLength(1);
  });

  it("sits right after the politics-majority note it qualifies", () => {
    const notes = clusters!.notesTr;
    const politics = notes.findIndex((n) => n.startsWith("Yalnızca üyelerinin en az %"));
    expect(politics).toBeGreaterThanOrEqual(0);
    expect(notes[politics + 1]).toBe(FLOOR_NOTE);
  });
});

// The page renders each note as plain text, so a markdown backtick would show
// as a raw character; and a note is for a partner, not an incident log.
describe("Turkish strings of the v1 docs are plain text (h47-reports-1)", () => {
  it("no Turkish string carries a backtick", () => {
    const offenders = turkishStrings()
      .filter((s) => s.text.includes("`"))
      .map((s) => s.where);
    expect(offenders, "write the field name bare; the page does not render markdown").toEqual([]);
  });

  it("the kap/pickup notes do not recite the internal production timeout", () => {
    const pickup = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/kap/pickup")!;
    const joined = pickup.notesTr.join(" ");
    expect(joined).not.toContain("üretimde");
    expect(joined).not.toContain("60 saniye");
    // The behaviour that aside qualified is still documented.
    expect(joined).toContain("disclosure_coverage görünümü asla sorgulanmaz;");
  });

  it("keeps the capped / total_disclosures / truncated explanation, without the backticks", () => {
    const pickup = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/kap/pickup")!;
    const note = pickup.notesTr.find((n) => n.startsWith("capped: true ise"));
    expect(note).toBeDefined();
    expect(note).toContain("liste limit sınırına ulaştı");
    expect(note).toContain("total_disclosures:");
    expect(note).toContain("truncated: true ise");
  });

  // h109: a replaced original is left out of the list, count and totals but not of total_disclosures.
  it("explains superseded, and that count + superseded = total_disclosures while capped is false, without the backticks", () => {
    const pickup = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/kap/pickup")!;
    const note = pickup.notesTr.find((n) => n.startsWith("superseded:"));
    expect(note).toBeDefined();
    expect(note).toContain("düzelt");
    expect(note).toContain("capped false iken count + superseded = total_disclosures");
    expect(note).not.toContain("`");
  });
});

describe("Turkish strings of the v1 docs carry no ASCII decimal", () => {
  it("scans a plausible number of strings (not vacuous)", () => {
    const all = turkishStrings();
    expect(all.length).toBeGreaterThan(60);
    expect(all.some((s) => s.where.includes("notesTr") && s.text.includes("relevance_filter"))).toBe(true);
    expect(all.some((s) => s.where.includes("param") && s.where.includes("descriptionTr"))).toBe(true);
    expect(all.some((s) => s.where.startsWith("plan "))).toBe(true);
  });

  it("no Turkish string writes digit.digit except an OpenAPI or RSS version token", () => {
    const offenders: string[] = [];
    for (const { where, text } of turkishStrings()) {
      for (const hit of asciiDecimals(text)) {
        offenders.push(`${where} @${hit.index}: "${hit.match}" in "${text.slice(Math.max(0, hit.index - 20), hit.index + 20)}"`);
      }
    }
    expect(offenders, "write the Turkish decimal with a comma (Intl.NumberFormat('tr-TR')) or a percent").toEqual([]);
  });

  it("the scanner flags a decimal, ignores an OpenAPI/RSS version and flags a bare version", () => {
    expect(asciiDecimals("eşik 0.2 altında")).toEqual([{ match: "0.2", index: 5 }]);
    expect(asciiDecimals("OpenAPI 3.1 tanımı")).toEqual([]);
    expect(asciiDecimals("RSS 2.0 döner")).toEqual([]);
    expect(asciiDecimals("0,2 altında")).toEqual([]);
    expect(asciiDecimals("HTTP 1.1 ile")).toEqual([{ match: "1.1", index: 5 }]);
    expect(asciiDecimals("OpenAPI 3.1 ve 0.5")).toEqual([{ match: "0.5", index: 15 }]);
  });
});
