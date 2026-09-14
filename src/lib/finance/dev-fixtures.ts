// Dev-only stand-in for the finance tables (migrations 049/050) so the
// /ekonomi pages can be looked at on a machine whose database has not had
// the migrations applied. Enabled by TAYF_FAKE_FINANCE=1 in
// lib/supabase/server.ts, never in production. Quotes still come from
// Yahoo, so prices on screen are real; everything else here is invented.

import { createSupabaseFake, type BuilderState } from "../../../tests/_helpers/supabase-fake";

const H = 3600 * 1000;
const D = 24 * H;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const day = (daysAgo: number) => new Date(now + 3 * H - daysAgo * D).toISOString().slice(0, 10);

const SOURCES = {
  bloomberght: { name: "Bloomberg HT", slug: "bloomberght" },
  dunya: { name: "Dünya", slug: "dunya" },
  ekonomim: { name: "Ekonomim", slug: "ekonomim" },
  aa: { name: "Anadolu Ajansı", slug: "aa" },
  hurriyet: { name: "Hürriyet", slug: "hurriyet" },
  sozcu: { name: "Sözcü", slug: "sozcu" },
  ntv: { name: "NTV", slug: "ntv" },
  haberturk: { name: "Habertürk", slug: "haberturk" },
  paraanaliz: { name: "Paraanaliz", slug: "paraanaliz" },
};

const COMPANIES = [
  { kap_member_oid: "o-thyao", tickers: ["THYAO"], title: "TÜRK HAVA YOLLARI A.O.", city: "İSTANBUL", shares_traded: true },
  { kap_member_oid: "o-asels", tickers: ["ASELS"], title: "ASELSAN ELEKTRONİK SANAYİ VE TİCARET A.Ş.", city: "ANKARA", shares_traded: true },
  { kap_member_oid: "o-vestl", tickers: ["VESTL"], title: "VESTEL ELEKTRONİK SANAYİ VE TİCARET A.Ş.", city: "MANİSA", shares_traded: true },
  { kap_member_oid: "o-eregl", tickers: ["EREGL"], title: "EREĞLİ DEMİR VE ÇELİK FABRİKALARI T.A.Ş.", city: "ZONGULDAK", shares_traded: true },
  { kap_member_oid: "o-bimas", tickers: ["BIMAS"], title: "BİM BİRLEŞİK MAĞAZALAR A.Ş.", city: "İSTANBUL", shares_traded: true },
  { kap_member_oid: "o-sasa", tickers: ["SASA"], title: "SASA POLYESTER SANAYİ A.Ş.", city: "ADANA", shares_traded: true },
  { kap_member_oid: "o-kontr", tickers: ["KONTR"], title: "KONTROLMATİK TEKNOLOJİ ENERJİ VE MÜHENDİSLİK A.Ş.", city: "İSTANBUL", shares_traded: true },
  { kap_member_oid: "o-tuprs", tickers: ["TUPRS"], title: "TÜRKİYE PETROL RAFİNERİLERİ A.Ş.", city: "KOCAELİ", shares_traded: true },
  { kap_member_oid: "o-sise", tickers: ["SISE"], title: "TÜRKİYE ŞİŞE VE CAM FABRİKALARI A.Ş.", city: "İSTANBUL", shares_traded: true },
  { kap_member_oid: "o-hekts", tickers: ["HEKTS"], title: "HEKTAŞ TİCARET T.A.Ş.", city: "KOCAELİ", shares_traded: true },
  { kap_member_oid: "o-isctr", tickers: ["ISCTR"], title: "TÜRKİYE İŞ BANKASI A.Ş.", city: "İSTANBUL", shares_traded: true },
];

