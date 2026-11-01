import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { twMerge } from "tailwind-merge";

import { badgeVariants } from "@/components/ui/badge";
import { BIAS_COLORS, BIAS_LABELS } from "@/lib/bias/config";
import type { BiasCategory } from "@/types";

import { BiasBadge } from "./bias-badge";

// BiasBadge used to render the shadcn <Badge variant="outline">, which is a
// client-graph module (Base UI useRender + tailwind-merge + cva). That dragged
// ~32 KB of tailwind-merge into every public route (h13-weight-2). It now
// renders a plain <span> with literal classes. This suite pins that the plain
// span carries EXACTLY the classes the merged Badge produced, for every bias
// and both sizes, so the look cannot drift from the old one. (The imports of
// tailwind-merge and ui/badge here are test-only: the suite is not part of any
// route's client graph.)

const here = dirname(fileURLToPath(import.meta.url));

const SIZE_CLASS = { default: "", sm: "text-[10px] px-1.5 py-0" } as const;
const BIASES = Object.keys(BIAS_LABELS) as BiasCategory[];

function decodeEntities(s: string): string {
  return s
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

function tokens(classAttr: string): string[] {
  return [...new Set(classAttr.split(/\s+/).filter(Boolean))].sort();
}

function renderedClassTokens(html: string): string[] {
  const m = html.match(/^<span\b[^>]*?\sclass="([^"]*)"/);
  expect(m, `no class attribute in ${html}`).not.toBeNull();
  return tokens(decodeEntities(m![1]!));
}

function expectedTokens(bias: BiasCategory, size: "default" | "sm"): string[] {
  return tokens(
    twMerge(
      badgeVariants({ variant: "outline" }),
      `${BIAS_COLORS[bias].className} ${SIZE_CLASS[size]}`,
    ),
  );
}

describe("BiasBadge class parity with the merged <Badge variant=outline>", () => {
  const cases = BIASES.flatMap((bias) =>
    (["default", "sm"] as const).map((size) => [bias, size] as const),
  );

  it("covers every bias category", () => {
    expect(BIASES).toHaveLength(10);
    expect(Object.keys(BIAS_COLORS).sort()).toEqual([...BIASES].sort());
  });

  it.each(cases)("%s / %s: same class-token set as twMerge(badge outline, palette + size)", (bias, size) => {
    const html = renderToStaticMarkup(
      size === "sm" ? <BiasBadge bias={bias} size="sm" /> : <BiasBadge bias={bias} />,
    );
    expect(renderedClassTokens(html)).toEqual(expectedTokens(bias, size));
  });

  it("an explicit size=\"default\" renders the same as the omitted size", () => {
    for (const bias of BIASES) {
      expect(renderToStaticMarkup(<BiasBadge bias={bias} size="default" />)).toBe(
        renderToStaticMarkup(<BiasBadge bias={bias} />),
      );
    }
  });
});

describe("BiasBadge markup", () => {
  it.each(BIASES)("%s renders a plain <span> holding the Turkish label", (bias) => {
    const html = renderToStaticMarkup(<BiasBadge bias={bias} />);
    expect(html.startsWith("<span ")).toBe(true);
    expect(html.endsWith(`>${BIAS_LABELS[bias]}</span>`)).toBe(true);
    // A single element: no wrapper, no children besides the label.
    expect(html.match(/</g)).toHaveLength(2);
  });

  it("the sm size is the only difference: it appends the small-text classes", () => {
    const def = renderedClassTokens(renderToStaticMarkup(<BiasBadge bias="center" />));
    const sm = renderedClassTokens(renderToStaticMarkup(<BiasBadge bias="center" size="sm" />));
    expect(def).toContain("text-xs");
    expect(def).toContain("px-2");
    expect(sm).not.toContain("text-xs");
    expect(sm).not.toContain("px-2");
    expect(sm).toEqual(expect.arrayContaining(["text-[10px]", "px-1.5", "py-0"]));
  });
});

describe("bias-badge.tsx / bias-spectrum.tsx source", () => {
  const badgeSrc = readFileSync(join(here, "bias-badge.tsx"), "utf8");
  const spectrumSrc = readFileSync(join(here, "bias-spectrum.tsx"), "utf8");

  it("bias-badge.tsx no longer imports the ui/badge primitive", () => {
    expect(badgeSrc).not.toMatch(/components\/ui\/badge/);
  });

  it("the dead BIAS_BADGE_CONFIG is gone from the badge and from the spectrum re-export", () => {
    expect(badgeSrc).not.toMatch(/export\s+const\s+BIAS_BADGE_CONFIG/);
    expect(spectrumSrc).not.toMatch(/from\s+["']\.\/bias-badge["']/);
    expect(spectrumSrc).not.toMatch(/export\s*\{\s*BIAS_BADGE_CONFIG\s*\}/);
  });
});
