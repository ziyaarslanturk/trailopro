#!/usr/bin/env node
// TRAILO PRO - ulke dosyalarini (data/XX.json) tekrar temizler ve ucretsiz kaynaklardan zenginlestirir.
// Kesilirse kaldigi yerden devam eder (work/ klasorunde durum tutar). Ek paket gerekmez, Node 18+.
// Kullanim:  node zenginlestir.js [--ulke TR,DE] [--max-dakika 330] [--sadece-tekrar] [--adimlar osm_id,osm_cevre,site,adres,wiki,irtifa,gbif]
// NOT: Bu dosya repo'nun KOK klasoründen calistirilmalidir (data/ klasoru ile yan yana).
//      node zenginlestir.js --ulke TR
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), https = require('https'), http = require('http');

// ---------------- AYARLAR ----------------
// Script nerede calisiyorsa ona gore kök bul
const SCRIPT_DIR = path.dirname(fs.realpathSync(process.argv[1]));
// data/ ve work/ her zaman repo kökünde: script tools/ altinda olabilir
const REPO_KOK = fs.existsSync(path.join(SCRIPT_DIR, 'data'))
  ? SCRIPT_DIR
  : path.join(SCRIPT_DIR, '..');

const CFG = {
  VERI: path.join(REPO_KOK, 'data'),
  CALISMA: path.join(REPO_KOK, 'work'),
  MESAFE: 50,            // metre: bu mesafedeki noktalar ayni yer sayilir
  KARISIK: 'birlestir', // biri adli biri adsiz: 'koru' | 'birlestir' (adsiz silinir, bilgisi adliya eklenir)
  ADLI_ADLI: 'hepsi',   // ikisi de adli: 'benzer' | 'hepsi' (50m icindeki bilgisi az olan silinir)
  UA: 'TrailoPRO-zenginlestir/1.0 (+https://github.com/ziyaarslanturk/trailopro)',
  ADIMLAR: ['osm_id', 'osm_cevre', 'site', 'adres', 'wiki', 'irtifa', 'gbif'],
};

// Baslangicta path kontrolu yap
console.log(`[YAPILANDIRMA] REPO KOK: ${REPO_KOK}`);
console.log(`[YAPILANDIRMA] VERI klasoru: ${CFG.VERI}`);
console.log(`[YAPILANDIRMA] CALISMA klasoru: ${CFG.CALISMA}`);
if (!fs.existsSync(CFG.VERI)) {
  console.error(`[HATA] data/ klasoru bulunamadi: ${CFG.VERI}`);
  console.error('Scripti repo kok klasorunden calistirin: node zenginlestir.js');
  process.exit(1);
}

const argv = process.argv.slice(2);
const arg = (n, v) => { const i = argv.indexOf('--' + n); return i < 0 ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const MAXMS = (parseFloat(arg('max-dakika', 0)) || 0) * 60000, T0 = Date.now();
const SADECE_TEKRAR = !!arg('sadece-tekrar', false);
const ADIMLAR = (arg('adimlar', '') || CFG.ADIMLAR.join(',')).split(',');
// --yeniden-baslat: belirtilen ulkeler icin state dosyasini sifirla
const YENIDEN = !!(arg('yeniden-baslat', false));

// ---------------- GENEL ----------------
class Stop extends Error {}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kontrol = () => { if (MAXMS && Date.now() - T0 > MAXMS) throw new Stop('sure doldu'); };
const sonVurus = {};
async function bekle(host, ms) { const n = Date.now(), t = Math.max(n, (sonVurus[host] || 0) + ms); sonVurus[host] = t; if (t > n) await sleep(t - n); }
const mt = (a, b, c, d) => { const x = (d - b) * Math.cos((a + c) * Math.PI / 360) * 111320, y = (c - a) * 110540; return Math.sqrt(x * x + y * y); };

function get(url, o = {}, hops = 0) {
  return new Promise(res => {
    let bitti = false; const son = r => { if (!bitti) { bitti = true; res(r); } };
    let u; try { u = new URL(url); } catch (e) { return son({ status: 0, body: '', buf: Buffer.alloc(0) }); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: o.method || 'GET', headers: Object.assign({ 'User-Agent': CFG.UA, Accept: '*/*' }, o.headers || {}), timeout: o.timeout || 30000 }, r => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && hops < 4) {
        r.resume(); let nu; try { nu = new URL(r.headers.location, u).href; } catch (e) { return son({ status: 0, body: '', buf: Buffer.alloc(0) }); }
        return son(get(nu, o, hops + 1));
      }
      const ch = []; let len = 0; const max = o.max || 3e6;
      const bit = () => { const buf = Buffer.concat(ch); son({ status: r.statusCode, headers: r.headers, buf, body: buf.toString('utf8') }); };
      r.on('data', c => { len += c.length; ch.push(c); if (len > max) r.destroy(); });
      r.on('end', bit); r.on('close', bit); r.on('error', bit);
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => son({ status: 0, body: '', buf: Buffer.alloc(0) }));
    if (o.body) req.write(o.body); req.end();
  });
}
const NET = { get };

