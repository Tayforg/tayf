import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BiasSpectrum } from "@/components/story/bias-spectrum";

import { SAVED_LOAD_FAILED_TEXT, SavedEmptyState, SavedFrame, SavedList, SavedLoadFailed } from "./saved-list";
import { toSavedRowView } from "./saved-row";

// Source guard (same approach as framing-game.test.tsx): saved-list.tsx must
// not statically import supabase-js into the /saved route's bundle — it
// should be pulled in lazily, inside the effect, only when there are
// bookmarked ids to look up.
/** Text content of static markup: a character scan, never a regular expression over the markup. */
function textOf(markup: string): string {
  let out = "";
  let inTag = false;
  for (const ch of markup) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out.split(/\s+/).join(" ").trim();
}

describe("saved-list.tsx source", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");

  it("does not statically import the browser Supabase client", () => {
    expect(src).not.toMatch(/^\s*import\s*\{[^}]*createBrowserClient[^}]*\}\s*from\s*["']@\/lib\/supabase\/browser["']/m);
  });

  it("dynamically imports the browser Supabase client", () => {
    expect(src).toContain(`await import("@/lib/supabase/browser")`);
  });
});

describe("saved-list.tsx change badges", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");

  it("reads rows through the saved_clusters_v4 RPC first (bias_distribution, is_blindspot, first_published and effective_article_count are in its return shape)", () => {
    expect(src.match(/\.rpc\("saved_clusters_v4"/g)).toHaveLength(1);
    expect(src).toMatch(/\.rpc\("saved_clusters_v4",\s*\{\s*p_ids:\s*ids\s*\}\)/);
    expect(src).toContain("bias_distribution: unknown");
    expect(src).toContain("is_blindspot?: boolean");
    // absent on v2 / v1 fallback rows, null when the cluster has no first_published
    expect(src).toContain("first_published?: string | null");
    // absent on v3 / v2 / v1 fallback rows, null when the cluster has no member rows
    expect(src).toContain("effective_article_count?: number | null");
  });

  it("prints the source count through savedSourceLabel (the wire-collapsed count of v4 when present, article_count otherwise), never the raw column (h112-follows-3)", () => {
    expect(src).toMatch(/import\s*\{[^}]*savedSourceLabel[^}]*\}\s*from\s*["']@\/components\/bookmark\/saved-row["']/);
    const code = src.replace(/\/\/[^\n]*/g, "");
    expect(code).toContain("{savedSourceLabel(row)}");
    expect(code).not.toContain("{row.article_count}");
    expect(code).not.toMatch(/row\.article_count/);
    // the label sits where the bare count was: after the Users icon, inside the meta line
    expect(code).toMatch(/<Users className="h-3 w-3" \/>\s*\{savedSourceLabel\(row\)\}/);
  });

  it("imports reconcileSnapshots and changeBadgeLabels", () => {
    expect(src).toMatch(/import\s*\{[^}]*reconcileSnapshots[^}]*\}\s*from\s*["']@\/components\/bookmark\/bookmark-snapshots["']/);
    expect(src).toMatch(/import\s*\{[^}]*changeBadgeLabels[^}]*\}\s*from\s*["']@\/components\/bookmark\/bookmark-snapshots["']/);
  });

  it("never touches localStorage directly and reads snapshots only inside the effect", () => {
    expect(src).not.toContain("localStorage");
    const effectAt = src.indexOf("useEffect(");
    const firstRead = src.indexOf("readSnapshots(");
    expect(effectAt).toBeGreaterThan(-1);
    expect(firstRead).toBeGreaterThan(effectAt);
    expect(src.indexOf("readSnapshots(", firstRead + 1)).toBe(-1);
  });
});

