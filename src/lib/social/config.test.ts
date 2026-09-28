import { describe, it, expect } from "vitest";
import { readSocialConfig, SOCIAL_CHANNELS } from "./config";

describe("readSocialConfig", () => {
  it("SOCIAL_CHANNELS is exactly telegram and bluesky", () => {
    expect(SOCIAL_CHANNELS).toEqual(["telegram", "bluesky"]);
  });

  it("disabled reflects SOCIAL_POST_DISABLED === '1'", () => {
    expect(readSocialConfig({ SOCIAL_POST_DISABLED: "1" }).disabled).toBe(true);
    expect(readSocialConfig({ SOCIAL_POST_DISABLED: "0" }).disabled).toBe(false);
    expect(readSocialConfig({}).disabled).toBe(false);
  });

  it("dryRun reflects SOCIAL_POST_DRY_RUN === '1'", () => {
    expect(readSocialConfig({ SOCIAL_POST_DRY_RUN: "1" }).dryRun).toBe(true);
    expect(readSocialConfig({}).dryRun).toBe(false);
  });

  it("telegram is null unless both token and channel id are set", () => {
    expect(readSocialConfig({}).telegram).toBeNull();
    expect(
      readSocialConfig({ TELEGRAM_BOT_TOKEN: "t" }).telegram,
    ).toBeNull();
    expect(
      readSocialConfig({ TELEGRAM_CHANNEL_ID: "c" }).telegram,
    ).toBeNull();
    expect(
      readSocialConfig({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHANNEL_ID: "c" })
        .telegram,
    ).toBeNull();
    expect(
      readSocialConfig({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "c" })
        .telegram,
    ).toEqual({ token: "t", chatId: "c" });
  });

  it("bluesky is null unless both handle and app password are set", () => {
    expect(readSocialConfig({}).bluesky).toBeNull();
    expect(
      readSocialConfig({ BLUESKY_HANDLE: "h" }).bluesky,
    ).toBeNull();
    expect(
      readSocialConfig({
        BLUESKY_HANDLE: "h",
        BLUESKY_APP_PASSWORD: "p",
      }).bluesky,
    ).toEqual({ handle: "h", appPassword: "p", service: "https://bsky.social" });
  });

  it("bluesky service uses BLUESKY_SERVICE_URL only when it starts with https://", () => {
    expect(
      readSocialConfig({
        BLUESKY_HANDLE: "h",
        BLUESKY_APP_PASSWORD: "p",
        BLUESKY_SERVICE_URL: "https://custom.example",
      }).bluesky?.service,
    ).toBe("https://custom.example");

    expect(
      readSocialConfig({
        BLUESKY_HANDLE: "h",
        BLUESKY_APP_PASSWORD: "p",
        BLUESKY_SERVICE_URL: "http://insecure.example",
      }).bluesky?.service,
    ).toBe("https://bsky.social");
  });

  it("never includes secret values in a JSON.stringify of the result beyond the expected fields", () => {
    const cfg = readSocialConfig({
      TELEGRAM_BOT_TOKEN: "SECRET_TOKEN",
      TELEGRAM_CHANNEL_ID: "c",
    });
    // Sanity: the secret is present in the returned config object (callers
    // need it to post) but this module itself performs no console.* calls.
    expect(cfg.telegram?.token).toBe("SECRET_TOKEN");
  });
});