// gecici hata -> undefined, veri yok -> null
async function json(url, o = {}, { host, ms = 1000, tries = 4 } = {}) {
  const h = host || new URL(url).host;
  for (let i = 0; i < tries; i++) {
    kontrol(); await bekle(h, ms);
    const r = await NET.get(url, o);
    if (r.status === 200) { try { return JSON.parse(r.body); } catch (e) {} }
    else if (r.status === 400 || r.status === 404) return null;
    await sleep(Math.min(60000, 3000 * 2 ** i));
  }
  return undefined;
}
const OP = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
let opi = 0;
async function overpass(q) {
  for (let i = 0; i < 6; i++) {
    kontrol(); const ep = OP[opi % OP.length]; await bekle(new URL(ep).host, 4000);
    const r = await NET.get(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q), timeout: 200000, max: 80e6 });
    if (r.status === 200) { try { const j = JSON.parse(r.body); if (!j.remark || !/runtime error|timed out/i.test(j.remark)) return j.elements || []; } catch (e) {} }
    opi++; await sleep(Math.min(90000, 10000 * (i + 1)));
  }
  return undefined;
}
async function havuz(liste, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < liste.length) { kontrol(); await fn(liste[i++]); } })); }

// ---------------- ISIM YARDIMCILARI ----------------
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ı/g, 'i').replace(/ß/g, 'ss').replace(/[^a-z0-9а-яё\u0600-\u06ff ]+/g, ' ').trim();
const STOP = new Set('camping camp kamp kamping alani alan karavan caravan park parki campsite campground campingplatz zeltplatz site area tent cadir kampi kampa campeggio campement'.split(' '));
const tokens = s => norm(s).split(/\s+/).filter(Boolean);
const genel = s => { const t = tokens(s); return t.length > 0 && t.every(x => STOP.has(x)); };
const adlar = p => [p.name_local, ...Object.values(p.name || {})].filter(x => x && String(x).trim());
const gercekAdlar = p => adlar(p).filter(x => !genel(x));
const adliMi = p => gercekAdlar(p).length > 0;
function lev(a, b) { const m = a.length, n = b.length; if (!m) return n; if (!n) return m; let pr = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const cu = [i]; for (let j = 1; j <= n; j++) cu[j] = Math.min(pr[j] + 1, cu[j - 1] + 1, pr[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); pr = cu; } return pr[n]; }
function benzerAd(p, k) {
  const f = s => tokens(s).filter(x => !STOP.has(x)).join('');
  for (const a of gercekAdlar(p).map(f)) for (const b of gercekAdlar(k).map(f)) {
    if (!a || !b) continue; if (a === b) return true;
    const kisa = a.length < b.length ? a : b, uzun = a.length < b.length ? b : a;
    if (kisa.length >= 4 && uzun.includes(kisa)) return true;
    if (kisa.length >= 6 && lev(a, b) <= 2) return true;
  }
  return false;
}
const hostOf = u => { try { return new URL(/^https?:/i.test(u) ? u : 'https://' + u).host.replace(/^www\./, '').toLowerCase(); } catch (e) { return null; } };
const digits = s => String(s || '').replace(/\D+/g, '');
function skor(p) {
  let s = 0; s += gercekAdlar(p).length; if (p.fee) s += 1; if (p.website) s += 3; if (p.phone) s += 2;
  if (p.notes && p.notes.description) s += 3; if (p.notes && p.notes.note) s += 1; s += Math.max(0, (p.category_ids || []).length - 1) * 0.5; return s;
}

// ---------------- 1) TEKRAR TEMIZLIGI ----------------
function birlestir(keep, drop) {
  keep.name = keep.name || {}; for (const l of Object.keys(drop.name || {})) if (!keep.name[l] && drop.name[l]) keep.name[l] = drop.name[l];
  for (const f of ['name_local', 'fee', 'website', 'phone']) if (!keep[f] && drop[f]) keep[f] = drop[f];
  keep.notes = keep.notes || {}; for (const f of ['description', 'note']) if (!keep.notes[f] && drop.notes && drop.notes[f]) keep.notes[f] = drop.notes[f];
  keep.category_ids = [...new Set([...(keep.category_ids || []), ...(drop.category_ids || [])])].sort((a, b) => a - b);
}
function karar(p, k) { // true: p silinir
  const pa = adliMi(p), ka = adliMi(k);
  if (!pa && !ka) return 'ikisi de adsiz';
  if (pa && ka) {
    if (CFG.ADLI_ADLI === 'hepsi') return skor(p) < skor(k) ? 'ikisi de adli, bilgisi az' : null;
    if (benzerAd(p, k)) return 'benzer ad';
    if (p.website && k.website && hostOf(p.website) === hostOf(k.website)) return 'ayni site';
    if (p.phone && k.phone && digits(p.phone) === digits(k.phone)) return 'ayni telefon';
    return null;
  }
  return (CFG.KARISIK === 'birlestir' && !pa && ka) ? 'adsiz, yakininda adli var' : null;
}
function tekrarTemizle(points) {
  const sira = points.map((p, i) => [p, i]).sort((a, b) => ((CFG.KARISIK === 'birlestir' ? (adliMi(b[0]) - adliMi(a[0])) : 0) || skor(b[0]) - skor(a[0]) || a[1] - b[1]));
  const grid = new Map(), ck = (la, lo) => Math.floor(la / 0.001) + ':' + Math.floor(lo / 0.002);
  const silinen = new Set(), log = [];
  for (const [p] of sira) {
    const cy = Math.floor(p.latitude / 0.001), cx = Math.floor(p.longitude / 0.002); let hedef = null, neden = null, mm = 0;
    for (let dy = -1; dy <= 1 && !hedef; dy++) for (let dx = -1; dx <= 1 && !hedef; dx++) for (const k of grid.get((cy + dy) + ':' + (cx + dx)) || []) {
      const d = mt(p.latitude, p.longitude, k.latitude, k.longitude); if (d > CFG.MESAFE) continue;
      const n = karar(p, k); if (n) { hedef = k; neden = n; mm = d; break; }
    }
    if (hedef) { birlestir(hedef, p); silinen.add(p.id); log.push({ silinen: p.id, korunan: hedef.id, mesafe_m: Math.round(mm), neden, silinen_ad: adlar(p)[0] || null, korunan_ad: adlar(hedef)[0] || null }); }
    else { const key = ck(p.latitude, p.longitude); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(p); }
  }
  return { points: points.filter(p => !silinen.has(p.id)), log };
}