describe("saved-list.tsx reading-diet card", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");

  it("imports SavedMixCard from the saved-mix-card module", () => {
    expect(src).toMatch(/import\s*\{[^}]*SavedMixCard[^}]*\}\s*from\s*["']@\/components\/bookmark\/saved-mix-card["']/);
  });

  it("renders the card with the already-loaded rows", () => {
    expect(src).toContain("<SavedMixCard rows={rows} />");
  });

  it("does not import the click tracker (the diet is computed, never sent)", () => {
    expect(src).not.toContain("@/lib/track");
    expect(src).not.toMatch(/\btrack\(/);
  });

  it("one v4 lookup plus missing-RPC fallbacks to v3 and v2 and a PGRST202-only fallback to v1 (no new fetch for the diet)", () => {
    expect(src.match(/\.rpc\("saved_clusters_v4"/g)).toHaveLength(1);
    expect(src.match(/\.rpc\("saved_clusters_v3"/g)).toHaveLength(1);
    expect(src.match(/\.rpc\("saved_clusters_v2"/g)).toHaveLength(1);
    expect(src.match(/\.rpc\("saved_clusters"/g)).toHaveLength(1);
    expect(src).toMatch(/\.rpc\("saved_clusters",\s*\{\s*p_ids:\s*ids\s*\}\)/);
    // v4 first, the v3 call behind isRpcMissing, the v2 call behind a second isRpcMissing, the v1 call behind the
    // PGRST202 check, in that order.
    const code = src.replace(/\/\/[^\n]*/g, "");
    const v4At = code.indexOf('.rpc("saved_clusters_v4"');
    const missingAt = code.indexOf("isRpcMissing(res.error)");
    const v3At = code.indexOf('.rpc("saved_clusters_v3"');
    const missing2At = code.indexOf("isRpcMissing(res.error)", missingAt + 1);
    const v2At = code.indexOf('.rpc("saved_clusters_v2"');
    const codeAt = code.indexOf("PGRST202");
    const v1At = code.indexOf('.rpc("saved_clusters",');
    expect(v4At).toBeGreaterThan(-1);
    expect(missingAt).toBeGreaterThan(v4At);
    expect(v3At).toBeGreaterThan(missingAt);
    expect(missing2At).toBeGreaterThan(v3At);
    expect(v2At).toBeGreaterThan(missing2At);
    expect(codeAt).toBeGreaterThan(v2At);
    expect(v1At).toBeGreaterThan(codeAt);
    // Array.from(...) is not a PostgREST table call.
    expect(src.match(/(?<!Array)\.from\(/g)).toBeNull();
  });
});

describe("saved-list.tsx RPC input hygiene", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");

  it("sends only well-formed UUIDs, capped at the newest 200 (the RPC's own cap)", () => {
    expect(src).toMatch(/const SAVED_RPC_MAX_IDS = 200;/);
    expect(src).toMatch(
      /const ids = idList\s*\.filter\(\(id\) => typeof id === "string" && UUID_RE\.test\(id\)\)\s*\.slice\(-SAVED_RPC_MAX_IDS\);/,
    );
  });

  it("short-circuits an empty id list without importing the client", () => {
    const emptyAt = src.indexOf("ids.length === 0");
    const importAt = src.indexOf(`await import("@/lib/supabase/browser")`);
    expect(emptyAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(emptyAt);
    expect(src.slice(emptyAt, importAt)).toMatch(/setRows\(\[\]\);[\s\S]*setFailed\(false\);[\s\S]*return;/);
  });

  it("keeps the fail-open error copy and prunes snapshots against the full saved list", () => {
    expect(src).toContain("Kaydedilenler yüklenemedi. Lütfen sayfayı yenileyin.");
    expect(src).toContain("pruneSnapshots(idList);");
  });
});

describe("saved-list.tsx v4 lookup, v3 fallback, v2 fallback and v1 fallback", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");
  // Line comments removed, so prose can neither satisfy nor trip a code guard.
  const code = src.replace(/\/\/[^\n]*/g, "");

  it("falls back from v4 to v3 once, only when v4 is missing (PGRST202 or 42883: the app deployed before migration 192), then v3 to v2 the same way, then v2 to v1 only on PGRST202, before the shared error handling", () => {
    expect(src).toMatch(/const client = createBrowserClient\(\);/);
    expect(src).toMatch(/let res = await client\.rpc\("saved_clusters_v4",\s*\{\s*p_ids:\s*ids\s*\}\);/);
    expect(src).toMatch(
      /if \(isRpcMissing\(res\.error\)\) \{\s*res = await client\.rpc\("saved_clusters_v3",\s*\{\s*p_ids:\s*ids\s*\}\);\s*\}/,
    );
    expect(src).toMatch(
      /if \(isRpcMissing\(res\.error\)\) \{\s*res = await client\.rpc\("saved_clusters_v2",\s*\{\s*p_ids:\s*ids\s*\}\);\s*\}/,
    );
    expect(src).toMatch(/import\s*\{[^}]*isRpcMissing[^}]*\}\s*from\s*["']@\/components\/bookmark\/saved-row["']/);
    const v2At = src.indexOf('res = await client.rpc("saved_clusters_v2",');
    const v1CheckAt = src.indexOf('res.error?.code === "PGRST202"');
    expect(v2At).toBeGreaterThan(-1);
    expect(v1CheckAt).toBeGreaterThan(v2At);
    expect(src).toMatch(
      /if \(res\.error\?\.code === "PGRST202"\) \{\s*res = await client\.rpc\("saved_clusters",\s*\{\s*p_ids:\s*ids\s*\}\);\s*\}/,
    );
    const fallbackAt = src.indexOf('res = await client.rpc("saved_clusters",');
    const errorAt = src.indexOf("const { data, error } = res;");
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(fallbackAt);
    // Exactly one PostgREST error code ever triggers the fallback.
    expect(code.match(/PGRST\d+/g)).toEqual(["PGRST202"]);
  });

  it("keeps the fail-open path for every other error code", () => {
    expect(src).toContain("if (error) {");
    expect(src).toContain("setFailed(true);");
  });
});

// h38-saved-1: the pill waits BLINDSPOT.feedDelayHours here too. The component reads the clock
// once, in the effect after the rows have loaded (never during a render), and maps every row
// through publicBlindspotClaim (via toPublicSavedRow) before anything else sees the flag.
describe("saved-list.tsx public Kör nokta claim (h38-saved-1)", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "");

  it("imports toPublicSavedRow from the saved-row module", () => {
    expect(src).toMatch(/import\s*\{[^}]*toPublicSavedRow[^}]*\}\s*from\s*["']@\/components\/bookmark\/saved-row["']/);
  });

  it("reads the clock exactly once, and only inside the effect that loads the rows", () => {
    expect(code.match(/Date\.now\(\)/g)).toHaveLength(1);
    const effectAt = code.indexOf("useEffect(");
    const effectEnd = code.indexOf("}, [idList]);");
    const clockAt = code.indexOf("Date.now()");
    expect(effectAt).toBeGreaterThan(-1);
    expect(clockAt).toBeGreaterThan(effectAt);
    expect(clockAt).toBeLessThan(effectEnd);
    // not while rendering: nothing before the first hook, nothing after the effect
    expect(code.slice(0, effectAt)).not.toContain("Date.now");
    expect(code.slice(effectEnd)).not.toContain("Date.now");
    expect(code).not.toMatch(/new Date\(\)(?!\.toISOString\(\))/);
  });

  it("maps the loaded rows after the error check and before the snapshots and setRows see them", () => {
    const errorAt = code.indexOf("const { data, error } = res;");
    const clockAt = code.indexOf("Date.now()");
    const mapAt = code.indexOf("toPublicSavedRow(");
    const reconcileAt = code.indexOf("reconcileSnapshots(");
    const setRowsAt = code.indexOf("setRows(loaded)");
    expect(errorAt).toBeGreaterThan(-1);
    expect(clockAt).toBeGreaterThan(errorAt);
    expect(mapAt).toBeGreaterThan(clockAt);
    expect(reconcileAt).toBeGreaterThan(mapAt);
    expect(setRowsAt).toBeGreaterThan(reconcileAt);
    expect(code).toMatch(/\.map\(\(row\) => toPublicSavedRow\(row, nowMs\)\)/);
    expect(code).toContain("reconcileSnapshots(loaded, snaps,");
  });

  it("the pill still renders only for view.isBlindspot, which is now the public claim", () => {
    expect(code).toContain("const view = toSavedRowView(row);");
    expect(code).toContain("view.isBlindspot && (");
  });
});

describe("saved-list.tsx blindspot pill and spectrum bar", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");
  const card = readFileSync(join(__dirname, "..", "story", "cluster-card.tsx"), "utf8");

  /** className of the "Kör nokta" pill that cluster-card.tsx renders after its AlertTriangle. */
  function cardPillClass(): string {
    const m = card.match(/<span className="([^"]+)">\s*<AlertTriangle[^>]*\/>\s*Kör nokta\s*<\/span>/);
    if (!m || m[1] === undefined) throw new Error("Kör nokta pill not found in cluster-card.tsx");
    return m[1];
  }

  it("imports toSavedRowView and BiasSpectrum", () => {
    expect(src).toMatch(/import\s*\{[^}]*toSavedRowView[^}]*\}\s*from\s*["']@\/components\/bookmark\/saved-row["']/);
    expect(src).toMatch(/import\s*\{[^}]*BiasSpectrum[^}]*\}\s*from\s*["']@\/components\/story\/bias-spectrum["']/);
  });

  it("uses the Kör nokta pill class string of cluster-card.tsx verbatim (so the two cannot drift)", () => {
    const cls = cardPillClass();
    expect(cls).toContain("bg-amber-500/15");
    // Both files carry the AA light-mode shade: text-amber-800 clears 4.5:1 on
    // the 15 % amber wash (WCAG 1.4.3), which the site-wide tinted-text guard in
    // tests/guards/text-contrast-tokens.test.ts measures. The string must stay
    // identical in both places, so no per-file patching is needed here.
    expect(cls).toContain("text-amber-800");
    expect(src).toContain(`className="${cls}"`);
    expect(src).not.toContain("text-amber-700");
  });

  it("renders the pill only for view.isBlindspot, with a decorative icon and the 'Kör nokta' copy", () => {
    expect(src).toMatch(/const view = toSavedRowView\(row\);/);
    expect(src).toMatch(
      /view\.isBlindspot && \(\s*<span className="[^"]+">\s*<AlertTriangle className="h-3 w-3" aria-hidden="true" \/>\s*Kör nokta\s*<\/span>\s*\)/,
    );
    expect(src).toMatch(/import\s*\{[^}]*AlertTriangle[^}]*\}\s*from\s*["']lucide-react["']/);
  });

  it("renders the compact spectrum bar for a non-null distribution, inside the Link, after the meta line", () => {
    expect(src).toMatch(
      /view\.distribution && \(\s*<div className="mt-2">\s*<BiasSpectrum distribution=\{view\.distribution\} compact \/>\s*<\/div>\s*\)/,
    );
    const linkOpen = src.indexOf("<Link");
    const linkClose = src.indexOf("</Link>");
    const barAt = src.indexOf("<BiasSpectrum");
    const pillAt = src.indexOf("Kör nokta");
    const metaAt = src.indexOf("text-[11px] text-muted-foreground");
    expect(barAt).toBeGreaterThan(linkOpen);
    expect(barAt).toBeLessThan(linkClose);
    expect(pillAt).toBeGreaterThan(metaAt);
    expect(pillAt).toBeLessThan(barAt);
  });

  it("keeps the remove button a sibling of the Link and the copy unchanged", () => {
    const linkClose = src.indexOf("</Link>");
    const buttonAt = src.indexOf("<button");
    expect(buttonAt).toBeGreaterThan(linkClose);
    expect(src).toContain("Kaydedilenlerden çıkar");
    expect(src).toContain("Henüz kaydettiğiniz bir hikâye yok");
    expect(src).toContain("Kaydedilenler yüklenemedi. Lütfen sayfayı yenileyin.");
  });

  it("BiasSpectrum's compact bar contains no interactive element (safe to nest inside the Link)", () => {
    const view = toSavedRowView({ bias_distribution: { pro_government: 2, center: 1, opposition: 3 } });
    expect(view.distribution).not.toBeNull();
    const markup = renderToStaticMarkup(
      createElement(BiasSpectrum, { distribution: view.distribution!, compact: true }),
    );
    expect(markup).toContain("İktidar");
    expect(markup).not.toMatch(/<(a|button|input|select|textarea|summary)[\s>]/i);
    expect(markup).not.toMatch(/\b(href|onclick|tabindex)=/i);
  });
});

