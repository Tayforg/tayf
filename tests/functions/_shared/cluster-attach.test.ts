import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ATTACH_AMBIGUITY_MARGIN,
  ATTACH_MAX_PER_DRAIN,
  ATTACH_MIN_POLITICS_SHARE,
  ATTACH_READ_FLOOR_MS,
  attachDecision,
  attachIsStale,
  planAttachRead,
  type AttachArticle,
  type AttachCandidate,
  type AttachMember,
} from "../../../supabase/functions/_shared/cluster/attach.ts";
import { headlineLane, headlineOnlyScore } from "../../../supabase/functions/_shared/cluster/ensemble.ts";
import { headlineTokens } from "../../../supabase/functions/_shared/cluster/fingerprint.ts";
import { HEADLINE_LANE_MAX_HOURS } from "../../../supabase/functions/_shared/cluster/constants.ts";

// ---------------------------------------------------------------------------
// hunt-25 W3 ("h25-clusters-3"): the deterministic, attach-only admission.
//
// One story must not split because the politics gate is decided per article
// (cluster 304a47ce: 13 FETO-operation rows clustered, nine identical or
// near-identical headlines filed under genel next to them). attachDecision()
// is the pure core of that probe: it only ever answers "which existing
// politics cluster does this article belong to", from three kinds of evidence
// -- the identical folded headline, an equal strict fingerprint, the headline
// lane -- and refuses everything else. It has no way to create a cluster and no
// text-similarity or entity input at all.
//
// Fixtures are the verbatim production rows of 2026-11-01..02 (read-only
// SELECTs, 2026-11-02): titles, published_at and fingerprints as stored. The
// source slug stands in for the source id.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..", "..");
const ATTACH_SRC = readFileSync(
  resolve(ROOT, "supabase/functions/_shared/cluster/attach.ts"),
  "utf8",
);

type FixtureMember = [id: string, source: string, title: string, publishedIso: string, fingerprint: string | null];

const FETO_ID = "304a47ce-8c4d-4874-9b73-d140f432df61";
const CANCER_ID = "50f441fa-be11-4db5-86ff-633f8ab44409";
const IRAN_ID = "2e973096-5a3d-40a1-96d9-584aae3ef5cf";
const TRAIN_ID = "609bdf18-a857-4ee1-908a-bdd70ec4737e";

