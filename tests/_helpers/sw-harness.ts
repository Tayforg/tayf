// Test harness for the offline-reading service worker (src/lib/pwa/sw-source.ts).
//
// The real built source is evaluated in a `node:vm` context that looks just
// enough like a ServiceWorkerGlobalScope: `self` is the context itself, the
// Node 24 web globals (Request/Response/Headers/URL/...) are shared in, and
// `caches` is an in-memory CacheStorage. Top-level `function` declarations of
// the worker become context properties, so tests can call `ctx.classifyRequest`
// and compare it with the TS twin in sw-policy.ts. Top-level `const`s (CONFIG,
// CONTRACT) are NOT properties; read them with `evaluate("CONFIG")`.

import vm from "node:vm";
import { vi, type Mock } from "vitest";

export type FetchImpl = (input: string | Request, init?: RequestInit) => Promise<Response>;

export interface FakeResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  type?: ResponseType;
  url?: string;
  redirected?: boolean;
}

interface Overrides {
  status?: number;
  type: ResponseType;
  url: string;
  redirected: boolean;
}

function decorate(res: Response, o: Overrides): Response {
  Object.defineProperty(res, "type", { value: o.type, configurable: true });
  Object.defineProperty(res, "url", { value: o.url, configurable: true });
  Object.defineProperty(res, "redirected", { value: o.redirected, configurable: true });
  if (o.status !== undefined) {
    Object.defineProperty(res, "status", { value: o.status, configurable: true });
    Object.defineProperty(res, "ok", {
      value: o.status >= 200 && o.status < 300,
      configurable: true,
    });
  }
  const originalClone = res.clone.bind(res);
  // clone() keeps the overrides (a bare clone would reset type/url to "default"/"")
  Object.defineProperty(res, "clone", {
    value: () => decorate(originalClone(), o),
    configurable: true,
  });
  return res;
}

/** A Response whose type/url/redirected (and an unconstructable status such as 0) are overridden and survive clone(). */
export function fakeResponse(body: BodyInit | null, opts: FakeResponseOptions = {}): Response {
  const status = opts.status ?? 200;
  const constructable = status >= 200 && status <= 599;
  const nullBody = status === 204 || status === 205 || status === 304;
  const res = new Response(nullBody || !constructable ? null : body, {
    status: constructable ? status : 200,
    headers: opts.headers,
  });
  return decorate(res, {
    status: constructable ? undefined : status,
    type: opts.type ?? "basic",
    url: opts.url ?? "",
    redirected: opts.redirected ?? false,
  });
}

export interface FakeRequestOptions {
  method?: string;
  mode?: RequestMode;
  cache?: RequestCache;
  headers?: Record<string, string>;
}

/** A Request with `mode` / `cache` forced (undici refuses mode "navigate" and only-if-cached in the constructor). */
export function fakeRequest(url: string, opts: FakeRequestOptions = {}): Request {
  const req = new Request(url, { method: opts.method ?? "GET", headers: opts.headers });
  Object.defineProperty(req, "mode", { value: opts.mode ?? "navigate", configurable: true });
  if (opts.cache !== undefined) {
    Object.defineProperty(req, "cache", { value: opts.cache, configurable: true });
  }
  return req;
}

export type CacheOp = { op: "open" | "put" | "delete"; cache: string; url?: string };

function keyOf(input: string | Request | URL): string {
  return typeof input === "string" ? new URL(input).href : input instanceof URL ? input.href : input.url;
}

class FakeCache {
  readonly entries = new Map<string, Response>();

  constructor(
    private readonly name: string,
    private readonly log: CacheOp[],
  ) {}

  async put(input: string | Request, res: Response): Promise<void> {
    const url = keyOf(input);
    this.log.push({ op: "put", cache: this.name, url });
    this.entries.delete(url); // a re-put moves the key to the end (insertion order)
    this.entries.set(url, res.clone());
  }

  async match(input: string | Request, _opts?: { ignoreVary?: boolean }): Promise<Response | undefined> {
    return this.entries.get(keyOf(input))?.clone();
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((u) => new Request(u));
  }

  async delete(input: string | Request): Promise<boolean> {
    const url = keyOf(input);
    this.log.push({ op: "delete", cache: this.name, url });
    return this.entries.delete(url);
  }
}

