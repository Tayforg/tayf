import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// No jsdom/testing-library in this repo (see cluster-merge-actions.test.tsx),
// so AdminPanel's hooks are replaced by a slot store: useState keeps values in
// `slots`, useEffect only records its callback (run by hand), useCallback is
// the identity. The panel is read two ways: renderToStaticMarkup for what the
// operator sees, and a direct call of the component function to walk the
// element tree and invoke handlers (onRun / onToggle / onSave) the way a click
// would.

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        h.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(h.slots[i]) : v;
      };
      return [h.slots[i], set];
    },
    useEffect: (fn: () => void | (() => void)) => {
      h.effects.push(fn);
    },
    useCallback: (fn: unknown) => fn,
  };
});

// WorkerStats owns hooks of its own and would claim slots from this store; it
// is also exactly what the error block must NOT mount, so a marker stands in.
vi.mock("@/components/admin/worker-stats", () => ({
  WorkerStats: () => "WORKER-STATS-STUB",
}));

import { AdminPanel } from "./admin-panel";

const STATS = {
  articles: 1234,
  sources: 2,
  clusters: 40,
  missingImages: 5,
  sourcesList: [
    { id: "s1", name: "Örnek Haber", slug: "ornek-haber", url: "https://ornek.example", rss_url: "https://ornek.example/rss", bias: "center", active: true },
    { id: "s2", name: "Diğer Gazete", slug: "diger-gazete", url: "https://diger.example", rss_url: "https://diger.example/rss", bias: "left", active: false },
  ],
};

type Reply = { status: number; body?: unknown; nonJson?: boolean };

function reply(r: Reply): Response {
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => {
      if (r.nonJson) throw new SyntaxError("Unexpected token <");
      return r.body;
    },
  } as unknown as Response;
}

// GET /api/admin and POST /api/admin answer independently; tests change the
// two variables between steps.
let getReply: Reply | Error;
let postReply: Reply | Error;
const fetchMock = vi.fn();

function methodOf(init: unknown): string {
  return (init as { method?: string } | undefined)?.method ?? "GET";
}

function settle() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function markup(): string {
  h.cursor = 0;
  h.effects.length = 0;
  return renderToStaticMarkup(<AdminPanel />);
}

/** Render once so the mount effect registers, run it, wait, render again. */
async function mount(): Promise<string> {
  markup();
  expect(h.effects[0], "AdminPanel registers a mount effect").toBeDefined();
  h.effects[0]!();
  await settle();
  return markup();
}

type El = { props?: Record<string, unknown> } | string | null;

function tree(): El {
  h.cursor = 0;
  h.effects.length = 0;
  return (AdminPanel as unknown as () => El)();
}

function texts(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(texts).join("");
  return texts((node as { props?: { children?: unknown } }).props?.children);
}

function findByProp(node: unknown, prop: string): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findByProp(n, prop);
      if (f) return f;
    }
    return null;
  }
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props && prop in props) return props;
  return findByProp(props?.children, prop);
}

function findButton(node: unknown, label: string): (() => unknown) | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findButton(n, label);
      if (f) return f;
    }
    return null;
  }
  const props = (node as { props?: { onClick?: () => unknown; children?: unknown } }).props;
  if (typeof props?.onClick === "function" && texts(props.children).trim() === label) {
    return props.onClick;
  }
  return findButton(props?.children, label);
}

function prop<T>(name: string): T {
  const found = findByProp(tree(), name);
  expect(found, `element with prop ${name}`).not.toBeNull();
  return found![name] as T;
}

