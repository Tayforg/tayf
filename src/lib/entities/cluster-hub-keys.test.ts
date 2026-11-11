import { describe, expect, it } from "vitest";

import { entityKeysIn } from "@/lib/clusters/related-clusters";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";
import { expectCpuUnder } from "../../../tests/_helpers/linear-time";
import {
  CLUSTER_HUB_KEYS_MAX,
  CLUSTER_HUB_TEXT_MAX_CHARS,
  clusterHubKeys,
  clusterHubKeysFromDetail,
  type ClusterHubRow,
} from "./cluster-hub-keys";

// The story page names the /gundem hubs its headline names, with the hub's own
// matching rule (entityHubPatterns: requires, excludes, hubExcludes, notAfter,
// headlineOnly for akp). These tests pin the pieces of that rule the page
// depends on; the hub's own behaviour samples live in entity-hub.test.ts.

const LIVE: ClusterHubRow = {
  title_tr: null,
  title_tr_neutral: null,
  summary_tr: null,
  article_count: 3,
  is_archived: false,
  merged_into: null,
};

function row(overrides: Partial<ClusterHubRow>): ClusterHubRow {
  return { ...LIVE, ...overrides };
}

const ORDER = new Map(RISING_ENTITIES.map((e, i) => [e.key, i]));

function inRisingOrder(keys: readonly string[]): string[] {
  return [...keys].sort((a, b) => (ORDER.get(a) as number) - (ORDER.get(b) as number));
}

