import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ saved: false }));

vi.mock("@/components/bookmark/use-bookmarks", () => ({
  useBookmarks: () => ({
    has: () => state.saved,
    toggle: vi.fn(),
  }),
}));
vi.mock("@/lib/track", () => ({ track: vi.fn() }));

import { BookmarkButton } from "./bookmark-button";
import {
  BOOKMARK_LABEL_TITLE_MAX,
  bookmarkChipSuffix,
  bookmarkStoryLabel,
  labelTitle,
  savedRemoveLabel,
} from "./bookmark-label";

const TITLE = "Asgari ücret açıklandı";

function render(props: { storyTitle?: string | null; variant?: "chip" | "overlay" }): string {
  return renderToStaticMarkup(<BookmarkButton clusterId="c1" {...props} />);
}

/** Visible-and-announced text of the markup: the text nodes between tags. */
function textOf(html: string): string {
  return (html.match(/>[^<]+</g) ?? []).map((run) => run.slice(1, -1)).join("");
}

beforeEach(() => {
  state.saved = false;
});

describe("BookmarkButton overlay accessible name", () => {
  it("names the control after the story and exposes the state through aria-pressed", () => {
    const html = render({ variant: "overlay", storyTitle: TITLE });
    expect(html).toContain('aria-label="«Asgari ücret açıklandı» hikâyesini kaydet"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('title="Hikâyeyi kaydet"');
  });

  it("keeps the same name when saved: only aria-pressed and the tooltip change", () => {
    state.saved = true;
    const html = render({ variant: "overlay", storyTitle: TITLE });
    expect(html).toContain('aria-label="«Asgari ücret açıklandı» hikâyesini kaydet"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('title="Kaydedilenlerden çıkar"');
  });

  it("gives two different stories two different names", () => {
    const a = render({ variant: "overlay", storyTitle: "Birinci hikâye" });
    const b = render({ variant: "overlay", storyTitle: "İkinci hikâye" });
    const nameOf = (html: string) => html.match(/aria-label="([^"]*)"/)?.[1];
    expect(nameOf(a)).toBeTruthy();
    expect(nameOf(b)).toBeTruthy();
    expect(nameOf(a)).not.toBe(nameOf(b));
  });

  it.each([undefined, null, "", "   \n\t "])("falls back to the generic name for a %j title", (title) => {
    const html = render({ variant: "overlay", storyTitle: title });
    expect(html).toContain('aria-label="Hikâyeyi kaydet"');
    expect(html).toContain('title="Hikâyeyi kaydet"');
  });

  it("falls back to the generic tooltip when saved and untitled", () => {
    state.saved = true;
    const html = render({ variant: "overlay" });
    expect(html).toContain('aria-label="Hikâyeyi kaydet"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('title="Kaydedilenlerden çıkar"');
  });

  it("escapes quotes in a title instead of breaking out of the attribute", () => {
    const html = render({ variant: "overlay", storyTitle: 'Bakan "tamam" dedi' });
    expect(html).toContain("aria-label=\"«Bakan &quot;tamam&quot; dedi» hikâyesini kaydet\"");
  });
});

describe("BookmarkButton chip accessible name (WCAG 2.5.3 label in name)", () => {
  it("has no aria-label: the name is the visible text plus an sr-only story suffix", () => {
    const html = render({ variant: "chip", storyTitle: TITLE });
    expect(html).not.toContain("aria-label");
    expect(html).toContain('<span class="sr-only">: «Asgari ücret açıklandı»</span>');
    const text = textOf(html);
    expect(text.startsWith("Kaydet")).toBe(true);
    expect(text).toBe("Kaydet: «Asgari ücret açıklandı»");
    expect(html).toContain('aria-pressed="false"');
  });

  it("starts with the visible word 'Kaydedildi' when saved (the old name 'Kaydedilenlerden çıkar' did not contain it)", () => {
    state.saved = true;
    const html = render({ variant: "chip", storyTitle: TITLE });
    expect(html).not.toContain("aria-label");
    const text = textOf(html);
    expect(text.startsWith("Kaydedildi")).toBe(true);
    expect(text).toBe("Kaydedildi: «Asgari ücret açıklandı»");
    expect(html).not.toContain("Kaydedilenlerden çıkar");
    expect(html).toContain('aria-pressed="true"');
  });

  it("is the bare visible word when there is no title (no suffix, no aria-label)", () => {
    expect(textOf(render({ variant: "chip" }))).toBe("Kaydet");
    expect(render({ variant: "chip" })).not.toContain("sr-only");
    expect(render({ variant: "chip" })).not.toContain("aria-label");
    state.saved = true;
    expect(textOf(render({ variant: "chip", storyTitle: null }))).toBe("Kaydedildi");
  });

  it("defaults to the chip variant", () => {
    const html = render({ storyTitle: TITLE });
    expect(textOf(html)).toBe("Kaydet: «Asgari ücret açıklandı»");
  });
});

describe("labelTitle", () => {
  it("returns null for nullish, empty and whitespace-only input", () => {
    expect(labelTitle(null)).toBeNull();
    expect(labelTitle(undefined)).toBeNull();
    expect(labelTitle("")).toBeNull();
    expect(labelTitle(" \n\t  ")).toBeNull();
  });

  it("returns null for a non-string that slipped through the types", () => {
    expect(labelTitle(42 as unknown as string)).toBeNull();
    expect(labelTitle({} as unknown as string)).toBeNull();
  });

  it("trims and collapses whitespace runs to one space", () => {
    expect(labelTitle("  Asgari \n\n ücret\t\taçıklandı  ")).toBe("Asgari ücret açıklandı");
  });

  it("leaves a title of exactly the maximum length untouched", () => {
    const t = "a".repeat(BOOKMARK_LABEL_TITLE_MAX);
    expect(labelTitle(t)).toBe(t);
  });

  it("cuts a 200-character title to at most 80 code points ending with an ellipsis", () => {
    const out = labelTitle("x".repeat(200))!;
    expect(Array.from(out).length).toBeLessThanOrEqual(BOOKMARK_LABEL_TITLE_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe("x".repeat(79) + "…");
  });

  it("drops the space before the ellipsis when the cut lands after a word", () => {
    const t = "a".repeat(78) + " " + "b".repeat(30);
    expect(labelTitle(t)).toBe("a".repeat(78) + "…");
  });

  it("never splits a surrogate pair at the cut", () => {
    const t = "a".repeat(78) + "😀" + "b".repeat(50);
    const out = labelTitle(t)!;
    expect(out).toBe("a".repeat(78) + "😀…");
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(Array.from(out).length).toBeLessThanOrEqual(BOOKMARK_LABEL_TITLE_MAX);
  });

  it("counts an all-emoji title by code points, not UTF-16 units", () => {
    const eighty = "😀".repeat(BOOKMARK_LABEL_TITLE_MAX);
    expect(labelTitle(eighty)).toBe(eighty);
    const out = labelTitle(eighty + "😀")!;
    expect(out).toBe("😀".repeat(79) + "…");
  });

  it("keeps « » and quotes inside a title verbatim", () => {
    expect(labelTitle('Bakan «"tamam"» dedi')).toBe('Bakan «"tamam"» dedi');
  });
});

describe("label builders", () => {
  it("bookmarkStoryLabel names the story, with the generic fallback", () => {
    expect(bookmarkStoryLabel(TITLE)).toBe("«Asgari ücret açıklandı» hikâyesini kaydet");
    expect(bookmarkStoryLabel(null)).toBe("Hikâyeyi kaydet");
    expect(bookmarkStoryLabel(undefined)).toBe("Hikâyeyi kaydet");
    expect(bookmarkStoryLabel("  ")).toBe("Hikâyeyi kaydet");
  });

  it("bookmarkChipSuffix is ': «title»' or null", () => {
    expect(bookmarkChipSuffix(TITLE)).toBe(": «Asgari ücret açıklandı»");
    expect(bookmarkChipSuffix(null)).toBeNull();
    expect(bookmarkChipSuffix("")).toBeNull();
  });

  it("savedRemoveLabel names the story, with the generic fallback", () => {
    expect(savedRemoveLabel(TITLE)).toBe("«Asgari ücret açıklandı» hikâyesini kaydedilenlerden çıkar");
    expect(savedRemoveLabel(null)).toBe("Kaydedilenlerden çıkar");
    expect(savedRemoveLabel(undefined)).toBe("Kaydedilenlerden çıkar");
  });

  it("applies the same truncation to every builder", () => {
    const long = "y".repeat(200);
    const cut = "y".repeat(79) + "…";
    expect(bookmarkStoryLabel(long)).toBe(`«${cut}» hikâyesini kaydet`);
    expect(bookmarkChipSuffix(long)).toBe(`: «${cut}»`);
    expect(savedRemoveLabel(long)).toBe(`«${cut}» hikâyesini kaydedilenlerden çıkar`);
  });
});

// h16-mobile-2: the overlay is a 36 px circle and the chip ~28 px tall. The
// overlay keeps its look (h-9 w-9) and grows an invisible 44 px hit area below
// sm through a ::before pseudo-element (34 px padding box + 2 * 4 inset + 2 * 1
// margin = 44); the chip gets a 44 px
// minimum height below sm. Every addition is a max-sm: token, so sm and up is
// unchanged.
describe("BookmarkButton mobile tap targets (h16-mobile-2)", () => {
  // renderToStaticMarkup HTML-escapes the quotes inside content-['']; decode
  // them so the tokens read like the source.
  const classTokens = (html: string) =>
    (/<button\b[^>]*\bclass="([^"]*)"/.exec(html)?.[1] ?? "")
      .replace(/&#x27;/g, "'")
      .split(/\s+/)
      .filter(Boolean);

  it("overlay keeps the 36 px circle and adds a 44 px ::before hit area below sm", () => {
    const tokens = classTokens(render({ variant: "overlay", storyTitle: TITLE }));
    for (const token of [
      "h-9",
      "w-9",
      "max-sm:before:absolute",
      "max-sm:before:-inset-1",
      "max-sm:before:content-['']",
    ]) {
      expect(tokens).toContain(token);
    }
    // An absolute ::before is sized from the button's PADDING box, which sits
    // inside the 1 px border: -inset-1 alone measured 42 px in Chrome at
    // 375 px. A -1 px margin on the pseudo-element grows it back to 44 px.
    expect(tokens).toContain("max-sm:before:-m-px");
    expect(tokens).not.toContain("h-11");
    expect(tokens).not.toContain("w-11");
  });

  it("overlay does not add relative: the caller's absolute stays the containing block", () => {
    const html = renderToStaticMarkup(
      <BookmarkButton clusterId="c1" variant="overlay" className="absolute right-2 top-2" />,
    );
    const tokens = classTokens(html);
    expect(tokens).toContain("absolute");
    expect(tokens).not.toContain("relative");
    expect(tokens).toContain("max-sm:before:-inset-1");
  });

  it("overlay hit area is identical in the saved state", () => {
    state.saved = true;
    const tokens = classTokens(render({ variant: "overlay" }));
    expect(tokens).toContain("max-sm:before:absolute");
    expect(tokens).toContain("max-sm:before:-inset-1");
    expect(tokens).toContain("text-brand");
  });

  it("chip gets max-sm:min-h-11 and keeps its pill look", () => {
    const tokens = classTokens(render({ variant: "chip", storyTitle: TITLE }));
    expect(tokens).toContain("max-sm:min-h-11");
    for (const token of ["rounded-full", "px-3", "py-1.5", "text-[11px]"]) {
      expect(tokens).toContain(token);
    }
  });

  it("chip adds no overlay-only pseudo-element tokens", () => {
    const tokens = classTokens(render({ variant: "chip" }));
    expect(tokens.some((t) => t.includes("before:"))).toBe(false);
  });
});