// The members of the four clusters at 2026-11-02 ~14:00Z.
const FETO_MEMBERS: FixtureMember[] = [
  ["8719e7ab-6661-4354-ae11-c873799f013e", "haber7", "32 ilde FETÖ operasyonu: 72 şüpheli yakalandı, 41’i tutuklandı", "2026-11-02T07:21:00Z", "a017ba6dfe8d636795269a053733220f339ad0b7"],
  ["d066f6e9-dee0-415e-8ebc-8123398b133e", "haber-global", "İçişleri Bakanlığı duyurdu! 32 ilde FETÖ operasyonu: 41 kişi tutuklandı", "2026-11-02T07:23:00Z", "6e126b0ce130341cc15706ced6923835a3fe4713"],
  ["94d49847-e4a1-43ce-a871-c88441cab828", "turkiye-gazetesi", "FETÖ'ye 32 ilde büyük operasyon: Gözaltılar var", "2026-11-02T07:23:28Z", "8cda40df7f4134e9c3d6a99123a5de0ad899e5f6"],
  ["c8540d3e-a250-48bc-8ccc-cd61915cc5e1", "star", "32 ilde FETÖ operasyonu! 72 şüpheli yakalandı", "2026-11-02T07:24:00Z", "b279d9d0579105f3d72a71dba20477cea5a593f9"],
  ["c521b4a1-a312-4793-8fad-e098c945a719", "haberler-com", "İçişleri Bakanlığı: \"32 ilde FETÖ’ye yönelik Jandarmamız tarafından düzenlenen operasyonlarda 72 şüpheli yakalandı.\"", "2026-11-02T07:24:21Z", "9f8c59f7a9f11ee3a5f250f73832f9c28a707a8a"],
  ["26ede371-565a-48ab-8782-fe7831d27e27", "aksam", "32 ilde FETÖ operasyonu: 41 şüpheli tutuklandı", "2026-11-02T07:25:00Z", "1ca4be7ef3416b1d250f78b7e900999f9b4dec1c"],
  ["25ceaa6d-c913-4e30-9951-c2a3eac9cf0b", "elips-haber", "32 ilde FETÖ operasyonu: 72 şüpheli yakalandı, 41'i tutuklandı!", "2026-11-02T07:26:00Z", "0ae02145fe11df97adb3659a5c572ffe02d3d172"],
  ["d22ec9a3-5497-430d-b0be-674d24bd3471", "yeni-safak", "İçişleri Bakanlığı'ndan 32 ilde FETÖ operasyonu: 72 şüpheli yakalandı", "2026-11-02T07:28:23Z", "3f797f63f9ccab77a0c4cb53d05f40c5a7d8a810"],
  ["1ac5459b-9f4b-4437-857a-a0d7088e10b4", "haberport", "Jandarma 32 ilde FETÖ'ye karşı yürüttüğü operasyonlarda 72 kişiyi yakaladı", "2026-11-02T07:30:45Z", "d14f79664426aede16cb1b13582496464b9afc14"],
  ["d8f1612a-51ad-443c-b113-351e0d3f521e", "milliyet", "32 ilde FETÖ operasyonu! 41 şüpheli tutuklandı", "2026-11-02T07:30:45Z", "509b9501cddfb0ee40a4147f8fd1cd333dcb2115"],
  ["2d98db6e-38d4-4669-bb8b-77b2ac191ebc", "isci-haber", "32 ilde FETÖ operasyonu: 41 şüpheli tutuklandı", "2026-11-02T07:35:08Z", "6f18e6d619575d30eaa0163f41ddec2b5ec83231"],
  ["ceeccbda-0b30-4e5e-9b1b-8b1daf27a7b8", "yenicag", "Terör örgütü FETÖ'nün finans kaynaklarına düzenlenen operasyonda 41 kişi tutuklandı", "2026-11-02T07:35:59Z", "0f3d8d15ccb76746de4c86fe03d70908a672d327"],
  ["dac199f6-4bda-49bd-b971-a1ad6041fc8f", "istiklal", "32 ilde FETÖ’ye yönelik operasyon: Çok sayıda tutuklama", "2026-11-02T07:36:21Z", "af91759bc81b8a37e62d218dd121e28b5498dd39"],
  ["39c2f196-5ff9-43ee-b286-62119f6e4ea0", "haberturk", "FETÖ operasyonunda 72 gözaltı", "2026-11-02T07:37:43Z", "c6dfb1fa7301e654397172ff764ffd27c60b1a97"],
  ["524d9852-ce45-4e4a-8954-6f010a20e72c", "takvim", "FETÖ'nün güncel yapılanmasına yönelik operasyon! 32 ilde yakalanan 72 şüpheliden 41'i cezaevinde", "2026-11-02T07:38:00Z", "0fe937f9d0d22d2b4e9cab0254dfcd59463c30db"],
  ["53f3b559-1362-4ab0-bee4-4969c3752091", "f5-haber", "FETÖ’ye 32 ilde büyük operasyon! 41 kişi tutuklandı", "2026-11-02T07:42:00Z", "fb1bebc572a636433d847d2e9d175844b8ba61e3"],
  ["e15a7067-824a-49a0-8e2e-85cc9e5b3eaf", "cumhuriyet", "İçişleri duyurdu... 32 ilde FETÖ operasyonu: 41 kişi tutuklandı", "2026-11-02T07:55:00Z", "845df0306a729114eac235a3ace6dfe85385a240"],
  ["80943c90-dbd8-4fb8-b5e2-ae7c63911599", "anadolu-ajansi", "FETÖ'ye yönelik 32 ilde düzenlenen operasyonlarda 41 şüpheli tutuklandı", "2026-11-02T07:56:06Z", "11f9041288f595c225a4209268f672bfc609a87a"],
];
const CANCER_MEMBERS: FixtureMember[] = [
  ["642d45c0-e120-4c04-8a4c-ea1dd4904d2a", "hurriyet", "Son kullanma tarihi geçmiş kanser ilaçlarıyla vurgun: 22 şüpheli gözaltına alındı", "2026-11-02T06:34:00Z", "9508f6a8928f4b5c01c00656afe5766882d0201f"],
  ["b6656fd3-9304-4678-bfc7-0051f5f212d0", "dunya", "Bakan Gürlek duyurdu: Kanser ilacında hileye 11 ilde operasyon", "2026-11-02T06:34:00Z", "75fac7484183ada11f90257c0dda116940429277"],
  ["94dd5574-ee7d-48dd-b244-e0c7186abc56", "haber-global", "Kanser hastalarının hayatıyla oynadılar! 650 milyon TL'lik ilaç vurgunu: 22 kişi gözaltına alındı", "2026-11-02T06:35:00Z", "38a9f7776f4ba8498412aa830b90b2e965a0e401"],
  ["de35c7ba-83f8-48c3-a694-c652a4c8091f", "sabah", "SON DAKİKA! Bakan Gürlek duyurdu: Tarihi geçmiş kanser ilacı satan şebekeye 11 ilde büyük operasyon", "2026-11-02T06:35:22Z", "68969ae95b336a30334e7dac6efb0ccea583b073"],
  ["636ed5f4-6042-49a2-ae6a-b8b792e2c7a1", "turkiye-gazetesi", "Tarihi geçmiş kanser ilaçlarına yönelik operasyon", "2026-11-02T06:37:02Z", "9587dc1518529dada241ade975226f784bf64923"],
  ["a5c72393-10f4-4e27-8dc2-5daf4e2ba4a5", "trt-haber", "Son kullanma tarihi geçmiş kanser ilaçlarını piyasaya süren 22 şüpheli gözaltında", "2026-11-02T06:39:00Z", "1a7cf572c35ee0cd77f192428263fe88747166d6"],
  ["1b704a6d-83d0-46c1-a7af-e4571d946ffa", "elips-haber", "Son kullanma tarihi geçmiş kanser ilaçlarını piyasaya sürdüler: 11 ilde operasyon!", "2026-11-02T06:39:00Z", "0c999eaa4d58adebab208ac17fd68574755104be"],
  ["be0840ba-fab3-4e35-bf8b-756f42878218", "birgun", "Tarihi geçmiş kanser ilaçlarını piyasaya sürenlere operasyon", "2026-11-02T06:39:00Z", "78ba1a7a872537c416dfa0eff0d8e78dd91c0a68"],
  ["9fd00599-48b4-4591-aeeb-b84da3f710b0", "dokuz8-haber", "Tarihi geçmiş kanser ilaçlarını yeniden piyasaya sürenlere yönelik operasyonda 22 kişi gözaltına alındı", "2026-11-02T06:39:18Z", "dd3c6bf0882b40895548cc9caa095f69fe9ec892"],
  ["77602698-3ae4-4253-a15d-ff68871da87a", "f5-haber", "11 ilde kanser ilaçlarına yönelik usulsüzlük operasyonu! Akın Gürlek duyurdu", "2026-11-02T06:40:00Z", "4c68892fdba9d63eed71af8ec9695cfcbcc28c37"],
  ["a00b7050-7773-448e-a248-46c695c0dcaf", "yeni-safak", "Vicdansızlığın bu kadarı: Kanser hastalarına tarihi geçmiş ilaç satan şebeke çökertildi", "2026-11-02T06:40:10Z", "be19c51fcab01440147331ad026b6c21fd725086"],
  ["c66f9a26-7ec8-4fe4-b45f-4baee855fbbb", "haberler-com", "Sahte kanser ilacı operasyonu! 11 ilde 650 milyon liralık vurgun", "2026-11-02T06:40:15Z", "fa39f82e71be0cea72f8b36dc50ef0dd1de0a1ba"],
  ["8f4f33a9-58a1-415e-96d7-f114cf97fe74", "yeni-akit", "Adalet Bakanı Gürlek duyurdu! Tarihi geçmiş kanser ilacı satan şebekeye operasyon: Çok sayıda gözaltı var", "2026-11-02T06:41:00Z", "3a5364d87156f9ded0f64479f9d2160f611ff2d1"],
  ["bb38ae9e-cab4-47d4-accf-ed22cbc2b5c0", "takvim", "Kanser ilaçlarının ambalajlarını değiştirerek piyasaya süren çeteye operasyon", "2026-11-02T06:41:02Z", "74ffe2db170d669f4c802dfff621548a596c3746"],
  ["75be4ca5-1efe-4dcf-a356-8ca8d56e9e35", "sozcu", "Tarihi geçmiş kanser ilaçlarını piyasaya süren çeteye operasyon! Çok sayıda gözaltı var", "2026-11-02T06:41:13Z", "daca602e43e25acae482f6b147b3809c5167b7d9"],
  ["2e10e7e7-ae23-4dda-afb9-e736410d5871", "gzt", "650 milyon liralık kanser ilacı vurgununa 11 ilde operasyon: Çok sayıda gözaltı var", "2026-11-02T06:41:32Z", "5423901c0306f2b5f523eb2a273dde270d5db39a"],
  ["9efebb08-54b7-443a-a2fa-c33f4617a43c", "haber7", "Tarihi geçmiş kanser ilaçlarını piyasaya sürmüşlerdi: Dev operasyon!", "2026-11-02T06:43:00Z", "4b1740104953956f93b7c633e37f181350238949"],
  ["d10c433e-b00d-4b18-8254-48e132e0be04", "cnn-turk", "Tarihi geçmiş kanser ilaçlarını yeniden piyasaya süren şebekeye operasyon: 22 gözaltı", "2026-11-02T06:43:03Z", "7e8c05b59d8b4cd5d6f669ad02c571db8555a3bb"],
  ["49847d77-5c3b-40bb-bd86-cbedcd3b6302", "ekonomim", "Tarihi geçmiş kanser ilaçlarını piyasaya sürenlere 11 ilde baskın: 22 şüpheli gözaltına alındı", "2026-11-02T06:45:00Z", "60bf016ec533cbaef4c70ea2bc622cccb56bdf9b"],
  ["2209ae72-c190-4a67-b75b-915fca3f1905", "milat", "Tarihi geçmiş kanser ilaçlarını piyasaya süren 22 şüpheli gözaltında", "2026-11-02T06:45:00Z", "1a7cf572c35ee0cd77f192428263fe88747166d6"],
  ["0931c5da-35a7-4c2f-a9dc-4c312aacd301", "dirilis-postasi", "Bakan Gürlek duyurdu: Kanser ilacı soruşturmasında 22 gözaltı!", "2026-11-02T06:52:00Z", "fd844adf359bbd67975ffc4521c8be8f6931877e"],
  ["c2425e5d-2a88-4a82-8e15-0a5e2d7c2592", "kamudanhaber", "Bakan Gürlek duyurdu: Tarihi geçmiş kanser ilaçlarını piyasaya süren şebekeye operasyon", "2026-11-02T06:53:00Z", "ae809e4e4ca14dc20d9c8d8f7f83b9d7ea355756"],
  ["0c54b928-d359-44f8-bf0d-48a8167f0c2d", "anadolu-ajansi", "Tarihi geçmiş kanser ilaçlarını yeniden piyasaya süren şüphelilere yönelik operasyonda 22 kişi gözaltına alındı", "2026-11-02T06:58:25Z", "5698f6defa527c971a221ceda5950ec15324f7eb"],
  ["934d2223-0914-48ff-95f1-f069ec648749", "aydinlik", "İlaç şebekesine 11 ilde eş zamanlı darbe! Bakan Gürlek ayrıntıları paylaştı", "2026-11-02T07:01:33Z", "70a0cd45df3ab8e4f11cffbe52446c1b676f166b"],
  ["f135e7ff-6064-40bb-9932-61a45c8417fb", "ilke-tv", "Tarihi geçmiş kanser ilaçlarını yeniden piyasaya sürenlere yönelik operasyonda 22 kişi gözaltına alındı", "2026-11-02T07:04:36Z", "468586982a2351b00417cc23ebac69f93b33d131"],
  ["d7f39f58-6398-429d-adbe-a9a96b1ad473", "on-haber", "Tarihi geçmiş kanser ilacı vurgunu: 22 gözaltı", "2026-11-02T07:07:20Z", "57132c32628ddb8967f8aa007613fbbf03d5108c"],
  ["fb4b7d40-96e2-47bf-bab2-9be64b482792", "haberet", "Son kullanma tarihi geçmiş kanser ilaçlarını piyasaya süren 22 şüpheli gözaltında", "2026-11-02T07:16:17Z", "1a7cf572c35ee0cd77f192428263fe88747166d6"],
  ["84e3bac5-3827-4235-8af2-7a9f4de2407f", "karar", "Ölümcül oyunu emniyet bozdu: Son kullanma tarihi geçen kanser ilaçlarını bakın nasıl satmışlar", "2026-11-02T07:18:00Z", "29d2371f08227c34308079574611af3d0163c545"],
  ["f554d020-72c6-48f8-bb27-8f245b0665ad", "sputnik-turkce", "Tarihi geçmiş kanser ilaçlarını yeniden piyasaya süren şebekeye operasyon: 22 gözaltı", "2026-11-02T07:42:14Z", "5eda01fbdbd36e478922f42a51629f37a05ad9af"],
  ["56a4d249-51ed-4a86-a29f-46266bfaf752", "habervakti", "Dev operasyon duyuruldu: Tarihi geçmiş kanser ilaçlarını piyasaya sürmüşlerdi!", "2026-11-02T07:52:00Z", "e8af30ee505452d1f9e2adb264ab4e2437e1bae0"],
];
const IRAN_MEMBERS: FixtureMember[] = [
  ["1a7d4c5c-ffed-41ac-86b0-2a5d8ac358fe", "haberler-com", "Olay iddia! ABD, 7 Kasım'da İran'a nükleer saldırı düzenleyecek", "2026-11-02T05:33:30Z", "76baf296e25c7e0d586ec47d4216282e214da759"],
  ["c8f3faaf-a3b0-4a32-a268-0adbbcc1f515", "haberturk", "ABD'li gazeteciden çarpıcı nükleer saldırı iddiası", "2026-11-02T05:56:17Z", "b69f8281a54a5019ca1a01e0234c02018de10a72"],
  ["68f0a2a5-bd1c-4f91-a68b-21ea6efa4b51", "gazete-oksijen", "ABD'li gazeteciden çarpıcı iddia: Trump, 7 Kasım'a kadar İran'a nükleer saldırı kararı alabilir", "2026-11-02T06:25:00Z", "3b3ca13a605f352a34dc67c144a31e7f19b73f18"],
  ["638cbed0-a276-44f5-908b-76d244c18857", "cumhuriyet", "Netanyahu'dan Trump'a İran baskısı: Ara seçimlerin ardından saldırı iddiası", "2026-11-02T06:39:00Z", "ff30f757f97182ed994e7814b34e904339c87ca9"],
  ["aba556dc-3059-4101-92a1-46a2addf8bf5", "sozcu", "Dünya nefesini tuttu: Büyük savaş için geri sayım başladı", "2026-11-02T06:52:20Z", "7e2919e0486cce37b45f8fb8c925ec24cb849d4a"],
  ["fcb95c20-11a8-4eac-bd30-3085746da133", "milliyet", "ABD'li gazeteci Tucker Carlson'dan dünyayı sarsan İran iddiası! Tarih verdi: 'Nükleer saldırı için geri sayım'", "2026-11-02T06:59:45Z", "81ef4ba024d7fcb7612c0838b4052b26d9cef517"],
  ["121d392d-2a95-4727-980e-0f5cf282765a", "onedio", "Tucker Carlson İddia Etti: Donald Trump 7 Kasım'a Kadar İran'a Nükleer Saldırı Kararı Verebilir", "2026-11-02T07:10:13Z", "423aa77b7b0b65ebee967ad4f3be8a838cd46aee"],
  ["d78e6d27-7075-4472-9129-88b1bb87ec3c", "sputnik-turkce", "ABD'li gazeteci Carlson: Trump, Netanyahu'nun baskısıyla İran'a nükleer saldırı düzenleyebilir", "2026-11-02T07:11:06Z", "968187ddc35091e0a9d367f5afb902aa7114f5b7"],
  ["ee8be731-3154-4564-98c9-df3180a21714", "birgun", "ABD'li gazeteci Tucker Carlson: Netanyahu Trump'a, İran'a nükleer saldırı yapması için baskı yapıyor", "2026-11-02T07:13:00Z", "c027e4e33b1e91a80c995441ac53aa49de4086d9"],
  ["5d6c902d-20d5-49a8-b5db-95451f16213b", "hurriyet", "Gündeme bomba gibi düşen iddia: 'Trump nükleer saldırı emri verecek'", "2026-11-02T07:20:57Z", "03816215c6b77d851b72beff15d9a6d47c3ea238"],
  ["219f65c4-9e12-4d17-8c21-548e7a913d8b", "aydinlik", "Tucker Carlson'dan nükleer savaş uyarısı: Netanyahu Trump'a İran'a saldırması için her gün baskı yapıyor", "2026-11-02T07:29:44Z", "1a99a56f468827898fe9b4924fd241b8a345ad1b"],
  ["47b20f77-37ab-4458-af94-7c0483e2ac2a", "haber7", "Tel Aviv köşeye sıkıştı, Netanyahu her gün Trump'ı arıyor: Alçak talebi ortaya çıktı!", "2026-11-02T07:39:00Z", "e71387de2a076dca68733a465c466f7d1e183ab9"],
];
const TRAIN_MEMBERS: FixtureMember[] = [
  ["abbfdb17-ff3c-454c-b41a-debd84ce8f22", "cnn-turk", "Suikast Treni filminin konusu nedir? Suikast Treni filminin oyuncuları kimler?", "2026-11-01T15:52:19Z", "d3f3647d2b7d7e08d7d84f31abc2fa4368882730"],
  ["b58047cd-8826-4161-a83b-ac2805cadb46", "cumhuriyet", "Suikast Treni filminin konusu ne? Suikast Treni filminin oyuncuları kim?", "2026-11-01T17:19:00Z", "0dcd672e76fef3496f156cf3f3be7f5e74a7c0a3"],
];

