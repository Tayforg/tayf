import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pickNeutralTitle } from "./neutral-title";

// Replay of the headline cron's re-pick over production data. The fixture is
// 150 clusters (article_count >= 4, the most recently updated) captured on
// 2026-11-01: each has the title the cluster carried then (`stored`, a good
// extractive-v1 title in almost every case) and the titles of its members.
//
// Why it exists (hunt 16): #156 re-picked every non-current row and rewrote
// about 48% of them; the first conservative margin (0.05) still rewrote 38%
// because the spread of scores between two good member titles of one cluster
// is wider than 0.05. Unit tests on a handful of clusters cannot see that, so
// this pins the churn rate itself. Migration 141 offers the whole 14-day
// window once per extractive-model bump, so the rate here is the share of
// good titles readers lose on the next bump. If a scorer or margin change
// pushes it past the cap, the change is not conservative; do not raise the cap
// to make the test pass.

interface ReplayCluster {
  cid: string;
  stored: string;
  titles: string[];
}

const CLUSTERS: ReplayCluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../tests/fixtures/neutral-title-repick-replay.json"), "utf8"),
) as ReplayCluster[];

const byId = (cid: string): ReplayCluster => {
  const c = CLUSTERS.find((x) => x.cid === cid);
  if (!c) throw new Error(`fixture cluster ${cid} missing`);
  return c;
};

const repick = (c: ReplayCluster): string | null =>
  pickNeutralTitle(
    c.titles.map((title) => ({ title })),
    { incumbent: c.stored },
  );

describe("re-pick replay over 150 production clusters", () => {
  it("the fixture is intact (150 clusters, 4+ member titles each, a stored title each)", () => {
    expect(CLUSTERS).toHaveLength(150);
    for (const c of CLUSTERS) {
      expect(c.titles.length, c.cid).toBeGreaterThanOrEqual(4);
      expect(c.stored.trim().length, c.cid).toBeGreaterThan(0);
    }
  });

  it("changes under 15% of the stored titles (the 0.05 margin changed 38%, #156 48%)", () => {
    const changed = CLUSTERS.filter((c) => {
      const next = repick(c);
      return next !== null && next !== c.stored;
    });
    expect(changed.length / CLUSTERS.length).toBeLessThan(0.1);
  });

  it("never returns null for these clusters (a stored title is always kept or replaced)", () => {
    for (const c of CLUSTERS) expect(repick(c), c.cid).not.toBeNull();
  });

  it("is idempotent: re-picking with the pick as incumbent returns it", () => {
    for (const c of CLUSTERS) {
      const picked = repick(c);
      expect(pickNeutralTitle(c.titles.map((title) => ({ title })), { incumbent: picked }), c.cid).toBe(picked);
    }
  });

  it("never picks a fragment (under 30 characters) for a cluster of 4+ members", () => {
    for (const c of CLUSTERS) {
      const picked = repick(c);
      expect(picked!.length, `${c.cid}: ${picked}`).toBeGreaterThanOrEqual(30);
    }
  });

  it("keeps the full-length titles #156 and the 0.05 margin used to rewrite", () => {
    // Gaps 0.079 (73 chars), 0.060 (102 chars), 0.057 (70 chars): outscored, but
    // not clearly. 55a8c57c used to become a different meeting ('Alman
    // mevkidaşı'), 070cbfc0 'Üç bakanlıkta yeni genel müdürlükler kuruldu'.
    for (const cid of ["55a8c57c", "070cbfc0", "97575687"]) {
      const c = byId(cid);
      expect(c.stored.length, cid).toBeGreaterThanOrEqual(45);
      expect(repick(c), cid).toBe(c.stored);
    }
  });

  it("replaces a stored title that fails the gate (generic placeholder, surviving lead-in)", () => {
    const generic = byId("2c15fdcf");
    expect(generic.stored).toBe("Kısa haberler");
    expect(repick(generic)).not.toBe(generic.stored);

    const leadIn = byId("c26c8c14");
    expect(leadIn.stored).toMatch(/^SON DAKİKA/);
    expect(repick(leadIn)).not.toMatch(/^SON DAKİKA/);
  });

  it("replaces a short stored title that a longer member title clearly beats", () => {
    // 'Boğaz trafiği askıya alındı' (27 chars) -> the Istanbul Strait title.
    const short = byId("1e96c356");
    expect(short.stored.length).toBeLessThan(45);
    expect(repick(short)).toBe("İstanbul Boğazı'nda gemi trafiği askıya alındı");
  });

  it("holds a full-length title to a wider margin than a short one at the same score gap", () => {
    // Both are outscored by about 0.10. The 34-character title is replaced
    // (REPICK_MARGIN 0.05), the 94-character one stays (REPICK_MARGIN_FULL_LENGTH 0.20).
    const short = byId("9088bea9");
    const full = byId("b2a03549");
    expect(short.stored.length).toBeLessThan(45);
    expect(full.stored.length).toBeGreaterThanOrEqual(45);
    expect(repick(short)).not.toBe(short.stored);
    expect(repick(full)).toBe(full.stored);
  });

  it("replaces a full-length title that is beaten by a wide margin (gaps 0.455 and 0.317)", () => {
    for (const cid of ["7148f645", "8262e836"]) {
      const c = byId(cid);
      expect(c.stored.length, cid).toBeGreaterThanOrEqual(45);
      expect(repick(c), cid).not.toBe(c.stored);
    }
  });
});
