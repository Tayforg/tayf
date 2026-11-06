import { describe, expect, it } from "vitest";

import { sourceExcerpt } from "./source-excerpt";

// ---------------------------------------------------------------------------
// h52-sources-1: the "Son haberler" excerpt on /source/<slug>.
//
// The page printed stripLeadingStyleRules(article.description) behind two
// gates, so the feed residue of cluster summaries showed up there: Sabah, A
// Haber and Yeni Asır end every description "...Devamı için tıklayınız", Diken
// opens "<headline> dd.mm.yyyy Diken" and ends "The post ... appeared first
// on #site_linkat", Medyascope ends with its echoed headline + " Medyascope".
// sourceExcerpt runs the same read-time tidy as the cluster summaries.
//
// The strings below are live `articles.description` rows (read-only SELECT,
// 2026-11-06) copied verbatim, newlines included.
// ---------------------------------------------------------------------------

const SABAH =
  "Başkan Recep Tayyip Erdoğan'ın eşi Emine Erdoğan, AK Parti Genel Merkez Kadın Kolları Başkanlığı ev sahipliğinde düzenlenen '81 İl, 81 Kadın, 81 Hikaye: Bize Özgü Sergisi Açılış Programı'na ilişkin paylaşım...Devamı için tıklayınız";

const DIKEN_TITLE = "Melenchon, cumhurbaşkanı seçilirse Netanyahu'yu tutuklamayı vaat etti";
const DIKEN =
  "Melenchon, cumhurbaşkanı seçilirse Netanyahu'yu tutuklamayı vaat etti 06.11.2026 DikenFransa'da cumhurbaşkanı adayı Jean-Luc Melenchon, seçilmesi halinde Uluslararası Ceza Mahkemesi'nin (UCM) İsrail Başbakanı Binyamin Netanyahu hakkındaki tutuklama emrini uygulamayı vaat etti.\nThe post Melenchon, cumhurbaşkanı seçilirse Netanyahu'yu tutuklamayı vaat etti appeared first on #site_linkat 06.11.2026 .";
const DIKEN_BODY =
  "Fransa'da cumhurbaşkanı adayı Jean-Luc Melenchon, seçilmesi halinde Uluslararası Ceza Mahkemesi'nin (UCM) İsrail Başbakanı Binyamin Netanyahu hakkındaki tutuklama emrini uygulamayı vaat etti.";

const MEDYASCOPE_TITLE =
  "Operasyonlar, erişim engelleri, COP31’de “genel ahlak” şartı: LGBTİ+ gündeminde bu hafta neler yaşandı?";
const MEDYASCOPE =
  "İzmir’de trans kadınlara yönelik gözaltılar, flört uygulamalarına erişim engelleri ve COP31'de “genel ahlak” şartı haftanın gündemindeydi.\nOperasyonlar, erişim engelleri, COP31’de “genel ahlak” şartı: LGBTİ+ gündeminde bu hafta neler yaşandı? Medyascope";
const MEDYASCOPE_BODY =
  "İzmir’de trans kadınlara yönelik gözaltılar, flört uygulamalarına erişim engelleri ve COP31'de “genel ahlak” şartı haftanın gündemindeydi.";

// Same fixtures as summary-tidy.test.ts (h19-ingest-2, h24-feeds-2).
const SERBESTIYET_A6A2 =
  "Fon soruşturmasında şüpheli sıfatıyla ifade veren Takasbank Genel Müdürü Yunus Arıncı, yurt dışına çıkış yasağı ve adli kontrol şartıyla serbest bırakıldıktan sonra görevinden istifa etti. \nTakasbank Genel Müdürü, fon soruşturmasında şüpheli olarak ifade verip istifa etti: Meclis’te Tera’ya finansmanı savunmuştu yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.";
const SERBESTIYET_A6A2_BODY =
  "Fon soruşturmasında şüpheli sıfatıyla ifade veren Takasbank Genel Müdürü Yunus Arıncı, yurt dışına çıkış yasağı ve adli kontrol şartıyla serbest bırakıldıktan sonra görevinden istifa etti.";
const SERBESTIYET_9CAB =
  "DEM Parti İmralı Heyeti Üyesi Pervin Buldan, Abdullah Öcalan’ın İmralı Cezaevi'ndeki yeni bir bölüme kalıcı olarak geçtiğini açıkladı\nPervin Buldan: “Öcalan yeni yerine taşındı ama bu ona statü kazandırmıyor, süreçte tıkanma var” yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.";
const SERBESTIYET_9CAB_BODY =
  "DEM Parti İmralı Heyeti Üyesi Pervin Buldan, Abdullah Öcalan’ın İmralı Cezaevi'ndeki yeni bir bölüme kalıcı olarak geçtiğini açıkladı";