function toMember([id, source, title, iso, fingerprint]: FixtureMember): AttachMember {
  return {
    id,
    sourceId: source,
    title,
    tokens: headlineTokens(title),
    publishedMs: Date.parse(iso),
    fingerprint,
  };
}

const article = (row: FixtureMember): AttachArticle => toMember(row);

function candidate(
  clusterId: string,
  rows: FixtureMember[],
  over: Partial<AttachCandidate> = {},
): AttachCandidate {
  const members = rows.map(toMember);
  return {
    clusterId,
    politicsShare: 1,
    sourceIds: new Set(members.map((m) => m.sourceId).filter((s): s is string => s !== null)),
    articleCount: members.length,
    members,
    ...over,
  };
}

// The articles the finding names (all unclustered at the time; fingerprint is
// null in production for non-gate rows, the consumer computes the strict hash).
const HURRIYET_FETO: FixtureMember = ["2f93603f-fd2d-445e-bf7e-51d3a22899bd", "hurriyet", "32 ilde FETÖ operasyonu: 41 şüpheli tutuklandı", "2026-11-02T07:22:00Z", null];
const AJANS_HABER_CANCER: FixtureMember = ["d30f18fb-1ca0-4b66-8554-391028af480a", "ajans-haber", "Tarihi geçmiş kanser ilaçlarını yeniden piyasaya sürenlere operasyon: 22 gözaltı", "2026-11-02T09:17:00Z", null];
const AA_CARLSON: FixtureMember = ["292c13a1-ddfa-49c9-92da-abade0f1eb91", "anadolu-ajansi", "ABD'li gazeteci Carlson'a göre Netanyahu Trump'a, İran'a nükleer saldırı yapması için baskı yapıyor", "2026-11-02T07:06:50Z", null];
const CUMHURIYET_MUHBIR: FixtureMember = ["312bce42-3145-47aa-84e7-35224a0b3935", "cumhuriyet", "Muhbir filminin konusu ne? Muhbir filminin oyuncuları kim?", "2026-11-01T17:44:00Z", "b0fb3bbe92ee9e2cd4238786eef84387e191cfcb"];
const CUMHURIYET_ELLER_YUKARI: FixtureMember = ["f4b82ef9-5044-4c28-bb04-e0a30379b032", "cumhuriyet", "Eller Yukarı filminin konusu ne? Eller Yukarı filminin oyuncuları kim?", "2026-11-01T18:15:00Z", "5cc51ad80a022e7699d5505a817213752cff5b3d"];

