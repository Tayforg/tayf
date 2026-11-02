import { describe, it, expect } from "vitest";
import { BIAS_ORDER } from "@/lib/bias/config";
import { WRITABLE_SOURCE_BIAS } from "@/lib/validation/source-input";
import { biasOptionValues } from "./source-dialog";

// ---------------------------------------------------------------------------
// Pure-logic coverage for the bias <Select> of SourceDialog (no render).
//
// Add mode may only offer the five keys production's sources_alignment_check
// lets a write through (WRITABLE_SOURCE_BIAS); offering state_media and the
// other four made "add source" fail with a 500 (and set_source_bias with a 400
// leaking the Postgres text). Edit mode shows the select DISABLED, so it must
// still carry every label: a legacy row (state_media, nationalist, ...) has to
// show its current label rather than a blank trigger.
// ---------------------------------------------------------------------------

describe("biasOptionValues", () => {
  it("add mode: exactly the writable keys, in the dialog's display order", () => {
    expect(biasOptionValues("add")).toEqual([...WRITABLE_SOURCE_BIAS]);
  });

  it("add mode: never offers a legacy key", () => {
    const offered = new Set<string>(biasOptionValues("add"));
    for (const legacy of ["state_media", "islamist_conservative", "international", "pro_kurdish", "nationalist"]) {
      expect(offered.has(legacy)).toBe(false);
    }
  });

  it("edit mode: all ten keys, so a legacy row still shows its label in the disabled select", () => {
    const values = biasOptionValues("edit");
    expect(values).toHaveLength(10);
    expect([...values].sort()).toEqual([...BIAS_ORDER].sort());
  });

  it("edit mode keeps every add-mode key, in the same relative order", () => {
    const edit = biasOptionValues("edit");
    const addInEdit = edit.filter((v) => (WRITABLE_SOURCE_BIAS as readonly string[]).includes(v));
    expect(addInEdit).toEqual(biasOptionValues("add"));
  });

  it("returns a fresh array each call (callers must not be able to mutate a shared list)", () => {
    const a = biasOptionValues("add");
    a.pop();
    expect(biasOptionValues("add")).toHaveLength(5);
  });
});
