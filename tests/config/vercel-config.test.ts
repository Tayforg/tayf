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

  it("keeps the other 4 crons unchanged: digest now ticks Saturday and Sunday, alerts-webhooks every 10 minutes", () => {
    const crons = (config as VercelConfig).crons;
    expect(crons).toEqual([
      { path: "/api/cron/headline", schedule: "*/5 * * * *" },
      { path: "/api/cron/digest", schedule: "0 6 * * 6,0" },
      { path: "/api/cron/fact-checks", schedule: "23 * * * *" },
      { path: "/api/cron/social", schedule: "*/20 5-20 * * *" },
      { path: "/api/cron/alerts-webhooks", schedule: "*/10 * * * *" },
    ]);
  });

  // h87-newsletter-2: Saturday sends, Sunday retries what Saturday could not send
  // (a 429 that outlasted Resend's retries, or rows left over after the send-time
  // budget). Same route, same CRON_SECRET bearer, so there is nothing new to
  // authenticate; the digest's "due" window (5 days 18 hours) is what keeps Sunday
  // from re-mailing what Saturday stamped.
  it("schedules the digest on Saturday and Sunday at 06:00 UTC, on the one authenticated route", () => {
    const digest = (config as VercelConfig).crons?.filter((c) => c.path === "/api/cron/digest");
    expect(digest).toEqual([{ path: "/api/cron/digest", schedule: "0 6 * * 6,0" }]);
  });
});
