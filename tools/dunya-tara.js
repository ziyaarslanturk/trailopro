#!/usr/bin/env node
'use strict';
/*
 * Trailo PRO - Dünya kamp alanı tarama + zenginleştirme aracı
 *
 * - OpenStreetMap (Overpass) ile ülke ülke kamp alanlarını çeker
 * - data/XX.json ile AYNI formatta yazar (US için US_WEST, US_SOUTH ... bölge dosyaları)
 * - Birbirine ESIK metre içindeki noktalardan bilgisi az olanı atar (mevcut dosya ile de birleştirir)
 * - Zenginleştirme: OSM etiketleri + yakın çevre (Overpass karo sorgusu) + irtifa (Open-Meteo)
 * - Yeniden başlatılabilir: durum tools/durum.json ve kayıtların notes.note işaretinde tutulur
 *
 * Kullanım:
 *   node tools/dunya-tara.js --mod pilot            (LU, pilot/ klasörüne, kategori onayı gerekmez)
 *   node tools/dunya-tara.js --mod tam --commit     (tüm dünya, data/ klasörüne, kategori onayı gerekir)
 *   Seçenekler: --ulkeler AT,DE  --esik 110  --sure 330 (dakika)  --yenile-gun 30  --yakin-cevre 1|0
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const KOK = path.resolve(__dirname, '..');
const UA = 'TrailoPRO-harvester/2.0 (https://github.com/ziyaarslanturk/trailopro)';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const ILKELER = ['AD','AE','AF','AG','AI','AL','AM','AO','AR','AS','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ','TC','TD','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VG','VI','VN','VU','WF','WS','YE','YT','ZA','ZM','ZW'];
// ABD: mevcut dosya düzenine göre bölgeler (US_PACIFIC = AK + HI)
const US_BOLGE = {
  US_NORTHEAST: ['ME','NH','VT','MA','RI','CT','NY','NJ','PA'],
  US_MIDWEST: ['OH','IN','IL','MI','WI','MN','IA','MO','ND','SD','NE','KS'],
  US_SOUTH: ['DE','MD','DC','VA','WV','NC','SC','GA','FL','KY','TN','AL','MS','AR','LA','OK','TX'],
  US_WEST: ['MT','ID','WY','NV','UT','CO','AZ','NM','WA','OR','CA'],
  US_PACIFIC: ['AK','HI'],
};
const DIL = ['tr', 'en', 'de', 'ru', 'ar'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------- Ayarlar ---------- */
function argumanlar(argv) {
  const o = { mod: 'pilot', ulkeler: null, esik: 110, sure: 330, yenileGun: 30, yakinCevre: 1, commit: false, kok: KOK, bekle: 2500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--mod') o.mod = v();
    else if (a === '--ulkeler') o.ulkeler = v().split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--esik') o.esik = Number(v());
    else if (a === '--sure') o.sure = Number(v());
    else if (a === '--yenile-gun') o.yenileGun = Number(v());
    else if (a === '--yakin-cevre') o.yakinCevre = Number(v());
    else if (a === '--commit') o.commit = true;
    else if (a === '--kok') o.kok = path.resolve(v());
    else if (a === '--bekle') o.bekle = Number(v());
  }
  return o;
}

