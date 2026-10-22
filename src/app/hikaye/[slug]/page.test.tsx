import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The page and generateMetadata read through the THROWING loader (a Supabase
// timeout must not look like a missing thread); the never-throw
// getPublishedThreadBySlug is no longer used here.
const loadPublishedThreadBySlug = vi.fn();
vi.mock("@/lib/story-threads/public-query", () => ({
  loadPublishedThreadBySlug: (...a: unknown[]) => loadPublishedThreadBySlug(...a),
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
  loadPublishedThreadBySlug.mockReset();
  notFound.mockClear();
});

describe("/hikaye/[slug]", () => {
  it("calls notFound for a missing thread", async () => {
    loadPublishedThreadBySlug.mockResolvedValue(null);
    await expect(StoryThreadPage({ params: Promise.resolve({ slug: "yok-boyle" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("renders the title, summary line, days and cluster links", async () => {
    loadPublishedThreadBySlug.mockResolvedValue(thread);
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
    loadPublishedThreadBySlug.mockResolvedValue(null);
    const m = await generateMetadata({ params: Promise.resolve({ slug: "x-y-z" }) });
    expect(m).toEqual({ title: "Sayfa bulunamadı", robots: { index: false, follow: true }, alternates: { canonical: null } });
  });

  it("metadata: found has canonical and description", async () => {
    loadPublishedThreadBySlug.mockResolvedValue(thread);
    const m = await generateMetadata({ params: Promise.resolve({ slug: thread.slug }) });
    expect(m.title).toBe("Sarpyener fon soruşturması");
    expect(m.alternates).toEqual({ canonical: "/hikaye/sarpyener-fon-a1b2c3" });
    expect(m.description).toBe("Sarpyener fon soruşturması: 3 haber kümesi, 2 gün. Gün gün kaynak dağılımı.");
  });
});

describe("/hikaye/[slug] — timeout is not a 404", () => {
  const TIMEOUT = new Error(
    "[story-threads] thread fetch error: AbortError: Supabase request exceeded 4000 ms",
  );

  it("lets a read failure propagate to the error boundary instead of calling notFound()", async () => {
    loadPublishedThreadBySlug.mockRejectedValue(TIMEOUT);

    await expect(
      StoryThreadPage({ params: Promise.resolve({ slug: thread.slug }) }),
    ).rejects.toThrow("AbortError");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("metadata: a read failure is a noindex, canonical-less 'unavailable' shell, not 'not found'", async () => {
    loadPublishedThreadBySlug.mockRejectedValue(TIMEOUT);

    const m = await generateMetadata({ params: Promise.resolve({ slug: thread.slug }) });

    expect(m).toEqual({
      title: "Hikaye şu anda yüklenemiyor",
      robots: { index: false, follow: true },
      alternates: { canonical: null },
    });
  });

  it("a genuinely missing thread (null) still 404s", async () => {
    loadPublishedThreadBySlug.mockResolvedValue(null);

    await expect(
      StoryThreadPage({ params: Promise.resolve({ slug: "yok-boyle" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});

