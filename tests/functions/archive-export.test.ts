import { describe, expect, it } from "vitest";
import {
  ARCHIVE_ID_CHUNK,
  ARCHIVE_LABEL_SOURCE,
  ARCHIVE_PAGE_SIZE,
  ARCHIVE_SCHEMA,
  ArchiveDeadlineError,
  buildManifest,
  byteLength,
  dayBounds,
  emptyLabels,
  isValidDay,
  labelsFromRows,
  mapArticle,
  objectPrefix,
  previousUtcDay,
  runArchiveExport,
  sha256Hex,
  summariseLabels,
  toJsonl,
  zoneOfBias,
  type ArchiveArticle,
  type ArchiveCluster,
  type ArchiveFile,
  type ArchiveLabels,
  type ArchiveManifestLabels,
  type ArchivePorts,
  type RawArticleRow,
  type RawLabelRow,
} from "../../supabase/functions/_shared/archive.ts";

// Pure-helper + algorithm contract for the archive-export Edge Function
// (M-10, Tayf Arşiv). The Supabase wiring in archive-export/index.ts is thin;
// what can silently rot is the day math, the deterministic JSONL/hash pair
// that makes the archive checksummable, the paging bounds and the
// "no ledger row unless every upload landed" invariant.
//
// P12 (migration 065) adds the label-enrichment pass: every exported article
// carries a `labels` object read (in a batched, chunked way) from
// jev_shadow_predictions, and the manifest declares a `labels` summary block.

// --- in-memory ArchivePorts ------------------------------------------------

interface UploadCall {
  path: string;
  body: string;
  contentType: string;
}

interface Recorder {
  ports: ArchivePorts;
  hasExportCalls: string[];
  clusterCalls: { start: string; end: string; page: number }[];
  articleCalls: { ids: string[]; page: number }[];
  labelCalls: string[][];
  uploads: UploadCall[];
  records: { day: string; object_path: string; sha256: string; rows: number; bytes: number }[];
}

function makePorts(overrides: Partial<ArchivePorts> = {}): Recorder {
  const rec: Recorder = {
    ports: {} as ArchivePorts,
    hasExportCalls: [],
    clusterCalls: [],
    articleCalls: [],
    labelCalls: [],
    uploads: [],
    records: [],
  };

  const base: ArchivePorts = {
    hasExport: async (day) => {
      rec.hasExportCalls.push(day);
      return false;
    },
    fetchClusters: async (start, end, page) => {
      rec.clusterCalls.push({ start, end, page });
      return [];
    },
    fetchArticles: async (clusterIds, page) => {
      rec.articleCalls.push({ ids: [...clusterIds], page });
      return { rows: [], fetched: 0 };
    },
    fetchLabels: async (ids) => {
      rec.labelCalls.push([...ids]);
      return new Map();
    },
    upload: async (path, body, contentType) => {
      rec.uploads.push({ path, body, contentType });
    },
    recordExport: async (row) => {
      rec.records.push(row);
    },
    now: () => 0,
  };

  rec.ports = { ...base, ...overrides };
  return rec;
}

function cluster(overrides: Partial<ArchiveCluster> = {}): ArchiveCluster {
  return {
    id: "c1",
    title_tr: "Başlık",
    title_tr_neutral: "Nötr başlık",
    title_neutral_model: "gpt-x",
    article_count: 3,
    is_blindspot: false,
    blindspot_side: null,
    is_archived: false,
    bias_distribution: { gov_leaning: 2, opposition: 1 },
    first_published: "2026-09-18T07:00:00.000Z",
    ...overrides,
  };
}

function rawArticle(overrides: Partial<RawArticleRow> = {}): RawArticleRow {
  return {
    id: "a1",
    cluster_id: "c1",
    title: "Haber başlığı",
    url: "https://example.com/haber",
    published_at: "2026-09-18T07:05:00.000Z",
    source: { slug: "ornek", bias: "center" },
    ...overrides,
  };
}

function labelRow(overrides: Partial<RawLabelRow> = {}): RawLabelRow {
  return {
    task: "politics",
    article_id: "a1",
    jev_prob: 0.5,
    jev_choice: null,
    question_set: "2026-09-21.1",
    ...overrides,
  };
}