// Açık Gazete: WordPress excerpt marker "[…]" and "The post ... appeared first
// on AÇIK GAZETE." (the second row is the feed's own cut, "AÇIK GAZ...").
const ACIK_FULL_TITLE = "Fatma Betül Sayan Kaya tutuklandı!";
const ACIK_FULL =
  "BirGün – Fon vurgunu soruşturmasında eski bakan, milletvekili ve AKP Genel Başkan Yardımcısı Fatma Betül Sayan Kaya tutuklandı. Yaklaşık 163 milyon TL’lik Özata Denizcilik hissesi alım satımından eşi İlyas Kaya ile birlikte 2,17 milyar TL gelir elde ettiği iddiasıyla soruşturulan Kaya hakkında örgüt üyeliği ve Sermaye Piyasası Kanunu’na muhalefet suçlamaları yöneltildi. Kaya’nın fonların tasfiyesinden bir […]\nThe post Fatma Betül Sayan Kaya tutuklandı! appeared first on AÇIK GAZETE.";
const ACIK_CUT_TITLE = "Kabul edilen Mekke Anlaşması’na hangi parti ne oy verdi?";
const ACIK_CUT =
  "EVRENSEL – Türkiye, Pakistan ve Suudi Arabistan arasında imzalanan Mekke Anlaşması, TBMM Genel Kurulunda kabul edildi. AKP’den 222, CHP’den 25, MHP’den 24 milletvekili kabul oyu verirken 118 vekil anlaşmaya karşı çıktı, 197 milletvekili ise oylamaya katılmadı. Türkiye, Pakistan ve Suudi Arabistan arasında imzalanan Mekke Anlaşması, TBMM Genel Kurulunda kabul edildi. Dün yapılan oylamada 277 kabul, […]\nThe post Kabul edilen Mekke Anlaşması’na hangi parti ne oy verdi? appeared first on AÇIK GAZ...";

// Bir Gazete: "<headline> yazısı ilk önce Bir Gazete - ... üzerinde ortaya çıktı."
// (the second row is the feed's own cut, "... yazısı ilk önce Bir...").
const BIR_FULL_TITLE = "Türkiye’de orman yangınları yüzde 35 azaldı";
const BIR_FULL =
  "Tarım ve Orman Bakanı İbrahim Yumaklı, 2026 yılında Türkiye genelinde 2 bin 111’i orman, 4 bin 108’i kırsal alan olmak üzere toplam 6 bin 219 yangına müdahale edildiğini açıkladı. Geçen yıla göre orman yangını sayısının yüzde 35, yangınlardan etkilenen orman alanının ise yüzde 68 azaldığını belirten Yumaklı, yangınların yüzde 86’sının insan kaynaklı olduğunu bildirdi. ANKARA...\nTürkiye’de orman yangınları yüzde 35 azaldı yazısı ilk önce Bir Gazete - Bir Gazete, Son Dakika üzerinde ortaya çıktı.";
const BIR_CUT_TITLE = "Türkiye ve Katar savunma sanayiinde yeni projeleri görüştü";
const BIR_CUT =
  "Cumhurbaşkanlığı Savunma Sanayii Başkanı Haluk Görgün, Katar Başbakan Yardımcısı ve Savunma İşlerinden Sorumlu Devlet Bakanı Şeyh Suud Al Sani ile bir araya geldi. Görüşmede iki ülke arasında yeni savunma sanayii projelerinin geliştirilmesi, teknoloji transferi ve ortak üretim imkânları ele alındı. ANKARA – BHA Cumhurbaşkanlığı Savunma Sanayii Başkanı Haluk Görgün, Katar Başbakan Yardımcısı ve Savunma İşlerinden...\nTürkiye ve Katar savunma sanayiinde yeni projeleri görüştü yazısı ilk önce Bir...";

// What must be gone from every excerpt. The first five alternatives are the
// markers the h52 replay greps over 48 hours of live rows; the rest catch the
// footer pieces that survive when only part of a footer is recognised.
const RESIDUE =
  /Devamı için tıklay|appeared first on|ilk önce|\d{2}\.\d{2}\.\d{4} Diken| Medyascope$|The post |\[…\]|yayınlanmıştır|ortaya çıktı\.$/;

