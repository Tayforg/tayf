import { describe, it, expect, vi, beforeEach } from "vitest";

const { trackMock, recordReadingClickMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  recordReadingClickMock: vi.fn(),
}));

vi.mock("@/lib/track", () => ({ track: trackMock }));
vi.mock("@/lib/diet/diet-store", () => ({ recordReadingClick: recordReadingClickMock }));

import { TrackedLink } from "./tracked-link";

// TrackedLink is a plain function component with no hooks, so it can be
// called directly (same approach as label-card.test.tsx) — its returned
// `<a>` element's onClick prop is the handler under test, invoked without
// a DOM/renderer.
describe("TrackedLink", () => {
  beforeEach(() => {
    trackMock.mockClear();
    recordReadingClickMock.mockClear();
  });

  it("calls track with the event/data, then recordReadingClick, then the caller's onClick", () => {
    const data = { zone: "iktidar" as const, kind: "member" };
    const onClick = vi.fn();
    const el = TrackedLink({ event: "outbound", data, href: "https://example.com", onClick });

    const fakeEvent = {} as React.MouseEvent<HTMLAnchorElement>;
    el.props.onClick(fakeEvent);

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith("outbound", data);
    // Same reference, not a copy — and unmutated.
    expect(trackMock.mock.calls[0]?.[1]).toBe(data);
    expect(data).toEqual({ zone: "iktidar", kind: "member" });

    expect(recordReadingClickMock).toHaveBeenCalledTimes(1);
    expect(recordReadingClickMock).toHaveBeenCalledWith("outbound", data);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(fakeEvent);

    const trackOrder = trackMock.mock.invocationCallOrder[0];
    const recordOrder = recordReadingClickMock.mock.invocationCallOrder[0];
    expect(trackOrder).toBeDefined();
    expect(recordOrder).toBeDefined();
    expect(trackOrder as number).toBeLessThan(recordOrder as number);
  });

  it("passes cta_other_side through unchanged", () => {
    const data = { zone: "muhalefet" as const };
    const el = TrackedLink({ event: "cta_other_side", data, href: "/x" });
    el.props.onClick({} as React.MouseEvent<HTMLAnchorElement>);

    expect(trackMock).toHaveBeenCalledWith("cta_other_side", data);
    expect(recordReadingClickMock).toHaveBeenCalledWith("cta_other_side", data);
  });

  it("still calls the caller's onClick even with no data", () => {
    const onClick = vi.fn();
    const el = TrackedLink({ event: "share", href: "/x", onClick });
    el.props.onClick({} as React.MouseEvent<HTMLAnchorElement>);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith("share", undefined);
  });
});
