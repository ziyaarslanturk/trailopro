// Sahte ag katmani: zenginlestir.js'in tum dis cagrilarina hazir yanit verir (sadece testlerde).
// Ortam degiskenleri:  SAHTE_OVERPASS_HATA=1 -> Overpass 500 doner | SAHTE_GBIF_HATA=1 -> GBIF 500 doner
module.exports = function (NET) {
  const yanit = (govde, status = 200, headers = { 'content-type': 'application/json' }) => {
    const metin = typeof govde === 'string' ? govde : JSON.stringify(govde);
    return { status, headers, buf: Buffer.from(metin, 'utf8'), body: metin };
  };
  const KOORU = { type: 'relation', id: 777, tags: { boundary: 'national_park', name: 'Dilek Yarımadası Milli Parkı' }, bounds: { minlat: 37.0, maxlat: 38.5, minlon: 26.5, maxlon: 27.9 }, center: { lat: 37.7, lon: 27.2 } };
  const POI = [
    { type: 'node', id: 11, lat: 37.8700, lon: 27.2650, tags: { amenity: 'drinking_water' } },
    { type: 'node', id: 12, lat: 37.8680, lon: 27.2646, tags: { amenity: 'shower', name: 'Public Shower' } },
    { type: 'node', id: 13, lat: 37.8690, lon: 27.2660, tags: { shop: 'convenience' } },
    { type: 'node', id: 14, lat: 37.8695, lon: 27.2640, tags: { shop: 'yes', name: 'Setur Market' } },
    { type: 'node', id: 15, lat: 37.8710, lon: 27.2670, tags: { amenity: 'pharmacy', name: 'Oksijen Eczanesi' } },
    { type: 'node', id: 16, lat: 37.8750, lon: 27.2700, tags: { amenity: 'fuel', name: 'Moil' } },
    { type: 'node', id: 17, lat: 37.9000, lon: 27.2800, tags: { natural: 'peak', name: 'Pilav Tepe' } },
    { type: 'node', id: 18, lat: 37.8720, lon: 27.2600, tags: { place: 'village', name: 'Türkmen' } },
    { type: 'node', id: 19, lat: 37.8650, lon: 27.2500, tags: { waterway: 'waterfall', name: 'Test Şelalesi' } },
    { type: 'node', id: 20, lat: 37.8679, lon: 27.2645, tags: { tourism: 'camp_site', name: 'Komsu Kamp' } },
    KOORU,
  ];
  const OSM_ETIKETLER = {
    'node:26861211': { tourism: 'camp_site', name: 'Önder Camping', fee: 'yes', shower: 'yes', toilets: 'yes', opening_hours: '24/7', internet_access: 'wlan', capacity: '40', dog: 'no', website: 'https://onder.example.com' },
    'way:1000000001': { tourism: 'camp_site', name: 'Alan Kamp', fee: 'no', shower: 'yes', power_supply: 'yes', description: 'OSM aciklama metni' },
  };
  NET.istekler = [];
  NET.get = async (url, o = {}) => {
    NET.istekler.push(url);
    const u = String(url);
    if (/overpass/.test(u)) {
      const q = decodeURIComponent(String(o.body || '').replace(/^data=/, ''));
      if (/id:/.test(q)) {
        const els = [];
        for (const m of q.matchAll(/(node|way|relation)\(id:([\d,]+)\)/g)) for (const id of m[2].split(',')) {
          const tags = OSM_ETIKETLER[m[1] + ':' + id]; if (tags) els.push({ type: m[1], id: Number(id), tags });
        }
        return yanit({ elements: els });
      }
      if (process.env.SAHTE_OVERPASS_HATA) return yanit('hata', 500, {});
      return yanit({ elements: POI });
    }
    if (/nominatim/.test(u)) return yanit({ address: { country: 'Türkiye', province: 'Aydın', town: 'Kuşadası', suburb: 'Türkmen Mahallesi' } });
    if (/wikipedia/.test(u)) return yanit({ query: { pages: { 1: { title: 'Kuşadası', extract: 'Kuşadası, Aydın ilinin bir ilçesidir.', coordinates: [{ lat: 37.86, lon: 27.26 }] } } } });
    if (/open-meteo/.test(u)) { const enler = /latitude=([^&]+)/.exec(u)[1].split(',').map(Number); return yanit({ elevation: enler.map(la => Math.round(la * 10) % 97) }); }
    if (/gbif\.org\/v1\/occurrence/.test(u)) {
      if (process.env.SAHTE_GBIF_HATA) return yanit('hata', 500, {});
      if (/classKey=212/.test(u)) return yanit({ results: [{ species: 'Larus michahellis', speciesKey: 2481139, vernacularName: 'Yellow-legged Gull' }, { species: 'Hirundo rustica', speciesKey: 2489000, vernacularName: 'Barn Swallow' }] });
      if (/classKey=359/.test(u)) return yanit({ results: [{ species: 'Sciurus anomalus', speciesKey: 2437000, vernacularName: 'Caucasian Squirrel' }] });
      if (/kingdomKey=6/.test(u)) return yanit({ results: [{ species: 'Nerium oleander', speciesKey: 3170000 }] });
      return yanit({ results: [] });
    }
    if (/gbif\.org\/v1\/species\/(\d+)\/vernacularNames/.test(u)) {
      const k = /species\/(\d+)\//.exec(u)[1];
      if (k === '2481139') return yanit({ results: [{ language: 'eng', vernacularName: 'Yellow-legged Gull' }, { language: 'tur', vernacularName: 'Gümüş martı' }] });
      if (k === '3170000') return yanit({ results: [{ language: 'tur', vernacularName: 'Zakkum' }] });
      return yanit({ results: [{ language: 'eng', vernacularName: 'Something' }] });
    }
    // her sey digeri: kamp sitesi
    return yanit('<html><head><title>Kamp</title><meta name="description" content="Denize sifir kamp"></head><body>Wi-Fi ve duş var. 25 € gece.</body></html>', 200, { 'content-type': 'text/html; charset=utf-8' });
  };
};