function archiveArticle(id: string, labels: Partial<ArchiveLabels> = {}): ArchiveArticle {
  return {
    article_id: id,
    cluster_id: "c1",
    source: "ornek",
    zone: "bagimsiz",
    title: "Başlık",
    url: `https://example.com/${id}`,
    published_at: "2026-09-18T07:00:00.000Z",
    labels: { ...emptyLabels(), ...labels },
  };
}

// --- 1. day math -----------------------------------------------------------

describe("previousUtcDay / isValidDay", () => {
  it("returns the UTC day before the cron instant", () => {
    expect(previousUtcDay(new Date("2026-09-19T03:40:00Z"))).toBe("2026-09-18");
  });

  it("crosses month and year boundaries in UTC", () => {
    expect(previousUtcDay(new Date("2026-03-01T00:10:00Z"))).toBe("2026-02-28");
    expect(previousUtcDay(new Date("2027-01-01T03:40:00Z"))).toBe("2026-12-31");
  });

  it("accepts a real calendar day", () => {
    expect(isValidDay("2026-02-28")).toBe(true);
  });

  it("rejects impossible days, unpadded days, non-strings and the empty string", () => {
    expect(isValidDay("2026-02-30")).toBe(false);
    expect(isValidDay("2026-9-1")).toBe(false);
    expect(isValidDay(20260901)).toBe(false);
    expect(isValidDay("")).toBe(false);
    expect(isValidDay(null)).toBe(false);
    expect(isValidDay(undefined)).toBe(false);
  });
});

// --- 2. bounds + prefix ----------------------------------------------------

describe("dayBounds / objectPrefix", () => {
  it("returns half-open UTC bounds for the day", () => {
    expect(dayBounds("2026-09-18")).toEqual({
      start: "2026-09-18T00:00:00.000Z",
      end: "2026-09-19T00:00:00.000Z",
    });
  });

  it("maps a day to its YYYY/MM/DD object prefix", () => {
    expect(objectPrefix("2026-09-18")).toBe("2026/09/18");
  });
});

// --- 3. deterministic JSONL ------------------------------------------------

describe("toJsonl", () => {
  it("sorts keys recursively so identical rows always hash identically", () => {
    expect(toJsonl([{ b: 1, a: { d: 1, c: 2 } }])).toBe('{"a":{"c":2,"d":1},"b":1}\n');
  });

  it("encodes an empty set as the empty string (no stray newline)", () => {
    expect(toJsonl([])).toBe("");
  });

  it("writes one object per line and keeps unicode intact", () => {
    const text = toJsonl([{ t: "Şirket" }, { t: "emoji 🙂" }]);
    expect(text).toBe('{"t":"Şirket"}\n{"t":"emoji 🙂"}\n');
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
  });
});

// --- 4. hashing ------------------------------------------------------------

describe("sha256Hex / byteLength", () => {
  it("matches the canonical SHA-256 of 'abc'", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes the empty string without throwing", async () => {
    await expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("ş")).toBe(2);
    expect(byteLength("")).toBe(0);
  });
});

// --- 5. manifest -----------------------------------------------------------

describe("buildManifest", () => {
  it("sums rows and bytes across files and carries the schema id", () => {
    const files: ArchiveFile[] = [
      { name: "clusters.jsonl", sha256: "aa", rows: 2, bytes: 100 },
      { name: "articles.jsonl", sha256: "bb", rows: 3, bytes: 250 },
    ];
    const labels: ArchiveManifestLabels = {
      source: ARCHIVE_LABEL_SOURCE,
      question_set: "2026-09-21.1",
      coverage: 0.5,
      declared: true,
    };

    const manifest = buildManifest("2026-09-18", "2026-09-19T03:40:00.000Z", files, labels);

    expect(manifest).toEqual({
      schema: ARCHIVE_SCHEMA,
      day: "2026-09-18",
      generated_at: "2026-09-19T03:40:00.000Z",
      files,
      rows: 5,
      bytes: 350,
      labels,
    });
    expect(manifest.schema).toBe("tayf-archive/1");
    expect(manifest.labels).toEqual(labels);
  });

  it("is zero-safe for a day with no rows", () => {
    const labels: ArchiveManifestLabels = {
      source: ARCHIVE_LABEL_SOURCE,
      question_set: null,
      coverage: 0,
      declared: true,
    };

    const manifest = buildManifest("2026-09-18", "2026-09-19T03:40:00.000Z", [], labels);

    expect(manifest.rows).toBe(0);
    expect(manifest.bytes).toBe(0);
    expect(manifest.labels).toEqual(labels);
  });
});

