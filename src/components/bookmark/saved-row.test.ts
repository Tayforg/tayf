import { describe, expect, it } from "vitest";

import { BIAS_ORDER } from "@/lib/bias/config";
import { publicBlindspotClaim } from "@/lib/clusters/recall-veto";
import { BLINDSPOT } from "../../../supabase/functions/_shared/cluster/blindspot";

import { isRpcMissing, savedUpdatedLabel, toPublicSavedRow, toSavedRowView } from "./saved-row";

const ZEROS = Object.fromEntries(BIAS_ORDER.map((k) => [k, 0]));

describe("toSavedRowView distribution", () => {
  it("returns null for a null, string, array or number bias_distribution", () => {
    for (const bad of [null, undefined, "pro_government", [1, 2, 3], 7, true]) {
      expect(toSavedRowView({ bias_distribution: bad }).distribution).toBeNull();
    }
  });

  it("returns null for an empty object and for all zeros", () => {
    expect(toSavedRowView({ bias_distribution: {} }).distribution).toBeNull();
    expect(toSavedRowView({ bias_distribution: ZEROS }).distribution).toBeNull();
  });

  it("keeps only valid keys from mixed junk and zero-fills the rest", () => {
    const view = toSavedRowView({
      bias_distribution: {
        pro_government: "3", // string: rejected
        state_media: -1, // negative: rejected
        gov_leaning: Number.NaN, // NaN: rejected
        islamist_conservative: Number.POSITIVE_INFINITY, // not finite: rejected
        center: 2,
        international: 0,
        opposition: 5,
        not_a_bias_key: 99, // unknown key: ignored
      },
    });
    expect(view.distribution).not.toBeNull();
    const d = view.distribution!;
    expect(d.center).toBe(2);
    expect(d.opposition).toBe(5);
    expect(d.pro_government).toBe(0);
    expect(d.state_media).toBe(0);
    expect(d.gov_leaning).toBe(0);
    expect(d.islamist_conservative).toBe(0);
    expect(d.international).toBe(0);
    expect(Object.keys(d).sort()).toEqual([...BIAS_ORDER].sort());
    expect("not_a_bias_key" in d).toBe(false);
  });

  it("gives null when only junk values are present (valid total is 0)", () => {
    const view = toSavedRowView({
      bias_distribution: { center: "4", opposition: -2, nationalist: Number.NaN, other: 3 },
    });
    expect(view.distribution).toBeNull();
  });

  it("passes a well-formed distribution through unchanged", () => {
    const dist = Object.fromEntries(BIAS_ORDER.map((k, i) => [k, i]));
    const view = toSavedRowView({ bias_distribution: dist, is_blindspot: false });
    expect(view.distribution).toEqual(dist);
    expect(view.isBlindspot).toBe(false);
  });

  it("does not mutate or alias the input object", () => {
    const input = { center: 1 };
    const view = toSavedRowView({ bias_distribution: input });
    expect(view.distribution).not.toBe(input);
    expect(input).toEqual({ center: 1 });
  });
});

describe("toSavedRowView isBlindspot", () => {
  it("is true only for the boolean true", () => {
    expect(toSavedRowView({ bias_distribution: null, is_blindspot: true }).isBlindspot).toBe(true);
  });

  it("is false for a missing flag (v1 fallback row)", () => {
    expect(toSavedRowView({ bias_distribution: { center: 1 } }).isBlindspot).toBe(false);
  });

  it("is false for the string 'true', 1, null and false", () => {
    for (const v of ["true", 1, null, false, undefined]) {
      expect(toSavedRowView({ bias_distribution: null, is_blindspot: v }).isBlindspot).toBe(false);
    }
  });
});

