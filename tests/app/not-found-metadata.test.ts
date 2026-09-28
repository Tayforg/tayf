import { describe, it, expect } from "vitest";
import { metadata } from "@/app/not-found";

describe("app/not-found.tsx metadata", () => {
  it("is noindex, has no homepage canonical and no og:url claiming the homepage", () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBeNull();
    const og = metadata.openGraph as Record<string, unknown> | undefined;
    expect(og?.url).toBeUndefined();
  });

  it("carries the Turkish not-found title", () => {
    expect(metadata.title).toBe("Sayfa bulunamadı");
  });
});
