'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');

const UA = 'TrailoPRO-harvester/3.0 (https://github.com/ziyaarslanturk/trailopro)';
const GEOFABRIK_INDEX_URL = 'https://download.geofabrik.de/index-v1-nogeom.json';
const MAX_SINGLE_PBF_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GB üstünde alt bölgelere böl

const OVERPASS_ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];

const KAYNAK_QL = [
  'nwr["tourism"="camp_site"]',
  'nwr["tourism"="caravan_site"]',
  'nwr["tourism"="wilderness_hut"]',
  'nwr["amenity"="shelter"]["shelter_type"~"^(basic_hut|lean_to)$"]["tents"="yes"]',
];

const POI_QL = [
  'nwr["amenity"="drinking_water"]',
  'nwr["amenity"="toilets"]',
  'nwr["amenity"="shower"]',
  'nwr["shop"~"^(supermarket|convenience|general|kiosk)$"]',
  'nwr["amenity"="fuel"]',
  'nwr["amenity"~"^(pharmacy|hospital|clinic|doctors)$"]',
  'nwr["place"~"^(city|town|village|suburb|hamlet|neighbourhood)$"]',
  'node["natural"="peak"]',
  'nwr["tourism"~"^(attraction|museum|viewpoint)$"]',
  'nwr["historic"~"^(castle|ruins|monument|archaeological_site)$"]',
  'nwr["natural"="beach"]',
  'nwr["leisure"="beach_resort"]',
  'nwr["tourism"~"^(hotel|hostel|motel|guest_house)$"]',
];

const OSMIUM_CAMP_FILTERS = [
  'nwr/tourism=camp_site,caravan_site,wilderness_hut',
  'nwr/amenity=shelter',
];

const OSMIUM_POI_FILTERS = [
  'nwr/amenity=drinking_water,toilets,shower,fuel,pharmacy,hospital,clinic,doctors',
  'nwr/shop=supermarket,convenience,general,kiosk',
  'nwr/place=city,town,village,suburb,hamlet,neighbourhood',
  'n/natural=peak',
  'nwr/tourism=attraction,museum,viewpoint,hotel,hostel,motel,guest_house',
  'nwr/historic=castle,ruins,monument,archaeological_site',
  'nwr/natural=beach',
  'nwr/leisure=beach_resort',
];

const POI_TAG_KEYS = [
  'name', 'natural', 'leisure', 'amenity', 'shop', 'place', 'tourism', 'historic',
];

const OSMFR_DIZINLER = [
  'europe', 'asia', 'africa', 'north-america', 'central-america', 'south-america', 'oceania',
];

const OSMFR_ALIAS = {
  AE: ['united_arab_emirates'],
  AG: ['antigua_and_barbuda'],
  BA: ['bosnia_herzegovina', 'bosnia_and_herzegovina'],
  BN: ['brunei'],
  BO: ['bolivia'],
  CD: ['congo_democratic_republic', 'democratic_republic_of_the_congo'],
  CG: ['congo_republic_brazzaville', 'republic_of_the_congo'],
  CI: ['ivory_coast', 'cote_d_ivoire'],
  CV: ['cape_verde'],
  CZ: ['czech_republic', 'czechia'],
  DO: ['dominican_republic'],
  FM: ['micronesia'],
  GB: ['united_kingdom', 'great_britain'],
  HK: ['hong_kong'],
  IR: ['iran'],
  KN: ['saint_kitts_and_nevis'],
  KP: ['north_korea'],
  KR: ['south_korea'],
  LA: ['laos'],
  LC: ['saint_lucia'],
  MD: ['moldova'],
  MK: ['north_macedonia', 'macedonia'],
  MM: ['myanmar', 'burma'],
  MO: ['macau', 'macao'],
  PS: ['palestine'],
  RU: ['russia'],
  ST: ['sao_tome_and_principe'],
  SY: ['syria'],
  SZ: ['eswatini', 'swaziland'],
  TL: ['east_timor', 'timor_leste'],
  TR: ['turkey', 'turkiye'],
  TT: ['trinidad_and_tobago'],
  TW: ['taiwan'],
  TZ: ['tanzania'],
  VA: ['vatican_city', 'vatican'],
  VC: ['saint_vincent_and_the_grenadines'],
  VE: ['venezuela'],
  VN: ['vietnam'],
  XK: ['kosovo'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const EN_BOLGE_AD = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; }
})();