describe("sourceExcerpt: feed residue the cluster summaries already lose", () => {
  it("drops the Sabah / A Haber / Yeni Asır 'Devamı için tıklayınız' tail and keeps the text before it", () => {
    const out = sourceExcerpt("Emine Erdoğan sergi açılışına ilişkin paylaşım yaptı", SABAH);
    expect(out).not.toContain("Devamı için");
    expect(out.endsWith("paylaşım...")).toBe(true);
    expect(out.startsWith("Başkan Recep Tayyip Erdoğan'ın eşi Emine Erdoğan")).toBe(true);
  });

  it("drops the Diken '<headline> dd.mm.yyyy Diken' lead and the 'The post ... appeared first on' footer", () => {
    expect(sourceExcerpt(DIKEN_TITLE, DIKEN)).toBe(DIKEN_BODY);
  });

  it("drops the Medyascope echoed headline and its site name, keeping the first sentence", () => {
    expect(sourceExcerpt(MEDYASCOPE_TITLE, MEDYASCOPE)).toBe(MEDYASCOPE_BODY);
  });

  it.each([
    ["Serbestiyet a6a2f0bd", "Takasbank Genel Müdürü istifa etti", SERBESTIYET_A6A2, SERBESTIYET_A6A2_BODY],
    ["Serbestiyet 9cab88ae", "Pervin Buldan: Öcalan yeni yerine taşındı", SERBESTIYET_9CAB, SERBESTIYET_9CAB_BODY],
  ])("%s: the 'yazısı ilk önce ... adresinde yayınlanmıştır.' footer goes", (_name, title, description, body) => {
    const out = sourceExcerpt(title, description);
    expect(out).toBe(body);
    expect(out).not.toContain("ilk önce");
    expect(out).not.toContain("appeared first");
  });

  it.each([
    ["Açık Gazete (full footer)", ACIK_FULL_TITLE, ACIK_FULL],
    ["Bir Gazete (footer cut by the feed)", BIR_CUT_TITLE, BIR_CUT],
  ])("%s: no footer piece is left", (_name, title, description) => {
    const out = sourceExcerpt(title, description);
    expect(out).not.toBe("");
    expect(out).not.toContain("ilk önce");
    expect(out).not.toContain("appeared first");
    expect(out).not.toMatch(RESIDUE);
  });

  // Known gaps of tidySummaryText itself (h52-sources-1 does not widen it):
  //  - Bir Gazete's full footer reads "<headline> yazısı ilk önce Bir Gazete -
  //    Bir Gazete, Son Dakika üzerinde ortaya çıktı."; the Yoast footer rule only
  //    knows "... adresinde yayınlanmıştır.".
  //  - Açık Gazete's footer is cut in half by the 500-character ingest clamp, and
  //    the clamp repair keeps "[…] The post <headline>?".
  // `it.fails` passes while the gap is open and turns red once summary-tidy.ts
  // learns the pattern, which is the cue to move the case into the list above.
  it.fails("known gap: Bir Gazete full footer ('üzerinde ortaya çıktı.') is not recognised yet", () => {
    expect(sourceExcerpt(BIR_FULL_TITLE, BIR_FULL)).not.toMatch(RESIDUE);
  });

  it.fails("known gap: an Açık Gazete footer cut by the ingest clamp keeps '[…] The post ...'", () => {
    expect(sourceExcerpt(ACIK_CUT_TITLE, ACIK_CUT)).not.toMatch(RESIDUE);
  });

  it("puts a space between sentences the tag stripper glued ('dedi.Cumhurbaşkanlığı')", () => {
    const out = sourceExcerpt(
      "Cumhurbaşkanlığı açıklama yaptı",
      "Bakan toplantının yarın yapılacağını söyledi dedi.Cumhurbaşkanlığı kaynakları ayrıntıları paylaştı.",
    );
    expect(out).toContain("dedi. Cumhurbaşkanlığı");
    expect(out).not.toContain("dedi.Cumhurbaşkanlığı");
  });

  it("collapses raw newlines into a one-line excerpt", () => {
    expect(sourceExcerpt("Başlık", "Birinci cümle burada bitti.\nİkinci cümle de burada.")).toBe(
      "Birinci cümle burada bitti. İkinci cümle de burada.",
    );
  });
});

describe("sourceExcerpt: the order of the checks", () => {
  it("runs the headline-echo check on the tidied text, not on the raw description", () => {
    // Raw: "Sabah başlığı burada...Devamı için tıklayınız" is not the title.
    // Tidied: "Sabah başlığı burada..." is the title again (cut with an ellipsis).
    expect(sourceExcerpt("Sabah başlığı burada yazıyor", "Sabah başlığı burada...Devamı için tıklayınız")).toBe("");
    expect(sourceExcerpt("Sabah başlığı", "Sabah başlığı.\nDevamı için tıklayınız")).toBe("");
  });

  it("runs the boilerplate check on the tidied text", () => {
    // Only a CTA is left once the wrappers are gone.
    expect(sourceExcerpt("Bir başlık", "Devamı için tıklayınız")).toBe("");
    expect(sourceExcerpt("Bir başlık", "Detaylar haberimizde...")).toBe("");
  });

  it("an excerpt that is only a footer is '' (so the page renders no empty paragraph)", () => {
    expect(sourceExcerpt("Başlık", "The post Başlık appeared first on #site_linkat 06.11.2026 .")).toBe("");
    expect(sourceExcerpt("Başlık", "Başlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.")).toBe("");
  });

  it("a Diken text whose body is the headline again is an echo and shows nothing", () => {
    const description = `${DIKEN_TITLE} 06.11.2026 Diken${DIKEN_TITLE}\nThe post ${DIKEN_TITLE} appeared first on #site_linkat 06.11.2026 .`;
    expect(sourceExcerpt(DIKEN_TITLE, description)).toBe("");
  });
});

