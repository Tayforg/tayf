// Shared footnote for /ekonomi and /ekonomi/[ticker]: names the data
// sources (Yahoo Finance quotes, KAP disclosures) and disclaims investment
// advice. Deck Ekonomi review deferred item — see pack.md (Pack E). The
// sentence is exact/load-bearing; see data-note.test.tsx.
export function DataNote() {
  return (
    <p className="pt-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
      Fiyat verisi Yahoo Finance&apos;ten alınır ve gecikmeli olabilir; KAP bildirimleri kap.org.tr&apos;den. Bu sayfa
      yatırım tavsiyesi değildir.
    </p>
  );
}