let geofabrikCache = null;
let osmFrCache = null;
let osmiumVarCache = null;
let sonOverpassMs = 0;
let sonNominatimMs = 0;
const aynaSoguma = new Map();

function osmiumMevcutMu() {
  if (osmiumVarCache !== null) return osmiumVarCache;
  const r = spawnSync('osmium', ['--version'], { stdio: 'ignore' });
  osmiumVarCache = r.status === 0;
  return osmiumVarCache;
}

function slugYap(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function kaynakUygunMu(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.tourism === 'camp_site' || t.tourism === 'caravan_site' || t.tourism === 'wilderness_hut') {
    return true;
  }
  if (t.amenity === 'shelter' && /^(basic_hut|lean_to)$/.test(t.shelter_type || '') && t.tents === 'yes') {
    return true;
  }
  return false;
}

function poiUygunMu(t, osmType) {
  if (!t || typeof t !== 'object') return false;
  if (t.natural === 'peak') return osmType === 'node';
  if (t.natural === 'beach' || t.leisure === 'beach_resort') return true;
  if (/^(drinking_water|toilets|shower|fuel|pharmacy|hospital|clinic|doctors)$/.test(t.amenity || '')) return true;
  if (/^(supermarket|convenience|general|kiosk)$/.test(t.shop || '')) return true;
  if (/^(city|town|village|suburb|hamlet|neighbourhood)$/.test(t.place || '')) return true;
  if (/^(attraction|museum|viewpoint|hotel|hostel|motel|guest_house)$/.test(t.tourism || '')) return true;
  if (/^(castle|ruins|monument|archaeological_site)$/.test(t.historic || '')) return true;
  return false;
}

function poiEtiketKirp(t) {
  const out = {};
  for (const k of POI_TAG_KEYS) {
    if (t[k] !== undefined) out[k] = t[k];
  }
  return out;
}

function geometriMerkezi(geom) {
  if (!geom || !geom.coordinates) return null;
  if (geom.type === 'Point') {
    const [lon, lat] = geom.coordinates;
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }
  let sumLat = 0;
  let sumLon = 0;
  let n = 0;
  const gez = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return;
    if (typeof arr[0] === 'number' && typeof arr[1] === 'number') {
      sumLon += arr[0];
      sumLat += arr[1];
      n++;
      return;
    }
    for (const c of arr) gez(c);
  };
  if (geom.type === 'Polygon') gez(geom.coordinates[0]);
  else if (geom.type === 'MultiPolygon') gez(geom.coordinates[0] && geom.coordinates[0][0]);
  else gez(geom.coordinates);
  if (!n) return null;
  return {
    lat: Math.round((sumLat / n) * 1e6) / 1e6,
    lon: Math.round((sumLon / n) * 1e6) / 1e6,
  };
}

function ogeTekillestir(ogeler) {
  const map = new Map();
  for (const el of ogeler) {
    const k = `${el.type}/${el.id}`;
    if (!map.has(k)) map.set(k, el);
  }
  return Array.from(map.values());
}

/* ---------- Mekansal Izgara (0.15 derece ~ 16.7 km) ---------- */
const POI_KARO = 0.15;

function lonSpanHesapla(lat) {
  const cos = Math.max(Math.cos((lat * Math.PI) / 180), 0.08);
  return Math.min(14, Math.max(1, Math.ceil(12000 / (111320 * cos) / POI_KARO)));
}

