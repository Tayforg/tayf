import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Static guard: "haber diyetim" is a device-only mirror. None of its core
// files may issue a network call or reach for a server client / analytics
// SDK — that would silently turn a "this never leaves your browser"
// feature into one that does.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");

const FILES = [
  "src/lib/diet/diet.ts",
  "src/lib/diet/diet-store.ts",
  "src/components/diet/use-reading-diet.ts",
  "src/components/diet/diet-summary.tsx",
  "src/components/diet/least-read-nudge.tsx",
  "src/components/diet/clear-diet-button.tsx",
];

const FORBIDDEN = ["fetch(", "sendBeacon", "createBrowserClient", "@supabase", "@vercel/analytics"];

describe("haber diyetim — privacy guard", () => {
  for (const relPath of FILES) {
    it(`${relPath} contains no network / analytics / Supabase calls`, () => {
      const contents = readFileSync(resolve(ROOT, relPath), "utf8");
      for (const needle of FORBIDDEN) {
        expect(contents).not.toContain(needle);
      }
    });
  }
});
