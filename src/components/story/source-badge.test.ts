import { describe, it, expect } from "vitest";
import { SourceBadge } from "./source-badge";

describe("SourceBadge — mobile künye wrap (B)", () => {
  it("root carries shrink-0 and whitespace-nowrap so it never wraps mid-badge", () => {
    const el = SourceBadge({ trusteeSince: "2025-09-11" }) as {
      props?: { className?: string };
    } | null;
    expect(el).not.toBeNull();
    expect(el?.props?.className ?? "").toContain("shrink-0");
    expect(el?.props?.className ?? "").toContain("whitespace-nowrap");
  });

  it("renders null for a null trusteeSince", () => {
    expect(SourceBadge({ trusteeSince: null })).toBeNull();
  });
});