/* ---------- Genel yardımcılar ---------- */
function mesafe(a1, o1, a2, o2) {
  const R = 6371008.8, rad = Math.PI / 180;
  const p1 = a1 * rad, p2 = a2 * rad, dp = p2 - p1, dl = (o2 - o1) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function mesafeYaz(m) {
  if (m < 1000) return Math.round(m) + ' m';
  return (m / 1000).toFixed(1).replace('.', ',') + ' km';
}
const bos = (v) => v === undefined || v === null || String(v).trim() === '';
const temiz = (v) => (bos(v) ? null : String(v).trim());

/* ---------- Kategori kuralları ---------- */
function kategoriYukle(kok) {
  const p = path.join(kok, 'tools', 'kategoriler.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function kategoriHesapla(etiket, kat) {
  const ids = [];
  for (const [id, k] of Object.entries(kat.kategoriler)) {
    const eslesti = (k.kural || []).some(([key, val]) => {
      const t = etiket[key];
      if (t === undefined) return false;
      if (val === '*') return true;
      return String(t).split(';').map((s) => s.trim()).includes(val);
    });
    if (eslesti) ids.push(Number(id));
  }
  return ids.sort((a, b) => a - b);
}

/* ---------- OSM kaydı -> proje kaydı ---------- */
function kayitOlustur(el, ulkeKodu, kat) {
  const t = el.tags || {};
  const lat = el.lat !== undefined ? el.lat : el.center && el.center.lat;
  const lon = el.lon !== undefined ? el.lon : el.center && el.center.lon;
  if (lat === undefined || lon === undefined) return null;
  let id;
  if (el.type === 'node') id = 'n' + el.id;
  else if (el.type === 'way') id = 'a' + el.id;
  else id = 'a' + (3600000000 + el.id);
  const ad = {};
  for (const d of DIL) ad[d] = temiz(t['name:' + d]);
  const yerel = temiz(t.name) || temiz(t['name:en']) || null;
  const website = temiz(t.website || t['contact:website'] || t.url);
  const phone = temiz(t.phone || t['contact:phone'] || t.mobile || t['contact:mobile']);
  return {
    id,
    country_code: ulkeKodu,
    latitude: Math.round(lat * 1e6) / 1e6,
    longitude: Math.round(lon * 1e6) / 1e6,
    name: ad,
    name_local: yerel,
    fee: temiz(t.fee),
    website,
    phone,
    notes: { description: etiketMetni(t), note: null },
    category_ids: kategoriHesapla(t, kat),
    _tags: t, // geçici: zenginleştirme için, yazarken silinir
  };
}

const EVET = (v) => v === 'yes' || v === 'designated';
function etiketMetni(t) {
  const ol = [];
  const ekle = (kosul, metin) => { if (kosul) ol.push(metin); };
  ekle(EVET(t.toilets) || t.toilets === 'yes', 'tuvalet');
  ekle(EVET(t.shower), 'duş');
  ekle(EVET(t.drinking_water), 'içme suyu');
  ekle(EVET(t.power_supply) || EVET(t.electricity), 'elektrik');
  ekle(EVET(t.internet_access) || t.internet_access === 'wlan' || t.internet_access === 'wifi', 'wifi');
  ekle(EVET(t.sanitary_dump_station), 'karavan atık boşaltma');
  ekle(EVET(t.washing_machine) || EVET(t.laundry), 'çamaşırhane');
  ekle(EVET(t.openfire), 'ateş yakmaya izinli');
  ekle(t.openfire === 'no', 'ateş yakmak yasak');
  ekle(EVET(t.bbq) || EVET(t.picnic_table), 'mangal/piknik alanı');
  ekle(EVET(t.swimming_pool), 'havuz');
  ekle(EVET(t.sauna), 'sauna');
  ekle(EVET(t.shop) || t.shop, 'market');
  ekle(EVET(t.restaurant) || EVET(t.bar), 'restoran/bar');
  ekle(EVET(t.playground), 'çocuk parkı');
  ekle(t.dog === 'yes', 'köpek kabul edilir');
  ekle(t.dog === 'no', 'köpek kabul edilmez');
  ekle(t.tents === 'yes', 'çadır kabul edilir');
  ekle(t.tents === 'no', 'çadır kabul edilmez');
  ekle(t.caravans === 'yes', 'karavan kabul edilir');
  ekle(t.motorhome === 'yes', 'motokaravan kabul edilir');
  ekle(t.backcountry === 'yes', 'yürüyüşle ulaşılan ilkel kamp (backcountry)');
  ekle(EVET(t.wheelchair), 'tekerlekli sandalye erişimi');
  ekle(t.nudism && t.nudism !== 'no', 'naturist alan');
  const satir = [];
  if (t.capacity) satir.push('Kapasite: ' + t.capacity + '.');
  if (t.opening_hours) satir.push('Çalışma saatleri: ' + t.opening_hours + '.');
  if (t.reservation) satir.push('Rezervasyon: ' + ({ required: 'zorunlu', recommended: 'önerilir', yes: 'var', no: 'yok' }[t.reservation] || t.reservation) + '.');
  if (t.operator) satir.push('İşletmeci: ' + t.operator + '.');
  if (t['addr:street']) satir.push('Adres: ' + [t['addr:street'], t['addr:housenumber'], t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ') + '.');
  const bolum = [];
  if (ol.length) bolum.push('OLANAKLAR: ' + ol.join(', ') + '.');
  const ucret = ucretMetni(t);
  if (ucret) bolum.push('ÜCRET: ' + ucret);
  if (satir.length) bolum.push(satir.join(' '));
  return bolum.length ? bolum.join('\n') : null;
}
function ucretMetni(t) {
  const f = t.fee;
  if (!f && !t.charge) return null;
  const parca = [];
  if (f === 'yes') parca.push('ücretli');
  else if (f === 'no') parca.push('ücretsiz');
  else if (f === 'donation') parca.push('bağışa dayalı');
  else if (f) parca.push(String(f));
  if (t.charge) parca.push(String(t.charge));
  return parca.join(', ') + '.';
}

/* ---------- Bilgi puanı + 100 m tekilleştirme ---------- */
function puan(r) {
  let s = 0;
  const adlar = Object.values(r.name || {}).filter(Boolean);
  if (adlar.length || r.name_local) s += 100;
  s += 5 * new Set(adlar).size;
  if (r.fee) s += 10;
  if (r.website) s += 20;
  if (r.phone) s += 20;
  const n = r.notes || {};
  s += Math.min((n.description || '').length, 3000) / 10;
  if (n.note) s += 2;
  s += (r.category_ids || []).length * 3;
  return s;
}
function tekillestir(kayitlar, esik) {
  // sıra: en bilgili önce; eşitlikte mevcut (_eski) kayıt, sonra id
  const sirali = kayitlar.map((r) => ({ r, p: puan(r) })).sort((a, b) => b.p - a.p || (b.r._eski ? 1 : 0) - (a.r._eski ? 1 : 0) || (a.r.id < b.r.id ? -1 : 1));
  const HUCRE = 0.004; // ~444 m
  const izgara = new Map();
  const kalan = [];
  for (const { r } of sirali) {
    const cy = Math.floor(r.latitude / HUCRE);
    const cx = Math.floor((r.longitude * Math.max(Math.cos((r.latitude * Math.PI) / 180), 0.05)) / HUCRE);
    const span = 3;
    let tekrar = false;
    for (let dy = -1; dy <= 1 && !tekrar; dy++) {
      for (let dx = -span; dx <= span && !tekrar; dx++) {
        const liste = izgara.get(cy + dy + ',' + (cx + dx));
        if (!liste) continue;
        for (const k of liste) if (mesafe(r.latitude, r.longitude, k.latitude, k.longitude) <= esik) { tekrar = true; break; }
      }
    }
    if (tekrar) continue;
    const anahtar = cy + ',' + cx;
    if (!izgara.has(anahtar)) izgara.set(anahtar, []);
    izgara.get(anahtar).push(r);
    kalan.push(r);
  }
  return { kalan, silinen: kayitlar.length - kalan.length };
}

/* ---------- Ağ: Overpass ve Open-Meteo ---------- */
let sonIstek = 0;
async function overpass(sorgu, ayar, deneme = 6) {
  for (let i = 0; i < deneme; i++) {
    const gecen = Date.now() - sonIstek;
    if (gecen < ayar.bekle) await sleep(ayar.bekle - gecen);
    const url = OVERPASS[i % OVERPASS.length];
    sonIstek = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(sorgu),
      });
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (j.remark && /error|timed out|out of memory/i.test(j.remark) && (!j.elements || !j.elements.length)) throw new Error('remark: ' + j.remark);
      return j.elements || [];
    } catch (e) {
      const bekleme = Math.min(120000, 5000 * 2 ** i);
      log('Overpass hata:', e.message, '- bekleniyor', Math.round(bekleme / 1000), 'sn');
      await sleep(bekleme);
    }
  }
  throw new Error('Overpass sorgusu başarısız');
}

const KAYNAK = [
  'nwr["tourism"="camp_site"]',
  'nwr["tourism"="caravan_site"]',
  'nwr["tourism"="wilderness_hut"]',
  'nwr["amenity"="shelter"]["shelter_type"~"^(basic_hut|lean_to)$"]["tents"="yes"]',
];
function alanSorgusu(filtre) {
  return '[out:json][timeout:900][maxsize:2147483648];' + filtre + '->.a;(' + KAYNAK.map((k) => k + '(area.a);').join('') + ');out center tags;';
}
const bolgeFiltre = (iso) => 'area["ISO3166-1"="' + iso + '"]["boundary"="administrative"]';
const altFiltre = (iso2) => 'area["ISO3166-2"="' + iso2 + '"]["boundary"="administrative"]';

async function ulkeCek(birim, ayar) {
  // birim: {dosya, iso1?, iso2[]?}
  let ogeler = [];
  if (birim.iso2) {
    for (const k of birim.iso2) ogeler = ogeler.concat(await overpass(alanSorgusu(altFiltre(k)), ayar));
    return ogeler;
  }
  try {
    return await overpass(alanSorgusu(bolgeFiltre(birim.iso1)), ayar, 3);
  } catch (e) {
    log(birim.dosya, 'tek parça sorgu olmadı, alt bölgelere ayrılıyor');
    const alt = await overpass('[out:json][timeout:300];' + bolgeFiltre(birim.iso1) + '->.c;rel(area.c)["boundary"="administrative"]["admin_level"="4"]["ISO3166-2"];out tags;', ayar);
    const kodlar = alt.map((x) => x.tags['ISO3166-2']).filter(Boolean);
    if (!kodlar.length) throw e;
    for (const k of kodlar) ogeler = ogeler.concat(await overpass(alanSorgusu(altFiltre(k)), ayar));
    return ogeler;
  }
}

async function irtifaAl(noktalar) {
  // noktalar: [{latitude, longitude}] -> [m|null]
  const sonuc = [];
  for (let i = 0; i < noktalar.length; i += 100) {
    const dilim = noktalar.slice(i, i + 100);
    const url = 'https://api.open-meteo.com/v1/elevation?latitude=' + dilim.map((p) => p.latitude).join(',') + '&longitude=' + dilim.map((p) => p.longitude).join(',');
    let deger = null;
    for (let d = 0; d < 4 && !deger; d++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        deger = j.elevation;
      } catch (e) { await sleep(3000 * (d + 1)); }
    }
    for (let k = 0; k < dilim.length; k++) sonuc.push(deger && deger[k] !== undefined && deger[k] !== null ? Math.round(deger[k]) : null);
    await sleep(400);
  }
  return sonuc;
}