/** In-memory CacheStorage: caches kept in creation order. */
export class FakeCacheStorage {
  readonly store = new Map<string, FakeCache>();
  readonly log: CacheOp[] = [];

  async open(name: string): Promise<FakeCache> {
    let cache = this.store.get(name);
    if (!cache) {
      this.log.push({ op: "open", cache: name });
      cache = new FakeCache(name, this.log);
      this.store.set(name, cache);
    }
    return cache;
  }

  async has(name: string): Promise<boolean> {
    return this.store.has(name);
  }

  async keys(): Promise<string[]> {
    return [...this.store.keys()];
  }

  async delete(name: string): Promise<boolean> {
    this.log.push({ op: "delete", cache: name });
    return this.store.delete(name);
  }

  async match(input: string | Request, opts?: { ignoreVary?: boolean }): Promise<Response | undefined> {
    for (const cache of this.store.values()) {
      const hit = await cache.match(input, opts);
      if (hit) return hit;
    }
    return undefined;
  }

  // ---- test conveniences (not part of the CacheStorage API) ----

  /** Seeds an entry without being recorded in the write log. */
  async seed(cacheName: string, url: string, res: Response): Promise<void> {
    let cache = this.store.get(cacheName);
    if (!cache) {
      cache = new FakeCache(cacheName, this.log);
      this.store.set(cacheName, cache);
    }
    cache.entries.set(keyOf(url), res.clone());
  }

  cacheNames(): string[] {
    return [...this.store.keys()];
  }

  urls(cacheName: string): string[] {
    return [...(this.store.get(cacheName)?.entries.keys() ?? [])];
  }

  async text(cacheName: string, url: string): Promise<string | null> {
    const hit = await this.store.get(cacheName)?.match(url);
    return hit ? hit.text() : null;
  }

  async headers(cacheName: string, url: string): Promise<Headers | null> {
    const hit = await this.store.get(cacheName)?.match(url);
    return hit ? hit.headers : null;
  }

  /** Writes recorded since load / the last clearLog() (open, put, delete). */
  writes(): CacheOp[] {
    return [...this.log];
  }

  clearLog(): void {
    this.log.length = 0;
  }
}

type Listener = (event: never) => void;

export interface FetchDispatch {
  /** The promise handed to respondWith, or null when the worker did not respond (bypass). */
  responded: Promise<Response> | null;
  /** Every promise handed to waitUntil, in call order. Grows as the worker calls waitUntil. */
  waits: Promise<unknown>[];
  respondWithCalls: number;
  /** Resolves once the response promise and every (also late) waitUntil promise have settled. */
  settled(): Promise<void>;
}

export interface LoadedWorker {
  /** The vm context; top-level function declarations of the worker are properties of it. */
  ctx: Record<string, (...args: unknown[]) => unknown>;
  origin: string;
  caches: FakeCacheStorage;
  skipWaiting: Mock<() => Promise<void>>;
  claim: Mock<() => Promise<void>>;
  unregister: Mock<() => Promise<boolean>>;
  fetch: Mock<FetchImpl>;
  /** Timers the worker started that have neither fired nor been cleared. */
  pendingTimers(): number;
  /** Event types the worker registered a listener for. */
  listenerTypes(): string[];
  hasListener(type: string): boolean;
  /** Evaluates an expression inside the worker (reads top-level const bindings). */
  evaluate(expr: string): unknown;
  dispatchFetch(req: Request): FetchDispatch;
  /** Resolves when the install waitUntil promises resolve; rejects when one rejects. */
  dispatchInstall(): Promise<void>;
  dispatchActivate(): Promise<void>;
  dispatchMessage(data: unknown): Promise<void>;
}

export interface LoadWorkerOptions {
  source: string;
  origin?: string;
  fetch?: FetchImpl;
}

class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

/** Mimics ExtendableEvent: waitUntil is only legal while the event is dispatching or a lifetime promise is pending. */
function makeLifetime() {
  const waits: Promise<unknown>[] = [];
  let pending = 0;
  let dispatching = true;
  const track = (p: Promise<unknown>) => {
    pending++;
    const done = () => {
      pending--;
    };
    p.then(done, done);
  };
  return {
    waits,
    waitUntil(p: Promise<unknown>) {
      if (!dispatching && pending === 0) {
        throw new InvalidStateError("waitUntil called when the event is no longer active");
      }
      const wrapped = Promise.resolve(p);
      waits.push(wrapped);
      track(wrapped);
    },
    track,
    endDispatch() {
      dispatching = false;
    },
    async settled(): Promise<void> {
      let seen = -1;
      while (seen !== waits.length) {
        seen = waits.length;
        await Promise.allSettled(waits);
      }
    },
    async all(): Promise<void> {
      let seen = -1;
      while (seen !== waits.length) {
        seen = waits.length;
        await Promise.all(waits);
      }
    },
  };
}

