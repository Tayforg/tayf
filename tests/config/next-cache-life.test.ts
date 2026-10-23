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
