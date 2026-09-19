import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Pack E / worker E2 — SEC-07-adjacent Ekonomi follow-up: unauthenticated
// GET /admin and /admin/ekonomi must 307 to /admin/login on the wire, and
// /admin/login itself must not be part of the (protected) group (no
// redirect loop).
//
// The wire-level 307 is actually committed by src/middleware.ts (Edge,
// runs before any response commits — a cacheComponents/PPR shell can flush
// before a layout-level redirect() resolves, degrading it to a
// client-side NEXT_REDIRECT inside the streamed flight payload; see
// middleware.ts's header comment). This suite does NOT exercise
// middleware — it exercises (protected)/layout.tsx directly, mocking
// @/lib/admin/session, and only proves: requireAdminSession() is called
// exactly once and its thrown redirect digest propagates instead of being
// swallowed (defence in depth alongside the middleware and each page's own
// call), plus that the route-group directory layout is the one that keeps
// /admin/login outside the protected group.
// ---------------------------------------------------------------------------

const requireAdminSessionMock = vi.fn();
vi.mock("@/lib/admin/session", () => ({
  requireAdminSession: (...args: unknown[]) => requireAdminSessionMock(...args),
}));

import ProtectedAdminLayout from "@/app/admin/(protected)/layout";

beforeEach(() => {
  requireAdminSessionMock.mockReset();
});

describe("(protected) admin layout — calls and propagates requireAdminSession()", () => {
  it("calls requireAdminSession() exactly once and renders children when authenticated", async () => {
    requireAdminSessionMock.mockResolvedValue(undefined);

    const result = await ProtectedAdminLayout({ children: "ADMIN_CHILD" as unknown as never });

    expect(requireAdminSessionMock).toHaveBeenCalledTimes(1);
    expect(result).toBe("ADMIN_CHILD");
  });

  it("propagates the redirect thrown by requireAdminSession() for an unauthenticated request, without rendering children", async () => {
    // requireAdminSession() wraps next/navigation's redirect(), which Next
    // implements by throwing a special digest error the router unwinds on.
    // The layout must NOT catch/swallow this — it has to propagate so Next
    // can commit the 307 before any page body runs.
    class RedirectSignal extends Error {
      digest = "NEXT_REDIRECT;replace;/admin/login;307;";
    }
    requireAdminSessionMock.mockRejectedValue(new RedirectSignal("NEXT_REDIRECT"));

    await expect(
      ProtectedAdminLayout({ children: "ADMIN_CHILD" as unknown as never }),
    ).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("admin route group layout — no redirect loop", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const APP_ADMIN = resolve(HERE, "../../src/app/admin");

  it("moved /admin and /admin/ekonomi under the (protected) group", () => {
    expect(existsSync(resolve(APP_ADMIN, "(protected)/page.tsx"))).toBe(true);
    expect(existsSync(resolve(APP_ADMIN, "(protected)/ekonomi/page.tsx"))).toBe(true);
    expect(existsSync(resolve(APP_ADMIN, "page.tsx"))).toBe(false);
    expect(existsSync(resolve(APP_ADMIN, "ekonomi/page.tsx"))).toBe(false);
  });

  it("left /admin/login outside the (protected) group", () => {
    expect(existsSync(resolve(APP_ADMIN, "login/page.tsx"))).toBe(true);
    expect(existsSync(resolve(APP_ADMIN, "(protected)/login/page.tsx"))).toBe(false);
  });
});
