// Sahte Overpass (sadece testlerde). Ulkeye gore farkli hata senaryolari uretir:
//  AD: normal (node, way, relation, 20 m'lik tekrar, otel, koordinatsiz oge, ayni id iki kez)
//  AF: hep HTTP 500           AG: 200 + "out of memory" remark'i ve KISMI veri   AL: HTML (gecersiz JSON)
//  AM: sonuc bos              AO: ilk istek 429, sonra basarili                  BR: tek parca sorgu timeout -> alt bolgelere ayrilir
//  AZ: eksik elements alani   BS: alt bolge sorgularindan biri hep hata (kismi sonuc kabul edilmemeli)
module.exports = function (ayarla) {
  const sayac = {};
  const yanit = (govde, status = 200) => ({ ok: status < 400, status, text: async () => (typeof govde === 'string' ? govde : JSON.stringify(govde)) });
  const camp = (id, tip, lat, lon, tags) => ({ type: tip, id, ...(tip === 'node' ? { lat, lon } : { center: { lat, lon } }), tags: { tourism: 'camp_site', ...tags } });
  const AD = [
    camp(1, 'node', 42.5, 1.5, { name: 'Camp A', website: 'a.ad', 'name:en': 'Camp A', toilets: 'yes', shower: 'yes', description: 'guzel yer' }),
    camp(2, 'way', 42.6, 1.6, { name: 'Karavan B', tourism: 'caravan_site', caravans: 'yes' }),
    camp(3, 'relation', 42.7, 1.7, { name: 'Rel C', fee: 'yes', phone: '+376 1' }),
    camp(4, 'node', 42.50009, 1.5, { /* Camp A'ya ~10 m, bilgisiz */ }),
    { type: 'node', id: 5, lat: 42.8, lon: 1.8, tags: { tourism: 'hotel', name: 'Otel' } },
    { type: 'node', id: 6, tags: { tourism: 'camp_site', name: 'Koordinatsiz' } },
    camp(1, 'node', 42.5, 1.5, { name: 'Camp A' }),
    { type: 'node', id: 7, lat: 0, lon: 0, tags: { tourism: 'camp_site' } },
  ];
  ayarla(async (url, o) => {
    const q = decodeURIComponent(String(o.body || '').replace(/^data=/, ''));
    const iso = (/ISO3166-1"="([A-Z]{2})"/.exec(q) || [])[1];
    const iso2 = (/ISO3166-2"="([A-Z]{2}-[A-Z0-9]+)"/.exec(q) || [])[1];
    const k = iso || iso2 || 'x';
    sayac[k] = (sayac[k] || 0) + 1;
    if (/admin_level"="4"/.test(q)) return yanit({ elements: iso === 'BR' ? [{ type: 'relation', id: 9, tags: { 'ISO3166-2': 'BR-SP' } }, { type: 'relation', id: 10, tags: { 'ISO3166-2': 'BR-RJ' } }] : [] });
    if (iso === 'AD') return yanit({ elements: AD });
    if (iso === 'LU') return yanit({ elements: [camp(51, 'node', 49.6, 6.1, { name: 'Pilot Kampi' })] });
    if (iso === 'AF') return yanit('hata', 500);
    if (iso === 'AG') return yanit({ remark: 'runtime error: Query ran out of memory', elements: [AD[0]] });
    if (iso === 'AL') return yanit('<html>Too busy</html>');
    if (iso === 'AM') return yanit({ elements: [] });
    if (iso === 'AZ') return yanit({ version: 0.6 });
    if (iso === 'AO') return sayac[k] === 1 ? yanit('limit', 429) : yanit({ elements: [camp(21, 'node', 8.9, 13.2, { name: 'Angola Kampi' })] });
    if (iso === 'BR') return yanit({ remark: 'runtime error: Query timed out in "query" at line 1', elements: [] });
    if (iso === 'BS') return yanit({ elements: [camp(31, 'node', 25.0, -77.3, { name: 'Bahamas' })] });
    if (iso2 === 'BR-SP') return yanit({ elements: [camp(41, 'node', -23.5, -46.6, { name: 'Sao Paulo Kampi' })] });
    if (iso2 === 'BR-RJ') return yanit({ elements: [camp(42, 'node', -22.9, -43.2, { name: 'Rio Kampi' })] });
    return yanit({ elements: [] });
  });
};