const feto = () => candidate(FETO_ID, FETO_MEMBERS);
const cancer = () => candidate(CANCER_ID, CANCER_MEMBERS);
const iran = () => candidate(IRAN_ID, IRAN_MEMBERS);
const train = () => candidate(TRAIN_ID, TRAIN_MEMBERS);
// The context holds more than the target: every other live cluster is a candidate too.
const context = (...first: AttachCandidate[]) => [...first, ...[feto(), cancer(), iran(), train()].filter((c) => !first.some((f) => f.clusterId === c.clusterId))];

describe("attachDecision: the findings that MUST attach", () => {
  it("hurriyet 2f93603f joins 304a47ce by the identical headline (aksam 26ede371 carries it character for character, milliyet d8f1612a with '!' for ':')", () => {
    const a = article(HURRIYET_FETO);
    const aksam = FETO_MEMBERS.find((m) => m[0].startsWith("26ede371"))!;
    const milliyet = FETO_MEMBERS.find((m) => m[0].startsWith("d8f1612a"))!;
    expect(aksam[2]).toBe(HURRIYET_FETO[2]);
    expect(milliyet[2]).toBe("32 ilde FETÖ operasyonu! 41 şüpheli tutuklandı");
    // Folded (punctuation is dropped), the three headlines are one key.
    expect(a.tokens.tokens).toEqual(headlineTokens(milliyet[2]).tokens);
    const decision = attachDecision(a, context());
    expect(decision).toEqual({ clusterId: FETO_ID, score: 1, lane: "exact-title" });
  });

  it("the exact title wins whatever the other clusters hold, and the order of the candidate list does not matter", () => {
    const a = article(HURRIYET_FETO);
    const forward = attachDecision(a, [feto(), cancer(), iran(), train()]);
    const backward = attachDecision(a, [train(), iran(), cancer(), feto()]);
    expect(forward).toEqual(backward);
    expect(forward).toMatchObject({ clusterId: FETO_ID, lane: "exact-title" });
  });

  it("ajans-haber d30f18fb joins the cancer-drug cluster 50f441fa through the headline lane", () => {
    const a = article(AJANS_HABER_CANCER);
    const decision = attachDecision(a, context());
    expect(decision).toMatchObject({ clusterId: CANCER_ID, lane: "headline" });
    // The score is the best member's headlineOnlyScore (sputnik-turkce f554d020 at 1.58 h).
    const best = Math.max(
      ...CANCER_MEMBERS.map((m) => {
        const mm = toMember(m);
        const hours = Math.abs(a.publishedMs - mm.publishedMs) / 3_600_000;
        return headlineLane(a.tokens, mm.tokens, hours).fired ? headlineOnlyScore(a.tokens, mm.tokens, hours) : 0;
      }),
    );
    expect(best).toBeGreaterThan(0.9);
    expect((decision as { score: number }).score).toBeCloseTo(best, 12);
  });

  it("AA 292c13a1 joins 2e973096 through the headline lane (birgun ee8be731: 11 shared stems)", () => {
    const decision = attachDecision(article(AA_CARLSON), context());
    expect(decision).toMatchObject({ clusterId: IRAN_ID, lane: "headline" });
    expect((decision as { score: number }).score).toBeGreaterThan(0.9);
  });

  it("an equal strict fingerprint is evidence on its own, even when the headlines differ", () => {
    const fp = "feedfacefeedfacefeedfacefeedfacefeedface";
    const target = candidate(FETO_ID, FETO_MEMBERS.map((m, i) => (i === 0 ? ([m[0], m[1], m[2], m[3], fp] as FixtureMember) : m)));
    const a = article(["aaaaaaaa-0000-4000-8000-000000000001", "star-yedek", "Tamamen başka bir başlık, aynı metin", "2026-11-02T07:40:00Z", fp]);
    expect(attachDecision(a, [target])).toEqual({ clusterId: FETO_ID, score: 1, lane: "fingerprint" });
  });

  it("a null or empty fingerprint is never evidence", () => {
    const blank = candidate(FETO_ID, FETO_MEMBERS.map((m) => [m[0], m[1], m[2], m[3], ""] as FixtureMember));
    const a = article(["aaaaaaaa-0000-4000-8000-000000000002", "star-yedek", "Tamamen başka bir başlık", "2026-11-02T07:40:00Z", ""]);
    expect(attachDecision(a, [blank])).toEqual({ reason: "no-match" });
    const nulls = candidate(FETO_ID, FETO_MEMBERS.map((m) => [m[0], m[1], m[2], m[3], null] as FixtureMember));
    expect(attachDecision(article(["aaaaaaaa-0000-4000-8000-000000000003", "x", "Tamamen başka bir başlık", "2026-11-02T07:40:00Z", null]), [nulls])).toEqual({ reason: "no-match" });
  });
});

