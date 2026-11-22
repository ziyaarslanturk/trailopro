#!/usr/bin/env node
// TRAILO PRO - ulke dosyalarini (data/XX.json) tekrar temizler ve ucretsiz kaynaklardan zenginlestirir.
// Kesilirse kaldigi yerden devam eder (work/ klasorunde durum tutar). Ek paket gerekmez, Node 18+.
// Kullanim:  node zenginlestir.js [--ulke TR,DE] [--max-dakika 330] [--sadece-tekrar] [--adimlar osm_id,osm_cevre,site,adres,wiki,irtifa,gbif]
// NOT: Bu dosya repo'nun KOK klasoründen calistirilmalidir (data/ klasoru ile yan yana).
//      node zenginlestir.js --ulke TR
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), https = require('https'), http = require('http');

// ---------------- AYARLAR ----------------
// Calisma dizini: komut repo kokunden calistirilir
const REPO_KOK = process.cwd();
const CFG = {
  CALISMA: path.join(REPO_KOK, 'work'),
  MESAFE: 50,            // metre: bu mesafedeki noktalar ayni yer sayilir
  KARISIK: 'birlestir',  // biri adli biri adsiz: 'koru' | 'birlestir' (adsiz silinir, bilgisi adliya eklenir)
  ADLI_ADLI: 'hepsi',    // ikisi de adli: 'benzer' | 'hepsi' (50m icindeki bilgisi az olan silinir)
  UA: 'TrailoPRO-zenginlestir/2.0 (+https://github.com/ziyaarslanturk/trailopro)',
  ADIMLAR: ['osm_id', 'osm_cevre', 'site', 'adres', 'wiki', 'irtifa', 'gbif'],
};

const argv = process.argv.slice(2);
const arg = (n, v) => { const i = argv.indexOf('--' + n); return i < 0 ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const MAXMS = (parseFloat(arg('max-dakika', 0)) || 0) * 60000, T0 = Date.now();
const SADECE_TEKRAR = !!arg('sadece-tekrar', false);
const ADIMLAR = (arg('adimlar', '') || CFG.ADIMLAR.join(',')).split(',');
// --yeniden-baslat: belirtilen ulkeler icin state dosyasini sifirla
const YENIDEN = !!(arg('yeniden-baslat', false));

// ---------------- GENEL ----------------
class Stop extends Error {}
const HIZLI = !!process.env.TRAILO_SAHTE_AG;  // testlerde bekleme yok
const sleep = ms => new Promise(r => setTimeout(r, HIZLI ? 1 : ms));
const kontrol = () => { if (MAXMS && Date.now() - T0 > MAXMS) throw new Stop('sure doldu'); };
const sonVurus = {};
async function bekle(host, ms) { if (HIZLI) return; const n = Date.now(), t = Math.max(n, (sonVurus[host] || 0) + ms); sonVurus[host] = t; if (t > n) await sleep(t - n); }
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
// Test kancasi: TRAILO_SAHTE_AG=dosya.js verilirse ag cagrilari sahte yanitla degistirilir (sadece testlerde)
if (process.env.TRAILO_SAHTE_AG) require(path.resolve(process.env.TRAILO_SAHTE_AG))(NET);

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
  // Silinen kimlikler hatirlanir: OSM'den tekrar gelirse yeni yer sanilip eklenmesin
  keep._meta = keep._meta && typeof keep._meta === 'object' ? keep._meta : {};
  keep._meta.birlesen = [...new Set([...(keep._meta.birlesen || []), drop.id, ...((drop._meta && drop._meta.birlesen) || [])])];
  if (drop._bekle && !keep._bekle) keep._bekle = 'tazele';  // yeni bilgi geldi, tekrar zenginlestir
  if (drop._meta && drop._meta.kullanici_alanlari) keep._meta.kullanici_alanlari = [...new Set([...(keep._meta.kullanici_alanlari || []), ...drop._meta.kullanici_alanlari])];
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
const hucreYol = cc => path.join(CFG.CALISMA, cc + '.hucre.json.gz');
function durumYukle(cc) { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(stPath(cc)))); } catch (e) { return { cc, det: {}, hucre: {}, log: [] }; } }
let CUR = null;
function durumKaydet(st) { try { fs.mkdirSync(CFG.CALISMA, { recursive: true }); const t = hucreYol(st.cc) + '.tmp'; fs.writeFileSync(t, zlib.gzipSync(JSON.stringify({ t: st.hucreT || new Date().toISOString().slice(0, 10), h: st.hucre || {} }))); fs.renameSync(t, hucreYol(st.cc)); } catch (e) {} }
process.on('SIGINT', () => { if (CUR) { try { durumKaydet(CUR); } catch (e) {} } process.exit(0); });
const dd = (st, p) => st.det[p.id] || (st.det[p.id] = {});
function hata(st, p, adim) { const d = dd(st, p); d._f = d._f || {}; d._f[adim] = (d._f[adim] || 0) + 1; if (d._f[adim] >= 3) d[adim] = 1; }
let islem = 0; const kaydetGerekirse = st => { if (++islem % 20 === 0) durumKaydet(st); };