describe("saved-list.tsx accessible names and update-time label", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "");

  it("names the remove button after the story it removes (WCAG 2.5.3 / 4.1.2)", () => {
    expect(code).toContain("aria-label={savedRemoveLabel(row.title_tr_neutral ?? row.title_tr)}");
    expect(src).toMatch(/import\s*\{[^}]*savedRemoveLabel[^}]*\}\s*from\s*["']@\/components\/bookmark\/bookmark-label["']/);
  });

  it("has no literal generic aria-label left on the remove button", () => {
    expect(src).not.toContain('aria-label="Kaydedilenlerden çıkar"');
  });

  it("keeps the generic tooltip", () => {
    expect(src).toContain('title="Kaydedilenlerden çıkar"');
  });

  it("renders the age as the update time inside <time>, only when the label is non-empty", () => {
    expect(src).toMatch(/import\s*\{[^}]*savedUpdatedLabel[^}]*\}\s*from\s*["']@\/components\/bookmark\/saved-row["']/);
    expect(code).toContain("savedUpdatedLabel(row.updated_at)");
    expect(code).toContain("<time dateTime={row.updated_at}>");
    expect(code).toMatch(/\{updatedLabel && \(\s*<time dateTime=\{row\.updated_at\}>\{updatedLabel\}<\/time>\s*\)\}/);
  });

  it("no longer prints a bare relative age that reads like a publication date", () => {
    expect(code).not.toContain("{formatTurkishTimeAgo(row.updated_at)}");
    expect(code).not.toContain("formatTurkishTimeAgo");
  });
});

