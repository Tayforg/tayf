import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// h24-pages-3: page titles used to mix Title Case ("Kör Noktalar", "Tarafı
// Tahmin Et", "Kaynak Durumu", "Medya DNA Trendi") with the sentence case the
// rest of the site uses ("Sistem durumu", "Küme kalitesi", "Haftanın
// yelpazesi", "Zaman çizelgesi", the footer's "Kör noktalar"). The <title>, the
// og:title and the H1 are all fed from the two literals scanned here, so they
// have to agree and follow the convention.
//
// This reads each page as text and finds the literals with indexOf and a
// character scan (no regex over JSX): the string after `staticPageMetadata(` ->
// `title: "`, and every `title="` attribute inside a `<PageHero` tag.

const ROOT = join(__dirname, "..", "..");

/** Words that keep their capital after the first word: product name and acronyms. */
const ALLOWED = ["DNA", "API", "RSS", "Tayf"];

const PAGES: readonly { path: string; heroMin: number }[] = [
  { path: "src/app/blindspots/page.tsx", heroMin: 1 },
  { path: "src/app/oyun/page.tsx", heroMin: 1 },
  { path: "src/app/kaynaklar/durum/page.tsx", heroMin: 1 },
  { path: "src/app/trends/page.tsx", heroMin: 2 },
  { path: "src/app/durum/page.tsx", heroMin: 1 },
  { path: "src/app/hafta/page.tsx", heroMin: 1 },
  { path: "src/app/timeline/page.tsx", heroMin: 1 },
  { path: "src/app/sources/page.tsx", heroMin: 2 },
  { path: "src/app/konu/page.tsx", heroMin: 1 },
  { path: "src/app/gundem/page.tsx", heroMin: 1 },
  { path: "src/app/duzeltmeler/page.tsx", heroMin: 1 },
  // /ekonomi has no PageHero: its panels carry the visible headings.
  { path: "src/app/ekonomi/page.tsx", heroMin: 0 },
];

/** The four titles this guard was written for, as they must read on the page. */
const PINNED: readonly { path: string; title: string; heroCount: number }[] = [
  { path: "src/app/blindspots/page.tsx", title: "Kör noktalar", heroCount: 1 },
  { path: "src/app/oyun/page.tsx", title: "Tarafı tahmin et", heroCount: 1 },
  { path: "src/app/kaynaklar/durum/page.tsx", title: "Kaynak durumu", heroCount: 1 },
  { path: "src/app/trends/page.tsx", title: "Medya DNA trendi", heroCount: 2 },
];

function isSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

/** The text of the double-quoted literal whose opening quote is at `open`. */
function readQuoted(text: string, open: number): string | null {
  let value = "";
  for (let i = open + 1; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "\\") {
      value += text.charAt(i + 1);
      i += 1;
    } else if (ch === '"') {
      return value;
    } else if (ch === "\n") {
      return null;
    } else {
      value += ch;
    }
  }
  return null;
}

/**
 * Index of the `>` that closes the JSX tag opened at `start`: the first `>`
 * outside a double-quoted attribute value and outside `{...}`, so a subtitle
 * expression that holds JSX or a `>` does not end the tag early.
 */
function tagEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (depth === 0 && ch === '"') {
      inString = !inString;
    } else if (inString) {
      continue;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
    } else if (ch === ">" && depth === 0) {
      return i;
    }
  }
  return text.length;
}