// ---------------- 2) OSM: nokta etiketleri (id ile) ----------------
const TAGOK = /^(name(:.+)?|alt_name|loc_name|operator|brand|description(:.+)?|website|url|contact:.+|phone|mobile|email|facebook|instagram|fee|charge|access|opening_hours|capacity(:.+)?|tents|caravans|backcountry|shower|toilets|drinking_water|power_supply|internet_access|dog|openfire|bbq|fireplace|picnic_table|sanitary_dump_station|laundry|washing_machine|swimming_pool|reservation|ele|wikipedia|wikidata|tourism|addr:.+)$/;
const kTags = t => { const o = {}; for (const k of Object.keys(t || {})) if (TAGOK.test(k)) o[k] = t[k]; return o; };
// osmium 'a' kimligi: cift sayi = way (id*2), tek sayi = relation (id*2+1)
const osmRef = id => { const m = /^([nwra])(\d+)$/.exec(id); if (!m) return null; if (m[1] === 'a') { const n = Number(m[2]); return n % 2 === 0 ? { t: 'way', i: String(n / 2) } : { t: 'relation', i: String((n - 1) / 2) }; } return { t: { n: 'node', w: 'way', r: 'relation' }[m[1]], i: m[2] }; };
async function adimOsmId(st) {
  const todo = []; for (const p of st.points) { const d = dd(st, p); if (d._id) continue; if (!osmRef(p.id)) d._id = 1; else todo.push(p); }
  console.log(`  OSM ID: ${todo.length} nokta sorgulanacak`);
  for (let i = 0; i < todo.length; i += 150) {
    const b = todo.slice(i, i + 150), by = { node: [], way: [], relation: [] }; b.forEach(p => { const r = osmRef(p.id); by[r.t].push(r.i); });
    const parts = Object.entries(by).filter(([, a]) => a.length).map(([t, a]) => `${t}(id:${a.join(',')});`).join('');
    const els = await overpass(`[out:json][timeout:120];(${parts});out tags center;`);
    if (els === undefined) { b.forEach(p => hata(st, p, '_id')); continue; }
    const map = new Map(els.flatMap(e => { const k = [[{ node: 'n', way: 'w', relation: 'r' }[e.type] + e.id, e]]; if (e.type === 'way') k.push(['a' + (e.id * 2), e]); if (e.type === 'relation') k.push(['a' + (e.id * 2 + 1), e]); return k; }));
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
    if (!idx[s]) idx[s] = []; idx[s].push({ la, lo, ad, tur: t.tourism || t.natural || t.amenity || t.place || t.shop || t.waterway || null, tags: t, bb });
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
    const lst = []; for (const x of idx[k] || []) { if (!x.ad && !ADSIZOK.has(k)) continue; if (Math.abs(x.la - p.latitude) > r / 100000) continue; const d = mt(p.latitude, p.longitude, x.la, x.lo); if (d <= r) lst.push({ ad: x.ad, tur: x.tur, m: Math.round(d), la: x.la, lo: x.lo }); }
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
        const sy = {}; for (const r of (j && j.results) || []) if (r.species) { const e = sy[r.species] || (sy[r.species] = { n: 0, ad: r.vernacularName || null, k: r.speciesKey || null }); e.n++; }
        o[ad] = Object.entries(sy).sort((x, y) => y[1].n - x[1].n).slice(0, 8).map(([s, e]) => ({ s, k: e.k, en: e.ad }));
      }
      if (bozuk) { hata(st, p, '_gb'); continue; } st.hucre[key] = o;
    }
    d.canli = st.hucre[key]; d._gb = 1; kaydetGerekirse(st);
  }
}