describe("SavedFrame / live region", () => {
  it("renders one polite status region before its children", () => {
    const markup = renderToStaticMarkup(
      createElement(SavedFrame, { announcement: "" }, createElement("i", null, "child")),
    );
    expect(markup).toBe('<div><p role="status" aria-live="polite" class="sr-only"></p><i>child</i></div>');
  });

  it("carries the announcement text in the region", () => {
    const markup = renderToStaticMarkup(
      createElement(SavedFrame, { announcement: "Çıkarıldı." }, createElement("i", null, "child")),
    );
    expect(markup).toMatch(/<p role="status" aria-live="polite" class="sr-only">Çıkarıldı\.<\/p>/);
  });

  it("escapes the announcement as text (a story title is never markup)", () => {
    const markup = renderToStaticMarkup(
      createElement(SavedFrame, { announcement: "<b>x</b>" }, null),
    );
    expect(markup).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(markup).not.toContain("<b>");
  });
});

describe("SavedLoadFailed (h30-live-1)", () => {
  it("exports the failure copy unchanged", () => {
    expect(SAVED_LOAD_FAILED_TEXT).toBe("Kaydedilenler yüklenemedi. Lütfen sayfayı yenileyin.");
  });

  it("renders a role=\"status\" element containing the failure copy", () => {
    const markup = renderToStaticMarkup(createElement(SavedLoadFailed));
    expect(markup).toContain(
      '<p role="status" aria-live="polite" class="sr-only">Kaydedilenler yüklenemedi. Lütfen sayfayı yenileyin.</p>',
    );
  });

  it("shows the copy once visually and hides the duplicate from assistive technology", () => {
    const markup = renderToStaticMarkup(createElement(SavedLoadFailed));
    expect(markup).toContain(
      '<p aria-hidden="true" class="text-sm text-muted-foreground">Kaydedilenler yüklenemedi. Lütfen sayfayı yenileyin.</p>',
    );
    // The region and the visible paragraph: the text is in the markup twice.
    expect(textOf(markup).split(SAVED_LOAD_FAILED_TEXT)).toHaveLength(3);
    // Exactly one live region, and it is not the visible paragraph.
    expect(markup.split('role="status"')).toHaveLength(2);
  });

  it("is the same markup as the SavedFrame the loading branch renders, with the copy as its announcement", () => {
    expect(renderToStaticMarkup(createElement(SavedLoadFailed))).toBe(
      renderToStaticMarkup(
        createElement(
          SavedFrame,
          { announcement: SAVED_LOAD_FAILED_TEXT },
          createElement("p", { "aria-hidden": "true", className: "text-sm text-muted-foreground" }, SAVED_LOAD_FAILED_TEXT),
        ),
      ),
    );
  });

  it("called as a function it returns an element of type SavedFrame: the loading and the failed branch share a root, so React keeps the region mounted", () => {
    const element = SavedLoadFailed();
    expect(element.type).toBe(SavedFrame);
    expect(element.props.announcement).toBe(SAVED_LOAD_FAILED_TEXT);
    // A component element would have a different type and remount the region.
    expect(createElement(SavedLoadFailed).type).not.toBe(SavedFrame);
  });

  it("contains no link or button", () => {
    expect(renderToStaticMarkup(createElement(SavedLoadFailed))).not.toMatch(/<(a|button)[\s>]/i);
  });
});

