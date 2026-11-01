/**
 * Scrubbing helpers shared by the Node, Edge and browser Sentry inits
 * (sentry.server.config.ts / sentry.edge.config.ts / instrumentation-client.ts).
 *
 * Why: the /rapor/<token> share URL is a capability secret that travels in the
 * URL PATH (not a header or query string, so neither the SDK's own filters nor
 * `dataCollection` touch it). Anything that carries a URL can ship a working,
 * unexpired share link to Sentry: the error event (request.url, the Referer
 * header, the transaction name, navigation/fetch breadcrumbs, trace context),
 * the streamed spans of @sentry/nextjs 11's default `traceLifecycle: "stream"`
 * (name, url.full / http.target / url.path attributes, links) and, under
 * `traceLifecycle: "static"`, the transaction event and its spans.
 * tests/guards/sentry-data-collection.test.ts feeds each of those to the hook
 * every config wires and fails if the token survives.
 *
 * The scrubbers mutate in place and return the SAME object. They never return
 * null, so a redaction can never turn into a dropped event. Generic over the
 * payload type so they slot into the SDK's `beforeSend` / `beforeSendSpan` /
 * `beforeBreadcrumb` signatures without casts.
 *
 * No runtime imports: this file is bundled into the Edge runtime and the
 * browser.
 */

/**
 * The exact pattern the three configs used to inline. Global: only ever use it
 * with `String.prototype.replace` (which resets `lastIndex`), never `.test` or
 * `.exec`, which would carry state between calls.
 */
export const RAPOR_TOKEN_PATH = /\/rapor\/[0-9a-f]{32}/gi;

const PLACEHOLDER = "/rapor/[token]";

/** Replaces every /rapor/<32 hex> path with /rapor/[token]. */
export function redactRaporToken(s: string): string {
  return s.replace(RAPOR_TOKEN_PATH, PLACEHOLDER);
}

/** Deeper than any real event nests; also bounds the work on hostile input. */
const MAX_DEPTH = 12;

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function walk(node: object, depth: number, seen: WeakSet<object>): void {
  if (depth > MAX_DEPTH || seen.has(node)) return;
  seen.add(node);

  const bag = node as Record<string, unknown>;
  for (const key of Object.keys(bag)) {
    const value = bag[key];
    if (typeof value === "string") {
      const redacted = redactRaporToken(value);
      // Only write when something changed, so a read-only property that holds
      // no token is never touched.
      if (redacted !== value) bag[key] = redacted;
    } else if (typeof value === "object" && value !== null) {
      if (Array.isArray(value) || isPlainObject(value)) walk(value, depth + 1, seen);
    }
  }
}

/**
 * Redacts the share token from every string leaf of `v`, in place, and returns
 * `v` itself. Walks plain objects and arrays only (an SDK payload is JSON-
 * shaped), to a depth of 12, and tolerates cycles. A top-level string cannot be
 * mutated, so its redacted copy is returned instead.
 */
export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redactRaporToken(v) as T;
  if (typeof v === "object" && v !== null && (Array.isArray(v) || isPlainObject(v))) {
    walk(v, 0, new WeakSet());
  }
  return v;
}

type HeaderBag = Record<string, unknown>;

/**
 * Error / transaction events: drops the credential headers the SDK attaches to
 * route-handler events (the cron bearer, cookies; matched case-insensitively),
 * then redacts the share token everywhere in the event. Referrer-Policy
 * strict-origin-when-cross-origin sends the FULL url same-origin, so a click on
 * the page's own "Markdown indir" link puts a live /rapor/<token> URL in
 * Referer; the deep walk covers every header value, so a future header cannot
 * reintroduce the leak.
 */
export function scrubSentryEvent<E>(e: E): E {
  if (typeof e !== "object" || e === null) return e;

  const headers = (e as { request?: { headers?: unknown } }).request?.headers;
  if (typeof headers === "object" && headers !== null) {
    const bag = headers as HeaderBag;
    for (const name of Object.keys(bag)) {
      const lower = name.toLowerCase();
      if (lower === "authorization" || lower === "cookie") delete bag[name];
    }
  }
  return redactDeep(e);
}

/** Streamed (traceLifecycle "stream") and static spans: name, attributes, links. */
export const scrubSentrySpan = <S>(s: S): S => redactDeep(s);

/** Navigation / fetch / xhr breadcrumbs: data.from, data.to, data.url, message. */
export const scrubSentryBreadcrumb = <B>(b: B): B => redactDeep(b);
