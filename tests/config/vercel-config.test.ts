import { describe, it, expect } from "vitest";

// `@vercel/config` is a types-only package (no runtime export), so this
// import only pulls in `VercelConfig`'s shape checking at compile time --
// the actual assertions below run against the plain object `vercel.ts`
// exports.
import type { VercelConfig } from "@vercel/config/v1";
import config from "../../vercel";

describe("vercel.ts", () => {
  it("pins the deployment to lhr1 (London) -- Supabase lives in eu-west-2", () => {
    expect((config as VercelConfig).regions).toEqual(["lhr1"]);
  });

  it("keeps the 4 existing crons unchanged and adds alerts-webhooks every 10 minutes", () => {
    const crons = (config as VercelConfig).crons;
    expect(crons).toEqual([
      { path: "/api/cron/headline", schedule: "*/5 * * * *" },
      { path: "/api/cron/digest", schedule: "0 6 * * 6" },
      { path: "/api/cron/fact-checks", schedule: "23 * * * *" },
      { path: "/api/cron/social", schedule: "*/20 5-20 * * *" },
      { path: "/api/cron/alerts-webhooks", schedule: "*/10 * * * *" },
    ]);
  });
});