/* ---------- Yakın çevre ---------- */
const POI_SORGU = [
  'nwr["amenity"="drinking_water"]', 'nwr["amenity"="toilets"]', 'nwr["amenity"="shower"]',
  'nwr["shop"~"^(supermarket|convenience|general|kiosk)$"]', 'nwr["amenity"="fuel"]',
  'nwr["amenity"~"^(pharmacy|hospital|clinic|doctors)$"]',
  'nwr["place"~"^(city|town|village|suburb|hamlet|neighbourhood)$"]', 'node["natural"="peak"]',
  'nwr["tourism"~"^(attraction|museum|viewpoint)$"]', 'nwr["historic"~"^(castle|ruins|monument|archaeological_site)$"]',
  'nwr["natural"="beach"]', 'nwr["leisure"="beach_resort"]',
  'nwr["tourism"~"^(hotel|hostel|motel|guest_house)$"]',
];
const GRUPLAR = [
  { baslik: 'Su/plaj', test: (t) => t.natural === 'beach' || t.leisure === 'beach_resort', adet: 1, azami: 10000, etiket: null },
  { baslik: 'İçme suyu', test: (t) => t.amenity === 'drinking_water', adet: 2, azami: 5000, etiket: 'drinking_water' },
  { baslik: 'Tuvalet/duş noktası', test: (t) => t.amenity === 'toilets' || t.amenity === 'shower', adet: 1, azami: 3000, etiket: (t) => (t.amenity === 'shower' ? 'Public Shower' : 'Public Toilet') },
  { baslik: 'Market', test: (t) => /^(supermarket|convenience|general|kiosk)$/.test(t.shop || ''), adet: 2, azami: 10000, etiket: (t) => t.shop },
  { baslik: 'Akaryakıt', test: (t) => t.amenity === 'fuel', adet: 1, azami: 10000, etiket: 'fuel' },
  { baslik: 'Sağlık', test: (t) => /^(pharmacy|hospital|clinic|doctors)$/.test(t.amenity || ''), adet: 1, azami: 10000, etiket: (t) => t.amenity },
  { baslik: 'Yerleşim', test: (t) => !!t.place, adet: 2, azami: 10000, etiket: (t) => t.place },
  { baslik: 'Zirve', test: (t) => t.natural === 'peak', adet: 2, azami: 10000, etiket: 'peak' },
  { baslik: 'Görülecek', test: (t) => /^(attraction|museum|viewpoint)$/.test(t.tourism || '') || !!t.historic, adet: 3, azami: 10000, etiket: (t) => t.tourism || t.historic },
  { baslik: 'Yakın tesis', test: (t) => /^(hotel|hostel|motel|guest_house)$/.test(t.tourism || ''), adet: 1, azami: 5000, etiket: (t) => t.tourism },
];
function yakinCevreMetni(r, poiler) {
  const parcalar = [];
  for (const g of GRUPLAR) {
    const adaylar = [];
    for (const p of poiler) {
      if (!g.test(p.tags)) continue;
      if (p.tags === r._tags) continue;
      const d = mesafe(r.latitude, r.longitude, p.lat, p.lon);
      if (d <= g.azami) adaylar.push({ d, ad: p.tags.name || (typeof g.etiket === 'function' ? g.etiket(p.tags) : g.etiket) || '?' });
    }
    adaylar.sort((a, b) => a.d - b.d);
    const sec = adaylar.slice(0, g.adet);
    if (sec.length) parcalar.push(g.baslik + ': ' + sec.map((s) => s.ad + ' (' + mesafeYaz(s.d) + ')').join(', ') + '.');
  }
  return parcalar.length ? 'YAKIN ÇEVRE: ' + parcalar.join(' ') : null;
}
function poiNoktalari(elemanlar) {
  const out = [];
  for (const e of elemanlar) {
    const lat = e.lat !== undefined ? e.lat : e.center && e.center.lat;
    const lon = e.lon !== undefined ? e.lon : e.center && e.center.lon;
    if (lat === undefined || e.tags === undefined) continue;
    out.push({ lat, lon, tags: e.tags });
  }
  return out;
}

