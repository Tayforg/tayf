import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/components/story/correction-form", () => ({
  CorrectionForm: () => null,
}));

import { BIAS_LABELS, BLINDSPOT, SURPRISE, ZONE_META } from "@/lib/bias/config";
import { WIRE_UNIQUE_HASH_RATIO } from "@/lib/clusters/wire";
import { OWNER_GROUPS } from "@/lib/sources/ownership";
import {
  HEADLINE_MIN_ARTICLE_COUNT,
  HEADLINE_PROMPT_TEMPLATE,
} from "@/lib/headline/prompt";

function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { children?: ReactNode } };
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

describe("/metodoloji page", () => {
  it("renders every bias-zone contract number and label from the shared config", async () => {
    const { default: MethodologyPage } = await import("./page");
    const tree = MethodologyPage();
    const text = collectText(tree).join("");

    // Assert the interpolated phrasing, not bare digits — a bare-digit
    // assertion (e.g. `toContain("5")`) would still pass if the prose used
    // a hardcoded literal instead of the contract constant.
    expect(text).toContain(`en az ${BLINDSPOT.minSources} kaynak yer almalı`);
    expect(text).toContain(`≥ %${Math.round(BLINDSPOT.dominantShare * 100)}`);
    expect(text).toContain(`${BLINDSPOT.feedDelayHours} saat sonra`);

    expect(text).toContain(`en az ${SURPRISE.minSources} kaynak`);
    expect(text).toContain(`≥ %${Math.round(SURPRISE.dominantShare * 100)}`);
    expect(text).toContain(`${SURPRISE.minMargin} fazla`);

    expect(text).toContain(`≤ %${Math.round(WIRE_UNIQUE_HASH_RATIO * 100)}`);
    expect(text).toContain(`En az ${HEADLINE_MIN_ARTICLE_COUNT} kaynağı`);

    for (const label of Object.values(BIAS_LABELS)) {
      expect(text).toContain(label);
    }
    for (const zone of Object.values(ZONE_META)) {
      expect(text).toContain(zone.label);
    }
    for (const group of Object.values(OWNER_GROUPS)) {
      expect(text).toContain(group);
    }

    expect(text).toContain(HEADLINE_PROMPT_TEMPLATE);

    // Stale-literal regression guard: this threshold used to be spelled
    // out as a word instead of interpolated from BLINDSPOT.minSources.
    expect(text).not.toMatch(/Beş kaynak/);
  });

  it("shows the mailto link only when NEXT_PUBLIC_CONTACT_EMAIL is set", async () => {
    const original = process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    vi.resetModules();
    const { default: WithoutEmail } = await import("./page");
    expect(collectText(WithoutEmail()).join("")).not.toContain("@");

    process.env.NEXT_PUBLIC_CONTACT_EMAIL = "duzeltme@tayfhaber.com";
    vi.resetModules();
    const { default: WithEmail } = await import("./page");
    expect(collectText(WithEmail()).join("")).toContain(
      "duzeltme@tayfhaber.com",
    );

    if (original === undefined) {
      delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    } else {
      process.env.NEXT_PUBLIC_CONTACT_EMAIL = original;
    }
  });
});
