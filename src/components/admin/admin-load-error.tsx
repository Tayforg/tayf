import Link from "next/link";

/**
 * Inline error line for an admin load failure (see `loadAdminJson`).
 * A 401 means the admin cookie expired, so it also offers the way back to the
 * login page; every other failure is just the message.
 */
export function AdminLoadError({
  status,
  message,
}: {
  status: number | null;
  message: string;
}) {
  return (
    <div className="space-y-1">
      <p role="alert" className="text-sm text-destructive">
        {message}
      </p>
      {status === 401 && (
        <Link href="/admin/login" className="underline">
          Giriş sayfasına git
        </Link>
      )}
    </div>
  );
}