const ULKE_AD = (() => { try { return new Intl.DisplayNames(['tr'], { type: 'region' }); } catch (e) { return null; } })();
function konumMetni(r, irtifa) {
  const t = r._tags || {};
  const parca = [t['addr:suburb'] || t['addr:neighbourhood'], t['addr:city'] || t['addr:town'] || t['addr:village'] || t['addr:municipality'], t['addr:state'] || t['addr:province']].filter(Boolean);
  const kod = r.country_code.startsWith('US_') ? 'US' : r.country_code;
  let ulke = null;
  try { ulke = ULKE_AD ? ULKE_AD.of(kod) : null; } catch (e) { /* yoksay */ }
  if (ulke) parca.push(ulke);
  let m = 'KONUM: ' + (parca.length ? parca.join(', ') + '.' : 'Koordinat ' + r.latitude + ', ' + r.longitude + '.');
  if (irtifa !== null && irtifa !== undefined) m += ' İrtifa: ' + irtifa + ' m.';
  return m;
}

async function zenginlestir(kayitlar, ayar, saatDolduMu, kaydet) {
  const hedef = kayitlar.filter((r) => !(r.notes && r.notes.note && /^(Otomatik|Temel) derleme/.test(r.notes.note)));
  if (!hedef.length) return true;
  const KARO = 0.2, MARJ = 0.1;
  const karolar = new Map();
  for (const r of hedef) {
    const k = Math.floor(r.latitude / KARO) + ',' + Math.floor(r.longitude / KARO);
    if (!karolar.has(k)) karolar.set(k, []);
    karolar.get(k).push(r);
  }
  log('zenginleştirilecek', hedef.length, 'kayıt,', karolar.size, 'karo');
  let islenen = 0, say = 0;
  const bugun = new Date().toISOString().slice(0, 10);
  for (const [k, liste] of karolar) {
    if (saatDolduMu()) return false;
    const [cy, cx] = k.split(',').map(Number);
    const s = (cy * KARO - MARJ).toFixed(4), w = (cx * KARO - MARJ).toFixed(4), n = ((cy + 1) * KARO + MARJ).toFixed(4), e = ((cx + 1) * KARO + MARJ).toFixed(4);
    let poiler = [];
    if (ayar.yakinCevre) {
      const bbox = '(' + s + ',' + w + ',' + n + ',' + e + ')';
      const sorgu = '[out:json][timeout:300];(' + POI_SORGU.map((q) => q + bbox + ';').join('') + ');out center tags;';
      poiler = poiNoktalari(await overpass(sorgu, ayar));
    }
    const irt = await irtifaAl(liste);
    liste.forEach((r, i) => {
      const parcalar = [konumMetni(r, irt[i])];
      const yc = ayar.yakinCevre ? yakinCevreMetni(r, poiler) : null;
      if (yc) parcalar.push(yc);
      if (r.notes.description) parcalar.push(r.notes.description);
      r.notes.description = parcalar.join('\n');
      r.notes.note = 'Temel derleme (' + bugun + '): OSM, Open-Meteo. Doğrulanmalı.';
    });
    islenen += liste.length;
    if (++say % 25 === 0) { kaydet(); log('ara kayıt:', islenen, '/', hedef.length); }
  }
  return true;
}