describe("clusterHubKeys: what the headline names", () => {
  it("(a) names chp for a CHP headline", () => {
    const keys = clusterHubKeys(
      row({
        title_tr: "CHP'nin 38'inci Olağan Kurultayı davasında yeni gelişme: Dava ertelendi",
      }),
    );
    expect(keys).toContain("chp");
  });

  it("reads the neutral title as well as the original (the RPC reads both)", () => {
    expect(
      clusterHubKeys(row({ title_tr: "Yeni gelişme", title_tr_neutral: "CHP'den yeni açıklama" })),
    ).toEqual(["chp"]);
    expect(
      clusterHubKeys(row({ title_tr: "CHP'den yeni açıklama", title_tr_neutral: "Yeni gelişme" })),
    ).toEqual(["chp"]);
  });

  it("(b) akp is headline-only: the summary lead's epithet does not name the party, a headline does", () => {
    const lead = "Eski AK Parti milletvekili Ertan Aydın hakkında yeni gelişme yaşandı";
    expect(
      clusterHubKeys(row({ title_tr: "Fon soruşturmasında yeni gelişme", summary_tr: lead })),
    ).not.toContain("akp");
    expect(clusterHubKeys(row({ title_tr: lead, summary_tr: "Özet" }))).toContain("akp");
    expect(
      clusterHubKeys(row({ title_tr: "Fon soruşturması", title_tr_neutral: lead })),
    ).toContain("akp");
  });

  it("every other hub keeps the summary's first line (chp named only in the lead still counts)", () => {
    expect(
      clusterHubKeys(
        row({ title_tr: "Kurultay davasında yeni gelişme", summary_tr: "CHP lideri Özel açıklama yaptı" }),
      ),
    ).toContain("chp");
  });

  it("(c) ignores the summary after its first line break", () => {
    const summary = "Genel bir haber metni.\nCHP lideri Özel açıklama yaptı";
    expect(clusterHubKeys(row({ title_tr: "Yeni gelişme", summary_tr: summary }))).toEqual([]);
    expect(
      clusterHubKeys(row({ title_tr: "Yeni gelişme", summary_tr: "CHP lideri açıklama yaptı\nDevamı" })),
    ).toEqual(["chp"]);
  });

  it("(d) Emine Erdoğan is not the President; the President is", () => {
    expect(
      clusterHubKeys(
        row({ title_tr: "Emine Erdoğan'dan anlamlı mesaj: Kadınlar sanatın ve zanaatın atan kalbidir" }),
      ),
    ).not.toContain("erdogan");
    expect(clusterHubKeys(row({ title_tr: "Cumhurbaşkanı Erdoğan açıklama yaptı" }))).toContain(
      "erdogan",
    );
  });

  it("(e) another country's central bank with no monetary cue is not tcmb (the Paraguay card of h61)", () => {
    const paraguay =
      "Paraguay'da ülkenin en büyük bankalarından biri battı, Devlet Başkanı Pena istifa etti " +
      "Ueno Bank'ın batmasının ardından Paraguay Devlet Başkanı Santiago Pena görevi bıraktı " +
      "Paraguay'da yaklaşık 2,9 milyon müşterisi olan Ueno Bank'ın sermaye yeterlilik oranının zorunlu asgari " +
      "seviyenin yüzde 50'sinin altına düştüğü tespit edildi. Merkez Bankası bankaya el koyup tasfiyeyi " +
      "başlattı; kriz ortamında Devlet Başkanı Santiago Pena istifa etti.";
    expect(clusterHubKeys(row({ title_tr: paraguay }))).not.toContain("tcmb");
  });

  it("(e2) shares the hub's own residue: a generic cue ('faiz') lets a foreign bank in on both sides", () => {
    // /gundem/tcmb lists such a story too (entity-hub.ts, "Residue: a generic word still lets a foreign
    // bank in"), so the chip matching it is parity, not a leak. The chip must never be stricter or looser
    // than the hub; tightening it alone would hide a hub that does list the story.
    expect(clusterHubKeys(row({ title_tr: "Paraguay Merkez Bankası faiz kararı" }))).toContain("tcmb");
    expect(clusterHubKeys(row({ title_tr: "Avrupa Merkez Bankası faiz kararı" }))).not.toContain(
      "tcmb",
    );
  });

  it("meclis needs its cue and the hub-only vetoes (Parti Meclisi is not the TBMM)", () => {
    expect(clusterHubKeys(row({ title_tr: "TBMM Genel Kurulu'nda yeni teklif görüşüldü" }))).toContain(
      "meclis",
    );
    expect(clusterHubKeys(row({ title_tr: "İTO meclis toplantısı yapıldı" }))).not.toContain("meclis");
  });

  it("folds Turkish capitals like the hub does (ÖZGÜR ÖZEL, İMAMOĞLU)", () => {
    expect(clusterHubKeys(row({ title_tr: "ÖZGÜR ÖZEL ve İMAMOĞLU buluştu" }))).toEqual([
      "ozgur-ozel",
      "imamoglu",
    ]);
  });

  it("(f) follows RISING_ENTITIES order and caps at 5 by default", () => {
    const title =
      "Trump, Erdoğan, MHP, CHP ve AK Parti liderleri Putin, Rusya ve İran konusunda görüştü";
    const all = clusterHubKeys(row({ title_tr: title }), RISING_ENTITIES.length);
    expect(all.length).toBeGreaterThan(CLUSTER_HUB_KEYS_MAX);
    expect(all).toEqual(inRisingOrder(all));
    expect(all.slice(0, 5)).toEqual(["akp", "chp", "mhp", "erdogan", "trump"]);

    expect(CLUSTER_HUB_KEYS_MAX).toBe(5);
    expect(clusterHubKeys(row({ title_tr: title }))).toEqual(all.slice(0, 5));
    expect(clusterHubKeys(row({ title_tr: title }), 2)).toEqual(["akp", "chp"]);
    expect(clusterHubKeys(row({ title_tr: title }), 0)).toEqual([]);
    expect(clusterHubKeys(row({ title_tr: title }), -3)).toEqual([]);
    expect(clusterHubKeys(row({ title_tr: title }), Number.NaN)).toEqual(all.slice(0, 5));
  });

  it("(g) a hub lists only live clusters of two or more articles: anything else gets no chips", () => {
    const title = "CHP'nin Olağan Kurultayı davasında yeni gelişme";
    expect(clusterHubKeys(row({ title_tr: title, article_count: 2 }))).toEqual(["chp"]);
    expect(clusterHubKeys(row({ title_tr: title, article_count: 1 }))).toEqual([]);
    expect(clusterHubKeys(row({ title_tr: title, article_count: 0 }))).toEqual([]);
    expect(clusterHubKeys(row({ title_tr: title, article_count: Number.NaN }))).toEqual([]);
    expect(clusterHubKeys(row({ title_tr: title, is_archived: true }))).toEqual([]);
    expect(
      clusterHubKeys(row({ title_tr: title, merged_into: "0b2e6dc8-aaaa-4bbb-8ccc-000000000001" })),
    ).toEqual([]);
  });

  it("(h) parity with entityKeysIn on titles, re-sorted into RISING_ENTITIES order", () => {
    const titles = [
      "CHP'nin 38'inci Olağan Kurultayı davasında yeni gelişme: Dava ertelendi",
      "Erdoğan ve Putin görüşmesinde Ukrayna, İran ve Suriye gündemdeydi",
      "Merkez Bankası faizi sabit tuttu, dolar ve borsa güne yükselişle başladı",
      "AK Parti Grup Başkanı Güler: Meclis'te yeni anayasa çalışması sürüyor",
      "Emine Erdoğan'dan anlamlı mesaj: Kadınlar sanatın ve zanaatın atan kalbidir",
      "Polonya'da polis Anayasa Mahkemesi'ni bastı",
      "Çin borsası sert düştü, ABD'de enflasyon beklentisi yükseldi",
    ];
    for (const title of titles) {
      expect(
        clusterHubKeys(row({ title_tr: title, summary_tr: "" }), RISING_ENTITIES.length),
        title,
      ).toEqual(inRisingOrder(entityKeysIn(title)));
    }
    // The fixtures must name something, or the equality above says nothing.
    expect(titles.filter((t) => entityKeysIn(t).length > 0).length).toBeGreaterThanOrEqual(5);
  });
});

