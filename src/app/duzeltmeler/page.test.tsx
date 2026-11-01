import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// S-18 (/duzeltmeler). Mirrors src/app/kalite/page.test.tsx: mock the fetcher
// module directly (the Supabase round-trip is covered by
// src/lib/corrections/public-log.test.ts) and call the default export as a
// plain async function — no React renderer needed for an async Server
// Component.
//
// The privacy assertions here are the point: the page must never render the
// reader's message or e-mail, even though the shaped row type has no place
// to put them — the test walks the whole tree and looks for them anyway.
// ---------------------------------------------------------------------------

type MockSubject =
  | { kind: "cluster"; clusterId: string; title: string }
  | { kind: "source"; slug: string; name: string }
  | { kind: "cluster_gone" }
  | { kind: "general" };

const mockCorrections = vi.hoisted(() => ({
  value: null as
    | Array<{
        id: string;
        subject: MockSubject;
        createdAt: string;
        reviewedAt: string | null;
      }>
    | null,
}));

vi.mock("@/lib/corrections/public-log", () => ({
  getPublicCorrections: () => Promise.resolve(mockCorrections.value),
}));

import CorrectionsPage, { metadata } from "./page";

/** See src/app/kalite/page.test.tsx for the function-expansion rationale. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type === "function") {
      const rendered = (el.type as (props: Record<string, unknown>) => unknown)(
        el.props ?? {},
      );
      collectText(rendered, out);
      return out;
    }
    if (el.props?.children !== undefined) collectText(el.props.children as ReactNode, out);
  }
  return out;
}

/** Page text with runs of whitespace collapsed, as a reader sees it. */
function pageText(node: unknown): string {
  return collectText(node).join(" ").replace(/\s+/g, " ");
}

/** Every `href` prop in the tree (next/link's Link is an object-typed element, so walk its children too). */
function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    const href = el.props?.href;
    if (typeof href === "string") out.push(href);
    if (typeof el.type === "function") {
      collectHrefs(
        (el.type as (props: Record<string, unknown>) => unknown)(el.props ?? {}),
        out,
      );
      return out;
    }
    if (el.props?.children !== undefined) collectHrefs(el.props.children, out);
  }
  return out;
}

function correction(
  overrides: Partial<NonNullable<typeof mockCorrections.value>[number]> = {},
) {
  return {
    id: "c1",
    subject: {
      kind: "cluster",
      clusterId: "11111111-1111-1111-1111-111111111111",
      title: "Asgari ücret görüşmeleri başladı",
    } as MockSubject,
    createdAt: "2026-09-10T08:00:00.000Z",
    reviewedAt: "2026-09-12T09:30:00.000Z",
    ...overrides,
  };
}

function clusterSubject(clusterId: string, title: string): MockSubject {
  return { kind: "cluster", clusterId, title };
}

describe("metadata", () => {
  it('title is "Düzeltmeler" (root layout template appends "— Tayf")', () => {
    expect(metadata.title).toBe("Düzeltmeler");
  });

  it("has a Turkish description and a canonical", () => {
    expect(typeof metadata.description).toBe("string");
    expect((metadata.description as string).length).toBeGreaterThan(0);
    expect(metadata.alternates?.canonical).toBe("/duzeltmeler");
  });
});

describe("CorrectionsPage — unavailable state (fetcher returned null)", () => {
  it("says the log cannot be read, and invents no rows", async () => {
    mockCorrections.value = null;

    const tree = await CorrectionsPage();
    const text = pageText(tree);

    expect(text).toContain("Düzeltme kaydı şu anda okunamıyor.");
    expect(collectHrefs(tree).filter((h) => h.startsWith("/cluster/"))).toEqual([]);
  });
});

