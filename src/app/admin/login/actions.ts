"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  checkAdminPassword,
  createAdminSession,
  deleteAdminSession,
} from "@/lib/admin/session";
import { checkAdminLoginThrottle } from "@/lib/admin/login-throttle";
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
 * Only once both layers allow the attempt do we sleep ~250ms so a wrong
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

  const throttle = await checkAdminLoginThrottle(key);
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
  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  await deleteAdminSession();
  redirect("/admin/login");
}
