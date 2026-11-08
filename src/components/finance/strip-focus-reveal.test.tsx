import { describe, expect, it } from "vitest";
import { revealFocusedChip, StripFocusReveal, stripScrollDelta } from "./strip-focus-reveal";

// h65-keyboard-1: vitest runs in a plain node environment (no jsdom), so the DOM
// is faked with plain objects that carry only the members the helpers read.

type Rect = { left: number; right: number };

describe("stripScrollDelta", () => {
  const view: Rect = { left: 17, right: 1263 };

  it("is 0 for a chip fully inside the view", () => {
    expect(stripScrollDelta({ left: 100, right: 300 }, view)).toBe(0);
  });

  it("is 0 for a chip that exactly fills the view edges", () => {
    expect(stripScrollDelta({ left: 17, right: 1263 }, view)).toBe(0);
    expect(stripScrollDelta({ left: 17, right: 200 }, view)).toBe(0);
    expect(stripScrollDelta({ left: 1000, right: 1263 }, view)).toBe(0);
  });

  it("the live case, chip 1134..1279 in view 17..1263, scrolls right by 16", () => {
    expect(stripScrollDelta({ left: 1134, right: 1279 }, view)).toBe(16);
  });

  it("a chip clipped on the left gives a negative delta that brings its left edge to the view", () => {
    expect(stripScrollDelta({ left: -50, right: 100 }, view)).toBe(-67);
    expect(stripScrollDelta({ left: 16, right: 150 }, view)).toBe(-1);
  });

  it("a chip wider than the view aligns its left edge, whichever side it overflows", () => {
    const narrow: Rect = { left: 0, right: 100 };
    // Overflows the right edge only: scroll right so its left edge reaches the view.
    expect(stripScrollDelta({ left: 40, right: 190 }, narrow)).toBe(40);
    // Overflows both edges.
    expect(stripScrollDelta({ left: -20, right: 140 }, narrow)).toBe(-20);
    // Overflows the left edge only.
    expect(stripScrollDelta({ left: -10, right: 120 }, narrow)).toBe(-10);
    // Already left-aligned: nothing to do, the rest is unreachable anyway.
    expect(stripScrollDelta({ left: 0, right: 130 }, narrow)).toBe(0);
  });

  it("a sub-pixel overflow still yields its fractional delta", () => {
    expect(stripScrollDelta({ left: 1100, right: 1263.5 }, view)).toBe(0.5);
  });
});

/** A fake strip whose scrollLeft writes are recorded. rect is the border box; clientLeft/clientWidth exclude borders. */
function fakeStrip(opts: {
  left?: number;
  clientLeft?: number;
  clientWidth?: number;
  scrollLeft?: number;
  contains?: (t: unknown) => boolean;
}) {
  const left = opts.left ?? 16;
  const clientLeft = opts.clientLeft ?? 1;
  const clientWidth = opts.clientWidth ?? 1246;
  const writes: number[] = [];
  let scrollLeft = opts.scrollLeft ?? 0;
  const strip = {
    getBoundingClientRect: () => ({ left, right: left + clientWidth + 2 * clientLeft }),
    clientLeft,
    clientWidth,
    contains: opts.contains ?? (() => true),
    get scrollLeft() {
      return scrollLeft;
    },
    set scrollLeft(v: number) {
      writes.push(v);
      scrollLeft = v;
    },
  };
  return { strip: strip as unknown as HTMLElement, writes, scrollLeft: () => scrollLeft };
}

function fakeTarget(rect: Rect, matches: (sel: string) => boolean = () => true) {
  const asked: string[] = [];
  const target = {
    getBoundingClientRect: () => rect,
    matches: (sel: string) => {
      asked.push(sel);
      return matches(sel);
    },
  };
  return { target: target as unknown as EventTarget, asked };
}