beforeEach(() => {
  h.slots.length = 0;
  h.effects.length = 0;
  getReply = { status: 200, body: STATS };
  postReply = { status: 200, body: { success: true, message: "ok" } };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: unknown) => {
    const r = methodOf(init) === "POST" ? postReply : getReply;
    if (r instanceof Error) throw r;
    return reply(r);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function postCalls() {
  return fetchMock.mock.calls.filter(([, init]) => methodOf(init) === "POST");
}
function getCalls() {
  return fetchMock.mock.calls.filter(([, init]) => methodOf(init) === "GET");
}

describe("AdminPanel initial load", () => {
  it("shows the skeleton until the first response", () => {
    const html = markup();
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Kaynaklar");
  });

  it("renders the panel with sources on a valid 200", async () => {
    const html = await mount();
    expect(html).toContain("Kaynaklar");
    expect(html).toContain("Örnek Haber");
    expect(html).toContain("Diğer Gazete");
    expect(html).toContain("WORKER-STATS-STUB");
    expect(html).not.toContain('role="alert"');
    expect(fetchMock).toHaveBeenCalledWith("/api/admin", { cache: "no-store" });
  });

  it("401 with a JSON body: no throw, session message, login link, no sources list", async () => {
    getReply = { status: 401, body: { error: "Unauthorized" } };
    let html = "";
    await expect((async () => (html = await mount()))()).resolves.toBeDefined();
    expect(html).toContain("Oturumunuzun süresi dolmuş. Devam etmek için yeniden giriş yapın.");
    expect(html).toContain('href="/admin/login"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Yenile");
    expect(html).not.toContain("Kaynaklar");
    expect(html).not.toContain("WORKER-STATS-STUB");
    expect(html).not.toContain("animate-pulse");
  });

  it("500 with a non-JSON body: HTTP line, no login link", async () => {
    getReply = { status: 500, nonJson: true };
    const html = await mount();
    expect(html).toContain("Veriler yüklenemedi (HTTP 500).");
    expect(html).not.toContain("/admin/login");
    expect(html).not.toContain("Kaynaklar");
    expect(html).not.toContain("WORKER-STATS-STUB");
  });

  it("network failure: connection message and the retry button", async () => {
    getReply = new TypeError("Failed to fetch");
    const html = await mount();
    expect(html).toContain("Sunucuya ulaşılamadı.");
    expect(html).toContain("Yenile");
    expect(html).not.toContain("Kaynaklar");
  });

  it("200 with the wrong shape is an error, not an empty panel of zeros", async () => {
    getReply = { status: 200, body: { articles: 1 } };
    const html = await mount();
    expect(html).toContain("Beklenmeyen yanıt alındı.");
    expect(html).not.toContain("Kaynaklar");
  });

  it("200 whose sourcesList is not an array is rejected by the shape check", async () => {
    getReply = { status: 200, body: { ...STATS, sourcesList: null } };
    const html = await mount();
    expect(html).toContain("Beklenmeyen yanıt alındı.");
  });

  it("the error block's Yenile button retries and recovers", async () => {
    getReply = { status: 500, nonJson: true };
    await mount();
    getReply = { status: 200, body: STATS };
    const retry = findButton(tree(), "Yenile");
    expect(retry, "Yenile button in the error block").not.toBeNull();
    await retry!();
    const html = markup();
    expect(html).toContain("Kaynaklar");
    expect(html).toContain("Örnek Haber");
    expect(html).not.toContain('role="alert"');
  });
});

describe("AdminPanel refresh after a successful load", () => {
  it("keeps the previous stats and shows the error above them when a refresh fails", async () => {
    await mount();
    getReply = { status: 503, nonJson: true };
    h.effects[0]!();
    await settle();
    const html = markup();
    expect(html).toContain("Veriler yüklenemedi (HTTP 503).");
    expect(html).toContain("Kaynaklar");
    expect(html).toContain("Örnek Haber");
    expect(html.indexOf("Veriler yüklenemedi")).toBeLessThan(html.indexOf("Kaynaklar"));
  });

  it("clears the error once a later refresh succeeds", async () => {
    await mount();
    getReply = { status: 503, nonJson: true };
    h.effects[0]!();
    await settle();
    getReply = { status: 200, body: STATS };
    h.effects[0]!();
    await settle();
    expect(markup()).not.toContain("yüklenemedi");
  });
});

describe("AdminPanel actions", () => {
  it("POST 500 with a non-JSON body shows an HTTP error banner, never success, and re-reads stats", async () => {
    await mount();
    postReply = { status: 500, nonJson: true };
    const onToggle = prop<(s: unknown) => void>("onToggle");
    const before = getCalls().length;
    onToggle(STATS.sourcesList[0]);
    await settle();
    const html = markup();
    expect(html).toContain("İşlem başarısız (HTTP 500).");
    expect(html).not.toContain("&quot;success&quot;");
    expect(postCalls()).toHaveLength(1);
    expect(getCalls().length).toBe(before + 1);
  });

  it("POST 400 with a JSON error shows the server's error text", async () => {
    await mount();
    postReply = { status: 400, body: { error: "Invalid slug" } };
    prop<(s: unknown) => void>("onToggle")(STATS.sourcesList[0]);
    await settle();
    const html = markup();
    expect(html).toContain("Invalid slug");
    expect(html).not.toContain("&quot;success&quot;");
  });

  it("POST 401 shows the error and the follow-up stats read surfaces the login link", async () => {
    await mount();
    postReply = { status: 401, body: { error: "Unauthorized" } };
    getReply = { status: 401, body: { error: "Unauthorized" } };
    prop<(s: unknown) => void>("onToggle")(STATS.sourcesList[0]);
    await settle();
    const html = markup();
    expect(html).toContain("Unauthorized");
    expect(html).toContain('href="/admin/login"');
    expect(html).toContain("Oturumunuzun süresi dolmuş");
  });

  it("a successful action shows the server message", async () => {
    await mount();
    postReply = { status: 200, body: { success: true, message: "ornek-haber is now disabled" } };
    prop<(s: unknown) => void>("onToggle")(STATS.sourcesList[0]);
    await settle();
    const html = markup();
    expect(html).toContain("ornek-haber is now disabled");
    // Anchors the `not.toContain("&quot;success&quot;")` checks above: the
    // banner really does print the success flag when there is one.
    expect(html).toContain("&quot;success&quot;: true");
    expect(html).not.toContain("İşlem başarısız");
  });

  it("a 200 action reply that is not JSON is reported, not swallowed", async () => {
    await mount();
    postReply = { status: 200, nonJson: true };
    prop<(s: unknown) => void>("onToggle")(STATS.sourcesList[0]);
    await settle();
    expect(markup()).toContain("Beklenmeyen yanıt alındı.");
  });

  it("a network failure during an action shows the error and clears the busy flag", async () => {
    await mount();
    postReply = new TypeError("Failed to fetch");
    prop<(s: unknown) => void>("onToggle")(STATS.sourcesList[0]);
    await settle();
    expect(markup()).toContain("Failed to fetch");
    expect(findByProp(tree(), "actionLoading")?.actionLoading).toBeNull();
  });
});

describe("AdminPanel source dialog save", () => {
  async function openEdit() {
    await mount();
    prop<(s: unknown) => void>("onEdit")(STATS.sourcesList[0]);
    expect(prop<boolean>("open")).toBe(true);
  }

  it("keeps the dialog open and shows the error when the save is rejected", async () => {
    await openEdit();
    postReply = { status: 400, body: { error: "Invalid url" } };
    await prop<() => Promise<void>>("onSave")();
    expect(prop<boolean>("open")).toBe(true);
    expect(markup()).toContain("Invalid url");
    expect(JSON.parse(postCalls()[0]![1].body as string).action).toBe("update_source");
  });

  it("keeps the dialog open on a 500 with a non-JSON body", async () => {
    await openEdit();
    postReply = { status: 500, nonJson: true };
    await prop<() => Promise<void>>("onSave")();
    expect(prop<boolean>("open")).toBe(true);
    expect(markup()).toContain("İşlem başarısız (HTTP 500).");
  });

  it("closes the dialog and re-reads stats on success", async () => {
    await openEdit();
    const before = getCalls().length;
    postReply = { status: 200, body: { success: true, message: "updated" } };
    await prop<() => Promise<void>>("onSave")();
    expect(prop<boolean>("open")).toBe(false);
    expect(getCalls().length).toBe(before + 1);
  });

  it("a 401 on save leaves the dialog open and surfaces the login link", async () => {
    await openEdit();
    postReply = { status: 401, body: { error: "Unauthorized" } };
    getReply = { status: 401, body: { error: "Unauthorized" } };
    await prop<() => Promise<void>>("onSave")();
    expect(prop<boolean>("open")).toBe(true);
    expect(markup()).toContain('href="/admin/login"');
  });
});
