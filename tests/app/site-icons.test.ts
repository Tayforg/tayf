import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const appleIconSvgPath = resolve(__dirname, "../../src/app/apple-icon.svg");
const appleIconTsxPath = resolve(__dirname, "../../src/app/apple-icon.tsx");
const faviconPath = resolve(__dirname, "../../src/app/favicon.ico");
const layoutPath = resolve(__dirname, "../../src/app/layout.tsx");

describe("apple-icon (C)", () => {
  it("src/app/apple-icon.svg no longer exists", () => {
    expect(existsSync(appleIconSvgPath)).toBe(false);
  });

  it("src/app/apple-icon.tsx exports a 180x180 image/png ImageResponse", () => {
    expect(existsSync(appleIconTsxPath)).toBe(true);
    const src = readFileSync(appleIconTsxPath, "utf-8");
    expect(src).toContain("ImageResponse");
    expect(src).toMatch(/width:\s*180/);
    expect(src).toMatch(/height:\s*180/);
    expect(src).toContain('"image/png"');
  });
});

describe("favicon.ico (C)", () => {
  it("is a valid single-image ICO wrapping a 32x32 PNG", () => {
    expect(existsSync(faviconPath)).toBe(true);
    const buf = readFileSync(faviconPath);

    // ICONDIR: reserved=0, type=1 (icon), count=1 — all little-endian u16.
    expect(buf.readUInt16LE(0)).toBe(0);
    expect(buf.readUInt16LE(2)).toBe(1);
    expect(buf.readUInt16LE(4)).toBe(1);

    // ICONDIRENTRY width byte (0 means 256, so 32 must be literal 32).
    expect(buf.readUInt8(6)).toBe(32);

    // Image data offset (u32 LE at byte 18) must point at a PNG signature.
    const offset = buf.readUInt32LE(18);
    expect(offset).toBe(22);
    expect(buf.subarray(offset, offset + 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });
});

describe("layout.tsx icon wiring (C)", () => {
  it("drops the hard-coded icons key and the apple-icon.svg reference, letting file conventions wire in", () => {
    const src = readFileSync(layoutPath, "utf-8");
    expect(src).not.toContain("apple-icon.svg");
    expect(src).not.toMatch(/\bicons:\s*{/);
  });
});