function hedefHucreSetiOlustur(noktalar) {
  const set = new Set();
  for (const p of noktalar) {
    const lat = p.lat !== undefined ? p.lat : p.latitude;
    const lon = p.lon !== undefined ? p.lon : p.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const cy = Math.floor(lat / POI_KARO);
    const cx = Math.floor(lon / POI_KARO);
    const dxMax = lonSpanHesapla(lat);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -dxMax; dx <= dxMax; dx++) {
        set.add(`${cy + dy},${cx + dx}`);
      }
    }
  }
  return set;
}

function poiIzgarasiOlustur(poiler) {
  const izgara = new Map();
  for (const p of poiler) {
    const k = `${Math.floor(p.lat / POI_KARO)},${Math.floor(p.lon / POI_KARO)}`;
    let liste = izgara.get(k);
    if (!liste) {
      liste = [];
      izgara.set(k, liste);
    }
    liste.push(p);
  }
  return izgara;
}

function izgaradanYakinPoiler(izgara, lat, lon) {
  if (!izgara || !izgara.size) return [];
  const cy = Math.floor(lat / POI_KARO);
  const cx = Math.floor(lon / POI_KARO);
  const dxMax = lonSpanHesapla(lat);
  const sonuc = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -dxMax; dx <= dxMax; dx++) {
      const liste = izgara.get(`${cy + dy},${cx + dx}`);
      if (liste) {
        for (let i = 0; i < liste.length; i++) sonuc.push(liste[i]);
      }
    }
  }
  return sonuc;
}

/* ---------- Geofabrik & OSM.fr İndeksleri ---------- */
async function geofabrikIndeksAl() {
  if (geofabrikCache) return geofabrikCache;
  for (let d = 1; d <= 3; d++) {
    try {
      const res = await fetch(GEOFABRIK_INDEX_URL, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      geofabrikCache = json.features || [];
      return geofabrikCache;
    } catch (e) {
      const detay = e.cause?.code || e.cause?.message || e.message;
      log(`!! Geofabrik indeks (${d}/3): ${detay}`);
      await sleep(d * 3000);
    }
  }
  return [];
}

function geofabrikIso1Bul(features, iso1, sadeceTekUlke) {
  const kod = iso1.toUpperCase();
  const adaylar = features.filter((f) => {
    const arr = f.properties && f.properties['iso3166-1:alpha2'];
    if (!Array.isArray(arr) || !arr.includes(kod) || !(f.properties.urls && f.properties.urls.pbf)) return false;
    return sadeceTekUlke ? arr.length === 1 : arr.length > 1;
  });
  if (!adaylar.length) return null;
  adaylar.sort(
    (a, b) =>
      (a.properties['iso3166-1:alpha2'].length || 99) -
      (b.properties['iso3166-1:alpha2'].length || 99)
  );
  return adaylar[0];
}

function geofabrikIso2Bul(features, iso2) {
  const kod = iso2.toUpperCase();
  const adaylar = features.filter((f) => {
    const arr = f.properties && f.properties['iso3166-2'];
    return Array.isArray(arr) && arr.includes(kod) && f.properties.urls && f.properties.urls.pbf;
  });
  if (!adaylar.length) return null;
  adaylar.sort((a, b) => (a.properties['iso3166-2'].length || 99) - (b.properties['iso3166-2'].length || 99));
  return adaylar[0];
}

function altYaprakPbfBul(features, parentId, ziyaret = new Set()) {
  if (ziyaret.has(parentId)) return [];
  ziyaret.add(parentId);
  const cocuklar = features.filter(
    (f) => f.properties && f.properties.parent === parentId && f.properties.urls && f.properties.urls.pbf
  );
  if (!cocuklar.length) return [];
  const urls = [];
  for (const c of cocuklar) {
    const torunlar = altYaprakPbfBul(features, c.properties.id, ziyaret);
    if (torunlar.length) urls.push(...torunlar);
    else urls.push(c.properties.urls.pbf);
  }
  return urls;
}

async function osmFrIndeksAl() {
  if (osmFrCache) return osmFrCache;
  const map = new Map();
  for (const bolge of OSMFR_DIZINLER) {
    const base = `https://download.openstreetmap.fr/extracts/${bolge}/`;
    try {
      const res = await fetch(base, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const re = /href="([a-z0-9_-]+)-latest\.osm\.pbf"/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const slug = slugYap(m[1]);
        if (!map.has(slug)) map.set(slug, `${base}${m[1]}-latest.osm.pbf`);
      }
    } catch {
      // Bir kıta listesi düşerse diğerlerine devam et
    }
  }
  osmFrCache = map;
  return map;
}

async function osmFrUrlBul(iso1) {
  const indeks = await osmFrIndeksAl();
  if (!indeks.size) return null;
  const kod = iso1.toUpperCase();
  const adaySluglar = [...(OSMFR_ALIAS[kod] || [])];
  if (EN_BOLGE_AD) {
    try {
      const ad = EN_BOLGE_AD.of(kod);
      if (ad) {
        adaySluglar.push(slugYap(ad));
        adaySluglar.push(slugYap(ad).replace(/^the_/, ''));
        adaySluglar.push(slugYap(ad).replace(/_and_/g, '_'));
      }
    } catch {}
  }
  for (const s of adaySluglar) {
    if (s && indeks.has(s)) return indeks.get(s);
  }
  return null;
}

async function headBoyut(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, bytes: 0 };
    return { ok: true, bytes: Number(res.headers.get('content-length') || 0) };
  } catch {
    return { ok: false, bytes: 0 };
  }
}