// Migration 138 applies the cluster page's recall/sibling veto inside
// saved_clusters_v2: a vetoed story comes back with is_blindspot = false, so the
// row view must carry no blindspot flag and /saved shows no "Kör nokta" pill.
describe("toSavedRowView with a vetoed v2 row (migration 138)", () => {
  it("gives isBlindspot false for is_blindspot false (a blindspot withdrawn by the veto): no 'Kör nokta' pill", () => {
    const view = toSavedRowView({
      bias_distribution: { gov_leaning: 7, pro_government: 1, opposition_leaning: 1 },
      is_blindspot: false,
    });
    expect(view.isBlindspot).toBe(false);
    // The bar still renders: only the claim is withdrawn, not the coverage.
    expect(view.distribution).toMatchObject({ gov_leaning: 7, pro_government: 1, opposition_leaning: 1 });
  });

  it("still gives isBlindspot true for a flagged, unvetoed v2 row", () => {
    expect(
      toSavedRowView({ bias_distribution: { gov_leaning: 8, opposition_leaning: 1 }, is_blindspot: true }).isBlindspot,
    ).toBe(true);
  });
});

describe("toSavedRowView happy path", () => {
  it("returns the distribution and the blindspot flag of a v2 row", () => {
    const view = toSavedRowView({
      bias_distribution: { pro_government: 1, center: 2, opposition: 3 },
      is_blindspot: true,
    });
    expect(view.isBlindspot).toBe(true);
    expect(view.distribution).toMatchObject({ pro_government: 1, center: 2, opposition: 3 });
    expect(view.distribution?.nationalist).toBe(0);
  });
});

// /saved shows saved_clusters_v2.updated_at (the RPC does not return
// first_published), so the age must say that it is the last update time rather
// than read like a publication date.
describe("savedUpdatedLabel", () => {
  const now = Date.parse("2026-11-01T08:00:00.000Z");

  it("labels a recent update as the last update, relative to the given clock", () => {
    expect(savedUpdatedLabel("2026-11-01T00:00:00.000Z", now)).toBe("Son güncelleme: 8 saat önce");
  });

  it("labels an older update with the absolute date once the age switches to one", () => {
    expect(savedUpdatedLabel("2026-10-12T09:00:00.000Z", now)).toBe("Son güncelleme: 12 Ekim 2026");
  });

  it("says 'az önce' for an update inside the last minute", () => {
    expect(savedUpdatedLabel("2026-11-01T07:59:30.000Z", now)).toBe("Son güncelleme: az önce");
  });

  it("returns an empty string for an invalid or empty ISO string (so no label is shown)", () => {
    expect(savedUpdatedLabel("not-a-date", now)).toBe("");
    expect(savedUpdatedLabel("", now)).toBe("");
    expect(savedUpdatedLabel("not-a-date")).toBe("");
  });

  it("falls back to the real clock when no 'now' is given", () => {
    const justNow = new Date(Date.now() - 5_000).toISOString();
    expect(savedUpdatedLabel(justNow)).toBe("Son güncelleme: az önce");
  });
});