const ARTICLES = [
  { id: "a01", title: "THY, Eylül'de yolcu sayısını yüzde 9 artırdı; kapasite artışı devam ediyor", src: "bloomberght", ago: 0.4 * H, t: ["THYAO"] },
  { id: "a02", title: "ASELSAN'dan 1,2 milyar dolarlık yeni ihracat sözleşmesi", src: "aa", ago: 0.9 * H, t: ["ASELS"] },
  { id: "a03", title: "Vestel'in ikinci çeyrek kârı beklentileri aştı, hisse tavan yaptı", src: "dunya", ago: 1.3 * H, t: ["VESTL"] },
  { id: "a04", title: "Erdemir'de bedelsiz sermaye artırımı gündemde: KAP'a açıklama geldi", src: "ekonomim", ago: 1.8 * H, t: ["EREGL"] },
  { id: "a05", title: "BİM'in yeni mağaza hedefi 1.100'e yükseldi", src: "hurriyet", ago: 2.5 * H, t: ["BIMAS"] },
  { id: "a06", title: "SASA'da devre kesici: hisse yüzde 9,8 düşüşle işleme kapatıldı", src: "sozcu", ago: 3.1 * H, t: ["SASA"] },
  { id: "a07", title: "Kontrolmatik, Kazakistan'da 40 MW'lık depolama projesini üstlendi", src: "paraanaliz", ago: 3.6 * H, t: ["KONTR"] },
  { id: "a08", title: "THY ve ASELSAN savunma bakım ortaklığı için ön protokol imzaladı", src: "ntv", ago: 4.2 * H, t: ["THYAO", "ASELS"] },
  { id: "a09", title: "Tüpraş rafineri marjları üçüncü çeyrekte toparlandı", src: "bloomberght", ago: 5 * H, t: ["TUPRS"] },
  { id: "a10", title: "Şişecam Bulgaristan fabrikası için 300 milyon euroluk yatırım açıkladı", src: "dunya", ago: 6 * H, t: ["SISE"] },
  { id: "a11", title: "Hektaş bilançosunda zarar büyüdü, yönetim 'tek seferlik' dedi", src: "ekonomim", ago: 7 * H, t: ["HEKTS"] },
  { id: "a12", title: "İş Bankası'ndan yeni kaynak: 500 milyon dolarlık sendikasyon kredisi", src: "aa", ago: 8 * H, t: ["ISCTR"] },
  { id: "a13", title: "Piyasa notu: THYAO, ASELS ve TUPRS'de yabancı alımı hızlandı", src: "haberturk", ago: 9 * H, t: ["THYAO", "ASELS", "TUPRS"] },
  { id: "a14", title: "Vestel Ventures, yapay zekâ girişimine ortak oldu", src: "paraanaliz", ago: 11 * H, t: ["VESTL"] },
  { id: "a15", title: "THY'nin Boeing siparişinde teslimat takvimi öne çekildi", src: "bloomberght", ago: 14 * H, t: ["THYAO"] },
  { id: "a16", title: "Erdemir hisselerinde satış baskısı: analistler ne diyor?", src: "hurriyet", ago: 20 * H, t: ["EREGL"] },
  { id: "a17", title: "BİM, Fas'taki mağaza sayısını 800'e çıkardı", src: "ntv", ago: 26 * H, t: ["BIMAS"] },
  { id: "a18", title: "SASA'nın yeni PTA tesisinde deneme üretimi başladı", src: "dunya", ago: 30 * H, t: ["SASA"] },
  { id: "a19", title: "THY'nin ağustos doluluk oranı yüzde 87 oldu", src: "aa", ago: 33 * H, t: ["THYAO"] },
  { id: "a20", title: "ASELSAN'ın yerli radar sistemi ilk ihracat teslimatını yaptı", src: "haberturk", ago: 40 * H, t: ["ASELS"] },
].map((a) => ({
  id: a.id,
  title: a.title,
  url: `https://example.com/${a.id}`,
  published_at: iso(a.ago),
  category: "ekonomi",
  source: SOURCES[a.src as keyof typeof SOURCES],
  article_tickers: a.t.map((ticker) => ({ ticker })),
}));