describe("CorrectionsPage — empty state ([])", () => {
  it("renders an honest empty state", async () => {
    mockCorrections.value = [];

    const tree = await CorrectionsPage();
    const text = pageText(tree);

    expect(text).toContain("Henüz yayımlanmış düzeltme yok");
    expect(collectHrefs(tree).filter((h) => h.startsWith("/cluster/"))).toEqual([]);
  });
});

describe("CorrectionsPage — rows present", () => {
  it("links each correction to its cluster and shows both dates", async () => {
    mockCorrections.value = [correction()];

    const tree = await CorrectionsPage();
    const text = pageText(tree);
    const hrefs = collectHrefs(tree);

    expect(text).toContain("Asgari ücret görüşmeleri başladı");
    expect(text).toContain("Düzeltme incelendi.");
    expect(text).toContain("Bildirildi: 10.09.2026");
    expect(text).toContain("İncelendi: 12.09.2026");
    expect(hrefs).toContain("/cluster/11111111-1111-1111-1111-111111111111");
  });

  it("renders one entry per correction", async () => {
    mockCorrections.value = [
      correction({ id: "c1", subject: clusterSubject("aaa", "Birinci küme") }),
      correction({ id: "c2", subject: clusterSubject("bbb", "İkinci küme") }),
    ];

    const tree = await CorrectionsPage();
    const text = pageText(tree);
    const clusterHrefs = collectHrefs(tree).filter((h) => h.startsWith("/cluster/"));

    expect(text).toContain("Birinci küme");
    expect(text).toContain("İkinci küme");
    expect(clusterHrefs).toEqual(["/cluster/aaa", "/cluster/bbb"]);
  });

  it('shows "İncelendi: —" when reviewedAt is null', async () => {
    mockCorrections.value = [correction({ reviewedAt: null })];

    const tree = await CorrectionsPage();
    const text = pageText(tree);

    expect(text).toContain("İncelendi: —");
  });

  it("names a source-label objection and links to the source page", async () => {
    mockCorrections.value = [
      correction({ subject: { kind: "source", slug: "sozcu", name: "Sözcü" } }),
    ];

    const tree = await CorrectionsPage();
    const text = pageText(tree);
    const hrefs = collectHrefs(tree);

    expect(text).toContain("Kaynak etiketi itirazı: Sözcü");
    expect(text).toContain("Düzeltme incelendi.");
    expect(text).toContain("Bildirildi: 10.09.2026");
    expect(hrefs).toContain("/source/sozcu");
    expect(hrefs.filter((h) => h.startsWith("/cluster/"))).toEqual([]);
    expect(text).not.toContain("Küme kaldırılmış");
  });

  it("labels a general correction without a link", async () => {
    mockCorrections.value = [correction({ subject: { kind: "general" } })];

    const tree = await CorrectionsPage();
    const text = pageText(tree);
    const hrefs = collectHrefs(tree);

    expect(text).toContain("Genel düzeltme bildirimi");
    expect(text).toContain("Bildirildi: 10.09.2026");
    expect(hrefs.filter((h) => h.startsWith("/cluster/"))).toEqual([]);
    expect(hrefs.filter((h) => h.startsWith("/source/"))).toEqual([]);
    expect(text).not.toContain("Küme kaldırılmış");
  });

  it("renders plain text, not a link, when the cluster was removed", async () => {
    mockCorrections.value = [correction({ subject: { kind: "cluster_gone" } })];

    const tree = await CorrectionsPage();
    const text = pageText(tree);
    const hrefs = collectHrefs(tree);

    expect(text).toContain("Küme kaldırılmış");
    expect(hrefs.filter((h) => h.startsWith("/cluster/"))).toEqual([]);
    expect(hrefs.filter((h) => h.startsWith("/source/"))).toEqual([]);
  });

  it('says "Küme kaldırılmış" only for cluster_gone, never for a cluster, source or general subject', async () => {
    mockCorrections.value = [
      correction({ id: "a", subject: clusterSubject("aaa", "Birinci küme") }),
      correction({ id: "b", subject: { kind: "source", slug: "t24", name: "T24" } }),
      correction({ id: "c", subject: { kind: "general" } }),
    ];

    const text = pageText(await CorrectionsPage());

    expect(text).not.toContain("Küme kaldırılmış");
    expect(text).toContain("Birinci küme");
    expect(text).toContain("Kaynak etiketi itirazı: T24");
    expect(text).toContain("Genel düzeltme bildirimi");
  });

  it("renders a mixed log in order, one entry per correction", async () => {
    mockCorrections.value = [
      correction({ id: "a", subject: { kind: "source", slug: "sozcu", name: "Sözcü" } }),
      correction({ id: "b", subject: clusterSubject("bbb", "İkinci küme") }),
      correction({ id: "c", subject: { kind: "cluster_gone" } }),
      correction({ id: "d", subject: { kind: "general" } }),
    ];

    const tree = await CorrectionsPage();
    const text = pageText(tree);
    const hrefs = collectHrefs(tree).filter(
      (h) => h.startsWith("/cluster/") || h.startsWith("/source/"),
    );

    expect(hrefs).toEqual(["/source/sozcu", "/cluster/bbb"]);
    expect(text.match(/Düzeltme incelendi\./g)).toHaveLength(4);
    expect(text.indexOf("Kaynak etiketi itirazı: Sözcü")).toBeLessThan(
      text.indexOf("İkinci küme"),
    );
    expect(text.indexOf("İkinci küme")).toBeLessThan(text.indexOf("Küme kaldırılmış"));
    expect(text.indexOf("Küme kaldırılmış")).toBeLessThan(
      text.indexOf("Genel düzeltme bildirimi"),
    );
  });

  it("never renders the reader's message, e-mail or submitted url, even if the row carries them", async () => {
    // Belt and braces: the fetcher does not select message/email and drops the
    // url after deriving the subject, so the shaped type has nowhere to put
    // them — this row smuggles all three in anyway to prove the page renders
    // only the fields it names.
    mockCorrections.value = [
      {
        ...correction(),
        message: "başlık yanlış, kaynak şu",
        email: "okur@example.com",
        url: "https://www.tayfhaber.com/cluster/smuggled-url?secret=1",
      } as unknown as NonNullable<typeof mockCorrections.value>[number],
    ];

    const tree = await CorrectionsPage();
    const text = pageText(tree);
    const hrefs = collectHrefs(tree);

    expect(text).not.toContain("okur@example.com");
    expect(text).not.toContain("başlık yanlış");
    expect(text).not.toMatch(/@/);
    expect(text).not.toContain("smuggled-url");
    expect(text).not.toContain("secret=1");
    expect(hrefs.join(" ")).not.toContain("smuggled-url");
    expect(hrefs.join(" ")).not.toContain("secret=1");
    expect(hrefs.some((h) => /^https?:\/\//.test(h))).toBe(false);
  });

  it("describes both the cluster and source forms in the subtitle", async () => {
    mockCorrections.value = [correction()];

    const text = pageText(await CorrectionsPage());

    expect(text).toContain(
      "Küme ve kaynak sayfalarındaki düzeltme formundan gelen bildirimler",
    );
    expect(text).not.toContain("Her küme sayfasındaki düzeltme formundan");
    expect(text).toContain("okurun yazdığı mesaj ve e-posta adresi hiçbir zaman yayımlanmaz");
  });

  it("states the ~12-month retention window the nightly purge enforces", async () => {
    mockCorrections.value = [correction()];

    const text = pageText(await CorrectionsPage());

    expect(text).toContain("Kayıt son 12 ayı kapsar");
  });

  it("links back to the methodology section in every state", async () => {
    for (const value of [null, [], [correction()]] as const) {
      mockCorrections.value = value as typeof mockCorrections.value;

      const hrefs = collectHrefs(await CorrectionsPage());

      expect(hrefs).toContain("/metodoloji#duzeltme");
    }
  });
});