// h38-saved-1 (migration 158): saved_clusters_v3 returns first_published, so /saved waits
// BLINDSPOT.feedDelayHours like every other card (publicBlindspotClaim). A v2 fallback row has
// no first_published and keeps today's behaviour (the veto-only claim).
describe("toPublicSavedRow: the Kör nokta claim waits BLINDSPOT.feedDelayHours (h38-saved-1)", () => {
  const NOW = Date.parse("2026-11-05T12:00:00.000Z");
  const HOUR = 3_600_000;
  const ago = (hours: number): string => new Date(NOW - hours * HOUR).toISOString();
  const flagged = (first_published?: string | null) => ({
    id: "c1",
    title_tr: "Başlık",
    bias_distribution: { pro_government: 5, center: 1 },
    is_blindspot: true,
    ...(first_published === undefined ? {} : { first_published }),
  });
  const pill = (row: Parameters<typeof toPublicSavedRow>[0]) =>
    toSavedRowView(toPublicSavedRow(row, NOW)).isBlindspot;

  it("shows no pill for a flagged row first published 1 hour ago", () => {
    expect(pill(flagged(ago(1)))).toBe(false);
  });

  it("shows the pill for a flagged row first published 25 hours ago", () => {
    expect(pill(flagged(ago(25)))).toBe(true);
  });

  it("uses the shared delay: the pill appears exactly at BLINDSPOT.feedDelayHours, not a minute before", () => {
    expect(BLINDSPOT.feedDelayHours).toBe(24);
    expect(pill(flagged(new Date(NOW - BLINDSPOT.feedDelayHours * HOUR + 60_000).toISOString()))).toBe(false);
    expect(pill(flagged(ago(BLINDSPOT.feedDelayHours)))).toBe(true);
  });

  it("keeps today's behaviour on a v2 fallback row (no first_published): the flag shows at once", () => {
    expect(pill(flagged())).toBe(true);
    expect(pill(flagged(null))).toBe(true);
  });

  it("does not hide a flag over an unparseable first_published or a non-finite clock (missing data never hides)", () => {
    expect(pill(flagged("not-a-date"))).toBe(true);
    expect(pill(flagged(""))).toBe(true);
    expect(toSavedRowView(toPublicSavedRow(flagged(ago(1)), Number.NaN)).isBlindspot).toBe(true);
    expect(toSavedRowView(toPublicSavedRow(flagged(ago(1)), Number.POSITIVE_INFINITY)).isBlindspot).toBe(true);
  });

  it("never invents a claim: an unflagged row stays unflagged at any age, and so do non-boolean flags", () => {
    for (const hours of [0, 1, 25, 400]) {
      expect(pill({ ...flagged(ago(hours)), is_blindspot: false })).toBe(false);
    }
    expect(pill({ ...flagged(ago(100)), is_blindspot: undefined })).toBe(false);
    for (const odd of ["true", 1, null]) expect(pill({ ...flagged(ago(100)), is_blindspot: odd })).toBe(false);
  });

  it("a first_published in the future is held back like any young cluster", () => {
    expect(pill(flagged(new Date(NOW + 2 * HOUR).toISOString()))).toBe(false);
  });

  it("agrees with publicBlindspotClaim for every age on a grid (the one rule of the site)", () => {
    for (const hours of [-3, 0, 0.5, 1, 12, 23.99, 24, 24.01, 25, 72, 24 * 30]) {
      const row = flagged(ago(hours));
      const viaSite = publicBlindspotClaim(
        { is_blindspot: true, blindspot_side: null, first_published: row.first_published },
        NOW,
      ).isBlindspot;
      expect(pill(row), `${hours} h`).toBe(viaSite);
    }
  });

  it("returns a copy with every other field untouched and does not mutate the input", () => {
    const input = flagged(ago(1));
    const snapshot = JSON.stringify(input);
    const out = toPublicSavedRow(input, NOW);
    expect(out).not.toBe(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).toEqual({ ...input, is_blindspot: false });
    expect(typeof out.is_blindspot).toBe("boolean");
  });

  it("always yields a real boolean (the row view reads only a literal true)", () => {
    expect(toPublicSavedRow({ bias_distribution: null }, NOW).is_blindspot).toBe(false);
    expect(toPublicSavedRow(flagged(ago(30)), NOW).is_blindspot).toBe(true);
  });
});

// A missing function answers PGRST202 (PostgREST: not in the schema cache) or 42883 (Postgres:
// undefined_function). Only those two send /saved to the older RPC; every other error is a real failure.
describe("isRpcMissing", () => {
  it("is true for PGRST202 and 42883", () => {
    expect(isRpcMissing({ code: "PGRST202" })).toBe(true);
    expect(isRpcMissing({ code: "42883", message: "function public.saved_clusters_v3(uuid[]) does not exist" })).toBe(true);
  });

  it("is false for any other code, a missing code, null and undefined", () => {
    for (const code of ["PGRST200", "PGRST201", "PGRST203", "42501", "42P01", "22P02", "57014", "500", "pgrst202", "42883 ", ""]) {
      expect(isRpcMissing({ code }), code).toBe(false);
    }
    expect(isRpcMissing({})).toBe(false);
    expect(isRpcMissing({ message: "boom" })).toBe(false);
    expect(isRpcMissing(null)).toBe(false);
    expect(isRpcMissing(undefined)).toBe(false);
  });
});
