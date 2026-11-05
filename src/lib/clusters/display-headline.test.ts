import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// pickNeutralTitle is wrapped (not replaced) so one test can make it throw.
// Every other test runs the real picker.
const picker = vi.hoisted(() => ({ failNext: false }));
vi.mock("./neutral-title", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./neutral-title")>();
  return {
    ...actual,
    pickNeutralTitle: vi.fn((...args: Parameters<typeof actual.pickNeutralTitle>) => {
      if (picker.failNext) {
        picker.failNext = false;
        throw new Error("picker blew up");
      }
      return actual.pickNeutralTitle(...args);
    }),
  };
});

import {
  FIRST_PICK_MIN_MEMBERS,
  clusterDisplayTitle,
  displayHeadline,
  memberTitlesNewestFirst,
} from "./display-headline";
import { cleanHeadline, framingPenalty, pickNeutralTitle } from "./neutral-title";

beforeEach(() => {
  vi.mocked(pickNeutralTitle).mockClear();
});

afterEach(() => {
  picker.failNext = false;
});

// Cluster 7d502c04-8782-406b-8fcf-b413e9b739f8 on 2026-11-05, read from prod
// (read-only). It debuted at 16:48:39 with its two oldest members and sat on the
// home page with the seed's raw title until the 16:55 headline cron tick.
const SEED_TITLE = "Eski Ulaştırma Bakanı Denizolgun’un ölüm nedeni netleşti... İşte detaylar!";
const SECOND_TITLE = "Eski Bakan Denizolgun'un şüpheli ölümüyle ilgili Adli Tıp raporu netleşti";
const DEBUT_MEMBERS_NEWEST_FIRST = [SECOND_TITLE, SEED_TITLE];

