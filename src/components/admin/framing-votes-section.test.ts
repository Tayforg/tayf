import { describe, it, expect } from "vitest";

import { majorityTone } from "./framing-votes-section";

// ---------------------------------------------------------------------------
// Pure-logic coverage for framing-votes-section.tsx (AGENTS.md: no render
// tests of server components — this file has no "use client").
// ---------------------------------------------------------------------------

describe("majorityTone", () => {
  it("iktidar -> bad", () => {
    expect(majorityTone("iktidar")).toBe("bad");
  });

  it("muhalefet -> ok", () => {
    expect(majorityTone("muhalefet")).toBe("ok");
  });

  it("none -> muted", () => {
    expect(majorityTone("none")).toBe("muted");
  });

  it("an unrecognized vote value -> muted (never throws)", () => {
    expect(majorityTone("")).toBe("muted");
    expect(majorityTone("something-unexpected")).toBe("muted");
  });
});