/** Every literal `title: "..."` that follows a `staticPageMetadata(` call. */
function metadataTitles(text: string): string[] {
  const found = new Map<number, string>();
  const call = "staticPageMetadata(";
  const key = 'title: "';
  let from = 0;
  for (;;) {
    const at = text.indexOf(call, from);
    if (at === -1) break;
    from = at + call.length;
    const keyAt = text.indexOf(key, from);
    if (keyAt === -1) continue;
    const value = readQuoted(text, keyAt + key.length - 1);
    if (value !== null) found.set(keyAt, value);
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
}

/** Every `title="..."` attribute inside a `<PageHero ...>` tag. */
function heroTitles(text: string): string[] {
  const titles: string[] = [];
  const open = "<PageHero";
  const attr = 'title="';
  let from = 0;
  for (;;) {
    const at = text.indexOf(open, from);
    if (at === -1) break;
    const end = tagEnd(text, at + open.length);
    from = end;
    let scan = at + open.length;
    for (;;) {
      const attrAt = text.indexOf(attr, scan);
      if (attrAt === -1 || attrAt >= end) break;
      scan = attrAt + attr.length;
      // "subtitle=" ends in title=" too: only a whole attribute name counts.
      if (!isSpace(text[attrAt - 1])) continue;
      const value = readQuoted(text, attrAt + attr.length - 1);
      if (value !== null) titles.push(value);
    }
  }
  return titles;
}

/** Words after the first that are neither lower case (Turkish rules) nor allowed. */
function offendingWords(title: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const ch of title) {
    if (isSpace(ch)) {
      if (current !== "") words.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current !== "") words.push(current);
  return words
    .slice(1)
    .filter((word) => word !== word.toLocaleLowerCase("tr") && !ALLOWED.includes(word));
}

function readPage(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("page-title guard: the scanners", () => {
  it("reads the staticPageMetadata title literal", () => {
    const source = [
      "export const metadata = staticPageMetadata({",
      '  title: "Kör noktalar",',
      '  description: "x",',
      "});",
    ].join("\n");
    expect(metadataTitles(source)).toEqual(["Kör noktalar"]);
  });

  it("reads every PageHero title and ignores subtitle, kicker and other components", () => {
    const source = [
      "<PageHero",
      '  kicker="Son 24 saat"',
      '  title="Zaman çizelgesi"',
      '  subtitle="Bir sayfa başlığı değil"',
      "/>",
      '<Panel title="Haber Akışı" />',
      '<PageHero title="Medya DNA trendi" subtitle={<b>x &gt; y</b>} />',
    ].join("\n");
    expect(heroTitles(source)).toEqual(["Zaman çizelgesi", "Medya DNA trendi"]);
  });

  it("does not mistake subtitle= for title=", () => {
    expect(heroTitles('<PageHero subtitle="Çok Büyük Harf" />')).toEqual([]);
  });

  it("accepts sentence case and the allowed capitals", () => {
    expect(offendingWords("Kör noktalar")).toEqual([]);
    expect(offendingWords("Medya DNA trendi")).toEqual([]);
    expect(offendingWords("Haftanın yelpazesi")).toEqual([]);
    expect(offendingWords("Kaynaklar")).toEqual([]);
  });

  it("flags a Title Case word after the first (mutation check)", () => {
    expect(offendingWords("Kör Noktalar")).toEqual(["Noktalar"]);
    expect(offendingWords("Tarafı Tahmin Et")).toEqual(["Tahmin", "Et"]);
    // Turkish rules: "İ" lowercases to "i", so an initial-dotted word is still a capital.
    expect(offendingWords("Sistem İzleme")).toEqual(["İzleme"]);
  });

  it("a synthetic Title Case page fails the same check the real pages go through", () => {
    const source = 'export const metadata = staticPageMetadata({ title: "Kör Noktalar", path: "/x" });';
    const offending = metadataTitles(source).flatMap(offendingWords);
    expect(offending).not.toEqual([]);
  });
});

describe.each(PAGES.map((page) => [page.path, page] as const))("page titles: %s", (_path, page) => {
  const text = readPage(page.path);
  const metadata = metadataTitles(text);
  const hero = heroTitles(text);

  it("has exactly one staticPageMetadata title (the scan is not vacuous)", () => {
    expect(metadata).toHaveLength(1);
  });

  it("has its PageHero titles (the scan is not vacuous)", () => {
    expect(hero.length).toBeGreaterThanOrEqual(page.heroMin);
  });

  it("uses sentence case in the metadata title", () => {
    expect(metadata.flatMap(offendingWords)).toEqual([]);
  });

  it("uses sentence case in every PageHero title", () => {
    expect(hero.flatMap(offendingWords)).toEqual([]);
  });
});

describe("page titles: the four converted pages", () => {
  it.each(PINNED.map((pin) => [pin.path, pin] as const))(
    "%s: <title>, og:title and H1 all read the sentence-case title",
    (_path, pin) => {
      const text = readPage(pin.path);
      expect(metadataTitles(text)).toEqual([pin.title]);
      expect(heroTitles(text)).toEqual(Array(pin.heroCount).fill(pin.title));
    },
  );
});
