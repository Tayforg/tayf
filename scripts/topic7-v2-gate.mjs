#!/usr/bin/env node
// scripts/topic7-v2-gate.mjs
//
// The paired v1/v2 topic7 gate run (T7a groundwork; the gate itself is run
// AFTER T7a, per founder decision #5 and docs/topic7-v2.md). Three
// subcommands:
//
//   prepare --items items.json --v2-question v2.json   (dry run, no network)
//   run     --items items.json --v2-question v2.json --execute            (network; gated)
//   score   --items items.json --results results.json --mix mix.json      (no network)
//
// `run` is HARD-GATED: it refuses to call any endpoint unless invoked with
// --execute AND env JEV_GATE_APPROVED is non-empty AND env
// AI_GATEWAY_API_KEY is set. This file must never be imported or executed
// by an automated gate/CI step without those three present -- the actual
// Jev call is founder-approved, operator-run, one-shot (~1.9M tokens, 300
// blind labels; see docs/topic7-v2.md). Logs status codes only, never a key
// or a response body.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { buildArticleCall, JEV_CONCURRENCY } from "../supabase/functions/_shared/jev.ts";
import { evaluateJev } from "../supabase/functions/_shared/jev-client.ts";
import { evaluateGate } from "./lib/topic7-gate.mjs";

export const RUN_CALL_CAP = 1_400;
export const RUN_INPUT_TOKEN_CAP = 2_500_000;
const CHARS_PER_TOKEN = 0.389;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function estimateTokens(text) {
  return Math.ceil(text.length * CHARS_PER_TOKEN);
}

/** Builds the v1 request (the exact production pack) and the v2 request
 * (the same request with questions.topic7 replaced). No network. */
export function buildCalls(items, v2Question) {
  return items.map((item) => {
    const v1 = buildArticleCall(item);
    const v2 = { state: v1.state, questions: { ...v1.questions, topic7: { ...v1.questions.topic7, ...v2Question } } };
    return { item, v1, v2 };
  });
}

export function prepare(args) {
  const itemsRaw = readFileSync(args.items, "utf8");
  const items = JSON.parse(itemsRaw);
  const v2Question = readJson(args["v2-question"]);
  const calls = buildCalls(items, v2Question);

  const callCount = calls.length * 2;
  const totalChars = calls.reduce(
    (sum, c) => sum + JSON.stringify(c.v1).length + JSON.stringify(c.v2).length,
    0,
  );
  const estimatedTokens = estimateTokens(String(totalChars)) === 0 ? 0 : Math.ceil(totalChars * CHARS_PER_TOKEN);
  const itemsSha = sha256Hex(itemsRaw);

  const report = { call_count: callCount, estimated_tokens: estimatedTokens, items_sha256: itemsSha };
  console.log(JSON.stringify(report));
  return report;
}

/**
 * The gated live run. Refuses (returns a non-zero exit code) unless
 * --execute is passed AND env.JEV_GATE_APPROVED is non-empty AND
 * env.AI_GATEWAY_API_KEY is set -- checked BEFORE any fetch. `fetchImpl` is
 * injectable for tests; production always uses the real evaluateJev, which
 * uses global fetch.
 */
export async function run(args, env, fetchImpl) {
  if (!args.execute) {
    console.error("run: refused -- pass --execute to run the live gate");
    return 1;
  }
  if (!env.JEV_GATE_APPROVED) {
    console.error("run: refused -- env JEV_GATE_APPROVED must be set (founder approval)");
    return 1;
  }
  const apiKey = env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    console.error("run: refused -- env AI_GATEWAY_API_KEY must be set");
    return 1;
  }

  const itemsRaw = readFileSync(args.items, "utf8");
  const items = JSON.parse(itemsRaw);
  const v2Question = readJson(args["v2-question"]);
  const calls = buildCalls(items, v2Question);

  if (calls.length * 2 > RUN_CALL_CAP) {
    console.error(`run: refused -- ${calls.length * 2} calls exceeds the ${RUN_CALL_CAP} cap`);
    return 1;
  }
  const totalChars = calls.reduce(
    (sum, c) => sum + JSON.stringify(c.v1).length + JSON.stringify(c.v2).length,
    0,
  );
  const estimatedTokens = Math.ceil(totalChars * CHARS_PER_TOKEN);
  if (estimatedTokens > RUN_INPUT_TOKEN_CAP) {
    console.error(`run: refused -- ~${estimatedTokens} input tokens exceeds the ${RUN_INPUT_TOKEN_CAP} cap`);
    return 1;
  }

  const results = [];
  let cursor = 0;
  const concurrency = JEV_CONCURRENCY ?? 8;
  const originalFetch = globalThis.fetch;
  if (fetchImpl && fetchImpl !== originalFetch) {
    globalThis.fetch = fetchImpl;
  }

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= calls.length) return;
      const { item, v1, v2 } = calls[i];
      for (const [label, request] of [["v1", v1], ["v2", v2]]) {
        try {
          const { response } = await evaluateJev(apiKey, request, { timeoutMs: 50_000, maxRetries: 2 });
          results.push({ article_id: item.article_id, version: label, answer: response.answers?.topic7 ?? null });
        } catch (err) {
          const status = err && typeof err === "object" && "status" in err ? err.status : "error";
          console.error(`[topic7-v2-gate] ${label} call failed, status=${status}`);
        }
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, calls.length || 1) }, () => worker()));
  } finally {
    globalThis.fetch = originalFetch;
  }

  if (args.out) {
    writeFileSync(args.out, JSON.stringify({ results, usage: { calls: calls.length * 2, estimated_input_tokens: estimatedTokens } }), "utf8");
  }
  return 0;
}

export function score(args) {
  const input = readJson(args.results);
  const report = evaluateGate(input);
  console.log(JSON.stringify(report, null, 2));
  return report.pass ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch) {
  const [subcommand, ...rest] = argv;
  const args = parseArgs(rest);

  if (subcommand === "prepare") {
    prepare(args);
    return 0;
  }
  if (subcommand === "run") {
    return run(args, env, fetchImpl);
  }
  if (subcommand === "score") {
    return score(args);
  }
  console.error("usage: topic7-v2-gate.mjs <prepare|run|score> [...]");
  return 1;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then((code) => process.exit(code));
}
