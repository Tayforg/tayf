import { describe, it, expect } from "vitest";
import { isAcceptableNeutral, pickNeutralTitle } from "./neutral-title";

// ---------------------------------------------------------------------------
// The picker side of migration 184 (h94-neutraltitles-1): what the headline cron's re-pick gets when it passes
// { floor } for a stored title that fails the gate.
//
// Migration 169 re-offers a stamped title that fails the length or '?' gate; 184 adds the all-capitals title (letters, no
// lower case) and the cluster stamped at 2 members that has grown to 3 or 4. The all-capitals title never healed because
// the re-pick ran without { floor }: shouting is a gate defect, so no member passes, and the picker answers null (the
// cron then keeps and stamps the stored title). The cron now passes { floor: !isAcceptableNeutral(stored, members) }.
//
// These pins are about FLOOR versus NO FLOOR and the all-capitals repair, the parts of the picker that the migration relies
// on. They deliberately say nothing about how two acceptable titles are ranked (scoring, margins, the incumbent switch
// rules): those are neutral-title.test.ts's, and 184 does not touch them. The two members of 09f152ec and the two of
// fe2c6725 are the live clusters' titles (production, read-only, 2026-11-09).
//
// Not pinned here, on purpose (hand-checked in the PR's replay, not tuned): 459a7b61, 4f8dbda9 and 7c1e5cde change to the
// fresh pick when they are re-offered, and 45303a94 and 81630164 keep their stored title. Those outcomes are scoring, and
// scoring is another change's business.
// ---------------------------------------------------------------------------

/** A lower-case Turkish letter (the migration's class, dotless i and circumflexed vowels included). */
const LOWER_TR = /[a-zçğıöşüâîû]/;

const SHOUT_09F152EC = "NEV'İN MİRASI GÜNDEM OLDU";
const MEMBERS_09F152EC = [
  { title: SHOUT_09F152EC },
  { title: "Nev’in ağabeyi miras için harekete mi geçti? Avukatından sert yanıt: 'Küslük söz konusu değil'" },
];

const SHOUT_FE2C6725 = "PENDİK VERGİ DAİRESİ MÜDÜRLÜĞÜ PENDİK VERGİ DAİRESİ";
const MEMBERS_FE2C6725 = [{ title: SHOUT_FE2C6725 }, { title: "PENDİK VERGİ DAİRESİ MÜDÜRLÜĞÜ" }];

const titlesOf = (items: Array<{ title: string }>): string[] => items.map((m) => m.title);

describe("the cron's floor condition: a shouted stored title fails the gate, so the re-pick asks for the floor", () => {
  it("09f152ec and fe2c6725: isAcceptableNeutral(stored, member titles) is false", () => {
    expect(isAcceptableNeutral(SHOUT_09F152EC, titlesOf(MEMBERS_09F152EC))).toBe(false);
    expect(isAcceptableNeutral(SHOUT_FE2C6725, titlesOf(MEMBERS_FE2C6725))).toBe(false);
  });

  it("the repaired titles pass it, so a second re-pick would not ask for the floor again", () => {
    expect(isAcceptableNeutral("Nev'in mirası gündem oldu", titlesOf(MEMBERS_09F152EC))).toBe(true);
  });
});

describe("09f152ec 'NEV'İN MİRASI GÜNDEM OLDU': floor versus no floor", () => {
  it("without the floor the pick is null: no member passes the gate, so the cron kept the shouted title (the defect)", () => {
    expect(pickNeutralTitle(MEMBERS_09F152EC, { incumbent: SHOUT_09F152EC })).toBeNull();
  });

  it("with { incumbent, floor: true } the pick is the sentence-cased title (neutral-title.ts cites it as the fixed form)", () => {
    expect(pickNeutralTitle(MEMBERS_09F152EC, { incumbent: SHOUT_09F152EC, floor: true })).toBe("Nev'in mirası gündem oldu");
  });

  it("the repair holds a lower-case letter, so it no longer matches migration 184's shout branch", () => {
    const repaired = pickNeutralTitle(MEMBERS_09F152EC, { incumbent: SHOUT_09F152EC, floor: true });
    expect(repaired).not.toBeNull();
    expect(repaired as string).toMatch(LOWER_TR);
    expect(repaired).not.toBe(SHOUT_09F152EC);
  });

  it("the Turkish capital İ becomes i, not an ASCII-folded I or a dotted-capital leftover", () => {
    const repaired = pickNeutralTitle(MEMBERS_09F152EC, { incumbent: SHOUT_09F152EC, floor: true }) as string;
    expect(repaired).toContain("Nev'in");
    expect(repaired).toContain("mirası");
    expect(repaired).not.toContain("İ");
    expect(repaired).not.toContain("I");
  });
});