describe("revealFocusedChip", () => {
  it("raises scrollLeft by the delta for a focus-visible chip clipped on the right", () => {
    const { strip, scrollLeft } = fakeStrip({ scrollLeft: 0 });
    const { target, asked } = fakeTarget({ left: 1134, right: 1279 });
    revealFocusedChip(target, strip);
    expect(scrollLeft()).toBe(16);
    expect(asked).toEqual([":focus-visible"]);
  });

  it("adds to the current scrollLeft instead of replacing it", () => {
    const { strip, scrollLeft } = fakeStrip({ scrollLeft: 240 });
    const { target } = fakeTarget({ left: 1134, right: 1279 });
    revealFocusedChip(target, strip);
    expect(scrollLeft()).toBe(256);
  });

  it("lowers scrollLeft for a focus-visible chip clipped on the left", () => {
    const { strip, scrollLeft } = fakeStrip({ scrollLeft: 300 });
    const { target } = fakeTarget({ left: -50, right: 100 });
    revealFocusedChip(target, strip);
    // view.left = 16 + clientLeft 1 = 17; 17 - (-50) = 67 to the left.
    expect(scrollLeft()).toBe(300 - 67);
  });

  it("measures the view inside the strip's border (clientLeft/clientWidth), not its border box", () => {
    // Border box 16..1264, view 17..1263. A chip at 16 is under the left border.
    const { strip, scrollLeft } = fakeStrip({ scrollLeft: 50 });
    revealFocusedChip(fakeTarget({ left: 16, right: 150 }).target, strip);
    expect(scrollLeft()).toBe(49);
    // A chip ending at 1264 is under the right border.
    const second = fakeStrip({ scrollLeft: 0 });
    revealFocusedChip(fakeTarget({ left: 1100, right: 1264 }).target, second.strip);
    expect(second.scrollLeft()).toBe(1);
  });

  it("never writes scrollLeft when the chip is already fully visible", () => {
    const { strip, writes, scrollLeft } = fakeStrip({ scrollLeft: 12 });
    revealFocusedChip(fakeTarget({ left: 200, right: 400 }).target, strip);
    expect(writes).toEqual([]);
    expect(scrollLeft()).toBe(12);
  });

  it("does nothing for a pointer focus: matches(':focus-visible') is false, so the click lands where it was aimed", () => {
    const { strip, writes, scrollLeft } = fakeStrip({ scrollLeft: 0 });
    const { target, asked } = fakeTarget({ left: 1134, right: 1279 }, () => false);
    revealFocusedChip(target, strip);
    expect(asked).toEqual([":focus-visible"]);
    expect(writes).toEqual([]);
    expect(scrollLeft()).toBe(0);
  });

  it("treats a throwing matches() (an engine without :focus-visible) as not focus-visible", () => {
    const { strip, writes, scrollLeft } = fakeStrip({ scrollLeft: 0 });
    const target = {
      getBoundingClientRect: () => ({ left: 1134, right: 1279 }),
      matches: () => {
        throw new SyntaxError("':focus-visible' is not a valid selector");
      },
    } as unknown as EventTarget;
    expect(() => revealFocusedChip(target, strip)).not.toThrow();
    expect(writes).toEqual([]);
    expect(scrollLeft()).toBe(0);
  });

  it("does nothing when the focus event target is the strip itself", () => {
    const { strip, writes } = fakeStrip({});
    // Element-like and focus-visible, and contains() is true, so only target === strip can stop the write.
    Object.assign(strip, { matches: () => true });
    revealFocusedChip(strip as unknown as EventTarget, strip);
    expect(writes).toEqual([]);
  });

  it("does nothing for a target the strip does not contain", () => {
    const { strip, writes, scrollLeft } = fakeStrip({ contains: () => false });
    revealFocusedChip(fakeTarget({ left: 1134, right: 1279 }).target, strip);
    expect(writes).toEqual([]);
    expect(scrollLeft()).toBe(0);
  });

  it("passes the target to strip.contains", () => {
    const seen: unknown[] = [];
    const { strip } = fakeStrip({
      contains: (t) => {
        seen.push(t);
        return false;
      },
    });
    const { target } = fakeTarget({ left: 1134, right: 1279 });
    revealFocusedChip(target, strip);
    expect(seen).toEqual([target]);
  });

  it("does nothing for a null target", () => {
    const { strip, writes } = fakeStrip({});
    expect(() => revealFocusedChip(null, strip)).not.toThrow();
    expect(writes).toEqual([]);
  });

  it("does nothing for a target that is not an Element (no matches / getBoundingClientRect)", () => {
    const { strip, writes } = fakeStrip({});
    expect(() => revealFocusedChip({} as unknown as EventTarget, strip)).not.toThrow();
    expect(() => revealFocusedChip({ matches: () => true } as unknown as EventTarget, strip)).not.toThrow();
    expect(writes).toEqual([]);
  });

  it("a chip wider than the view is aligned by its left edge", () => {
    const { strip, scrollLeft } = fakeStrip({ left: 0, clientLeft: 0, clientWidth: 100, scrollLeft: 0 });
    revealFocusedChip(fakeTarget({ left: 40, right: 190 }).target, strip);
    expect(scrollLeft()).toBe(40);
  });
});

describe("StripFocusReveal", () => {
  it("renders a div with the given className, the children and an onFocus handler", () => {
    const el = StripFocusReveal({ className: "x", children: "kids" }) as unknown as {
      type: unknown;
      props: { className: string; children: unknown; onFocus: unknown };
    };
    expect(el.type).toBe("div");
    expect(el.props.className).toBe("x");
    expect(el.props.children).toBe("kids");
    expect(typeof el.props.onFocus).toBe("function");
  });

  it("its onFocus reveals the focused chip inside the div (event target and currentTarget)", () => {
    const el = StripFocusReveal({ className: "x", children: null }) as unknown as {
      props: { onFocus: (e: { target: unknown; currentTarget: unknown }) => void };
    };
    const { strip, scrollLeft } = fakeStrip({ scrollLeft: 0 });
    const { target } = fakeTarget({ left: 1134, right: 1279 });
    el.props.onFocus({ target, currentTarget: strip });
    expect(scrollLeft()).toBe(16);
  });

  it("its onFocus leaves a pointer focus alone", () => {
    const el = StripFocusReveal({ className: "x", children: null }) as unknown as {
      props: { onFocus: (e: { target: unknown; currentTarget: unknown }) => void };
    };
    const { strip, writes } = fakeStrip({ scrollLeft: 0 });
    const { target } = fakeTarget({ left: 1134, right: 1279 }, () => false);
    el.props.onFocus({ target, currentTarget: strip });
    expect(writes).toEqual([]);
  });
});
