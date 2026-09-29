import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

const ORIGINAL = process.env.INDEXNOW_KEY;
const KEY = "abcdef0123456789abcdef0123456789";

beforeEach(() => vi.resetModules());
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INDEXNOW_KEY;
  else process.env.INDEXNOW_KEY = ORIGINAL;
});

async function get(): Promise<Response> {
  const { GET } = await import("@/app/indexnow-key.txt/route");
  return GET();
}

describe("GET /indexnow-key.txt", () => {
  it("404s when unset", async () => {
    delete process.env.INDEXNOW_KEY;
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300");
  });
  it("404s when invalid", async () => {
    process.env.INDEXNOW_KEY = "bad key!";
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });
  it("serves the exact key as text/plain when set", async () => {
    process.env.INDEXNOW_KEY = KEY;
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(KEY);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=3600");
  });
});