describe("attachDecision: the findings that MUST NOT attach", () => {
  it("the cumhuriyet 'Muhbir' / 'Eller Yukarı' pair (#152): no member matches, so no-match -- not a duplicate-source skip", () => {
    for (const row of [CUMHURIYET_MUHBIR, CUMHURIYET_ELLER_YUKARI]) {
      const a = article(row);
      // The headline lane does not fire against any member of the "Suikast Treni" cluster...
      for (const m of TRAIN_MEMBERS.map(toMember)) {
        const hours = Math.abs(a.publishedMs - m.publishedMs) / 3_600_000;
        expect(headlineLane(a.tokens, m.tokens, hours).fired).toBe(false);
        expect(m.fingerprint).not.toBe(a.fingerprint);
      }
      // ...although cumhuriyet IS already in that cluster (same-source would apply if anything matched).
      expect(train().sourceIds.has("cumhuriyet")).toBe(true);
      expect(attachDecision(a, context(train()))).toEqual({ reason: "no-match" });
      expect(attachDecision(a, [train()])).toEqual({ reason: "no-match" });
    }
  });

  it("the shared description template is invisible to it: the module takes titles and fingerprints, nothing else", () => {
    // Same fingerprint field type, different values: the 0.85 MinHash score of the
    // incident never existed here.
    const a = article(CUMHURIYET_MUHBIR);
    expect(Object.keys(a).sort()).toEqual(["fingerprint", "id", "publishedMs", "sourceId", "title", "tokens"]);
  });

  it("numeral mismatch: '61 şüpheli adliyeye sevk edildi' never attaches to the '39 kişi tutuklandı' cluster", () => {
    const sozcu61: FixtureMember = ["59339b75-0000-4000-8000-000000000001", "sozcu", "Bakırköy Belediyesi soruşturmasında 61 şüpheli adliyeye sevk edildi", "2026-10-31T06:30:00Z", null];
    const members: FixtureMember[] = [
      ["f25a86a2-0000-4000-8000-000000000001", "turkiye-gazetesi", "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı", "2026-10-31T06:58:04Z", null],
      ["e7c13ec3-0000-4000-8000-000000000001", "sputnik-turkce", "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı", "2026-10-31T07:08:45Z", null],
      ["2e8bb4a6-0000-4000-8000-000000000001", "dunya", "Bakırköy Belediyesi soruşturmasında karar: 39 kişi tutuklandı", "2026-10-31T07:04:00Z", null],
    ];
    const a = article(sozcu61);
    expect(a.tokens.numbers).toEqual(new Set(["61"]));
    expect(attachDecision(a, [candidate("bakirkoy-39", members)])).toEqual({ reason: "no-match" });
    // The same story in the SAME numeral does attach (control).
    const control = article(["59339b75-0000-4000-8000-000000000002", "sozcu", "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı", "2026-10-31T06:30:00Z", null]);
    expect(attachDecision(control, [candidate("bakirkoy-39", members)])).toMatchObject({ clusterId: "bakirkoy-39" });
  });

  it("a roundup headline is not 'contained' by short headlines of unrelated stories (the size guard)", () => {
    const roundup: FixtureMember = [
      "69c0d657-0000-4000-8000-000000000001",
      "cnn-turk",
      "REYTİNG SONUÇLARI 31 EKİM 2026 | Dün Akşamın Reyting Birincisi Kim Oldu? Güller ve Günahlar, Gönül Dağı, Başkalarının Hayatı, Kim Milyoner Olmak İster?, Güldür Güldür Show, Ömür Usta, MasterChef Türkiye Reyting Sonucu",
      "2026-11-01T06:00:00Z",
      null,
    ];
    const shorts: FixtureMember[] = [
      ["a0000000-0000-4000-8000-000000000001", "sabah", "Güller ve Günahlar, Gönül Dağı, Ömür Usta reyting sonuçları", "2026-11-01T06:20:00Z", null],
      ["a0000000-0000-4000-8000-000000000002", "star", "Gönül Dağı Başkalarının Hayatı Ömür Usta reyting sonucu", "2026-11-01T06:40:00Z", null],
      ["a0000000-0000-4000-8000-000000000003", "posta", "Kim Milyoner Olmak İster Güldür Güldür Show MasterChef reyting sonucu", "2026-11-01T07:00:00Z", null],
    ];
    const a = article(roundup);
    for (const s of shorts.map(toMember)) {
      const lane = headlineLane(a.tokens, s.tokens, 0.5);
      expect(lane.containment).toBeGreaterThanOrEqual(0.85); // every short word is in the roundup
      expect(lane.fired).toBe(false); // ...and the ratio guard (0.4) refuses it
    }
    expect(attachDecision(a, [candidate("reyting", shorts)])).toEqual({ reason: "no-match" });
    // Symmetric: a short headline against a cluster whose newest member is the roundup.
    const asMember = candidate("reyting-2", [roundup]);
    expect(attachDecision(article(shorts[0]!), [asMember])).toEqual({ reason: "no-match" });
  });

  it("a target below ATTACH_MIN_POLITICS_SHARE (0.59) is refused, 0.6 is allowed", () => {
    const a = article(HURRIYET_FETO);
    expect(attachDecision(a, [candidate(FETO_ID, FETO_MEMBERS, { politicsShare: 0.59 })])).toEqual({ reason: "below-share" });
    expect(attachDecision(a, [candidate(FETO_ID, FETO_MEMBERS, { politicsShare: 0.6 })])).toMatchObject({ clusterId: FETO_ID });
    expect(attachDecision(a, [candidate(FETO_ID, FETO_MEMBERS, { politicsShare: 0 })])).toEqual({ reason: "below-share" });
    expect(attachDecision(a, [candidate(FETO_ID, FETO_MEMBERS, { politicsShare: Number.NaN })])).toEqual({ reason: "below-share" });
  });

  it("a source already in the cluster is refused (same-source), by the id set and by a member of that source", () => {
    const a = article(HURRIYET_FETO);
    const withSource = candidate(FETO_ID, FETO_MEMBERS, { sourceIds: new Set(["hurriyet", "aksam"]) });
    expect(attachDecision(a, [withSource])).toEqual({ reason: "same-source" });
    // Also when only a (non-politics) member row carries the source and the id set forgot it.
    const memberOnly = candidate(FETO_ID, [...FETO_MEMBERS, ["bbbbbbbb-0000-4000-8000-000000000001", "hurriyet", "Başka bir hürriyet haberi", "2026-11-02T07:00:00Z", null]], {
      sourceIds: new Set(["aksam"]),
    });
    expect(attachDecision(a, [memberOnly])).toEqual({ reason: "same-source" });
    // An array works as the id list.
    expect(attachDecision(a, [candidate(FETO_ID, FETO_MEMBERS, { sourceIds: ["hurriyet"] })])).toEqual({ reason: "same-source" });
  });

  it("two clusters that qualify within 0.05 through the headline lane are ambiguous", () => {
    const a = article(AA_CARLSON);
    const birgun = IRAN_MEMBERS.find((m) => m[1] === "birgun")!;
    const twin = candidate("twin-of-iran", [[ "cccccccc-0000-4000-8000-000000000001", "evrensel", birgun[2], birgun[3], null ]]);
    const decision = attachDecision(a, [iran(), twin]);
    expect(decision).toEqual({ reason: "ambiguous" });
    expect(attachDecision(a, [twin, iran()])).toEqual({ reason: "ambiguous" });
  });

  it("ambiguity is a margin, not a tie: a clearly weaker second cluster does not block the best one", () => {
    const a = article(AA_CARLSON);
    // A twin whose only match is the same headline plus one word, 5.5 h earlier: the lane
    // fires (Jaccard 12/13) but the time decay puts it well below birgun's 0.92.
    const weakRow: FixtureMember = [
      "cccccccc-0000-4000-8000-000000000002",
      "evrensel",
      AA_CARLSON[2] + " iddiası",
      new Date(a.publishedMs - 5.5 * 3_600_000).toISOString(),
      null,
    ];
    const weak = candidate("weak-twin", [weakRow]);
    const wm = toMember(weakRow);
    const weakScore = headlineOnlyScore(a.tokens, wm.tokens, 5.5);
    expect(headlineLane(a.tokens, wm.tokens, 5.5).fired).toBe(true);
    const strong = attachDecision(a, [iran()]);
    const strongScore = (strong as { score: number }).score;
    expect(strongScore - weakScore).toBeGreaterThan(ATTACH_AMBIGUITY_MARGIN);
    expect(attachDecision(a, [weak, iran()])).toMatchObject({ clusterId: IRAN_ID, lane: "headline" });
    expect(attachDecision(a, [iran(), weak])).toMatchObject({ clusterId: IRAN_ID, lane: "headline" });
  });

  it("two clusters holding the SAME exact title are ambiguous (twin clusters are not the attach path's to pick)", () => {
    const a = article(HURRIYET_FETO);
    const twin = candidate("feto-twin", FETO_MEMBERS.filter((m) => m[1] === "aksam" || m[1] === "milliyet"));
    expect(twin.members).toHaveLength(2);
    expect(attachDecision(a, [feto(), twin])).toEqual({ reason: "ambiguous" });
  });

  it("a same-source cluster close behind the best one makes the answer ambiguous too", () => {
    const a = article(HURRIYET_FETO);
    const blocked = candidate("feto-twin", FETO_MEMBERS.filter((m) => m[1] === "aksam"), { sourceIds: new Set(["hurriyet"]) });
    expect(attachDecision(a, [feto(), blocked])).toEqual({ reason: "ambiguous" });
  });

  it("a below-share cluster close behind the best one does not make it ambiguous (it is not a politics cluster)", () => {
    const a = article(HURRIYET_FETO);
    const low = candidate("feto-genel-twin", FETO_MEMBERS.filter((m) => m[1] === "aksam"), { politicsShare: 0.3 });
    expect(attachDecision(a, [feto(), low])).toMatchObject({ clusterId: FETO_ID, lane: "exact-title" });
  });
});

