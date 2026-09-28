import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  JEV_TOPIC7_CHOICES_ORDER,
  selectHeldout,
  buildBlindPrompt,
  parseBlindAnswer,
  renderBlindImportSql,
  validateV2Question,
  wilson,
  mcnemarExact,
  reweight,
  evaluateGate,
} from "./topic7-gate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeGoldRows() {
  const rows = [];
  for (let i = 0; i < 356; i++) {
    rows.push({ article_id: `opus-${String(i).padStart(4, "0")}`, stratum: "opus_seed" });
  }
  for (let i = 0; i < 304; i++) {
    rows.push({ article_id: `orig-${String(i).padStart(4, "0")}`, stratum: "original" });
  }
  return rows;
}

describe("selectHeldout", () => {
  it("returns 300 from a synthetic 660 with 4 pre-labelled original rows", () => {
    const goldRows = makeGoldRows();
    expect(goldRows).toHaveLength(660);
    const provisionalIds = ["orig-0000", "orig-0001", "orig-0002", "orig-0003"];
    const heldout = selectHeldout(goldRows, provisionalIds);
    expect(heldout).toHaveLength(300);
    expect(heldout.every((r) => r.stratum !== "opus_seed")).toBe(true);
    for (const id of provisionalIds) {
      expect(heldout.some((r) => r.article_id === id)).toBe(false);
    }
  });
});

describe("buildBlindPrompt", () => {
  const guide = "Guide text.";

  it("builds a prompt from title/description", () => {
    const result = buildBlindPrompt(guide, { title: "Başlık", description: "Özet" });
    expect(result.prompt).toContain(guide);
    expect(result.prompt).toContain("Başlık");
    expect(result.prompt).toContain("Özet");
  });

  it("rejects an article carrying url/category/source/source_slug/jev fields", () => {
    for (const key of ["url", "category", "source", "source_slug", "jev_choice"]) {
      expect(() => buildBlindPrompt(guide, { title: "t", description: null, [key]: "x" })).toThrow();
    }
  });
});

describe("parseBlindAnswer", () => {
  it("parses a valid JSON string", () => {
    expect(parseBlindAnswer('{"is_politics": true, "topic": "politika"}')).toEqual({
      is_politics: true,
      topic: "politika",
    });
  });

  it("parses an already-parsed object", () => {
    expect(parseBlindAnswer({ is_politics: false, topic: "genel" })).toEqual({
      is_politics: false,
      topic: "genel",
    });
  });

  it("throws on a non-boolean is_politics", () => {
    expect(() => parseBlindAnswer({ is_politics: "yes", topic: "genel" })).toThrow();
  });

  it("throws on a topic outside the 7 labels", () => {
    expect(() => parseBlindAnswer({ is_politics: true, topic: "magazin" })).toThrow();
  });
});

describe("renderBlindImportSql", () => {
  const rows = [
    { article_id: "b-2", is_politics: true, topic: "politika" },
    { article_id: "a-1", is_politics: false, topic: "genel" },
  ];

  it("validates labelSource", () => {
    expect(() => renderBlindImportSql(rows, { labelSource: "not-a-valid-source" })).toThrow();
    expect(() => renderBlindImportSql(rows, { labelSource: "blind-v2guide-A-2026-09-28" })).not.toThrow();
  });

  it("uses the $blind$ delimiter and is deterministic regardless of input order", () => {
    const sql1 = renderBlindImportSql(rows, { labelSource: "blind-v2guide-A-2026-09-28" });
    const sql2 = renderBlindImportSql([...rows].reverse(), { labelSource: "blind-v2guide-A-2026-09-28" });
    expect(sql1).toBe(sql2);
    expect(sql1).toContain("$blind$");
    expect(sql1).toContain("begin;");
    expect(sql1).toContain("commit;");
    expect(sql1.indexOf("a-1")).toBeLessThan(sql1.indexOf("b-2"));
  });

  it("throws if a payload would contain the $blind$ delimiter", () => {
    expect(() =>
      renderBlindImportSql(
        [{ article_id: "$blind$", is_politics: true, topic: "genel" }],
        { labelSource: "blind-v2guide-A-2026-09-28" },
      ),
    ).toThrow();
  });
});

