import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

import {
  API_KEY_RE,
  generateApiKey,
  hashApiKey,
  isApiTier,
  normalizeKeyLabel,
  parseBearerApiKey,
} from "@/lib/api/keys";
import {
  parseLimit,
  parseSince,
  toV1ClusterRecord,
  type V1ClusterRow,
} from "@/lib/api/v1-clusters";

// ---------------------------------------------------------------------------
// Unit tests for src/lib/api/keys.ts and src/lib/api/v1-clusters.ts's pure
// helpers. No Supabase / Next.js surface here — that's tests/api/*.test.ts.
// ---------------------------------------------------------------------------

describe("generateApiKey", () => {
  it("matches API_KEY_RE, is 45 chars, and never repeats across 1000 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const key = generateApiKey();
      expect(key).toMatch(API_KEY_RE);
      expect(key).toHaveLength(45);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("hashApiKey", () => {
  it("is the sha256 hex of the whole key including the tayf_ prefix and is 64 lowercase hex chars", () => {
    const key = generateApiKey();
    const expected = crypto.createHash("sha256").update(key).digest("hex");
    const actual = hashApiKey(key);
    expect(actual).toBe(expected);
    expect(actual).toHaveLength(64);
    expect(actual).toMatch(/^[0-9a-f]{64}$/);

    // Hashing just the 40-hex suffix (dropping the prefix) must differ —
    // proves the whole string, prefix included, is what gets hashed.
    const withoutPrefix = key.slice("tayf_".length);
    expect(hashApiKey(withoutPrefix)).not.toBe(actual);
  });
});

describe("parseBearerApiKey", () => {
  it("accepts 'bearer' in any case and rejects a missing header, a bare token, a uuid and a 39-hex key", () => {
    const key = generateApiKey();

    expect(parseBearerApiKey(`Bearer ${key}`)).toBe(key);
    expect(parseBearerApiKey(`BEARER ${key}`)).toBe(key);
    expect(parseBearerApiKey(`bearer ${key}`)).toBe(key);
    expect(parseBearerApiKey(`BeArEr ${key}`)).toBe(key);

    expect(parseBearerApiKey(null)).toBeNull();
    expect(parseBearerApiKey(key)).toBeNull(); // bare token, no scheme
    expect(
      parseBearerApiKey("Bearer 11111111-2222-3333-4444-555555555555"),
    ).toBeNull(); // uuid, not a tayf_ key
    expect(
      parseBearerApiKey(`Bearer tayf_${"a".repeat(39)}`),
    ).toBeNull(); // 39 hex chars, one short
  });
});

describe("normalizeKeyLabel", () => {
  it("trims, rejects empty, rejects 65 chars, rejects control characters", () => {
    expect(normalizeKeyLabel("  smoke  ")).toBe("smoke");
    expect(normalizeKeyLabel("")).toBeNull();
    expect(normalizeKeyLabel("   ")).toBeNull();
    expect(normalizeKeyLabel("a".repeat(65))).toBeNull();
    expect(normalizeKeyLabel("a".repeat(64))).toBe("a".repeat(64));
    expect(normalizeKeyLabel("bad\x01label")).toBeNull();
    expect(normalizeKeyLabel("bad\nlabel")).toBeNull();
    expect(normalizeKeyLabel(42)).toBeNull();
    expect(normalizeKeyLabel(null)).toBeNull();
  });
});

describe("isApiTier", () => {
  it("accepts free and partner only", () => {
    expect(isApiTier("free")).toBe(true);
    expect(isApiTier("partner")).toBe(true);
    expect(isApiTier("enterprise")).toBe(false);
    expect(isApiTier("")).toBe(false);
    expect(isApiTier(null)).toBe(false);
    expect(isApiTier(undefined)).toBe(false);
    expect(isApiTier(1)).toBe(false);
  });
});

describe("parseSince", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");

  it("defaults to 24h ago, rejects a non-ISO string, clamps a since older than 7 days", () => {
    const defaulted = parseSince(null, now);
    expect(defaulted).toEqual({ since: "2026-09-20T12:00:00.000Z" });

    const empty = parseSince("", now);
    expect(empty).toEqual({ since: "2026-09-20T12:00:00.000Z" });

    const badFormat = parseSince("not-a-date", now);
    expect("error" in badFormat).toBe(true);

    const dateOnly = parseSince("2026-09-01", now);
    expect("error" in dateOnly).toBe(true);

    // 30 days ago -> clamped to exactly V1_MAX_SINCE_DAYS (7) ago.
    const tooOld = parseSince("2026-08-22T12:00:00.000Z", now);
    expect(tooOld).toEqual({ since: "2026-09-14T12:00:00.000Z" });

    // Within the 7-day window -> passed through unclamped.
    const withinWindow = parseSince("2026-09-19T00:00:00.000Z", now);
    expect(withinWindow).toEqual({ since: "2026-09-19T00:00:00.000Z" });
  });
});

describe("parseLimit", () => {
  it("defaults to 50, rejects 0 and 101 and a non-numeric value", () => {
    expect(parseLimit(null)).toBe(50);
    expect(parseLimit("")).toBe(50);
    expect(parseLimit("30")).toBe(30);
    expect(parseLimit("100")).toBe(100);

    expect(parseLimit("0")).toEqual({ error: expect.any(String) });
    expect(parseLimit("101")).toEqual({ error: expect.any(String) });
    expect(parseLimit("abc")).toEqual({ error: expect.any(String) });
    expect(parseLimit("-5")).toEqual({ error: expect.any(String) });
    expect(parseLimit("1.5")).toEqual({ error: expect.any(String) });
  });
});

function makeRow(overrides: Partial<V1ClusterRow> = {}): V1ClusterRow {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    title_tr: "Orijinal başlık",
    title_tr_neutral: null,
    bias_distribution: { pro_government: 2, opposition: 1 },
    is_blindspot: false,
    blindspot_side: null,
    article_count: 3,
    first_published: "2026-09-20T10:00:00.000Z",
    updated_at: "2026-09-21T09:00:00.000Z",
    cluster_articles: [
      {
        articles: {
          category: "politika",
          sources: { slug: "sabah", bias: "pro_government" },
        },
      },
      {
        articles: {
          category: "politika",
          sources: { slug: "birgun", bias: "opposition" },
        },
      },
    ],
    ...overrides,
  };
}

describe("toV1ClusterRecord", () => {
  it("uses title_tr_neutral when present and falls back to title_tr", () => {
    const neutral = toV1ClusterRecord(
      makeRow({ title_tr_neutral: "Nötr başlık" }),
    );
    expect(neutral.title).toBe("Nötr başlık");

    const fallback = toV1ClusterRecord(makeRow({ title_tr_neutral: null }));
    expect(fallback.title).toBe("Orijinal başlık");

    // An empty-string neutral title (rewriter wrote junk) also falls back.
    const emptyNeutral = toV1ClusterRecord(
      makeRow({ title_tr_neutral: "   " }),
    );
    expect(emptyNeutral.title).toBe("Orijinal başlık");
  });

  it("emits member sources as deduped {slug, zone} pairs and no article field of any kind", () => {
    const row = makeRow({
      cluster_articles: [
        {
          articles: {
            category: "politika",
            sources: { slug: "sabah", bias: "pro_government" },
          },
        },
        // Duplicate slug — must be deduped to one entry.
        {
          articles: {
            category: "politika",
            sources: { slug: "sabah", bias: "pro_government" },
          },
        },
        {
          articles: {
            category: "politika",
            sources: { slug: "birgun", bias: "opposition" },
          },
        },
        {
          articles: { category: "politika", sources: null },
        },
      ],
    });
    const record = toV1ClusterRecord(row);

    expect(record.sources).toEqual([
      { slug: "sabah", zone: "iktidar" },
      { slug: "birgun", zone: "muhalefet" },
    ]);
    for (const s of record.sources) {
      expect(Object.keys(s).sort()).toEqual(["slug", "zone"]);
    }
    // The record legitimately has its own "title"/"url"/"article_count"
    // keys (the cluster's title, Tayf's own cluster URL, and the member
    // count) — what must never appear is an ARTICLE-level leak: an
    // article id/url, an image_url, or a description.
    const json = JSON.stringify(record);
    expect(json).not.toContain("image_url");
    expect(json).not.toContain("description");
    expect(json).not.toContain("content_hash");
    expect(Object.keys(record)).not.toContain("articles");
    expect(Object.keys(record)).not.toContain("cluster_articles");
  });

  it("topic7 is null when the column is absent, never an error", () => {
    const record = toV1ClusterRecord(makeRow());
    expect(record.topic7).toBeNull();
    expect("topic7" in record).toBe(true);

    const withTopic = toV1ClusterRecord(makeRow(), "siyaset");
    expect(withTopic.topic7).toBe("siyaset");
  });
});
