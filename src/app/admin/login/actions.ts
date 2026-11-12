"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  checkAdminPassword,
  createAdminSession,
  deleteAdminSession,
  issueAdminDeviceCookie,
  readAdminDeviceId,
} from "@/lib/admin/session";
import {
  checkAdminDeviceLoginThrottle,
  checkAdminLoginThrottle,
  type LoginThrottleDecision,
} from "@/lib/admin/login-throttle";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";

export type LoginState = { error?: string } | undefined;

const TOO_MANY_ATTEMPTS_ERROR =
  "Çok fazla deneme. Lütfen biraz sonra tekrar deneyin.";

// 5 attempts, refilling 1 every 60s. Process-local (same caveat as the
// module doc in rate-limit.ts): cheap first filter against a flood hitting
// a single instance, but it does not hold across Vercel replicas on its
// own — see `checkAdminLoginThrottle` below for the layer that does.
const loginLimit = createRateLimiter("admin-login", {
  capacity: 5,
  refillPerSecond: 1 / 60,
});

/**
 * Server Action invoked by the login form. Returns `{ error }` for the
 * client-side `useActionState` to display; on success it sets the cookie
 * and redirects to /admin (redirect throws, so no return value after).
 *
 * Two throttle layers run before `checkAdminPassword`, in order:
 *   1. `loginLimit`, the in-memory limiter above — cheap, and shields the
 *      DB from a flood hitting a single instance.
 *   2. `checkAdminLoginThrottle` (migration 086) — a DB-backed counter
 *      keyed off an HMAC of the client key, which holds across every
 *      Vercel instance because it lives in Postgres, not process memory.
 *      This resolves the process-local caveat: layer 1 alone couldn't
 *      stop a distributed attempt against the one shared ADMIN_PASSWORD
 *      spread across serverless instances or rotated IPs. It fails
 *      closed — any DB error, timeout, or misconfiguration denies the
 *      attempt with a generic message rather than falling through to
 *      `checkAdminPassword`.
 *
 * Device cookie (migration 207): layer 2 has a per-device form. A browser that
 * has logged in with the current password carries a signed `admin_device`
 * cookie (src/lib/admin/session.ts); when it is valid, the attempt is counted
 * per device (`checkAdminDeviceLoginThrottle`, 5 per 15 minutes) and is never
 * refused by the global cap (its row still counts toward that cap for other
 * callers), so the owner's own browser keeps working while the shared per-IP
 * and global caps are full. The device throttle fails closed too:
 * a limited device gets the generic error and is never sent to the per-IP path,
 * but an unavailable device RPC (for instance migration 207 not yet applied)
 * falls back to `checkAdminLoginThrottle`, exactly the path a browser without
 * the cookie takes, except a timeout, which is refused like a limited device
 * (the timed-out RPC is not cancelled and may still record its attempt). A missing, forged, expired or mismatched cookie reads as no
 * device at all. The cookie is set only after the password has been checked,
 * so it can only be held by someone who has presented the right password.
 *
 * Only once the throttles allow the attempt do we sleep ~250ms so a wrong
 * password takes roughly the same wall time as a right one — cheap
 * defense against timing attacks scripting attempts against /admin/login
 * — and then run the constant-time `checkAdminPassword` compare
 * (unchanged).
 *
 * Nothing here logs the password or the client key/IP.
 */
export async function loginAction(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const password = String(formData.get("password") ?? "");
  if (!password) {
    return { error: "Şifre gerekli." };
  }

  const hdrs = await headers();
  const key = clientKey({ headers: hdrs });
  if (!loginLimit(key).allowed) {
    return { error: TOO_MANY_ATTEMPTS_ERROR };
  }

  // Layer 2. A valid device cookie selects the per-device throttle; a limited
  // device is refused outright, an unavailable device RPC falls back to the
  // per-IP + global throttle unless it timed out (the timed-out RPC is not
  // cancelled and may still record its attempt, so it is refused too). Without
  // a device cookie only the per-IP + global throttle runs.
  const deviceId = await readAdminDeviceId();
  let throttle: LoginThrottleDecision;
  if (deviceId === null) {
    throttle = await checkAdminLoginThrottle(key);
  } else {
    throttle = await checkAdminDeviceLoginThrottle(deviceId);
    if (!throttle.allowed && throttle.reason === "unavailable" && !throttle.timedOut) {
      throttle = await checkAdminLoginThrottle(key);
    }
  }
  if (!throttle.allowed) {
    // Fail closed and indistinguishable: whether the DB-backed throttle
    // rate-limited this attempt or was unreachable, the caller sees the
    // same generic message. The correct operator action for both is
    // "wait and retry" (see login-throttle.ts's module doc); returning a
    // different string per reason would leak which layer is degraded to
    // an unauthenticated caller.
    return { error: TOO_MANY_ATTEMPTS_ERROR };
  }

  await new Promise((resolve) => setTimeout(resolve, 250));

  if (!checkAdminPassword(password)) {
    return { error: "Şifre yanlış." };
  }

  await createAdminSession();
  // Only a successful password check gets here, so only then is the browser
  // marked as a known device. Best effort: it never fails the login.
  await issueAdminDeviceCookie();
  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  await deleteAdminSession();
  redirect("/admin/login");
}