// ================= YENI (v2): yapilandirilmis alanlar, parca parca isleme =================
const SURUM = parseInt(arg('surum', '2'), 10) || 2;
const bugun = () => new Date().toISOString().slice(0, 10);
const gunFarki = t => { const x = Date.parse(t); return isNaN(x) ? Infinity : (Date.now() - x) / 864e5; };
const mf = m => m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : m + ' m';
const CAMPWORD = { TR: 'Kamp Alanı', DE: 'Campingplatz', AT: 'Campingplatz', CH: 'Campingplatz', FR: 'Camping', ES: 'Camping', IT: 'Campeggio', PT: 'Parque de Campismo', NL: 'Camping', PL: 'Pole Namiotowe', RU: 'Кемпинг' };
const KORUMA_UYARI = 'Kural ve yasakları kontrol et.';

// ---------------- ham OSM etiketi -> Turkce ----------------
const ETIKET = JSON.parse(fs.readFileSync(path.join(__dirname, 'etiketler.json'), 'utf8'));
const TUR_TR = ETIKET.tur;
const SINIF_ETIKET = ETIKET.sinif;
const HAM_ETIKET = tok => Object.prototype.hasOwnProperty.call(TUR_TR, tok) || /^[a-z0-9]+(_[a-z0-9]+)+$/.test(tok);
const KRITIK = [['icmesuyu', 'icme_suyu'], ['wc', 'tuvalet_dus'], ['market', 'market'], ['yakit', 'akaryakit'], ['saglik', 'saglik']];
const CEVRE = [['su', 'su_plaj'], ['yerlesim', 'yerlesim'], ['tepe', 'zirve'], ['ilgi', 'gorulecek'], ['isletme', 'yakin_tesis']];
const ADIM_BAYRAK = { osm_id: '_id', osm_cevre: '_cv', site: '_st', adres: '_ad', wiki: '_wk', irtifa: '_el', gbif: '_gb' };
const BAYRAK_ADIM = Object.fromEntries(Object.entries(ADIM_BAYRAK).map(([a, b]) => [b, a]));

// x: {ad, tur, m, la, lo}  ->  {ad, mesafe_m, enlem, boylam} | null
function noktaCevir(x, sinifAd) {
  if (!x || !Number.isFinite(x.m)) return null;
  const tur = x.tur ? String(x.tur) : '';
  const etiket = (tur && Object.prototype.hasOwnProperty.call(TUR_TR, tur) ? TUR_TR[tur] : null) || SINIF_ETIKET[sinifAd] || null;
  const ham = x.ad ? String(x.ad).trim() : '';
  const ad = ham && !HAM_ETIKET(ham) ? ham : etiket;
  if (!ad) return null;
  const o = { ad, mesafe_m: Math.max(0, Math.round(x.m)) };
  if (Number.isFinite(x.la) && Number.isFinite(x.lo)) { o.enlem = +x.la.toFixed(6); o.boylam = +x.lo.toFixed(6); }
  return o;
}

// ---------------- Turkce canli adlari (GBIF vernacularNames, kalici onbellek) ----------------
const TR_ONBELLEK_YOL = (() => { const a = arg('onbellek', ''); return a && a !== true ? a : path.join(CFG.CALISMA, 'turce_adlar.json'); })();
let TR_ON = null; // { speciesKey: { tr: 'ad' | null, t: 'YYYY-MM-DD' } }
function trYukle() {
  if (TR_ON) return TR_ON;
  try { TR_ON = JSON.parse(fs.readFileSync(TR_ONBELLEK_YOL, 'utf8')); } catch (e) { TR_ON = {}; }
  if (!TR_ON || typeof TR_ON !== 'object' || Array.isArray(TR_ON)) TR_ON = {};
  return TR_ON;
}
function trKaydet() {
  if (!TR_ON) return;
  try {
    fs.mkdirSync(path.dirname(TR_ONBELLEK_YOL), { recursive: true });
    const t = TR_ONBELLEK_YOL + '.tmp';
    fs.writeFileSync(t, '{\n' + Object.keys(TR_ON).sort().map(k => JSON.stringify(k) + ':' + JSON.stringify(TR_ON[k])).join(',\n') + '\n}\n'); fs.renameSync(t, TR_ONBELLEK_YOL);
  } catch (e) {}
}
async function adimTurce(st) {
  const on = trYukle(), keys = new Set();
  for (const p of st.points) { const c = dd(st, p).canli; if (!c) continue; for (const g of Object.values(c)) for (const x of g || []) if (x && x.k) keys.add(String(x.k)); }
  const todo = [...keys].filter(k => !on[k] || (on[k].tr === null && gunFarki(on[k].t) > 180));
  console.log(`  Turkce ad: ${todo.length} tur sorgulanacak (onbellekte ${keys.size - todo.length})`);
  let n = 0;
  try {
    for (const k of todo) {
      kontrol();
      const j = await json(`https://api.gbif.org/v1/species/${k}/vernacularNames?limit=200`, {}, { ms: 250 });
      if (j === undefined) continue; // gecici hata: onbellege yazma, sonra tekrar denenir
      const r = ((j && j.results) || []).filter(x => x.language === 'tur' && x.vernacularName);
      on[k] = { tr: r.length ? String(r[0].vernacularName).trim() : null, t: bugun() };
      if (++n % 50 === 0) trKaydet();
    }
  } finally { trKaydet(); }
}

