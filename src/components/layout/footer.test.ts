import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source guard: footer.tsx claimed "Çerez kullanmıyoruz" (no cookies) while
// /api/oyun/cerceve/next sets a 30-day session cookie. The copy must own
// that cookie truthfully instead of denying it.
describe("footer.tsx cookie copy", () => {
  const src = readFileSync(join(__dirname, "footer.tsx"), "utf8");

  it("no longer claims no cookies are used", () => {
    expect(src).not.toContain("Çerez kullanmıyoruz");
  });

  it("truthfully names the Çerçeve session cookie's 30-day retention and Vercel Web Analytics", () => {
    expect(src).toContain("30 gün");
    expect(src).toContain("Çerçeve");
    expect(src).toContain("Vercel Web Analytics");
  });
});
