import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentProps } from "react";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { BiasCategory, Source } from "@/types";

import type { MediaDna } from "./media-dna";
import { toMediaDnaSources, type MediaDnaSource } from "./media-dna-sources";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(here, ...parts), "utf8");

const BIASES: BiasCategory[] = ["pro_government", "center", "opposition"];

function row(i: number): Source {
  return {
    id: `id-${i}`,
    name: `Kaynak ${i}`,
    slug: `kaynak-${i}`,
    url: `https://example.com/${i}`,
    rss_url: `https://example.com/${i}/rss`,
    bias: BIASES[i % BIASES.length]!,
    logo_url: i % 2 === 0 ? `https://example.com/${i}/logo.png` : null,
    active: i % 5 !== 0,
    kind: i % 7 === 0 ? "aggregator" : "outlet",
    trustee_since: null,
    trustee_note: null,
  };
}

describe("toMediaDnaSources", () => {
  const rows = Array.from({ length: 118 }, (_, i) => row(i));
  const out = toMediaDnaSources(rows);

  it("keeps only id, name, slug, bias and kind on every row", () => {
    for (const x of out) {
      expect(Object.keys(x).sort()).toEqual(["bias", "id", "kind", "name", "slug"]);
    }
  });

  it("keeps the order and count of 118 rows and copies the values verbatim", () => {
    expect(out).toHaveLength(118);
    out.forEach((x, i) => {
      const src = rows[i]!;
      expect(x).toEqual({
        id: src.id,
        name: src.name,
        slug: src.slug,
        bias: src.bias,
        kind: src.kind,
      });
    });
  });

  it("serialises without any trace of the dropped columns", () => {
    const json = JSON.stringify(out);
    expect(json).not.toContain("rss_url");
    expect(json).not.toContain("logo_url");
    expect(json).not.toContain('"url"');
    expect(json).not.toContain("active");
    expect(json).not.toContain("trustee");
    expect(json).not.toContain("example.com");
  });

  it("returns an empty array for an empty directory", () => {
    expect(toMediaDnaSources([])).toEqual([]);
  });

  it("returns fresh objects and does not mutate its input", () => {
    const input = [row(1)];
    const before = JSON.stringify(input);
    const result = toMediaDnaSources(input);
    expect(result[0]).not.toBe(input[0]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps an absent kind absent-valued (undefined means outlet downstream)", () => {
    const { kind: _kind, ...noKind } = row(2);
    const [x] = toMediaDnaSources([noKind as Source]);
    expect(x!.kind).toBeUndefined();
  });
});

describe("media-dna-sources.ts module", () => {
  const src = read("media-dna-sources.ts");

  it("is a plain server-safe module (no 'use client', so a server page gets the real function)", () => {
    expect(src).not.toMatch(/["']use client["']/);
  });

  it("copies keys explicitly instead of spreading the row", () => {
    expect(src).not.toMatch(/\.\.\.\s*s\b|\.\.\.\s*source\b|\.\.\.\s*row\b/);
  });
});

describe("MediaDna props", () => {
  it("takes the narrowed MediaDnaSource[] projection, not full Source rows", () => {
    expectTypeOf<ComponentProps<typeof MediaDna>["sources"]>().toEqualTypeOf<MediaDnaSource[]>();
    expectTypeOf<MediaDnaSource>().toEqualTypeOf<Pick<Source, "id" | "name" | "slug" | "bias" | "kind">>();
  });

  it("media-dna.tsx no longer imports the Source type", () => {
    const comp = read("media-dna.tsx");
    expect(comp).not.toMatch(/import\s+type\s*\{[^}]*\bSource\b[^}]*\}\s*from/);
    expect(comp).not.toMatch(/import\s*\{[^}]*\bSource\b[^}]*\}\s*from/);
    expect(comp).toMatch(/from\s*["']@\/components\/story\/media-dna-sources["']/);
  });
});

describe("cluster page wiring", () => {
  const page = readFileSync(join(here, "..", "..", "app", "cluster", "[id]", "page.tsx"), "utf8");

  it("projects the directory before it crosses into the client component", () => {
    expect(page).toContain("<MediaDna sources={toMediaDnaSources(allSources)}");
    expect(page).not.toContain("<MediaDna sources={allSources}");
  });

  it("imports toMediaDnaSources from the plain module, not from the 'use client' file", () => {
    expect(page).toMatch(
      /import\s*\{[^}]*\btoMediaDnaSources\b[^}]*\}\s*from\s*["']@\/components\/story\/media-dna-sources["']/,
    );
    expect(page).not.toMatch(
      /import\s*\{[^}]*\btoMediaDnaSources\b[^}]*\}\s*from\s*["']@\/components\/story\/media-dna["']/,
    );
  });
});
