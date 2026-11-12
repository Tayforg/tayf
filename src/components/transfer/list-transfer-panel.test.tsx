import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SAVED_MAX_IDS } from "@/components/bookmark/saved-lookup";
import type { FollowKind } from "@/lib/follows/follows";

import {
  buildTransferCode,
  EXPORT_EMPTY_TEXT,
  IMPORT_HINT_TEXT,
  IMPORT_NOT_STORED_TEXT,
  importErrorText,
  TRANSFER_MAX_CHARS,
  TRANSFER_SUMMARY_TEXT,
} from "./list-transfer";
import { ListTransferPanel, ListTransferView, runExport, runImport } from "./list-transfer-panel";

// The vitest environment is "node" (no DOM, no effects), so the panel is covered
// the way follow-feed.test.tsx covers /takip: renderToStaticMarkup for what the
// server and the first client render emit, the pure runExport / runImport for
// the click handlers, a stubbed window + localStorage for the two stores, and
// source guards for the invariants markup cannot show (no network, no heavy
// imports on the home page).

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}
const A = uuid(0xa);
const B = uuid(0xb);
const C = uuid(0xc);

const NOW = "2026-11-12T10:00:00.000Z";

/** The text of the markup, by a character walk (never a tag-stripping regex). */
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

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** The opening tag (up to its first ">") of the nearest `<tag` before `index`. */
function openTagBefore(markup: string, index: number, tag: string): string {
  const start = markup.lastIndexOf(`<${tag}`, index);
  return markup.slice(start, markup.indexOf(">", start) + 1);
}

/** The value of attribute `name` inside one opening tag, or null. */
function attr(tag: string, name: string): string | null {
  const needle = ` ${name}="`;
  const at = tag.indexOf(needle);
  if (at < 0) return null;
  const from = at + needle.length;
  return tag.slice(from, tag.indexOf('"', from));
}

/** The opening tag of every <textarea>, in document order. */
function textareaTags(markup: string): string[] {
  return markup
    .split("<textarea")
    .slice(1)
    .map((part) => `<textarea${part.slice(0, part.indexOf(">") + 1)}`);
}

function view(over: Partial<ComponentProps<typeof ListTransferView>> = {}): string {
  return renderToStaticMarkup(
    <ListTransferView
      code={null}
      input=""
      status=""
      invalid={false}
      onExport={() => {}}
      onImport={() => {}}
      onInput={() => {}}
      {...over}
    />,
  );
}

function statusTag(markup: string): string {
  return openTagBefore(markup, markup.indexOf('role="status"'), "p");
}

