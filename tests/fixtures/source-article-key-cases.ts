// Shared truth table for the source article key (twin-articles).
//
// Consumed by tests/functions/_shared/article-key.test.ts (TS implementation)
// and, behind TAYF_PSQL, by tests/migrations/113-source-article-key.test.ts and
// tests/migrations/149-source-article-key-parent-segment.test.ts (the SQL twin
// public.source_article_key). Both must agree on every row. The live parity
// runs against the NEWEST re-creation of the function (migration 149); a
// database that only has 113 fails the "parent-segment ids (149)" rows.
//
// The first block is real production URLs (read-only sample of the last day,
// 2026-10-23); the "parent-segment ids (149)" block is verbatim stored urls
// from 2026-11-02 (hunt 24); the rest pins the algorithm's edges.

export interface SourceArticleKeyCase {
  url: string;
  key: string | null;
  note: string;
}

export const SOURCE_ARTICLE_KEY_CASES: SourceArticleKeyCase[] = [
  // ---- the incident pair (articles 1fe98b20 / 8f291028) ---------------------
  {
    url: "https://www.aksam.com.tr/guncel/bakan-gulerden-mekke-ittifaki-vurgusu/haber-1708664",
    key: "1708664",
    note: "aksam twin, first headline",
  },
  {
    url: "https://www.aksam.com.tr/guncel/bakan-gulerden-mekke-ittifaki-vurgusu-husilerle-catismaya-girilmeyecek/haber-1708664",
    key: "1708664",
    note: "aksam twin, edited headline (new slug, same id)",
  },

  // ---- real shapes from the Step 0 sample (3 per source) --------------------
  {
    url: "https://www.aksam.com.tr/spor/devlerin-gozu-batrakovda/haber-1708701",
    key: "1708701",
    note: "aksam: /haber-<id> suffix",
  },
  {
    url: "https://www.aksam.com.tr/spor/saras-jasikevicius-karakterimiz-ve-inancimizla-kazandik/haber-1708700",
    key: "1708700",
    note: "aksam",
  },
  {
    url: "https://www.aksam.com.tr/yasam/kacirildi-sanildi-gercek-bambaska-cikti-borclu-adami-ailesi-bagaja-atip-eve-goturdu/haber-1708699",
    key: "1708699",
    note: "aksam",
  },
  {
    url: "https://www.aa.com.tr/tr/spor/lider-kayserisporda-seferiden-11-macta-9-gol/4099137",
    key: "4099137",
    note: "anadolu-ajansi: id is the whole last segment; '11' and '9' in the slug are too short",
  },
  {
    url: "https://www.aa.com.tr/tr/gundem/guneydogunun-en-yuksek-dagina-kayak-merkezi-kuruluyor/4099138",
    key: "4099138",
    note: "anadolu-ajansi",
  },
  {
    url: "https://www.aa.com.tr/tr/dunya/israil-ordusu-bati-serianin-el-halil-sehrine-genis-capli-askeri-operasyon-baslattigini-duyurdu/4099141",
    key: "4099141",
    note: "anadolu-ajansi",
  },
  {
    url: "https://www.cnnturk.com/dunya/abdden-irana-yeni-saldiri-sinyali-irana-bir-destansi-ofke-saldirisi-daha-yapacagiz-3483798",
    key: "3483798",
    note: "cnn-turk carries a trailing -<id>, so it is NOT a slug-only shape",
  },
  {
    url: "https://www.cnnturk.com/turkiye/24-ekim-resmi-gazete-kararlari-resmi-gazetede-neler-var-3483797",
    key: "3483797",
    note: "cnn-turk: '24' in the slug is too short to count",
  },
  {
    url: "https://www.cnnturk.com/video/dunya/yahudi-kongresi-baskani-netanyahuya-ates-puskurdu-yaziklar-olsun-size-3483796",
    key: "3483796",
    note: "cnn-turk video section, same trailing id shape",
  },
  {
    url: "https://www.dunya.com/gundem/bakan-kurum-gelecek-50-yil-sekillenecek-haberi-845066",
    key: "845066",
    note: "dunya twin, first headline (6-digit ids sit on the lower bound)",
  },
  {
    url: "https://www.dunya.com/gundem/gelecek-50-yil-sekillenecek-haberi-845066",
    key: "845066",
    note: "dunya twin, edited headline",
  },
  {
    url: "https://www.dunya.com/dunya-hashtag/ise-alinmayanlar-kendini-dogrulayan-kehanet-haberi-845048",
    key: "845048",
    note: "dunya",
  },
  {
    url: "https://www.yenisafak.com/galeri/gundem/kayseride-otomobil-ile-motosiklet-carpisti-bir-kisi-oldu-bir-kisi-yaralandi-4866822",
    key: "4866822",
    note: "yeni-safak gallery",
  },
  {
    url: "https://www.yenisafak.com/gundem/corumda-ambulans-ile-otomobil-carpisti-lpg-tanki-yola-savruldu-4866821",
    key: "4866821",
    note: "yeni-safak",
  },
  {
    url: "https://www.yenisafak.com/galeri/ekonomi/izmir-odemis-bademlide-kestane-hasadi-suruyor-urunler-avrupa-ve-orta-doguya-ihrac-ediliyor-4866819",
    key: "4866819",
    note: "yeni-safak gallery",
  },
  {
    url: "https://www.dailysabah.com/business/economy/german-industry-lost-nearly-500000-jobs-since-2019-ifo",
    key: null,
    note: "a round number inside a slug-only URL is a quantity, not an id (round-number guard). The 7-day replay merged two unrelated daily-sabah stories on '500000'; daily-sabah is also in ARTICLE_KEY_EXCLUDED_SLUGS",
  },
  {
    url: "https://www.dailysabah.com/world/mid-east/iran-plans-to-target-gulf-undersea-cables-if-attacked-report",
    key: null,
    note: "slug-only shape: no digit run at all",
  },

  // ---- a-news: slug-only English outlet (30-day replay, 2026-10-23) -----------
  {
    url: "https://www.anews.com.tr/world/2026/09/26/noreaster-leaves-over-100000-customers-without-power-in-us-northeast-over-400-flights-canceled",
    key: null,
    note: "a-news false group 100000 (1 of 3): round number in the slug",
  },
  {
    url: "https://www.anews.com.tr/asia/2026/10/01/chinas-tencent-leases-100000-chips-from-us-oracle-amid-escalating-ai-race-report",
    key: null,
    note: "a-news false group 100000 (2 of 3)",
  },
  {
    url: "https://www.anews.com.tr/world/2026/10/06/more-than-250000-protesters-at-school-marches-across-france",
    key: null,
    note: "a-news false group 250000",
  },
  {
    url: "https://www.anews.com.tr/economy/2026/10/09/trump-russia-to-immediately-supply-300000-tons-of-diesel-fuel",
    key: null,
    note: "a-news false group 300000",
  },
  {
    url: "https://www.anews.com.tr/world/2026/10/20/germanys-afd-investigates-alleged-theft-of-421000-internal-emails",
    key: "421000",
    note: "a-news: 421,000 is not round (three zeros), so the guard keeps it; only ARTICLE_KEY_EXCLUDED_SLUGS stops a-news from using it",
  },
  {
    url: "https://www.anews.com.tr/world/2026/10/21/macron-arrives-in-saudi-arabia-on-gulf-tour-elysee-1792588576",
    key: "1792588576",
    note: "a-news: a few urls end in a 10-digit epoch-like suffix; a key here, but a-news is excluded",
  },

  // ---- date-shaped runs are not ids ------------------------------------------
  { url: "https://x.test/2026/10/23", key: null, note: "date in path segments: last segment is 2 digits" },
  { url: "https://x.test/haber/20261023", key: null, note: "8-digit date-shaped run" },
  { url: "https://x.test/20261023-ozet", key: null, note: "date prefix in a slug" },
  { url: "https://x.test/a/20261023153000", key: null, note: "14-digit timestamp" },
  { url: "https://x.test/a/2026102315", key: null, note: "10-digit date-hour" },
  { url: "https://x.test/a/202610231530", key: null, note: "12-digit date-time" },
  { url: "https://x.test/a/slug-1234567-20261023", key: "1234567", note: "a trailing date is skipped, the last kept run wins" },
  { url: "https://x.test/a/slug-20261023-1234567", key: "1234567", note: "a leading date is skipped" },
  { url: "https://x.test/a/202610231", key: "202610231", note: "9 digits is not a date-shaped length, so it is kept" },
  { url: "https://x.test/a/20261323", key: "20261323", note: "month 13 is not a date, so it is kept" },
  { url: "https://x.test/a/21001231", key: "21001231", note: "year outside 19xx/20xx is not date-shaped" },
  { url: "https://x.test/a/79691716", key: "79691716", note: "8 digits that do not start like a date (dw-turkce)" },

  // ---- query, fragment, port, scheme ------------------------------------------
  {
    url: "https://x.test/a/haber-1708664?utm_source=x&id=9999999#top",
    key: "1708664",
    note: "query and fragment never reach the path",
  },
  { url: "https://x.test/a/slug?id=1234567", key: null, note: "an id only in the query string is ignored" },
  { url: "https://x.test/a/slug#1234567", key: null, note: "an id only in the fragment is ignored" },
  { url: "https://x.test:8080/a/slug-1234567", key: "1234567", note: "a port is part of the authority" },
  { url: "http://x.test/a/slug-1234567", key: "1234567", note: "plain http" },
  { url: "https://x.test?id=1234567", key: null, note: "no path at all" },
  { url: "https://x.test", key: null, note: "bare host" },
  { url: "https://x.test/", key: null, note: "bare host with a slash" },

  // ---- trailing slash and file extensions ------------------------------------
  { url: "https://x.test/slug-1234567/", key: "1234567", note: "trailing slash is stripped" },
  { url: "https://x.test/slug-1234567//", key: "1234567", note: "repeated trailing slashes are stripped" },
  { url: "https://x.test/slug-1234567.html", key: "1234567", note: ".html is stripped" },
  { url: "https://www.trthaber.com/haber/gundem/cumhurbaskani-erdogan-konusuyor-960417.html", key: "960417", note: "trt-haber shape" },
  { url: "https://x.test/slug-1234567.HTM", key: "1234567", note: "extension match is case-insensitive" },
  { url: "https://x.test/slug-1234567.shtml", key: "1234567", note: ".shtml" },
  { url: "https://x.test/slug-1234567.php", key: "1234567", note: ".php" },
  { url: "https://x.test/slug-1234567.aspx", key: "1234567", note: ".aspx" },
  { url: "https://x.test/slug-1234567.asp", key: "1234567", note: ".asp" },
  { url: "https://x.test/slug-1234567.jpg", key: "1234567", note: "other extensions are not stripped but cannot hide the run" },
  { url: "https://x.test/a/12345678.html", key: "12345678", note: "id is the whole file name" },

  // ---- digit-length bounds -----------------------------------------------------
  { url: "https://x.test/slug-12345", key: null, note: "5 digits is below the minimum" },
  { url: "https://x.test/slug-123456", key: "123456", note: "6 digits is the minimum" },
  { url: "https://x.test/slug-12345678901234567890", key: "12345678901234567890", note: "20 digits is the maximum" },
  { url: "https://x.test/slug-123456789012345678901", key: null, note: "21 digits is above the maximum" },

  // ---- only the last path segment counts --------------------------------------
  {
    url: "https://x.test/kategori/123456/slug",
    key: null,
    note: "an id in a parent segment is a section id: keying on it would merge different stories",
  },
  { url: "https://x.test/kategori/123456/slug-7654321", key: "7654321", note: "the last segment decides" },
  { url: "https://x.test/1234567-slug-7654321", key: "7654321", note: "the LAST run in the segment wins" },
  { url: "https://x.test/a/1234567-slug", key: "1234567", note: "a leading id is fine when it is the only run" },

  // ---- parent-segment ids (149) -------------------------------------------------
  // evrensel puts its CMS id in /haber/<id>/<slug> and indyturk in
  // /node/<id>/[<section>/]<slug>: the id is a PARENT segment and the slug
  // changes with every headline edit, so the last-segment rule gave these two
  // outlets no key at all. Verbatim stored urls, prod 2026-11-02 (hunt 24).
  {
    url: "https://www.evrensel.net/haber/6007631/akaryakita-zam-ustune-zam-otogaza-9-tl-zam-bekleniyor-litresi-50-tlyi-asacak?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
    key: "6007631",
    note: "evrensel 6007631 (b3a2b8e4), first slug; the query never reaches the path",
  },
  {
    url: "https://www.evrensel.net/haber/6007631/akaryakita-zam-ustune-zam-otogaza-9-tl-zam-bekleniyor-litresi-50-tl-yi-asacak?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
    key: "6007631",
    note: "evrensel 6007631 (829e55e4), re-titled slug, same id",
  },
  {
    url: "https://www.indyturk.com/node/784651/heatin-83-ya%C5%9F%C4%B1ndaki-usta-y%C3%B6netmeni-kazara-kendini-vurdu",
    key: "784651",
    note: "indyturk node 784651 (6cf47ad9), id right after /node/",
  },
  {
    url: "https://www.indyturk.com/node/784651/k%C3%BClt%C3%BCr/heatin-83-ya%C5%9F%C4%B1ndaki-usta-y%C3%B6netmeni-kazara-kendini-vurdu",
    key: "784651",
    note: "indyturk node 784651 (5e0c2aa6), the section segment moved in after the id",
  },
  {
    url: "https://www.evrensel.net/haber/6006697/sarsingil-sorusturmasinda-akpli-serkan-korkutata-gozaltina-alindi?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
    key: "6006697",
    note: "evrensel 6006697, another re-titled pair (4aed9bd6)",
  },
  {
    url: "https://www.evrensel.net/haber/6006697/sarigul-sorusturmasinda-akp-li-serkan-korkutata-gozaltina-alindi?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
    key: "6006697",
    note: "evrensel 6006697, the re-titled twin (3b6a4cf3)",
  },
  {
    url: "https://www.indyturk.com/node/784495/k%C3%BClt%C3%BCr/matrix-y%C4%B1ld%C4%B1z%C4%B1-daha-seksi-giyin-denilince-b%C3%BCy%C3%BCk-kazan%C3%A7-getirecek-rol%C3%BC-reddetmi%C5%9F",
    key: "784495",
    note: "indyturk 784495, another re-titled pair (1f04dd37)",
  },
  {
    url: "https://www.indyturk.com/node/784495/k%C3%BClt%C3%BCr/matrix-y%C4%B1ld%C4%B1z%C4%B1-daha-seksi-giyin-denilince-%C3%A7ok-kazand%C4%B1racak-rol%C3%BC-reddetmi%C5%9F",
    key: "784495",
    note: "indyturk 784495, the re-titled twin (fb1484a8)",
  },
  {
    url: "https://www.evrensel.net/haber/6006702/fon-vurgunu-sorusturmasi-gozaltina-alinan-altinbas-holding-in-sahibi-nusret-altinbas-a-tutuklama-talebi?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
    key: "6006702",
    note: "evrensel: a different article, a different id, a different key",
  },
  {
    url: "https://www.evrensel.net/haber/6006706/super-lig-9uncu-hafta-maci-besiktas-basaksehir-macinin-ilk-11leri-belli-oldu?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
    key: "6006706",
    note: "evrensel: another article; '9' and '11' in the slug are too short to count",
  },
  {
    url: "https://www.indyturk.com/node/784377/haber/d%C3%BCnyada-genelinde-kriz-ve-acil-durum-haz%C4%B1rl%C4%B1klar%C4%B1-h%C4%B1zland%C4%B1-avrupa-abd-ve-asyada",
    key: "784377",
    note: "indyturk: a different article, section segment /haber/ after the id",
  },
  {
    url: "https://www.indyturk.com/node/784544/haber/%C3%B6zg%C3%BCr-%C3%B6zel-%C3%BCmraniye-ata%C5%9Fehir-g%C3%B6ztepe-metro-hatt%C4%B1n%C4%B1n-test-s%C3%BCr%C3%BC%C5%9F%C3%BCne-kat%C4%B1ld%C4%B1",
    key: "784544",
    note: "indyturk: another article, another id",
  },
  {
    url: "https://evil.test/haber/6007631/x",
    key: null,
    note: "host anchoring: the evrensel rule does not apply to another host (the slug 'x' has no run)",
  },
  {
    url: "https://www.evrensel.net.evil.test/haber/6007631/x",
    key: null,
    note: "host anchoring: evrensel.net as a prefix of another host is not evrensel.net",
  },
  {
    url: "https://notevrensel.net/haber/6007631/x",
    key: null,
    note: "host anchoring: a host that merely ends in 'evrensel.net' is not evrensel.net",
  },
  {
    url: "https://www.indyturk.com.evil.test/node/784651/x",
    key: null,
    note: "host anchoring (indyturk): a longer host is not indyturk.com",
  },
  {
    url: "https://www.evrensel.net/node/6007631/x",
    key: null,
    note: "path anchoring: /node/ is indyturk's shape, not evrensel's",
  },
  {
    url: "https://www.evrensel.net/haber/600763/",
    key: "600763",
    note: "6 digits is the minimum for a parent id; a trailing slash with no slug",
  },
  {
    url: "http://evrensel.net/haber/6007631/x",
    key: "6007631",
    note: "plain http, no www",
  },
  {
    url: "https://WWW.EVRENSEL.NET/haber/6007631/x",
    key: "6007631",
    note: "the host match is case-insensitive",
  },
  {
    url: "https://www.evrensel.net/haber/6007631",
    key: "6007631",
    note: "the id may end the url (no slug)",
  },
  {
    url: "https://www.evrensel.net/haber/12345/slug",
    key: null,
    note: "5 digits is below the minimum: no parent key, and the slug has no run",
  },
  {
    url: "https://www.evrensel.net/haber/100000/slug",
    key: null,
    note: "round guard: 100000 is a quantity, so the parent rule does not return it; the last segment 'slug' has no run",
  },
  {
    url: "https://www.evrensel.net/haber/20261023/slug",
    key: null,
    note: "date guard: an 8-digit date-shaped run is not an id; the last segment has no run",
  },
  {
    url: "https://www.evrensel.net/haber/100000/slug-7654321",
    key: "7654321",
    note: "a rejected parent run falls through to the last-segment rule, which keeps its own id",
  },
  {
    url: "https://www.evrensel.net/haber/6007631/slug-7654321",
    key: "6007631",
    note: "when both exist the host-anchored parent id wins over a run in the slug",
  },

  // ---- not a URL ----------------------------------------------------------------
  { url: "", key: null, note: "empty string" },
  { url: "not a url", key: null, note: "no scheme" },
  { url: "/a/haber-1234567", key: null, note: "relative path: no scheme and authority" },
  { url: "//x.test/a/haber-1234567", key: null, note: "scheme-relative" },
  { url: "1http://x.test/a/slug-1234567", key: null, note: "scheme must start with a letter" },
];