describe("SavedEmptyState", () => {
  it("reads 'kartlarındaki yer imi simgesine' with the icon between two spaces (h30-live-1)", () => {
    const markup = renderToStaticMarkup(createElement(SavedEmptyState, {}));
    const paragraph = markup.slice(markup.indexOf("<p "));
    expect(textOf(paragraph)).toBe("Hikâye kartlarındaki yer imi simgesine dokunarak favorilerinizi kaydedin.");
    // The spaces are text around the icon, not margins on it.
    expect(markup).toContain("Hikâye kartlarındaki <svg");
    expect(markup).toContain("</svg> yer imi simgesine dokunarak");
  });

  it("hides the bookmark icon from assistive technology and drops the margin class", () => {
    const markup = renderToStaticMarkup(createElement(SavedEmptyState, {}));
    const svgAt = markup.indexOf("<svg");
    expect(svgAt).toBeGreaterThan(-1);
    const openTag = markup.slice(svgAt, markup.indexOf(">", svgAt) + 1);
    expect(openTag).toContain('aria-hidden="true"');
    expect(openTag).toContain("inline");
    expect(openTag).toContain("h-3.5");
    expect(openTag).toContain("w-3.5");
    expect(openTag).toContain("align-[-2px]");
    expect(openTag).not.toContain("mx-1");
    expect(markup.split("<svg")).toHaveLength(2);
  });

  it("source: the icon sits between {\" \"} spaces with literal Tailwind classes", () => {
    const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");
    expect(src).toContain('Hikâye kartlarındaki{" "}');
    expect(src).toContain('<Bookmark aria-hidden="true" className="inline h-3.5 w-3.5 align-[-2px]" />');
    expect(src).toMatch(/\/>\{" "\}\s*yer imi simgesine dokunarak/);
    expect(src).not.toContain("mx-1");
  });

  it("renders the heading as a script-focusable target (tabindex -1)", () => {
    const markup = renderToStaticMarkup(createElement(SavedEmptyState, {}));
    expect(markup).toMatch(/<h2 tabindex="-1"[^>]*>Henüz kaydettiğiniz bir hikâye yok<\/h2>/);
  });

  it("keeps a visible focus ring on the heading", () => {
    const markup = renderToStaticMarkup(createElement(SavedEmptyState, {}));
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain("focus-visible:ring-ring");
    expect(markup).toContain("outline-none");
  });

  it("contains no link or button (the remove button must stay the first one after the first link)", () => {
    const markup = renderToStaticMarkup(createElement(SavedEmptyState, {}));
    expect(markup).not.toMatch(/<(a|button)[\s>]/i);
  });
});

