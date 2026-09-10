"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  checkAdminPassword,
  createAdminSession,
  deleteAdminSession,
} from "@/lib/admin/session";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";

export type LoginState = { error?: string } | undefined;

// 5 attempts, refilling 1 every 60s. Process-local (same caveat as the
// module doc in rate-limit.ts): a multi-instance/serverless deployment
// would need a shared store (e.g. Redis) for this to hold across replicas.
const loginLimit = createRateLimiter("admin-login", {
  capacity: 5,
  refillPerSecond: 1 / 60,
});

/**
 * Server Action invoked by the login form. Returns `{ error }` for the
 * client-side `useActionState` to display; on success it sets the cookie
 * and redirects to /admin (redirect throws, so no return value after).
 *
 * Rate-limited per client IP (see `loginLimit` above) before anything else
 * runs, so an exhausted bucket never reaches `checkAdminPassword`. We also
 * sleep ~250ms on every remaining attempt so a wrong password takes
 * roughly the same wall time as a right one — cheap defense against timing
 * attacks scripting attempts against /admin/login.
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
    return { error: "Çok fazla deneme. Lütfen biraz sonra tekrar deneyin." };
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
