import { describe, expect, it } from "vitest";
import {
  decodeResidualEntities,
  isXmlCodePoint,
  repairEntityResidue,
  RESIDUAL_NAMED_ENTITIES,
} from "../../../supabase/functions/_shared/rss/entities.ts";

// ---------------------------------------------------------------------------
// Entity residue: some feeds double-encode ("&amp;quot;"), and the ingest
// decoder is single-pass by design, so 47 stored articles carry a literal
// '&quot;' / '&#39;' / '&#8217;' / '&amp;' that readers saw as text.
//
//   decodeResidualEntities  ONE pass, run at ingest AFTER stripTags.
//   repairEntityResidue     bounded fixpoint of that pass, run at READ time.
//
// The invariant both must keep: they can never produce '<' or '>', so running
// after the tag strip cannot reintroduce markup.
// ---------------------------------------------------------------------------

describe("decodeResidualEntities", () => {
  it.each([
    ["&quot;x&quot;", '"x"'],
    ["&#39;", "'"],
    ["&#8217;", "’"],
    ["&amp;", "&"],
    ["&apos;", "'"],
    ["&#x27;", "'"],
    ["&#X27;", "'"],
    ["&#46;", "."],
    ["&nbsp;", " "],
    ["&zwnj;", "\u200C"],
    ["&uuml;", "ü"],
    ["&Uuml;", "Ü"],
    ["&ouml;", "ö"],
    ["&Ouml;", "Ö"],
    ["&ccedil;", "ç"],
    ["&Ccedil;", "Ç"],
    ["&scedil;", "ş"],
    ["&Scedil;", "Ş"],
    ["&gbreve;", "ğ"],
    ["&Gbreve;", "Ğ"],
    ["&Idot;", "İ"],
    ["&imath;", "ı"],
    ["&rsquo;", "’"],
    ["&lsquo;", "‘"],
    ["&ldquo;", "“"],
    ["&rdquo;", "”"],
    ["&ndash;", "–"],
    ["&mdash;", "—"],
    ["&hellip;", "…"],
  ])("decodes %j to %j", (input, expected) => {
    expect(decodeResidualEntities(input)).toBe(expected);
  });

  it.each([
    "&lt;b&gt;",
    "&#60;",
    "&#060;",
    "&#x3C;",
    "&#X3e;",
    "&#62;",
    "AT&T",
    "AT&T;",
    "&notAnEntity;",
    "&Foo123;",
    "&uuml",
    "&;",
    "uuml;",
    "Fenerbahçe",
  ])("leaves %j unchanged", (input) => {
    expect(decodeResidualEntities(input)).toBe(input);
  });

  it("keeps an angle-bracket reference unchanged even when zero-padded or mixed into text", () => {
    expect(decodeResidualEntities("a &#x0003C; b &#0000062; c")).toBe(
      "a &#x0003C; b &#0000062; c",
    );
  });

  it.each([["&#0;"], ["&#1114112;"]])(
    "drops the XML-illegal reference %j without throwing",
    (input) => {
      expect(() => decodeResidualEntities(input)).not.toThrow();
      expect(decodeResidualEntities(input)).toBe("");
    },
  );

  it("drops an overflowing decimal and an overflowing hex reference without throwing", () => {
    expect(decodeResidualEntities("a&#99999999999999999999;b")).toBe("ab");
    expect(decodeResidualEntities(`a&#x${"f".repeat(400)};b`)).toBe("ab");
  });

  it("drops a surrogate and a C0 control reference", () => {
    expect(decodeResidualEntities("a&#xD800;b&#11;c")).toBe("abc");
  });

  it("is a single pass: '&amp;quot;' becomes '&quot;', not '\"'", () => {
    expect(decodeResidualEntities("&amp;quot;")).toBe("&quot;");
  });

  it("returns '' for '' and leaves text without references untouched", () => {
    expect(decodeResidualEntities("")).toBe("");
    expect(decodeResidualEntities("Düz metin, 50% & fazlası 😀")).toBe(
      "Düz metin, 50% & fazlası 😀",
    );
  });

  it("decodes an astral reference to a whole code point", () => {
    expect(decodeResidualEntities("&#128512;")).toBe("😀");
    expect(decodeResidualEntities("&#x1F600;")).toBe("😀");
  });

  it("is safe to call repeatedly (global regex has no lastIndex carry-over)", () => {
    for (let i = 0; i < 5; i++) {
      expect(decodeResidualEntities("&quot;a&quot;")).toBe('"a"');
    }
  });
});