// --- 6. row mapping --------------------------------------------------------

describe("zoneOfBias / mapArticle", () => {
  it("maps known bias keys to Medya DNA zones", () => {
    expect(zoneOfBias("gov_leaning")).toBe("iktidar");
    expect(zoneOfBias("center")).toBe("bagimsiz");
    expect(zoneOfBias("opposition")).toBe("muhalefet");
  });

  it("returns null for unknown, null, undefined and empty bias", () => {
    expect(zoneOfBias("nope")).toBeNull();
    expect(zoneOfBias(null)).toBeNull();
    expect(zoneOfBias(undefined)).toBeNull();
    expect(zoneOfBias("")).toBeNull();
  });

  it("maps an article whose source came back as an embedded object", () => {
    expect(mapArticle(rawArticle())).toEqual({
      article_id: "a1",
      cluster_id: "c1",
      source: "ornek",
      zone: "bagimsiz",
      title: "Haber başlığı",
      url: "https://example.com/haber",
      published_at: "2026-09-18T07:05:00.000Z",
      labels: emptyLabels(),
    });
  });

  it("maps an article whose source came back as a one-element array", () => {
    const mapped = mapArticle(rawArticle({ source: [{ slug: "gazete", bias: "opposition" }] }));
    expect(mapped.source).toBe("gazete");
    expect(mapped.zone).toBe("muhalefet");
  });

  it("maps an article with no source (and an empty source array) to nulls", () => {
    expect(mapArticle(rawArticle({ source: null })).source).toBeNull();
    expect(mapArticle(rawArticle({ source: null })).zone).toBeNull();
    expect(mapArticle(rawArticle({ source: [] })).source).toBeNull();
    expect(mapArticle(rawArticle({ source: [] })).zone).toBeNull();
  });

  it("carries only headline-level fields (no description/body/image)", () => {
    expect(Object.keys(mapArticle(rawArticle())).sort()).toEqual([
      "article_id",
      "cluster_id",
      "labels",
      "published_at",
      "source",
      "title",
      "url",
      "zone",
    ]);
  });

  it("defaults labels to emptyLabels() when no second argument is given", () => {
    expect(mapArticle(rawArticle()).labels).toEqual(emptyLabels());
  });
});

// --- 6b. label folding -------------------------------------------------------