describe("clusterHubKeys: bad and extreme input", () => {
  it("returns [] for null, empty and non-string fields without throwing", () => {
    expect(clusterHubKeys(row({}))).toEqual([]);
    expect(clusterHubKeys(row({ title_tr: "", title_tr_neutral: "", summary_tr: "" }))).toEqual([]);
    expect(
      clusterHubKeys(
        row({
          title_tr: 12 as unknown as string,
          title_tr_neutral: {} as unknown as string,
          summary_tr: ["CHP"] as unknown as string,
        }),
      ),
    ).toEqual([]);
    expect(clusterHubKeys(null as unknown as ClusterHubRow)).toEqual([]);
    expect(clusterHubKeys(undefined as unknown as ClusterHubRow)).toEqual([]);
  });

  it("treats SQL characters, emoji and markup as plain text", () => {
    expect(clusterHubKeys(row({ title_tr: "CHP 😀 '; drop table clusters; -- <b>x</b>" }))).toEqual(["chp"]);
  });

  it("does not match inside a longer word (the hub's \\M and \\m)", () => {
    expect(clusterHubKeys(row({ title_tr: "Chpx ve xchp denemesi" }))).toEqual([]);
  });

  it("reads at most CLUSTER_HUB_TEXT_MAX_CHARS and stays cheap on a huge summary", () => {
    expect(CLUSTER_HUB_TEXT_MAX_CHARS).toBe(2000);
    const filler = "x ".repeat(CLUSTER_HUB_TEXT_MAX_CHARS);
    const huge = row({
      title_tr: "Yeni gelişme",
      summary_tr: `${filler}CHP ${"y ".repeat(500_000)}`,
    });
    // CPU time, not wall clock (tests/_helpers/linear-time.ts): the cut bounds the work at 2,000 characters,
    // so a 1 MB lead costs what a short one does. The ceiling is generous; a scan of the whole lead is not.
    expectCpuUnder(() => clusterHubKeys(huge), 100);
    // The name sits past the cap: not read.
    expect(clusterHubKeys(huge)).toEqual([]);
    // ...and just inside it, it is.
    expect(
      clusterHubKeys(row({ title_tr: "Yeni gelişme", summary_tr: `${"x ".repeat(900)}CHP` })),
    ).toEqual(["chp"]);
  });

  it("answers 1,000 stories at a modest CPU cost (the page does one per request)", () => {
    const sample = row({
      title_tr: "Erdoğan ve Putin görüşmesinde Ukrayna, İran ve Suriye gündemdeydi",
      summary_tr: "Cumhurbaşkanı Erdoğan, Rusya Devlet Başkanı Putin ile telefonda görüştü. ".repeat(20),
    });
    expectCpuUnder(() => {
      for (let i = 0; i < 1000; i += 1) clusterHubKeys(sample);
    }, 4000);
  });

  it("returns a fresh array each call", () => {
    const a = clusterHubKeys(row({ title_tr: "CHP" }));
    a.push("zzz");
    expect(clusterHubKeys(row({ title_tr: "CHP" }))).toEqual(["chp"]);
  });
});

describe("clusterHubKeysFromDetail: the page's cluster shape", () => {
  // ClusterDetail.cluster carries the DISPLAYED title in title_tr (the neutral rewrite when there is one)
  // and the outlet's original in title_original (null when nothing was replaced). The RPC reads the
  // stored pair, so the two are mapped back to it.
  const DETAIL = {
    title_tr: "Yeni gelişme",
    title_original: null as string | null,
    summary_tr: "",
    article_count: 3,
    is_archived: false,
    merged_into: undefined as string | null | undefined,
  };

  it("reads the displayed title when nothing was replaced", () => {
    expect(clusterHubKeysFromDetail({ ...DETAIL, title_tr: "CHP'den yeni açıklama" })).toEqual(["chp"]);
  });

  it("reads both the neutral title and the original one when the headline was rewritten", () => {
    expect(
      clusterHubKeysFromDetail({
        ...DETAIL,
        title_tr: "Tarafsız başlık",
        title_original: "CHP'den sert tepki",
      }),
    ).toEqual(["chp"]);
    expect(
      clusterHubKeysFromDetail({
        ...DETAIL,
        title_tr: "AK Parti'den açıklama",
        title_original: "Sert tepki geldi",
      }),
    ).toEqual(["akp"]);
  });

  it("applies the same eligibility rules (a missing merged_into is null)", () => {
    const title = "CHP'den yeni açıklama";
    expect(clusterHubKeysFromDetail({ ...DETAIL, title_tr: title, merged_into: undefined })).toEqual(["chp"]);
    expect(clusterHubKeysFromDetail({ ...DETAIL, title_tr: title, article_count: 1 })).toEqual([]);
    expect(clusterHubKeysFromDetail({ ...DETAIL, title_tr: title, is_archived: true })).toEqual([]);
    expect(
      clusterHubKeysFromDetail({
        ...DETAIL,
        title_tr: title,
        merged_into: "0b2e6dc8-aaaa-4bbb-8ccc-000000000001",
      }),
    ).toEqual([]);
  });

  it("honours the cap", () => {
    const title = "Trump, Erdoğan, MHP, CHP ve AK Parti liderleri Putin, Rusya ve İran konusunda görüştü";
    expect(clusterHubKeysFromDetail({ ...DETAIL, title_tr: title }, 3)).toEqual(["akp", "chp", "mhp"]);
  });
});
