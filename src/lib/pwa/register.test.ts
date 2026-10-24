import { afterEach, describe, expect, it, vi } from "vitest";

import { registerServiceWorker, type SwContainerLike } from "./register";
import { SW_READY_TIMEOUT_MS } from "./sw-contract";

const ID_A = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
const ID_B = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";

/** What `navigator.serviceWorker.ready` does: never settle, reject, or resolve a registration. */
type ReadyMode = "hang" | "reject" | { active: { postMessage(m: unknown): void } | null };

function makeContainer(opts: { controller?: boolean; regs?: number; ready?: ReadyMode } = {}) {
  const order: string[] = [];
  const post = vi.fn((_m: unknown) => {
    order.push("post");
  });
  const register = vi.fn(async (_url: string, _o: { scope: string; updateViaCache: "none" }) => {
    order.push("register");
    return {};
  });
  const unregisters = Array.from({ length: opts.regs ?? 2 }, () => vi.fn(async () => true));
  const getRegistrations = vi.fn(async () => unregisters.map((unregister) => ({ unregister })));
  const controlled = opts.controller !== false;
  // An uncontrolled page defaults to "registered, but no active worker yet": settles at once, posts nothing.
  const mode: ReadyMode = opts.ready ?? (controlled ? "hang" : { active: null });
  const readyGetter = vi.fn(() => {
    if (mode === "hang") return new Promise<never>(() => {});
    if (mode === "reject") return Promise.reject(new Error("no registration"));
    return Promise.resolve(mode);
  });
  const container: SwContainerLike = {
    controller: controlled ? { postMessage: post } : null,
    register,
    getRegistrations,
  };
  // `ready` can hang forever (no registration): only ever read, raced against a timeout, on an uncontrolled page.
  Object.defineProperty(container, "ready", { get: readyGetter, configurable: true });
  return { container, post, register, unregisters, getRegistrations, readyGetter, order };
}

function makeCaches(names: string[], opts: { failDelete?: string; keysRejects?: boolean } = {}, order: string[] = []) {
  const live = new Set(names);
  const keys = vi.fn(async () => {
    if (opts.keysRejects) throw new Error("keys boom");
    return [...live];
  });
  const del = vi.fn(async (name: string) => {
    order.push("delete:" + name);
    if (name === opts.failDelete) throw new Error("delete boom");
    return live.delete(name);
  });
  return { cachesLike: { keys, delete: del }, live, keys, del };
}