describe("labelsFromRows", () => {
  it("folds one row per task into a single label object per article", () => {
    const rows: RawLabelRow[] = [
      labelRow({ task: "politics", article_id: "a1", jev_prob: 0.8, jev_choice: null, question_set: "qs1" }),
      labelRow({ task: "topic", article_id: "a1", jev_prob: null, jev_choice: "ekonomi", question_set: null }),
      labelRow({ task: "clickbait", article_id: "a1", jev_prob: 0.3, jev_choice: null, question_set: null }),
      labelRow({ task: "framing", article_id: "a1", jev_prob: null, jev_choice: "tarafli", question_set: null }),
      labelRow({ task: "sensational", article_id: "a1", jev_prob: 2, jev_choice: null, question_set: null }),
    ];

    const map = labelsFromRows(rows);

    expect(map.size).toBe(1);
    expect(map.get("a1")).toEqual({
      question_set: "qs1",
      politics_p: 0.8,
      topic: "ekonomi",
      clickbait_p: 0.3,
      framing: "tarafli",
      sensational: 2,
    });
  });

  it("coerces jev_prob sent as a string and keeps sensational raw (0..3, not normalised)", () => {
    const rows: RawLabelRow[] = [
      labelRow({ task: "politics", article_id: "a1", jev_prob: "0.87" }),
      labelRow({ task: "sensational", article_id: "a1", jev_prob: "2" }),
    ];

    const labels = labelsFromRows(rows).get("a1")!;

    expect(labels.politics_p).toBe(0.87);
    expect(labels.sensational).toBe(2);
  });

  it("ignores rows with a null article_id and rows whose task is not an ARCHIVE_LABEL_TASK", () => {
    const rows: RawLabelRow[] = [
      labelRow({ task: "politics", article_id: null, jev_prob: 0.9 }),
      labelRow({ task: "politics", article_id: "", jev_prob: 0.9 }),
      labelRow({ task: "unknown_task", article_id: "a1", jev_prob: 0.9 }),
      labelRow({ task: "politics", article_id: "a2", jev_prob: 0.4 }),
    ];

    const map = labelsFromRows(rows);

    expect(map.has("a1")).toBe(false);
    expect(map.size).toBe(1);
    expect(map.get("a2")!.politics_p).toBe(0.4);
  });

  it("takes question_set from the first non-null row and never overwrites it", () => {
    const rows: RawLabelRow[] = [
      labelRow({ task: "politics", article_id: "a1", jev_prob: 0.5, question_set: null }),
      labelRow({ task: "topic", article_id: "a1", jev_choice: "spor", question_set: "qsFirst" }),
      labelRow({ task: "clickbait", article_id: "a1", jev_prob: 0.2, question_set: "qsSecond" }),
    ];

    expect(labelsFromRows(rows).get("a1")!.question_set).toBe("qsFirst");
  });
});

describe("summariseLabels", () => {
  it("reports coverage as the share of articles carrying a politics label, to 3 places", () => {
    const articles = [
      archiveArticle("a1", { politics_p: 0.9 }),
      archiveArticle("a2"),
      archiveArticle("a3"),
    ];

    expect(summariseLabels(articles).coverage).toBe(0.333);
  });

  it("returns coverage 0 and question_set null for an empty day", () => {
    expect(summariseLabels([])).toEqual({
      source: ARCHIVE_LABEL_SOURCE,
      question_set: null,
      coverage: 0,
      declared: true,
    });
  });

  it("picks the most common question_set and breaks a tie lexicographically", () => {
    const majority = [
      archiveArticle("a1", { question_set: "b" }),
      archiveArticle("a2", { question_set: "b" }),
      archiveArticle("a3", { question_set: "a" }),
    ];
    expect(summariseLabels(majority).question_set).toBe("b");

    const tie = [
      archiveArticle("a1", { question_set: "b" }),
      archiveArticle("a2", { question_set: "a" }),
    ];
    expect(summariseLabels(tie).question_set).toBe("a");
  });

  it("always declares the source and declared:true", () => {
    const summary = summariseLabels([archiveArticle("a1", { politics_p: 0.5 })]);
    expect(summary.source).toBe(ARCHIVE_LABEL_SOURCE);
    expect(summary.declared).toBe(true);
  });
});

// --- 7. runArchiveExport ---------------------------------------------------

