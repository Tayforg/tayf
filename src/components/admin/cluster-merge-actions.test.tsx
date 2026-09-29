import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";

// The repo has no jsdom/testing-library (see share-button.test.tsx), so click
// handlers cannot run through a DOM. Instead the hooks the component uses are
// replaced by a tiny slot-based store: the component function is called
// directly, its element tree is walked for the button by label, and onClick is
// invoked. Each setState re-renders by calling the function again.

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  dirty: false,
  pending: null as Promise<void> | null,
  refresh: vi.fn(),
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
        h.dirty = true;
      };
      return [h.slots[i], set];
    },
    useTransition: () => [
      false,
      (fn: () => unknown) => {
        h.pending = Promise.resolve(fn()).then(() => undefined);
      },
    ],
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: h.refresh }),
}));

import { ClusterMergeActions } from "./cluster-merge-actions";
import type { MergeClusterRef } from "@/lib/admin/merge-queue";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function ref(id: string, title: string): MergeClusterRef {
  return {
    id,
    title,
    articleCount: 3,
    firstPublished: null,
    biasDistribution: {} as MergeClusterRef["biasDistribution"],
    isBlindspot: false,
    headlines: [],
  };
}

const props = { a: ref(A, "Küme A"), b: ref(B, "Küme B"), defaultTargetId: B, origin: "thread" as const };

type El = { props?: { children?: ReactNode; onClick?: () => void; className?: string } } | string | null;

function render(p = props): El {
  h.cursor = 0;
  h.dirty = false;
  return (ClusterMergeActions as unknown as (p: typeof props) => El)(p);
}

function texts(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(texts).join("");
  const el = node as { props?: { children?: unknown } };
  return texts(el.props?.children);
}

function find(node: unknown, label: string): { props: { onClick?: () => void; className?: string } } | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = find(n, label);
      if (f) return f;
    }
    return null;
  }
  const el = node as { props?: { children?: unknown; onClick?: () => void } };
  if (typeof el.props?.onClick === "function" && texts(el.props.children).trim() === label) {
    return el as { props: { onClick?: () => void } };
  }
  return find(el.props?.children, label);
}

async function click(label: string): Promise<El> {
  const tree = render();
  const btn = find(tree, label);
  expect(btn, `button ${label}`).not.toBeNull();
  btn!.props.onClick!();
  if (h.pending) await h.pending;
  h.pending = null;
  return render();
}

const fetchMock = vi.fn();
const confirmMock = vi.fn();

beforeEach(() => {
  h.slots.length = 0;
  h.pending = null;
  h.refresh.mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  confirmMock.mockReset();
  confirmMock.mockReturnValue(true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { confirm: confirmMock });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastBody() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url, init, body: JSON.parse(init.body as string) };
}

describe("ClusterMergeActions", () => {
  it("shows Hedef and Taşınacak titles for the default direction", () => {
    const text = texts(render());
    expect(text).toContain("Hedef: Küme B");
    expect(text).toContain("Taşınacak: Küme A");
  });

  it("uses the h-9 sm:h-7 button classes", () => {
    const btn = find(render(), "Birleştir");
    expect(btn!.props.className).toContain("h-9 sm:h-7");
  });

  it("posts source = the non-default id and target = defaultTargetId", async () => {
    await click("Birleştir");
    const { url, init, body } = lastBody();
    expect(url).toBe("/api/admin/cluster-merge");
    expect(init.method).toBe("POST");
    expect(body).toEqual({ action: "merge", source: A, target: B, origin: "thread" });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("'Yönü değiştir' swaps source and target", async () => {
    const tree = await click("Yönü değiştir");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(texts(tree)).toContain("Hedef: Küme A");
    expect(texts(tree)).toContain("Taşınacak: Küme B");
    await click("Birleştir");
    expect(lastBody().body).toEqual({ action: "merge", source: B, target: A, origin: "thread" });
  });

  it("asks window.confirm first and does not post when cancelled", async () => {
    confirmMock.mockReturnValue(false);
    await click("Birleştir");
    expect(confirmMock).toHaveBeenCalledWith(
      "Bu iki küme birleştirilsin mi? Taşınan küme arşivlenir, bağlantısı hedefe yönlenir.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("shows the conflict line on 409", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, text: async () => "server detail" });
    const tree = await click("Birleştir");
    expect(texts(tree)).toContain("Kümelerden biri zaten birleştirilmiş veya arşivlenmiş; sayfayı yenileyin.");
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("shows the generic line on other errors and on network failure, never the server text", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "secret server detail" });
    let tree = await click("Birleştir");
    expect(texts(tree)).toContain("İşlem başarısız, tekrar deneyin.");
    expect(texts(tree)).not.toContain("secret server detail");

    fetchMock.mockRejectedValue(new Error("offline"));
    tree = await click("Birleştir");
    expect(texts(tree)).toContain("İşlem başarısız, tekrar deneyin.");
  });

  it("'Farklı hikaye' posts dismiss without confirming", async () => {
    await click("Farklı hikaye");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(lastBody().body).toEqual({ action: "dismiss", a: A, b: B, origin: "thread" });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
