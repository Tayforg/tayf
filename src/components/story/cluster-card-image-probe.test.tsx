import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Behavioural tests for the async intrinsic-width probe in ClusterCardImage's
// `onLoad` (the stale-result guard). The suite runs in the node environment
// with no DOM, so:
//   - next/image is mocked to a plain <img> that records the props it got, so
//     the test can pull `onLoad` out and call it with a fake <img> element;
//   - `react`'s useState is wrapped so the component's state setters are
//     spies. A server render never applies updates, so the spies are the
//     observable "did the component skip the image" signal.
// The photo is visible from the first paint (perf-1), so there is no reveal
// state: the component declares only idx, logoFailed (in that order), and the
// probe's sole outcome is advancing `idx` past an undersized candidate.
const h = vi.hoisted(() => ({
  imageProps: [] as Array<Record<string, unknown>>,
  setters: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    h.imageProps.push(props);
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const [value, set] = actual.useState(initial);
      const spy = vi.fn((next: unknown) => set(next as never));
      h.setters.push(spy);
      return [value, spy];
    },
  };
});

import { ClusterCardImage } from "./cluster-card-image";

const NEXT_IMG =
  "/_next/image?url=https%3A%2F%2Fcdn.outlet.example%2Ffoto.jpg&w=828&q=75";
const W_SRCSET = `/_next/image?url=x&w=384&q=75 384w, ${NEXT_IMG} 828w`;

/** Probe `Image` stand-in: resolves with `naturalWidth` after a microtask. */
function stubProbeImage(naturalWidth: number) {
  class FakeProbe {
    naturalWidth = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private _src = "";
    get src() {
      return this._src;
    }
    set src(value: string) {
      this._src = value;
      queueMicrotask(() => {
        this.naturalWidth = naturalWidth;
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("Image", FakeProbe);
}

/** The element next/image's onLoad receives as `currentTarget`. */
function fakeImg(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    clientWidth: 358,
    naturalWidth: 216, // density-corrected, as at DPR2
    currentSrc: NEXT_IMG,
    srcset: W_SRCSET,
    isConnected: true,
    ...overrides,
  };
}

function renderOnLoad({ withFloor = true }: { withFloor?: boolean } = {}) {
  renderToStaticMarkup(
    <ClusterCardImage
      src="https://cdn.outlet.example/foto.jpg"
      srcs={["https://cdn.outlet.example/second.jpg"]}
      alt="Test"
      width={768}
      height={576}
      minIntrinsicWidth={withFloor ? 320 : undefined}
    />,
  );
  const onLoad = h.imageProps[0]!.onLoad as (e: { currentTarget: unknown }) => void;
  const onError = h.imageProps[0]!.onError as () => void;
  const [setIdx, setLogoFailed] = [h.setters[0]!, h.setters[1]!];
  return { onLoad, onError, setIdx, setLogoFailed };
}

/** Let the probe's microtask and the `.then` continuation run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  h.imageProps.length = 0;
  h.setters.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClusterCardImage — probe stale-result guard", () => {
  it("declares exactly two state slots, idx then logoFailed (no reveal flag)", () => {
    renderOnLoad();

    expect(h.setters).toHaveLength(2);
  });

  it("keeps a 460px photo (naturalWidth reads 216 at DPR2): the probe resolves and idx stays put", async () => {
    stubProbeImage(460);
    const { onLoad, setIdx, setLogoFailed } = renderOnLoad();

    onLoad({ currentTarget: fakeImg() });
    await settle();

    expect(setIdx).not.toHaveBeenCalled();
    expect(setLogoFailed).not.toHaveBeenCalled();
  });

  it("skips a genuinely tiny image: advances the candidate exactly once", async () => {
    stubProbeImage(150);
    const { onLoad, setIdx, setLogoFailed } = renderOnLoad();

    onLoad({ currentTarget: fakeImg({ naturalWidth: 70 }) });
    await settle();

    expect(setIdx).toHaveBeenCalledTimes(1);
    const updater = setIdx.mock.calls[0]![0] as (i: number) => number;
    expect(updater(0)).toBe(1);
    expect(setLogoFailed).not.toHaveBeenCalled();
  });

  it("drops the result when the <img> was removed from the DOM mid-probe (unmount / candidate advance)", async () => {
    stubProbeImage(150);
    const { onLoad, setIdx, setLogoFailed } = renderOnLoad();
    const img = fakeImg({ naturalWidth: 70 });

    onLoad({ currentTarget: img });
    img.isConnected = false; // the keyed <Image> was unmounted while probing
    await settle();

    expect(setIdx).not.toHaveBeenCalled();
    expect(setLogoFailed).not.toHaveBeenCalled();
  });

  it("still applies the result while the <img> stays connected, as it does inside a hidden <Activity>", async () => {
    // A hidden <Activity> runs effect cleanups but keeps the host nodes in the
    // document (display:none). The probe resolving meanwhile must not be
    // discarded, or an undersized photo would stay on screen after the tree
    // is shown again.
    stubProbeImage(150);
    const { onLoad, setIdx, setLogoFailed } = renderOnLoad();
    const img = fakeImg({ naturalWidth: 70 });

    onLoad({ currentTarget: img });
    // (hide: <img> stays in the DOM, isConnected remains true)
    await settle();

    expect(img.isConnected).toBe(true);
    expect(setIdx).toHaveBeenCalledTimes(1);
    expect(setLogoFailed).not.toHaveBeenCalled();
  });

  it("does nothing, and never probes, when the element is not rendered (display:none)", async () => {
    const probeCtor = vi.fn();
    vi.stubGlobal("Image", probeCtor);
    const { onLoad, setIdx, setLogoFailed } = renderOnLoad();

    onLoad({ currentTarget: fakeImg({ clientWidth: 0 }) });
    await settle();

    expect(probeCtor).not.toHaveBeenCalled();
    expect(setIdx).not.toHaveBeenCalled();
    expect(setLogoFailed).not.toHaveBeenCalled();
  });

  it("does nothing, and never probes, when no minIntrinsicWidth was requested", async () => {
    const probeCtor = vi.fn();
    vi.stubGlobal("Image", probeCtor);
    const { onLoad, setIdx, setLogoFailed } = renderOnLoad({ withFloor: false });

    onLoad({ currentTarget: fakeImg() });
    await settle();

    expect(probeCtor).not.toHaveBeenCalled();
    expect(setIdx).not.toHaveBeenCalled();
    expect(setLogoFailed).not.toHaveBeenCalled();
  });

  it("onError only advances to the next candidate", () => {
    const { onError, setIdx, setLogoFailed } = renderOnLoad();

    onError();

    expect(setIdx).toHaveBeenCalledTimes(1);
    const updater = setIdx.mock.calls[0]![0] as (i: number) => number;
    expect(updater(0)).toBe(1);
    expect(setLogoFailed).not.toHaveBeenCalled();
  });
});
