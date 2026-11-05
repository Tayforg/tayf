import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const src = readFileSync(join(root, "next.config.ts"), "utf8");

// Pulls `{ stale, revalidate, expire }` for one custom cacheLife profile out
// of the config source (the config is not imported: it pulls in the whole
// Next toolchain).
function profile(name: string): { stale: number; revalidate: number; expire: number } {
  const re = new RegExp(
    `['"]?${name}['"]?\\s*:\\s*\\{([^}]*)\\}`,
  );
  const m = re.exec(src);
  expect(m, `cacheLife profile '${name}' must be defined in next.config.ts`).toBeTruthy();
  const num = (key: string) => {
    const k = new RegExp(`${key}\\s*:\\s*(\\d+)`).exec(m![1]!);
    expect(k, `${name}.${key}`).toBeTruthy();
    return Number(k![1]);
  };
  return { stale: num("stale"), revalidate: num("revalidate"), expire: num("expire") };
}

describe("next.config.ts cacheLife 'status' profile (/durum)", () => {
  it("is defined with stale <= revalidate <= expire", () => {
    const p = profile("status");
    expect(p.stale).toBeLessThanOrEqual(p.revalidate);
    expect(p.revalidate).toBeLessThanOrEqual(p.expire);
  });

  it("bounds how old a served snapshot can be to a few minutes (the built-in 'minutes' profile keeps entries for an hour)", () => {
    const p = profile("status");
    expect(p.revalidate).toBeLessThanOrEqual(60);
    expect(p.expire).toBeLessThanOrEqual(300);
    // the client router cache must not outlive the server window either
    expect(p.stale).toBeLessThanOrEqual(60);
  });
});

// h34-perf-1: the comment above 'cluster-feed' promised "at most ~5 min stale".
// The measured worst case is an idle spell, where the first reader gets the
// stale PPR shell AND the stale 'use cache' entry (each up to `expire` old).
describe("next.config.ts cacheLife 'cluster-feed' profile (home, hubs, /timeline)", () => {
  it("is defined with stale <= revalidate <= expire", () => {
    const p = profile("cluster-feed");
    expect(p.stale).toBeLessThanOrEqual(p.revalidate);
    expect(p.revalidate).toBeLessThanOrEqual(p.expire);
  });

  it("keeps expire at 3600: lowering it turns the idle-spell stale hit into a blocking regeneration that no preview has measured", () => {
    expect(profile("cluster-feed").expire).toBe(3600);
  });

  it("documents the real worst case instead of promising ~5 min", () => {
    const start = src.indexOf("cacheLife: {");
    const end = src.indexOf("'cluster-feed'", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const comment = src.slice(start, end);
    expect(comment).not.toMatch(/at most ~5 min stale/);
    expect(comment).toMatch(/shell/i);
    expect(comment).toMatch(/expire/);
    expect(comment).toMatch(/RelativeTime/);
  });
});