describe("SavedList markup before hydration", () => {
  // The server snapshot of useBookmarks has no ids, so the first paint used to be
  // the empty state, told to every visitor including the ones who have saved
  // stories (h54-personal-1). It is now the same neutral busy placeholder /takip
  // ships. The live region has to be there already: a region inserted together
  // with its text is usually not announced.
  const markup = renderToStaticMarkup(createElement(SavedList));

  it("mounts the polite status region, empty, around the placeholder", () => {
    expect(markup).toContain('<p role="status" aria-live="polite" class="sr-only"></p>');
    expect(markup.indexOf('role="status"')).toBeLessThan(markup.indexOf('aria-busy="true"'));
  });

  it("renders the neutral busy placeholder /takip uses (same box, so the two pages match)", () => {
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('class="h-24 animate-pulse rounded-xl bg-card/60 ring-1 ring-border/60"');
  });

  it("hides the empty placeholder from assistive technology (it has no name to read)", () => {
    expect(markup).toMatch(/<div aria-hidden="true" aria-busy="true"[^>]*><\/div>/);
  });

  it("does not tell the reader the list is empty", () => {
    expect(markup).not.toContain("Henüz kaydettiğiniz bir hikâye yok");
    expect(markup).not.toContain("yer imi simgesine");
    expect(markup).not.toContain("<h2");
    expect(markup).not.toContain('tabindex="-1"');
  });

  it("is exactly the frame around the placeholder, with nothing else to focus or read", () => {
    expect(markup).toBe(
      '<div><p role="status" aria-live="polite" class="sr-only"></p>' +
        '<div aria-hidden="true" aria-busy="true" class="h-24 animate-pulse rounded-xl bg-card/60 ring-1 ring-border/60"></div></div>',
    );
    expect(markup).not.toMatch(/<(a|button)[\s>]/i);
  });
});

describe("saved-list.tsx hydration gate (source guard: effects and hydration need a browser)", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "");
  const component = code.slice(code.indexOf("export function SavedList"));

  it("reads the hook once, next to useBookmarks, above every early return", () => {
    expect(component.match(/\buseHydrated\(\)/g)).toHaveLength(1);
    expect(component).toContain("const hydrated = useHydrated();");
    expect(component.indexOf("useHydrated()")).toBeLessThan(component.indexOf("\n  if ("));
  });

  it("returns the placeholder inside the same SavedFrame, before the empty and loading branches", () => {
    const gateAt = component.indexOf("  if (!hydrated) {");
    const emptyAt = component.indexOf("  if (emptyNow) {");
    const loadingAt = component.indexOf("  if (rows === null) {");
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(emptyAt);
    expect(emptyAt).toBeLessThan(loadingAt);
    const body = component.slice(gateAt, component.indexOf("\n  }\n", gateAt));
    expect(body).toContain("<SavedFrame announcement={announcement}>");
    expect(body).toContain('aria-busy="true"');
    expect(body).toContain('aria-hidden="true"');
    expect(body).toContain('className="h-24 animate-pulse rounded-xl bg-card/60 ring-1 ring-border/60"');
    expect(body).not.toContain("SavedEmptyState");
  });

  it("renders SavedEmptyState on exactly one path, the post-hydration empty branch", () => {
    expect(component.match(/<SavedEmptyState/g)).toHaveLength(1);
    const emptyAt = component.indexOf("  if (emptyNow) {");
    expect(component.indexOf("<SavedEmptyState")).toBeGreaterThan(emptyAt);
  });

  it("leaves the empty / loading / focus logic as it was", () => {
    expect(component).toMatch(/const emptyNow\s*=\s*count === 0 \|\| \(rows !== null && !failed && rows\.length === 0\);/);
    expect(component).not.toMatch(/hydrated\s*&&/);
    expect(component).not.toMatch(/emptyNow[^\n]*hydrated/);
    expect(component).not.toMatch(/shownSig[^\n]*hydrated/);
  });
});

