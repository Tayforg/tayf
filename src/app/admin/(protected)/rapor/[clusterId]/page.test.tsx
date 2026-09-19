import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// D-MISSING-TESTS: pack D's riskiest surface — the admin session gate —
// had zero regression guard. This suite proves two things a later
// refactor could silently break:
//   1. An unauthenticated request never reaches buildYelpazeReport() (no
//      report data is ever fetched before the redirect).
//   2. requireAdminSession() runs BEFORE buildYelpazeReport() on every
//      code path, not just by accident of the current source order —
//      enforced via a shared call-order log rather than a mock-call-count
//      check alone, so a refactor that hoists the fetch above the gate
//      fails this suite even if both functions still get called once each.
//
// @/lib/admin/session and @/lib/reports/yelpaze are mocked wholesale (both
// hit real infra — cookies / Supabase — in production) so this exercises
// only the page's own call ordering. next/server's connection() (added by
// D-PPR-REDIRECT so this route can't flush a static PPR shell before the
// session check) is mocked the same way `next/navigation` already is
// elsewhere in this repo — it throws outside of a real Next.js request
// context, which a bare unit-test call to the page function always is.
// ---------------------------------------------------------------------------

const callLog: string[] = [];

const REDIRECT_SENTINEL = Symbol("NEXT_REDIRECT");
const NOT_FOUND_SENTINEL = Symbol("NEXT_NOT_FOUND");

const requireAdminSessionMock = vi.fn(async () => {
  callLog.push("requireAdminSession");
});
vi.mock("@/lib/admin/session", () => ({
  requireAdminSession: () => requireAdminSessionMock(),
}));

const buildYelpazeReportMock = vi.fn(async (clusterId: string) => {
  callLog.push("buildYelpazeReport");
  void clusterId;
  return null;
});
vi.mock("@/lib/reports/yelpaze", () => ({
  buildYelpazeReport: (clusterId: string) => buildYelpazeReportMock(clusterId),
}));

vi.mock("next/server", () => ({
  connection: async () => undefined,
}));

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw REDIRECT_SENTINEL;
  },
  notFound: () => {
    throw NOT_FOUND_SENTINEL;
  },
}));

// Import AFTER mocks are declared.
import YelpazeRaporPage from "./page";

const VALID_UUID = "00000000-0000-0000-0000-000000000000";

beforeEach(() => {
  callLog.length = 0;
  requireAdminSessionMock.mockClear();
  requireAdminSessionMock.mockImplementation(async () => {
    callLog.push("requireAdminSession");
  });
  buildYelpazeReportMock.mockClear();
});

describe("YelpazeRaporPage — admin session gate", () => {
  it("rejects an unauthenticated request and never calls buildYelpazeReport", async () => {
    requireAdminSessionMock.mockImplementation(async () => {
      callLog.push("requireAdminSession");
      throw REDIRECT_SENTINEL;
    });

    await expect(
      YelpazeRaporPage({ params: Promise.resolve({ clusterId: VALID_UUID }) }),
    ).rejects.toBe(REDIRECT_SENTINEL);

    expect(buildYelpazeReportMock).not.toHaveBeenCalled();
    expect(callLog).toEqual(["requireAdminSession"]);
  });

  it("always calls requireAdminSession before buildYelpazeReport, by call order not just call count", async () => {
    await expect(
      YelpazeRaporPage({ params: Promise.resolve({ clusterId: VALID_UUID }) }),
    ).rejects.toBe(NOT_FOUND_SENTINEL); // buildYelpazeReport() mock resolves null → notFound()

    expect(callLog).toEqual(["requireAdminSession", "buildYelpazeReport"]);
  });
});
