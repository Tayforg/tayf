import { describe, expect, it } from "vitest";

import { BIAS_ORDER } from "@/lib/bias/config";

import { toSavedRowView } from "./saved-row";

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
