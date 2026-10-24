import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Permanent CI guard (db-4 ingest half): a publisher logo card or a 'son
// dakika' stand-in (isPlaceholderImageUrl, _shared/image-url.ts) must never be
// stored as articles.image_url. Three places could write one:
//
//   1. supabase/functions/_shared/rss/normalize.ts -- the RSS image extractor.
//      Both firstNonVideoCandidate (enclosure / media:*) and the local
//      isValidImageUrl (itemImage / inline <img>) must refuse a placeholder,
//      so a real candidate behind it can win and an all-placeholder item gets
//      NULL (which is what queues the og:image backfill).
//   2. supabase/functions/_shared/og-image.ts -- isValidImageUrl is the
//      candidate filter of extractHeroImageFromHtml.
//   3. supabase/functions/image-consumer/index.ts -- the backfill itself. It
//      must reject a placeholder og:image BEFORE the update that writes
//      image_url, or the job meant to find the real photo writes the
//      placeholder straight back.
//
// The checks read the source text and walk the TypeScript AST (a mention in a
// comment or a string never counts as a call). Each check is a pure function of
// the source so the last describe block can prove, on mutated copies, that
// removing any one of the guarded pieces makes the guard fail.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

const NORMALIZE = "supabase/functions/_shared/rss/normalize.ts";
const OG_IMAGE = "supabase/functions/_shared/og-image.ts";
const IMAGE_CONSUMER = "supabase/functions/image-consumer/index.ts";

const PLACEHOLDER_FN = "isPlaceholderImageUrl";

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

function parse(src: string): ts.SourceFile {
  return ts.createSourceFile("guard.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

/** Top-level `function <name>` declaration. */
function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
}

/** Every `isPlaceholderImageUrl(...)` call expression under `root`. */
function placeholderCalls(root: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  visit(root, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === PLACEHOLDER_FN) {
      calls.push(n);
    }
  });
  return calls;
}

/** `import { ..., isPlaceholderImageUrl, ... } from "<specifier>"` (value import). */
function importsPlaceholderFrom(sf: ts.SourceFile, specifier: string): boolean {
  return sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === specifier &&
      !!s.importClause &&
      !s.importClause.isTypeOnly &&
      !!s.importClause.namedBindings &&
      ts.isNamedImports(s.importClause.namedBindings) &&
      s.importClause.namedBindings.elements.some(
        (e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === PLACEHOLDER_FN,
      ),
  );
}

/** True when `thenStmt` is, or is a block holding, `return false`. */
function returnsFalse(thenStmt: ts.Statement): boolean {
  const isReturnFalse = (s: ts.Statement): boolean =>
    ts.isReturnStatement(s) && s.expression?.kind === ts.SyntaxKind.FalseKeyword;
  if (isReturnFalse(thenStmt)) return true;
  return ts.isBlock(thenStmt) && thenStmt.statements.some(isReturnFalse);
}

/**
 * `fn` contains `if (isPlaceholderImageUrl(...)) return false;`
 * (an inverted or merely-present call does not count).
 */
function rejectsPlaceholderWithReturnFalse(fn: ts.FunctionDeclaration): boolean {
  let found = false;
  visit(fn, (n) => {
    if (
      ts.isIfStatement(n) &&
      placeholderCalls(n.expression).length > 0 &&
      returnsFalse(n.thenStatement)
    ) {
      found = true;
    }
  });
  return found;
}

/** `fn` contains `!isPlaceholderImageUrl(...)` (negated, so a placeholder is skipped). */
function requiresNotPlaceholder(fn: ts.FunctionDeclaration): boolean {
  return placeholderCalls(fn).some(
    (c) =>
      ts.isPrefixUnaryExpression(c.parent) &&
      c.parent.operator === ts.SyntaxKind.ExclamationToken,
  );
}

// -- the three source checks: each returns the list of violations ------------

function checkNormalize(src: string): string[] {
  const sf = parse(src);
  const problems: string[] = [];
  if (!importsPlaceholderFrom(sf, "../image-url.ts")) {
    problems.push('normalize.ts must import isPlaceholderImageUrl from "../image-url.ts"');
  }
  const first = findFunction(sf, "firstNonVideoCandidate");
  if (!first) problems.push("normalize.ts lost firstNonVideoCandidate");
  else if (!requiresNotPlaceholder(first)) {
    problems.push("firstNonVideoCandidate must require !isPlaceholderImageUrl(candidate)");
  }
  const valid = findFunction(sf, "isValidImageUrl");
  if (!valid) problems.push("normalize.ts lost its local isValidImageUrl");
  else if (!rejectsPlaceholderWithReturnFalse(valid)) {
    problems.push("normalize.ts isValidImageUrl must `if (isPlaceholderImageUrl(url)) return false`");
  }
  return problems;
}

function checkOgImage(src: string): string[] {
  const sf = parse(src);
  const problems: string[] = [];
  if (!importsPlaceholderFrom(sf, "./image-url.ts")) {
    problems.push('og-image.ts must import isPlaceholderImageUrl from "./image-url.ts"');
  }
  const valid = findFunction(sf, "isValidImageUrl");
  if (!valid) problems.push("og-image.ts lost its exported isValidImageUrl");
  else if (!rejectsPlaceholderWithReturnFalse(valid)) {
    problems.push("og-image.ts isValidImageUrl must `if (isPlaceholderImageUrl(url)) return false`");
  }
  return problems;
}