describe("fe2c6725 'PENDİK VERGİ DAİRESİ MÜDÜRLÜĞÜ PENDİK VERGİ DAİRESİ': members that all shout", () => {
  it("without the floor the pick is null", () => {
    expect(pickNeutralTitle(MEMBERS_FE2C6725, { incumbent: SHOUT_FE2C6725 })).toBeNull();
  });

  it("with the floor the pick holds a lower-case letter and starts with a capital", () => {
    const repaired = pickNeutralTitle(MEMBERS_FE2C6725, { incumbent: SHOUT_FE2C6725, floor: true });
    expect(repaired).not.toBeNull();
    expect(repaired as string).toMatch(LOWER_TR);
    expect(repaired).not.toBe(SHOUT_FE2C6725);
    expect((repaired as string).startsWith("Pendik vergi dairesi")).toBe(true);
  });

  it("the repair is a member's own wording, only recased: it reads the same as a member title in lower case", () => {
    const repaired = pickNeutralTitle(MEMBERS_FE2C6725, { incumbent: SHOUT_FE2C6725, floor: true }) as string;
    const folded = repaired.toLocaleLowerCase("tr");
    expect(titlesOf(MEMBERS_FE2C6725).map((t) => t.toLocaleLowerCase("tr"))).toContain(folded);
  });
});

describe("the floor does not touch a stored title that passes the gate", () => {
  const GOOD = [
    { title: "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı" },
    { title: "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı" },
    { title: "Bakırköy Belediyesine yönelik soruşturmada 39 şüpheli tutuklandı" },
  ];

  it("an acceptable incumbent that is a member's title is returned as passed, with or without the floor", () => {
    const stored = "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı";
    expect(isAcceptableNeutral(stored, titlesOf(GOOD))).toBe(true);
    const noFloor = pickNeutralTitle(GOOD, { incumbent: stored });
    const withFloor = pickNeutralTitle(GOOD, { incumbent: stored, floor: true });
    expect(withFloor).toBe(noFloor);
  });

  it("a stored title that passes the gate and that no member carries is not turned into a floor title", () => {
    const noFloor = pickNeutralTitle(GOOD, { incumbent: "Eski başlık burada duruyor" });
    const withFloor = pickNeutralTitle(GOOD, { incumbent: "Eski başlık burada duruyor", floor: true });
    expect(withFloor).toBe(noFloor);
  });

  it("the live young clusters 459a7b61, 4f8dbda9 and 7c1e5cde: whatever the pick, the floor flag is not what makes it", () => {
    const young: Array<{ stored: string; members: Array<{ title: string }> }> = [
      {
        stored: "Cumhurbaşkanı Erdoğan'dan Azerbaycan'da önemli açıklamalar",
        members: [
          { title: "Son dakika... Cumhurbaşkanı Erdoğan: Bakü'nün sevinci Ankara'nın sevincidir" },
          { title: "Erdoğan ve Aliyev'den Şuşu'da net mesaj: Kardeşliğimiz daim olacak" },
          { title: "Cumhurbaşkanı Erdoğan'dan Azerbaycan'da önemli açıklamalar" },
          { title: "Bir millet iki devlet! Başkan Erdoğan: Bakü'nün sevinci Ankara'nın sevincidir" },
        ],
      },
      {
        stored: "Bakan Murat Kurum canlı yayında soruları cevaplıyor",
        members: [
          { title: "Bakan Murat Kurum: COP31'de Antalyadan tüm dünyaya ortak bir çağrı yapacağız" },
          { title: "Bakan Murat Kurum canlı yayında soruları cevaplıyor" },
          { title: "Bakan Kurum'dan COP31 açıklaması: Antalya'dan tüm dünyaya çağrı yapacağız" },
        ],
      },
      {
        stored: "TBMM'de bu hafta da bütçe maratonu sürecek",
        members: [
          { title: "Mecliste bütçe görüşmeleri ve Kızılay düzenlemesi gündemde" },
          { title: "TBMM'de bu hafta da bütçe maratonu sürecek" },
          { title: "TBMM'de bu hafta da bütçe maratonu sürecek" },
          { title: "TBMM'de bu hafta hangi konular görüşülecek?" },
        ],
      },
    ];
    for (const { stored, members } of young) {
      expect(isAcceptableNeutral(stored, titlesOf(members)), stored).toBe(true);
      expect(pickNeutralTitle(members, { incumbent: stored, floor: true }), stored).toBe(pickNeutralTitle(members, { incumbent: stored }));
    }
  });
});

describe("a stored title that no member carries any more and that shouts", () => {
  it("is floored by the stale path already: the same pick with and without the flag", () => {
    // The outlet edited the shouted title away (a member now reads in sentence case): the stored title is stale, fails the
    // gate, and repickStale takes the floor pick of the members whatever the caller passed.
    const members = [{ title: "Nev'in mirası gündem oldu" }, { title: "Nev’in ağabeyi miras için harekete mi geçti? Avukatından sert yanıt" }];
    const noFlag = pickNeutralTitle(members, { incumbent: SHOUT_09F152EC });
    const flagged = pickNeutralTitle(members, { incumbent: SHOUT_09F152EC, floor: true });
    expect(noFlag).not.toBeNull();
    expect(flagged).toBe(noFlag);
    expect(noFlag as string).toMatch(LOWER_TR);
  });
});

describe("the residue: a shouted stored title and no usable member title", () => {
  it("is null with or without the floor (the cron stamps and keeps the title)", () => {
    expect(pickNeutralTitle([], { incumbent: SHOUT_09F152EC, floor: true })).toBeNull();
    expect(pickNeutralTitle([{ title: "" }], { incumbent: SHOUT_09F152EC, floor: true })).toBeNull();
  });
});