describe("attachDecision: other refusals", () => {
  it("a pair that would only match on text similarity or entities has no input here and is no-match", () => {
    // Same story, no shared headline words: only a text or entity score could connect them.
    const a = article(["dddddddd-0000-4000-8000-000000000001", "sabah", "Devlet Bahçeli'den sert açıklama", "2026-11-02T07:30:00Z", null]);
    const members: FixtureMember[] = [
      ["eeeeeeee-0000-4000-8000-000000000001", "haber7", "MHP lideri Bahçeli partisinin grup toplantısında konuştu", "2026-11-02T07:20:00Z", null],
    ];
    expect(attachDecision(a, [candidate("bahceli", members)])).toEqual({ reason: "no-match" });
  });

  it("the module imports no text-similarity, signature or entity helper", () => {
    const lowered = ATTACH_SRC.toLowerCase();
    for (const banned of ["tfidf", "tf-idf", "minhash", "extractentities", "bandkeys", "cosine", "entities", "createcluster", "jev"]) {
      expect(lowered.includes(banned), `attach.ts must not mention "${banned}"`).toBe(false);
    }
    // Exactly three imports, and only these names: the headline lane, its two scorers' constants and the folding helper.
    const imports: Array<{ names: string[]; from: string }> = [];
    for (const m of ATTACH_SRC.matchAll(/^import\s*\{([^}]*)\}\s*from\s*"([^"]+)";/gm)) {
      imports.push({
        names: (m[1] ?? "").split(",").map((x) => x.trim().replace(/^type\s+/, "")).filter(Boolean).sort(),
        from: m[2] ?? "",
      });
    }
    expect(imports).toEqual([
      { names: ["HEADLINE_LANE_MAX_HOURS", "HEADLINE_LANE_MIN_SHARED"], from: "./constants.ts" },
      { names: ["headlineLane", "headlineOnlyScore"], from: "./ensemble.ts" },
      { names: ["HeadlineTokens", "normalizeTurkish"], from: "./fingerprint.ts" },
    ]);
    expect([...ATTACH_SRC.matchAll(/^import\b/gm)]).toHaveLength(3);
    expect(ATTACH_SRC).not.toMatch(/\bfetch\s*\(|\bDeno\b|createClient|\.rpc\(/);
  });

  it("an article with no source cannot be checked against sourceIds: no-source", () => {
    const a = { ...article(HURRIYET_FETO), sourceId: null };
    expect(attachDecision(a, context())).toEqual({ reason: "no-source" });
  });

  it("a non-finite published time is no-match", () => {
    const a = { ...article(HURRIYET_FETO), publishedMs: Number.NaN };
    expect(attachDecision(a, context())).toEqual({ reason: "no-match" });
  });

  it("members outside HEADLINE_LANE_MAX_HOURS do not count, for the exact title either", () => {
    const base = Date.parse(HURRIYET_FETO[3]);
    const late = (hours: number): FixtureMember => ["ffffffff-0000-4000-8000-000000000001", "star", HURRIYET_FETO[2], new Date(base + hours * 3_600_000).toISOString(), null];
    expect(attachDecision(article(HURRIYET_FETO), [candidate("c", [late(HEADLINE_LANE_MAX_HOURS - 0.01)])])).toMatchObject({ lane: "exact-title" });
    expect(attachDecision(article(HURRIYET_FETO), [candidate("c", [late(HEADLINE_LANE_MAX_HOURS + 0.01)])])).toEqual({ reason: "no-match" });
    expect(attachDecision(article(HURRIYET_FETO), [candidate("c", [late(-(HEADLINE_LANE_MAX_HOURS + 0.01))])])).toEqual({ reason: "no-match" });
    // The same limit applies to an equal fingerprint.
    const fp = "0123456789abcdef0123456789abcdef01234567";
    const withFp = article(["aaaaaaaa-0000-4000-8000-000000000009", "x", "başka bir şey", HURRIYET_FETO[3], fp]);
    const old: FixtureMember = ["ffffffff-0000-4000-8000-000000000002", "star", "bambaşka bir başlık", new Date(base + 7 * 3_600_000).toISOString(), fp];
    expect(attachDecision(withFp, [candidate("c", [old])])).toEqual({ reason: "no-match" });
  });

  it("an identical headline with fewer than three tokens is no identity key (but the pair may still be a lane match)", () => {
    const t = "Deprem oldu";
    const a = article(["aaaaaaaa-0000-4000-8000-0000000000a1", "sabah", t, "2026-11-02T07:00:00Z", null]);
    const m: FixtureMember = ["aaaaaaaa-0000-4000-8000-0000000000a2", "star", t, "2026-11-02T07:05:00Z", null];
    expect(a.tokens.tokens.size).toBeLessThan(3);
    expect(attachDecision(a, [candidate("c", [m])])).toEqual({ reason: "no-match" });
  });

  it("the live-title lane ('CANLI | ...') is never attach evidence", () => {
    const t = "CANLI | Cumhurbaşkanı Erdoğan konuşuyor";
    const a = article(["aaaaaaaa-0000-4000-8000-0000000000b1", "sabah", t, "2026-11-02T07:00:00Z", null]);
    const m: FixtureMember = ["aaaaaaaa-0000-4000-8000-0000000000b2", "star", t, "2026-11-02T07:02:00Z", null];
    expect(headlineLane(a.tokens, toMember(m).tokens, 0.03).kind).toBe("live-title");
    expect(attachDecision(a, [candidate("c", [m])])).toEqual({ reason: "no-match" });
  });

  it("the article itself is never its own evidence", () => {
    const a = article(HURRIYET_FETO);
    const self: FixtureMember = [HURRIYET_FETO[0], "hurriyet", HURRIYET_FETO[2], HURRIYET_FETO[3], null];
    expect(attachDecision(a, [candidate("c", [self], { sourceIds: new Set() })])).toEqual({ reason: "no-match" });
  });

  it("an empty candidate list is no-match", () => {
    expect(attachDecision(article(HURRIYET_FETO), [])).toEqual({ reason: "no-match" });
  });

  it("stale: an article older than HEADLINE_LANE_MAX_HOURS at nowMs is refused before any matching", () => {
    const a = article(HURRIYET_FETO);
    const t0 = a.publishedMs;
    expect(attachDecision(a, context(), { nowMs: t0 + 2 * 3_600_000 })).toMatchObject({ clusterId: FETO_ID });
    expect(attachDecision(a, context(), { nowMs: t0 + (HEADLINE_LANE_MAX_HOURS + 0.01) * 3_600_000 })).toEqual({ reason: "stale" });
    expect(attachIsStale(t0, t0 + HEADLINE_LANE_MAX_HOURS * 3_600_000)).toBe(false);
    expect(attachIsStale(t0, t0 + HEADLINE_LANE_MAX_HOURS * 3_600_000 + 1)).toBe(true);
    expect(attachIsStale(Number.NaN, t0)).toBe(true);
  });

  it("does not mutate its inputs", () => {
    const a = article(HURRIYET_FETO);
    const ctx = context();
    const snapshot = JSON.stringify(ctx.map((c) => ({ ...c, sourceIds: [...c.sourceIds], members: c.members.map((m) => ({ ...m, tokens: [...m.tokens.tokens] })) })));
    attachDecision(a, ctx);
    expect(JSON.stringify(ctx.map((c) => ({ ...c, sourceIds: [...c.sourceIds], members: c.members.map((m) => ({ ...m, tokens: [...m.tokens.tokens] })) })))).toBe(snapshot);
  });
});

