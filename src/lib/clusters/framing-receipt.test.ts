import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// T11 (migration 068) — the framing receipt's pure Turkish-possessive
// helper, its exact-copy sentence builder, and its plain fetcher
// (getClusterFramingReceipt). Mirrors src/lib/game/agreement.test.ts for
// the shared chainable Supabase fake (tests/_helpers/supabase-fake.ts) and
// the next/cache stub. getCachedClusterFramingReceipt is a thin
// "use cache" wrapper over getClusterFramingReceipt and is deliberately
// NOT tested here — a "use cache" function needs the real Next.js runtime
// to exercise caching semantics, and vitest doesn't run one.

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  error: null as { message: string } | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    rpc: {
      cluster_framing_receipt: () => {
        if (fixture.error) return { data: null, error: fixture.error };
        return { data: fixture.row ? [fixture.row] : [], error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import {
  framingReceiptSentence,
  getClusterFramingReceipt,
  isFramingReceiptPublic,
  numberPossessive,
  shouldShowPublicFramingReceipt,
  type FramingReceipt,
} from "./framing-receipt";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  delete process.env.FRAMING_RECEIPT_PUBLIC;
  fixture.row = null;
  fixture.error = null;
});

afterEach(() => {
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "FRAMING_RECEIPT_PUBLIC",
  ]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("numberPossessive", () => {
  it("returns the correct Turkish possessive for 1-10, 20, 30, 40 and 100", () => {
    expect(numberPossessive(1)).toBe("1'i");
    expect(numberPossessive(2)).toBe("2'si");
    expect(numberPossessive(3)).toBe("3'ü");
    expect(numberPossessive(4)).toBe("4'ü");
    expect(numberPossessive(5)).toBe("5'i");
    expect(numberPossessive(6)).toBe("6'sı");
    expect(numberPossessive(7)).toBe("7'si");
    expect(numberPossessive(8)).toBe("8'i");
    expect(numberPossessive(9)).toBe("9'u");
    expect(numberPossessive(10)).toBe("10'u");
    expect(numberPossessive(20)).toBe("20'si");
    expect(numberPossessive(30)).toBe("30'u");
    expect(numberPossessive(40)).toBe("40'ı");
    expect(numberPossessive(100)).toBe("100'ü");
  });
});

describe("framingReceiptSentence", () => {
  const base: FramingReceipt = {
    members: 12,
    scored: 9,
    proGovernment: 4,
    proOpposition: 3,
    neutral: 2,
    questionSet: "2026-09-21.1",
  };

  it("names the denominator, the three counts and the 0,75 threshold", () => {
    const sentence = framingReceiptSentence(base);
    expect(sentence).toBe(
      "Çerçeveleme makbuzu — bu kümedeki 12 başlığın 9 tanesi eşiği (0,75) geçti; 4'ü iktidar lehine, 3'ü muhalefet lehine, 2'si tarafsız ifade taşıyor (otomatik, eşik 0,75)",
    );
    expect(sentence).toContain("12");
    expect(sentence).toContain("9");
    expect(sentence).toContain("0,75");
  });

  it("uses the no-reading branch when scored is 0", () => {
    const sentence = framingReceiptSentence({ ...base, scored: 0 });
    expect(sentence).toBe(
      "Çerçeveleme makbuzu — bu kümedeki 12 başlıkta eşiği (0,75) geçen otomatik çerçeve okuması yok.",
    );
  });
});

describe("getClusterFramingReceipt", () => {
  it("maps the RPC row to camelCase counts", async () => {
    fixture.row = {
      members: 12,
      scored: 9,
      pro_government: 4,
      pro_opposition: 3,
      neutral: 2,
      question_set: "2026-09-21.1",
    };

    const result = await getClusterFramingReceipt("cluster-1");

    expect(result).toEqual({
      members: 12,
      scored: 9,
      proGovernment: 4,
      proOpposition: 3,
      neutral: 2,
      questionSet: "2026-09-21.1",
    });
  });

  it("returns null when the RPC errors and never throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.error = {
      message: 'function "cluster_framing_receipt" does not exist',
    };

    await expect(getClusterFramingReceipt("cluster-1")).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("returns null when the Supabase env vars are missing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getClusterFramingReceipt("cluster-1")).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("isFramingReceiptPublic", () => {
  it("is false unless FRAMING_RECEIPT_PUBLIC is exactly '1'", () => {
    delete process.env.FRAMING_RECEIPT_PUBLIC;
    expect(isFramingReceiptPublic()).toBe(false);

    process.env.FRAMING_RECEIPT_PUBLIC = "true";
    expect(isFramingReceiptPublic()).toBe(false);

    process.env.FRAMING_RECEIPT_PUBLIC = "0";
    expect(isFramingReceiptPublic()).toBe(false);

    process.env.FRAMING_RECEIPT_PUBLIC = "1";
    expect(isFramingReceiptPublic()).toBe(true);
  });
});

describe("shouldShowPublicFramingReceipt", () => {
  const receipt: FramingReceipt = {
    members: 5,
    scored: 3,
    proGovernment: 2,
    proOpposition: 1,
    neutral: 0,
    questionSet: null,
  };

  it("requires the flag AND scored >= 3", () => {
    delete process.env.FRAMING_RECEIPT_PUBLIC;
    expect(shouldShowPublicFramingReceipt(receipt)).toBe(false);

    process.env.FRAMING_RECEIPT_PUBLIC = "1";
    expect(shouldShowPublicFramingReceipt(receipt)).toBe(true);
    expect(shouldShowPublicFramingReceipt(null)).toBe(false);
    expect(shouldShowPublicFramingReceipt({ ...receipt, scored: 2 })).toBe(
      false,
    );
  });

  it("blocks a fully-scored, single-bucket cluster (counts would map 1:1 onto the named outlets) but allows a split-bucket fully-scored cluster", () => {
    process.env.FRAMING_RECEIPT_PUBLIC = "1";

    expect(
      shouldShowPublicFramingReceipt({
        members: 3,
        scored: 3,
        proGovernment: 0,
        proOpposition: 0,
        neutral: 3,
        questionSet: null,
      }),
    ).toBe(false);

    expect(
      shouldShowPublicFramingReceipt({
        members: 3,
        scored: 3,
        proGovernment: 2,
        proOpposition: 1,
        neutral: 0,
        questionSet: null,
      }),
    ).toBe(true);
  });
});