describe("saved-list.tsx focus handoff and announcements", () => {
  const src = readFileSync(join(__dirname, "saved-list.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "");
  const listAt = code.indexOf("export function SavedList");
  const component = code.slice(listAt);

  it("reuses focusTargetAfterRemove from the follows module", () => {
    expect(src).toMatch(/import\s*\{[^}]*focusTargetAfterRemove[^}]*\}\s*from\s*["']@\/lib\/follows\/follows["']/);
  });

  it("builds the removal announcement with savedRemovalAnnouncement", () => {
    expect(src).toMatch(/import\s*\{[^}]*savedRemovalAnnouncement[^}]*\}\s*from\s*["']@\/components\/bookmark\/bookmark-label["']/);
    expect(component).toContain("setAnnouncement(");
    expect(component).toContain("savedRemovalAnnouncement(");
  });

  it("the remove button calls handleRemove", () => {
    expect(component).toContain("onClick={() => handleRemove(row)}");
    expect(component).not.toContain("onClick={() => toggle(row.id)}");
  });

  it("handleRemove records the focus target before it toggles the bookmark", () => {
    const from = component.indexOf("function handleRemove");
    expect(from).toBeGreaterThan(-1);
    const body = component.slice(from, component.indexOf("\n  }\n", from));
    const pendingAt = body.indexOf("pendingFocus.current = focusTargetAfterRemove(");
    const announceAt = body.indexOf("setAnnouncement(");
    const toggleAt = body.indexOf("toggle(row.id)");
    expect(pendingAt).toBeGreaterThan(-1);
    expect(announceAt).toBeGreaterThan(-1);
    expect(toggleAt).toBeGreaterThan(pendingAt);
    expect(toggleAt).toBeGreaterThan(announceAt);
    // The row leaves the list at once, so focus does not wait for the RPC.
    expect(body).toContain("setRows(");
  });

  it("toggle( is called nowhere else", () => {
    expect(component.match(/\btoggle\(/g)).toHaveLength(1);
  });

  it("every JSX return path of SavedList is wrapped in SavedFrame, so the live region never remounts", () => {
    const lines = component.split("\n");
    // JSX returns of the component itself (indent <= 4: top level or one if-block
    // deep). The row callback's own return sits deeper, and `return;` / the
    // effect cleanup are not JSX.
    const jsxReturns: number[] = [];
    lines.forEach((line, i) => {
      const indent = line.length - line.trimStart().length;
      const t = line.trim();
      if (indent <= 4 && (t === "return (" || t.startsWith("return <"))) jsxReturns.push(i);
    });
    // placeholder, empty, loading and list; the failed branch returns SavedLoadFailed() (below).
    expect(jsxReturns).toHaveLength(4);
    for (const i of jsxReturns) {
      expect(`${lines[i]}\n${lines[i + 1]}`).toContain("<SavedFrame announcement={announcement}>");
    }
    expect(component.match(/<SavedFrame/g)).toHaveLength(4);
    expect(component).not.toMatch(/return null/);
  });

  it("the failed branch returns SavedLoadFailed() in the SavedFrame position of the loading branch (h30-live-1)", () => {
    const failedAt = component.indexOf("  if (failed) {");
    expect(failedAt).toBeGreaterThan(-1);
    const loadingAt = component.indexOf("  if (rows === null) {");
    expect(loadingAt).toBeGreaterThan(-1);
    // Loading comes first: the failed branch is reached from it.
    expect(failedAt).toBeGreaterThan(loadingAt);
    const body = component.slice(failedAt, component.indexOf("\n  }\n", failedAt));
    // A plain call, not <SavedLoadFailed />: the element React compares against
    // the loading branch is then a SavedFrame, the same type, so the status
    // region is updated in place and the text is announced. An element of a new
    // component type would unmount the region and mount it again with its text.
    expect(body).toContain("return SavedLoadFailed();");
    expect(body).not.toContain("<SavedLoadFailed");
    expect(body).not.toContain("<p");
    expect(body).not.toContain("<SavedFrame");
  });

  it("SavedLoadFailed itself returns the SavedFrame element, the one place the failure copy is rendered", () => {
    const failedAt = code.indexOf("export function SavedLoadFailed");
    expect(failedAt).toBeGreaterThan(-1);
    const end = code.indexOf("\n}\n", failedAt);
    const fn = code.slice(failedAt, end);
    expect(fn).toContain("<SavedFrame announcement={SAVED_LOAD_FAILED_TEXT}>");
    expect(fn).toContain('<p aria-hidden="true" className="text-sm text-muted-foreground">');
    // The declaration, the announcement and the visible paragraph: one text, one constant.
    expect(code.match(/SAVED_LOAD_FAILED_TEXT/g)).toHaveLength(3);
    expect(src).toContain('export const SAVED_LOAD_FAILED_TEXT = "Kaydedilenler yüklenemedi. Lütfen sayfayı yenileyin.";');
  });

  it("has exactly one live region (inside SavedFrame)", () => {
    expect(code.match(/role="status"/g)).toHaveLength(1);
  });

  it("declares every hook above the first early return", () => {
    const firstReturn = component.indexOf("\n  if (");
    expect(firstReturn).toBeGreaterThan(-1);
    const before = component.slice(0, firstReturn);
    for (const hook of ["useState(", "useRef(", "useEffect(", "useMemo(", "useBookmarks(", "useHydrated("]) {
      expect(component.lastIndexOf(hook), hook).toBeLessThan(firstReturn);
    }
    expect(before).toContain("pendingFocus");
    expect(before).toContain("linkRefs");
    expect(before).toContain("emptyHeadingRef");
  });

  it("treats a drained list as the empty state too, so focus always has a target", () => {
    expect(component).toMatch(/const emptyNow\s*=\s*count === 0 \|\| \(rows !== null && !failed && rows\.length === 0\);/);
    expect(component).toContain("<SavedEmptyState headingRef={emptyHeadingRef} />");
  });

  it("a useEffect keyed on the rendered-id signature moves focus", () => {
    const keyedAt = component.indexOf("}, [shownSig]);");
    expect(keyedAt).toBeGreaterThan(-1);
    const effectAt = component.lastIndexOf("useEffect(", keyedAt);
    expect(effectAt).toBeGreaterThan(-1);
    const effect = component.slice(effectAt, keyedAt);
    expect(effect).toContain("pendingFocus.current");
    expect(effect).toContain("linkRefs.current.get(");
    expect(effect).toContain("emptyHeadingRef.current");
    expect(effect).toContain(".focus()");
    // The pending target is consumed before it is used, so it fires once.
    expect(effect.indexOf("pendingFocus.current = undefined")).toBeGreaterThan(-1);
    expect(effect.indexOf("pendingFocus.current = undefined")).toBeLessThan(effect.indexOf(".focus()"));
  });

  it("derives the signature from the shown ids, a loading marker and the empty state", () => {
    expect(component).toContain(
      'const shownSig = emptyNow ? "" : rows === null ? "\\u0000loading" : rows.map((r) => r.id).join("\\n");',
    );
  });

  it("registers each row link in the ref map with a callback ref", () => {
    expect(component).toMatch(/ref=\{\(el\) => \{\s*if \(el\) linkRefs\.current\.set\(row\.id, el\);\s*else linkRefs\.current\.delete\(row\.id\);\s*\}\}/);
  });

  it("the empty heading takes the ref and is script-focusable", () => {
    const emptyAt = code.indexOf("export function SavedEmptyState");
    const emptyEnd = code.indexOf("export function SavedList");
    const emptyState = code.slice(emptyAt, emptyEnd);
    expect(emptyState).toContain("ref={headingRef}");
    expect(emptyState).toContain("tabIndex={-1}");
    expect(emptyState).not.toContain("<Link");
    expect(emptyState).not.toContain("<button");
  });

  it("SavedFrame holds no link or button either", () => {
    const frameAt = code.indexOf("export function SavedFrame");
    const frameEnd = code.indexOf("export function SavedEmptyState");
    const frame = code.slice(frameAt, frameEnd);
    expect(frameAt).toBeGreaterThan(-1);
    expect(frame).not.toContain("<Link");
    expect(frame).not.toContain("<button");
  });
});