/* ---------- Dosya işlemleri ---------- */
function dosyaOku(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return []; } }
function temizYaz(kayitlar) {
  return JSON.stringify(kayitlar.map((r) => {
    const { _tags, _eski, ...gerisi } = r; // eslint-disable-line no-unused-vars
    return gerisi;
  }), null, 0);
}
function manifestGuncelle(klasor, kod, kayitSayisi, metin) {
  const p = path.join(klasor, 'manifest.json');
  let m = { countries: {} };
  try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { /* yeni */ }
  if (!m.countries) m.countries = {};
  const b = Buffer.from(metin, 'utf8');
  m.countries[kod] = {
    count: kayitSayisi,
    sha256: crypto.createHash('sha256').update(b).digest('hex'),
    size: b.length,
    updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  const sirali = {};
  Object.keys(m.countries).sort().forEach((k) => { sirali[k] = m.countries[k]; });
  m.countries = sirali;
  fs.writeFileSync(p, JSON.stringify(m, null, 1));
}
function gitKaydet(kok, mesaj) {
  const calis = (c) => execSync(c, { cwd: kok, stdio: 'pipe' }).toString();
  try {
    calis('git add data tools/durum.json');
    try { calis('git diff --cached --quiet'); return; } catch (e) { /* değişiklik var */ }
    calis('git -c user.name="trailopro-bot" -c user.email="bot@users.noreply.github.com" commit -m "' + mesaj.replace(/"/g, '') + '"');
    for (let i = 0; i < 4; i++) {
      try { calis('git pull --rebase -X theirs -q'); calis('git push -q'); return; } catch (e) { log('push yeniden deneniyor'); }
    }
  } catch (e) { log('git hatası:', e.message); }
}

function birimler(ayar) {
  const liste = [];
  for (const kod of ILKELER) {
    if (kod === 'US') { for (const b of Object.keys(US_BOLGE)) liste.push({ dosya: b, kod: b, iso2: US_BOLGE[b].map((s) => 'US-' + s) }); }
    else liste.push({ dosya: kod, kod, iso1: kod });
  }
  if (!ayar.ulkeler) return liste;
  return liste.filter((b) => ayar.ulkeler.includes(b.kod) || (b.kod.startsWith('US_') && ayar.ulkeler.includes('US')));
}

/* ---------- Ana akış ---------- */
async function calistir(ayar) {
  const kat = kategoriYukle(ayar.kok);
  const pilot = ayar.mod === 'pilot';
  if (!pilot && !kat.onayli) {
    log('Kategori tablosu henüz onaylanmadı (tools/kategoriler.json -> "onayli": true). Tam tarama başlatılmadı. Önce --mod pilot çalıştırın.');
    return;
  }
  if (pilot && !ayar.ulkeler) ayar.ulkeler = ['LU'];
  const veriKlasoru = path.join(ayar.kok, pilot ? 'pilot' : 'data');
  fs.mkdirSync(veriKlasoru, { recursive: true });
  const durumYol = path.join(ayar.kok, 'tools', pilot ? 'durum-pilot.json' : 'durum.json');
  const durum = fs.existsSync(durumYol) ? JSON.parse(fs.readFileSync(durumYol, 'utf8')) : {};
  const bitis = Date.now() + ayar.sure * 60000;
  const saatDolduMu = () => Date.now() > bitis;
  const yenileMs = ayar.yenileGun * 86400000;

  // sıra: durumu olmayan veya en eski taranan önce
  const sirali = birimler(ayar).sort((a, b) => (Date.parse((durum[a.kod] || {}).harita || 0) || 0) - (Date.parse((durum[b.kod] || {}).harita || 0) || 0));

  for (const b of sirali) {
    if (saatDolduMu()) { log('Süre doldu, çıkılıyor. Sonraki çalıştırma kaldığı yerden devam eder.'); break; }
    const d = durum[b.kod] || {};
    const yeniMi = d.tamam && Date.now() - Date.parse(d.tamam) < yenileMs;
    if (yeniMi) continue;
    const dosyaYol = path.join(veriKlasoru, b.dosya + '.json');
    const harita = d.harita && Date.now() - Date.parse(d.harita) < yenileMs;
    let kayitlar = dosyaOku(dosyaYol);
    kayitlar.forEach((r) => { r._eski = true; });
    const kaydet = () => {
      const metin = temizYaz(kayitlar);
      fs.writeFileSync(dosyaYol, metin);
      manifestGuncelle(veriKlasoru, b.dosya, kayitlar.length, metin);
      fs.writeFileSync(durumYol, JSON.stringify(durum, null, 1));
    };
    try {
      if (!harita) {
        log('>>', b.kod, 'taranıyor');
        const ogeler = await ulkeCek(b, ayar);
        const yeni = ogeler.map((e) => kayitOlustur(e, b.kod, kat)).filter(Boolean);
        const once = kayitlar.length;
        const t = tekillestir(kayitlar.concat(yeni), ayar.esik);
        kayitlar = t.kalan;
        log(b.kod, 'OSM:', yeni.length, '| önceki dosya:', once, '| tekilleştirme sonrası:', kayitlar.length, '| elenen:', t.silinen);
        durum[b.kod] = { ...d, harita: new Date().toISOString(), osm: yeni.length, elenen: t.silinen, sayi: kayitlar.length };
        kaydet();
        if (ayar.commit) gitKaydet(ayar.kok, 'data: ' + b.kod + ' taraması (' + kayitlar.length + ' nokta)');
      }
      const bitti = await zenginlestir(kayitlar, ayar, saatDolduMu, () => { kaydet(); if (ayar.commit) gitKaydet(ayar.kok, 'data: ' + b.kod + ' zenginleştirme (ara)'); });
      if (bitti) durum[b.kod] = { ...durum[b.kod], tamam: new Date().toISOString() };
      kaydet();
      if (ayar.commit) gitKaydet(ayar.kok, 'data: ' + b.kod + (bitti ? ' tamamlandı' : ' kısmen zenginleştirildi'));
    } catch (e) {
      log('!!', b.kod, 'hata:', e.message, '- atlandı, sonra yeniden denenecek');
    }
  }
}

if (require.main === module) {
  calistir(argumanlar(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { mesafe, mesafeYaz, puan, tekillestir, kayitOlustur, kategoriHesapla, etiketMetni, yakinCevreMetni, konumMetni, temizYaz, manifestGuncelle, calistir, argumanlar, US_BOLGE, ILKELER, birimler };