describe("ListTransferPanel markup", () => {
  it("ListTransferPanel renders a closed <details> (no open attribute) with summary 'Başka bir tarayıcıya taşı' and an empty status", () => {
    expect(typeof window).toBe("undefined");
    const markup = renderToStaticMarkup(<ListTransferPanel />);
    expect(markup.startsWith("<details ")).toBe(true);
    const detailsTag = markup.slice(0, markup.indexOf(">") + 1);
    expect(attr(detailsTag, "open")).toBeNull();
    expect(detailsTag.split(" ").includes("open")).toBe(false);
    expect(markup.endsWith("</details>")).toBe(true);

    const summary = markup.slice(markup.indexOf("<summary"), markup.indexOf("</summary>") + "</summary>".length);
    expect(TRANSFER_SUMMARY_TEXT).toBe("Başka bir tarayıcıya taşı");
    expect(textOf(summary)).toBe("Başka bir tarayıcıya taşı");

    // The status region is mounted and empty.
    const status = markup.slice(markup.indexOf('role="status"'));
    expect(status.slice(status.indexOf(">") + 1, status.indexOf("</p>"))).toBe("");
    // Nothing in the closed markup depends on the stores: no code box before the first export.
    expect(markup.includes("Aktarma kodu")).toBe(false);
  });

  it("the server render and the view with empty props are the same markup (no hydration difference, no shift)", () => {
    expect(renderToStaticMarkup(<ListTransferPanel />)).toBe(view());
  });

  it("exactly one role=\"status\" aria-live=\"polite\" region", () => {
    const markup = view({ status: "x" });
    expect(count(markup, 'role="status"')).toBe(1);
    expect(count(markup, 'aria-live="polite"')).toBe(1);
    expect(count(view({ code: "{}", status: "y", invalid: true }), 'role="status"')).toBe(1);
  });

  it("the import box's label for= matches the textarea id, and aria-describedby names the hint and the status", () => {
    const markup = view();
    const [importTag] = textareaTags(markup);
    expect(importTag).toBeDefined();
    const inputId = attr(importTag as string, "id");
    expect(inputId).toBeTruthy();

    const labelTag = openTagBefore(markup, markup.indexOf("<label"), "label");
    expect(attr(labelTag, "for")).toBe(inputId);
    expect(markup.includes("Diğer tarayıcıda oluşturduğunuz kodu yapıştırın</label>")).toBe(true);

    const hintTag = openTagBefore(markup, markup.indexOf(IMPORT_HINT_TEXT), "p");
    const hintId = attr(hintTag, "id");
    const statusId = attr(statusTag(markup), "id");
    expect(hintId).toBeTruthy();
    expect(statusId).toBeTruthy();
    expect(hintId).not.toBe(statusId);
    expect(attr(importTag as string, "aria-describedby")).toBe(`${hintId} ${statusId}`);
    expect(markup.includes(IMPORT_HINT_TEXT)).toBe(true);
  });

  it("both buttons are type=button and read 'Dışa aktar' / 'İçe aktar'", () => {
    const markup = view();
    expect(count(markup, "<button")).toBe(2);
    expect(count(markup, '<button type="button"')).toBe(2);
    expect(markup.includes(">Dışa aktar</button>")).toBe(true);
    expect(markup.includes(">İçe aktar</button>")).toBe(true);
    // Both are 44px touch targets.
    expect(count(markup, "min-h-11")).toBe(2);
  });

  it("no code box before the first export; with code set it renders a readOnly box labelled 'Aktarma kodu'; spellcheck=\"false\" appears on both boxes", () => {
    const before = view();
    expect(textareaTags(before)).toHaveLength(1);
    expect(before.includes("Aktarma kodu")).toBe(false);
    expect(count(before, 'spellCheck="false"')).toBe(1);

    const code = '{"format":"tayf-liste","v":1,"saved":[],"follows":[]}';
    const after = view({ code });
    const tags = textareaTags(after);
    expect(tags).toHaveLength(2);
    const codeTag = tags[0] as string;
    expect(attr(codeTag, "aria-label")).toBe("Aktarma kodu");
    expect(codeTag.toLowerCase().includes("readonly")).toBe(true);
    expect(tags[1]?.toLowerCase().includes("readonly")).toBe(false);
    expect(count(after, 'spellCheck="false"')).toBe(2);
    // The code is the box's content (escaped as markup).
    expect(after.includes("&quot;tayf-liste&quot;")).toBe(true);
    // The export box comes before the import label.
    expect(after.indexOf("Aktarma kodu")).toBeLessThan(after.indexOf("<label"));
  });

  it("the import box is not length-capped, has autocomplete and autocapitalize off, and shows its value", () => {
    const markup = view({ input: "yapıştırılan" });
    const tag = textareaTags(markup)[0] as string;
    expect(tag.toLowerCase().includes("maxlength")).toBe(false);
    expect(attr(tag, "autocomplete") ?? attr(tag, "autoComplete")).toBe("off");
    expect((attr(tag, "autocapitalize") ?? attr(tag, "autoCapitalize"))).toBe("off");
    expect(markup.includes("yapıştırılan</textarea>")).toBe(true);
  });

  it("invalid=true sets aria-invalid on the import box and the destructive status class", () => {
    const bad = view({ invalid: true, status: "Kod okunamadı." });
    const badInput = textareaTags(bad)[0] as string;
    expect(attr(badInput, "aria-invalid")).toBe("true");
    expect(attr(statusTag(bad), "class")).toBe("min-h-5 text-xs text-destructive");

    const good = view({ status: "ok" });
    expect(attr(textareaTags(good)[0] as string, "aria-invalid")).toBeNull();
    expect(attr(statusTag(good), "class")).toBe("min-h-5 text-xs text-muted-foreground");
  });

  it("the status text is rendered inside the live region", () => {
    const markup = view({ status: "Kod kopyalandı: 1 kayıtlı hikâye, 0 takip." });
    const from = markup.indexOf('role="status"');
    const inner = markup.slice(markup.indexOf(">", from) + 1, markup.indexOf("</p>", from));
    expect(inner).toBe("Kod kopyalandı: 1 kayıtlı hikâye, 0 takip.");
  });
});