const ADIM_FN = { osm_id: adimOsmId, osm_cevre: adimCevre, site: adimSite, adres: adimAdres, wiki: adimWiki, irtifa: adimIrtifa, gbif: adimGbif, turce: adimTurce };
const TUM_ADIMLAR = ['osm_id', 'osm_cevre', 'site', 'adres', 'wiki', 'irtifa', 'gbif', 'turce'];
// faz: [kayit durumu, calistirilacak adimlar]  (siralama = oncelik)
const FAZLAR = [['yeni', TUM_ADIMLAR], ['tamir', TUM_ADIMLAR], ['yukselt', ['osm_cevre', 'gbif', 'turce']], ['tazele', TUM_ADIMLAR]];

// ---------------- ad / iletisim / ucret alanlari (sadece bos olani doldurur) ----------------
function alanDoldur(st, p) {
  const d = dd(st, p), t = d.tags || {}, cc = st.cc, cv = d.cevre || {}, ad = d.adres || {}, notlar = [];
  p.notes = p.notes || { description: null, note: null }; p.name = p.name || {};
  let uretildi = false;
  const yeniAd = () => t.operator || t.brand || (cv.komsu50 && cv.komsu50.ad) || null;
  if (!adliMi(p)) {
    let a = yeniAd();
    if (!a) { const y = (cv.yerlesim && cv.yerlesim[0] && cv.yerlesim[0].m <= 2000 && cv.yerlesim[0].ad) || ad.koy || ad.ilce; if (y) { a = y + ' ' + (CAMPWORD[cc] || 'Campsite'); uretildi = true; } }
    if (a) { p.name_local = a; const l = cc === 'TR' ? 'tr' : 'en'; p.name[l] = a; notlar.push(uretildi ? 'Ad konumdan türetildi' : 'Ad OSM/yakın işletmeden alındı'); }
  }
  for (const l of ['tr', 'en', 'de', 'ru', 'ar']) if (!p.name[l] && t['name:' + l]) p.name[l] = t['name:' + l];
  const s = d.site || {};
  if (!p.website) { const u = t.website || t['contact:website'] || t.url || (cv.komsu50 && cv.komsu50.site); if (u) p.website = u; }
  if (!p.phone) { const x = t.phone || t['contact:phone'] || t.mobile || (s.tel && s.tel[0]) || (cv.komsu50 && cv.komsu50.tel); if (x) p.phone = x; }
  if (!p.fee) { if (t.fee === 'yes' || t.charge) p.fee = 'yes'; else if (t.fee === 'no') p.fee = 'no'; }
  return notlar;
}

