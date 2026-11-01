import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");

describe("next.config.ts images sizing", () => {
  const src = readFileSync(join(root, "next.config.ts"), "utf8");

  it("sets deviceSizes down to 384 and drops the unused 3840", () => {
    expect(src).toMatch(/deviceSizes:\s*\[[^\]]*384[^\]]*\]/);
    expect(src).not.toMatch(/deviceSizes:\s*\[[^\]]*3840[^\]]*\]/);
  });

  it("sets imageSizes including 160 and 320", () => {
    const m = src.match(/imageSizes:\s*\[([^\]]*)\]/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain("160");
    expect(m![1]).toContain("320");
  });
});

describe("cluster-card.tsx thumbnail sizes", () => {
  const src = readFileSync(join(root, "src/components/story/cluster-card.tsx"), "utf8");

  it("thumbnail renders width={160} without sizes", () => {
    // The thumbnail is the <ClusterCardImage> after the `hidden sm:block`
    // wrapper. A `sizes` with no vw term (the old fixed "160px") made next/image
    // emit all 15 configured widths; width 160 alone gives a 1x/2x pair, and
    // 160/320 are in imageSizes (asserted above).
    const from = src.indexOf("hidden sm:block");
    expect(from).toBeGreaterThan(-1);
    const start = src.indexOf("<ClusterCardImage", from);
    const tag = src.slice(start, src.indexOf("/>", start) + 2);
    expect(tag).toContain("width={160}");
    expect(tag).not.toMatch(/\bsizes=/);
    expect(src).not.toContain('sizes="160px"');
    expect(src).not.toContain("(min-width: 640px) 160px, 100vw");
  });
});
