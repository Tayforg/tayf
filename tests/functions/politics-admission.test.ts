import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  POLITICS_CATEGORIES,
  JEV_ADMISSION_POLICY,
  admissionMode,
  parseAdmitTag,
  isPoliticsMember,
  claimArgs,
  routeMessage,
} from "../../supabase/functions/_shared/cluster/politics-admission";
import { admissionEffect } from "../../supabase/functions/_shared/cluster/admission-effect";
import {
  JEV_POLITICS_CATEGORIES,
  taskQuestionFingerprint,
  buildArticleCall,
} from "../../supabase/functions/_shared/jev";

const REPO_ROOT = resolve(__dirname, "..", "..");

describe("admissionMode (strict parse)", () => {
  it.each([
    [undefined, "off"],
    [null, "off"],
    ["", "off"],
    ["1", "off"],
    ["on", "off"],
    ["LIVE", "off"],
    [" live", "off"],
    ["shadow", "shadow"],
    ["live", "live"],
  ] as const)("admissionMode(%s) === %s", (input, expected) => {
    expect(admissionMode(input)).toBe(expected);
  });
});

describe("parseAdmitTag", () => {
  it.each([
    [undefined, null],
    [null, null],
    ["", null],
    ["shadow", "shadow"],
    ["live", "live"],
    ["LIVE", null],
    [1, null],
    [{}, null],
  ] as const)("parseAdmitTag(%o) === %o", (input, expected) => {
    expect(parseAdmitTag(input as unknown)).toBe(expected);
  });
});

describe("isPoliticsMember", () => {
  it("truth table", () => {
    expect(isPoliticsMember(null)).toBe(false);
    expect(isPoliticsMember(undefined)).toBe(false);
    expect(isPoliticsMember({ category: null })).toBe(false);
    expect(isPoliticsMember({ category: "ekonomi" })).toBe(false);
    expect(isPoliticsMember({ category: "politika" })).toBe(true);
    expect(isPoliticsMember({ category: "son_dakika" })).toBe(true);
    expect(isPoliticsMember({ category: "ekonomi", politics_admitted_at: null })).toBe(false);
    expect(
      isPoliticsMember({ category: "ekonomi", politics_admitted_at: "2026-09-28T00:00:00Z" }),
    ).toBe(true);
  });
});

describe("routeMessage", () => {
  const rows: Array<{
    article: { category: string | null; politics_admitted_at?: string | null };
    admit: "shadow" | "live" | null;
    mode: "off" | "shadow" | "live";
    expected: string;
  }> = [
    { article: { category: "politika" }, admit: null, mode: "off", expected: "cluster" },
    { article: { category: "ekonomi" }, admit: null, mode: "shadow", expected: "not-politics" },
    { article: { category: "ekonomi" }, admit: "shadow", mode: "off", expected: "disabled" },
    { article: { category: "ekonomi" }, admit: "shadow", mode: "shadow", expected: "dry-run" },
    { article: { category: "ekonomi" }, admit: "shadow", mode: "live", expected: "dry-run" },
    {
      article: { category: "ekonomi", politics_admitted_at: "2026-09-28T00:00:00Z" },
      admit: "live",
      mode: "live",
      expected: "cluster",
    },
    { article: { category: "ekonomi", politics_admitted_at: null }, admit: "live", mode: "live", expected: "rejected" },
    { article: { category: "ekonomi" }, admit: "live", mode: "shadow", expected: "disabled" },
  ];

  it.each(rows.map((r, i) => [i, r] as const))("row %i", (_i, row) => {
    expect(routeMessage(row.article, row.admit, row.mode)).toBe(row.expected);
  });
});

describe("claimArgs", () => {
  it("equals the policy for shadow and live modes", () => {
    expect(claimArgs("shadow")).toEqual({
      p_mode: "shadow",
      p_live_pins: JEV_ADMISSION_POLICY.livePins,
      p_shadow_pins: JEV_ADMISSION_POLICY.shadowPins,
      p_min_politics: 0.9,
      p_topic7: "politika",
      p_excluded_categories: ["politika", "son_dakika", "dunya"],
      p_max_age: "6 hours",
      p_lookback: "90 minutes",
      p_limit: 20,
    });
    expect(claimArgs("live").p_mode).toBe("live");
    expect(claimArgs("off").p_mode).toBe("shadow");
  });
});