describe("validateV2Question", () => {
  // Copied from the lead's scratchpad/lead/v2b.mts fixture.
  const instructions =
    "Which section of a Turkish news site does this item belong in? Judge the event in `title` and `description`, not the outlet. Apply the rules in order and stop at the first that fits. " +
    "1) Sport of any kind, anywhere: spor. " +
    "2) A Turkish state, government or party actor, or Turkey's relations with other states, is the subject: politika. This includes Turkish diplomacy abroad (a minister's talks abroad, the president at an international summit, Ankara's reply to another government) and investigations, trials, detentions, trustee (kayyum) appointments and access bans involving politicians, mayors, journalists, public officials, the intelligence service, terrorism or coup cases. Exceptions: an official announcing an economic figure, target or support package is ekonomi; an official service notice (exam or school dates, appointments, transport, closures) is yasam; a police operation against ordinary crime is genel even when a minister announces it. " +
    "3) Another country or an international body is the subject and no Turkish actor is a principal: dunya, except markets and companies (ekonomi), technology and science (teknoloji), and entertainment, celebrities and the arts (yasam). " +
    "4) Otherwise choose by subject as defined below.";
  const criteria = {
    politika:
      "Turkish politics and state power: the presidency, ministers' political acts, parliament, parties, politicians, elections and laws; Turkey's foreign policy and diplomacy; political and state-security cases (politicians, mayors, journalists, the intelligence service, terrorism, coup, kayyum, access bans, free speech).",
    dunya:
      "Other countries and international bodies with no Turkish actor as a principal: their politics, elections, wars, diplomacy, crime, disasters and human-interest stories.",
    ekonomi:
      "Economy and business: prices, inflation, interest and exchange rates, markets, companies and sectors, trade, jobs, wages, pensions, taxes, economic data, targets and support packages, retail and consumer-market rules.",
    spor: "Sport of any kind: matches, athletes, clubs, transfers, federations and sports officials.",
    yasam:
      "Daily life and society: health, education (school calendar, exams, KPSS, appointments), culture, arts, history, religion, entertainment and celebrities including their legal news, environment and nature, weather forecasts and warnings, public-service notices and consumer advice.",
    teknoloji:
      "Technology and science: tech companies and their products, games, apps, internet platforms, AI, cybersecurity as technology, space and research.",
    genel:
      "Incidents and public order: crime, police operations, ordinary criminal trials, missing persons, traffic and work accidents, fires, building collapses, floods, storms and earthquakes that cause damage, court and legal notices, local municipal works.",
  };

  it("passes on the lead's v2 text", () => {
    const result = validateV2Question({ instructions, criteria }, JEV_TOPIC7_CHOICES_ORDER);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails on gold strings", () => {
    const result = validateV2Question(
      { instructions: instructions + " e.g. Fidan in Damascus.", criteria },
      JEV_TOPIC7_CHOICES_ORDER,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("gold string"))).toBe(true);
  });

  it("fails on wrong key order", () => {
    const scrambled = { ...criteria };
    const reordered = Object.fromEntries(Object.entries(scrambled).reverse());
    const result = validateV2Question({ instructions, criteria: reordered }, JEV_TOPIC7_CHOICES_ORDER);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("criteria keys"))).toBe(true);
  });

  it("fails on over-length text", () => {
    const longInstructions = instructions + " ".padEnd(3000, "x");
    const result = validateV2Question({ instructions: longInstructions, criteria }, JEV_TOPIC7_CHOICES_ORDER);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("2,800"))).toBe(true);
  });
});

describe("mcnemarExact", () => {
  it("mcnemarExact(10, 2) ≈ 0.0386", () => {
    expect(mcnemarExact(10, 2)).toBeCloseTo(0.0386, 3);
  });

  it("is 1 when there are no discordant pairs", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });
});

describe("wilson", () => {
  it("wilson(37, 50) lower bound ≈ 0.60", () => {
    expect(wilson(37, 50).lower).toBeCloseTo(0.6, 1);
  });
});

describe("reweight", () => {
  it("weights per-category accuracy by the target mix", () => {
    const acc = { politika: { correct: 8, n: 10 }, genel: { correct: 4, n: 10 } };
    const mix = { politika: 0.2, genel: 0.8 };
    // 0.2*0.8 + 0.8*0.4 = 0.16 + 0.32 = 0.48
    expect(reweight(acc, mix)).toBeCloseTo(0.48, 5);
  });

  it("returns null when the mix has no overlap with the accuracy map", () => {
    expect(reweight({ politika: { correct: 1, n: 1 } }, { spor: 1 })).toBeNull();
  });
});