describe("decodeResidualEntities named table", () => {
  // `RESIDUAL_NAMED_ENTITIES` is a plain-text-only table. These two tests are
  // the structural guard: whatever a future edit adds to it, it can never
  // become a route back to markup or to an XML-illegal character.
  it("never maps to an angle bracket, and never lists lt / gt", () => {
    expect(RESIDUAL_NAMED_ENTITIES.size).toBeGreaterThan(20);
    for (const [name, value] of RESIDUAL_NAMED_ENTITIES) {
      expect(value, name).not.toContain("<");
      expect(value, name).not.toContain(">");
    }
    expect(RESIDUAL_NAMED_ENTITIES.has("lt")).toBe(false);
    expect(RESIDUAL_NAMED_ENTITIES.has("gt")).toBe(false);
  });

  it("maps every name to one legal XML character", () => {
    for (const [name, value] of RESIDUAL_NAMED_ENTITIES) {
      expect(value.length, name).toBe(1);
      expect(isXmlCodePoint(value.codePointAt(0) as number), name).toBe(true);
    }
  });

  it("decodes every name in the table in context, and only that name", () => {
    for (const [name, value] of RESIDUAL_NAMED_ENTITIES) {
      expect(decodeResidualEntities(`a &${name}; b`), name).toBe(`a ${value} b`);
    }
  });

  it("is case-sensitive: '&UUML;' and '&Quot;' are not entities and stay as they are", () => {
    expect(decodeResidualEntities("&UUML; &Quot; &AMP;")).toBe("&UUML; &Quot; &AMP;");
  });

  // The regex accepts any `&name;`, so the lookup must not fall through to
  // Object.prototype: `{}["constructor"]` is a function, and a replace callback
  // that returns a function would write "function Object() { [native code] }".
  it.each([
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ])("leaves the Object.prototype name '&%s;' unchanged", (name) => {
    expect(decodeResidualEntities(`&${name};`)).toBe(`&${name};`);
    expect(repairEntityResidue(`&amp;${name};`)).toBe(`&${name};`);
  });

  it("does not hang on 10k unterminated '&name' runs", () => {
    const input = "&abcdefghij".repeat(1000);
    const start = Date.now();
    expect(decodeResidualEntities(input)).toBe(input);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("repairEntityResidue", () => {
  it("peels nested levels: '&amp;amp;quot;x' becomes '\"x'", () => {
    expect(repairEntityResidue("&amp;amp;quot;x")).toBe('"x');
  });

  it("keeps entity-encoded markup inert: '&amp;lt;script&amp;gt;' becomes '&lt;script&gt;'", () => {
    expect(repairEntityResidue("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
  });

  it("repairs the real-world shapes from the 47 stored articles", () => {
    expect(repairEntityResidue("Bakan, &quot;kimden gelirse gelsin&quot; dedi")).toBe(
      'Bakan, "kimden gelirse gelsin" dedi',
    );
    expect(repairEntityResidue("Erdoğan&#39;dan açıklama")).toBe(
      "Erdoğan'dan açıklama",
    );
    expect(repairEntityResidue("Meclis&#8217;te gündem")).toBe("Meclis’te gündem");
    expect(repairEntityResidue("Tom &amp; Jerry")).toBe("Tom & Jerry");
  });

  it("repairs the named entities still in stored rows (232 descriptions, 88 summaries)", () => {
    expect(repairEntityResidue("T&uuml;rkiye")).toBe("Türkiye");
    expect(repairEntityResidue("&Ccedil;ok")).toBe("Çok");
    expect(repairEntityResidue("Bakan&rsquo;dan")).toBe("Bakan’dan");
    expect(repairEntityResidue("bekliyor&hellip;")).toBe("bekliyor…");
    expect(repairEntityResidue("a&nbsp;b")).toBe("a b");
  });

  it("peels a double-encoded named entity: '&amp;nbsp;' and '&amp;uuml;' both resolve", () => {
    expect(repairEntityResidue("&amp;nbsp;")).toBe(" ");
    expect(repairEntityResidue("T&amp;uuml;rkiye")).toBe("Türkiye");
    expect(repairEntityResidue("&amp;amp;hellip;")).toBe("…");
  });

  it("keeps '&amp;lt;' inert next to the wider table", () => {
    expect(repairEntityResidue("&amp;lt;&amp;uuml;&amp;gt;")).toBe("&lt;ü&gt;");
  });

  const FIXTURES = [
    "",
    "plain",
    "&quot;x&quot;",
    "&amp;amp;quot;x",
    "&amp;lt;script&amp;gt;",
    "&amp;#60;b&amp;#62;",
    "&amp;amp;amp;#39;",
    "A &quot;b&quot; c &amp; d &#39;e&#39;",
    "AT&T &nbsp; &ccedil; Fenerbahçe",
    "T&amp;uuml;rkiye &amp;amp;nbsp; bekliyor&hellip;",
    "&amp;constructor; &amp;amp;toString;",
    "&#0; &#1114112; &#xD800;",
    "&amp;#0;&amp;#1114112;",
  ];

  it.each(FIXTURES)("is idempotent for %j", (input) => {
    const once = repairEntityResidue(input);
    expect(repairEntityResidue(once)).toBe(once);
  });

  it("only ever shortens or keeps the length", () => {
    for (const input of FIXTURES) {
      expect(repairEntityResidue(input).length).toBeLessThanOrEqual(input.length);
    }
  });

  const REFS = [
    "lt;",
    "gt;",
    "#60;",
    "#62;",
    "#x3c;",
    "#X3E;",
    "#0060;",
    "quot;",
    "#39;",
  ];

  it("never produces '<' or '>' from any angle-bracket reference nested 0-5 levels deep", () => {
    let checked = 0;
    for (const ref of REFS) {
      for (let depth = 0; depth <= 5; depth++) {
        const input = `a &${"amp;".repeat(depth)}${ref} b`;
        const out = repairEntityResidue(input);
        expect(out, input).not.toContain("<");
        expect(out, input).not.toContain(">");
        // Same for a single decode pass.
        const pass = decodeResidualEntities(input);
        expect(pass, input).not.toContain("<");
        expect(pass, input).not.toContain(">");
        checked += 1;
      }
    }
    expect(checked).toBe(REFS.length * 6);
  });

  it("never produces '<' or '>' when '&' is itself produced by a numeric reference", () => {
    for (const input of ["&#38;lt;", "&#38;#60;", "&#x26;#x3C;", "&#38;#38;#62;", "&#38;gt;"]) {
      const out = repairEntityResidue(input);
      expect(out, input).not.toContain("<");
      expect(out, input).not.toContain(">");
    }
  });

  it("does not hang on a 10k-character '&amp;amp;...' chain and stays inert", () => {
    const chain = "&" + "amp;".repeat(2500);
    expect(chain.length).toBeGreaterThanOrEqual(10_000);
    const start = Date.now();
    const out = repairEntityResidue(chain);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out.length).toBeLessThan(chain.length);
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });

  it("does not hang on 10k separate references", () => {
    const input = "&quot;".repeat(10_000);
    const start = Date.now();
    expect(repairEntityResidue(input)).toBe('"'.repeat(10_000));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