describe("politics-admission.ts import discipline", () => {
  it("has no import statement (must compile under tsc bundler resolution AND deno with no import map)", () => {
    const src = readFileSync(
      resolve(REPO_ROOT, "supabase/functions/_shared/cluster/politics-admission.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it("POLITICS_CATEGORIES matches JEV_POLITICS_CATEGORIES from _shared/jev.ts", () => {
    expect(POLITICS_CATEGORIES).toEqual(JEV_POLITICS_CATEGORIES);
  });

  it("cluster-consumer/index.ts has no local ['politika', 'son_dakika'] literal", () => {
    const src = readFileSync(
      resolve(REPO_ROOT, "supabase/functions/cluster-consumer/index.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\[\s*["']politika["']\s*,\s*["']son_dakika["']\s*\]/);
  });
});

describe("pin guard: shadowPins/livePins must track the live question text", () => {
  it("the pinned (politics, topic7) fingerprint pair is in livePins or shadowPins", () => {
    const politicsFp = taskQuestionFingerprint("politics");
    const topic7Fp = taskQuestionFingerprint("topic7");
    const pins = [...JEV_ADMISSION_POLICY.livePins, ...JEV_ADMISSION_POLICY.shadowPins];
    const found = pins.some((p) => p.politics === politicsFp && p.topic7 === topic7Fp);
    expect(
      found,
      "politics/topic7 text changed: add the new pair to shadowPins, run >=48 h shadow + >=50 stratified reviews, then move to livePins",
    ).toBe(true);
  });
});

describe("framing guard", () => {
  it("buildArticleCall asks 'framing' for every category, including ekonomi/genel/yasam/spor/teknoloji/null", () => {
    for (const category of ["ekonomi", "genel", "yasam", "spor", "teknoloji", null]) {
      const request = buildArticleCall({
        id: "a1",
        title: "Başlık",
        description: "Açıklama",
        category,
        published_at: new Date().toISOString(),
        source_slug: "kaynak",
      });
      expect(request.questions).toHaveProperty("framing");
    }
  });
});

describe("admissionEffect", () => {
  const outlet = (bias: string) => ({ bias, kind: "outlet" as const });

  it("blindspot withdrawn: another silent-zone source drops the dominant share below 0.8", () => {
    const before = [
      outlet("pro_government"),
      outlet("pro_government"),
      outlet("pro_government"),
      outlet("pro_government"),
      outlet("opposition"),
    ];
    const added = outlet("opposition");
    const effect = admissionEffect(before as never, added as never);
    expect(effect.blindspotBefore).toBe(true);
    expect(effect.blindspotAfter).toBe(false);
  });

  it("blindspot created: a 5th same-zone source tips a cluster into one", () => {
    const before = [
      outlet("pro_government"),
      outlet("pro_government"),
      outlet("pro_government"),
      outlet("pro_government"),
    ];
    const added = outlet("gov_leaning");
    const effect = admissionEffect(before as never, added as never);
    expect(effect.blindspotBefore).toBe(false);
    expect(effect.blindspotAfter).toBe(true);
  });

  it("zone added: added source's zone absent from before", () => {
    const before = [outlet("pro_government"), outlet("pro_government")];
    const added = outlet("opposition");
    const effect = admissionEffect(before as never, added as never);
    expect(effect.zoneAdded).toBe(true);
  });

  it("an aggregator never votes", () => {
    const before = [outlet("pro_government"), outlet("pro_government")];
    const added = { bias: "opposition", kind: "aggregator" };
    const effect = admissionEffect(before as never, added as never);
    expect(effect.zoneAdded).toBe(false);
    expect(effect.blindspotBefore).toBe(effect.blindspotAfter);
  });

  it("a null source is ignored (after equals before, zoneAdded false)", () => {
    const before = [outlet("pro_government"), outlet("pro_government")];
    const effect = admissionEffect(before as never, null);
    expect(effect.zoneAdded).toBe(false);
    expect(effect.blindspotBefore).toBe(effect.blindspotAfter);
  });
});
