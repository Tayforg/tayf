import { describe, it, expect, vi } from "vitest";

import { BLINDSPOT } from "../../../supabase/functions/_shared/cluster/blindspot";
import { applyRecallVeto, logRecallVeto, publicBlindspotClaim } from "./recall-veto";

describe("applyRecallVeto", () => {
  it("withdraws the blindspot claim and nulls the side when the recall veto is set", () => {
    expect(
      applyRecallVeto({
        is_blindspot: true,
        blindspot_side: "pro_government",
        blindspot_recall_veto: true,
      }),
    ).toEqual({ isBlindspot: false, blindspotSide: null, vetoed: true });
  });

  it("passes through when the veto column is absent (fixtures, pre-071 rows)", () => {
    expect(
      applyRecallVeto({ is_blindspot: true, blindspot_side: "opposition" }),
    ).toEqual({ isBlindspot: true, blindspotSide: "opposition", vetoed: false });
  });

  it("passes through when the veto is null (missing data never hides anything)", () => {
    expect(
      applyRecallVeto({
        is_blindspot: true,
        blindspot_side: "pro_government",
        blindspot_recall_veto: null,
      }),
    ).toEqual({ isBlindspot: true, blindspotSide: "pro_government", vetoed: false });
  });

  it("passes through when the veto is false", () => {
    expect(
      applyRecallVeto({
        is_blindspot: true,
        blindspot_side: "pro_government",
        blindspot_recall_veto: false,
      }),
    ).toEqual({ isBlindspot: true, blindspotSide: "pro_government", vetoed: false });
  });

  it("leaves a non-blindspot row unchanged even if the veto is (stale-)true", () => {
    expect(
      applyRecallVeto({
        is_blindspot: false,
        blindspot_side: null,
        blindspot_recall_veto: true,
      }),
    ).toEqual({ isBlindspot: false, blindspotSide: null, vetoed: false });
  });

  it("only treats a literal `true` as a veto (truthy non-booleans pass through)", () => {
    const row = {
      is_blindspot: true,
      blindspot_side: "pro_government",
      blindspot_recall_veto: "true" as unknown as boolean,
    };
    expect(applyRecallVeto(row).vetoed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// h37-content-1: the public claim also waits BLINDSPOT.feedDelayHours, like
// /blindspots does. applyRecallVeto above stays the raw veto.
// ---------------------------------------------------------------------------

describe("publicBlindspotClaim", () => {
  const NOW = Date.parse("2026-11-05T12:00:00.000Z");
  const HOUR = 3_600_000;
  const agoIso = (hours: number) => new Date(NOW - hours * HOUR).toISOString();
  const flagged = {
    is_blindspot: true,
    blindspot_side: "pro_government" as const,
    blindspot_recall_veto: false,
  };

  it("holds back a flagged, unvetoed claim younger than the feed delay (pending)", () => {
    expect(publicBlindspotClaim({ ...flagged, first_published: agoIso(1) }, NOW)).toEqual({
      isBlindspot: false,
      blindspotSide: null,
      vetoed: false,
      pending: true,
    });
  });

  it("shows the stored claim once the cluster is older than the feed delay", () => {
    expect(publicBlindspotClaim({ ...flagged, first_published: agoIso(25) }, NOW)).toEqual({
      isBlindspot: true,
      blindspotSide: "pro_government",
      vetoed: false,
      pending: false,
    });
  });

  it("is pending one millisecond short of BLINDSPOT.feedDelayHours (the delay comes from the shared contract)", () => {
    const oneMsYounger = new Date(NOW - BLINDSPOT.feedDelayHours * HOUR + 1).toISOString();
    expect(publicBlindspotClaim({ ...flagged, first_published: oneMsYounger }, NOW).pending).toBe(true);
  });

  it("shows the claim at exactly BLINDSPOT.feedDelayHours old (inclusive boundary)", () => {
    const r = publicBlindspotClaim({ ...flagged, first_published: agoIso(BLINDSPOT.feedDelayHours) }, NOW);
    expect(r.isBlindspot).toBe(true);
    expect(r.blindspotSide).toBe("pro_government");
    expect(r.pending).toBe(false);
  });

  it.each([
    ["1 h", 1],
    ["25 h", 25],
    ["400 h", 400],
  ])("keeps a vetoed row vetoed at any age (%s), never pending", (_l, hours) => {
    expect(
      publicBlindspotClaim(
        { ...flagged, blindspot_recall_veto: true, first_published: agoIso(hours) },
        NOW,
      ),
    ).toEqual({ isBlindspot: false, blindspotSide: null, vetoed: true, pending: false });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["unparseable", "not-a-date"],
    ["empty string", ""],
  ])("behaves exactly like applyRecallVeto when first_published is %s (missing data never hides)", (_l, fp) => {
    const row = { ...flagged, first_published: fp as string | null | undefined };
    expect(publicBlindspotClaim(row, NOW)).toEqual({ ...applyRecallVeto(row), pending: false });
  });

  it("does not hide anything when the clock value is not a finite number", () => {
    const row = { ...flagged, first_published: agoIso(1) };
    expect(publicBlindspotClaim(row, Number.NaN)).toEqual({ ...applyRecallVeto(row), pending: false });
  });

  it("leaves a non-blindspot row unchanged and never marks it pending, however young", () => {
    expect(
      publicBlindspotClaim(
        { is_blindspot: false, blindspot_side: null, first_published: agoIso(1) },
        NOW,
      ),
    ).toEqual({ isBlindspot: false, blindspotSide: null, vetoed: false, pending: false });
  });

  it("treats a future first_published as young (pending), like /blindspots' strict cutoff", () => {
    expect(publicBlindspotClaim({ ...flagged, first_published: agoIso(-5) }, NOW).pending).toBe(true);
  });
});

describe("logRecallVeto", () => {
  it("logs with the same shape as the feed-health suppression log", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logRecallVeto("abc");
    expect(spy).toHaveBeenCalledWith("[recall-veto] withdrew blindspot for cluster abc");
    spy.mockRestore();
  });
});
