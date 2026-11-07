import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchBar } from "./search-bar";
import { isSearchBarActive } from "./search-shortcut";

// A tiny hook runtime so the real SearchBar can run in the node environment
// (no jsdom in this repo): useState / useRef / useEffect keep their values in
// slots between renders, effects run after each render when their deps changed
// (cleanups first), and a setState re-renders until the component settles.
// The router, the search params and the analytics call are fakes.
const rt = vi.hoisted(() => {
  interface Slot {
    inited?: boolean;
    value?: unknown;
    ref?: { current: unknown };
    deps?: readonly unknown[];
    cleanup?: unknown;
  }
  interface Pending {
    slot: Slot;
    create: () => unknown;
    deps: readonly unknown[] | undefined;
  }
  const state = {
    slots: [] as Slot[],
    cursor: 0,
    dirty: false,
    queue: [] as Pending[],
    params: new URLSearchParams(""),
    replace: vi.fn(),
    track: vi.fn(),
    nextSlot(): Slot {
      const slot = (state.slots[state.cursor] ??= {});
      state.cursor += 1;
      return slot;
    },
  };
  return state;
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useId: () => "search-id",
    startTransition: (fn: () => void) => fn(),
    useState: <T>(init: T | (() => T)) => {
      const slot = rt.nextSlot();
      if (!slot.inited) {
        slot.inited = true;
        slot.value = typeof init === "function" ? (init as () => T)() : init;
      }
      const set = (next: T) => {
        if (!Object.is(next, slot.value)) {
          slot.value = next;
          rt.dirty = true;
        }
      };
      return [slot.value as T, set] as const;
    },
    useRef: <T>(init: T) => {
      const slot = rt.nextSlot();
      slot.ref ??= { current: init };
      return slot.ref as { current: T };
    },
    useEffect: (create: () => unknown, deps?: readonly unknown[]) => {
      const slot = rt.nextSlot();
      const prev = slot.deps;
      const changed =
        deps === undefined ||
        prev === undefined ||
        deps.length !== prev.length ||
        deps.some((d, i) => !Object.is(d, prev[i]));
      if (changed) rt.queue.push({ slot, create, deps });
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: rt.replace }),
  usePathname: () => "/",
  useSearchParams: () => rt.params,
}));

vi.mock("@/lib/track", () => ({ track: rt.track }));

// h60-forms-1: SearchBar seeded `value` from ?q only once, so an in-app
// navigation back to "/" (header logo, "Haberler", "Aramayı temizle", g h)
// kept the stale text and the debounced effect wrote ?q=<old query> straight
// back (pushState('/') then replaceState('/?q=tutuklama') 0.4 to 0.9 s later).
// The URL is now the source of truth whenever it changes from outside the
// component. Effects need a browser, so these are source pins on the
// comment-blanked file; the real-browser check is in the wave report.

const src = readFileSync(join(__dirname, "search-bar.tsx"), "utf8");

/** Blanks block and line comments (a `//` after `:` is a URL, not a comment). */
function blankComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

const code = blankComments(src);

/** The text of every useEffect(...) call, each running up to the next one. */
function effectBlocks(text: string): string[] {
  return text.split("useEffect(").slice(1);
}

/** The dependency array source of an effect block (first `}, [ ... ])`). */
function depsOf(block: string): string {
  return /\},\s*\[([^\]]*)\]\s*\)/.exec(block)?.[1] ?? "";
}

const externalEffect = effectBlocks(code).find((b) => b.includes("externalQueryChange("));
const debounceEffect = effectBlocks(code).find((b) => b.includes("router.replace("));

