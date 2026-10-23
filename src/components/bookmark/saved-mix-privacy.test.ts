import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// "Computed on the device": the reading-diet module and card must stay free of
// every network, storage and analytics primitive. The only data they see is
// the rows SavedList already fetched.
const FORBIDDEN = [
  "fetch(",
  "sendBeacon",
  "createBrowserClient",
  "@supabase",
  "@vercel/analytics",
  "@/lib/track",
  "track(",
  "localStorage",
] as const;

describe.each(["saved-mix.ts", "saved-mix-card.tsx"])("%s privacy", (file) => {
  const src = readFileSync(join(__dirname, file), "utf8");

  it.each(FORBIDDEN)("does not contain %s", (needle) => {
    expect(src).not.toContain(needle);
  });
});
