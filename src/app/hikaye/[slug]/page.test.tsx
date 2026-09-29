import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const getPublishedThreadBySlug = vi.fn();
vi.mock("@/lib/story-threads/public-query", () => ({
  getPublishedThreadBySlug: (...a: unknown[]) => getPublishedThreadBySlug(...a),
}));
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));

import StoryThreadPage, { generateMetadata } from "./page";

const thread = {
  id: "t",
  slug: "sarpyener-fon-a1b2c3",
  title: "Sarpyener fon soruşturması",
  publishedAt: "2026-09-02T00:00:00Z",
  members: [
    { id: "c1", title_tr: "Bir küme", title_tr_neutral: null, first_published: "2026-09-01T10:00:00Z", article_count: 4, bias_distribution: { opposition: 2, center: 1 } },
    { id: "c2", title_tr: "İki küme", title_tr_neutral: null, first_published: "2026-09-03T10:00:00Z", article_count: 3, bias_distribution: {} },
    { id: "c3", title_tr: "Üç küme", title_tr_neutral: null, first_published: "2026-09-03T12:00:00Z", article_count: 5, bias_distribution: {} },
  ],
};

beforeEach(() => {
  getPublishedThreadBySlug.mockReset();
  notFound.mockClear();
});

describe("/hikaye/[slug]", () => {
  it("calls notFound for a missing thread", async () => {
    getPublishedThreadBySlug.mockResolvedValue(null);
    await expect(StoryThreadPage({ params: Promise.resolve({ slug: "yok-boyle" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("renders the title, summary line, days and cluster links", async () => {
    getPublishedThreadBySlug.mockResolvedValue(thread);
    const html = renderToStaticMarkup(await StoryThreadPage({ params: Promise.resolve({ slug: thread.slug }) }));
    expect(html).toContain("Gelişen hikaye");
    expect(html).toContain("<h1");
    expect(html).toContain("Sarpyener fon soruşturması");
    expect(html).toContain("3 haber kümesi");
    expect(html).toContain("2 gün");
    expect(html).toContain('href="/cluster/c1"');
    expect(html).toContain("4 haber");
    expect(html).toContain('href="/metodoloji"');
    expect(html).toContain("Bu gün için sınıflandırılmış kaynak yok.");
    expect(html).toContain("Çubuk, o günkü kümelerdeki kaynak sayılarının toplamıdır.");
    expect(html).not.toMatch(/kör nokta/i);
  });

  it("metadata: not found is noindex with no canonical", async () => {
    getPublishedThreadBySlug.mockResolvedValue(null);
    const m = await generateMetadata({ params: Promise.resolve({ slug: "x-y-z" }) });
    expect(m).toEqual({ title: "Sayfa bulunamadı", robots: { index: false, follow: true }, alternates: { canonical: null } });
  });

  it("metadata: found has canonical and description", async () => {
    getPublishedThreadBySlug.mockResolvedValue(thread);
    const m = await generateMetadata({ params: Promise.resolve({ slug: thread.slug }) });
    expect(m.title).toBe("Sarpyener fon soruşturması");
    expect(m.alternates).toEqual({ canonical: "/hikaye/sarpyener-fon-a1b2c3" });
    expect(m.description).toBe("Sarpyener fon soruşturması: 3 haber kümesi, 2 gün. Gün gün kaynak dağılımı.");
  });
});