describe("ATTACH_MIN_POLITICS_SHARE parity", () => {
  it("is 0.6, the POLITICS_THRESHOLD of the reader's politics query", () => {
    expect(ATTACH_MIN_POLITICS_SHARE).toBe(0.6);
    const reader = readFileSync(resolve(ROOT, "src/lib/clusters/politics-query.ts"), "utf8");
    expect(reader).toContain("const POLITICS_THRESHOLD = 0.6;");
  });

  it("the attach cap and margin are the documented values", () => {
    expect(ATTACH_MAX_PER_DRAIN).toBe(25);
    expect(ATTACH_AMBIGUITY_MARGIN).toBe(0.05);
    expect(ATTACH_READ_FLOOR_MS).toBe(5_000);
  });

  it("the read floor equals the consumer's READ_BUDGET_FLOOR_MS", () => {
    const src = readFileSync(resolve(ROOT, "supabase/functions/cluster-consumer/index.ts"), "utf8");
    expect(src).toContain("const READ_BUDGET_FLOOR_MS = 5_000;");
  });
});

describe("planAttachRead: the attach queue must never starve cluster_work", () => {
  const budgetMs = 30_000;

  it("reads nothing while cluster_work still has messages", () => {
    expect(planAttachRead({ clusterWorkEmpty: false, elapsedMs: 0, budgetMs, cap: 25 })).toBe(0);
    expect(planAttachRead({ clusterWorkEmpty: false, elapsedMs: 1_000, budgetMs, cap: 1 })).toBe(0);
  });

  it("reads nothing when less than the read-budget floor remains", () => {
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: budgetMs - ATTACH_READ_FLOOR_MS + 1, budgetMs, cap: 25 })).toBe(0);
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: budgetMs, budgetMs, cap: 25 })).toBe(0);
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: budgetMs + 5_000, budgetMs, cap: 25 })).toBe(0);
  });

  it("reads at exactly the floor, up to the cap", () => {
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: budgetMs - ATTACH_READ_FLOOR_MS, budgetMs, cap: 25 })).toBe(25);
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: 0, budgetMs, cap: 10 })).toBe(10);
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: 0, budgetMs, cap: 1 })).toBe(1);
  });

  it("never returns more than ATTACH_MAX_PER_DRAIN, whatever cap asks for", () => {
    for (const cap of [26, 100, 10_000, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) {
      expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: 0, budgetMs, cap })).toBe(ATTACH_MAX_PER_DRAIN);
    }
  });

  it("returns 0 for a non-positive, fractional-below-one or non-finite cap, elapsed or budget", () => {
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: 0, budgetMs, cap: 0 })).toBe(0);
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: 0, budgetMs, cap: -3 })).toBe(0);
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: 0, budgetMs, cap: 0.9 })).toBe(0);
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: 0, budgetMs, cap: Number.NaN })).toBe(0);
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: Number.NaN, budgetMs, cap: 25 })).toBe(0);
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: 0, budgetMs: Number.NaN, cap: 25 })).toBe(0);
  });

  it("returns an integer", () => {
    expect(Number.isInteger(planAttachRead({ clusterWorkEmpty: true, elapsedMs: 0, budgetMs, cap: 7.9 }))).toBe(true);
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: 0, budgetMs, cap: 7.9 })).toBe(7);
  });

  it("honours an explicit floor", () => {
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: 20_000, budgetMs, cap: 25, floorMs: 10_000 })).toBe(25);
    expect(planAttachRead({ clusterWorkEmpty: true, elapsedMs: 20_001, budgetMs, cap: 25, floorMs: 10_000 })).toBe(0);
  });

  it("capacity: the cap covers the measured peak (467 candidates an hour, 7.8 a minute) with a wide margin", () => {
    const peakPerMinute = 467 / 60;
    expect(ATTACH_MAX_PER_DRAIN).toBeGreaterThan(peakPerMinute * 3);
  });
});

