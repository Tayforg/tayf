import { describe, it, expect } from "vitest";

import { isNoticeOnlyCluster } from "./notice-only-clusters";

// ---------------------------------------------------------------------------
// h168-notices-1: the cluster page answers `noindex` when EVERY member is a legal notice (isLegalNotice on the member's title,
// url and description). isNoticeOnlyCluster is that predicate: true when the member list is non-empty and every member is a
// notice. The page applies it directly; the sitemaps and IndexNow do not (see isIndexableCluster in the cluster page).
// ---------------------------------------------------------------------------

interface Art {
  title: string;
  url: string;
  description: string | null;
}

/** Two municipalities' EKAP tenders under a bare all-caps title: the h168-notices-1 shape (550b5df0). */
const TENDER_A: Art = {
  title: "ÜMRANİYE BELEDİYE BAŞKANLIĞI",
  url: "https://www.yenimesaj.com.tr/umraniye-belediye-baskanligi-H1621484.htm",
  description: "İLAN BİNA İNŞAATI YAPTIRILACAKTIR ... 4734 sayılı Kamu İhale Kanununun 19 uncu maddesine göre açık ihale usulü ile ihale edilecektir.",
};
const TENDER_B: Art = {
  title: "ŞİŞLİ BELEDİYE BAŞKANLIĞI",
  url: "https://www.milatgazetesi.com/sisli-belediye-baskanligi",
  description: "JENERATÖR MONTAJ DAHİL ALIMI İŞİ ... mal alımı 4734 sayılı Kamu İhale Kanununun 19 uncu maddesine göre ...",
};
/** A court notice by the url rule alone (no description). */
const COURT_BY_URL: Art = { title: "Duruşma günü", url: "https://www.example-news.test/ilan/12345", description: null };
/** Yeniçağ's D1 notice: a mixed-case title and the marker in the description only. */
const YENICAG: Art = {
  title: "T.C. Kırıkhan 2. Asliye Ceza Mahkemesi",
  url: "https://www.yenicaggazetesi.com/tc-kirikhan-2-asliye-ceza-mahkemesi-1090289h.htm",
  description: "İlan-T.C. Kırıkhan 2. Asliye Ceza Mahkemesi",
};
/** Real news that merely quotes the tender law under a mixed-case title. */
const NEWS: Art = {
  title: "Meclis’te kabul edildi, Kızılay’a ihalesiz alım yolu açıldı",
  url: "https://www.example-news.test/gundem/kizilay-ihalesiz-alim",
  description: "Teklifle Kızılay’ın alımları 4734 sayılı Kamu İhale Kanunu kapsamı dışına çıkarılıyor.",
};

describe("isNoticeOnlyCluster", () => {
  it("is true when every member is a notice, by the title rules, the url rule or the description rules", () => {
    expect(isNoticeOnlyCluster([TENDER_A, TENDER_B])).toBe(true);
    expect(isNoticeOnlyCluster([TENDER_A, COURT_BY_URL, YENICAG])).toBe(true);
    expect(isNoticeOnlyCluster([TENDER_A])).toBe(true);
  });

  it("one ordinary member keeps the cluster indexable", () => {
    expect(isNoticeOnlyCluster([TENDER_A, TENDER_B, NEWS])).toBe(false);
    expect(isNoticeOnlyCluster([NEWS])).toBe(false);
    // The tender description under a mixed-case title is news, not a notice.
    expect(isNoticeOnlyCluster([TENDER_A, { ...TENDER_B, title: "Şişli Belediye Başkanlığı ihale açtı" }])).toBe(false);
  });

  it("an empty member list is not 'every member': a read that returned nothing says nothing about the cluster", () => {
    expect(isNoticeOnlyCluster([])).toBe(false);
  });

  it("a member with no description, or a null or undefined one, is judged on its title and url", () => {
    expect(isNoticeOnlyCluster([{ ...COURT_BY_URL, description: undefined }, COURT_BY_URL])).toBe(true);
    expect(isNoticeOnlyCluster([{ ...TENDER_A, description: null }, TENDER_B])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// h181-sourcepages-1: a cluster whose only members are tax-office, enforcement-office or mixed-case court notices is notice-only
// too (rows of 2026-11-14 with the private text cut away).
// ---------------------------------------------------------------------------

describe("isNoticeOnlyCluster: tax-office, enforcement-office and mixed-case court notices (h181-sourcepages-1)", () => {
  const TAX_OFFICE: Art = {
    title: "KOZYATAĞI VERGİ DAİRESİ MÜDÜRLÜĞÜ",
    url: "https://www.milatgazetesi.com/kozyatagi-vergi-dairesi-mudurlugu",
    description: "İSTANBUL DEFTERDARLIĞI’NDAN İLANEN TEBLİĞVergi NoSoyad Ad/UnvanAdresVergi DönemiAna Vergi KoduVergi Kodu",
  };
  const ENFORCEMENT_OFFICE: Art = {
    title: "SİLİVRİ İCRA VE İFLAS MÜDÜRLÜĞÜ",
    url: "https://www.yenimesaj.com.tr/silivri-icra-ve-iflas-mudurlugu-H1",
    description: "Örnek No:55*\tT.C.SİLİVRİİCRA DAİRESİ\t2025/623 TLMT.\tTAŞINMAZIN GAZETE VEYA İNTERNET HABER SİTESİ İLANI",
  };
  const MIXED_COURT: Art = {
    title: "Kocaeli 3. sulh hukuk Mahkemesi'nden ilanen tebliğ",
    url: "https://www.iscihaber.net/yerel-haberler/kocaeli-3-sulh-hukuk-mahkemesinden-ilanen-teblig/281043",
    description: "Kocaeli 3. Sulh Hukuk Mahkemesi, adresine ulaşılamayan davalı Örnek Kişi için ilanen tebligat kararı aldı.",
  };
  /** Real news with a court in its title (the eighth İşçi Haber row of the fortnight). */
  const AYM_NEWS: Art = {
    title: "Anayasa Mahkemesi'nden Canan Karatay Kararı: İfade Özgürlüğü Vurgusu",
    url: "https://www.iscihaber.net/gundem/anayasa-mahkemesinden-canan-karatay-karari-ifade-ozgurlugu-vurgusu/278533",
    description: "Anayasa Mahkemesi, Prof. Dr. Canan Karatay'ın aşılarla ilgili açıklamaları nedeniyle aldığı meslekten geçici men cezasının ifade özgürlüğünü ihlal ettiğine hükmetti.",
  };

  it("is true for a cluster of two of these notices, and for each alone", () => {
    expect(isNoticeOnlyCluster([TAX_OFFICE, ENFORCEMENT_OFFICE])).toBe(true);
    expect(isNoticeOnlyCluster([TAX_OFFICE, MIXED_COURT])).toBe(true);
    expect(isNoticeOnlyCluster([ENFORCEMENT_OFFICE, MIXED_COURT, YENICAG])).toBe(true);
    expect(isNoticeOnlyCluster([TAX_OFFICE])).toBe(true);
  });

  it("one real story keeps the cluster indexable", () => {
    expect(isNoticeOnlyCluster([TAX_OFFICE, ENFORCEMENT_OFFICE, AYM_NEWS])).toBe(false);
    expect(isNoticeOnlyCluster([AYM_NEWS])).toBe(false);
  });
});