const DISCLOSURES = [
  { i: 1662301, ago: 0.5 * H, codes: ["THYAO"], subject: "Özel Durum Açıklaması (Genel)", summary: "Eylül 2026 trafik sonuçları hk.", cls: "ODA" },
  { i: 1662298, ago: 1.1 * H, codes: ["ASELS"], subject: "Yeni İş İlişkisi", summary: "Yurt dışı müşteri ile sözleşme imzalanması hk.", cls: "ODA" },
  { i: 1662290, ago: 1.6 * H, codes: ["EREGL"], subject: "Sermaye Artırımı - Azaltımı İşlemlerine İlişkin Bildirim", summary: "Bedelsiz sermaye artırımı başvurusu", cls: "DG" },
  { i: 1662284, ago: 2.2 * H, codes: ["SASA"], subject: "Pay Bazında Devre Kesici Bildirimi", summary: "SASA payında devre kesici uygulanmıştır.", cls: "DKB" },
  { i: 1662270, ago: 3.4 * H, codes: ["KONTR"], subject: "Yeni İş İlişkisi", summary: "Kazakistan enerji depolama projesi", cls: "ODA" },
  { i: 1662255, ago: 5.5 * H, codes: ["SISE"], subject: "Özel Durum Açıklaması (Genel)", summary: "Bulgaristan yatırımı hk.", cls: "ODA" },
  { i: 1662240, ago: 7.2 * H, codes: ["HEKTS"], subject: "Finansal Rapor", summary: "2026 Yılı 2. Çeyrek Finansal Rapor", cls: "FR" },
  { i: 1662233, ago: 8.4 * H, codes: ["ISCTR"], subject: "Pay Dışında Sermaye Piyasası Aracı İşlemlerine İlişkin Bildirim (Faiz İçeren)", summary: "Sendikasyon kredisi", cls: "DG" },
  { i: 1662210, ago: 12 * H, codes: ["TUPRS"], subject: "Payların Geri Alınmasına İlişkin Bildirim", summary: "Geri alım işlemleri", cls: "ODA" },
  { i: 1662188, ago: 16 * H, codes: ["BIMAS"], subject: "Özel Durum Açıklaması (Genel)", summary: "Mağaza sayısı hedefi güncellemesi", cls: "ODA" },
  { i: 1662150, ago: 27 * H, codes: ["VESTL"], subject: "Finansal Rapor", summary: "2026 Yılı 2. Çeyrek Finansal Rapor", cls: "FR" },
  { i: 1662101, ago: 40 * H, codes: ["THYAO", "ASELS"], subject: "Özel Durum Açıklaması (Genel)", summary: "Bakım ortaklığı ön protokolü", cls: "ODA" },
  { i: 1661980, ago: 3 * D, codes: ["ODAS"], subject: "Kredi Derecelendirmesi", summary: "JCR Eurasia derecelendirme", cls: "ODA" },
].map((d) => ({
  disclosure_index: d.i,
  published_at: iso(d.ago),
  kap_title: COMPANIES.find((c) => c.tickers[0] === d.codes[0])?.title ?? null,
  stock_codes: d.codes,
  subject: d.subject,
  summary: d.summary,
  disclosure_class: d.cls,
}));

function attentionSeries(ticker: string, base: number, spikes: Record<number, number>): Array<{ ticker: string; day: string; articles: number; sources: number }> {
  const out = [];
  for (let d = 29; d >= 0; d--) {
    const n = spikes[d] ?? (Math.abs(Math.sin(d * 3.7 + base)) > 0.55 ? base : 0);
    if (n > 0) out.push({ ticker, day: day(d), articles: n, sources: Math.max(1, Math.ceil(n * 0.6)) });
  }
  return out;
}

const ATTENTION = [
  ...attentionSeries("THYAO", 2, { 0: 5, 1: 2, 7: 6, 14: 4 }),
  ...attentionSeries("ASELS", 1, { 0: 3, 1: 1, 9: 5 }),
  ...attentionSeries("VESTL", 1, { 0: 2, 1: 1, 3: 4 }),
  ...attentionSeries("EREGL", 1, { 0: 2 }),
  ...attentionSeries("BIMAS", 1, { 0: 1, 1: 1 }),
  ...attentionSeries("SASA", 1, { 0: 1, 1: 1, 12: 7 }),
  ...attentionSeries("KONTR", 0, { 0: 1, 20: 3 }),
  ...attentionSeries("TUPRS", 1, { 0: 2 }),
  ...attentionSeries("SISE", 0, { 0: 1 }),
  ...attentionSeries("HEKTS", 0, { 0: 1, 5: 2 }),
  ...attentionSeries("ISCTR", 1, { 0: 1 }),
];