// h70-mergequality-3: the headline lane must not cross actors. Cluster 6e585787
// (AK Parti Sozcusu Celik) took anadolu-ajansi "Cumhurbaskani Erdogan, Karabag
// Zaferi'nin 6. yilini kutladi" through the headline lane against aksam's comma-less
// member title, which the subject veto cannot see. The attach probe uses the same
// lane, so it shares the rule.
describe("attachDecision: the headline lane does not cross actors (h70-mergequality-3)", () => {
  const AA_TITLE = "Cumhurbaşkanı Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı";
  const AKSAM_TITLE = "AK Parti Sözcüsü Çelik Karabağ Zaferi'nin 6. yılını kutladı";
  const AA_ROW: FixtureMember = ["aaaaaaaa-0000-4000-8000-0000000000b1", "anadolu-ajansi", AA_TITLE, "2026-11-08T11:06:00Z", null];
  const AKSAM_ROW: FixtureMember = ["bbbbbbbb-0000-4000-8000-0000000000b1", "aksam", AKSAM_TITLE, "2026-11-08T08:00:00Z", null];
  const KARABAG_ID = "6e585787-0000-4000-8000-000000000001";

  it("control: the lane itself fires for the pair, so a missing match below is the actor rule", () => {
    const a = article(AA_ROW);
    const m = toMember(AKSAM_ROW);
    const hours = Math.abs(a.publishedMs - m.publishedMs) / 3_600_000;
    expect(headlineLane(a.tokens, m.tokens, hours).fired).toBe(true);
    expect(headlineOnlyScore(a.tokens, m.tokens, hours)).toBeGreaterThan(0);
  });

  it("an AA-like article against an aksam-like member yields no headline evidence", () => {
    const decision = attachDecision(article(AA_ROW), [candidate(KARABAG_ID, [AKSAM_ROW])]);
    expect(decision).toEqual({ reason: "no-match" });
  });

  it("the same refusal holds when the member has a comma subject of its own (the old subject veto pair)", () => {
    const posta: FixtureMember = ["cccccccc-0000-4000-8000-0000000000b1", "posta", "AK Parti Sözcüsü Çelik, Karabağ Zaferi'nin 6. yılını kutladı", "2026-11-08T08:30:00Z", null];
    expect(attachDecision(article(AA_ROW), [candidate(KARABAG_ID, [posta])])).toEqual({ reason: "no-match" });
  });

  it("one actor-mismatched member does not hide a genuine one: a same-actor member of the same cluster still attaches", () => {
    const sameActor: FixtureMember = ["dddddddd-0000-4000-8000-0000000000b1", "trt-haber", "Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı", "2026-11-08T09:00:00Z", null];
    const decision = attachDecision(article(AA_ROW), [candidate(KARABAG_ID, [AKSAM_ROW, sameActor])]);
    expect(decision).toMatchObject({ clusterId: KARABAG_ID, lane: "headline" });
    expect((decision as { score: number }).score).toBeGreaterThan(0);
  });

  it("a same-actor pair with one comma-less title (no mismatch) keeps its evidence", () => {
    const withComma: FixtureMember = ["eeeeeeee-0000-4000-8000-0000000000b1", "posta", "AK Parti Sözcüsü Çelik, Karabağ Zaferi'nin 6. yılını kutladı", "2026-11-08T11:00:00Z", null];
    const decision = attachDecision(article(["ffffffff-0000-4000-8000-0000000000b1", "milliyet", AKSAM_TITLE, "2026-11-08T11:10:00Z", null]), [candidate(KARABAG_ID, [withComma])]);
    expect(decision).toMatchObject({ clusterId: KARABAG_ID });
  });

  it("the exact-title and fingerprint evidence are untouched by the rule", () => {
    const sameTitle: FixtureMember = ["12121212-0000-4000-8000-0000000000b1", "haberturk", AA_TITLE, "2026-11-08T11:00:00Z", null];
    expect(attachDecision(article(AA_ROW), [candidate(KARABAG_ID, [sameTitle])])).toMatchObject({ lane: "exact-title", score: 1 });
    const fp = "0123456789abcdef0123456789abcdef01234567";
    const withFp: FixtureMember = ["34343434-0000-4000-8000-0000000000b1", "aksam", AKSAM_TITLE, "2026-11-08T10:00:00Z", fp];
    const a = article(["56565656-0000-4000-8000-0000000000b1", "anadolu-ajansi", AA_TITLE, "2026-11-08T11:06:00Z", fp]);
    expect(attachDecision(a, [candidate(KARABAG_ID, [withFp])])).toEqual({ clusterId: KARABAG_ID, score: 1, lane: "fingerprint" });
  });
});
