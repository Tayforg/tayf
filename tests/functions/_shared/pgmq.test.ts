import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  archive,
  deleteMessage,
  isPollRpcMissing,
  queueDepth,
  readBatch,
  readBatchPoll,
  send,
} from "../../../supabase/functions/_shared/pgmq.ts";

// ---------------------------------------------------------------------------
// Direct tests for supabase/functions/_shared/pgmq.ts (h29-tests-2). Until now
// the module was only ever vi.mock'ed (image-consumer / cluster-consumer
// suites), so nothing tied the RPC names and argument objects to migration 029
// and a rename on either side passed CI and stopped both queue consumers.
//
//   1. each wrapper calls the exact RPC with the exact argument object and maps
//      error.message to its documented Error string (recording fake client);
//   2. '029 contract': the (name, argument keys) pairs found in pgmq.ts equal
//      the (name, parameter names) pairs of the public.pgmq_* shims created by
//      supabase/migrations/029_public_pgmq_wrappers.sql, and no later migration
//      redefines or drops those shims;
//   3. '188 contract' (h101-e2elatency-1): the long-poll twin readBatchPoll calls
//      public.pgmq_read_msgs_poll, whose parameter names are those of migration
//      188, the only migration that names it.
// ---------------------------------------------------------------------------

type Client = Parameters<typeof readBatch>[0];
interface RpcResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/** A client whose rpc() records (name, args) and answers from a FIFO of queued results. */
function fakeClient(...results: RpcResult[]): {
  client: Client;
  rpc: ReturnType<typeof vi.fn>;
} {
  const queue = [...results];
  const rpc = vi.fn(async (_name: string, _args: unknown): Promise<RpcResult> => {
    const next = queue.shift();
    if (!next) throw new Error("fake rpc queue exhausted");
    return next;
  });
  return { client: { rpc } as unknown as Client, rpc };
}

const ok = (data: unknown): RpcResult => ({ data, error: null });
const fail = (message: string, code?: string): RpcResult => ({
  data: null,
  error: code === undefined ? { message } : { message, code },
});

