import { describe, it, expect, vi } from "vitest";

import { applyRecallVeto, logRecallVeto } from "./recall-veto";

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

describe("logRecallVeto", () => {
  it("logs with the same shape as the feed-health suppression log", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logRecallVeto("abc");
    expect(spy).toHaveBeenCalledWith("[recall-veto] withdrew blindspot for cluster abc");
    spy.mockRestore();
  });
});