describe("displayHeadline", () => {
  it("(a) returns a stored neutral title verbatim and never runs the picker", () => {
    const stored = "Eski bakan Denizolgun’un ölüm nedeni belli oldu: Adli Tıp raporu ortaya çıktı";
    const out = displayHeadline(
      { title_tr: SEED_TITLE, title_tr_neutral: stored },
      DEBUT_MEMBERS_NEWEST_FIRST,
    );
    expect(out).toBe(stored);
    expect(vi.mocked(pickNeutralTitle)).not.toHaveBeenCalled();
  });

  it("(b) replays the debut of 7d502c04: no 'İşte detaylar!' seed, framing penalty 0", () => {
    const out = displayHeadline(
      { title_tr: SEED_TITLE, title_tr_neutral: null },
      DEBUT_MEMBERS_NEWEST_FIRST,
    );
    expect(out).not.toBe(SEED_TITLE);
    expect(out).not.toMatch(/İşte detaylar/i);
    expect(out).not.toContain("...");
    expect(framingPenalty(out)).toBe(0);
    expect(out.trim().length).toBeGreaterThan(20);
  });

  it("(c) one member gives cleanHeadline output: no 'Son dakika' lead-in", () => {
    const raw = "SON DAKİKA | Merkez Bankası faizi sabit tuttu!";
    const out = displayHeadline({ title_tr: raw, title_tr_neutral: null }, [raw]);
    expect(out).toBe(cleanHeadline(raw));
    expect(out).not.toMatch(/son dakika/i);
    expect(out).not.toContain("!");
    expect(out.startsWith("Merkez Bankası faizi sabit tuttu")).toBe(true);
  });

  it("(d) parity: equals the cron's first pick over the same members, so nothing flips when the cron writes", () => {
    const rows = [
      DEBUT_MEMBERS_NEWEST_FIRST,
      [
        "Hürmüz'de gerilim: ABD ve İran heyetleri Cenevre'de görüşecek",
        "SON DAKİKA: ABD ve İran heyetleri Cenevre'de masaya oturuyor",
        "ABD ile İran Cenevre'de görüşecek",
      ],
      ["Başkan Erdoğan Kabine toplantısı sonrası açıklama yaptı", "Kabine toplantısı sona erdi"],
    ];
    for (const titles of rows) {
      const expected = pickNeutralTitle(
        titles.map((title) => ({ title })),
        { floor: true },
      );
      expect(expected).not.toBeNull();
      expect(
        displayHeadline({ title_tr: titles[titles.length - 1]!, title_tr_neutral: null }, titles),
      ).toBe(expected);
    }
  });

  it("calls the picker exactly like the cron's first pick: floor on, no incumbent", () => {
    displayHeadline({ title_tr: SEED_TITLE, title_tr_neutral: null }, DEBUT_MEMBERS_NEWEST_FIRST);
    expect(vi.mocked(pickNeutralTitle)).toHaveBeenCalledTimes(1);
    const [members, opts] = vi.mocked(pickNeutralTitle).mock.calls[0]!;
    expect(members).toEqual(DEBUT_MEMBERS_NEWEST_FIRST.map((title) => ({ title })));
    expect(opts).toEqual({ floor: true });
  });

  it("treats a whitespace-only or empty neutral title as missing", () => {
    const expected = pickNeutralTitle(
      DEBUT_MEMBERS_NEWEST_FIRST.map((title) => ({ title })),
      { floor: true },
    );
    for (const blank of ["", "   ", "\n\t"]) {
      expect(
        displayHeadline({ title_tr: SEED_TITLE, title_tr_neutral: blank }, DEBUT_MEMBERS_NEWEST_FIRST),
      ).toBe(expected);
    }
  });

  it("falls back to cleanHeadline(title_tr) when the pick finds nothing", () => {
    const raw = "SON DAKİKA: Meclis bugün olağanüstü toplanıyor!";
    // No members at all.
    expect(displayHeadline({ title_tr: raw, title_tr_neutral: null }, [])).toBe(cleanHeadline(raw));
    // Only placeholder titles: every member is generic, so the picker returns null.
    expect(
      displayHeadline({ title_tr: raw, title_tr_neutral: null }, ["Son dakika", "Kısa haberler"]),
    ).toBe(cleanHeadline(raw));
  });

  it("falls back to title_tr itself when cleaning leaves nothing", () => {
    expect(displayHeadline({ title_tr: "...", title_tr_neutral: null }, [])).toBe("...");
    expect(displayHeadline({ title_tr: "", title_tr_neutral: null }, [])).toBe("");
  });

  it("never throws: a picker that throws falls back to the cleaned title_tr", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = "SON DAKİKA | Bakan istifa etti!";
    picker.failNext = true;
    expect(displayHeadline({ title_tr: raw, title_tr_neutral: null }, ["a", "b"])).toBe(cleanHeadline(raw));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("survives junk input: null members, non-string members, non-string neutral", () => {
    const raw = "Başlık";
    expect(
      displayHeadline({ title_tr: raw, title_tr_neutral: null }, null as unknown as string[]),
    ).toBe(raw);
    expect(
      displayHeadline({ title_tr: raw, title_tr_neutral: undefined as unknown as null }, [
        undefined as unknown as string,
        42 as unknown as string,
        "Cumhurbaşkanı Erdoğan yeni ekonomi paketini açıkladı",
      ]),
    ).toBe("Cumhurbaşkanı Erdoğan yeni ekonomi paketini açıkladı");
    const real = "SON DAKİKA: Merkez Bankası faizi sabit tuttu";
    expect(
      displayHeadline({ title_tr: raw, title_tr_neutral: 7 as unknown as string }, [real]),
    ).toBe(cleanHeadline(real));
  });

  it("handles special characters and a large member list without flipping", () => {
    const many = Array.from({ length: 400 }, (_, i) => `İstanbul'da ${i} numaralı hat 🚇 seferleri durdu`);
    const out = displayHeadline({ title_tr: many[0]!, title_tr_neutral: null }, many);
    expect(out).toBe(pickNeutralTitle(many.map((title) => ({ title })), { floor: true }));
  });
});

describe("memberTitlesNewestFirst", () => {
  it("orders by published_at, newest first", () => {
    expect(
      memberTitlesNewestFirst([
        { title: "old", published_at: "2026-11-05T16:41:00Z" },
        { title: "new", published_at: "2026-11-05T16:51:13Z" },
        { title: "mid", published_at: "2026-11-05T16:48:39Z" },
      ]),
    ).toEqual(["new", "mid", "old"]);
  });

  it("breaks equal timestamps on the title, ascending, like the cron's fetchMemberItems", () => {
    const at = "2026-11-05T16:48:39Z";
    expect(
      memberTitlesNewestFirst([
        { title: "b", published_at: at },
        { title: "c", published_at: at },
        { title: "a", published_at: at },
      ]),
    ).toEqual(["a", "b", "c"]);
    // Same instant in a different notation is still a tie.
    expect(
      memberTitlesNewestFirst([
        { title: "z", published_at: "2026-11-05T16:48:39Z" },
        { title: "y", published_at: "2026-11-05T19:48:39+03:00" },
      ]),
    ).toEqual(["y", "z"]);
  });

  it("puts a missing or unparseable published_at last and skips empty titles", () => {
    expect(
      memberTitlesNewestFirst([
        { title: "undated", published_at: null },
        { title: "", published_at: "2026-11-05T16:00:00Z" },
        { title: null, published_at: "2026-11-05T16:00:00Z" },
        { title: "garbled", published_at: "not a date" },
        { title: "dated", published_at: "2026-11-05T15:00:00Z" },
        { published_at: "2026-11-05T17:00:00Z" },
      ]),
    ).toEqual(["dated", "garbled", "undated"]);
  });

  it("does not mutate its input and tolerates a non-array", () => {
    const input = [
      { title: "b", published_at: "2026-11-05T10:00:00Z" },
      { title: "a", published_at: "2026-11-05T11:00:00Z" },
    ];
    const snapshot = JSON.stringify(input);
    memberTitlesNewestFirst(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(memberTitlesNewestFirst(null as unknown as [])).toEqual([]);
  });
});

describe("clusterDisplayTitle", () => {
  const debut = [
    { title: SEED_TITLE, published_at: "2026-11-05T16:41:00Z" },
    { title: SECOND_TITLE, published_at: "2026-11-05T16:48:39Z" },
  ];

  it("needs at least FIRST_PICK_MIN_MEMBERS members, the cron's own floor", () => {
    expect(FIRST_PICK_MIN_MEMBERS).toBe(2);
  });

  it("orders the members newest first, then picks (the arrival order does not matter)", () => {
    const expected = displayHeadline(
      { title_tr: SEED_TITLE, title_tr_neutral: null },
      DEBUT_MEMBERS_NEWEST_FIRST,
    );
    for (const members of [debut, [...debut].reverse()]) {
      const out = clusterDisplayTitle({ title_tr: SEED_TITLE, title_tr_neutral: null }, members);
      expect(out).toEqual({ title: expected, picked: true });
    }
    expect(expected).not.toBe(SEED_TITLE);
  });

  it("returns a stored neutral title untouched and marks it as not picked", () => {
    expect(
      clusterDisplayTitle({ title_tr: SEED_TITLE, title_tr_neutral: "Saklı başlık" }, debut),
    ).toEqual({ title: "Saklı başlık", picked: false });
  });

  it("keeps title_tr as it was for a cluster the cron would not title (fewer than 2 members)", () => {
    const raw = "SON DAKİKA: Tek kaynaklı haber!";
    expect(clusterDisplayTitle({ title_tr: raw, title_tr_neutral: null }, [])).toEqual({
      title: raw,
      picked: false,
    });
    expect(
      clusterDisplayTitle({ title_tr: raw, title_tr_neutral: null }, [
        { title: raw, published_at: "2026-11-05T16:00:00Z" },
      ]),
    ).toEqual({ title: raw, picked: false });
    // A blank neutral title with fewer than 2 members also keeps the original.
    expect(clusterDisplayTitle({ title_tr: raw, title_tr_neutral: "  " }, [])).toEqual({
      title: raw,
      picked: false,
    });
  });

  it("counts members that carry a title, not rows", () => {
    expect(
      clusterDisplayTitle({ title_tr: SEED_TITLE, title_tr_neutral: null }, [
        { title: SEED_TITLE, published_at: "2026-11-05T16:41:00Z" },
        { title: "", published_at: "2026-11-05T16:48:39Z" },
      ]),
    ).toEqual({ title: SEED_TITLE, picked: false });
  });
});