describe("readBatch", () => {
  it("calls pgmq_read_msgs with the default vt 60 and qty 50", async () => {
    const msg = { msg_id: 1, read_ct: 1, enqueued_at: "t", vt: "t", message: { a: 1 } };
    const { client, rpc } = fakeClient(ok([msg]));
    expect(await readBatch(client, "q")).toEqual([msg]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("pgmq_read_msgs", { queue_name: "q", vt: 60, qty: 50 });
  });

  it("passes a custom vt and qty through", async () => {
    const { client, rpc } = fakeClient(ok([]));
    await readBatch(client, "q", 120, 5);
    expect(rpc).toHaveBeenCalledWith("pgmq_read_msgs", { queue_name: "q", vt: 120, qty: 5 });
  });

  it("returns [] when the RPC answers null", async () => {
    const { client } = fakeClient(ok(null));
    expect(await readBatch(client, "q")).toEqual([]);
  });

  it("throws 'pgmq.read(q): boom' on an RPC error", async () => {
    const { client } = fakeClient(fail("boom"));
    await expect(readBatch(client, "q")).rejects.toThrow("pgmq.read(q): boom");
  });
});

describe("readBatchPoll", () => {
  const msg = { msg_id: 1, read_ct: 1, enqueued_at: "t", vt: "t", message: { a: 1 } };

  it("calls pgmq_read_msgs_poll with the queue, vt, qty, wait and sleep step it was given", async () => {
    const { client, rpc } = fakeClient(ok([msg]));
    expect(await readBatchPoll(client, "q", 60, 2, 6, 250)).toEqual([msg]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("pgmq_read_msgs_poll", {
      queue_name: "q",
      vt: 60,
      qty: 2,
      max_poll_seconds: 6,
      poll_interval_ms: 250,
    });
  });

  it("does not clamp: the database function owns the 1..6 s and 50..1000 ms bounds", async () => {
    const { client, rpc } = fakeClient(ok([]));
    await readBatchPoll(client, "q", 60, 2, 99, 5);
    expect(rpc).toHaveBeenCalledWith("pgmq_read_msgs_poll", {
      queue_name: "q",
      vt: 60,
      qty: 2,
      max_poll_seconds: 99,
      poll_interval_ms: 5,
    });
  });

  it("returns [] when the poll timed out empty or the RPC answers null", async () => {
    const { client } = fakeClient(ok([]), ok(null));
    expect(await readBatchPoll(client, "q", 60, 2, 6, 250)).toEqual([]);
    expect(await readBatchPoll(client, "q", 60, 2, 6, 250)).toEqual([]);
  });

  it("throws with readBatch's message shape, 'pgmq.read(q): boom', on an RPC error", async () => {
    const { client } = fakeClient(fail("boom"));
    await expect(readBatchPoll(client, "q", 60, 2, 6, 250)).rejects.toThrow("pgmq.read(q): boom");
  });

  it("keeps the PostgREST / Postgres error code on the thrown error, so a caller can tell a missing RPC from a failure", async () => {
    const { client } = fakeClient(fail("Could not find the function", "PGRST202"), fail("boom"));
    const missing = await readBatchPoll(client, "q", 60, 2, 6, 250).catch((e: unknown) => e);
    expect((missing as { code?: string }).code).toBe("PGRST202");
    const plain = await readBatchPoll(client, "q", 60, 2, 6, 250).catch((e: unknown) => e);
    expect((plain as { code?: string }).code).toBeUndefined();
  });
});

describe("isPollRpcMissing", () => {
  it.each([
    ["PostgREST schema cache miss PGRST202", { code: "PGRST202" }],
    ["Postgres undefined_function 42883", { code: "42883" }],
  ])("is true for %s", (_label, err) => {
    expect(isPollRpcMissing(Object.assign(new Error("x"), err))).toBe(true);
  });

  it.each([
    ["a statement timeout 57014", Object.assign(new Error("x"), { code: "57014" })],
    ["a permission error 42501", Object.assign(new Error("x"), { code: "42501" })],
    ["an error without a code", new Error("x")],
    ["a code that only contains the digits", Object.assign(new Error("x"), { code: "x42883" })],
    ["a non-string code", Object.assign(new Error("x"), { code: 42883 })],
    ["a plain string", "PGRST202"],
    ["null", null],
    ["undefined", undefined],
  ])("is false for %s", (_label, err) => {
    expect(isPollRpcMissing(err)).toBe(false);
  });
});

describe("archive", () => {
  it("calls pgmq_archive_msg with queue_name and msg_id", async () => {
    const { client, rpc } = fakeClient(ok(true));
    await expect(archive(client, "q", 7)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("pgmq_archive_msg", { queue_name: "q", msg_id: 7 });
  });

  it("throws 'pgmq.archive(q, 7): boom' on an RPC error", async () => {
    const { client } = fakeClient(fail("boom"));
    await expect(archive(client, "q", 7)).rejects.toThrow("pgmq.archive(q, 7): boom");
  });
});

describe("deleteMessage", () => {
  it("calls pgmq_delete_msg with queue_name and msg_id", async () => {
    const { client, rpc } = fakeClient(ok(true));
    await expect(deleteMessage(client, "q", 7)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("pgmq_delete_msg", { queue_name: "q", msg_id: 7 });
  });

  it("throws 'pgmq.delete(q, 7): boom' on an RPC error", async () => {
    const { client } = fakeClient(fail("boom"));
    await expect(deleteMessage(client, "q", 7)).rejects.toThrow("pgmq.delete(q, 7): boom");
  });
});

describe("queueDepth", () => {
  it("reads depth and oldest age from an array row", async () => {
    const { client, rpc } = fakeClient(ok([{ queue_length: 12, oldest_msg_age_sec: 340 }]));
    expect(await queueDepth(client, "q")).toEqual({ depth: 12, oldest_msg_age_sec: 340 });
    expect(rpc).toHaveBeenCalledWith("pgmq_metrics_one", { queue_name: "q" });
  });

  it("reads depth and oldest age from a bare object row", async () => {
    const { client } = fakeClient(ok({ queue_length: 0, oldest_msg_age_sec: 0 }));
    expect(await queueDepth(client, "q")).toEqual({ depth: 0, oldest_msg_age_sec: 0 });
  });

  it("maps each non-number field to null independently", async () => {
    const { client } = fakeClient(
      ok([{ queue_length: "12", oldest_msg_age_sec: 5 }]),
      ok([{ queue_length: 3, oldest_msg_age_sec: null }]),
      ok([{}]),
      ok([]),
      ok(null),
    );
    expect(await queueDepth(client, "q")).toEqual({ depth: null, oldest_msg_age_sec: 5 });
    expect(await queueDepth(client, "q")).toEqual({ depth: 3, oldest_msg_age_sec: null });
    expect(await queueDepth(client, "q")).toEqual({ depth: null, oldest_msg_age_sec: null });
    expect(await queueDepth(client, "q")).toEqual({ depth: null, oldest_msg_age_sec: null });
    expect(await queueDepth(client, "q")).toEqual({ depth: null, oldest_msg_age_sec: null });
  });

  it("returns nulls on an RPC error and never throws", async () => {
    const { client } = fakeClient(fail("boom"));
    await expect(queueDepth(client, "q")).resolves.toEqual({
      depth: null,
      oldest_msg_age_sec: null,
    });
  });
});

describe("send", () => {
  it("calls pgmq_send_msg with queue_name and the payload as message", async () => {
    const { client, rpc } = fakeClient(ok(42));
    const payload = { article_id: "a1", n: [1, 2] };
    await send(client, "q", payload);
    expect(rpc).toHaveBeenCalledWith("pgmq_send_msg", { queue_name: "q", message: payload });
  });

  it.each([
    ["an array [42]", [42]],
    ["a number 42", 42],
    ["a numeric string '42'", "42"],
  ])("returns 42 for %s", async (_label, data) => {
    const { client } = fakeClient(ok(data));
    expect(await send(client, "q", {})).toBe(42);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty array", []],
    ["a non-numeric string", "abc"],
    ["an empty string", ""],
    ["a blank string", "   "],
    ["an array holding null", [null]],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an object", { msg_id: 1 }],
  ])("throws 'no msg_id returned' for %s", async (_label, data) => {
    const { client } = fakeClient(ok(data));
    await expect(send(client, "q", {})).rejects.toThrow("pgmq.send(q): no msg_id returned");
  });

  it("throws 'pgmq.send(q): boom' on an RPC error", async () => {
    const { client } = fakeClient(fail("boom"));
    await expect(send(client, "q", {})).rejects.toThrow("pgmq.send(q): boom");
  });
});

// ---------------------------------------------------------------------------
// 029 contract
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const PGMQ_TS = resolve(here, "../../../supabase/functions/_shared/pgmq.ts");
const MIGRATIONS_DIR = resolve(here, "../../../supabase/migrations");
const MIGRATION_029 = join(MIGRATIONS_DIR, "029_public_pgmq_wrappers.sql");
const MIGRATION_188 = join(MIGRATIONS_DIR, "188_pgmq_read_msgs_poll.sql");

/** True when `name` occurs in `text` as a whole identifier (the next character does not continue it). */
function mentionsIdentifier(text: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at === -1) return false;
    const next = text.charAt(at + name.length);
    const continues = (next >= "a" && next <= "z") || (next >= "0" && next <= "9") || next === "_";
    if (!continues) return true;
    from = at + name.length;
  }
}

/**
 * Blanks comments (newlines kept) with a character scan. `lineComment` is the
 * line-comment opener ("--" for SQL, "//" for TypeScript); /* ... *\/ blocks
 * are blanked for both. Text inside the given quote characters is left alone,
 * so a "--" inside a SQL string is not mistaken for a comment.
 */
function blankComments(src: string, lineComment: string, quotes: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (src.startsWith(lineComment, i)) {
      while (i < src.length && src.charAt(i) !== "\n") {
        out += " ";
        i += 1;
      }
    } else if (src.startsWith("/*", i)) {
      out += "  ";
      i += 2;
      while (i < src.length && !src.startsWith("*/", i)) {
        out += src.charAt(i) === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
    } else if (quotes.includes(c)) {
      out += c;
      i += 1;
      while (i < src.length && src.charAt(i) !== c) {
        if (c !== "'" && src.charAt(i) === "\\") {
          out += src.charAt(i);
          i += 1;
        }
        out += src.charAt(i);
        i += 1;
      }
      out += c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** The text between the "(" or "{" at `open` and its matching closer, plus the index after it. */
function balanced(text: string, open: number): { inner: string; end: number } {
  const opener = text.charAt(open);
  const closer = opener === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) {
        if (c !== closer) throw new Error(`unbalanced ${opener} at ${open}`);
        return { inner: text.slice(open + 1, i), end: i + 1 };
      }
    }
  }
  throw new Error(`no closing ${closer} for ${opener} at ${open}`);
}

/** Splits on commas that are not nested inside (), {} or []. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function collapseWhitespace(text: string): string {
  return text.split(/\s+/).join(" ");
}

/** name -> sorted parameter names of every `create or replace function public.pgmq_*` in the SQL. */
function sqlShims(sql: string): Map<string, string[]> {
  const text = collapseWhitespace(blankComments(sql, "--", "'")).toLowerCase();
  const marker = "create or replace function public.";
  const out = new Map<string, string[]>();
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at === -1) break;
    from = at + marker.length;
    const open = text.indexOf("(", from);
    const name = text.slice(from, open).trim();
    if (!name.startsWith("pgmq_")) continue;
    const { inner } = balanced(text, open);
    const params = splitTopLevel(inner).map((p) => p.split(" ")[0] ?? "");
    out.set(name, params.sort());
  }
  return out;
}

