#!/usr/bin/env node
// scripts/jev-gold-opus-seed.mjs
//
// Turns the 360 paid Opus labels (labels_0.json + labels_1.json) plus the
// 2026-09-20 limits rig's Jev reference answers (accuracy_t1.json) into
// scripts/sql/jev-gold-opus-seed.sql, the deterministic, committed seed
// that calls public.jev_gold_import_provisional() once. No network calls,
// no DB connection, no LLM/Jev calls -- purely reads the three input
// files and writes one SQL file.
//
//   node scripts/jev-gold-opus-seed.mjs \
//     --labels labels_0.json,labels_1.json \
//     --jev accuracy_t1.json \
//     --out scripts/sql/jev-gold-opus-seed.sql
//
// Prints the row count, the is_politics=true count, the topic histogram and
// the disagreement count at 0.5 against the Jev reference (expect 54). If
// the disagreement count is not 54, the script exits non-zero WITHOUT
// writing the output file -- investigate before committing a seed whose
// numbers don't match the brief.

import { readFileSync, writeFileSync } from "node:fs";

import {
  JEV_GOLD_TOPICS,
  parseLabelFile,
  mergeLabels,
  attachRefJev,
  countDisagreements,
  renderSeedSql,
} from "./lib/jev-gold-opus-seed.mjs";

const EXPECTED_DISAGREEMENTS = 54;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      out[key] = next;
      i++;
    }
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.labels || !args.jev || !args.out) {
    console.error(
      "usage: node scripts/jev-gold-opus-seed.mjs --labels <a.json>,<b.json> --jev <accuracy.json> --out <out.sql>",
    );
    process.exit(2);
  }

  const labelPaths = args.labels.split(",").map((s) => s.trim()).filter(Boolean);
  const lists = labelPaths.map((p) => parseLabelFile(readJson(p)));
  const merged = mergeLabels(lists);

  const accuracyJson = readJson(args.jev);
  const attached = attachRefJev(merged, accuracyJson, "en");

  const disagreements = countDisagreements(attached, 0.5);

  const politicsTrue = attached.filter((r) => r.is_politics).length;
  const histogram = {};
  for (const topic of JEV_GOLD_TOPICS) histogram[topic] = 0;
  for (const row of attached) histogram[row.topic] = (histogram[row.topic] ?? 0) + 1;

  console.log(`rows: ${attached.length}`);
  console.log(`is_politics=true: ${politicsTrue}`);
  console.log("topic histogram:");
  for (const [topic, n] of Object.entries(histogram)) {
    console.log(`  ${topic}: ${n}`);
  }
  console.log(`disagreements at 0.5: ${disagreements} (expected ${EXPECTED_DISAGREEMENTS})`);

  if (disagreements !== EXPECTED_DISAGREEMENTS) {
    console.error(
      `refusing to write ${args.out}: disagreement count ${disagreements} != expected ${EXPECTED_DISAGREEMENTS}. Investigate before committing.`,
    );
    process.exit(1);
  }

  const sql = renderSeedSql(attached, { labelSource: "opus-2026-09-20", stratum: "opus_seed" });
  writeFileSync(args.out, sql, "utf8");
  console.log(`wrote ${args.out}`);
}

main();
