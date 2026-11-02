import { describe, it, expect, vi } from "vitest";

import { isShareAbort as dailyIsShareAbort } from "@/lib/game/daily-share";
import { isShareAbort, runNativeShare } from "./native-share";

const DATA: ShareData = { title: "Başlık", url: "https://tayf.test/cluster/x" };

describe("runNativeShare", () => {
  it("is 'shared' when the share resolves, and passes the data through", async () => {
    const shareFn = vi.fn(async (_d: ShareData) => {});
    expect(await runNativeShare(shareFn, DATA)).toBe("shared");
    expect(shareFn).toHaveBeenCalledTimes(1);
    expect(shareFn).toHaveBeenCalledWith(DATA);
  });

  it("is 'aborted' for a DOMException AbortError (the reader dismissed the sheet)", async () => {
    const shareFn = async () => {
      throw new DOMException("x", "AbortError");
    };
    expect(await runNativeShare(shareFn, DATA)).toBe("aborted");
  });

  it("is 'aborted' for any rejection carrying name AbortError", async () => {
    const shareFn = () => Promise.reject({ name: "AbortError" });
    expect(await runNativeShare(shareFn, DATA)).toBe("aborted");
  });

  it("is 'fallback' for a NotAllowedError rejection", async () => {
    const shareFn = async () => {
      throw new DOMException("denied", "NotAllowedError");
    };
    expect(await runNativeShare(shareFn, DATA)).toBe("fallback");
  });

  it("is 'fallback' for a plain Error rejection", async () => {
    const shareFn = async () => {
      throw new Error("boom");
    };
    expect(await runNativeShare(shareFn, DATA)).toBe("fallback");
  });

  it("is 'fallback' for a non-object rejection", async () => {
    expect(await runNativeShare(() => Promise.reject("nope"), DATA)).toBe("fallback");
    expect(await runNativeShare(() => Promise.reject(null), DATA)).toBe("fallback");
  });

  it("catches a synchronous throw as well (fallback, not an unhandled throw)", async () => {
    const shareFn = (): Promise<void> => {
      throw new Error("sync");
    };
    expect(await runNativeShare(shareFn, DATA)).toBe("fallback");
  });

  it("treats a synchronous AbortError throw as 'aborted'", async () => {
    const shareFn = (): Promise<void> => {
      throw new DOMException("x", "AbortError");
    };
    expect(await runNativeShare(shareFn, DATA)).toBe("aborted");
  });

  it("is 'fallback' when there is no share function", async () => {
    expect(await runNativeShare(undefined, DATA)).toBe("fallback");
  });
});

describe("isShareAbort", () => {
  it("is true only for an object named AbortError", () => {
    expect(isShareAbort(new DOMException("x", "AbortError"))).toBe(true);
    expect(isShareAbort({ name: "AbortError" })).toBe(true);
    expect(isShareAbort({ name: "NotAllowedError" })).toBe(false);
    expect(isShareAbort(new Error("AbortError"))).toBe(false);
    expect(isShareAbort(null)).toBe(false);
    expect(isShareAbort(undefined)).toBe(false);
    expect(isShareAbort("AbortError")).toBe(false);
  });

  it("is the very same function daily-share re-exports (one rule, two callers)", () => {
    expect(dailyIsShareAbort).toBe(isShareAbort);
  });
});