describe("evaluateGate", () => {
  const allPass = {
    heldout: {
      v1PerCategory: { politika: 0.7, dunya: 0.7, ekonomi: 0.7, spor: 0.7, yasam: 0.7, teknoloji: 0.7, genel: 0.7 },
      v2PerCategory: { politika: 0.8, dunya: 0.8, ekonomi: 0.8, spor: 0.8, yasam: 0.8, teknoloji: 0.8, genel: 0.8 },
      mix: { politika: 1, dunya: 1, ekonomi: 1, spor: 1, yasam: 1, teknoloji: 1, genel: 1 },
      b: 2,
      c: 20,
    },
    dev: { v1Acc: 0.85, v2Acc: 0.9 },
    politika: { heldoutShareV2: 0.2, goldShare: 0.21, precisionV1: 0.8, precisionV2: 0.8 },
    dunya: { recallV1: 0.8, recallV2: 0.78 },
    genel: { shareV2: 0.12, goldShare: 0.1 },
    p080: { accuracy: 0.92, coverage: 0.7 },
    packStability: { politics50Flip: 0.01, topicFlip: 0.02, clickbaitFlip: 0.0, framingFlip: 0.03 },
    tokens: { meanV1: 1000, meanV2: 1500 },
  };

  it("passes on an all-pass fixture", () => {
    const result = evaluateGate(allPass);
    expect(result.pass).toBe(true);
    expect(result.checks).toHaveLength(7);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  const flips = [
    ["1", { heldout: { ...allPass.heldout, v2PerCategory: allPass.heldout.v1PerCategory } }],
    ["2", { dev: { v1Acc: 0.9, v2Acc: 0.8 } }],
    ["3", { politika: { ...allPass.politika, heldoutShareV2: 0.4 } }],
    ["4", { dunya: { recallV1: 0.9, recallV2: 0.5 } }],
    ["5", { p080: { accuracy: 0.5, coverage: 0.7 } }],
    ["6", { packStability: { ...allPass.packStability, topicFlip: 0.1 } }],
    ["7", { tokens: { meanV1: 1000, meanV2: 3000 } }],
  ];

  for (const [id, patch] of flips) {
    it(`fails check ${id} when only that condition is flipped`, () => {
      const result = evaluateGate({ ...allPass, ...patch });
      expect(result.pass).toBe(false);
      const check = result.checks.find((c) => c.id === id);
      expect(check?.ok).toBe(false);
    });
  }
});

describe("CLI modules are importable with no side effects", () => {
  it("scripts/topic7-blind-label.mjs and scripts/topic7-v2-gate.mjs import cleanly", async () => {
    await expect(import("../topic7-blind-label.mjs")).resolves.toBeDefined();
    await expect(import("../topic7-v2-gate.mjs")).resolves.toBeDefined();
  });
});

describe("topic7-v2-gate.mjs run refuses without --execute / JEV_GATE_APPROVED", () => {
  it("main() rejects before any fetch when --execute is missing", async () => {
    const mod = await import("../topic7-v2-gate.mjs");
    const fetchSpy = vi.fn();
    const exitCode = await mod.main(["run"], { AI_GATEWAY_API_KEY: "k" }, fetchSpy);
    expect(exitCode).not.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("main() rejects before any fetch when JEV_GATE_APPROVED is missing", async () => {
    const mod = await import("../topic7-v2-gate.mjs");
    const fetchSpy = vi.fn();
    const exitCode = await mod.main(["run", "--execute"], { AI_GATEWAY_API_KEY: "k" }, fetchSpy);
    expect(exitCode).not.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("main() rejects before any fetch when AI_GATEWAY_API_KEY is missing", async () => {
    const mod = await import("../topic7-v2-gate.mjs");
    const fetchSpy = vi.fn();
    const exitCode = await mod.main(["run", "--execute"], { JEV_GATE_APPROVED: "1" }, fetchSpy);
    expect(exitCode).not.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the same guard holds when spawned as a real CLI process", () => {
    const scriptPath = resolve(__dirname, "..", "topic7-v2-gate.mjs");
    expect(() =>
      execFileSync(process.execPath, [scriptPath, "run"], {
        env: { ...process.env, AI_GATEWAY_API_KEY: "k" },
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
