import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { vercelTrack } = vi.hoisted(() => ({ vercelTrack: vi.fn() }));
vi.mock("@vercel/analytics", () => ({ track: vercelTrack }));

import { track } from "./track";

describe("track", () => {
  beforeEach(() => {
    vercelTrack.mockReset();
    vi.stubGlobal("window", {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("forwards the event name and props", () => {
    track("share", { clusterId: "c1", kind: "native" });
    expect(vercelTrack).toHaveBeenCalledWith("share", { clusterId: "c1", kind: "native" });
  });

  it("is a no-op on the server", () => {
    vi.unstubAllGlobals();
    track("search");
    expect(vercelTrack).not.toHaveBeenCalled();
  });

  it("swallows errors thrown by the analytics client", () => {
    vercelTrack.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => track("bookmark", { clusterId: "c1" })).not.toThrow();
  });
});