describe("runArchiveExport", () => {
  it("(a) skips a day that already has a ledger row, touching nothing else", async () => {
    const rec = makePorts({ hasExport: async () => true });

    const result = await runArchiveExport(rec.ports, "2026-09-18");

    expect(result).toEqual({ ok: true, skipped: true, day: "2026-09-18" });
    expect(rec.clusterCalls).toHaveLength(0);
    expect(rec.articleCalls).toHaveLength(0);
    expect(rec.labelCalls).toHaveLength(0);
    expect(rec.uploads).toHaveLength(0);
    expect(rec.records).toHaveLength(0);
  });

  it("(b) uploads clusters, articles and manifest in order, then records one ledger row", async () => {
    const clusters = [cluster({ id: "c1" }), cluster({ id: "c2" })];
    const articles = [
      rawArticle({ id: "a1", cluster_id: "c1" }),
      rawArticle({ id: "a2", cluster_id: "c1", source: [{ slug: "gazete", bias: "gov_leaning" }] }),
      rawArticle({ id: "a3", cluster_id: "c2", source: null }),
    ];
    const rec = makePorts({
      fetchClusters: async (start, end, page) => {
        rec.clusterCalls.push({ start, end, page });
        return page === 0 ? clusters : [];
      },
      fetchArticles: async (ids, page) => {
        rec.articleCalls.push({ ids: [...ids], page });
        return page === 0
          ? { rows: articles, fetched: articles.length }
          : { rows: [], fetched: 0 };
      },
    });

    const result = await runArchiveExport(rec.ports, "2026-09-18", {
      generatedAt: "2026-09-19T03:40:00.000Z",
    });

    expect(rec.uploads.map((u) => u.path)).toEqual([
      "2026/09/18/clusters.jsonl",
      "2026/09/18/articles.jsonl",
      "2026/09/18/manifest.json",
    ]);
    expect(rec.uploads.map((u) => u.contentType)).toEqual([
      "application/x-ndjson",
      "application/x-ndjson",
      "application/json",
    ]);

    const [clustersUpload, articlesUpload, manifestUpload] = rec.uploads as [
      UploadCall,
      UploadCall,
      UploadCall,
    ];
    expect(clustersUpload.body.trimEnd().split("\n")).toHaveLength(2);
    expect(articlesUpload.body.trimEnd().split("\n")).toHaveLength(3);

    const manifest = JSON.parse(manifestUpload.body) as {
      schema: string;
      day: string;
      generated_at: string;
      rows: number;
      bytes: number;
      files: ArchiveFile[];
      labels: ArchiveManifestLabels;
    };
    expect(manifest.schema).toBe("tayf-archive/1");
    expect(manifest.day).toBe("2026-09-18");
    expect(manifest.generated_at).toBe("2026-09-19T03:40:00.000Z");
    expect(manifest.files.map((f) => f.name)).toEqual(["clusters.jsonl", "articles.jsonl"]);
    expect(manifest.files[0]!.sha256).toBe(await sha256Hex(clustersUpload.body));
    expect(manifest.files[1]!.sha256).toBe(await sha256Hex(articlesUpload.body));
    expect(manifest.files[0]!.rows).toBe(2);
    expect(manifest.files[1]!.rows).toBe(3);
    expect(manifest.rows).toBe(5);
    expect(manifest.bytes).toBe(byteLength(clustersUpload.body) + byteLength(articlesUpload.body));
    expect(manifest.labels).toEqual({
      source: ARCHIVE_LABEL_SOURCE,
      question_set: null,
      coverage: 0,
      declared: true,
    });

    expect(rec.records).toEqual([
      {
        day: "2026-09-18",
        object_path: "2026/09/18",
        sha256: await sha256Hex(manifestUpload.body),
        rows: 5,
        bytes: manifest.bytes,
      },
    ]);

    expect(result).toMatchObject({
      ok: true,
      skipped: false,
      day: "2026-09-18",
      object_path: "2026/09/18",
      clusters: 2,
      articles: 3,
      rows: 5,
      sha256: await sha256Hex(manifestUpload.body),
    });
  });

  it("(c) pages clusters by ARCHIVE_PAGE_SIZE and chunks article ids by ARCHIVE_ID_CHUNK", async () => {
    const page0 = Array.from({ length: ARCHIVE_PAGE_SIZE }, (_, i) => cluster({ id: `c${i}` }));
    const page1 = [cluster({ id: "x1" }), cluster({ id: "x2" }), cluster({ id: "x3" })];
    const rec = makePorts({
      fetchClusters: async (start, end, page) => {
        rec.clusterCalls.push({ start, end, page });
        return page === 0 ? page0 : page1;
      },
    });

    const result = await runArchiveExport(rec.ports, "2026-09-18");

    expect(result).toMatchObject({ skipped: false, clusters: 1003, articles: 0 });
    expect(rec.clusterCalls.map((c) => c.page)).toEqual([0, 1]);
    expect(rec.clusterCalls[0]).toEqual({
      start: "2026-09-18T00:00:00.000Z",
      end: "2026-09-19T00:00:00.000Z",
      page: 0,
    });

    expect(rec.articleCalls).toHaveLength(Math.ceil(1003 / ARCHIVE_ID_CHUNK));
    expect(rec.articleCalls).toHaveLength(11);
    expect(rec.articleCalls.every((c) => c.page === 0)).toBe(true);
    expect(rec.articleCalls.every((c) => c.ids.length <= ARCHIVE_ID_CHUNK)).toBe(true);
    expect(rec.articleCalls.at(-1)!.ids).toHaveLength(3);
    expect(rec.articleCalls.flatMap((c) => c.ids)).toHaveLength(1003);
    expect(rec.labelCalls).toHaveLength(0);
  });

  it("(c2) keeps paging articles on a full page even when a member row was dropped", async () => {
    // One member row of a full 1,000-row page had no article embed, so the
    // port returns 999 mapped rows but reports fetched = 1000. Paging must
    // follow `fetched` — stopping on rows.length would truncate the day and
    // still write a green manifest.
    const full = Array.from({ length: ARCHIVE_PAGE_SIZE - 1 }, (_, i) =>
      rawArticle({ id: `a${i}` }),
    );
    const rec = makePorts({
      fetchClusters: async (start, end, page) => {
        rec.clusterCalls.push({ start, end, page });
        return page === 0 ? [cluster()] : [];
      },
      fetchArticles: async (ids, page) => {
        rec.articleCalls.push({ ids: [...ids], page });
        if (page === 0) return { rows: full, fetched: ARCHIVE_PAGE_SIZE };
        if (page === 1) {
          return { rows: [rawArticle({ id: "tail" })], fetched: 1 };
        }
        return { rows: [], fetched: 0 };
      },
    });

    const result = await runArchiveExport(rec.ports, "2026-09-18");

    expect(rec.articleCalls.map((c) => c.page)).toEqual([0, 1]);
    expect(result).toMatchObject({ skipped: false, articles: ARCHIVE_PAGE_SIZE });
  });

  it("(d) writes no ledger row when an upload fails", async () => {
    const rec = makePorts({
      fetchClusters: async (start, end, page) => {
        rec.clusterCalls.push({ start, end, page });
        return page === 0 ? [cluster()] : [];
      },
      upload: async (path, body, contentType) => {
        rec.uploads.push({ path, body, contentType });
        if (path.endsWith("articles.jsonl")) throw new Error("storage 507");
      },
    });

    await expect(runArchiveExport(rec.ports, "2026-09-18")).rejects.toThrow("storage 507");
    expect(rec.records).toHaveLength(0);
  });

  it("(e) throws ArchiveDeadlineError before fetching when the budget is already spent", async () => {
    const ticks = [0, 60_000];
    let i = 0;
    const rec = makePorts({ now: () => ticks[Math.min(i++, ticks.length - 1)]! });

    await expect(
      runArchiveExport(rec.ports, "2026-09-18", { deadlineMs: 1_000 }),
    ).rejects.toBeInstanceOf(ArchiveDeadlineError);

    expect(rec.clusterCalls).toHaveLength(0);
    expect(rec.uploads).toHaveLength(0);
    expect(rec.records).toHaveLength(0);
  });
});