describe("sourceExcerpt: what it must keep or hide as before (h48-ingest-1)", () => {
  const ELIPS_CSS =
    "BODY { font-family: Calibri, Arial; font-size: 12pt; margin : 15px; background-color:#FFFAF4; }\n" +
    "        table { border:1px solid #B96F00; margin-top:10px; margin-bottom:10px; background-color:white; }\n" +
    "        td { border:1px solid #B96F00; font-size: 12pt; padding:1 3 1 5; }\n\nİLANEN TEBLİGAT...";

  it("still strips a leading style sheet (Elips Haber) and shows what follows it", () => {
    const out = sourceExcerpt("Elips ilan başlığı", ELIPS_CSS);
    expect(out).toBe("İLANEN TEBLİGAT...");
  });

  it("a text that is nothing but a style sheet is ''", () => {
    expect(sourceExcerpt("Elips ilan", "BODY { font-family: Calibri; }\n td { padding: 2px; }")).toBe("");
  });

  it("an excerpt that equals the title once the sheet is gone is ''", () => {
    expect(sourceExcerpt("İLANEN TEBLİGAT...", ELIPS_CSS)).toBe("");
  });

  it.each([
    "Korkusuz haber başlığı",
    "  KORKUSUZ HABER BAŞLIĞI. ",
    "Korkusuz haber baş...",
  ])("a description that is the title again (%j) is ''", (description) => {
    expect(sourceExcerpt("Korkusuz haber başlığı", description)).toBe("");
  });

  it.each(["Ayrıntılar geliyor...", "Detaylar gelecek…", "DETAYLAR GELİYOR...", "Click to continue", "Ayrıntılar birazdan...", ".", "…", "..."])(
    "the placeholder %j is ''",
    (description) => {
      expect(sourceExcerpt("Bir başlık", description)).toBe("");
    },
  );

  it("a placeholder first line hides the other story's headline behind it", () => {
    expect(sourceExcerpt("Bir başlık", "Ayrıntılar geliyor...\n\n\n\nKKTC Başbakanı Üstel, ... teşekkür etti")).toBe("");
  });

  it("a plain one-sentence description comes back unchanged", () => {
    const description = "Düzenleme gelecek ay yürürlüğe girecek.";
    expect(sourceExcerpt("Bakan Yılmaz yeni vergiyi açıkladı", description)).toBe(description);
  });

  it("a description that starts with the title and goes on is kept", () => {
    const description = "Korkusuz haber başlığı. Devamında ayrıntılar ve açıklamalar yer alıyor.";
    expect(sourceExcerpt("Korkusuz haber başlığı", description)).toBe(description);
  });
});

describe("sourceExcerpt: empty and odd input", () => {
  it.each([null, undefined, "", "   ", "\n\n", "\t"])("%j gives ''", (description) => {
    expect(sourceExcerpt("Bir başlık", description)).toBe("");
  });

  it("an empty title never hides a real description", () => {
    expect(sourceExcerpt("", "Gerçek bir özet cümlesi burada.")).toBe("Gerçek bir özet cümlesi burada.");
  });

  it("keeps Unicode, emoji and SQL-looking characters as they are", () => {
    const description = "İstanbul'da 🔥 yangın çıktı; \"DROP TABLE articles;--\" yazılı bir not bulundu.";
    expect(sourceExcerpt("Yangın", description)).toBe(description);
  });

  it("is idempotent on its own output", () => {
    for (const [title, description] of [
      [DIKEN_TITLE, DIKEN],
      [MEDYASCOPE_TITLE, MEDYASCOPE],
      ["Sabah", SABAH],
      ["Serbestiyet", SERBESTIYET_A6A2],
    ] as const) {
      const once = sourceExcerpt(title, description);
      expect(sourceExcerpt(title, once)).toBe(once);
    }
  });

  it("a 100k-character description finishes in well under a second", () => {
    const started = Date.now();
    sourceExcerpt("Başlık", "Bu bir cümle. ".repeat(7_000));
    sourceExcerpt("Başlık", "a".repeat(100_000));
    sourceExcerpt("Başlık", `${" ".repeat(100_000)}Devamı için tıklayınız`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
