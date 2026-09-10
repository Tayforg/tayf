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

/** Collects every `href` prop found anywhere in a React element tree. */
function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { href?: unknown; children?: ReactNode } };
    if (typeof el.props?.href === "string") out.push(el.props.href);
    if (el.props?.children !== undefined) collectHrefs(el.props.children, out);
  }
  return out;
}

/** Collects every `id` prop found anywhere in a React element tree. */
function collectIds(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectIds(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { id?: unknown; children?: ReactNode } };
    if (typeof el.props?.id === "string") out.push(el.props.id);
    if (el.props?.children !== undefined) collectIds(el.props.children, out);
  }
  return out;
}

/**
 * Walks every prop (className, href, children text, etc.) of every element
 * in the tree and collects every string value found, recursing into nested
 * elements and arrays. Unlike `collectText`, this also sees strings that
 * were passed through a prop (e.g. a `PageHero subtitle`) rather than
 * rendered as a JSX child.
 */
function collectStringProps(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectStringProps(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: Record<string, unknown> };
    if (el.props && typeof el.props === "object") {
      for (const value of Object.values(el.props)) {
        if (typeof value === "string") {
          out.push(value);
        } else if (value && typeof value === "object") {
          collectStringProps(value, out);
        }
      }
    }
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

    // Source-kind sentence: aggregator/niche kinds are cluster members but
    // never vote in the spectrum, blindspot or surprise calculations.
    expect(text).toContain(
      "yanlılık dağılımına, kör nokta ve sürpriz hesaplarına sayılmaz",
    );
    expect(collectHrefs(tree)).toContain("/sources");
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

  // Regression guard: a table-of-contents pill pointing at a renamed or
  // removed section id would silently break in-page navigation.
  it("links every table-of-contents pill to a section id that exists on the page", async () => {
    const { default: MethodologyPage } = await import("./page");
    const tree = MethodologyPage();
    const ids = collectIds(tree);
    const anchors = collectHrefs(tree).filter((href) => href.startsWith("#"));
    expect(anchors.length).toBeGreaterThanOrEqual(7);
    for (const href of anchors) expect(ids).toContain(href.slice(1));
  });

  // Regression guard: catches the stale "144 Türk haber kaynağı" claim
  // (the count belongs on /sources, which computes it live) and a bias-zone
  // column rendered as bare text without its contract dot colour.
  it("never hard-codes a source count and marks each Medya DNA zone with its contract dot colour", async () => {
    const { default: MethodologyPage } = await import("./page");
    const strings = collectStringProps(MethodologyPage()).join(" ");
    expect(strings).not.toMatch(/\d+\s*Türk haber kaynağ/);
    for (const zone of Object.values(ZONE_META)) expect(strings).toContain(zone.dot);
  });
});