// ---------------- DURUM DOSYASI ----------------
const stPath = cc => path.join(CFG.CALISMA, cc + '.state.json.gz');
function durumYukle(cc) { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(stPath(cc)))); } catch (e) { return { cc, det: {}, hucre: {}, log: [] }; } }
let CUR = null;
function durumKaydet(st) { fs.mkdirSync(CFG.CALISMA, { recursive: true }); const t = stPath(st.cc) + '.tmp'; fs.writeFileSync(t, zlib.gzipSync(JSON.stringify(st))); fs.renameSync(t, stPath(st.cc)); }
process.on('SIGINT', () => { if (CUR) { try { durumKaydet(CUR); } catch (e) {} } process.exit(0); });
const dd = (st, p) => st.det[p.id] || (st.det[p.id] = {});
function hata(st, p, adim) { const d = dd(st, p); d._f = d._f || {}; d._f[adim] = (d._f[adim] || 0) + 1; if (d._f[adim] >= 3) d[adim] = 1; }
let islem = 0; const kaydetGerekirse = st => { if (++islem % 20 === 0) durumKaydet(st); };

// ---------------- 2) OSM: nokta etiketleri (id ile) ----------------
const TAGOK = /^(name(:.+)?|alt_name|loc_name|operator|brand|description(:.+)?|website|url|contact:.+|phone|mobile|email|facebook|instagram|fee|charge|access|opening_hours|capacity(:.+)?|tents|caravans|backcountry|shower|toilets|drinking_water|power_supply|internet_access|dog|openfire|bbq|fireplace|picnic_table|sanitary_dump_station|laundry|washing_machine|swimming_pool|reservation|ele|wikipedia|wikidata|tourism|addr:.+)$/;
const kTags = t => { const o = {}; for (const k of Object.keys(t || {})) if (TAGOK.test(k)) o[k] = t[k]; return o; };
const osmRef = id => { const m = /^([nwr])(\d+)$/.exec(id); return m ? { t: { n: 'node', w: 'way', r: 'relation' }[m[1]], i: m[2] } : null; };
async function adimOsmId(st) {
  const todo = []; for (const p of st.points) { const d = dd(st, p); if (d._id) continue; if (!osmRef(p.id)) d._id = 1; else todo.push(p); }
  console.log(`  OSM ID: ${todo.length} nokta sorgulanacak`);
  for (let i = 0; i < todo.length; i += 150) {
    const b = todo.slice(i, i + 150), by = { node: [], way: [], relation: [] }; b.forEach(p => { const r = osmRef(p.id); by[r.t].push(r.i); });
    const parts = Object.entries(by).filter(([, a]) => a.length).map(([t, a]) => `${t}(id:${a.join(',')});`).join('');
    const els = await overpass(`[out:json][timeout:120];(${parts});out tags center;`);
    if (els === undefined) { b.forEach(p => hata(st, p, '_id')); continue; }
    const map = new Map(els.map(e => [{ node: 'n', way: 'w', relation: 'r' }[e.type] + e.id, e]));
    b.forEach(p => { const e = map.get(p.id); const d = dd(st, p); d.tags = e ? kTags(e.tags) : null; d._id = 1; });
    if (i % 1500 === 0) console.log(`  OSM ID ilerleme: ${i}/${todo.length}`);
    kaydetGerekirse(st);
  }
}

