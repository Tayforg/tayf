import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  POLITICS_CATEGORIES,
  JEV_ADMISSION_POLICY,
  admissionMode,
  attachMode,
  parseAdmitTag,
  isPoliticsMember,
  claimArgs,
  routeMessage,
  ATTACH_MODE_ENV,
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

describe("attachMode (CLUSTER_ATTACH_MODE, strict parse; hunt-25 W3)", () => {
  // The attach probe ships in SHADOW: unset is shadow, only the exact string
  // "off" disables it and only the exact string "live" lets it write clusters.
  // Garbage, a stray case or a stray space NEVER means live.
  it.each([
    ["off", "off"],
    ["shadow", "shadow"],
    ["live", "live"],
    [undefined, "shadow"],
    [null, "shadow"],
    ["", "shadow"],
    ["LIVE", "shadow"],
    ["Live", "shadow"],
    [" live", "shadow"],
    ["live ", "shadow"],
    ["OFF", "shadow"],
    ["on", "shadow"],
    ["1", "shadow"],
    ["true", "shadow"],
    ["attach", "shadow"],
  ] as const)("attachMode(%o) === %s", (input, expected) => {
    expect(attachMode(input)).toBe(expected);
  });

  it("only the exact string 'live' ever yields live", () => {
    for (const junk of ["LIVE", "Live", " live", "live ", "live\n", "yes", "on", "1", "true", "liv", "lives", "\u200blive"]) {
      expect(attachMode(junk)).not.toBe("live");
    }
    expect(attachMode("live")).toBe("live");
  });

  it("names its environment variable", () => {
    expect(ATTACH_MODE_ENV).toBe("CLUSTER_ATTACH_MODE");
  });
});

describe("parseAdmitTag", () => {
  it.each([
    [undefined, null],
    [null, null],
    ["", null],
    ["shadow", "shadow"],
    ["live", "live"],
    ["attach", "attach"],
    ["LIVE", null],
    ["ATTACH", null],
    [" attach", null],
    ["attach ", null],
    [1, null],
    [{}, null],
    [["attach"], null],
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

  it("every existing row is unchanged whatever the attach mode is (the attach rule applies only to admit === 'attach')", () => {
    for (const attach of ["off", "shadow", "live"] as const) {
      for (const row of rows) {
        expect(routeMessage(row.article, row.admit, row.mode, attach)).toBe(row.expected);
      }
    }
  });
});

describe("routeMessage: the attach tag (hunt-25 W3)", () => {
  const attachRows: Array<{
    name: string;
    article: { category: string | null; politics_admitted_at?: string | null };
    jev: "off" | "shadow" | "live";
    attach: "off" | "shadow" | "live";
    expected: string;
  }> = [
    { name: "genel, attach shadow", article: { category: "genel" }, jev: "off", attach: "shadow", expected: "attach" },
    { name: "genel, attach live", article: { category: "genel" }, jev: "off", attach: "live", expected: "attach" },
    { name: "ekonomi, attach shadow", article: { category: "ekonomi" }, jev: "off", attach: "shadow", expected: "attach" },
    { name: "null category, attach shadow", article: { category: null }, jev: "off", attach: "shadow", expected: "attach" },
    { name: "genel, attach off", article: { category: "genel" }, jev: "off", attach: "off", expected: "disabled" },
    { name: "genel, attach off, even with live Jev", article: { category: "genel" }, jev: "live", attach: "off", expected: "disabled" },
    { name: "politika is in the gate", article: { category: "politika" }, jev: "off", attach: "shadow", expected: "in-gate" },
    { name: "son_dakika is in the gate", article: { category: "son_dakika" }, jev: "off", attach: "live", expected: "in-gate" },
    {
      name: "an admitted (stamped) genel article is in the gate",
      article: { category: "genel", politics_admitted_at: "2026-11-02T08:00:00Z" },
      jev: "off",
      attach: "live",
      expected: "in-gate",
    },
    {
      name: "a null stamp is not in the gate",
      article: { category: "genel", politics_admitted_at: null },
      jev: "off",
      attach: "shadow",
      expected: "attach",
    },
    { name: "the Jev mode does not matter: live", article: { category: "dunya" }, jev: "live", attach: "shadow", expected: "attach" },
    { name: "the Jev mode does not matter: shadow", article: { category: "yasam" }, jev: "shadow", attach: "live", expected: "attach" },
    { name: "off wins over in-gate", article: { category: "politika" }, jev: "off", attach: "off", expected: "disabled" },
  ];

  it.each(attachRows.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    expect(routeMessage(row.article, "attach", row.jev, row.attach)).toBe(row.expected);
  });

  it("without an attach mode the tag fails closed (disabled), never attach", () => {
    expect(routeMessage({ category: "genel" }, "attach", "live")).toBe("disabled");
    expect(routeMessage({ category: "genel" }, "attach", "shadow")).toBe("disabled");
  });

  it("the attach route is never 'cluster', 'dry-run' or 'rejected': the attach queue cannot reach clusterArticle", () => {
    for (const category of ["genel", "politika", "son_dakika", "ekonomi", null]) {
      for (const jev of ["off", "shadow", "live"] as const) {
        for (const attach of ["off", "shadow", "live"] as const) {
          const route = routeMessage({ category }, "attach", jev, attach);
          expect(["attach", "in-gate", "disabled"]).toContain(route);
        }
      }
    }
  });

  it("a Jev claim tag is untouched by the attach mode: 'live' stays rejected without a stamp", () => {
    expect(routeMessage({ category: "genel" }, "live", "live", "off")).toBe("rejected");
    expect(routeMessage({ category: "genel" }, "shadow", "shadow", "off")).toBe("dry-run");
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
