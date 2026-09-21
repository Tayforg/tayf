import { describe, it, expect, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseFake } from "../_helpers/supabase-fake";
import {
  SHARE_TOKEN_RE,
  SHARE_DEFAULT_DAYS,
  SHARE_MAX_DAYS,
  generateShareToken,
  isShareToken,
  normalizeShareDays,
  shareUrl,
  listShareLinks,
  resolveShareToken,
} from "@/lib/reports/share";

// ---------------------------------------------------------------------------
// Unit tests for src/lib/reports/share.ts (pack E, W2 / B9). No Supabase
// mock is needed for the pure helpers — only `listShareLinks` and
// `resolveShareToken` touch a client, and they take it as an explicit
// argument (contract section 6), so the shared proxy fake is passed
// directly rather than going through a `@supabase/supabase-js` module mock.
// ---------------------------------------------------------------------------

const ORIGINAL_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  if (ORIGINAL_SITE_URL === undefined) {
    delete process.env.NEXT_PUBLIC_SITE_URL;
  } else {
    process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_SITE_URL;
  }
});

describe("generateShareToken", () => {
  it("returns 32 lowercase hex chars and never repeats across 1000 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const token = generateShareToken();
      expect(token).toMatch(SHARE_TOKEN_RE);
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
    expect(seen.size).toBe(1000);
  });
});

describe("isShareToken", () => {
  it("rejects uppercase hex, 31 and 33 chars, a uuid, and a non-string", () => {
    const valid = "a".repeat(32);
    expect(isShareToken(valid)).toBe(true);
    expect(isShareToken(valid.toUpperCase())).toBe(false);
    expect(isShareToken("a".repeat(31))).toBe(false);
    expect(isShareToken("a".repeat(33))).toBe(false);
    expect(isShareToken("11111111-2222-3333-4444-555555555555")).toBe(false);
    expect(isShareToken(12345)).toBe(false);
    expect(isShareToken(null)).toBe(false);
    expect(isShareToken(undefined)).toBe(false);
    expect(isShareToken({})).toBe(false);
  });
});

describe("normalizeShareDays", () => {
  it("undefined and null default to 7", () => {
    expect(normalizeShareDays(undefined)).toBe(SHARE_DEFAULT_DAYS);
    expect(normalizeShareDays(null)).toBe(SHARE_DEFAULT_DAYS);
  });

  it("rejects 0, 31, 7.5, '7' and NaN with null", () => {
    expect(normalizeShareDays(0)).toBeNull();
    expect(normalizeShareDays(31)).toBeNull();
    expect(normalizeShareDays(7.5)).toBeNull();
    expect(normalizeShareDays("7")).toBeNull();
    expect(normalizeShareDays(NaN)).toBeNull();
  });

  it("accepts the 1..30 boundary", () => {
    expect(normalizeShareDays(1)).toBe(1);
    expect(normalizeShareDays(SHARE_MAX_DAYS)).toBe(SHARE_MAX_DAYS);
  });
});

describe("shareUrl", () => {
  it("builds `${siteUrl()}/rapor/<token>` with no double slash", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://tayfhaber.com/";
    const token = "a".repeat(32);
    expect(shareUrl(token)).toBe(`https://tayfhaber.com/rapor/${token}`);
    expect(shareUrl(token)).not.toContain("//rapor");
  });
});

describe("listShareLinks", () => {
  it("returns [] (never throws) when the query errors", async () => {
    const { client } = createSupabaseFake({
      tables: {
        report_share_links: () => ({
          data: null,
          error: { message: "boom" },
        }),
      },
    });

    const result = await listShareLinks(
      client as unknown as SupabaseClient,
      "11111111-2222-3333-4444-555555555555",
    );
    expect(result).toEqual([]);
  });
});

describe("resolveShareToken", () => {
  it("returns null (never throws) when the rpc errors", async () => {
    const { client } = createSupabaseFake({
      rpc: {
        report_share_view: () => ({
          data: null,
          error: { message: "boom" },
        }),
      },
    });

    const result = await resolveShareToken(
      client as unknown as SupabaseClient,
      "a".repeat(32),
    );
    expect(result).toBeNull();
  });
});