export function loadWorker(opts: LoadWorkerOptions): LoadedWorker {
  const origin = opts.origin ?? "https://tayf.test";
  const caches = new FakeCacheStorage();
  const listeners = new Map<string, Listener[]>();

  const fetchMock = vi.fn<FetchImpl>(
    opts.fetch ?? (async () => Promise.reject(new TypeError("fetch not mocked"))),
  );
  const skipWaiting = vi.fn<() => Promise<void>>(async () => undefined);
  const claim = vi.fn<() => Promise<void>>(async () => undefined);
  const unregister = vi.fn<() => Promise<boolean>>(async () => true);

  // The worker's timers go through these wrappers so tests can prove none is left running.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const trackedSetTimeout = (fn: () => void, ms?: number) => {
    const handle: ReturnType<typeof setTimeout> = setTimeout(() => {
      timers.delete(handle);
      fn();
    }, ms);
    timers.add(handle);
    return handle;
  };
  const trackedClearTimeout = (handle: ReturnType<typeof setTimeout>) => {
    timers.delete(handle);
    clearTimeout(handle);
  };

  const sandbox: Record<string, unknown> = {
    Request,
    Response,
    Headers,
    URL,
    AbortSignal,
    TextDecoder,
    TextEncoder,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    console,
    caches,
    fetch: fetchMock,
    location: { origin },
    skipWaiting,
    clients: { claim },
    registration: { unregister },
    addEventListener: (type: string, fn: Listener) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
  };
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  new vm.Script(opts.source, { filename: "sw.js" }).runInContext(context);

  const fire = (type: string, event: object) => {
    for (const fn of listeners.get(type) ?? []) (fn as (e: object) => void)(event);
  };

  return {
    ctx: sandbox as LoadedWorker["ctx"],
    origin,
    caches,
    skipWaiting,
    claim,
    unregister,
    fetch: fetchMock,
    pendingTimers: () => timers.size,
    listenerTypes: () => [...listeners.keys()],
    hasListener: (type) => (listeners.get(type)?.length ?? 0) > 0,
    evaluate: (expr) => vm.runInContext(expr, context),

    dispatchFetch(request) {
      const life = makeLifetime();
      const state: { responded: Promise<Response> | null; calls: number } = {
        responded: null,
        calls: 0,
      };
      const event = {
        request,
        respondWith(p: Promise<Response> | Response) {
          state.calls++;
          state.responded = Promise.resolve(p);
          life.track(state.responded);
        },
        waitUntil: life.waitUntil,
      };
      fire("fetch", event);
      life.endDispatch();
      const dispatch: FetchDispatch = {
        responded: state.responded,
        waits: life.waits,
        respondWithCalls: state.calls,
        settled: async () => {
          if (state.responded) await Promise.allSettled([state.responded]);
          await life.settled();
        },
      };
      return dispatch;
    },

    async dispatchInstall() {
      const life = makeLifetime();
      fire("install", { waitUntil: life.waitUntil });
      life.endDispatch();
      await life.all();
    },

    async dispatchActivate() {
      const life = makeLifetime();
      fire("activate", { waitUntil: life.waitUntil });
      life.endDispatch();
      await life.all();
    },

    async dispatchMessage(data) {
      const life = makeLifetime();
      fire("message", { data, source: null, waitUntil: life.waitUntil });
      life.endDispatch();
      await life.all();
    },
  };
}

/** Counts concurrent in-flight calls of a wrapped async function (used to prove sequential warming). */
export function trackConcurrency<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const state = { inFlight: 0, max: 0, calls: 0 };
  const wrapped = async (...args: A): Promise<R> => {
    state.calls++;
    state.inFlight++;
    state.max = Math.max(state.max, state.inFlight);
    try {
      return await fn(...args);
    } finally {
      state.inFlight--;
    }
  };
  return { wrapped, state };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