// --- 8. runArchiveExport labels ---------------------------------------------

describe("runArchiveExport labels", () => {
  it("(f) requests labels once per ARCHIVE_ID_CHUNK of DEDUPED article ids, never once per article", async () => {
    const c1Ids = Array.from({ length: 60 }, (_, i) => `a${i}`); // a0..a59
    const c2Ids = ["a0", ...Array.from({ length: 41 }, (_, i) => `a${60 + i}`)]; // a0 shared + a60..a100
    const clusters = [cluster({ id: "c1" }), cluster({ id: "c2" })];
    const members = [
      ...c1Ids.map((id) => rawArticle({ id, cluster_id: "c1" })),
      ...c2Ids.map((id) => rawArticle({ id, cluster_id: "c2" })),
    ];
    const rec = makePorts({
      fetchClusters: async (start, end, page) => {
        rec.clusterCalls.push({ start, end, page });
        return page === 0 ? clusters : [];
      },
      fetchArticles: async (ids, page) => {
        rec.articleCalls.push({ ids: [...ids], page });
        return page === 0 ? { rows: members, fetched: members.length } : { rows: [], fetched: 0 };
      },
    });

    await runArchiveExport(rec.ports, "2026-09-18");

    const distinctIds = new Set(members.map((m) => m.id));
    expect(distinctIds.size).toBe(101);
    expect(rec.labelCalls).toHaveLength(Math.ceil(distinctIds.size / ARCHIVE_ID_CHUNK));
    expect(rec.labelCalls).toHaveLength(2);
    expect(rec.labelCalls.every((chunk) => chunk.length <= ARCHIVE_ID_CHUNK)).toBe(true);
    const flattened = rec.labelCalls.flat();
    expect(flattened).toHaveLength(101);
    expect(new Set(flattened).size).toBe(101);
  });

  it("(g) attaches labels to the matching article and emptyLabels to an article with no prediction row", async () => {
    const clusters = [cluster({ id: "c1" })];
    const members = [rawArticle({ id: "a1", cluster_id: "c1" }), rawArticle({ id: "a2", cluster_id: "c1" })];
    const knownLabels: ArchiveLabels = {
      question_set: "qs",
      politics_p: 0.7,
      topic: "spor",
      clickbait_p: 0.1,
      framing: "tarafsiz",
      sensational: 1,
    };
    const rec = makePorts({
      fetchClusters: async (start, end, page) => (page === 0 ? clusters : []),
      fetchArticles: async (ids, page) =>
        page === 0 ? { rows: members, fetched: members.length } : { rows: [], fetched: 0 },
      fetchLabels: async (ids) => {
        rec.labelCalls.push([...ids]);
        return new Map([["a1", knownLabels]]);
      },
    });

    await runArchiveExport(rec.ports, "2026-09-18");

    const articlesUpload = rec.uploads.find((u) => u.path.endsWith("articles.jsonl"))!;
    const rows = articlesUpload.body
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as ArchiveArticle);
    const a1 = rows.find((r) => r.article_id === "a1")!;
    const a2 = rows.find((r) => r.article_id === "a2")!;

    expect(a1.labels).toEqual(knownLabels);
    expect(a2.labels).toEqual(emptyLabels());
  });

  it("(h) writes the manifest labels block with source, question_set, coverage and declared:true", async () => {
    const clusters = [cluster({ id: "c1" })];
    const members = [
      rawArticle({ id: "a1", cluster_id: "c1" }),
      rawArticle({ id: "a2", cluster_id: "c1" }),
      rawArticle({ id: "a3", cluster_id: "c1" }),
    ];
    const labelsMap = new Map<string, ArchiveLabels>([
      ["a1", { ...emptyLabels(), question_set: "2026-09-21.1", politics_p: 0.6 }],
      ["a2", { ...emptyLabels(), question_set: "2026-09-21.1", politics_p: 0.2 }],
    ]);
    const rec = makePorts({
      fetchClusters: async (start, end, page) => (page === 0 ? clusters : []),
      fetchArticles: async (ids, page) =>
        page === 0 ? { rows: members, fetched: members.length } : { rows: [], fetched: 0 },
      fetchLabels: async () => labelsMap,
    });

    await runArchiveExport(rec.ports, "2026-09-18");

    const manifestUpload = rec.uploads.find((u) => u.path.endsWith("manifest.json"))!;
    const manifest = JSON.parse(manifestUpload.body) as { labels: ArchiveManifestLabels };

    expect(manifest.labels).toEqual({
      source: ARCHIVE_LABEL_SOURCE,
      question_set: "2026-09-21.1",
      coverage: 0.667,
      declared: true,
    });
    expect(Object.keys(JSON.parse(manifestUpload.body))).toEqual([
      "schema",
      "day",
      "generated_at",
      "files",
      "rows",
      "bytes",
      "labels",
    ]);
  });

  it("(i) keeps articles.jsonl deterministic: the same rows in a different label-row order hash identically", async () => {
    const clusters = [cluster({ id: "c1" })];
    const members = [rawArticle({ id: "a1", cluster_id: "c1" }), rawArticle({ id: "a2", cluster_id: "c1" })];
    const rowsOrderA: RawLabelRow[] = [
      labelRow({ task: "politics", article_id: "a1", jev_prob: 0.5, question_set: "qs" }),
      labelRow({ task: "politics", article_id: "a2", jev_prob: 0.4, question_set: "qs" }),
    ];
    const rowsOrderB = [...rowsOrderA].reverse();

    async function runWith(rows: RawLabelRow[]) {
      const rec = makePorts({
        fetchClusters: async (start, end, page) => (page === 0 ? clusters : []),
        fetchArticles: async (ids, page) =>
          page === 0 ? { rows: members, fetched: members.length } : { rows: [], fetched: 0 },
        fetchLabels: async () => labelsFromRows(rows),
      });
      await runArchiveExport(rec.ports, "2026-09-18");
      return rec.uploads.find((u) => u.path.endsWith("articles.jsonl"))!.body;
    }

    const bodyA = await runWith(rowsOrderA);
    const bodyB = await runWith(rowsOrderB);

    expect(bodyA).toBe(bodyB);
  });

  it("(j) still exports the article when its label lookup misses entirely", async () => {
    const clusters = [cluster({ id: "c1" })];
    const members = [rawArticle({ id: "a1", cluster_id: "c1" })];
    const rec = makePorts({
      fetchClusters: async (start, end, page) => (page === 0 ? clusters : []),
      fetchArticles: async (ids, page) =>
        page === 0 ? { rows: members, fetched: members.length } : { rows: [], fetched: 0 },
      fetchLabels: async () => new Map(),
    });

    const result = await runArchiveExport(rec.ports, "2026-09-18");

    expect(result).toMatchObject({ ok: true, skipped: false, articles: 1 });
    const articlesUpload = rec.uploads.find((u) => u.path.endsWith("articles.jsonl"))!;
    const rows = articlesUpload.body
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as ArchiveArticle);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.labels).toEqual(emptyLabels());
  });

  it("(k) a rejecting fetchLabels still exports the day: all-null labels, one recordExport call, ok:true", async () => {
    const clusters = [cluster({ id: "c1" })];
    const members = [
      rawArticle({ id: "a1", cluster_id: "c1" }),
      rawArticle({ id: "a2", cluster_id: "c1" }),
    ];
    const rec = makePorts({
      fetchClusters: async (start, end, page) => (page === 0 ? clusters : []),
      fetchArticles: async (ids, page) =>
        page === 0 ? { rows: members, fetched: members.length } : { rows: [], fetched: 0 },
      fetchLabels: async () => {
        throw new Error("labels chunk failed: PGRST100");
      },
    });

    const result = await runArchiveExport(rec.ports, "2026-09-18");

    expect(result).toMatchObject({ ok: true, skipped: false, articles: 2 });
    expect(rec.records).toHaveLength(1);
    const articlesUpload = rec.uploads.find((u) => u.path.endsWith("articles.jsonl"))!;
    const rows = articlesUpload.body
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as ArchiveArticle);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.labels).toEqual(emptyLabels());
  });

  it("(l) a labels-phase deadline degrades: runArchiveExport resolves, every article carries emptyLabels(), and exactly one ledger row is written", async () => {
    const clusters = [cluster({ id: "c1" })];
    const members = [rawArticle({ id: "a1", cluster_id: "c1" })];
    const rec = makePorts({
      fetchClusters: async (start, end, page) => (page === 0 ? clusters : []),
      fetchArticles: async (ids, page) =>
        page === 0 ? { rows: members, fetched: members.length } : { rows: [], fetched: 0 },
      fetchLabels: async () => {
        throw new ArchiveDeadlineError("labels");
      },
    });

    const result = await runArchiveExport(rec.ports, "2026-09-18");

    expect(result).toMatchObject({ ok: true, skipped: false, articles: 1 });
    expect(rec.records).toHaveLength(1);
    const articlesUpload = rec.uploads.find((u) => u.path.endsWith("articles.jsonl"))!;
    const rows = articlesUpload.body
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as ArchiveArticle);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.labels).toEqual(emptyLabels());
  });
});