// ---------------- YAPILANDIRMA: d (toplanan ham bilgi) + eski zengin -> yeni zengin ----------------
// Kural: bir bolum yalnizca bagli oldugu adimlar BASARILI bittiyse yenilenir; basarisizsa eski bolum korunur.
function yapilandir(st, p, denenen) {
  const d = dd(st, p), t = d.tags || {}, cv = d.cevre || {}, ad = d.adres || {}, s = d.site || {}, c = d.canli || {};
  const eski = p.zengin && typeof p.zengin === 'object' ? p.zengin : {};
  const ekk = eski.kaynak && typeof eski.kaynak === 'object' ? eski.kaynak : {};
  const S = {}, eksik = [], alanKaynak = Object.assign({}, ekk.alanlar || {});
  const ok = k => d[k] === 1 && !((d._f || {})[k] >= 3);
  const bolum = (adlar, bayraklar, kaynak, fn) => {
    if (bayraklar.every(ok)) { const r = fn(); for (const a of adlar) { S[a] = r[a]; alanKaynak[a] = kaynak; } }
    else for (const b of bayraklar) if (!ok(b) && denenen.has(b) && !eksik.includes(BAYRAK_ADIM[b])) eksik.push(BAYRAK_ADIM[b]);
  };

  bolum(['olanaklar', 'kisitlar', 'kapasite', 'calisma_saati', 'sebeke'], ['_id', '_st'], 'osm+site', () => {
    const ol = [], yasak = [];
    const yn = (k, a) => { if (t[k] === 'yes' || (k === 'internet_access' && /^(wlan|wifi|yes)$/.test(t[k]))) ol.push(a); };
    yn('shower', 'Duş'); yn('toilets', 'Tuvalet'); yn('power_supply', 'Elektrik'); yn('internet_access', 'Wi-Fi'); yn('drinking_water', 'İçme suyu'); yn('swimming_pool', 'Havuz');
    yn('bbq', 'Mangal'); yn('picnic_table', 'Piknik masası'); yn('sanitary_dump_station', 'Atık su boşaltımı'); yn('laundry', 'Çamaşırhane'); yn('tents', 'Çadır alanı'); yn('caravans', 'Karavan alanı');
    for (const x of s.olanak || []) if (!ol.some(o => o.toLowerCase() === String(x).toLowerCase())) ol.push(x);
    if (t.dog === 'yes') ol.push('Evcil hayvan izinli'); else if (t.dog === 'no') yasak.push('Evcil hayvan yasak');
    if (t.openfire === 'yes') ol.push('Ateş yakılabilir'); else if (t.openfire === 'no') yasak.push('Ateş yakmak yasak');
    if (t.backcountry === 'yes') ol.push('Vahşi kamp');
    const saat = t.opening_hours ? String(t.opening_hours) : null;
    const wifi = ol.some(o => /wi-?fi/i.test(o)) ? true : (t.internet_access === 'no' ? false : null);
    return { olanaklar: ol, kisitlar: yasak, kapasite: t.capacity ? String(t.capacity) : null, calisma_saati: saat, sebeke: { wifi, yirmidort_yedi: saat ? saat.trim() === '24/7' : null } };
  });

  bolum(['ucret'], ['_id', '_st'], 'osm+site', () => {
    const ay = (s.fiyat || []).slice(0, 3).map(String);
    const durum = p.fee === 'yes' ? 'ucretli' : p.fee === 'no' ? 'ucretsiz' : null;
    if (!durum && p.fee) ay.unshift(String(p.fee));
    return { ucret: { durum, ayrinti: ay } };
  });

  bolum(['kritik_noktalar', 'cevre', 'koruma_alani'], ['_cv'], 'osm', () => {
    const kr = [], cvr = {};
    for (const [sn, tur] of KRITIK) for (const x of cv[sn] || []) { const n = noktaCevir(x, sn); if (!n) continue; const o = { tur, ...n }; if (sn === 'wc') o.alt = x.tur === 'shower' ? 'dus' : 'tuvalet'; kr.push(o); }
    for (const [sn, anahtar] of CEVRE) { const lst = (cv[sn] || []).filter(x => sn !== 'isletme' || x.m > 50).map(x => noktaCevir(x, sn)).filter(Boolean); if (lst.length) cvr[anahtar] = lst; }
    const koru = (cv.koru || []).filter(Boolean);
    return { kritik_noktalar: kr, cevre: cvr, koruma_alani: koru.length ? { ad: koru.join(', '), uyari: KORUMA_UYARI, yaklasik: true } : null };
  });

  const on = trYukle(); let turceEksik = false;
  bolum(['doga'], ['_gb'], 'gbif', () => {
    const g = (arr, n) => (arr || []).slice(0, n).map(x => {
      if (typeof x === 'string') return { bilimsel: x, tr: null, en: null };
      const k = x.k ? String(x.k) : null; if (k && !on[k]) turceEksik = true;
      return { bilimsel: x.s, tr: (k && on[k] && on[k].tr) || null, en: x.en || null };
    });
    const o = { kuslar: g(c.kus, 5), memeliler: g(c.memeli, 4), surungenler: g(c.surungen, 3), bitkiler: g(c.bitki, 5) };
    for (const k of Object.keys(o)) if (!o[k].length) delete o[k];
    return { doga: o };
  });
  if (turceEksik && denenen.has('turce') && !eksik.includes('turce')) eksik.push('turce');

  bolum(['hakkinda'], ['_wk'], 'wikipedia', () => {
    const w = d.wiki && d.wiki[0], lang = DIL[st.cc] || 'en';
    return { hakkinda: w && w.ozet ? { baslik: w.baslik, mesafe_m: w.m, metin: String(w.ozet).slice(0, 300), kaynak: 'Wikipedia', url: 'https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(String(w.baslik).replace(/ /g, '_')) } : null };
  });
  bolum(['iletisim'], ['_st'], 'site', () => ({ iletisim: { sosyal: [...new Set([...(d.sosyal || []), ...(s.sosyal || [])])], eposta: s.mail || [] } }));
  bolum(['osm_notu'], ['_id'], 'osm', () => ({ osm_notu: t['description:tr'] || t.description || null }));

  // konum: adres ve irtifa ayri adimlardan gelir
  const konum = Object.assign({ adres: null, il: null, ilce: null, koy: null, ulke: null, irtifa_m: null }, eski.konum || {});
  if (ok('_ad')) {
    const yer = [ad.koy, ad.ilce, ad.il, ad.ulke].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    if (yer.length) { konum.adres = yer.join(', '); konum.il = ad.il || null; konum.ilce = ad.ilce || null; konum.koy = ad.koy || null; konum.ulke = ad.ulke || null; alanKaynak.konum = 'nominatim'; }
  } else if (denenen.has('_ad')) eksik.push('adres');
  if (ok('_el')) { if (d.irtifa != null && Number.isFinite(d.irtifa)) konum.irtifa_m = Math.round(d.irtifa); }
  else if (denenen.has('_el')) eksik.push('irtifa');

  const pick = (a, v) => (a in S ? S[a] : (eski[a] !== undefined ? eski[a] : v));
  const deneme = Object.assign({}, ekk.deneme || {});
  for (const e of eksik) deneme[e] = (deneme[e] || 0) + 1;
  for (const k of Object.keys(deneme)) if (!eksik.includes(k)) delete deneme[k];
  const kaynaklar = new Set(ekk.kaynaklar || []);
  if (ok('_id') || ok('_cv')) kaynaklar.add('OSM'); if (d.site) kaynaklar.add('site'); if (d.wiki && d.wiki.length) kaynaklar.add('Wikipedia');
  if (ok('_gb')) kaynaklar.add('GBIF'); if (d.irtifa != null) kaynaklar.add('Open-Meteo'); if (ok('_ad')) kaynaklar.add('Nominatim');

  return {
    surum: SURUM, tarih: bugun(), konum,
    olanaklar: pick('olanaklar', []), kisitlar: pick('kisitlar', []), kapasite: pick('kapasite', null), calisma_saati: pick('calisma_saati', null),
    sebeke: pick('sebeke', { wifi: null, yirmidort_yedi: null }), ucret: pick('ucret', { durum: null, ayrinti: [] }),
    kritik_noktalar: pick('kritik_noktalar', []), cevre: pick('cevre', {}), doga: pick('doga', {}), koruma_alani: pick('koruma_alani', null),
    hakkinda: pick('hakkinda', null), iletisim: pick('iletisim', { sosyal: [], eposta: [] }), osm_notu: pick('osm_notu', null),
    ek_notlar: Array.isArray(eski.ek_notlar) ? eski.ek_notlar : [],
    kaynak: { tarih: bugun(), kaynaklar: [...kaynaklar], dogrulandi: !!ekk.dogrulandi, eksik_adimlar: eksik, deneme, alanlar: alanKaynak },
  };
}

// ---------------- eski uygulamalar icin duz metin (yapidan uretilir, bos satir yazmaz) ----------------
const LEGACY_RE = /^(KONUM:|OLANAKLAR:|ÜCRET:|YAKIN ÇEVRE:|DOĞA)/;
function duzMetin(z) {
  const L = [], k = z.konum || {};
  const yer = k.adres || [k.koy, k.ilce, k.il, k.ulke].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  if (yer || k.irtifa_m != null) L.push('KONUM: ' + yer + (k.irtifa_m != null ? (yer ? '. ' : '') + 'İrtifa: ' + k.irtifa_m + ' m' : '') + '.');
  const ol = [...(z.olanaklar || []), ...(z.kisitlar || []).map(x => x.toLowerCase()), z.kapasite ? 'kapasite ' + z.kapasite : null, z.calisma_saati ? 'saat: ' + z.calisma_saati : null].filter(Boolean);
  if (ol.length) L.push('OLANAKLAR: ' + ol.join(', ') + '.');
  const u = z.ucret || {}, ub = [];
  if (u.durum === 'ucretli') ub.push('Ücretli'); else if (u.durum === 'ucretsiz') ub.push('Ücretsiz');
  if (u.ayrinti && u.ayrinti.length) ub.push('sitede geçen fiyat ifadeleri: ' + u.ayrinti.join(' | '));
  if (ub.length) L.push('ÜCRET: ' + ub.join('; ') + '.');
  const lst = a => (a || []).map(x => x.ad + ' (' + mf(x.mesafe_m) + ')').join(', ');
  const kr = tur => (z.kritik_noktalar || []).filter(x => x.tur === tur), cv = z.cevre || {};
  const y = [];
  const ekle = (etiket, arr) => { if (arr && arr.length) y.push(etiket + ': ' + lst(arr)); };
  ekle('Su/plaj', cv.su_plaj); ekle('İçme suyu', kr('icme_suyu')); ekle('Tuvalet/duş noktası', kr('tuvalet_dus')); ekle('Market', kr('market')); ekle('Akaryakıt', kr('akaryakit')); ekle('Sağlık', kr('saglik'));
  ekle('Yerleşim', cv.yerlesim); ekle('Zirve', cv.zirve); ekle('Görülecek', cv.gorulecek); ekle('Yakın tesis', cv.yakin_tesis);
  if (y.length) L.push('YAKIN ÇEVRE: ' + y.join('. ') + '.');
  if (z.koruma_alani && z.koruma_alani.ad) L.push('KORUMA ALANI (yaklaşık): ' + z.koruma_alani.ad + '. ' + (z.koruma_alani.uyari || KORUMA_UYARI));
  const dg = z.doga || {}, ad = x => x.bilimsel + (x.tr ? ' (' + x.tr + ')' : x.en ? ' (' + x.en + ')' : '');
  const dn = []; for (const [a, e] of [['kuslar', 'Kuşlar'], ['memeliler', 'Memeliler'], ['surungenler', 'Sürüngenler'], ['bitkiler', 'Bitkiler']]) if (dg[a] && dg[a].length) dn.push(e + ': ' + dg[a].map(ad).join(', '));
  if (dn.length) L.push('DOĞA (çevredeki gözlem kayıtları, bilimsel ad): ' + dn.join('. ') + '.');
  const h = z.hakkinda; if (h && h.metin) L.push('ÇEVRE BİLGİSİ (Wikipedia, ' + h.baslik + ', ' + mf(h.mesafe_m) + '): ' + h.metin);
  for (const n of z.ek_notlar || []) if (n && String(n).trim()) L.push(String(n).trim());
  return L.join('\n').slice(0, 2000);
}

// ---------------- dosya islemleri (atomik) ----------------
function dosyaOku(f) { const b = fs.readFileSync(f); return JSON.parse((f.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^\uFEFF/, '')); }
function dosyaYaz(f, o) {
  const s = JSON.stringify(o), t = f + '.tmp';
  fs.writeFileSync(t, f.endsWith('.gz') ? zlib.gzipSync(s) : s); fs.renameSync(t, f);
}
const HUCRE_OMUR_GUN = 30;  // Wikipedia/GBIF/Nominatim hucre onbellegi bu kadar gunden eskiyse atilir (veri tazelensin)
function hucreYukle(cc) {
  try { const x = JSON.parse(zlib.gunzipSync(fs.readFileSync(hucreYol(cc)))); if (x && x.h && typeof x.h === 'object' && !Array.isArray(x.h) && gunFarki(x.t) <= HUCRE_OMUR_GUN) return { h: x.h, t: x.t }; } catch (e) {}
  return { h: {}, t: bugun() };
}
const karoSirala = (a, b) => (Math.floor(a.latitude / 0.1) - Math.floor(b.latitude / 0.1)) || (Math.floor(a.longitude / 0.1) - Math.floor(b.longitude / 0.1)) || (a.latitude - b.latitude) || (a.longitude - b.longitude);

// Bir parcayi (kayit listesi) tum adimlardan gecirip kayitlara yazar. Hata olan kayit _bekle isaretiyle kalir.
async function islemParca(st, pts, adimlar) {
  st.points = pts; st.det = {};
  const denenen = new Set();
  for (const a of adimlar) { denenen.add(ADIM_BAYRAK[a] || a); await ADIM_FN[a](st); }
  const tamAdim = adimlar.length === TUM_ADIMLAR.length;
  let yazilan = 0;
  for (const p of pts) {
    try {
      p.notes = p.notes && typeof p.notes === 'object' ? p.notes : { description: null, note: null };
      const notlar = adimlar.includes('osm_id') ? alanDoldur(st, p) : [];
      const z = yapilandir(st, p, denenen);
      p.zengin = z;
      const m = duzMetin(z), eskiAc = p.notes.description;
      if (m && (!eskiAc || LEGACY_RE.test(eskiAc))) p.notes.description = m;
      if (tamAdim) {
        const en = p.notes.note;
        if (!en || /^Otomatik derleme/.test(en)) p.notes.note = ('Otomatik derleme (' + bugun() + '): ' + z.kaynak.kaynaklar.join(', ') + '. ' + notlar.join('. ') + (notlar.length ? '. ' : '') + 'Doğrulanmalı.').replace(/\s+/g, ' ');
      }
      delete p._bekle; yazilan++;
    } catch (e) { console.error('  kayit hatasi', p.id, e && e.message); }
  }
  return yazilan;
}

async function calistir() {
  const f = arg('dosya', null);
  if (!f || f === true) { console.error('Kullanim: node tools/zenginlestir.js --dosya ham/TR.json [--cc TR] [--max-dakika 300] [--parca 150]'); process.exit(2); }
  const cc = String(arg('cc', path.basename(f).split('.')[0])).toUpperCase();
  const tum = dosyaOku(f);
  if (!Array.isArray(tum)) throw new Error('dosya bir liste degil: ' + f);
  const hc = hucreYukle(cc), st = CUR = { cc, det: {}, hucre: hc.h, hucreT: hc.t, log: [], points: [] };
  const gecerli = tum.filter(p => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
  const gecersiz = tum.filter(p => !(p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)));
  const { points: temiz, log } = tekrarTemizle(gecerli);
  const points = temiz.concat(gecersiz);
  console.log(`${cc}: ${tum.length} kayit, tekrar temizligi sonrasi ${points.length} (birlestirilen ${log.length}, gecersiz koordinat ${gecersiz.length})`);
  if (log.length) dosyaYaz(f, points);
  const PARCA = parseInt(arg('parca', 150), 10) || 150;
  let islenen = 0, durdu = false;
  try {
    for (const [faz, adimlar] of FAZLAR) {
      const bekle = points.filter(p => p._bekle === faz).sort(karoSirala);
      if (!bekle.length) continue;
      console.log(`${cc} - faz '${faz}': ${bekle.length} kayit, adimlar: ${adimlar.join(',')}`);
      for (let i = 0; i < bekle.length; i += PARCA) {
        kontrol();
        const grup = bekle.slice(i, i + PARCA);
        islenen += await islemParca(st, grup, adimlar);
        dosyaYaz(f, points); durumKaydet(st); trKaydet();
        console.log(`${cc} - faz '${faz}': ${Math.min(i + PARCA, bekle.length)}/${bekle.length} yazildi`);
      }
    }
  } catch (e) {
    if (e instanceof Stop) { durdu = true; console.log('Sure doldu; tamamlanan parcalar dosyaya yazildi.'); } else throw e;
  } finally { try { durumKaydet(st); trKaydet(); } catch (e) {} }
  const kalan = points.filter(p => p._bekle).length;
  console.log('SONUC ' + JSON.stringify({ cc, islenen, kalan, durdu, birlestirilen: log.length }));
}

module.exports = { TUR_TR, tekrarTemizle, yapilandir, duzMetin, noktaCevir, alanDoldur, islemParca, calistir, NET, dd, trYukle, indeksle, cevreHesapla, siteParse, adliMi, genel, CFG, TR_ON_YOL: TR_ONBELLEK_YOL };
if (require.main === module) calistir().catch(e => { console.error(e); process.exit(1); });