const COVERAGE = [
  { disclosure_index: 1662301, ticker: "THYAO", disclosed_at: iso(0.5 * H), lag_minutes: 6 },
  { disclosure_index: 1662298, ticker: "ASELS", disclosed_at: iso(1.1 * H), lag_minutes: 12 },
  { disclosure_index: 1662290, ticker: "EREGL", disclosed_at: iso(1.6 * H), lag_minutes: -12 },
  { disclosure_index: 1662290, ticker: "EREGL", disclosed_at: iso(1.6 * H), lag_minutes: 1100 },
  { disclosure_index: 1662270, ticker: "KONTR", disclosed_at: iso(3.4 * H), lag_minutes: -14 },
  { disclosure_index: 1662255, ticker: "SISE", disclosed_at: iso(5.5 * H), lag_minutes: -30 },
  { disclosure_index: 1662150, ticker: "VESTL", disclosed_at: iso(27 * H), lag_minutes: 1540 },
  { disclosure_index: 1662150, ticker: "VESTL", disclosed_at: iso(27 * H), lag_minutes: 960 },
  { disclosure_index: 1662101, ticker: "THYAO", disclosed_at: iso(40 * H), lag_minutes: -2160 },
  { disclosure_index: 1662101, ticker: "THYAO", disclosed_at: iso(40 * H), lag_minutes: -1900 },
  { disclosure_index: 1662101, ticker: "ASELS", disclosed_at: iso(40 * H), lag_minutes: -2160 },
  { disclosure_index: 1662101, ticker: "ASELS", disclosed_at: iso(40 * H), lag_minutes: -1900 },
];

const HEALTH = [
  {
    last_disclosure_at: iso(0.5 * H),
    disclosures_24h: 212,
    article_tickers_24h: 37,
    tickers_24h: 11,
    last_resolved_at: iso(0.2 * H),
    companies_traded: 626,
    aliases: 1104,
  },
];

const SIGNALS = [
  { kind: "attention_spike", ticker: "THYAO", score: 4.2, evidence: { today: 5, avg7d: 1.2 }, observed_at: iso(0) },
  { kind: "attention_spike", ticker: "ASELS", score: 3.5, evidence: { today: 3, avg7d: 0.9 }, observed_at: iso(0) },
  { kind: "silent_disclosure", ticker: "HEKTS", score: 3, evidence: { disclosure_index: 1662240, subject: "Finansal Rapor", class: "FR", disclosed_at: iso(7.2 * H) }, observed_at: iso(7.2 * H) },
  { kind: "silent_disclosure", ticker: "TUPRS", score: 1, evidence: { disclosure_index: 1662210, subject: "Payların Geri Alınmasına İlişkin Bildirim", class: "ODA", disclosed_at: iso(12 * H) }, observed_at: iso(12 * H) },
  { kind: "press_ahead", ticker: "THYAO", score: 2, evidence: { disclosure_index: 1662101, articles_before: 2, median_lag_min: -2030 }, observed_at: iso(40 * H) },
  { kind: "press_ahead", ticker: "ASELS", score: 2, evidence: { disclosure_index: 1662101, articles_before: 2, median_lag_min: -2030 }, observed_at: iso(40 * H) },
];

// --- predicate helpers over the recorded builder state ----------------------

function eqVal(state: BuilderState, col: string): unknown {
  return state.eq.find((e) => e.col === col)?.val;
}
function gteVal(state: BuilderState, col: string): string | undefined {
  return state.gte.find((e) => e.col === col)?.val as string | undefined;
}
function containsVal(state: BuilderState, col: string): string[] | undefined {
  return state.contains.find((e) => e.col === col)?.val as string[] | undefined;
}
function finish<T>(rows: T[], state: BuilderState): { data: T[]; error: null } {
  return { data: state.limit ? rows.slice(0, state.limit) : rows, error: null };
}

export function createFinanceFakeClient(): unknown {
  return createSupabaseFake({
    tables: {
      articles: (state) => {
        const t = eqVal(state, "article_tickers.ticker");
        const rows = ARTICLES.filter((a) => !t || a.article_tickers.some((x) => x.ticker === t));
        return finish(rows, state);
      },
      ticker_attention_daily: (state) => {
        const t = eqVal(state, "ticker");
        const since = gteVal(state, "day") ?? "0000";
        return finish(
          ATTENTION.filter((r) => (!t || r.ticker === t) && r.day >= since),
          state,
        );
      },
      bist_companies: (state) => {
        const c = containsVal(state, "tickers");
        return finish(COMPANIES.filter((r) => !c || c.some((x) => r.tickers.includes(x))), state);
      },
      kap_disclosures: (state) => {
        const c = containsVal(state, "stock_codes");
        const since = gteVal(state, "published_at") ?? "0000";
        return finish(
          DISCLOSURES.filter((r) => (!c || c.some((x) => r.stock_codes.includes(x))) && r.published_at >= since),
          state,
        );
      },
      disclosure_coverage: (state) => {
        const t = eqVal(state, "ticker");
        return finish(COVERAGE.filter((r) => !t || r.ticker === t), state);
      },
      finance_health: HEALTH,
      finance_signals: SIGNALS,
    },
  }).client;
}