// ---------------- 3) OSM: yakin cevre (0.1 derece kare) ----------------
function sinif(t) {
  if (/^(national_park|protected_area)$/.test(t.boundary)) return 'koru';
  if (/^(camp_site|caravan_site|guest_house|hostel|chalet|hotel|motel|apartment|alpine_hut|wilderness_hut)$/.test(t.tourism)) return 'isletme';
  if (/^(attraction|viewpoint)$/.test(t.tourism)) return 'ilgi';
  if (t.waterway === 'waterfall') return 'su';
  if (/^(water|beach|spring|hot_spring|bay)$/.test(t.natural)) return 'su';
  if (t.natural === 'peak') return 'tepe';
  if (t.natural === 'cave_entrance' || t.natural === 'cape') return 'ilgi';
  if (t.place) return 'yerlesim';
  if (t.amenity === 'drinking_water') return 'icmesuyu';
  if (/^(toilets|shower)$/.test(t.amenity)) return 'wc';
  if (t.amenity === 'fuel') return 'yakit';
  if (/^(hospital|clinic|pharmacy)$/.test(t.amenity)) return 'saglik';
  if (t.shop) return 'market';
  return null;
}
const YARICAP = { su: [3000, 3], tepe: [10000, 2], yerlesim: [15000, 2], ilgi: [10000, 3], icmesuyu: [3000, 2], wc: [300, 3], yakit: [20000, 1], saglik: [30000, 1], market: [10000, 2], isletme: [1000, 3] };
const ADSIZOK = new Set(['icmesuyu', 'wc', 'yakit', 'saglik', 'market']);
function sorguTile(S, W, N, E) {
  const b = `(${S},${W},${N},${E})`;
  return `[out:json][timeout:180];(
    node["tourism"~"^(camp_site|caravan_site|attraction|viewpoint|guest_house|hostel|chalet|hotel|motel|apartment|alpine_hut|wilderness_hut)$"]${b};
    way["tourism"~"^(camp_site|caravan_site|attraction|viewpoint|guest_house|hostel|chalet|hotel|motel|apartment|alpine_hut|wilderness_hut)$"]${b};
    node["natural"~"^(peak|water|beach|spring|hot_spring|bay|cave_entrance|cape)$"]${b};
    way["natural"~"^(water|beach|spring|hot_spring|bay)$"]${b};
    node["waterway"="waterfall"]${b};
    node["place"]${b};
    node["amenity"~"^(drinking_water|toilets|shower|fuel|hospital|clinic|pharmacy)$"]${b};
    way["amenity"~"^(hospital|clinic|pharmacy)$"]${b};
    node["shop"]${b};
    relation["boundary"~"^(national_park|protected_area)$"]${b};
    way["boundary"~"^(national_park|protected_area)$"]${b};
  );out tags center bb;`;
}
function indeksle(els) {
  const idx = {}; for (const e of els) {
    const t = e.tags || {}, s = sinif(t); if (!s) continue;
    const la = e.center ? e.center.lat : e.lat, lo = e.center ? e.center.lon : e.lon;
    const ad = t.name || t['name:en'] || t['name:tr'] || null;
    const bb = e.bounds || null;
    if (!idx[s]) idx[s] = []; idx[s].push({ la, lo, ad, tur: t.tourism || t.natural || t.amenity || t.place || t.shop || null, tags: t, bb });
  }
  return idx;
}
async function tileCek(S, W, N, E, derinlik) {
  const els = await overpass(sorguTile(S, W, N, E));
  if (els !== undefined) return els;
  if (derinlik >= 2) return undefined;
  const mla = (S + N) / 2, mlo = (W + E) / 2;
  const q = [[S, W, mla, mlo], [S, mlo, mla, E], [mla, W, N, mlo], [mla, mlo, N, E]];
  const all = [];
  for (const [s, w, n, e] of q) { const r = await tileCek(s, w, n, e, derinlik + 1); if (r === undefined) return undefined; all.push(...r); }
  return all;
}
function cevreHesapla(p, idx) {
  const o = {}; let kd = Infinity, komsu = null;
  for (const [k, [r, n]] of Object.entries(YARICAP)) {
    const lst = []; for (const x of idx[k] || []) { if (!x.ad && !ADSIZOK.has(k)) continue; if (Math.abs(x.la - p.latitude) > r / 100000) continue; const d = mt(p.latitude, p.longitude, x.la, x.lo); if (d <= r) lst.push({ ad: x.ad, tur: x.tur, m: Math.round(d) }); }
    lst.sort((a, b) => a.m - b.m); if (lst.length) o[k] = lst.slice(0, n);
  }
  for (const k of ['isletme', 'su', 'tepe', 'ilgi', 'yerlesim']) for (const x of idx[k] || []) {
    if (!x.ad || Math.abs(x.la - p.latitude) > 0.0006) continue; const d = mt(p.latitude, p.longitude, x.la, x.lo); if (d <= 50 && d < kd && (k === 'isletme' || !komsu)) { kd = d; komsu = { ad: x.ad, tur: x.tur, m: Math.round(d), sinif: k, site: x.tags.website || x.tags['contact:website'] || null, tel: x.tags.phone || x.tags['contact:phone'] || null }; }
  }
  const koru = (idx.koru || []).filter(x => x.bb && p.latitude >= x.bb.minlat && p.latitude <= x.bb.maxlat && p.longitude >= x.bb.minlon && p.longitude <= x.bb.maxlon).map(x => x.ad).slice(0, 2);
  if (koru.length) o.koru = koru; if (komsu) o.komsu50 = komsu; return o;
}
async function adimCevre(st) {
  const gr = {}; for (const p of st.points) if (!dd(st, p)._cv) { const k = Math.floor(p.latitude / 0.1) + ':' + Math.floor(p.longitude / 0.1); (gr[k] = gr[k] || []).push(p); }
  const toplam = Object.keys(gr).length;
  console.log(`  Cevre: ${toplam} tile sorgulanacak`);
  let tileNo = 0;
  for (const [k, pts] of Object.entries(gr)) {
    const [a, b] = k.split(':').map(Number);
    const els = await tileCek(a * 0.1 - 0.05, b * 0.1 - 0.05, a * 0.1 + 0.15, b * 0.1 + 0.15, 0);
    if (els === undefined) { pts.forEach(p => hata(st, p, '_cv')); continue; }
    const idx = indeksle(els); pts.forEach(p => { const d = dd(st, p); d.cevre = cevreHesapla(p, idx); d._cv = 1; }); durumKaydet(st);
    tileNo++; if (tileNo % 10 === 0) console.log(`  Cevre tile ${tileNo}/${toplam}`);
  }
}