describe("runExport", () => {
  it("runExport with empty stores returns code null and EXPORT_EMPTY_TEXT and never calls copy", async () => {
    const copy = vi.fn(async () => true);
    const result = await runExport({ readBookmarks: () => [], readFollows: () => [], copy });
    expect(result).toEqual({ code: null, status: EXPORT_EMPTY_TEXT });
    expect(copy).not.toHaveBeenCalled();
    // Only legacy, non-uuid bookmarks is as good as nothing.
    const legacy = await runExport({ readBookmarks: () => ["legacy-id", 7], readFollows: () => [], copy });
    expect(legacy).toEqual({ code: null, status: EXPORT_EMPTY_TEXT });
    expect(copy).not.toHaveBeenCalled();
  });

  it("runExport copies the code once and reports 'Kod kopyalandı: …'", async () => {
    const copy = vi.fn(async () => true);
    const result = await runExport({
      readBookmarks: () => [A, B],
      readFollows: () => [{ kind: "konu", value: "ekonomi" }],
      copy,
    });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(buildTransferCode([A, B], [{ kind: "konu", value: "ekonomi" }]).code);
    expect(copy).toHaveBeenCalledWith(result.code);
    expect(result.status).toBe("Kod kopyalandı: 2 kayıtlı hikâye, 1 takip.");
  });

  it("runExport calls copy synchronously, inside the click gesture (no await before it)", () => {
    const copy = vi.fn(async () => true);
    const pending = runExport({ readBookmarks: () => [A], readFollows: () => [], copy });
    expect(copy).toHaveBeenCalledTimes(1);
    return pending;
  });

  it("runExport with a refused clipboard keeps the code and returns the manual-copy status", async () => {
    const copy = vi.fn(async () => false);
    const result = await runExport({ readBookmarks: () => [A], readFollows: () => [], copy });
    expect(result.code).not.toBeNull();
    expect(result.status).toBe(
      "Kod oluşturuldu: 1 kayıtlı hikâye, 0 takip. Otomatik kopyalanamadı — kutudaki metni seçip kopyalayın.",
    );
    // A copy that rejects is a refused copy, not a crash.
    const rejecting = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    const again = await runExport({ readBookmarks: () => [A], readFollows: () => [], copy: rejecting });
    expect(again.code).toBe(result.code);
    expect(again.status).toBe(result.status);
  });

  it("runExport reports the truncation when more than 1000 are saved", async () => {
    const ids = Array.from({ length: SAVED_MAX_IDS + 234 }, (_, i) => uuid(i));
    const result = await runExport({
      readBookmarks: () => ids,
      readFollows: () => [{ kind: "q", value: "seçim" }, { kind: "q", value: "enflasyon" }, { kind: "q", value: "faiz oranı" }],
      copy: async () => true,
    });
    expect(result.status).toBe("Kod kopyalandı: en yeni 1.000 kayıtlı hikâye (toplam 1.234), 3 takip.");
    expect((result.code ?? "").length).toBeLessThan(TRANSFER_MAX_CHARS);
  });
});

describe("runImport", () => {
  type Counts = { added: number; existing: number; skipped: number; stored: boolean };
  const ok = (over: Partial<Counts> = {}): Counts => ({ added: 0, existing: 0, skipped: 0, stored: true, ...over });

  function deps(b: Counts = ok(), f: Counts = ok()) {
    return {
      importBookmarks: vi.fn((ids: readonly string[]) => {
        void ids;
        return b;
      }),
      importFollows: vi.fn((follows: readonly { kind: string; value: string }[]) => {
        void follows;
        return f;
      }),
    };
  }

  it("runImport with malformed or oversized text returns invalid:true and calls no store", () => {
    const d = deps();
    const junk = runImport("bu bir kod değil", d);
    expect(junk).toEqual({ status: importErrorText("invalid"), invalid: true, clearInput: false });
    const empty = runImport("   ", d);
    expect(empty).toEqual({ status: importErrorText("empty"), invalid: true, clearInput: false });
    const big = runImport(" ".repeat(TRANSFER_MAX_CHARS + 1), d);
    expect(big).toEqual({ status: importErrorText("too-large"), invalid: true, clearInput: false });
    expect(d.importBookmarks).not.toHaveBeenCalled();
    expect(d.importFollows).not.toHaveBeenCalled();
  });

  it("runImport with a valid code passes lower-cased ids and canonical follows to the stores and clears the input", () => {
    const d = deps(ok({ added: 2 }), ok({ added: 2 }));
    const code = JSON.stringify({
      format: "tayf-liste",
      v: 1,
      saved: [A.toUpperCase(), B],
      follows: [
        { kind: "q", value: "DEVA" },
        { kind: "konu", value: "ekonomi" },
      ],
    });
    const result = runImport(code, d);
    expect(d.importBookmarks).toHaveBeenCalledTimes(1);
    expect(d.importBookmarks).toHaveBeenCalledWith([A, B]);
    expect(d.importFollows).toHaveBeenCalledTimes(1);
    expect(d.importFollows).toHaveBeenCalledWith([
      { kind: "gundem", value: "deva" },
      { kind: "konu", value: "ekonomi" },
    ]);
    // Bookmarks first.
    const bookmarkOrder = d.importBookmarks.mock.invocationCallOrder[0] as number;
    const followOrder = d.importFollows.mock.invocationCallOrder[0] as number;
    expect(bookmarkOrder).toBeLessThan(followOrder);
    expect(result).toEqual({ status: "2 hikâye ve 2 takip eklendi.", invalid: false, clearInput: true });
  });

  it("runImport says everything is already there, and still clears the input", () => {
    const d = deps(ok({ existing: 2 }), ok({ existing: 1 }));
    const result = runImport(
      JSON.stringify({ format: "tayf-liste", v: 1, saved: [A, B], follows: [{ kind: "konu", value: "spor" }] }),
      d,
    );
    expect(result).toEqual({ status: "Koddaki her şey zaten listenizde.", invalid: false, clearInput: true });
  });

  it("runImport keeps the input and returns the storage-failed text when a store reports stored:false", () => {
    const code = JSON.stringify({ format: "tayf-liste", v: 1, saved: [A], follows: [{ kind: "konu", value: "spor" }] });
    const failed = "Kaydedilemedi: tarayıcı yerel depolamaya yazmaya izin vermiyor.";
    const bookmarksFail = runImport(code, deps(ok({ added: 1, stored: false }), ok({ added: 1 })));
    expect(bookmarksFail).toEqual({ status: failed, invalid: false, clearInput: false });
    const followsFail = runImport(code, deps(ok({ added: 1 }), ok({ added: 1, stored: false })));
    expect(followsFail).toEqual({ status: failed, invalid: false, clearInput: false });
  });

  it("runImport of two empty lists says there is nothing to import", () => {
    const d = deps();
    const result = runImport(JSON.stringify({ format: "tayf-liste", v: 1, saved: [], follows: [] }), d);
    expect(result).toEqual({ status: "Kodda aktarılacak bir şey yok.", invalid: false, clearInput: true });
  });
});