describe("search-bar.tsx: the URL wins when it changes from outside", () => {
  it("imports externalQueryChange next to searchNavTarget", () => {
    expect(code).toMatch(
      /import \{[^}]*\bexternalQueryChange\b[^}]*\} from "\.\/search-nav";/,
    );
    expect(code).toMatch(/import \{[^}]*\bsearchNavTarget\b[^}]*\} from "\.\/search-nav";/);
  });

  it("keeps the last value it wrote in a ref seeded from ?q", () => {
    expect(code).toContain('const lastWrittenRef = useRef(searchParams.get("q") ?? "");');
  });

  it("calls externalQueryChange inside a useEffect that depends on searchParams", () => {
    expect(externalEffect).toBeDefined();
    expect(depsOf(externalEffect ?? "")).toMatch(/\bsearchParams\b/);
  });

  it("feeds it the current ?q and the ref, and adopts a non-null result", () => {
    const e = externalEffect ?? "";
    expect(e).toContain('const urlQ = searchParams.get("q") ?? "";');
    expect(e).toMatch(
      /externalQueryChange\(\{\s*urlQ,\s*lastWritten:\s*lastWrittenRef\.current\s*\}\)/,
    );
    expect(e).toMatch(/if \(next === null\) return;/);
    expect(e).toContain("lastWrittenRef.current = next;");
    expect(e).toContain("setValue(next);");
  });

  it("resets the one-search-event latch to match the adopted value", () => {
    expect(externalEffect ?? "").toContain("searchedRef.current = next.trim().length > 0;");
  });

  it("returns early in the debounced callback when the URL already reflects the value", () => {
    const d = debounceEffect ?? "";
    const early = d.indexOf("if (value.trim() === lastWrittenRef.current.trim()) return;");
    expect(early).toBeGreaterThan(-1);
    // before the analytics rule and before any navigation work
    expect(early).toBeLessThan(d.indexOf('track("search")'));
    expect(early).toBeLessThan(d.indexOf("searchNavTarget("));
  });

  it("records what it wrote after computing the target and before router.replace", () => {
    const d = debounceEffect ?? "";
    const target = d.indexOf("searchNavTarget(");
    const assign = d.indexOf("lastWrittenRef.current = q;");
    const replace = d.indexOf("router.replace(");
    expect(target).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(target);
    expect(replace).toBeGreaterThan(assign);
  });

  it("keeps the 300 ms debounce, startTransition and the single 'search' event rule", () => {
    const d = debounceEffect ?? "";
    expect(d).toMatch(/\},\s*300\s*\)/);
    expect(d).toContain("startTransition(");
    expect(d).toContain('if (q && !searchedRef.current) track("search");');
    expect(d).toContain("searchNavTarget({ value, pathname, search: searchParams.toString() })");
    expect(depsOf(d)).toMatch(/\bvalue\b/);
  });

  it("still seeds the latch from the landing ?q (no event on landing with ?q=)", () => {
    expect(code).toContain('const searchedRef = useRef(Boolean(searchParams.get("q")));');
  });

  it("does not remount the bar with a key or navigate with router.push", () => {
    expect(code).not.toContain("router.push(");
    expect(code).not.toMatch(/\bkey=\{/);
  });
});

// h60-forms-4: "/" on a page without the bar goes to "/#ara".
describe("search-bar.tsx: arrival from the '/' shortcut on another page", () => {
  const arrivalEffect = effectBlocks(code).find((b) => b.includes("isSearchArrivalHash("));

  it("puts id=\"ara\" on the role=search wrapper", () => {
    const at = code.indexOf('role="search"');
    expect(at).toBeGreaterThan(-1);
    const open = code.lastIndexOf("<div", at);
    const tag = code.slice(open, code.indexOf(">", at));
    expect(tag).toContain('id="ara"');
  });

  it("imports isSearchArrivalHash from ./search-shortcut", () => {
    expect(code).toMatch(/import \{ isSearchArrivalHash \} from "\.\/search-shortcut";/);
    // the guard in tests/guards/search-announce.test.ts pins this exact line too
    expect(code).toMatch(/import \{ isSearchShortcut \} from "\.\/search-shortcut";/);
  });

  it("runs once on mount: no dependencies", () => {
    expect(arrivalEffect).toBeDefined();
    expect(depsOf(arrivalEffect ?? "")).toBe("");
    expect(arrivalEffect ?? "").toMatch(/\},\s*\[\]\s*\)/);
  });

  it("focuses the input, then strips the hash without adding a history entry", () => {
    const e = arrivalEffect ?? "";
    expect(e).toContain("isSearchArrivalHash(window.location.hash)");
    const focus = e.indexOf("inputRef.current?.focus()");
    // null, not window.history.state: Next's patched replaceState passes an
    // entry that carries __NA straight through and skips syncing canonicalUrl.
    const strip = e.search(
      /window\.history\.replaceState\(\s*null,\s*"",\s*window\.location\.pathname \+ window\.location\.search,?\s*\)/,
    );
    expect(focus).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(focus);
    expect(e).not.toContain("pushState");
  });
});

