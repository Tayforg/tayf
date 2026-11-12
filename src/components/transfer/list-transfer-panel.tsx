"use client";

import { useId, useState } from "react";

import { importBookmarkIds, useBookmarks } from "@/components/bookmark/use-bookmarks";
import { SAVED_MAX_IDS } from "@/components/bookmark/saved-lookup";
import { followsStore, useFollows } from "@/components/follow/use-follows";
import type { Follow, FollowKind } from "@/lib/follows/follows";

import {
  buildTransferCode,
  EXPORT_BUTTON_TEXT,
  EXPORT_CODE_LABEL,
  EXPORT_EMPTY_TEXT,
  exportSummaryText,
  IMPORT_BUTTON_TEXT,
  IMPORT_HINT_TEXT,
  IMPORT_LABEL_TEXT,
  importErrorText,
  importSummaryText,
  parseTransferCode,
  TRANSFER_INTRO_TEXT,
  TRANSFER_SUMMARY_TEXT,
  type ImportCounts,
} from "./list-transfer";

// "Başka bir tarayıcıya taşı": a closed <details> above the client list on /saved
// and /takip. Export builds the code and copies it; import checks a pasted code
// strictly and merges it into this browser's two stores (adds what is missing,
// removes nothing, stays within the caps).
//
// The code path makes no network request: it imports no analytics module (so not
// the share button either, which pulls one in) and no server client, and it never
// calls the bookmark toggle (that one loads a snapshot and asks the service worker
// to pin the page). list-transfer-panel.test.tsx guards all of it.
//
// Layout: the <details> is uncontrolled, closed, and nothing in the closed markup
// depends on the stores, so the server markup and the first client render are the
// same and there is no shift above the hydrating list.

const BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-border/60 px-3 py-1.5 text-sm touch-manipulation hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Clipboard write. Resolves false when the browser refuses (no permission, insecure context). */
async function copyText(v: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(v);
    return true;
  } catch {
    return false;
  }
}

type ImportStoreResult = ImportCounts & { stored: boolean };

/**
 * The click handler of "Dışa aktar", without React. When both lists are empty it
 * says so and copies nothing. Otherwise `copy` is called ONCE and with no await
 * before it: Safari only allows a clipboard write inside the click gesture.
 */
export async function runExport(deps: {
  readBookmarks(): readonly unknown[];
  readFollows(): ReadonlyArray<Pick<Follow, "kind" | "value">>;
  copy(text: string): Promise<boolean>;
}): Promise<{ code: string | null; status: string }> {
  const built = buildTransferCode(deps.readBookmarks(), deps.readFollows());
  if (built.saved === 0 && built.follows === 0) {
    return { code: null, status: EXPORT_EMPTY_TEXT };
  }
  let copied = false;
  try {
    copied = await deps.copy(built.code);
  } catch {
    copied = false;
  }
  return { code: built.code, status: exportSummaryText(built, copied) };
}

/**
 * The click handler of "İçe aktar", without React. A code that does not parse is
 * refused whole and no store is called. Otherwise both stores are called
 * (bookmarks first) and the input is cleared only when both wrote.
 */
export function runImport(
  text: string,
  deps: {
    importBookmarks(ids: readonly string[]): ImportStoreResult;
    importFollows(follows: readonly { kind: FollowKind; value: string }[]): ImportStoreResult;
  },
): { status: string; invalid: boolean; clearInput: boolean } {
  const parsed = parseTransferCode(text);
  if (!parsed.ok) {
    return { status: importErrorText(parsed.reason), invalid: true, clearInput: false };
  }
  const bookmarks = deps.importBookmarks(parsed.payload.saved);
  const follows = deps.importFollows(parsed.payload.follows);
  const stored = bookmarks.stored && follows.stored;
  return {
    status: importSummaryText({ saved: bookmarks, follows, stored }),
    invalid: false,
    clearInput: stored,
  };
}

export function ListTransferView({
  code,
  input,
  status,
  invalid,
  onExport,
  onImport,
  onInput,
}: {
  code: string | null;
  input: string;
  status: string;
  invalid: boolean;
  onExport: () => void;
  onImport: () => void;
  onInput: (value: string) => void;
}) {
  const inputId = useId();
  const hintId = useId();
  const statusId = useId();

  return (
    <details className="mb-4 rounded-lg border border-border/60 bg-card/40">
      <summary className="cursor-pointer select-none rounded-lg px-3 py-3 text-[12px] leading-5 text-muted-foreground hover:text-foreground touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {TRANSFER_SUMMARY_TEXT}
      </summary>
      <div className="space-y-4 border-t border-border/60 p-3 text-sm">
        <p className="text-xs text-muted-foreground">{TRANSFER_INTRO_TEXT}</p>
        <div className="space-y-2">
          <button type="button" className={BUTTON_CLASS} onClick={onExport}>
            {EXPORT_BUTTON_TEXT}
          </button>
          {code !== null ? (
            <textarea
              readOnly
              aria-label={EXPORT_CODE_LABEL}
              rows={3}
              spellCheck={false}
              value={code}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-md border border-input bg-muted/30 p-2 font-mono text-[11px] text-foreground"
            />
          ) : null}
        </div>
        <div className="space-y-2">
          <label htmlFor={inputId} className="block text-xs font-medium">
            {IMPORT_LABEL_TEXT}
          </label>
          <p id={hintId} className="text-xs text-muted-foreground">
            {IMPORT_HINT_TEXT}
          </p>
          {/* No maxLength: it would cut the paste silently and turn "too long" into "unreadable".
              text-base on phones: an editable field under 16 px makes iOS Safari zoom the page on focus
              (tests/guards/input-font-size.test.ts). */}
          <textarea
            id={inputId}
            rows={3}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            aria-invalid={invalid || undefined}
            aria-describedby={`${hintId} ${statusId}`}
            value={input}
            onChange={(e) => onInput(e.target.value)}
            className="w-full rounded-md border border-input bg-background p-2 font-mono text-base sm:text-[11px] text-foreground"
          />
          <button type="button" className={BUTTON_CLASS} onClick={onImport}>
            {IMPORT_BUTTON_TEXT}
          </button>
          <p
            id={statusId}
            role="status"
            aria-live="polite"
            className={invalid ? "min-h-5 text-xs text-destructive" : "min-h-5 text-xs text-muted-foreground"}
          >
            {status}
          </p>
        </div>
      </div>
    </details>
  );
}

export function ListTransferPanel() {
  const { ids } = useBookmarks();
  const { follows } = useFollows();
  const [code, setCode] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");
  const [invalid, setInvalid] = useState(false);

  const onExport = () => {
    void runExport({
      readBookmarks: () => Array.from(ids),
      readFollows: () => follows,
      copy: copyText,
    }).then((result) => {
      setCode(result.code);
      setStatus(result.status);
      setInvalid(false);
    });
  };

  const onImport = () => {
    const result = runImport(input, {
      importBookmarks: (x) => importBookmarkIds(x, SAVED_MAX_IDS),
      importFollows: (x) => followsStore.importMany(x),
    });
    setStatus(result.status);
    setInvalid(result.invalid);
    if (result.clearInput) setInput("");
  };

  return (
    <ListTransferView
      code={code}
      input={input}
      status={status}
      invalid={invalid}
      onExport={onExport}
      onImport={onImport}
      onInput={setInput}
    />
  );
}