/** name -> sorted argument-object keys of every `client.rpc("pgmq_*", { ... })` in the TypeScript. */
function clientCalls(ts: string): Map<string, string[]> {
  const text = blankComments(ts, "//", '"\'`');
  const marker = "client.rpc(";
  const out = new Map<string, string[]>();
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at === -1) break;
    from = at + marker.length;
    const { inner } = balanced(text, at + marker.length - 1);
    const [nameArg = "", objectArg = ""] = splitTopLevel(inner);
    const name = nameArg.replaceAll('"', "").replaceAll("'", "");
    if (!objectArg.startsWith("{")) throw new Error(`rpc ${name}: second argument is not an object literal`);
    const keys = splitTopLevel(balanced(objectArg, 0).inner).map((entry) => {
      const colon = entry.indexOf(":");
      // Shorthand `{ vt, qty }` has no colon: the key is the whole token.
      return (colon === -1 ? entry : entry.slice(0, colon)).trim();
    });
    out.set(name, keys.sort());
  }
  return out;
}

describe("029 contract", () => {
  const shims = sqlShims(readFileSync(MIGRATION_029, "utf8"));
  const calls = clientCalls(readFileSync(PGMQ_TS, "utf8"));
  const EXPECTED = [
    "pgmq_archive_msg",
    "pgmq_delete_msg",
    "pgmq_metrics_one",
    "pgmq_read_msgs",
    "pgmq_send_msg",
  ];

  it("parses 6 client.rpc calls out of pgmq.ts (029's 5 and 188's long-poll twin) and 5 shims out of migration 029", () => {
    expect([...calls.keys()].sort()).toEqual([...EXPECTED, "pgmq_read_msgs_poll"].sort());
    expect([...shims.keys()].sort()).toEqual(EXPECTED);
  });

  it("parses shorthand and renamed keys correctly", () => {
    expect(calls.get("pgmq_read_msgs")).toEqual(["qty", "queue_name", "vt"]);
    expect(calls.get("pgmq_send_msg")).toEqual(["message", "queue_name"]);
    expect(shims.get("pgmq_read_msgs")).toEqual(["qty", "queue_name", "vt"]);
  });

  it.each(EXPECTED)("%s exists in 029 with exactly the argument names pgmq.ts sends", (name) => {
    expect(shims.has(name), `${name} must be created by migration 029`).toBe(true);
    expect(calls.get(name)).toEqual(shims.get(name));
  });

  it("migration 029 grants EXECUTE on every shim to service_role only", () => {
    const sql = collapseWhitespace(blankComments(readFileSync(MIGRATION_029, "utf8"), "--", "'")).toLowerCase();
    expect(sql).toContain("revoke execute on function %s from public, anon, authenticated");
    expect(sql).toContain("grant execute on function %s to service_role");
    for (const name of EXPECTED) {
      expect(sql, `${name} must be in the revoke/grant signature list`).toContain(`'public.${name}(`);
    }
  });

  it("no later migration (030 and up) redefines, alters, drops or regrants a pgmq shim (188's new _poll function is a different identifier)", () => {
    const later = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && Number(f.slice(0, 3)) >= 30)
      .sort();
    expect(later.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const file of later) {
      const sql = blankComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"), "--", "'").toLowerCase();
      for (const name of EXPECTED) {
        if (mentionsIdentifier(sql, name)) offenders.push(`${file} mentions ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("188 contract (h101-e2elatency-1)", () => {
  const calls = clientCalls(readFileSync(PGMQ_TS, "utf8"));
  const shims188 = sqlShims(readFileSync(MIGRATION_188, "utf8"));

  it("migration 188 creates exactly one pgmq shim, pgmq_read_msgs_poll", () => {
    expect([...shims188.keys()]).toEqual(["pgmq_read_msgs_poll"]);
  });

  it("readBatchPoll sends exactly the parameter names migration 188 declares", () => {
    expect(calls.get("pgmq_read_msgs_poll")).toEqual(["max_poll_seconds", "poll_interval_ms", "qty", "queue_name", "vt"]);
    expect(calls.get("pgmq_read_msgs_poll")).toEqual(shims188.get("pgmq_read_msgs_poll"));
  });

  it("188 is the only migration that names pgmq_read_msgs_poll", () => {
    const named = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) =>
        mentionsIdentifier(blankComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8"), "--", "'").toLowerCase(), "pgmq_read_msgs_poll"),
      );
    expect(named).toEqual(["188_pgmq_read_msgs_poll.sql"]);
  });
});