/* ---------- Nominatim (Sınır GeoJSON & BBox) ---------- */
async function nominatimSorgula(params) {
  const gecen = Date.now() - sonNominatimMs;
  if (gecen < 1200) await sleep(1200 - gecen);
  sonNominatimMs = Date.now();
  const qs = new URLSearchParams(params).toString();
  const url = `https://nominatim.openstreetmap.org/search?${qs}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json();
}

async function ulkeSinirGeojsonAl(iso1) {
  const fc = await nominatimSorgula({
    countrycodes: iso1.toLowerCase(),
    format: 'geojson',
    polygon_geojson: '1',
    featuretype: 'country',
    limit: '3',
  });
  const features = fc && fc.features ? fc.features : [];
  const poly = features.find(
    (f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
  );
  return poly || null;
}

async function bboxAl(kod) {
  const params = kod.includes('-')
    ? { q: kod, format: 'json', limit: '1' }
    : { countrycodes: kod.toLowerCase(), format: 'json', limit: '1' };
  const arr = await nominatimSorgula(params);
  if (!arr || !arr[0] || !arr[0].boundingbox) throw new Error(`Nominatim bbox yok: ${kod}`);
  return arr[0].boundingbox.map(Number); // [s, n, w, e]
}

/* ---------- PBF İndirme ve Osmium İşleme ---------- */
function pbfIndirCurl(url, hedef) {
  if (fs.existsSync(hedef)) fs.unlinkSync(hedef);
  execFileSync(
    'curl',
    [
      '-fsSL',
      '--retry', '4',
      '--retry-delay', '5',
      '--retry-all-errors',
      '--connect-timeout', '30',
      '--max-time', '900',
      '-A', UA,
      '-o', hedef,
      url,
    ],
    { stdio: 'pipe' }
  );
}

async function geojsonSeqOku(dosya, isleyici) {
  if (!fs.existsSync(dosya) || fs.statSync(dosya).size === 0) return;
  const rl = readline.createInterface({
    input: fs.createReadStream(dosya, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const raw of rl) {
    const line = raw.replace(/^\u001e/, '').trim();
    if (!line) continue;
    try {
      const feat = JSON.parse(line);
      const props = feat.properties || {};
      const fid = String(feat.id || '');
      const osmType =
        props['@type'] ||
        (fid.startsWith('n') ? 'node' : fid.startsWith('w') ? 'way' : 'relation');
      const osmId = Number(props['@id']) || Number(fid.replace(/^[a-z]+/i, ''));
      const tags = { ...props };
      delete tags['@type'];
      delete tags['@id'];
      const merkez = geometriMerkezi(feat.geometry);
      if (!merkez || !Number.isFinite(osmId)) continue;
      isleyici({ type: osmType, id: osmId, lat: merkez.lat, lon: merkez.lon, tags });
    } catch {
      // Bozuk geometri satırı atlanır
    }
  }
}

async function pbfCozumle(pbfDosya, tmpDir, secenekler) {
  const { sinirFeature, kampCek, poiCek, mevcutNoktalar } = secenekler;
  const ogeler = [];
  const poiler = [];

  if (kampCek) {
    const kampHam = path.join(tmpDir, 'kamp-ham.osm.pbf');
    let kampHedef = kampHam;
    execFileSync(
      'osmium',
      ['tags-filter', '--overwrite', '-o', kampHam, pbfDosya, ...OSMIUM_CAMP_FILTERS],
      { stdio: 'pipe' }
    );

    if (sinirFeature) {
      const sinirYol = path.join(tmpDir, 'sinir.geojson');
      const kampKirpik = path.join(tmpDir, 'kamp-kirpik.osm.pbf');
      fs.writeFileSync(sinirYol, JSON.stringify(sinirFeature));
      execFileSync(
        'osmium',
        ['extract', '--overwrite', '-p', sinirYol, '-o', kampKirpik, kampHam],
        { stdio: 'pipe' }
      );
      kampHedef = kampKirpik;
    }

    const kampSeq = path.join(tmpDir, 'kamp.geojsonseq');
    execFileSync(
      'osmium',
      ['export', '--overwrite', '-f', 'geojsonseq', '-u', 'type_id', '-a', 'type,id', '-o', kampSeq, kampHedef],
      { stdio: 'pipe' }
    );

    await geojsonSeqOku(kampSeq, (el) => {
      if (kaynakUygunMu(el.tags)) ogeler.push(el);
    });
  }

  if (poiCek) {
    const referansNoktalar = [...(mevcutNoktalar || []), ...ogeler];
    if (referansNoktalar.length > 0) {
      const hedefHucreler = hedefHucreSetiOlustur(referansNoktalar);
      const poiPbf = path.join(tmpDir, 'poi.osm.pbf');
      const poiSeq = path.join(tmpDir, 'poi.geojsonseq');
      execFileSync(
        'osmium',
        ['tags-filter', '--overwrite', '-o', poiPbf, pbfDosya, ...OSMIUM_POI_FILTERS],
        { stdio: 'pipe' }
      );
      execFileSync(
        'osmium',
        ['export', '--overwrite', '-f', 'geojsonseq', '-u', 'type_id', '-a', 'type,id', '-o', poiSeq, poiPbf],
        { stdio: 'pipe' }
      );

      await geojsonSeqOku(poiSeq, (el) => {
        if (!poiUygunMu(el.tags, el.type)) return;
        const h = `${Math.floor(el.lat / POI_KARO)},${Math.floor(el.lon / POI_KARO)}`;
        if (!hedefHucreler.has(h)) return;
        poiler.push({
          lat: el.lat,
          lon: el.lon,
          tags: poiEtiketKirp(el.tags),
        });
      });
    }
  }

  return { ogeler, poiler };
}

async function pbfUrlListesiIsle(urls, etiket, secenekler) {
  const tumOgeler = [];
  const tumPoiler = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailo-pbf-'));
    const pbfPath = path.join(tmpDir, 'veri.osm.pbf');
    try {
      log(`  [${etiket} ${i + 1}/${urls.length}] indiriliyor: ${path.basename(url)}`);
      pbfIndirCurl(url, pbfPath);
      const { ogeler, poiler } = await pbfCozumle(pbfPath, tmpDir, secenekler);
      tumOgeler.push(...ogeler);
      tumPoiler.push(...poiler);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  return { ogeler: ogeTekillestir(tumOgeler), poiler: tumPoiler };
}

async function geofabrikKayitUrlListesi(features, kayit) {
  const anaUrl = kayit.properties.urls.pbf;
  const head = await headBoyut(anaUrl);
  if (head.bytes > MAX_SINGLE_PBF_BYTES) {
    const altlar = altYaprakPbfBul(features, kayit.properties.id);
    if (altlar.length) {
      log(`  [Geofabrik] ${kayit.properties.id} büyük (${(head.bytes / 1e9).toFixed(2)} GB) -> ${altlar.length} alt parça`);
      return altlar;
    }
  }
  return [anaUrl];
}

/* ---------- 5 Aynalı Overpass İstemcisi ---------- */
async function overpassSorgula(sorgu, ayar = {}, turSayisi = 2) {
  const bekleMs = ayar.bekle || 2500;
  let sonHata = 'Overpass yanıt vermedi';

  for (let tur = 0; tur < turSayisi; tur++) {
    for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
      const url = OVERPASS_ENDPOINTS[(tur + i) % OVERPASS_ENDPOINTS.length];
      const host = new URL(url).hostname;
      const sogumaBitis = aynaSoguma.get(url) || 0;
      if (Date.now() < sogumaBitis && tur === 0) continue;

      const gecen = Date.now() - sonOverpassMs;
      if (gecen < bekleMs) await sleep(bekleMs - gecen);
      sonOverpassMs = Date.now();

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          },
          body: 'data=' + encodeURIComponent(sorgu),
          signal: AbortSignal.timeout(120_000),
        });

        if (res.status === 429 || res.status >= 500) {
          aynaSoguma.set(url, Date.now() + (res.status === 429 ? 90_000 : 45_000));
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const j = await res.json();
        if (j.remark && /error|timed out|out of memory/i.test(j.remark) && (!j.elements || !j.elements.length)) {
          throw new Error('remark: ' + j.remark);
        }
        aynaSoguma.delete(url);
        return j.elements || [];
      } catch (e) {
        const detay = e.cause?.code || e.cause?.message || e.message;
        sonHata = `${host}: ${detay}`;
        log(`  [Overpass] ${sonHata} -> sonraki ayna`);
        await sleep(2500);
      }
    }
    await sleep((tur + 1) * 8000);
  }
  throw new Error(sonHata);
}

function alanSorgusuOlustur(filtre) {
  return `[out:json][timeout:110];${filtre}->.a;(${KAYNAK_QL.map((k) => `${k}(area.a);`).join('')});out center tags;`;
}

async function overpassAlanVeyaBbox(kod, iso2Mi, ayar) {
  const anaFiltre = iso2Mi
    ? `area["ISO3166-2"="${kod}"]["boundary"="administrative"]`
    : `area["ISO3166-1"="${kod}"]["boundary"="administrative"]`;

  // 4a: Resmi idari sınır alanı
  try {
    const ogeler = await overpassSorgula(alanSorgusuOlustur(anaFiltre), ayar, 2);
    if (ogeler.length > 0) return { ogeler, kaynak: 'overpass-area' };
  } catch (e) {
    log(`  [Overpass alan] ${kod}: ${e.message}`);
  }

  // 4b: boundary filtresi olmadan ISO3166 alanı (XK, TW, PS vb. için)
  try {
    const esnek = iso2Mi ? `area["ISO3166-2"="${kod}"]` : `area["ISO3166-1"="${kod}"]`;
    const ogeler = await overpassSorgula(alanSorgusuOlustur(esnek), ayar, 1);
    return { ogeler, kaynak: 'overpass-iso' };
  } catch (e) {
    log(`  [Overpass esnek] ${kod}: ${e.message}`);
  }

  // 4c: Ülke için admin_level=4 alt bölgelere böl
  if (!iso2Mi) {
    try {
      const alt = await overpassSorgula(
        `[out:json][timeout:90];${anaFiltre}->.c;rel(area.c)["boundary"="administrative"]["admin_level"="4"]["ISO3166-2"];out tags;`,
        ayar,
        1
      );
      const kodlar = alt.map((x) => x.tags && x.tags['ISO3166-2']).filter(Boolean);
      if (kodlar.length > 0) {
        let tum = [];
        for (const k of kodlar) {
          tum = tum.concat(
            await overpassSorgula(alanSorgusuOlustur(`area["ISO3166-2"="${k}"]["boundary"="administrative"]`), ayar, 2)
          );
        }
        return { ogeler: ogeTekillestir(tum), kaynak: 'overpass-subarea' };
      }
    } catch (e) {
      log(`  [Overpass alt-bölge] ${kod}: ${e.message}`);
    }
  }

  // 5: Son çare — Nominatim BBox 2x2 bölme
  const [s, n, w, e] = await bboxAl(kod);
  const kucukMu = Math.abs(n - s) < 1.5 && Math.abs(e - w) < 1.5;
  const kutular = kucukMu
    ? [[s, w, n, e]]
    : [
        [s, w, (s + n) / 2, (w + e) / 2],
        [s, (w + e) / 2, (s + n) / 2, e],
        [(s + n) / 2, w, n, (w + e) / 2],
        [(s + n) / 2, (w + e) / 2, n, e],
      ];

  const tum = [];
  for (let i = 0; i < kutular.length; i++) {
    const [bS, bW, bN, bE] = kutular[i];
    const bbox = `(${bS.toFixed(4)},${bW.toFixed(4)},${bN.toFixed(4)},${bE.toFixed(4)})`;
    const sorgu = `[out:json][timeout:110];(${KAYNAK_QL.map((q) => `${q}${bbox};`).join('')});out center tags;`;
    log(`  [Overpass BBox ${i + 1}/${kutular.length}] ${kod}`);
    tum.push(...(await overpassSorgula(sorgu, ayar, 2)));
  }
  return { ogeler: ogeTekillestir(tum), kaynak: 'overpass-bbox' };
}

/* ---------- Tek Ülke veya Tek ABD Eyaleti Çekimi ---------- */
async function tekBolgeCek(kod, iso2Mi, ayar, secenekler) {
  const osmiumVar = osmiumMevcutMu();
  const features = osmiumVar ? await geofabrikIndeksAl() : [];

  // KATMAN 1: Geofabrik tam eşleşen tek ülke / ABD eyalet PBF
  if (osmiumVar && features.length) {
    const kayit = iso2Mi
      ? geofabrikIso2Bul(features, kod)
      : geofabrikIso1Bul(features, kod, true);
    if (kayit) {
      try {
        const urls = await geofabrikKayitUrlListesi(features, kayit);
        const res = await pbfUrlListesiIsle(urls, `Geofabrik:${kod}`, secenekler);
        return { ...res, kaynak: 'geofabrik-pbf', yerelPoiHazir: secenekler.poiCek };
      } catch (e) {
        log(`  !! [Geofabrik] ${kod} hata: ${e.message}`);
      }
    }
  }

  // KATMAN 2: OpenStreetMap.fr tek ülke PBF
  if (osmiumVar && !iso2Mi) {
    try {
      const osmFrUrl = await osmFrUrlBul(kod);
      if (osmFrUrl) {
        const head = await headBoyut(osmFrUrl);
        if (head.ok && head.bytes <= MAX_SINGLE_PBF_BYTES) {
          const res = await pbfUrlListesiIsle([osmFrUrl], `OSM.fr:${kod}`, secenekler);
          return { ...res, kaynak: 'osm-fr-pbf', yerelPoiHazir: secenekler.poiCek };
        }
      }
    } catch (e) {
      log(`  !! [OSM.fr] ${kod} hata: ${e.message}`);
    }
  }

  // KATMAN 3: Geofabrik çoklu ülke PBF + Nominatim GeoJSON sınır kırpma
  if (osmiumVar && !iso2Mi && features.length) {
    const bolgeKayit = geofabrikIso1Bul(features, kod, false);
    if (bolgeKayit) {
      try {
        const head = await headBoyut(bolgeKayit.properties.urls.pbf);
        if (head.ok && head.bytes <= MAX_SINGLE_PBF_BYTES) {
          const sinirFeature = await ulkeSinirGeojsonAl(kod);
          if (sinirFeature) {
            const res = await pbfUrlListesiIsle(
              [bolgeKayit.properties.urls.pbf],
              `Geofabrik-Kırp:${kod}`,
              { ...secenekler, sinirFeature }
            );
            return { ...res, kaynak: 'geofabrik-clipped-pbf', yerelPoiHazir: secenekler.poiCek };
          }
        }
      } catch (e) {
        log(`  !! [Geofabrik-Kırp] ${kod} hata: ${e.message}`);
      }
    }
  }

  // KATMAN 4 & 5: Sadece POI gerekiyorsa PBF yoktur, null dön ki Overpass karo yedeğine geçsin
  if (!secenekler.kampCek) {
    return { ogeler: [], poiler: [], kaynak: 'yok', yerelPoiHazir: false };
  }

  const ov = await overpassAlanVeyaBbox(kod, iso2Mi, ayar);
  return { ogeler: ov.ogeler, poiler: [], kaynak: ov.kaynak, yerelPoiHazir: false };
}

/**
 * Bir birim ({ dosya, kod, iso1?, iso2[]? }) için tüm kaynakları dener.
 * PBF kullanıldığında hem kampları hem yakın çevre POI'lerini 0 Overpass isteğiyle döndürür.
 */
async function birimVerisiCek(birim, ayar, mevcutKayitlar = []) {
  const poiCek = Boolean(ayar.yakinCevre);
  const secenekler = { kampCek: true, poiCek, mevcutNoktalar: mevcutKayitlar };

  if (birim.iso2) {
    const tumOgeler = [];
    const tumPoiler = [];
    const kaynaklar = new Set();
    let hepsiYerelPoi = poiCek;

    for (const st of birim.iso2) {
      const r = await tekBolgeCek(st, true, ayar, secenekler);
      tumOgeler.push(...r.ogeler);
      tumPoiler.push(...r.poiler);
      kaynaklar.add(r.kaynak);
      if (!r.yerelPoiHazir) hepsiYerelPoi = false;
    }

    const benzersiz = ogeTekillestir(tumOgeler);
    return {
      ogeler: benzersiz,
      poiIzgarasi: hepsiYerelPoi ? poiIzgarasiOlustur(tumPoiler) : null,
      kaynak: Array.from(kaynaklar).join('+'),
    };
  }

  const r = await tekBolgeCek(birim.iso1, false, ayar, secenekler);
  return {
    ogeler: r.ogeler,
    poiIzgarasi: r.yerelPoiHazir ? poiIzgarasiOlustur(r.poiler) : null,
    kaynak: r.kaynak,
  };
}

/**
 * Yarım kalmış zenginleştirme devam ederken PBF mevcutsa POI'leri yine Overpass'siz çeker.
 */
async function birimYerelPoiCek(birim, ayar, kayitlar) {
  if (!osmiumMevcutMu() || !kayitlar.length) return null;
  const secenekler = { kampCek: false, poiCek: true, mevcutNoktalar: kayitlar };

  if (birim.iso2) {
    const tumPoiler = [];
    for (const st of birim.iso2) {
      const r = await tekBolgeCek(st, true, ayar, secenekler);
      if (!r.yerelPoiHazir) return null;
      tumPoiler.push(...r.poiler);
    }
    return poiIzgarasiOlustur(tumPoiler);
  }

  const r = await tekBolgeCek(birim.iso1, false, ayar, secenekler);
  return r.yerelPoiHazir ? poiIzgarasiOlustur(r.poiler) : null;
}

module.exports = {
  birimVerisiCek,
  birimYerelPoiCek,
  overpassSorgula,
  izgaradanYakinPoiler,
  POI_QL,
};
