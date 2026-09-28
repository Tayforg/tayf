import type { BlueskyConfig } from "@/lib/social/config";
import type { BlueskyEmbed } from "@/lib/social/compose";

// Bluesky (AT Protocol) posting — session creation (app password ->
// accessJwt/did) then a single createRecord call per post. Both calls are
// bounded to 6s. Errors are sanitized: the app password and the session
// JWT must never reach a log line or a caller-visible error string.

const TIMEOUT_MS = 6000;
const ERROR_MAX_LEN = 300;

export interface BlueskySession {
  accessJwt: string;
  did: string;
}

export interface BlueskyPostInput {
  text: string;
  url: string;
  title: string;
  description: string;
}

export type BlueskyResult =
  | { ok: true; externalId: string }
  | { ok: false; error: string };

function sanitizeError(raw: string, secrets: string[]): string {
  let out = raw;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, ERROR_MAX_LEN);
}

export async function createBlueskySession(
  cfg: BlueskyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<BlueskySession> {
  const res = await fetchImpl(
    `${cfg.service}/xrpc/com.atproto.server.createSession`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: cfg.handle,
        password: cfg.appPassword,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // keep the HTTP-status fallback
    }
    throw new Error(sanitizeError(message, [cfg.appPassword]));
  }

  const body = (await res.json()) as { accessJwt?: string; did?: string };
  if (!body.accessJwt || !body.did) {
    throw new Error("createSession: missing accessJwt/did");
  }

  return { accessJwt: body.accessJwt, did: body.did };
}

export async function postToBluesky(
  session: BlueskySession,
  cfg: BlueskyConfig,
  input: BlueskyPostInput,
  fetchImpl: typeof fetch = fetch,
): Promise<BlueskyResult> {
  const embed: { $type: string; external: BlueskyEmbed } = {
    $type: "app.bsky.embed.external",
    external: {
      uri: input.url,
      title: input.title,
      description: input.description,
    },
  };

  try {
    const res = await fetchImpl(
      `${cfg.service}/xrpc/com.atproto.repo.createRecord`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessJwt}`,
        },
        body: JSON.stringify({
          repo: session.did,
          collection: "app.bsky.feed.post",
          record: {
            $type: "app.bsky.feed.post",
            text: input.text,
            createdAt: new Date().toISOString(),
            langs: ["tr"],
            embed,
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        error: sanitizeError(`HTTP ${res.status}`, [session.accessJwt, cfg.appPassword]),
      };
    }

    const parsed = body as { uri?: string; message?: string; error?: string };

    if (!res.ok || !parsed.uri) {
      const message = parsed.message ?? parsed.error ?? `HTTP ${res.status}`;
      return {
        ok: false,
        error: sanitizeError(message, [session.accessJwt, cfg.appPassword]),
      };
    }

    return { ok: true, externalId: parsed.uri };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: sanitizeError(message, [session.accessJwt, cfg.appPassword]),
    };
  }
}
