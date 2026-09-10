import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";

import manifest from "./manifest";

describe("manifest", () => {
  const icons = manifest().icons ?? [];

  it("declares at least one icon", () => {
    expect(icons.length).toBeGreaterThan(0);
  });

  it("never points an icon at a favicon.ico (404s in production)", () => {
    for (const icon of icons) {
      expect(icon.src.toLowerCase().endsWith(".ico")).toBe(false);
    }
  });

  it("maps every icon src to a file that actually exists under src/app", () => {
    for (const icon of icons) {
      // "/icon.svg" -> src/app/icon.svg
      const relative = icon.src.replace(/^\//, "");
      const filePath = path.resolve(__dirname, relative);
      expect(existsSync(filePath), `${icon.src} -> ${filePath}`).toBe(true);
    }
  });
});