// ---------------------------------------------------------------------------
// The two stores, with a stubbed window and an in-memory localStorage.
// ---------------------------------------------------------------------------

type Browser = {
  storage: Map<string, string>;
  setItem: ReturnType<typeof vi.fn>;
  getItem: ReturnType<typeof vi.fn>;
  events: (type: string) => number;
  failWrites: (on: boolean) => void;
};

function installBrowser(seed: Record<string, string> = {}): Browser {
  const storage = new Map<string, string>(Object.entries(seed));
  const win = new EventTarget();
  const counts = new Map<string, number>();
  for (const type of ["tayf:bookmarks-change", "tayf:follows-change"]) {
    win.addEventListener(type, () => counts.set(type, (counts.get(type) ?? 0) + 1));
  }
  let failWrites = false;
  const getItem = vi.fn((k: string) => (storage.has(k) ? (storage.get(k) as string) : null));
  const setItem = vi.fn((k: string, v: string) => {
    if (failWrites) throw new Error("QuotaExceededError");
    storage.set(k, v);
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", { getItem, setItem, removeItem: (k: string) => storage.delete(k) });
  return {
    storage,
    setItem,
    getItem,
    events: (type) => counts.get(type) ?? 0,
    failWrites: (on) => {
      failWrites = on;
    },
  };
}

async function loadStores() {
  vi.resetModules();
  const bookmarks = await import("@/components/bookmark/use-bookmarks");
  const follows = await import("@/components/follow/use-follows");
  return { importBookmarkIds: bookmarks.importBookmarkIds, followsStore: follows.followsStore };
}

describe("store integration", () => {
  let browser: Browser;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("importBookmarkIds merges into tayf:bookmarks and dispatches tayf:bookmarks-change once", async () => {
    browser = installBrowser({ "tayf:bookmarks": JSON.stringify([A]) });
    const { importBookmarkIds } = await loadStores();
    const result = importBookmarkIds([B, A, C], SAVED_MAX_IDS);
    expect(result).toEqual({ next: [A, B, C], added: 2, existing: 1, skipped: 0, stored: true });
    expect(JSON.parse(browser.storage.get("tayf:bookmarks") as string)).toEqual([A, B, C]);
    expect(browser.events("tayf:bookmarks-change")).toBe(1);
    expect(browser.setItem).toHaveBeenCalledTimes(1);
  });

  it("importBookmarkIds reads storage fresh, not a render snapshot", async () => {
    browser = installBrowser({ "tayf:bookmarks": JSON.stringify([A]) });
    const { importBookmarkIds } = await loadStores();
    expect(importBookmarkIds([B], SAVED_MAX_IDS).added).toBe(1);
    // Another tab saves C directly into storage; the next import must see it.
    browser.storage.set("tayf:bookmarks", JSON.stringify([A, B, C]));
    const second = importBookmarkIds([C, uuid(0xd)], SAVED_MAX_IDS);
    expect(second.existing).toBe(1);
    expect(second.added).toBe(1);
    expect(JSON.parse(browser.storage.get("tayf:bookmarks") as string)).toEqual([A, B, C, uuid(0xd)]);
  });

  it("importBookmarkIds writes nothing and dispatches nothing when every id is already saved", async () => {
    browser = installBrowser({ "tayf:bookmarks": JSON.stringify([A, B]) });
    const { importBookmarkIds } = await loadStores();
    const result = importBookmarkIds([B, A], SAVED_MAX_IDS);
    expect(result).toEqual({ next: [A, B], added: 0, existing: 2, skipped: 0, stored: true });
    expect(browser.setItem).not.toHaveBeenCalled();
    expect(browser.events("tayf:bookmarks-change")).toBe(0);
  });

  it("importBookmarkIds returns stored:false when setItem throws", async () => {
    browser = installBrowser({ "tayf:bookmarks": JSON.stringify([A]) });
    const { importBookmarkIds } = await loadStores();
    browser.failWrites(true);
    const result = importBookmarkIds([B], SAVED_MAX_IDS);
    expect(result.stored).toBe(false);
    expect(result.added).toBe(1);
    expect(JSON.parse(browser.storage.get("tayf:bookmarks") as string)).toEqual([A]);
  });

  it("importBookmarkIds never truncates a list that is already over the cap", async () => {
    const legacy = Array.from({ length: SAVED_MAX_IDS + 5 }, (_, i) => uuid(i));
    browser = installBrowser({ "tayf:bookmarks": JSON.stringify(legacy) });
    const { importBookmarkIds } = await loadStores();
    const result = importBookmarkIds([uuid(5000)], SAVED_MAX_IDS);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(browser.setItem).not.toHaveBeenCalled();
    expect(JSON.parse(browser.storage.get("tayf:bookmarks") as string)).toHaveLength(SAVED_MAX_IDS + 5);
  });

  it("followsStore.importMany applies canonical rules and dispatches tayf:follows-change", async () => {
    browser = installBrowser();
    const { followsStore } = await loadStores();
    const result = followsStore.importMany([
      { kind: "q", value: "DEVA" },
      { kind: "q", value: "Seçim" },
      { kind: "konu", value: "ekonomi" },
      { kind: "q", value: "secim" },
      { kind: "konu", value: "politika" as "konu" },
    ]);
    expect(result.added).toBe(3);
    expect(result.existing).toBe(1);
    expect(result.invalid).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.stored).toBe(true);
    const list = JSON.parse(browser.storage.get("tayf:follows") as string) as Array<Record<string, unknown>>;
    expect(list).toEqual([
      { kind: "gundem", value: "deva", addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null },
      { kind: "q", value: "Seçim", addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null },
      { kind: "konu", value: "ekonomi", addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null },
    ]);
    expect(browser.events("tayf:follows-change")).toBe(1);
    expect(followsStore.read()).toHaveLength(3);
  });

  it("followsStore.importMany takes an explicit instant, writes nothing when nothing is added and reports a refused write", async () => {
    browser = installBrowser();
    const { followsStore } = await loadStores();
    const stamp = "2026-11-01T00:00:00.000Z";
    expect(followsStore.importMany([{ kind: "konu", value: "spor" }], stamp).added).toBe(1);
    expect(followsStore.read()[0]?.addedAt).toBe(stamp);
    const writes = browser.setItem.mock.calls.length;
    const events = browser.events("tayf:follows-change");

    const again = followsStore.importMany([{ kind: "konu", value: "spor" }]);
    expect(again.added).toBe(0);
    expect(again.existing).toBe(1);
    expect(again.stored).toBe(true);
    expect(browser.setItem.mock.calls.length).toBe(writes);
    expect(browser.events("tayf:follows-change")).toBe(events);

    browser.failWrites(true);
    const refused = followsStore.importMany([{ kind: "konu", value: "dunya" }]);
    expect(refused.added).toBe(1);
    expect(refused.stored).toBe(false);
  });

  // A refused write leaves the list alive in memory only. A retry then finds
  // everything "existing", and must still not claim the items are saved.
  it("followsStore.importMany keeps reporting stored:false on a retry while writes are refused", async () => {
    browser = installBrowser();
    const { followsStore } = await loadStores();
    browser.failWrites(true);
    const first = followsStore.importMany([{ kind: "konu", value: "spor" }]);
    expect(first.added).toBe(1);
    expect(first.stored).toBe(false);
    const again = followsStore.importMany([{ kind: "konu", value: "spor" }]);
    expect(again.added).toBe(0);
    expect(again.existing).toBe(1);
    expect(again.stored).toBe(false);
    expect(browser.storage.has("tayf:follows")).toBe(false);
  });

  it("runImport of a follows-only code twice while writes are refused keeps the input and the not-stored text", async () => {
    browser = installBrowser();
    const { importBookmarkIds, followsStore } = await loadStores();
    browser.failWrites(true);
    const code = buildTransferCode([], [{ kind: "konu", value: "spor" }]).code;
    const d = {
      importBookmarks: (ids: readonly string[]) => importBookmarkIds(ids, SAVED_MAX_IDS),
      importFollows: (follows: readonly { kind: FollowKind; value: string }[]) => followsStore.importMany(follows),
    };
    const first = runImport(code, d);
    expect(first).toEqual({ status: IMPORT_NOT_STORED_TEXT, invalid: false, clearInput: false });
    const second = runImport(code, d);
    expect(second.status).toBe(IMPORT_NOT_STORED_TEXT);
    expect(second.clearInput).toBe(false);
    expect(browser.storage.has("tayf:follows")).toBe(false);
  });

  it("followsStore.importMany reports stored:true again once a write goes through", async () => {
    browser = installBrowser();
    const { followsStore } = await loadStores();
    browser.failWrites(true);
    expect(followsStore.importMany([{ kind: "konu", value: "spor" }]).stored).toBe(false);
    browser.failWrites(false);
    // A successful commit clears the memory-only state (and writes the in-memory 'spor' too).
    const fresh = followsStore.importMany([{ kind: "konu", value: "dunya" }]);
    expect(fresh.added).toBe(1);
    expect(fresh.stored).toBe(true);
    const again = followsStore.importMany([{ kind: "konu", value: "spor" }]);
    expect(again.added).toBe(0);
    expect(again.existing).toBe(1);
    expect(again.stored).toBe(true);
    const saved = JSON.parse(browser.storage.get("tayf:follows") as string) as Array<{ value: string }>;
    expect(saved.map((f) => f.value)).toEqual(["spor", "dunya"]);
  });

  it("followsStore.importMany of an empty list is stored:true even while the store is memory-only", async () => {
    browser = installBrowser();
    const { followsStore } = await loadStores();
    browser.failWrites(true);
    expect(followsStore.importMany([{ kind: "konu", value: "spor" }]).stored).toBe(false);
    const none = followsStore.importMany([]);
    expect(none.added).toBe(0);
    expect(none.stored).toBe(true);
  });

  it("importBookmarkIds keeps reporting stored:false on a retry while storage is blocked", async () => {
    browser = installBrowser();
    const { importBookmarkIds } = await loadStores();
    browser.getItem.mockImplementation(() => {
      throw new Error("SecurityError");
    });
    browser.failWrites(true);
    const first = importBookmarkIds([A], SAVED_MAX_IDS);
    expect(first.added).toBe(1);
    expect(first.stored).toBe(false);
    const second = importBookmarkIds([A], SAVED_MAX_IDS);
    expect(second.added).toBe(0);
    expect(second.existing).toBe(1);
    expect(second.stored).toBe(false);
    expect(browser.storage.has("tayf:bookmarks")).toBe(false);
  });

  it("runImport of a bookmarks-only code twice while storage is blocked keeps the input and the not-stored text", async () => {
    browser = installBrowser();
    const { importBookmarkIds, followsStore } = await loadStores();
    browser.getItem.mockImplementation(() => {
      throw new Error("SecurityError");
    });
    browser.failWrites(true);
    const code = buildTransferCode([A], []).code;
    const d = {
      importBookmarks: (ids: readonly string[]) => importBookmarkIds(ids, SAVED_MAX_IDS),
      importFollows: (follows: readonly { kind: FollowKind; value: string }[]) => followsStore.importMany(follows),
    };
    const first = runImport(code, d);
    expect(first).toEqual({ status: IMPORT_NOT_STORED_TEXT, invalid: false, clearInput: false });
    const second = runImport(code, d);
    expect(second.status).toBe(IMPORT_NOT_STORED_TEXT);
    expect(second.clearInput).toBe(false);
  });

  it("importBookmarkIds pins the quota-only case: getItem works, setItem throws, the retry is still stored:false", async () => {
    browser = installBrowser();
    const { importBookmarkIds } = await loadStores();
    browser.failWrites(true);
    expect(importBookmarkIds([A], SAVED_MAX_IDS).stored).toBe(false);
    const second = importBookmarkIds([A], SAVED_MAX_IDS);
    expect(second.stored).toBe(false);
    expect(browser.storage.has("tayf:bookmarks")).toBe(false);
  });

  it("importBookmarkIds of an empty list is stored:true, and a recovered storage reports stored:true again", async () => {
    browser = installBrowser();
    const { importBookmarkIds } = await loadStores();
    const blocked = browser.getItem.getMockImplementation();
    browser.getItem.mockImplementation(() => {
      throw new Error("SecurityError");
    });
    browser.failWrites(true);
    expect(importBookmarkIds([A], SAVED_MAX_IDS).stored).toBe(false);
    expect(importBookmarkIds([], SAVED_MAX_IDS).stored).toBe(true);

    // Storage comes back: the next read mirrors storage again, and the write lands.
    browser.getItem.mockImplementation(blocked as (k: string) => string | null);
    browser.failWrites(false);
    const recovered = importBookmarkIds([A], SAVED_MAX_IDS);
    expect(recovered.added).toBe(1);
    expect(recovered.stored).toBe(true);
    const again = importBookmarkIds([A], SAVED_MAX_IDS);
    expect(again.added).toBe(0);
    expect(again.existing).toBe(1);
    expect(again.stored).toBe(true);
  });

  it("export from storage A then import into storage B merges both lists and fetch (vi.fn stub) is never called", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    // Browser A: three saved stories and three follows.
    const a = installBrowser({
      "tayf:bookmarks": JSON.stringify([A, B, C]),
      "tayf:follows": JSON.stringify([
        { kind: "q", value: "seçim anketleri 2028", addedAt: NOW, seenAt: NOW, seenIds: [A], seenFloor: NOW },
        { kind: "gundem", value: "deva", addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null },
        { kind: "konu", value: "ekonomi", addedAt: NOW, seenAt: NOW, seenIds: null, seenFloor: null },
      ]),
    });
    const storesA = await loadStores();
    const exported = await runExport({
      readBookmarks: () => JSON.parse(a.storage.get("tayf:bookmarks") as string) as unknown[],
      readFollows: () => storesA.followsStore.read(),
      copy: async () => true,
    });
    expect(exported.code).not.toBeNull();
    expect((exported.code as string).includes("seenIds")).toBe(false);

    // Browser B: one story of its own (also in A) and one follow of its own.
    const b = installBrowser({
      "tayf:bookmarks": JSON.stringify([uuid(0x99), B]),
      "tayf:follows": JSON.stringify([
        { kind: "konu", value: "spor", addedAt: "2026-10-01T00:00:00.000Z", seenAt: null, seenIds: null, seenFloor: null },
      ]),
    });
    const storesB = await loadStores();
    const result = runImport(exported.code as string, {
      importBookmarks: (ids) => storesB.importBookmarkIds(ids, SAVED_MAX_IDS),
      importFollows: (follows) => storesB.followsStore.importMany(follows),
    });
    expect(result).toEqual({
      status: "2 hikâye ve 3 takip eklendi. Zaten listenizde olan 1 kayıt atlandı.",
      invalid: false,
      clearInput: true,
    });

    expect(JSON.parse(b.storage.get("tayf:bookmarks") as string)).toEqual([uuid(0x99), B, A, C]);
    const followsB = JSON.parse(b.storage.get("tayf:follows") as string) as Array<{ kind: string; value: string; addedAt: string; seenIds: unknown }>;
    expect(followsB.map((f) => `${f.kind}:${f.value}`)).toEqual(["konu:spor", "q:seçim anketleri 2028", "gundem:deva", "konu:ekonomi"]);
    // The old follow keeps its stamp; the imported ones start a fresh baseline now, with no seen ids.
    expect(followsB[0]?.addedAt).toBe("2026-10-01T00:00:00.000Z");
    for (const f of followsB.slice(1)) {
      expect(f.addedAt).toBe(NOW);
      expect(f.seenIds).toBeNull();
    }
    expect(fetchStub).not.toHaveBeenCalled();

    // Importing the same code again is a no-op that says so.
    const writes = b.setItem.mock.calls.length;
    const again = runImport(exported.code as string, {
      importBookmarks: (ids) => storesB.importBookmarkIds(ids, SAVED_MAX_IDS),
      importFollows: (follows) => storesB.followsStore.importMany(follows),
    });
    expect(again.status).toBe("Koddaki her şey zaten listenizde.");
    expect(b.setItem.mock.calls.length).toBe(writes);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------

const read = (...parts: string[]) => readFileSync(resolve(__dirname, "..", "..", "..", ...parts), "utf8");

describe("source guards", () => {
  it("list-transfer.ts and list-transfer-panel.tsx contain no fetch(, sendBeacon, XMLHttpRequest, WebSocket, import(, localStorage, @/lib/track or @/lib/supabase", () => {
    const forbidden = ["fetch(", "sendBeacon", "XMLHttpRequest", "WebSocket", "import(", "localStorage", "@/lib/track", "@/lib/supabase"];
    for (const file of ["list-transfer.ts", "list-transfer-panel.tsx"]) {
      const src = readFileSync(resolve(__dirname, file), "utf8");
      for (const token of forbidden) {
        expect(src.includes(token), `${file} contains ${token}`).toBe(false);
      }
    }
  });

  it("list-transfer-panel.tsx does not import share-button (it pulls in @/lib/track)", () => {
    const src = readFileSync(resolve(__dirname, "list-transfer-panel.tsx"), "utf8");
    expect(src.includes("share-button")).toBe(false);
  });

  it("carries no sentence about where the code goes or where the lists are kept (data-handling wording is founder-owned)", async () => {
    const mod = await import("./list-transfer");
    expect("TRANSFER_CODE_NOTE_TEXT" in mod).toBe(false);
    for (const file of ["list-transfer.ts", "list-transfer-panel.tsx"]) {
      const src = readFileSync(resolve(__dirname, file), "utf8");
      expect(src.includes("TRANSFER_CODE_NOTE_TEXT"), file).toBe(false);
      expect(src.includes("gönderilmez"), file).toBe(false);
      expect(src.includes("sunucusuna"), file).toBe(false);
      expect(src.includes("saklanır"), file).toBe(false);
    }
    // One intro paragraph above the buttons, and no second one about the code.
    const markup = view();
    const body = markup.slice(markup.indexOf("</summary>"), markup.indexOf(">Dışa aktar</button>"));
    expect(count(body, "<p ")).toBe(1);
    expect(textOf(markup).includes("sunucu")).toBe(false);
    expect(textOf(markup).includes("saklanır")).toBe(false);
  });

  it("use-bookmarks.ts imports nothing from @/components/transfer or @/lib/follows", () => {
    const src = read("src", "components", "bookmark", "use-bookmarks.ts");
    expect(src.includes("@/components/transfer")).toBe(false);
    expect(src.includes("@/lib/follows")).toBe(false);
    expect(src.includes("list-transfer")).toBe(false);
  });

  it("bookmark-ids.ts and follows.ts add no import for the merge helpers", () => {
    const importLines = (src: string) => src.split("\n").filter((line) => line.startsWith("import ")).length;
    expect(importLines(read("src", "components", "bookmark", "bookmark-ids.ts"))).toBe(0);
    // follows.ts keeps the two it always had (@/lib/time and the hub vocabulary).
    expect(importLines(read("src", "lib", "follows", "follows.ts"))).toBe(2);
  });

  it("the importBookmarkIds body contains neither captureSnapshot nor pinForOffline", () => {
    const src = read("src", "components", "bookmark", "use-bookmarks.ts");
    const start = src.indexOf("export function importBookmarkIds");
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body.includes("captureSnapshot")).toBe(false);
    expect(body.includes("pinForOffline")).toBe(false);
    // The reason is written down just above it.
    const above = src.slice(Math.max(0, start - 600), start);
    expect(above.includes("captureSnapshot")).toBe(true);
    expect(above.includes("pinForOffline")).toBe(true);
  });

  it("src/app/page.tsx does not reference list-transfer", () => {
    const src = read("src", "app", "page.tsx");
    expect(src.includes("list-transfer")).toBe(false);
    expect(src.includes("ListTransfer")).toBe(false);
  });

  it("/saved renders <ListTransferPanel before <SavedList; /takip before <FollowFeed", () => {
    const saved = read("src", "app", "saved", "page.tsx");
    expect(count(saved, "<ListTransferPanel")).toBe(1);
    expect(saved.indexOf("<ListTransferPanel")).toBeGreaterThan(0);
    expect(saved.indexOf("<ListTransferPanel")).toBeLessThan(saved.indexOf("<SavedList"));
    expect(saved.includes('from "@/components/transfer/list-transfer-panel"')).toBe(true);

    const takip = read("src", "app", "takip", "page.tsx");
    expect(count(takip, "<ListTransferPanel")).toBe(1);
    expect(takip.indexOf("<ListTransferPanel")).toBeGreaterThan(0);
    expect(takip.indexOf("<ListTransferPanel")).toBeLessThan(takip.indexOf("<FollowFeed"));
    expect(takip.includes('from "@/components/transfer/list-transfer-panel"')).toBe(true);
  });
});
