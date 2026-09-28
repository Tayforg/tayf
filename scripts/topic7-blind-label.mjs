#!/usr/bin/env node
// scripts/topic7-blind-label.mjs
//
// Prepares and ingests the held-out topic7 v2 gate's blind labels (T7a,
// migration 090; the gate procedure lives in docs/topic7-v2.md). NO
// model-calling code here: `prepare` only renders prompts for a human (or
// a separately-run, founder-approved model pass) to answer; `ingest` only
// turns already-adjudicated answers into a SQL import file. Never touches
// the network, never reads an API key.
//
// Imports the guide from ../src/lib/admin/jev-topic7-guide.ts, a zero-
// import TypeScript file, via Node 24's built-in type-stripping loader
// (`node --experimental-strip-types` is NOT required on Node >=22.6 with
// the default "type-stripping" mode for erasable-syntax-only files; this
// repo's CI and local dev both run Node 24). Run with the Node 24 toolchain
// at ~/.local/share/node-24/bin if the default `node` on PATH is older.
//
//   node scripts/topic7-blind-label.mjs prepare --heldout heldout.json --out prompts.jsonl
//   node scripts/topic7-blind-label.mjs ingest --heldout heldout.json --answers answers.jsonl \
//     --label-source blind-v2guide-A-2026-09-28 --out /path/outside/the/repo/import.sql
//
// heldout.json: JSON array of { article_id, title, description }, e.g. the
// output of the read-only SELECT documented in docs/topic7-v2.md.
// answers.jsonl: one JSON object per line, `{"is_politics": bool, "topic": "..."}`,
// in the SAME order as heldout.json.

import { readFileSync, writeFileSync } from "node:fs";

import { renderTopic7GuideText } from "../src/lib/admin/jev-topic7-guide.ts";
import { buildBlindPrompt, parseBlindAnswer, renderBlindImportSql } from "./lib/topic7-gate.mjs";

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

export function prepare(args) {
  const heldout = readJson(args.heldout);
  const guideText = renderTopic7GuideText();
  const lines = heldout.map((row) => {
    const { article_id: articleId, ...rest } = row;
    const built = buildBlindPrompt(guideText, { title: rest.title, description: rest.description ?? null });
    return JSON.stringify({ article_id: articleId, prompt: built.prompt });
  });
  writeFileSync(args.out, lines.join("\n") + "\n", "utf8");
  return lines.length;
}

export function ingest(args) {
  const heldout = readJson(args.heldout);
  const answerLines = readFileSync(args.answers, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (answerLines.length !== heldout.length) {
    throw new Error(
      `ingest: ${answerLines.length} answers but ${heldout.length} held-out rows -- must match 1:1`,
    );
  }
  const rows = heldout.map((row, i) => {
    const parsed = parseBlindAnswer(answerLines[i]);
    return { article_id: row.article_id, is_politics: parsed.is_politics, topic: parsed.topic };
  });
  const sql = renderBlindImportSql(rows, { labelSource: args["label-source"] });
  writeFileSync(args.out, sql, "utf8");
  return rows.length;
}

export async function main(argv = process.argv.slice(2)) {
  const [subcommand, ...rest] = argv;
  const args = parseArgs(rest);

  if (subcommand === "prepare") {
    const n = prepare(args);
    console.log(`wrote ${n} prompt(s) to ${args.out}`);
    return 0;
  }
  if (subcommand === "ingest") {
    const n = ingest(args);
    console.log(`wrote ${n} adjudicated row(s) to ${args.out}`);
    return 0;
  }
  console.error("usage: topic7-blind-label.mjs <prepare|ingest> --heldout <file> [...]");
  return 1;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then((code) => process.exit(code));
}