// ---------------------------------------------------------------------------
// Behaviour: the real component driven through the hook runtime above.
// ---------------------------------------------------------------------------

interface ElementLike {
  type?: unknown;
  props?: {
    children?: unknown;
    value?: unknown;
    ref?: unknown;
    onChange?: (e: unknown) => void;
  };
}

let tree: unknown;

/** Re-renders until no state update is pending, running effects after each pass. */
function render(): void {
  for (let pass = 0; pass < 25; pass++) {
    rt.cursor = 0;
    rt.dirty = false;
    tree = SearchBar();
    attachInputRef();
    const batch = rt.queue.splice(0);
    for (const e of batch) {
      if (typeof e.slot.cleanup === "function") (e.slot.cleanup as () => void)();
      e.slot.cleanup = undefined;
    }
    for (const e of batch) {
      e.slot.deps = e.deps;
      e.slot.cleanup = e.create();
    }
    if (!rt.dirty) return;
  }
  throw new Error("SearchBar did not settle");
}

/** What React does on commit: point the input's ref at the (fake) DOM node. */
function attachInputRef(): void {
  const ref = findInput(tree)?.props?.ref;
  if (ref && typeof ref === "object") (ref as { current: unknown }).current = fakeInput;
}

function findInput(node: unknown): ElementLike | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findInput(child);
      if (hit) return hit;
    }
    return null;
  }
  if (node === null || typeof node !== "object") return null;
  const el = node as ElementLike;
  if (el.type === "input") return el;
  return findInput(el.props?.children);
}

function inputValue(): unknown {
  return findInput(tree)?.props?.value;
}

function type(text: string): void {
  const input = findInput(tree);
  if (!input?.props?.onChange) throw new Error("no input.onChange");
  input.props.onChange({ target: { value: text } });
  render();
}

/** The URL changes from outside the component (link click, g h, Back/forward). */
function externalNav(search: string): void {
  rt.params = new URLSearchParams(search);
  render();
}

function mount(search: string): void {
  rt.params = new URLSearchParams(search);
  render();
}

const fakeInput = { focus: vi.fn() };
const historyState = { __NA: true };
const fakeWindow = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  location: { hash: "", pathname: "/", search: "" },
  history: { state: historyState as unknown, replaceState: vi.fn() },
};

beforeEach(() => {
  vi.useFakeTimers();
  fakeWindow.addEventListener.mockReset();
  fakeWindow.removeEventListener.mockReset();
  fakeWindow.history.replaceState.mockReset();
  fakeWindow.history.state = historyState;
  fakeWindow.location.hash = "";
  fakeWindow.location.pathname = "/";
  fakeWindow.location.search = "";
  fakeInput.focus.mockReset();
  vi.stubGlobal("window", fakeWindow);
  rt.slots.length = 0;
  rt.queue.length = 0;
  rt.cursor = 0;
  rt.replace.mockReset();
  rt.track.mockReset();
  // The router lands the replace at once, like a finished navigation.
  rt.replace.mockImplementation((target: string) => {
    const at = target.indexOf("?");
    externalNavFromReplace(at === -1 ? "" : target.slice(at + 1));
  });
});

/** A router.replace that the bar itself issued lands in the URL. */
function externalNavFromReplace(search: string): void {
  rt.params = new URLSearchParams(search);
  render();
}

