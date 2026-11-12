import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { mergeBookmarkIds } from "@/components/bookmark/bookmark-ids";
import { SAVED_MAX_IDS } from "@/components/bookmark/saved-lookup";
import { MAX_FOLLOWS, mergeFollows, type Follow } from "@/lib/follows/follows";

import { expectLinear, rep } from "../../../tests/_helpers/linear-time";

import {
  buildTransferCode,
  exportSummaryText,
  IMPORT_KEPT_FOR_RETRY_TEXT,
  importErrorText,
  importSummaryText,
  parseTransferCode,
  TRANSFER_FORMAT,
  TRANSFER_INTRO_TEXT,
  TRANSFER_MAX_CHARS,
  TRANSFER_VERSION,
} from "./list-transfer";

// Pure tests: the code format, its strict parser, the two merges and the copy.
// No DOM and no storage; the stores and the panel are covered in
// list-transfer-panel.test.tsx.

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const A = uuid(0xa);
const B = uuid(0xb);
const C = uuid(0xc);

const NOW = "2026-11-12T10:00:00.000Z";
const OLD = "2026-10-01T00:00:00.000Z";

function stored(kind: Follow["kind"], value: string, stamp: string = OLD): Follow {
  return { kind, value, addedAt: stamp, seenAt: stamp, seenIds: null, seenFloor: null };
}

/** A well-formed code around the given parts, written the way buildTransferCode writes it. */
function codeOf(parts: { saved?: unknown; follows?: unknown } = {}): string {
  return JSON.stringify({
    format: "tayf-liste",
    v: 1,
    saved: parts.saved ?? [],
    follows: parts.follows ?? [],
  });
}

function reasonOf(raw: unknown): string {
  const r = parseTransferCode(raw);
  return r.ok ? "ok" : r.reason;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildTransferCode", () => {
  it("round trip: parseTransferCode(buildTransferCode(ids, follows).code) returns the same ids and follows", () => {
    // A keyword that is not a hub label: "asgari ücret" is one, and would come back as the hub follow.
    const follows = [
      { kind: "q" as const, value: "seçim anketleri 2028" },
      { kind: "gundem" as const, value: "deva" },
      { kind: "konu" as const, value: "ekonomi" },
    ];
    const built = buildTransferCode([A, B, C], follows);
    expect(built.saved).toBe(3);
    expect(built.follows).toBe(3);
    expect(built.savedTotal).toBe(3);
    const parsed = parseTransferCode(built.code);
    expect(parsed).toEqual({ ok: true, payload: { saved: [A, B, C], follows } });
  });

  it("writes the envelope {format:'tayf-liste', v:1, saved, follows} with keys in that order", () => {
    expect(TRANSFER_FORMAT).toBe("tayf-liste");
    expect(TRANSFER_VERSION).toBe(1);
    const built = buildTransferCode(
      [A],
      [
        { kind: "q", value: "asgari ücret" },
        { kind: "gundem", value: "deva" },
        { kind: "konu", value: "ekonomi" },
      ],
    );
    expect(built.code).toBe(
      `{"format":"tayf-liste","v":1,"saved":["${A}"],"follows":[{"kind":"q","value":"asgari ücret"},{"kind":"gundem","value":"deva"},{"kind":"konu","value":"ekonomi"}]}`,
    );
    expect(Object.keys(JSON.parse(built.code) as object)).toEqual(["format", "v", "saved", "follows"]);
    // One line: it is pasted into a chat box or a mail.
    expect(built.code.split("\n")).toHaveLength(1);
  });

  it("lower-cases ids and drops legacy non-uuid ids and duplicates", () => {
    const built = buildTransferCode([A.toUpperCase(), "legacy-id", A, 42, null, `${B}\n`, "", B], []);
    // The padded B is trimmed to B by normaliseBookmarkId, so it is the same id as the last entry.
    expect(JSON.parse(built.code)).toEqual({
      format: "tayf-liste",
      v: 1,
      saved: [A, B],
      follows: [],
    });
    expect(built.saved).toBe(2);
    expect(built.savedTotal).toBe(2);
  });

  it("keeps only the newest 1000 ids (the tail) and reports savedTotal", () => {
    const ids = Array.from({ length: SAVED_MAX_IDS + 5 }, (_, i) => uuid(i));
    const built = buildTransferCode(ids, []);
    expect(built.saved).toBe(SAVED_MAX_IDS);
    expect(built.savedTotal).toBe(SAVED_MAX_IDS + 5);
    const saved = (JSON.parse(built.code) as { saved: string[] }).saved;
    expect(saved).toHaveLength(SAVED_MAX_IDS);
    expect(saved[0]).toBe(uuid(5));
    expect(saved[SAVED_MAX_IDS - 1]).toBe(uuid(SAVED_MAX_IDS + 4));
  });

  it("keeps at most MAX_FOLLOWS follows (the first ones)", () => {
    const follows = Array.from({ length: MAX_FOLLOWS + 3 }, (_, i) => ({
      kind: "q" as const,
      value: `kelime ${i}`,
    }));
    const built = buildTransferCode([], follows);
    expect(built.follows).toBe(MAX_FOLLOWS);
    const out = (JSON.parse(built.code) as { follows: { value: string }[] }).follows;
    expect(out).toHaveLength(MAX_FOLLOWS);
    expect(out[0]?.value).toBe("kelime 0");
  });

  it("exports only kind and value of a follow", () => {
    const full: Follow = {
      kind: "q",
      value: "seçim",
      addedAt: OLD,
      seenAt: OLD,
      seenIds: [A],
      seenFloor: OLD,
    };
    const built = buildTransferCode([], [full]);
    expect((JSON.parse(built.code) as { follows: unknown[] }).follows).toEqual([{ kind: "q", value: "seçim" }]);
    for (const leaked of ["addedAt", "seenAt", "seenIds", "seenFloor"]) {
      expect(built.code.includes(leaked)).toBe(false);
    }
  });

  it("the largest legitimate code (1,000 ids, 20 keyword follows of 64 code points, 60 of them '\"') fits under TRANSFER_MAX_CHARS and parses ok", () => {
    expect(TRANSFER_MAX_CHARS).toBe(50_000);
    const ids = Array.from({ length: SAVED_MAX_IDS }, (_, i) => uuid(i));
    const follows = Array.from({ length: MAX_FOLLOWS }, (_, i) => ({
      kind: "q" as const,
      value: `${'"'.repeat(60)}${String(1000 + i)}`,
    }));
    expect([...(follows[0]?.value ?? "")]).toHaveLength(64);
    const built = buildTransferCode(ids, follows);
    expect(built.code.length).toBeLessThan(TRANSFER_MAX_CHARS);
    expect(built.code.length).toBeGreaterThan(40_000);
    const parsed = parseTransferCode(built.code);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.saved).toHaveLength(SAVED_MAX_IDS);
      expect(parsed.payload.follows).toHaveLength(MAX_FOLLOWS);
    }
  });
});

