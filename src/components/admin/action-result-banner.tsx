import { CheckCircle, XCircle } from "lucide-react";

export type ActionResult = {
  success?: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
};

export function ActionResultBanner({ result }: { result: ActionResult }) {
  return (
    <div
      className={`mb-4 rounded-lg border p-3 text-sm ${
        result.error
          ? "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-400"
          : "border-green-500/30 bg-green-500/10 text-green-800 dark:text-green-400"
      }`}
    >
      <div className="flex items-start gap-2">
        {result.error ? (
          <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
        ) : (
          <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />
        )}
        <pre className="text-xs whitespace-pre-wrap font-mono">
          {JSON.stringify(result, null, 2)}
        </pre>
      </div>
    </div>
  );
}