function checkImageConsumer(src: string): string[] {
  const sf = parse(src);
  const problems: string[] = [];
  if (!importsPlaceholderFrom(sf, "../_shared/image-url.ts")) {
    problems.push('image-consumer must import isPlaceholderImageUrl from "../_shared/image-url.ts"');
  }
  const calls = placeholderCalls(sf);
  if (calls.length === 0) {
    problems.push("image-consumer never calls isPlaceholderImageUrl");
    return problems;
  }
  // Every place that assigns the fetched `ogImage` to an `image_url:` property
  // (the .update({ image_url: ogImage, ... }) write) must come after a check.
  const firstCheck = Math.min(...calls.map((c) => c.getStart(sf)));
  let writes = 0;
  visit(sf, (n) => {
    if (
      ts.isPropertyAssignment(n) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
      n.name.text === "image_url"
    ) {
      writes += 1;
      if (n.getStart(sf) < firstCheck) {
        problems.push("image-consumer writes image_url before it calls isPlaceholderImageUrl");
      }
    }
  });
  if (writes === 0) problems.push("image-consumer no longer has an image_url write to guard");
  return problems;
}

describe("db-4 ingest half: placeholder images are never stored as image_url", () => {
  it("normalize.ts skips placeholders in firstNonVideoCandidate and in isValidImageUrl", () => {
    expect(checkNormalize(read(NORMALIZE))).toEqual([]);
  });

  it("og-image.ts isValidImageUrl rejects placeholders (extractHeroImageFromHtml and the consumer gate)", () => {
    expect(checkOgImage(read(OG_IMAGE))).toEqual([]);
  });

  it("image-consumer/index.ts rejects a placeholder og:image before it writes image_url", () => {
    expect(checkImageConsumer(read(IMAGE_CONSUMER))).toEqual([]);
  });
});

describe("db-4 ingest half guard: removing a guarded piece fails the guard", () => {
  function mutate(src: string, from: string | RegExp, to: string): string {
    const out = src.replace(from, to);
    expect(out).not.toBe(src); // the mutation must actually change the source
    return out;
  }

  it("fails when normalize.ts drops the import", () => {
    const src = mutate(read(NORMALIZE), /isPlaceholderImageUrl,\s*/, "");
    expect(checkNormalize(src).length).toBeGreaterThan(0);
  });

  it("fails when firstNonVideoCandidate stops checking", () => {
    const src = mutate(read(NORMALIZE), /\s*&&\s*!isPlaceholderImageUrl\(normalized\)/, "");
    const problems = checkNormalize(src);
    expect(problems.join("\n")).toContain("firstNonVideoCandidate");
  });

  it("fails when firstNonVideoCandidate inverts the check", () => {
    const src = mutate(read(NORMALIZE), "!isPlaceholderImageUrl(normalized)", "isPlaceholderImageUrl(normalized)");
    expect(checkNormalize(src).join("\n")).toContain("firstNonVideoCandidate");
  });

  it("fails when the normalize.ts isValidImageUrl stops checking", () => {
    const src = mutate(read(NORMALIZE), /\n[^\n]*if \(isPlaceholderImageUrl\(url\)\) return false;/, "");
    expect(checkNormalize(src).join("\n")).toContain("isValidImageUrl");
  });

  it("fails when a placeholder mention only survives in a comment", () => {
    const src = mutate(
      read(NORMALIZE),
      /\n[^\n]*if \(isPlaceholderImageUrl\(url\)\) return false;/,
      "\n  // if (isPlaceholderImageUrl(url)) return false;",
    );
    expect(checkNormalize(src).join("\n")).toContain("isValidImageUrl");
  });

  it("fails when og-image.ts isValidImageUrl stops checking", () => {
    const src = mutate(read(OG_IMAGE), /\n[^\n]*if \(isPlaceholderImageUrl\(url\)\) return false;/, "");
    expect(checkOgImage(src).join("\n")).toContain("isValidImageUrl");
  });

  it("fails when og-image.ts drops the import", () => {
    const src = mutate(read(OG_IMAGE), /isPlaceholderImageUrl,\s*/, "");
    expect(checkOgImage(src).length).toBeGreaterThan(0);
  });

  it("fails when image-consumer stops calling isPlaceholderImageUrl", () => {
    const src = mutate(read(IMAGE_CONSUMER), /isPlaceholderImageUrl\(ogImage\)/g, "false");
    expect(checkImageConsumer(src).join("\n")).toContain("never calls");
  });

  it("fails when image-consumer only checks after the image_url write", () => {
    // Move the placeholder check to the end of the file: it still "exists",
    // but not before the write.
    const withoutCheck = mutate(read(IMAGE_CONSUMER), /isPlaceholderImageUrl\(ogImage\)/g, "false");
    const src = `${withoutCheck}\nvoid isPlaceholderImageUrl("x");\n`;
    expect(checkImageConsumer(src).join("\n")).toContain("before it calls");
  });

  it("fails when image-consumer drops the import", () => {
    const src = mutate(read(IMAGE_CONSUMER), /import \{ isPlaceholderImageUrl \} from "\.\.\/_shared\/image-url\.ts";\n/, "");
    expect(checkImageConsumer(src).join("\n")).toContain("import");
  });
});