describe("parseTransferCode – malformed", () => {
  it("non-string input is invalid", () => {
    for (const raw of [undefined, null, 1, true, {}, [], codeOf]) {
      expect(reasonOf(raw)).toBe("invalid");
    }
  });

  it("empty or whitespace-only text is empty", () => {
    for (const raw of ["", "   ", "\n\t \r\n"]) {
      expect(reasonOf(raw)).toBe("empty");
    }
  });

  it("non-JSON and truncated codes are invalid", () => {
    const code = codeOf({ saved: [A, B] });
    for (const raw of ["hello", "{", "{}", code.slice(0, -5), code.slice(0, 20), `${code}}`]) {
      expect(reasonOf(raw)).toBe("invalid");
    }
  });

  it("JSON that is not an object ([], null, 1, \"x\") is invalid", () => {
    for (const raw of ["[]", "null", "1", '"x"', "true", `[${codeOf()}]`]) {
      expect(reasonOf(raw)).toBe("invalid");
    }
  });

  it("wrong format or version (v:2, v:'1') is invalid", () => {
    expect(reasonOf(JSON.stringify({ format: "tayf-liste", v: 2, saved: [], follows: [] }))).toBe("invalid");
    expect(reasonOf(JSON.stringify({ format: "tayf-liste", v: "1", saved: [], follows: [] }))).toBe("invalid");
    expect(reasonOf(JSON.stringify({ format: "tayf", v: 1, saved: [], follows: [] }))).toBe("invalid");
    expect(reasonOf(JSON.stringify({ format: "TAYF-LISTE", v: 1, saved: [], follows: [] }))).toBe("invalid");
    expect(reasonOf(JSON.stringify({ format: "tayf-liste", v: 1.0000001, saved: [], follows: [] }))).toBe("invalid");
  });

  it("a missing, extra or own __proto__ top-level key is invalid", () => {
    expect(reasonOf('{"format":"tayf-liste","v":1,"saved":[]}')).toBe("invalid");
    expect(reasonOf('{"format":"tayf-liste","v":1,"saved":[],"follows":[],"extra":1}')).toBe("invalid");
    expect(reasonOf('{"format":"tayf-liste","v":1,"saved":[],"follows":[],"__proto__":{}}')).toBe("invalid");
    // Four own keys, but "__proto__" stands where "follows" should be.
    expect(reasonOf('{"format":"tayf-liste","v":1,"saved":[],"__proto__":[]}')).toBe("invalid");
  });

  it("saved or follows that is not an array is invalid", () => {
    expect(reasonOf(JSON.stringify({ format: "tayf-liste", v: 1, saved: "x", follows: [] }))).toBe("invalid");
    expect(reasonOf(JSON.stringify({ format: "tayf-liste", v: 1, saved: [], follows: {} }))).toBe("invalid");
    expect(reasonOf(JSON.stringify({ format: "tayf-liste", v: 1, saved: null, follows: null }))).toBe("invalid");
  });

  it("one non-uuid saved entry (\"abc\", 42, uuid with a trailing newline) rejects the whole code", () => {
    expect(reasonOf(codeOf({ saved: [A, "abc"] }))).toBe("invalid");
    expect(reasonOf(codeOf({ saved: [A, 42] }))).toBe("invalid");
    expect(reasonOf(codeOf({ saved: [A, `${B}\n`] }))).toBe("invalid");
    expect(reasonOf(codeOf({ saved: [A, ` ${B}`] }))).toBe("invalid");
    expect(reasonOf(codeOf({ saved: [A, null] }))).toBe("invalid");
    expect(reasonOf(codeOf({ saved: [A, ""] }))).toBe("invalid");
  });

  it("a follow with an unknown kind, a non-string value, an extra key, a too-short keyword, a non-topic konu slug, gundem '__proto__', a control character or a 201-char value is invalid", () => {
    const bad: unknown[] = [
      { kind: "x", value: "seçim" },
      { kind: "q", value: 5 },
      { kind: "q", value: null },
      { kind: "q", value: "seçim", addedAt: OLD },
      { kind: "q" },
      { value: "seçim" },
      { kind: "q", value: "a" },
      { kind: "konu", value: "politika" },
      { kind: "gundem", value: "__proto__" },
      { kind: "gundem", value: "bilinmeyen-hub" },
      { kind: "q", value: "se\u0001çim" },
      { kind: "q", value: "x".repeat(201) },
      { kind: "q", value: "x".repeat(65) },
      "seçim",
      null,
      [],
      42,
    ];
    for (const f of bad) {
      expect(reasonOf(codeOf({ follows: [f] }))).toBe("invalid");
    }
    // One bad entry among good ones rejects everything.
    expect(reasonOf(codeOf({ follows: [{ kind: "q", value: "seçim" }, { kind: "x", value: "y" }] }))).toBe("invalid");
  });

  it("upper-case uuids are accepted and returned lower-case", () => {
    const parsed = parseTransferCode(codeOf({ saved: [A.toUpperCase(), B] }));
    expect(parsed).toEqual({ ok: true, payload: { saved: [A, B], follows: [] } });
  });

  it("repeated ids and same-identity follows ('Seçim' and 'secim') collapse, first wins", () => {
    const parsed = parseTransferCode(
      codeOf({
        saved: [A, B, A.toUpperCase(), B],
        follows: [
          { kind: "q", value: "Seçim" },
          { kind: "q", value: "secim" },
          { kind: "konu", value: "ekonomi" },
          { kind: "konu", value: "ekonomi" },
        ],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      payload: {
        saved: [A, B],
        follows: [
          { kind: "q", value: "Seçim" },
          { kind: "konu", value: "ekonomi" },
        ],
      },
    });
  });

  it("a keyword equal to a hub label ({q,'DEVA'}) becomes {gundem,'deva'}", () => {
    const parsed = parseTransferCode(codeOf({ follows: [{ kind: "q", value: "DEVA" }] }));
    expect(parsed).toEqual({ ok: true, payload: { saved: [], follows: [{ kind: "gundem", value: "deva" }] } });
  });

  it("a code with two empty lists is valid and empty", () => {
    expect(parseTransferCode(codeOf())).toEqual({ ok: true, payload: { saved: [], follows: [] } });
    // Surrounding whitespace is allowed (a paste often carries a newline).
    expect(parseTransferCode(`\n  ${codeOf()}  \n`)).toEqual({ ok: true, payload: { saved: [], follows: [] } });
  });

  it("deeply nested JSON ('['.repeat(20000)) is invalid, not a crash", () => {
    expect(reasonOf("[".repeat(20_000))).toBe("invalid");
    expect(reasonOf(`${"[".repeat(20_000)}${"]".repeat(20_000)}`)).toBe("invalid");
    expect(reasonOf(`{"format":"tayf-liste","v":1,"saved":${"[".repeat(15_000)}${"]".repeat(15_000)},"follows":[]}`)).toBe(
      "invalid",
    );
  });
});

describe("parseTransferCode – oversized", () => {
  it("text longer than TRANSFER_MAX_CHARS is too-large and JSON.parse is never called (vi.spyOn)", () => {
    const parse = vi.spyOn(JSON, "parse");
    const big = `${codeOf()}${" ".repeat(TRANSFER_MAX_CHARS)}`;
    expect(big.length).toBeGreaterThan(TRANSFER_MAX_CHARS);
    expect(parseTransferCode(big)).toEqual({ ok: false, reason: "too-large" });
    // The size check is on the raw text, before trimming: blanks alone are too large, not empty.
    expect(parseTransferCode(" ".repeat(TRANSFER_MAX_CHARS + 1))).toEqual({ ok: false, reason: "too-large" });
    expect(parseTransferCode("x".repeat(TRANSFER_MAX_CHARS + 1))).toEqual({ ok: false, reason: "too-large" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("a valid code padded with spaces to exactly TRANSFER_MAX_CHARS is accepted", () => {
    const code = codeOf({ saved: [A] });
    const padded = code + " ".repeat(TRANSFER_MAX_CHARS - code.length);
    expect(padded.length).toBe(TRANSFER_MAX_CHARS);
    expect(parseTransferCode(padded)).toEqual({ ok: true, payload: { saved: [A], follows: [] } });
    expect(reasonOf(`${padded} `)).toBe("too-large");
  });

  it("1001 saved ids is too-large", () => {
    const ids = Array.from({ length: SAVED_MAX_IDS + 1 }, (_, i) => uuid(i));
    const code = codeOf({ saved: ids });
    expect(code.length).toBeLessThanOrEqual(TRANSFER_MAX_CHARS);
    expect(parseTransferCode(code)).toEqual({ ok: false, reason: "too-large" });
    // Exactly the cap is fine.
    expect(parseTransferCode(codeOf({ saved: ids.slice(1) })).ok).toBe(true);
  });

  it("21 follows is too-large", () => {
    const follows = Array.from({ length: MAX_FOLLOWS + 1 }, (_, i) => ({ kind: "q", value: `kelime ${i}` }));
    expect(parseTransferCode(codeOf({ follows }))).toEqual({ ok: false, reason: "too-large" });
    expect(parseTransferCode(codeOf({ follows: follows.slice(1) })).ok).toBe(true);
  });
});

describe("parseTransferCode – invisible characters at the edges", () => {
  // A code travels through a messenger, a mail client or a notes app, which add a
  // no-break space, a byte-order mark, a zero-width space, U+2028 or U+3000 at an
  // end. Every character below is written as an escape: a literal one is invisible
  // and an editor or a formatter may drop it.
  const code = codeOf({ saved: [A] });
  const bare = { ok: true, payload: { saved: [A], follows: [] } };

  const span = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0x2060];
  // What is cut at an edge: what String.prototype.trim strips, then the zero-width
  // format characters it leaves. Written out here, independent of the module.
  const STRIPPED: number[] = [
    ...span(0x09, 0x0d),
    0x20,
    0xa0,
    0x1680,
    ...span(0x2000, 0x200a),
    0x200b,
    0x200c,
    0x200d,
    0x2028,
    0x2029,
    0x202f,
    0x205f,
    0x2060,
    0x3000,
    0xfeff,
  ];

  it.each([
    ["a trailing NBSP", "", "\u00a0"],
    ["a leading NBSP", "\u00a0", ""],
    ["a leading BOM", "\ufeff", ""],
    ["a trailing zero-width space", "", "\u200b"],
    ["a trailing U+2028", "", "\u2028"],
    ["a trailing U+3000", "", "\u3000"],
    ["zero-width, no-break and BOM characters at both ends, mixed", "\u200b\u00a0", "\u00a0\ufeff\u200b"],
    ["a CRLF pair", "", "\r\n"],
    ["a zero-width joiner and a word joiner between blanks", "\u200d \u2060", "\u2060 \u200d"],
  ])("%s around a valid code parses ok with the same payload as the bare code", (_label, before, after) => {
    expect(parseTransferCode(`${before}${code}${after}`)).toEqual(bare);
  });

  it("the cleaned edges reach JSON.parse: it is called with the bare code, never with the wrapped text", () => {
    const parse = vi.spyOn(JSON, "parse");
    expect(parseTransferCode(`\u200b\u00a0${code}\u00a0\ufeff`)).toEqual(bare);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(code);
  });

  it("text that is only blanks and zero-width characters is empty, and JSON.parse is not called", () => {
    const parse = vi.spyOn(JSON, "parse");
    expect(reasonOf("\u200b\u00a0\ufeff")).toBe("empty");
    expect(reasonOf("\u2028\u2029\u3000\u2060\u200c")).toBe("empty");
    expect(reasonOf(" \u200b\n\u00a0\t\ufeff ")).toBe("empty");
    expect(parse).not.toHaveBeenCalled();
  });

  it("characters INSIDE the code are not touched: a no-break space or a zero-width space between tokens stays invalid", () => {
    expect(reasonOf(`{"format":"tayf-liste",\u00a0"v":1,"saved":[],"follows":[]}`)).toBe("invalid");
    expect(reasonOf(`{"format":"tayf-liste","v":1,\u200b"saved":[],"follows":[]}`)).toBe("invalid");
    expect(reasonOf(`{"format":"tayf-liste","v":1,"saved":[],"follows":[]\ufeff}`)).toBe("invalid");
    // The inside of an entry stays strict too: an id with an NBSP or a ZWSP is no uuid.
    expect(reasonOf(codeOf({ saved: [`${A}\u00a0`] }))).toBe("invalid");
    expect(reasonOf(codeOf({ saved: [`\u200b${A}`] }))).toBe("invalid");
    expect(reasonOf(codeOf({ saved: [A, ` ${B}`] }))).toBe("invalid");
  });

  it("a real character next to the code still makes it invalid, wrapped or not", () => {
    expect(reasonOf(`${code}x`)).toBe("invalid");
    expect(reasonOf(`x${code}`)).toBe("invalid");
    expect(reasonOf(`\u00a0${code}x\u00a0`)).toBe("invalid");
    expect(reasonOf(`\u200b${code}\u200b}`)).toBe("invalid");
    expect(reasonOf(`${code}${code}`)).toBe("invalid");
    // U+0085 and U+180E are not stripped by trim, so they are not stripped here.
    expect(reasonOf(`${code}\u0085`)).toBe("invalid");
    expect(reasonOf(`\u180e${code}`)).toBe("invalid");
    expect(reasonOf("\u0085")).toBe("invalid");
  });

  it("the size check is on the RAW text: a 50,001-character input whose edges are no-break spaces is still too-large", () => {
    const parse = vi.spyOn(JSON, "parse");
    const pad = "\u00a0".repeat(TRANSFER_MAX_CHARS + 1 - code.length);
    const raw = `${pad}${code}`;
    expect(raw.length).toBe(TRANSFER_MAX_CHARS + 1);
    expect(parseTransferCode(raw)).toEqual({ ok: false, reason: "too-large" });
    expect(parseTransferCode(`${code}${pad}`)).toEqual({ ok: false, reason: "too-large" });
    expect(parseTransferCode("\u00a0".repeat(TRANSFER_MAX_CHARS + 1))).toEqual({ ok: false, reason: "too-large" });
    expect(parseTransferCode("\u200b".repeat(TRANSFER_MAX_CHARS + 1))).toEqual({ ok: false, reason: "too-large" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("a code padded with no-break spaces to exactly TRANSFER_MAX_CHARS is accepted", () => {
    const raw = `\u00a0${code}${"\u200b".repeat(TRANSFER_MAX_CHARS - code.length - 1)}`;
    expect(raw.length).toBe(TRANSFER_MAX_CHARS);
    expect(parseTransferCode(raw)).toEqual(bare);
  });

  it("the stripped set is what String.prototype.trim strips plus U+200B, U+200C, U+200D and U+2060", () => {
    const byEngine: number[] = [];
    for (let u = 0; u <= 0xffff; u++) {
      if (String.fromCharCode(u).trim() === "") byEngine.push(u);
    }
    expect(byEngine).toEqual(STRIPPED.filter((u) => !ZERO_WIDTH.includes(u)));
    expect(STRIPPED).toEqual([...STRIPPED].sort((a, b) => a - b));
  });

  it("sweep of every UTF-16 code unit: exactly the stripped ones are cut at an edge, every other one keeps the code invalid", () => {
    const stripped = new Set(STRIPPED);
    const wrong: string[] = [];
    for (let u = 0; u <= 0xffff; u++) {
      const ch = String.fromCharCode(u);
      const want = stripped.has(u);
      const front = reasonOf(`${ch}${code}`);
      const back = reasonOf(`${code}${ch}`);
      const alone = reasonOf(ch);
      if (front !== (want ? "ok" : "invalid") || back !== (want ? "ok" : "invalid") || alone !== (want ? "empty" : "invalid")) {
        wrong.push(`U+${u.toString(16).padStart(4, "0")}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("cuts a long run at an edge in linear time, wherever the run sits (no regex backtracking)", () => {
    // Under TRANSFER_MAX_CHARS, so the walk runs. The run is a mix of no-break, zero-width,
    // U+2028 and BOM characters. The worst shapes for a "^\s+|\s+$" regex are a long run
    // that does NOT end the text (a trailing "x"), and one that starts after a real character.
    const unit = "\u00a0\u200b\u2028\ufeff \u3000";
    const run = (input: string) => parseTransferCode(input);
    const options = { n: 48_000, ceilingMs: 2_000 };
    expectLinear(rep(unit, "", code), run, options);
    expectLinear(rep(unit, code, ""), run, options);
    expectLinear(rep(unit, "", "x"), run, options);
    expectLinear(rep(unit, "x", "x"), run, options);
    expectLinear(rep(unit, "x", ""), run, options);
    expect(run(rep(unit, "", code)(48_000))).toEqual(bare);
    expect(reasonOf(rep(unit, "x", "x")(48_000))).toBe("invalid");
  });

  it("keeps the comment above true: neither transfer test file holds a literal invisible character", () => {
    // no-break space, mongolian vowel separator, zero-width space/non-joiner/joiner, U+2028, U+2029,
    // word joiner, ideographic space and the byte-order mark. The class itself is written as escapes.
    const invisible = /[\u00a0\u180e\u200b-\u200d\u2028\u2029\u2060\u3000\ufeff]/u;
    for (const file of ["list-transfer.test.ts", "list-transfer-panel.test.tsx"]) {
      const source = readFileSync(resolve(process.cwd(), "src/components/transfer", file), "utf8");
      const hit = invisible.exec(source);
      const line = hit === null ? 0 : source.slice(0, hit.index).split("\n").length;
      expect({ file, line }).toEqual({ file, line: 0 });
    }
  });
});

describe("mergeBookmarkIds", () => {
  it("appends new ids after the stored ones and never removes one", () => {
    const merge = mergeBookmarkIds([A, B], [C], SAVED_MAX_IDS);
    expect(merge).toEqual({ next: [A, B, C], added: 1, existing: 0, skipped: 0 });
  });

  it("ids already stored count as existing", () => {
    const merge = mergeBookmarkIds([A, B], [B.toUpperCase(), C, A], SAVED_MAX_IDS);
    expect(merge).toEqual({ next: [A, B, C], added: 1, existing: 2, skipped: 0 });
  });

  it("at 998 stored and 5 new, adds only the newest 2 and skips 3", () => {
    const current = Array.from({ length: 998 }, (_, i) => uuid(i));
    const incoming = Array.from({ length: 5 }, (_, i) => uuid(2000 + i));
    const merge = mergeBookmarkIds(current, incoming, SAVED_MAX_IDS);
    expect(merge.added).toBe(2);
    expect(merge.skipped).toBe(3);
    expect(merge.existing).toBe(0);
    expect(merge.next).toHaveLength(1000);
    expect(merge.next.slice(0, 998)).toEqual(current);
    expect(merge.next.slice(998)).toEqual([uuid(2003), uuid(2004)]);
  });

  it("at or over max (1000, or 1005 legacy) adds nothing and never truncates", () => {
    const full = Array.from({ length: 1000 }, (_, i) => uuid(i));
    const fresh = [uuid(5000), uuid(5001)];
    const atMax = mergeBookmarkIds(full, fresh, SAVED_MAX_IDS);
    expect(atMax).toEqual({ next: full, added: 0, existing: 0, skipped: 2 });

    const legacy = Array.from({ length: 1005 }, (_, i) => uuid(i));
    const over = mergeBookmarkIds(legacy, fresh, SAVED_MAX_IDS);
    expect(over.next).toEqual(legacy);
    expect(over.next).toHaveLength(1005);
    expect(over.added).toBe(0);
    expect(over.skipped).toBe(2);

    // max 0 is the slice(-0) trap: it must add nothing, not everything.
    expect(mergeBookmarkIds([], [A, B], 0)).toEqual({ next: [], added: 0, existing: 0, skipped: 2 });
  });

  it("duplicates in incoming are added once; inputs are not mutated", () => {
    const current = Object.freeze([A]);
    const incoming = Object.freeze([B, B.toUpperCase(), C, B]);
    const merge = mergeBookmarkIds(current, incoming, SAVED_MAX_IDS);
    expect(merge).toEqual({ next: [A, B, C], added: 2, existing: 0, skipped: 0 });
    expect(current).toEqual([A]);
    expect(incoming).toEqual([B, B.toUpperCase(), C, B]);
    expect(merge.next).not.toBe(current);
  });

  it("keeps the current list as it is, order and legacy ids included", () => {
    const current = ["legacy-id", C, A];
    const merge = mergeBookmarkIds(current, [B], SAVED_MAX_IDS);
    expect(merge.next).toEqual(["legacy-id", C, A, B]);
  });

  it("drops entries that are not ids from incoming without counting them", () => {
    const merge = mergeBookmarkIds([A], [B, "", "   ", 7 as unknown as string], SAVED_MAX_IDS);
    expect(merge).toEqual({ next: [A, B], added: 1, existing: 0, skipped: 0 });
  });
});

describe("mergeFollows", () => {
  it("new follows get addedAt = seenAt = nowIso and seenIds null", () => {
    const merge = mergeFollows(
      [],
      [
        { kind: "q", value: "Seçim" },
        { kind: "konu", value: "ekonomi" },
      ],
      NOW,
    );
    expect(merge.added).toBe(2);
    expect(merge.existing).toBe(0);
    expect(merge.skipped).toBe(0);
    expect(merge.invalid).toBe(0);
    expect(merge.list).toEqual([
      { kind: "q", value: "Seçim", addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null },
      { kind: "konu", value: "ekonomi", addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null },
    ]);
  });

  it("a same-identity follow ('SEÇİM' vs stored 'seçim') counts as existing and keeps its stamps", () => {
    const list = [stored("q", "seçim")];
    const merge = mergeFollows(list, [{ kind: "q", value: "SEÇİM" }], NOW);
    expect(merge.existing).toBe(1);
    expect(merge.added).toBe(0);
    expect(merge.list).toBe(list);
    expect(merge.list[0]?.addedAt).toBe(OLD);
    expect(merge.list[0]?.seenAt).toBe(OLD);
  });

  it("stops at MAX_FOLLOWS and counts the rest as skipped", () => {
    const list = Array.from({ length: MAX_FOLLOWS - 2 }, (_, i) => stored("q", `kelime ${i}`));
    const incoming = Array.from({ length: 5 }, (_, i) => ({ kind: "q" as const, value: `yeni ${i}` }));
    const merge = mergeFollows(list, incoming, NOW);
    expect(merge.added).toBe(2);
    expect(merge.skipped).toBe(3);
    expect(merge.list).toHaveLength(MAX_FOLLOWS);
    expect(merge.list.slice(0, MAX_FOLLOWS - 2)).toEqual(list);
    expect(merge.list.slice(MAX_FOLLOWS - 2).map((f) => f.value)).toEqual(["yeni 0", "yeni 1"]);
  });

  it("an existing follow in a full list counts as existing, not skipped", () => {
    const list = Array.from({ length: MAX_FOLLOWS }, (_, i) => stored("q", `kelime ${i}`));
    const merge = mergeFollows(list, [{ kind: "q", value: "kelime 3" }], NOW);
    expect(merge.existing).toBe(1);
    expect(merge.skipped).toBe(0);
    expect(merge.added).toBe(0);
    expect(merge.list).toBe(list);
  });

  it("an invalid entry counts as invalid and is never stored", () => {
    const list = [stored("konu", "spor")];
    const merge = mergeFollows(
      list,
      [
        { kind: "q", value: "a" },
        { kind: "konu", value: "politika" },
      ],
      NOW,
    );
    expect(merge.invalid).toBe(2);
    expect(merge.added).toBe(0);
    expect(merge.list).toBe(list);
  });

  it("returns the same list reference when nothing is added", () => {
    const list = [stored("q", "seçim")];
    expect(mergeFollows(list, [], NOW).list).toBe(list);
    expect(mergeFollows(list, [{ kind: "q", value: "seçim" }], NOW).list).toBe(list);
    const empty: Follow[] = [];
    expect(mergeFollows(empty, [], NOW).list).toBe(empty);
  });

  it("counts a duplicate inside the incoming list as existing", () => {
    const merge = mergeFollows(
      [],
      [
        { kind: "q", value: "Seçim" },
        { kind: "q", value: "secim" },
      ],
      NOW,
    );
    expect(merge.added).toBe(1);
    expect(merge.existing).toBe(1);
    expect(merge.list).toHaveLength(1);
  });

  it("does not mutate the list it is given", () => {
    const list = Object.freeze([stored("q", "seçim")]);
    const merge = mergeFollows(list, [{ kind: "konu", value: "spor" }], NOW);
    expect(list).toHaveLength(1);
    expect(merge.list).toHaveLength(2);
  });
});

describe("copy", () => {
  it("TRANSFER_INTRO_TEXT is exactly the transfer instruction, with no sentence about where the lists are kept", () => {
    expect(TRANSFER_INTRO_TEXT).toBe(
      "Kaydedilenleri ve takip listenizi başka bir tarayıcıya ya da cihaza taşımak için burada bir kod oluşturun, sonra kodu orada aynı bölüme yapıştırın.",
    );
    expect(TRANSFER_INTRO_TEXT.includes("saklanır")).toBe(false);
  });

  it("exportSummaryText copied / not copied / truncated ('en yeni 1.000 kayıtlı hikâye (toplam 1.234), 3 takip')", () => {
    const built = { saved: 2, follows: 3, savedTotal: 2 };
    expect(exportSummaryText(built, true)).toBe("Kod kopyalandı: 2 kayıtlı hikâye, 3 takip.");
    expect(exportSummaryText(built, false)).toBe(
      "Kod oluşturuldu: 2 kayıtlı hikâye, 3 takip. Otomatik kopyalanamadı — kutudaki metni seçip kopyalayın.",
    );
    const truncated = { saved: 1000, follows: 3, savedTotal: 1234 };
    expect(exportSummaryText(truncated, true)).toBe(
      "Kod kopyalandı: en yeni 1.000 kayıtlı hikâye (toplam 1.234), 3 takip.",
    );
    expect(exportSummaryText(truncated, false)).toBe(
      "Kod oluşturuldu: en yeni 1.000 kayıtlı hikâye (toplam 1.234), 3 takip. Otomatik kopyalanamadı — kutudaki metni seçip kopyalayın.",
    );
  });

  it("importErrorText returns the three exact strings", () => {
    expect(importErrorText("empty")).toBe("Önce bir aktarma kodu yapıştırın.");
    expect(importErrorText("too-large")).toBe("Kod çok uzun: en fazla 1.000 kayıtlı hikâye ve 20 takip aktarılabilir.");
    expect(importErrorText("invalid")).toBe("Kod okunamadı. Kodu eksiksiz kopyaladığınızdan emin olun.");
  });

  it("IMPORT_KEPT_FOR_RETRY_TEXT is exactly the retry sentence, and importSummaryText alone does not append it", () => {
    expect(IMPORT_KEPT_FOR_RETRY_TEXT).toBe("Kod alanda duruyor: yer açtıktan sonra yeniden İçe aktar'a basın.");
    const zero = { added: 0, existing: 0, skipped: 0 };
    const summary = importSummaryText({ saved: zero, follows: { ...zero, added: 2, skipped: 3 }, stored: true });
    expect(summary).toBe("0 hikâye ve 2 takip eklendi. 3 takip eklenmedi: en fazla 20 takip olabilir.");
    expect(summary.includes(IMPORT_KEPT_FOR_RETRY_TEXT)).toBe(false);
  });

  it("importSummaryText head, existing, both cap notes, all-present, nothing, storage-failed", () => {
    const zero = { added: 0, existing: 0, skipped: 0 };
    // Head only.
    expect(importSummaryText({ saved: { ...zero, added: 3 }, follows: { ...zero, added: 2 }, stored: true })).toBe(
      "3 hikâye ve 2 takip eklendi.",
    );
    // Existing ones are summed over both lists.
    expect(
      importSummaryText({
        saved: { added: 1, existing: 4, skipped: 0 },
        follows: { added: 0, existing: 2, skipped: 0 },
        stored: true,
      }),
    ).toBe("1 hikâye ve 0 takip eklendi. Zaten listenizde olan 6 kayıt atlandı.");
    // Both cap notes, in this order, after the existing note.
    expect(
      importSummaryText({
        saved: { added: 2, existing: 1, skipped: 3 },
        follows: { added: 1, existing: 0, skipped: 4 },
        stored: true,
      }),
    ).toBe(
      "2 hikâye ve 1 takip eklendi. Zaten listenizde olan 1 kayıt atlandı. 3 hikâye eklenmedi: liste 1.000 kayda ulaştı. 4 takip eklenmedi: en fazla 20 takip olabilir.",
    );
    // One cap note only.
    expect(
      importSummaryText({ saved: { ...zero, added: 1, skipped: 2 }, follows: zero, stored: true }),
    ).toBe("1 hikâye ve 0 takip eklendi. 2 hikâye eklenmedi: liste 1.000 kayda ulaştı.");
    expect(
      importSummaryText({ saved: zero, follows: { ...zero, added: 1, skipped: 2 }, stored: true }),
    ).toBe("0 hikâye ve 1 takip eklendi. 2 takip eklenmedi: en fazla 20 takip olabilir.");
    // Everything already there.
    expect(
      importSummaryText({
        saved: { added: 0, existing: 5, skipped: 0 },
        follows: { added: 0, existing: 1, skipped: 0 },
        stored: true,
      }),
    ).toBe("Koddaki her şey zaten listenizde.");
    // Nothing in the code.
    expect(importSummaryText({ saved: zero, follows: zero, stored: true })).toBe("Kodda aktarılacak bir şey yok.");
    // Storage refused: wins over every other rule.
    expect(importSummaryText({ saved: zero, follows: zero, stored: false })).toBe(
      "Kaydedilemedi: tarayıcı yerel depolamaya yazmaya izin vermiyor.",
    );
    expect(
      importSummaryText({ saved: { ...zero, added: 3 }, follows: zero, stored: false }),
    ).toBe("Kaydedilemedi: tarayıcı yerel depolamaya yazmaya izin vermiyor.");
  });

  it("counts use the Turkish dot (1.000)", () => {
    expect(
      importSummaryText({
        saved: { added: 1234, existing: 1000, skipped: 0 },
        follows: { added: 0, existing: 0, skipped: 0 },
        stored: true,
      }),
    ).toBe("1.234 hikâye ve 0 takip eklendi. Zaten listenizde olan 1.000 kayıt atlandı.");
    expect(exportSummaryText({ saved: 1000, follows: 0, savedTotal: 1000 }, true)).toBe(
      "Kod kopyalandı: 1.000 kayıtlı hikâye, 0 takip.",
    );
  });
});
