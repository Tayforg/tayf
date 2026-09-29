import { connection } from "next/server";
import { readIndexNowKey } from "@/lib/seo/indexnow";

// IndexNow key-ownership file. `connection()` opts out of prerendering so
// INDEXNOW_KEY is read at request time, not frozen at build time.
export async function GET(): Promise<Response> {
  await connection();
  const key = readIndexNowKey();
  if (!key) {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "public, s-maxage=300" },
    });
  }
  return new Response(key, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, s-maxage=3600",
    },
  });
}