afterEach(() => {
  for (const slot of rt.slots) {
    if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SearchBar behaviour: in-app navigation back to '/' sticks", () => {
  it("clears the input and never writes the old query back after the header logo", () => {
    mount("q=tutuklama");
    vi.advanceTimersByTime(1000);
    expect(inputValue()).toBe("tutuklama");
    expect(rt.replace).not.toHaveBeenCalled();

    externalNav(""); // logo / 'Haberler' / 'Aramayı temizle' / g h land on '/'
    expect(inputValue()).toBe("");
    vi.advanceTimersByTime(2000);
    expect(rt.replace).not.toHaveBeenCalled();
    expect(inputValue()).toBe("");
  });

  it("keeps a search it wrote itself, then lets the same logo click clear it", () => {
    mount("");
    type("tutuklama");
    vi.advanceTimersByTime(300);
    expect(rt.replace).toHaveBeenCalledTimes(1);
    expect(rt.replace.mock.calls[0]?.[0]).toBe("/?q=tutuklama");
    vi.advanceTimersByTime(2000);
    expect(inputValue()).toBe("tutuklama");
    expect(rt.replace).toHaveBeenCalledTimes(1);

    externalNav("");
    expect(inputValue()).toBe("");
    vi.advanceTimersByTime(2000);
    expect(rt.replace).toHaveBeenCalledTimes(1);
  });

  it("follows Back/forward to a different query without navigating", () => {
    mount("q=ab");
    externalNav("q=a");
    expect(inputValue()).toBe("a");
    vi.advanceTimersByTime(2000);
    expect(rt.replace).not.toHaveBeenCalled();
  });

  it("follows a link to a search from an empty bar", () => {
    mount("");
    externalNav("q=se%C3%A7im");
    expect(inputValue()).toBe("seçim");
    vi.advanceTimersByTime(2000);
    expect(rt.replace).not.toHaveBeenCalled();
  });

  it("lets the reader type again right after the bar was cleared from outside", () => {
    mount("q=tutuklama");
    externalNav("");
    type("seçim");
    vi.advanceTimersByTime(299);
    expect(rt.replace).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rt.replace).toHaveBeenCalledTimes(1);
    expect(rt.replace.mock.calls[0]?.[0]).toBe("/?q=se%C3%A7im");
  });
});

describe("SearchBar behaviour: typing still debounces into ?q=", () => {
  it("writes ?q= once, after 300 ms, with the Turkish text encoded", () => {
    mount("");
    type("seçim");
    vi.advanceTimersByTime(299);
    expect(rt.replace).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rt.replace).toHaveBeenCalledTimes(1);
    expect(rt.replace.mock.calls[0]?.[0]).toBe("/?q=se%C3%A7im");
    expect(rt.replace.mock.calls[0]?.[1]).toEqual({ scroll: false });
    vi.advanceTimersByTime(3000);
    expect(rt.replace).toHaveBeenCalledTimes(1);
  });

  it("restarts the wait on every keystroke and writes only the last text", () => {
    mount("");
    type("s");
    vi.advanceTimersByTime(200);
    type("se");
    vi.advanceTimersByTime(200);
    type("seç");
    vi.advanceTimersByTime(300);
    expect(rt.replace).toHaveBeenCalledTimes(1);
    expect(rt.replace.mock.calls[0]?.[0]).toBe("/?q=se%C3%A7");
  });

  it("writes the bare path when the reader erases a search", () => {
    mount("q=abc");
    type("");
    vi.advanceTimersByTime(300);
    expect(rt.replace).toHaveBeenCalledTimes(1);
    expect(rt.replace.mock.calls[0]?.[0]).toBe("/");
  });

  it("does not navigate for a whitespace-only edit", () => {
    mount("");
    type("   ");
    vi.advanceTimersByTime(2000);
    expect(rt.replace).not.toHaveBeenCalled();
  });

  it("does not navigate or track when it merely lands on ?q=", () => {
    mount("q=abc");
    vi.advanceTimersByTime(2000);
    expect(rt.replace).not.toHaveBeenCalled();
    expect(rt.track).not.toHaveBeenCalled();
  });
});