const base = (container: SwContainerLike | undefined, over: Record<string, unknown> = {}) => ({
  nodeEnv: "production" as string | undefined,
  container,
  kill: false,
  readIds: () => [ID_A, ID_B] as string[] | null,
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("registerServiceWorker", () => {
  it("skips outside production without touching the container", async () => {
    const m = makeContainer();
    const getter = vi.fn(() => m.container);
    const readIds = vi.fn(() => [ID_A]);
    for (const nodeEnv of ["development", "test", undefined]) {
      const deps = {
        nodeEnv,
        get container() {
          return getter();
        },
        kill: true,
        readIds,
      };
      await expect(registerServiceWorker(deps)).resolves.toBe("skipped-env");
    }
    expect(getter).not.toHaveBeenCalled();
    expect(readIds).not.toHaveBeenCalled();
    expect(m.register).not.toHaveBeenCalled();
    expect(m.getRegistrations).not.toHaveBeenCalled();
  });

  it("reports unsupported when there is no service worker container", async () => {
    const readIds = vi.fn(() => [ID_A]);
    await expect(registerServiceWorker(base(undefined, { readIds }))).resolves.toBe("unsupported");
    await expect(registerServiceWorker(base(undefined, { readIds, kill: true }))).resolves.toBe(
      "unsupported",
    );
    expect(readIds).not.toHaveBeenCalled();
  });

  it("registers /sw.js with scope / and updateViaCache none, exactly once", async () => {
    const m = makeContainer({ controller: false });
    await expect(registerServiceWorker(base(m.container))).resolves.toBe("registered");
    expect(m.register).toHaveBeenCalledTimes(1);
    expect(m.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
    expect(m.getRegistrations).not.toHaveBeenCalled();
  });

  it("posts a sync message after registering when a controller exists", async () => {
    const m = makeContainer();
    await expect(registerServiceWorker(base(m.container))).resolves.toBe("registered");
    expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.post).toHaveBeenCalledWith({ type: "tayf:sync", ids: [ID_A, ID_B] });
    expect(m.order).toEqual(["register", "post"]);
  });

  it("syncs an empty list (the user has no bookmarks: prune)", async () => {
    const m = makeContainer();
    await registerServiceWorker(base(m.container, { readIds: () => [] }));
    expect(m.post).toHaveBeenCalledWith({ type: "tayf:sync", ids: [] });
  });

  it("does not sync when ids are unreadable (null), controlled or on a first visit", async () => {
    const m = makeContainer();
    await expect(registerServiceWorker(base(m.container, { readIds: () => null }))).resolves.toBe(
      "registered",
    );
    expect(m.register).toHaveBeenCalledTimes(1);
    expect(m.post).not.toHaveBeenCalled();

    const activePost = vi.fn();
    const first = makeContainer({ controller: false, ready: { active: { postMessage: activePost } } });
    await expect(registerServiceWorker(base(first.container, { readIds: () => null }))).resolves.toBe(
      "registered",
    );
    expect(activePost).not.toHaveBeenCalled();
    expect(first.post).not.toHaveBeenCalled();
  });

  describe("first visit (nothing controls the page yet)", () => {
    it("syncs through registration.active once it is ready", async () => {
      const activePost = vi.fn();
      const m = makeContainer({ controller: false, ready: { active: { postMessage: activePost } } });
      activePost.mockImplementation(() => {
        m.order.push("post");
      });
      await expect(registerServiceWorker(base(m.container))).resolves.toBe("registered");
      expect(activePost).toHaveBeenCalledTimes(1);
      expect(activePost).toHaveBeenCalledWith({ type: "tayf:sync", ids: [ID_A, ID_B] });
      expect(m.order).toEqual(["register", "post"]);
      expect(m.post).not.toHaveBeenCalled();
    });

    it("reads the ids only after the target resolved, so a bookmark saved while waiting is synced", async () => {
      const log: string[] = [];
      let saved = [ID_A];
      const activePost = vi.fn((_m: unknown) => {
        log.push("post");
      });
      const m = makeContainer({ controller: false });
      let release!: (v: { active: { postMessage(m: unknown): void } }) => void;
      Object.defineProperty(m.container, "ready", {
        get: () => {
          log.push("ready");
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      });
      const readIds = vi.fn(() => {
        log.push("readIds");
        return [...saved];
      });
      const done = registerServiceWorker(base(m.container, { readIds }));
      await vi.waitFor(() => expect(log).toContain("ready"));
      expect(readIds).not.toHaveBeenCalled(); // still waiting for the worker
      saved = [ID_A, ID_B]; // the reader bookmarks another story in the meantime
      release({ active: { postMessage: activePost } });
      await expect(done).resolves.toBe("registered");
      expect(log).toEqual(["ready", "readIds", "post"]);
      expect(activePost).toHaveBeenCalledWith({ type: "tayf:sync", ids: [ID_A, ID_B] });
    });

    it("posts nothing, and does not read the ids, when the registration has no active worker", async () => {
      const m = makeContainer({ controller: false, ready: { active: null } });
      const readIds = vi.fn(() => [ID_A]);
      await expect(registerServiceWorker(base(m.container, { readIds }))).resolves.toBe("registered");
      expect(m.post).not.toHaveBeenCalled();
      expect(readIds).not.toHaveBeenCalled();
    });

    it("gives up after SW_READY_TIMEOUT_MS when ready never settles: still registered, nothing posted", async () => {
      vi.useFakeTimers();
      const m = makeContainer({ controller: false, ready: "hang" });
      let outcome: string | undefined;
      const done = registerServiceWorker(base(m.container)).then((o) => {
        outcome = o;
        return o;
      });
      await vi.advanceTimersByTimeAsync(SW_READY_TIMEOUT_MS - 1);
      expect(outcome).toBeUndefined(); // still waiting
      await vi.advanceTimersByTimeAsync(1);
      await expect(done).resolves.toBe("registered");
      expect(m.post).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a rejecting ready is still registered (not failed) and posts nothing", async () => {
      const m = makeContainer({ controller: false, ready: "reject" });
      await expect(registerServiceWorker(base(m.container))).resolves.toBe("registered");
      expect(m.readyGetter).toHaveBeenCalledTimes(1);
      expect(m.post).not.toHaveBeenCalled();
    });

    it("a ready getter that throws is still registered (not failed)", async () => {
      const m = makeContainer({ controller: false });
      Object.defineProperty(m.container, "ready", {
        get: () => {
          throw new DOMException("denied", "SecurityError");
        },
      });
      await expect(registerServiceWorker(base(m.container))).resolves.toBe("registered");
      expect(m.post).not.toHaveBeenCalled();
    });

    it("an active worker whose postMessage throws gives failed (same as a controller that throws)", async () => {
      const activePost = vi.fn(() => {
        throw new Error("clone");
      });
      const m = makeContainer({ controller: false, ready: { active: { postMessage: activePost } } });
      await expect(registerServiceWorker(base(m.container))).resolves.toBe("failed");
    });
  });

  it("never reads ready when a controller exists or the kill switch is on", async () => {
    const m = makeContainer();
    await registerServiceWorker(base(m.container));
    await registerServiceWorker(base(m.container, { kill: true }));
    const uncontrolled = makeContainer({ controller: false });
    await registerServiceWorker(base(uncontrolled.container, { kill: true }));
    expect(m.readyGetter).not.toHaveBeenCalled();
    expect(uncontrolled.readyGetter).not.toHaveBeenCalled();
  });

  it("kill: unregisters every registration and never registers", async () => {
    const m = makeContainer();
    await expect(registerServiceWorker(base(m.container, { kill: true }))).resolves.toBe("killed");
    expect(m.unregisters).toHaveLength(2);
    for (const u of m.unregisters) expect(u).toHaveBeenCalledTimes(1);
    expect(m.register).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });

  it("kill with no registrations is still killed", async () => {
    const m = makeContainer({ regs: 0 });
    await expect(registerServiceWorker(base(m.container, { kill: true }))).resolves.toBe("killed");
    expect(m.register).not.toHaveBeenCalled();
  });

  it("kill: one failing unregister is reported as failed after trying them all", async () => {
    const m = makeContainer();
    m.getRegistrations.mockResolvedValueOnce([
      {
        unregister: async () => {
          throw new Error("nope");
        },
      },
      { unregister: m.unregisters[1]! },
    ]);
    await expect(registerServiceWorker(base(m.container, { kill: true }))).resolves.toBe("failed");
    expect(m.unregisters[1]).toHaveBeenCalledTimes(1);
  });

  it("kill: getRegistrations rejecting gives failed", async () => {
    const m = makeContainer();
    m.getRegistrations.mockRejectedValueOnce(new Error("boom"));
    await expect(registerServiceWorker(base(m.container, { kill: true }))).resolves.toBe("failed");
  });

  describe("kill also purges the offline caches from the page", () => {
    // The kill worker's own activate-time purge only runs if the browser re-fetches /sw.js for a registration,
    // and this registrar has just unregistered it, so the page has to delete the caches itself.
    const NAMES = ["tayf-static-v1", "tayf-pages-v1", "tayf-shell-v1", "tayf-meta-v1", "tayf-saved-v1", "tayf-static-v0", "other-lib"];

    it("deletes every tayf- cache (saved included) and nothing else", async () => {
      const m = makeContainer();
      const c = makeCaches(NAMES);
      await expect(registerServiceWorker(base(m.container, { kill: true, cachesLike: c.cachesLike }))).resolves.toBe("killed");
      expect([...c.live]).toEqual(["other-lib"]);
      expect(c.del).toHaveBeenCalledTimes(6);
    });

    it("unregisters first, then purges", async () => {
      const order: string[] = [];
      const m = makeContainer({ regs: 1 });
      m.unregisters[0]!.mockImplementation(async () => {
        order.push("unregister");
        return true;
      });
      const c = makeCaches(["tayf-saved-v1"], {}, order);
      await registerServiceWorker(base(m.container, { kill: true, cachesLike: c.cachesLike }));
      expect(order).toEqual(["unregister", "delete:tayf-saved-v1"]);
    });

    it("still purges when there is no registration to unregister", async () => {
      const m = makeContainer({ regs: 0 });
      const c = makeCaches(NAMES);
      await expect(registerServiceWorker(base(m.container, { kill: true, cachesLike: c.cachesLike }))).resolves.toBe("killed");
      expect([...c.live]).toEqual(["other-lib"]);
    });

    it("one failing delete is reported as failed after trying every cache", async () => {
      const m = makeContainer();
      const c = makeCaches(NAMES, { failDelete: "tayf-pages-v1" });
      await expect(registerServiceWorker(base(m.container, { kill: true, cachesLike: c.cachesLike }))).resolves.toBe("failed");
      expect(c.del).toHaveBeenCalledTimes(6);
      expect(c.live.has("tayf-saved-v1")).toBe(false);
    });

    it("listing the caches failing is reported as failed, registrations are still unregistered", async () => {
      const m = makeContainer();
      const c = makeCaches(NAMES, { keysRejects: true });
      await expect(registerServiceWorker(base(m.container, { kill: true, cachesLike: c.cachesLike }))).resolves.toBe("failed");
      for (const u of m.unregisters) expect(u).toHaveBeenCalledTimes(1);
    });

    it("getRegistrations rejecting is reported as failed, the caches are still purged", async () => {
      const m = makeContainer();
      m.getRegistrations.mockRejectedValueOnce(new Error("boom"));
      const c = makeCaches(NAMES);
      await expect(registerServiceWorker(base(m.container, { kill: true, cachesLike: c.cachesLike }))).resolves.toBe("failed");
      expect([...c.live]).toEqual(["other-lib"]);
    });

    it("a missing CacheStorage is fine (killed, nothing to purge)", async () => {
      const m = makeContainer();
      await expect(registerServiceWorker(base(m.container, { kill: true, cachesLike: undefined }))).resolves.toBe("killed");
    });

    it("never touches the caches when the switch is off or outside production", async () => {
      const m = makeContainer();
      const c = makeCaches(NAMES);
      await registerServiceWorker(base(m.container, { cachesLike: c.cachesLike }));
      await registerServiceWorker(base(m.container, { kill: true, nodeEnv: "development", cachesLike: c.cachesLike }));
      await registerServiceWorker(base(undefined, { kill: true, cachesLike: c.cachesLike }));
      expect(c.keys).not.toHaveBeenCalled();
      expect(c.del).not.toHaveBeenCalled();
    });
  });

  it("a register rejection gives failed without throwing, logging or syncing", async () => {
    const m = makeContainer();
    m.register.mockRejectedValueOnce(new Error("SecurityError"));
    const readIds = vi.fn(() => [ID_A]);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {}),
    );
    try {
      await expect(registerServiceWorker(base(m.container, { readIds }))).resolves.toBe("failed");
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(readIds).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });

  it("a synchronous throw from register gives failed", async () => {
    const m = makeContainer();
    m.register.mockImplementationOnce(() => {
      throw new Error("sync boom");
    });
    await expect(registerServiceWorker(base(m.container))).resolves.toBe("failed");
  });

  it("readIds throwing gives failed", async () => {
    const m = makeContainer();
    const readIds = () => {
      throw new Error("storage");
    };
    await expect(registerServiceWorker(base(m.container, { readIds }))).resolves.toBe("failed");
  });

  it("postMessage throwing gives failed", async () => {
    const m = makeContainer();
    m.post.mockImplementationOnce(() => {
      throw new Error("clone");
    });
    await expect(registerServiceWorker(base(m.container))).resolves.toBe("failed");
  });

  it("a throwing container getter gives failed in production", async () => {
    const deps = {
      nodeEnv: "production",
      get container(): never {
        throw new DOMException("denied", "SecurityError");
      },
      kill: false,
      readIds: () => [ID_A],
    };
    await expect(registerServiceWorker(deps)).resolves.toBe("failed");
  });
});
