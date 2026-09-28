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

  it("uses a fixed 160px sizes slot for the desktop thumbnail", () => {
    expect(src).toContain('sizes="160px"');
    expect(src).not.toContain("(min-width: 640px) 160px, 100vw");
  });
});
