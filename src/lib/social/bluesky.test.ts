import { describe, it, expect, vi } from "vitest";
import { createBlueskySession, postToBluesky } from "./bluesky";
import type { BlueskyConfig } from "./config";

const cfg: BlueskyConfig = {
  handle: "tayf.bsky.social",
  appPassword: "SECRET-APP-PASSWORD",
  service: "https://bsky.social",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createBlueskySession", () => {
  it("posts the exact URL and body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ accessJwt: "jwt-abc", did: "did:plc:xyz" }),
    );
    await createBlueskySession(cfg, fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${cfg.service}/xrpc/com.atproto.server.createSession`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ identifier: cfg.handle, password: cfg.appPassword });
  });

  it("returns accessJwt and did", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ accessJwt: "jwt-abc", did: "did:plc:xyz" }),
    );
    const session = await createBlueskySession(cfg, fetchImpl);
    expect(session).toEqual({ accessJwt: "jwt-abc", did: "did:plc:xyz" });
  });

  it("throws a sanitized error without the app password on failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: `bad password ${cfg.appPassword}` }, 401),
    );
    await expect(createBlueskySession(cfg, fetchImpl)).rejects.toThrow();
    try {
      await createBlueskySession(cfg, fetchImpl);
    } catch (err) {
      expect((err as Error).message).not.toContain(cfg.appPassword);
    }
  });
});

describe("postToBluesky", () => {
  const session = { accessJwt: "jwt-abc", did: "did:plc:xyz" };
  const input = {
    text: "merhaba",
    url: "https://tayfhaber.com/cluster/1?utm_source=bluesky",
    title: "Başlık",
    description: "İktidar 2 · Bağımsız 1 · Muhalefet 2",
  };

  it("posts createRecord with the Authorization bearer header and expected body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ uri: "at://did:plc:xyz/app.bsky.feed.post/abc" }),
    );
    await postToBluesky(session, cfg, input, fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${cfg.service}/xrpc/com.atproto.repo.createRecord`);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${session.accessJwt}`);

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.repo).toBe(session.did);
    expect(body.collection).toBe("app.bsky.feed.post");
    expect(body.record.$type).toBe("app.bsky.feed.post");
    expect(body.record.text).toBe(input.text);
    expect(body.record.langs).toEqual(["tr"]);
    expect(body.record.embed).toEqual({
      $type: "app.bsky.embed.external",
      external: { uri: input.url, title: input.title, description: input.description },
    });
  });

  it("returns the record uri as externalId on success", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ uri: "at://did:plc:xyz/app.bsky.feed.post/abc" }),
    );
    const res = await postToBluesky(session, cfg, input, fetchImpl);
    expect(res).toEqual({ ok: true, externalId: "at://did:plc:xyz/app.bsky.feed.post/abc" });
  });

  it("returns {ok:false} on a non-2xx response, without leaking the JWT or app password", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: `token ${session.accessJwt} expired, password ${cfg.appPassword}` }, 401),
    );
    const res = await postToBluesky(session, cfg, input, fetchImpl);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain(session.accessJwt);
      expect(res.error).not.toContain(cfg.appPassword);
    }
  });

  it("handles a timeout/network error without leaking secrets", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`network error with jwt ${session.accessJwt}`);
    });
    const res = await postToBluesky(session, cfg, input, fetchImpl);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain(session.accessJwt);
    }
  });
});