// ---------------- 4) WEB SITESI ----------------
const SOSYAL = /(facebook\.com|instagram\.com|wa\.me|linktr\.ee|goo\.gl|maps\.app|google\.[a-z.]+\/maps|youtube\.com|tiktok\.com|twitter\.com|x\.com)/i;
const ANAHTAR = [['Duş', /\b(du[sş]|dusch|shower|douche|ducha)/i], ['Tuvalet/WC', /\b(tuvalet|wc|toilet|toilette)/i], ['Elektrik', /\b(elektrik|electric|strom|électricité|electricidad|hook-?up)/i], ['Wi-Fi', /\b(wi-?fi|wlan)/i], ['Sıcak su', /(sıcak su|hot water|warmwasser|eau chaude)/i], ['Restoran/Kafe', /\b(restoran|restaurant|lokanta|kafeterya|caf[eé])/i], ['Market', /\b(market|supermarkt|épicerie|mini ?mart)/i], ['Çamaşırhane', /(çamaşır|laundry|waschmaschine)/i], ['Çadır alanı', /\b(çadır|tent|zelt|tente)/i], ['Karavan alanı', /\b(karavan|caravan|wohnmobil|camping-?car)/i], ['Bungalov', /\b(bungalo[vw]|chalet|cabin|mobilheim)/i], ['Havuz', /\b(havuz|pool|piscine|schwimmbad)/i], ['Plaj', /\b(plaj|beach|strand|plage)/i], ['Evcil hayvan', /(evcil|\bpets?\b|\bdogs?\b|\bhund|chien|köpek)/i], ['Mangal/BBQ', /\b(mangal|barbecue|bbq|grill)/i], ['Çocuk oyun alanı', /(çocuk oyun|playground|spielplatz|kids)/i]];
function siteParse(html) {
  const meta = (n) => { const m = new RegExp('<meta[^>]+(?:name|property)=["\']' + n + '["\'][^>]*content=["\']([^"\']*)', 'i').exec(html) || new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:name|property)=["\']' + n + '["\']', 'i').exec(html); return m ? m[1].trim() : null; };
  const baslik = (/<title[^>]*>([^<]*)/i.exec(html) || [])[1];
  const txt = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const tel = [...new Set([...html.matchAll(/href=["']tel:([+\d()\-\s.%]+)/gi)].map(m => decodeURIComponent(m[1]).trim()))].slice(0, 2);
  const mail = [...new Set([...html.matchAll(/mailto:([^"'?\s>]+@[^"'?\s>]+)/gi)].map(m => m[1]))].slice(0, 2);
  const sos = [...new Set([...html.matchAll(/https?:\/\/(?:www\.)?(?:facebook|instagram)\.com\/[^"'\s<>)]+/gi)].map(m => m[0].replace(/[.,;]+$/, '')))].slice(0, 3);
  const fiyat = [...new Set([...txt.matchAll(/.{0,25}\d[\d.,]*\s?(?:₺|TL|€|EUR|\$|USD|£)(?:.{0,15})/g)].map(m => m[0].trim()))].slice(0, 3);
  return { baslik: baslik && baslik.trim().slice(0, 120), aciklama: (meta('description') || meta('og:description') || '').slice(0, 300) || null, tel, mail, sosyal: sos, olanak: ANAHTAR_BUL(txt), fiyat };
}
function ANAHTAR_BUL(txt) { return ANAHTAR.filter(([, re]) => re.test(txt)).map(([ad]) => ad); }
function decode(r) {
  const ct = (r.headers && r.headers['content-type']) || '', head = r.buf.slice(0, 3000).toString('latin1');
  const m = /charset=["']?([\w-]+)/i.exec(ct) || /charset=["']?([\w-]+)/i.exec(head); const cs = m ? m[1].toLowerCase() : 'utf-8';
  if (/utf-?8/.test(cs)) return r.buf.toString('utf8'); try { return new TextDecoder(cs).decode(r.buf); } catch (e) { return r.buf.toString('utf8'); }
}
const siteOf = (p, d) => { const t = d.tags || {}; return p.website || t.website || t['contact:website'] || t.url || (d.cevre && d.cevre.komsu50 && d.cevre.komsu50.site) || null; };
async function adimSite(st) {
  const todo = []; for (const p of st.points) { const d = dd(st, p); if (d._st) continue; const u = siteOf(p, d); if (!u) { d._st = 1; continue; } if (SOSYAL.test(u)) { d.sosyal = [u]; d._st = 1; continue; } todo.push([p, /^https?:/i.test(u) ? u : 'https://' + u]); }
  console.log(`  Site: ${todo.length} adres cekilecek`);
  await havuz(todo, 8, async ([p, u]) => {
    const d = dd(st, p); await bekle(hostOf(u) || 'x', 1500); const r = await NET.get(u, { timeout: 15000, max: 600000, headers: { Accept: 'text/html', 'Accept-Language': 'tr,en;q=0.8' } });
    if (r.status === 200 && /html/i.test((r.headers && r.headers['content-type']) || 'html')) { try { d.site = siteParse(decode(r)); d.site.url = u; } catch (e) {} d._st = 1; }
    else if (r.status === 0 || r.status >= 500 || r.status === 429) hata(st, p, '_st'); else d._st = 1;
    kaydetGerekirse(st);
  });
}

// ---------------- 5) ADRES (Nominatim, ~500 m hucre onbellegi) ----------------
const DIL = { TR: 'tr', DE: 'de', AT: 'de', CH: 'de', FR: 'fr', ES: 'es', IT: 'it', PT: 'pt', NL: 'nl', PL: 'pl', RU: 'ru' };
async function adimAdres(st) {
  const todo = st.points.filter(p => !dd(st, p)._ad);
  console.log(`  Adres: ${todo.length} nokta sorgulanacak`);
  for (const p of todo) {
    const d = dd(st, p); kontrol();
    const key = 'ad:' + Math.round(p.latitude / 0.005) + ':' + Math.round(p.longitude / 0.005);
    if (st.hucre[key] === undefined) {
      const j = await json(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&addressdetails=1&accept-language=${DIL[st.cc] || 'en'}&lat=${p.latitude}&lon=${p.longitude}`, {}, { ms: 1100 });
      if (j === undefined) { hata(st, p, '_ad'); continue; }
      const a = (j && j.address) || {};
      st.hucre[key] = { ulke: a.country || null, il: a.province || a.state || a.region || null, ilce: a.town || a.county || a.municipality || a.city || a.city_district || null, koy: a.village || a.hamlet || a.suburb || a.neighbourhood || a.quarter || null };
    }
    d.adres = st.hucre[key]; d._ad = 1; kaydetGerekirse(st);
  }
}

// ---------------- 6) WIKIPEDIA ----------------
async function adimWiki(st) {
  const lang = DIL[st.cc] || 'en';
  const todo = st.points.filter(p => !dd(st, p)._wk);
  console.log(`  Wiki: ${todo.length} nokta sorgulanacak`);
  for (const p of todo) {
    const d = dd(st, p); kontrol();
    const key = 'wk:' + Math.round(p.latitude / 0.02) + ':' + Math.round(p.longitude / 0.02);
    if (st.hucre[key] === undefined) {
      const j = await json(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&generator=geosearch&ggscoord=${p.latitude}%7C${p.longitude}&ggsradius=6000&ggslimit=5&prop=extracts%7Ccoordinates&exintro=1&explaintext=1&exchars=350&colimit=5`, {}, { ms: 300 });
      if (j === undefined) { hata(st, p, '_wk'); continue; }
      st.hucre[key] = Object.values((j && j.query && j.query.pages) || {}).map(x => ({ b: x.title, o: (x.extract || '').replace(/\s+/g, ' ').trim(), la: x.coordinates && x.coordinates[0].lat, lo: x.coordinates && x.coordinates[0].lon })).filter(x => x.la != null);
    }
    d.wiki = st.hucre[key].map(x => ({ baslik: x.b, ozet: x.o, m: Math.round(mt(p.latitude, p.longitude, x.la, x.lo)) })).filter(x => x.m <= 5000).sort((a, b) => a.m - b.m).slice(0, 2); d._wk = 1; kaydetGerekirse(st);
  }
}

// ---------------- 7) IRTIFA (Open-Meteo) ----------------
async function adimIrtifa(st) {
  const todo = st.points.filter(p => !dd(st, p)._el);
  console.log(`  Irtifa: ${todo.length} nokta sorgulanacak`);
  for (let i = 0; i < todo.length; i += 100) {
    const b = todo.slice(i, i + 100);
    const j = await json(`https://api.open-meteo.com/v1/elevation?latitude=${b.map(p => p.latitude.toFixed(5)).join(',')}&longitude=${b.map(p => p.longitude.toFixed(5)).join(',')}`, {}, { ms: 600 });
    if (j === undefined) { b.forEach(p => hata(st, p, '_el')); continue; }
    b.forEach((p, n) => { const d = dd(st, p); d.irtifa = j && j.elevation ? Math.round(j.elevation[n]) : null; d._el = 1; }); kaydetGerekirse(st);
  }
}

// ---------------- 8) CANLI TURLERI (GBIF gozlem kayitlari, ~5 km hucre) ----------------
const GRUP = [['kus', 'classKey=212'], ['memeli', 'classKey=359'], ['surungen', 'classKey=358'], ['bitki', 'kingdomKey=6']];
async function adimGbif(st) {
  const todo = st.points.filter(p => !dd(st, p)._gb);
  console.log(`  GBIF: ${todo.length} nokta sorgulanacak`);
  for (const p of todo) {
    const d = dd(st, p); kontrol();
    const a = Math.round(p.latitude / 0.05), b = Math.round(p.longitude / 0.05), key = 'gb:' + a + ':' + b;
    if (st.hucre[key] === undefined) {
      const o = {}; let bozuk = false;
      for (const [ad, q] of GRUP) {
        const j = await json(`https://api.gbif.org/v1/occurrence/search?decimalLatitude=${(a * 0.05 - 0.025).toFixed(3)},${(a * 0.05 + 0.025).toFixed(3)}&decimalLongitude=${(b * 0.05 - 0.025).toFixed(3)},${(b * 0.05 + 0.025).toFixed(3)}&${q}&limit=300&hasCoordinate=true&hasGeospatialIssue=false`, {}, { ms: 300 });
        if (j === undefined) { bozuk = true; break; }
        const sy = {}; for (const r of (j && j.results) || []) if (r.species) { const e = sy[r.species] || (sy[r.species] = { n: 0, ad: r.vernacularName || null }); e.n++; }
        o[ad] = Object.entries(sy).sort((x, y) => y[1].n - x[1].n).slice(0, 8).map(([s, e]) => e.ad ? `${s} (${e.ad})` : s);
      }
      if (bozuk) { hata(st, p, '_gb'); continue; } st.hucre[key] = o;
    }
    d.canli = st.hucre[key]; d._gb = 1; kaydetGerekirse(st);
  }
}

// ---------------- YAZIM: nokta alanlarini doldur ----------------
const CAMPWORD = { TR: 'Kamp Alanı', DE: 'Campingplatz', AT: 'Campingplatz', CH: 'Campingplatz', FR: 'Camping', ES: 'Camping', IT: 'Campeggio', PT: 'Parque de Campismo', NL: 'Camping', PL: 'Pole Namiotowe', RU: 'Кемпинг' };
const mf = m => m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : m + ' m';
const liste = (a, n) => (a || []).slice(0, n).map(x => (x.ad || x.tur) + ' (' + mf(x.m) + ')').join(', ');
function yaz(st, p) {
  const d = dd(st, p), t = d.tags || {}, cc = st.cc, cv = d.cevre || {}, ad = d.adres || {}, notlar = [];
  p.notes = p.notes || { description: null, note: null }; p.name = p.name || {};
  // ad
  let uretildi = false;
  const yeniAd = () => t.operator || t.brand || (cv.komsu50 && cv.komsu50.ad) || null;
  if (!adliMi(p)) {
    let a = yeniAd();
    if (!a) { const y = (cv.yerlesim && cv.yerlesim[0] && cv.yerlesim[0].m <= 2000 && cv.yerlesim[0].ad) || ad.koy || ad.ilce; if (y) { a = y + ' ' + (CAMPWORD[cc] || 'Campsite'); uretildi = true; } }
    if (a) { p.name_local = a; const l = cc === 'TR' ? 'tr' : 'en'; p.name[l] = a; notlar.push(uretildi ? 'Ad konumdan türetildi' : 'Ad OSM/yakın işletmeden alındı'); }
  }
  for (const l of ['tr', 'en', 'de', 'ru', 'ar']) if (!p.name[l] && t['name:' + l]) p.name[l] = t['name:' + l];
  // iletisim
  const s = d.site || {};
  if (!p.website) { const u = t.website || t['contact:website'] || t.url || (cv.komsu50 && cv.komsu50.site); if (u) p.website = u; }
  if (!p.phone) { const x = t.phone || t['contact:phone'] || t.mobile || (s.tel && s.tel[0]) || (cv.komsu50 && cv.komsu50.tel); if (x) p.phone = x; }
  if (!p.fee) { if (t.fee === 'yes' || t.charge) p.fee = 'yes'; else if (t.fee === 'no') p.fee = 'no'; }
  // aciklama
  const ol = []; const yn = (k, ad) => { if (t[k] === 'yes' || (k === 'internet_access' && /^(wlan|wifi|yes)$/.test(t[k]))) ol.push(ad); };
  yn('shower', 'duş'); yn('toilets', 'tuvalet'); yn('power_supply', 'elektrik'); yn('internet_access', 'Wi-Fi'); yn('drinking_water', 'içme suyu'); yn('swimming_pool', 'havuz'); yn('bbq', 'mangal'); yn('picnic_table', 'piknik masası'); yn('sanitary_dump_station', 'atık su boşaltımı'); yn('laundry', 'çamaşır'); yn('tents', 'çadır alanı'); yn('caravans', 'karavan alanı');
  for (const x of s.olanak || []) if (!ol.some(o => o.toLowerCase() === x.toLowerCase())) ol.push(x);
  const yasak = []; if (t.dog === 'yes') ol.push('evcil hayvan izinli'); else if (t.dog === 'no') yasak.push('evcil hayvan yasak'); if (t.openfire === 'yes') ol.push('ateş yakılabilir'); else if (t.openfire === 'no') yasak.push('ateş yakmak yasak'); if (t.backcountry === 'yes') ol.push('vahşi kamp');
  const L = [], yer = [ad.koy, ad.ilce, ad.il, ad.ulke].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  if (yer.length || d.irtifa != null) L.push('KONUM: ' + yer.join(', ') + (d.irtifa != null ? (yer.length ? '. ' : '') + 'İrtifa: ' + d.irtifa + ' m' : '') + '.');
  if (ol.length || yasak.length || t.capacity || t.opening_hours) L.push('OLANAKLAR: ' + [...ol.map(x => x.charAt(0).toUpperCase() + x.slice(1)), ...yasak, t.capacity ? 'kapasite ' + t.capacity : null, t.opening_hours ? 'saat: ' + t.opening_hours : null].filter(Boolean).join(', ') + '.');
  const u = []; if (p.fee === 'yes') u.push('Ücretli'); else if (p.fee === 'no') u.push('Ücretsiz'); if (s.fiyat && s.fiyat.length) u.push('sitede geçen fiyat ifadeleri: ' + s.fiyat.join(' | ')); if (u.length) L.push('ÜCRET: ' + u.join('; ') + '.');
  const y = []; if (cv.su) y.push('Su/plaj: ' + liste(cv.su, 3)); if (cv.icmesuyu) y.push('İçme suyu: ' + liste(cv.icmesuyu, 2)); if (cv.wc) y.push('Tuvalet/duş noktası: ' + liste(cv.wc, 2)); if (cv.market) y.push('Market: ' + liste(cv.market, 2)); if (cv.yakit) y.push('Akaryakıt: ' + liste(cv.yakit, 1)); if (cv.saglik) y.push('Sağlık: ' + liste(cv.saglik, 1)); if (cv.yerlesim) y.push('Yerleşim: ' + liste(cv.yerlesim, 2)); if (cv.tepe) y.push('Zirve: ' + liste(cv.tepe, 2)); if (cv.ilgi) y.push('Görülecek: ' + liste(cv.ilgi, 3)); if (cv.isletme) y.push('Yakın tesis: ' + liste(cv.isletme.filter(x => x.m > 50), 2));
  if (y.length) L.push('YAKIN ÇEVRE: ' + y.join('. ').replace(/\.\. /g, '. ') + '.');
  if (cv.koru) L.push('KORUMA ALANI (yaklaşık): ' + cv.koru.join(', ') + '. Kural ve yasakları kontrol et.');
  const c = d.canli || {}, dn = []; if (c.kus && c.kus.length) dn.push('Kuşlar: ' + c.kus.slice(0, 5).join(', ')); if (c.memeli && c.memeli.length) dn.push('Memeliler: ' + c.memeli.slice(0, 4).join(', ')); if (c.surungen && c.surungen.length) dn.push('Sürüngenler: ' + c.surungen.slice(0, 3).join(', ')); if (c.bitki && c.bitki.length) dn.push('Bitkiler: ' + c.bitki.slice(0, 5).join(', '));
  if (dn.length) L.push('DOĞA (çevredeki gözlem kayıtları, bilimsel ad): ' + dn.join('. ') + '.');
  const w = d.wiki && d.wiki[0]; if (w && w.ozet) L.push('ÇEVRE BİLGİSİ (Wikipedia, ' + w.baslik + ', ' + mf(w.m) + '): ' + w.ozet.slice(0, 300));
  if (s.aciklama) L.push('SİTE: ' + s.aciklama);
  if (t.description || t['description:tr']) L.push('OSM NOTU: ' + (t['description:tr'] || t.description));
  const eski = p.notes.description;
  if (L.length && (!eski || /^KONUM:|^OLANAKLAR:|^ÜCRET:|^YAKIN ÇEVRE:|^DOĞA/.test(eski))) p.notes.description = L.join('\n').slice(0, 2000);
  const kay = ['OSM'].concat(d.site ? ['site'] : [], d.wiki && d.wiki.length ? ['Wikipedia'] : [], d.canli ? ['GBIF'] : [], d.irtifa != null ? ['Open-Meteo'] : []);
  const en = p.notes.note; if (!en || /^Otomatik derleme/.test(en)) p.notes.note = ('Otomatik derleme (' + new Date().toISOString().slice(0, 10) + '): ' + kay.join(', ') + '. ' + notlar.join('. ') + (notlar.length ? '. ' : '') + 'Doğrulanmalı.').replace(/\s+/g, ' ');
  if (d.sosyal || (s.sosyal && s.sosyal.length)) d.sosyal = [...new Set([...(d.sosyal || []), ...(s.sosyal || [])])];
}

// ---------------- ULKE ISLEME ----------------
function dosyaOku(f) { const b = fs.readFileSync(f); return JSON.parse((f.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8')); }
function dosyaYaz(f, o) { const s = JSON.stringify(o); fs.writeFileSync(f, f.endsWith('.gz') ? zlib.gzipSync(s) : s); }
const ADIM_FN = { osm_id: adimOsmId, osm_cevre: adimCevre, site: adimSite, adres: adimAdres, wiki: adimWiki, irtifa: adimIrtifa, gbif: adimGbif };
async function ulke(cc, f) {
  if (YENIDEN) {
    const sp = stPath(cc);
    if (fs.existsSync(sp)) { fs.unlinkSync(sp); console.log(cc, '- state sifirlandi'); }
  }
  const st = CUR = durumYukle(cc);
  if (st.bitti) { console.log(cc, 'zaten bitti (--yeniden-baslat ile sifirla)'); return; }
  if (!st.tekrarBitti) {
    const p0 = dosyaOku(f); const { points, log } = tekrarTemizle(p0);
    st.points = points; st.log = log; st.once = p0.length; st.tekrarBitti = true; durumKaydet(st);
    console.log(`${cc}: ${p0.length} nokta, tekrar temizligi sonrasi ${points.length} (silinen ${log.length})`);
  } else {
    console.log(`${cc}: state yukle - ${st.points.length} nokta, adimlar isleniyor`);
  }
  if (SADECE_TEKRAR) return;
  for (const a of ADIMLAR) {
    const tamam = st.points.filter(p => dd(st, p)['_' + { osm_id: 'id', osm_cevre: 'cv', site: 'st', adres: 'ad', wiki: 'wk', irtifa: 'el', gbif: 'gb' }[a]]).length;
    if (tamam === st.points.length) { console.log(cc, '- adim ATLANDI (zaten tamamlandi):', a); continue; }
    console.log(cc, '- adim basladi:', a, `(${tamam}/${st.points.length} tamamlanmis)`);
    await ADIM_FN[a](st); durumKaydet(st);
    console.log(cc, '- adim tamamlandi:', a);
  }
  st.points.forEach(p => yaz(st, p));
  dosyaYaz(f, st.points); // mevcut dosyanin icine yazar, baska dosya uretmez
  st.bitti = true; durumKaydet(st); console.log(cc, 'TAMAMLANDI ->', f);
}
async function main() {
  const dosyalar = fs.readdirSync(CFG.VERI)
    .map(n => /^([A-Za-z]{2})\.json(\.gz)?$/.exec(n))
    .filter(Boolean)
    .map(m => ({ cc: m[1].toUpperCase(), f: path.join(CFG.VERI, m[0]), boy: fs.statSync(path.join(CFG.VERI, m[0])).size }));
  console.log(`[TARAMA] ${dosyalar.length} ulke dosyasi bulundu: ${dosyalar.map(x => x.cc).join(', ')}`);
  if (dosyalar.length === 0) { console.error('[HATA] data/ klasorunde hic XX.json dosyasi yok!'); process.exit(1); }
  const sec = (arg('ulke', '') || '').toString().toUpperCase().split(',').filter(Boolean);
  if (sec.length) console.log(`[FILTRE] Secilen ulkeler: ${sec.join(', ')}`);
  dosyalar.sort((a, b) => (a.cc === 'TR' ? -1 : b.cc === 'TR' ? 1 : a.boy - b.boy));
  try {
    for (const x of dosyalar) if (!sec.length || sec.includes(x.cc)) await ulke(x.cc, x.f);
    console.log('Secilen ulkelerin hepsi bitti.');
  } catch (e) {
    if (CUR) durumKaydet(CUR);
    if (e instanceof Stop) console.log('Sure doldu, durum kaydedildi. Ayni komutla devam eder.');
    else throw e;
  }
}
module.exports = { tekrarTemizle, yaz, indeksle, cevreHesapla, siteParse, adliMi, genel, CFG, NET, dd, ulke, adimCevre, adimOsmId, adimSite, adimAdres, adimWiki, adimIrtifa, adimGbif, durumYukle };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
