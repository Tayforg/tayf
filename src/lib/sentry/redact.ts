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
 * Second job (h53-privacy-1): the URL QUERY STRING. The home page reads ?q= and
 * /takip takes follow keywords, so the reader's search text rides in the query
 * of every URL the SDK copies verbatim (request.url, the Referer header,
 * navigation / fetch breadcrumbs, transaction and span names, span attributes).
 * `dataCollection.urlQueryParams: false` only covers what the SDK collects by
 * itself; stripUrlQuery and the scrubbers below cover the rest. The Referer
 * header also reaches the root span as the `http.request.header.referer`
 * attribute (a string[]): the primary control there is the "referer" entry in
 * SENTRY_DATA_COLLECTION.httpHeaders.request.deny, and scrubUrlBag strips the
 * query from that attribute as defence in depth.
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

/**
 * Cuts a URL (absolute or relative) at its first "?", dropping the query and
 * anything after it, including a fragment. Fail closed: no parsing, so no
 * input can make it keep a query. A string with no "?" comes back unchanged.
 */
export function stripUrlQuery(url: string): string {
  const at = url.indexOf("?");
  return at === -1 ? url : url.slice(0, at);
}

// A transaction or span name is free text ("GET /?q=x", but also a SQL
// description ending in "= ?"). Only strings that open like an HTTP route or
// URL, with an optional method, are cut. Not global: safe with .test.
const HTTP_NAME =
  /^(?:(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE) )?(?:[a-z][a-z0-9+.-]*:\/\/|\/(?!\*))/i;

function stripNameQuery(name: string): string {
  return HTTP_NAME.test(name) ? stripUrlQuery(name) : name;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keys (event data, breadcrumb data, span attributes) whose value is a URL. */
const URL_KEYS = ["url", "url.full", "http.url", "http.target", "from", "to"] as const;
/** Keys that hold nothing but a query string: dropped outright. */
const QUERY_KEYS = ["query_string", "url.query", "http.query"] as const;

/** Applies `strip` to every string element of `list`, in place; anything else in it is kept. */
function stripElements(list: unknown[], strip: (s: string) => string): void {
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (typeof el !== "string") continue;
    const next = strip(el);
    if (next !== el) list[i] = next;
  }
}

/**
 * Strips the query from `bag[key]`: a plain string, a string[] (the SDK's
 * `http.request.header.*` attributes), or a streamed-span attribute
 * `{ value, type }` whose value is either.
 */
function stripQueryAt(bag: Record<string, unknown>, key: string, strip: (s: string) => string): void {
  const v = bag[key];
  if (typeof v === "string") {
    const next = strip(v);
    if (next !== v) bag[key] = next;
  } else if (Array.isArray(v)) {
    stripElements(v as unknown[], strip);
  } else if (isRecord(v)) {
    const inner = v.value;
    if (typeof inner === "string") {
      const next = strip(inner);
      if (next !== inner) v.value = next;
    } else if (Array.isArray(inner)) {
      stripElements(inner as unknown[], strip);
    }
  }
}

/**
 * The Referer header as the SDK copies it onto a span (`http.request.header.referer`,
 * a string[]). The HTTP header is spelled "referer"; "referrer" is matched too
 * because the misspelling is common in hand-built payloads. Not global: safe with .test.
 */
const REFERER_ATTRIBUTE = /^http\.request\.header\.referr?er$/i;

/** One data / attributes bag: drops the query-only keys, strips the query from the URL keys and the Referer attribute. */
function scrubUrlBag(bag: unknown): void {
  if (!isRecord(bag)) return;
  for (const key of QUERY_KEYS) {
    if (Object.hasOwn(bag, key)) delete bag[key];
  }
  for (const key of URL_KEYS) {
    if (Object.hasOwn(bag, key)) stripQueryAt(bag, key, stripUrlQuery);
  }
  // A same-origin Referer is the full referring url, query (the reader's ?q=) included.
  for (const key of Object.keys(bag)) {
    if (REFERER_ATTRIBUTE.test(key)) stripQueryAt(bag, key, stripUrlQuery);
  }
}

/** A span-shaped object (streamed span, static span, trace context): name, description, data, attributes, links. */
function scrubSpanQueries(span: unknown): void {
  if (!isRecord(span)) return;
  stripQueryAt(span, "name", stripNameQuery);
  stripQueryAt(span, "description", stripNameQuery);
  scrubUrlBag(span.data);
  scrubUrlBag(span.attributes);
  if (Array.isArray(span.links)) {
    for (const link of span.links as unknown[]) {
      if (isRecord(link)) scrubUrlBag(link.attributes);
    }
  }
}

/** Error / transaction event: request, transaction name, breadcrumbs, trace context, static spans. */
function scrubEventQueries(event: Record<string, unknown>): void {
  const request = event.request;
  if (isRecord(request)) {
    stripQueryAt(request, "url", stripUrlQuery);
    if (Object.hasOwn(request, "query_string")) delete request.query_string;
    const headers = request.headers;
    if (isRecord(headers)) {
      for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        // A same-origin click sends the FULL referring url, query included.
        if (lower === "referer" || lower === "referrer") stripQueryAt(headers, name, stripUrlQuery);
      }
    }
  }
  stripQueryAt(event, "transaction", stripNameQuery);
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs as unknown[]) {
      if (isRecord(crumb)) scrubUrlBag(crumb.data);
    }
  }
  if (isRecord(event.contexts)) scrubSpanQueries(event.contexts.trace);
  if (Array.isArray(event.spans)) {
    for (const span of event.spans as unknown[]) scrubSpanQueries(span);
  }
}

type HeaderBag = Record<string, unknown>;

/**
 * Error / transaction events: drops the credential headers the SDK attaches to
 * route-handler events (the cron bearer, cookies; matched case-insensitively),
 * then redacts the share token everywhere in the event. Referrer-Policy
 * strict-origin-when-cross-origin sends the FULL url same-origin, so a click on
 * the page's own "Markdown indir" link puts a live /rapor/<token> URL in
 * Referer; the deep walk covers every header value, so a future header cannot
 * reintroduce the leak. Then strips the URL query string (h53-privacy-1) from
 * request.url, the Referer header, the transaction name, breadcrumb data, the
 * trace context and static spans, and deletes request.query_string.
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
  redactDeep(e);
  if (isRecord(e)) scrubEventQueries(e);
  return e;
}

/**
 * Streamed (traceLifecycle "stream") and static spans: name, attributes, links.
 * The share token is redacted everywhere; the query string is stripped from the
 * name and the URL attributes, and `url.query` is dropped.
 */
export const scrubSentrySpan = <S>(s: S): S => {
  redactDeep(s);
  scrubSpanQueries(s);
  return s;
};

/**
 * Navigation / fetch / xhr breadcrumbs: data.from, data.to, data.url, message.
 * The query string is stripped from data.url / from / to.
 */
export const scrubSentryBreadcrumb = <B>(b: B): B => {
  redactDeep(b);
  if (isRecord(b)) scrubUrlBag(b.data);
  return b;
};