describe("SearchBar behaviour: one 'search' event per empty to non-empty transition", () => {
  it("tracks once for a typed search, not again for its own URL update or a refinement", () => {
    mount("");
    type("seçim");
    vi.advanceTimersByTime(300);
    vi.advanceTimersByTime(3000);
    expect(rt.track).toHaveBeenCalledTimes(1);
    expect(rt.track).toHaveBeenCalledWith("search");
    type("seçim 2023");
    vi.advanceTimersByTime(300);
    expect(rt.track).toHaveBeenCalledTimes(1);
  });

  it("does not track the URL being cleared or adopted from outside", () => {
    mount("q=abc");
    externalNav("");
    externalNav("q=xyz");
    vi.advanceTimersByTime(3000);
    expect(rt.track).not.toHaveBeenCalled();
  });

  it("tracks again when the reader starts a new search after an outside clear", () => {
    mount("");
    type("abc");
    vi.advanceTimersByTime(300);
    expect(rt.track).toHaveBeenCalledTimes(1);
    externalNav("");
    type("def");
    vi.advanceTimersByTime(300);
    expect(rt.track).toHaveBeenCalledTimes(2);
  });
});

// react-kbd-activity-hidden-searchbar: while Next keeps the home page hidden in
// <Activity>, its effects are cleaned up but its DOM (including this input)
// stays. KbdShortcuts must know the bar is NOT listening, so the mounted state
// is reported through a registry that the effect cleanup releases.
describe("SearchBar behaviour: reports whether it is listening for '/'", () => {
  it("is active after mount", () => {
    mount("");
    expect(isSearchBarActive()).toBe(true);
  });

  it("is inactive once its effects are cleaned up (Activity hide), like an unmount", () => {
    mount("");
    expect(isSearchBarActive()).toBe(true);
    for (const slot of rt.slots) {
      if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
    }
    expect(isSearchBarActive()).toBe(false);
  });

  it("registers in the same effect that adds the keydown listener, and removes it in the cleanup", () => {
    mount("");
    expect(fakeWindow.addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    for (const slot of rt.slots) {
      if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
    }
    expect(fakeWindow.removeEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(isSearchBarActive()).toBe(false);
  });

  it("stays active across re-renders (typing does not release the registration)", () => {
    mount("");
    type("seçim");
    vi.advanceTimersByTime(2000);
    expect(isSearchBarActive()).toBe(true);
  });
});

describe("SearchBar behaviour: arriving from the '/' shortcut (#ara)", () => {
  it("focuses the input and strips the hash, keeping the path and query", () => {
    fakeWindow.location.hash = "#ara";
    fakeWindow.location.pathname = "/";
    fakeWindow.location.search = "?q=abc";
    mount("q=abc");
    expect(fakeInput.focus).toHaveBeenCalledTimes(1);
    expect(fakeWindow.history.replaceState).toHaveBeenCalledTimes(1);
    const [state, unused, url] = fakeWindow.history.replaceState.mock.calls[0] ?? [];
    // null lets Next copy its own tree into the entry and sync canonicalUrl;
    // history.state carries __NA and would bypass that sync.
    expect(state).toBeNull();
    expect(unused).toBe("");
    expect(url).toBe("/?q=abc");
  });

  it("strips to the bare path when there is no query", () => {
    fakeWindow.location.hash = "#ara";
    mount("");
    expect(fakeWindow.history.replaceState.mock.calls[0]?.[2]).toBe("/");
  });

  it.each(["", "#ar", "#ARA", "#ara2", "#baska"])("does nothing for hash %j", (hash) => {
    fakeWindow.location.hash = hash;
    mount("");
    expect(fakeInput.focus).not.toHaveBeenCalled();
    expect(fakeWindow.history.replaceState).not.toHaveBeenCalled();
  });

  it("does not refocus or rewrite history on later renders (typing, outside navigation)", () => {
    fakeWindow.location.hash = "#ara";
    mount("");
    type("seçim");
    externalNav("q=baska");
    vi.advanceTimersByTime(2000);
    expect(fakeInput.focus).toHaveBeenCalledTimes(1);
    expect(fakeWindow.history.replaceState).toHaveBeenCalledTimes(1);
  });

  it("does not disturb the search: no navigation and no analytics event on arrival", () => {
    fakeWindow.location.hash = "#ara";
    mount("");
    vi.advanceTimersByTime(2000);
    expect(rt.replace).not.toHaveBeenCalled();
    expect(rt.track).not.toHaveBeenCalled();
  });
});
