#!/usr/bin/env node
'use strict';
/*
 * Trailo PRO - Dunya kamp alani tarama araci (v3, hata toleransli)
 *
 * Ne yapar: ulke ulke OpenStreetMap'ten (Overpass) camp_site/caravan_site kayitlarini ceker, ham satirlari
 * tools/dunya_birlestir.py'a verir. O da data/<ULKE>.json ile GUVENLE birlestirir (ayni id guncellenir, zenginlestirme ve
 * kullanici bilgisi korunur), 100 m kuralini uygular, zenginlestirme motorunu calistirir, kontrol eder, atomik yazar.
 *
 * Sahiplik (cakisma olmasin diye): Geofabrik ulkelerini (state/osm_md5.json) ve elle/baska yoldan gelen mevcut dosyalari
 * dongu.py yonetir; bu arac yalnizca henuz olmayan ya da kendi urettigi ulkelere dokunur. --zorla ile hepsi.
 *
 * Kullanim:
 *   node tools/dunya-tara.js --mod pilot                 (LU, pilot/ klasorune; data/ degismez)
 *   node tools/dunya-tara.js --mod tam --commit          (dunya, data/ klasorune)
 *   Secenekler: --ulkeler AD,AL  --sure 300 (dk)  --ulke-dk 45  --yenile-gun 30  --zenginlestir 1|0  --zorla  --bekle 2500
 * Hata olursa ASLA cokmez (cikis kodu 0); sorunlar loga yazilir, ilgili ulke sonra yeniden denenir.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const KOK = path.resolve(__dirname, '..');
const UA = 'TrailoPRO-harvester/3.0 (https://github.com/ziyaarslanturk/trailopro)';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const ILKELER = ['AD','AE','AF','AG','AI','AL','AM','AO','AR','AS','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ','TC','TD','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VG','VI','VN','VU','WF','WS','YE','YT','ZA','ZM','ZW'];
// ABD: mevcut dosya duzenine gore bolgeler (US_PACIFIC = AK + HI)
const US_BOLGE = {
  US_NORTHEAST: ['ME','NH','VT','MA','RI','CT','NY','NJ','PA'],
  US_MIDWEST: ['OH','IN','IL','MI','WI','MN','IA','MO','ND','SD','NE','KS'],
  US_SOUTH: ['DE','MD','DC','VA','WV','NC','SC','GA','FL','KY','TN','AL','MS','AR','LA','OK','TX'],
  US_WEST: ['MT','ID','WY','NV','UT','CO','AZ','NM','WA','OR','CA'],
  US_PACIFIC: ['AK','HI'],
};
const DIL = ['tr', 'en', 'de', 'ru', 'ar'];

// Test kancasi (sadece testlerde): sahte fetch ve bekleme yok
let FETCH = (...a) => globalThis.fetch(...a);
if (process.env.TRAILO_SAHTE_FETCH) require(path.resolve(process.env.TRAILO_SAHTE_FETCH))((f) => { FETCH = f; });
const HIZLI = !!process.env.TRAILO_HIZLI;
const sleep = (ms) => new Promise((r) => setTimeout(r, HIZLI ? 1 : ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------- Ayarlar ---------- */
function argumanlar(argv) {
  const o = { mod: 'pilot', ulkeler: null, sure: 300, ulkeDk: 45, yenileGun: 30, commit: false, kok: KOK, bekle: 2500, zengin: true, zorla: false, istekDk: 20, ardisikSinir: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--mod') o.mod = v();
    else if (a === '--ulkeler') o.ulkeler = String(v() || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--sure') o.sure = Number(v());
    else if (a === '--ulke-dk') o.ulkeDk = Number(v());
    else if (a === '--yenile-gun') o.yenileGun = Number(v());
    else if (a === '--zenginlestir') o.zengin = !['0', 'false'].includes(String(v()));
    else if (a === '--commit') o.commit = true;
    else if (a === '--zorla') o.zorla = true;
    else if (a === '--kok') o.kok = path.resolve(v());
    else if (a === '--bekle') o.bekle = Number(v());
    else if (a === '--istek-dk') o.istekDk = Number(v());
  }
  // gecersiz sayilar varsayilana dussun
  for (const [k, d] of [['sure', 300], ['ulkeDk', 45], ['yenileGun', 30], ['bekle', 2500], ['istekDk', 20]]) if (!Number.isFinite(o[k]) || o[k] < 0) o[k] = d;
  if (o.mod !== 'pilot' && o.mod !== 'tam') { log('Bilinmeyen mod, pilot kullaniliyor:', o.mod); o.mod = 'pilot'; }
  return o;
}

/* ---------- Genel yardimcilar ---------- */
const KONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const temiz = (v, n = 500) => {
  if (v === undefined || v === null || typeof v === 'object') return null;
  const s = String(v).replace(KONTROL, '').trim();
  return s ? s.slice(0, n) : null;
};
const gecerliKoordinat = (la, lo) => Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);
function atomikYaz(yol, metin) {
  fs.mkdirSync(path.dirname(yol), { recursive: true });
  const t = yol + '.tmp';
  fs.writeFileSync(t, metin);
  fs.renameSync(t, yol);
}
function jsonOku(yol, varsayilan, yedekle) {
  try {
    return JSON.parse(fs.readFileSync(yol, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    if (yedekle && fs.existsSync(yol)) {
      try { fs.copyFileSync(yol, yol + '.bozuk-' + Date.now()); log('UYARI:', path.basename(yol), 'okunamadi, yedeklendi; bos baslaniyor'); } catch (_) { /* yoksay */ }
    }
    return varsayilan;
  }
}

/* ---------- Kategori kurallari: osm_cek.build_categories ile BIREBIR AYNI (projedeki gercek tablo) ---------- */
const yes = (v) => ['yes', 'designated', 'permissive', 'true'].includes(v);
function kategoriHesapla(t) {
  const c = [], g = (k) => (t[k] === undefined ? '' : t[k]);
  if (t.tents !== 'no' && (t.tourism === 'camp_site' || yes(g('tents')))) c.push(1);
  if (t.tourism === 'caravan_site' || yes(g('caravans')) || yes(g('motorhome'))) c.push(2);
  if (yes(g('drinking_water'))) c.push(3);
  if (yes(g('power_supply'))) c.push(4);
  if (yes(g('openfire')) || yes(g('campfire')) || yes(g('fireplace'))) c.push(5);
  if (yes(g('toilets'))) c.push(6);
  if (yes(g('shower'))) c.push(7);
  if (yes(g('shop')) || yes(g('restaurant')) || yes(g('food'))) c.push(8);
  if (['wlan', 'yes', 'wifi'].includes(t.internet_access)) c.push(10);
  if (yes(g('parking')) || t['capacity:parking']) c.push(11);
  if (yes(g('dog')) || yes(g('pets'))) c.push(12);
  if (yes(g('fishing'))) c.push(15);
  if (yes(g('supervised')) || yes(g('security'))) c.push(16);
  if (yes(g('beach')) || t.natural === 'beach') c.push(17);
  if (yes(g('bbq')) || yes(g('barbecue'))) c.push(18);
  if (yes(g('playground'))) c.push(19);
  if (yes(g('firewood'))) c.push(20);
  if (yes(g('horse')) || yes(g('riding'))) c.push(22);
  if (yes(g('4wd_only'))) c.push(23);
  if (yes(g('swimming')) || yes(g('swimming_pool'))) c.push(24);
  return c;
}

/* ---------- OSM ogesi -> proje kaydi (osm_cek ile ayni alanlar ve kimlik semasi) ---------- */
// Kimlik: node n<id>; way a<2*id>; relation a<2*id+1>  (osmium 'type_id' alan kimligiyle ayni, motor bunu cozer)
function kayitOlustur(el, ulkeKodu) {
  if (!el || typeof el !== 'object' || !el.tags || typeof el.tags !== 'object') return null;
  const t = el.tags;
  if (t.tourism !== 'camp_site' && t.tourism !== 'caravan_site') return null;
  const lat = el.lat !== undefined ? el.lat : el.center && el.center.lat;
  const lon = el.lon !== undefined ? el.lon : el.center && el.center.lon;
  if (!gecerliKoordinat(lat, lon) || !Number.isInteger(el.id)) return null;
  let id;
  if (el.type === 'node') id = 'n' + el.id;
  else if (el.type === 'way') id = 'a' + el.id * 2;
  else if (el.type === 'relation') id = 'a' + (el.id * 2 + 1);
  else return null;
  const ad = {};
  for (const d of DIL) ad[d] = temiz(t['name:' + d]) || (d === 'en' && !t['name:en'] ? temiz(t.name) : null);
  return {
    id, country_code: ulkeKodu,
    latitude: Math.round(lat * 1e6) / 1e6, longitude: Math.round(lon * 1e6) / 1e6,
    name: ad, name_local: temiz(t.name),
    fee: temiz(t.fee, 100), website: temiz(t.website || t['contact:website'], 300), phone: temiz(t.phone || t['contact:phone'], 60),
    notes: { description: temiz(t.description, 2000), note: temiz(t.note, 500) },
    category_ids: kategoriHesapla(t),
  };
}
function hamKayitlar(ogeler, ulkeKodu) {
  const goruldu = new Set(), out = [];
  for (const e of ogeler) {
    const r = kayitOlustur(e, ulkeKodu);
    if (!r || goruldu.has(r.id)) continue;
    goruldu.add(r.id); out.push(r);
  }
  return out;
}

/* ---------- Ag: Overpass (zaman asimli, kismi/bozuk yanit = hata) ---------- */
const BAGLAM = (ayar) => {
  const bitis = Date.now() + ayar.sure * 60000;
  return { ...ayar, bitis, bitti: () => Date.now() > bitis, kalanMs: () => bitis - Date.now(), sonIstek: 0, ardisikHata: 0 };
};
async function overpass(sorgu, ctx, deneme = 6) {
  let sonHata = null;
  for (let i = 0; i < deneme; i++) {
    if (ctx.bitti()) throw new Error('sure doldu');
    const gecen = Date.now() - ctx.sonIstek;
    if (gecen < ctx.bekle) await sleep(ctx.bekle - gecen);
    ctx.sonIstek = Date.now();
    try {
      const res = await FETCH(OVERPASS[i % OVERPASS.length], {
        method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(sorgu), signal: AbortSignal.timeout(Math.max(1, ctx.istekDk) * 60000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const metin = await res.text();
      let j;
      try { j = JSON.parse(metin); } catch (e) { throw new Error('gecersiz JSON (kesik ya da hata sayfasi)'); }
      if (!j || !Array.isArray(j.elements)) throw new Error('yanitta elements yok');
      // 200 donse bile "bellek/zaman" uyarisi varsa sonuc EKSIK olabilir: kismi veriyi asla kullanma
      if (j.remark && /runtime error|timed out|out of memory|too many|rate_limit|dispatcher/i.test(j.remark)) throw new Error('remark: ' + j.remark);
      return j.elements;
    } catch (e) {
      sonHata = e;
      if (i < deneme - 1) {
        const bekleme = Math.min(120000, 5000 * 2 ** i) * (0.75 + Math.random() * 0.5);
        log('Overpass hata:', e.message, '- bekleniyor', Math.round(bekleme / 1000), 'sn');
        await sleep(Math.min(bekleme, Math.max(0, ctx.kalanMs() - 1000)));
      }
    }
  }
  throw new Error('Overpass sorgusu basarisiz: ' + (sonHata && sonHata.message));
}

const KAYNAK = ['nwr["tourism"="camp_site"]', 'nwr["tourism"="caravan_site"]'];
const alanSorgusu = (filtre) => '[out:json][timeout:900][maxsize:2147483648];' + filtre + '->.a;(' + KAYNAK.map((k) => k + '(area.a);').join('') + ');out center tags;';
const bolgeFiltre = (iso) => 'area["ISO3166-1"="' + iso + '"]["boundary"="administrative"]';
const altFiltre = (iso2) => 'area["ISO3166-2"="' + iso2 + '"]["boundary"="administrative"]';

async function ulkeCek(b, ctx) {
  if (b.iso2) { // birden cok alt bolge: hepsi basarili olmali (kismi sonuc = eksik veri)
    let o = [];
    for (const k of b.iso2) o = o.concat(await overpass(alanSorgusu(altFiltre(k)), ctx));
    return o;
  }
  try {
    return await overpass(alanSorgusu(bolgeFiltre(b.iso1)), ctx, 3);
  } catch (e) {
    if (ctx.bitti()) throw e;
    log(b.dosya, 'tek parca sorgu olmadi, alt bolgelere ayriliyor');
    const alt = await overpass('[out:json][timeout:300];' + bolgeFiltre(b.iso1) + '->.c;rel(area.c)["boundary"="administrative"]["admin_level"="4"]["ISO3166-2"];out tags;', ctx);
    const kodlar = [...new Set(alt.map((x) => x.tags && x.tags['ISO3166-2']).filter(Boolean))];
    if (!kodlar.length) throw e;
    let o = [];
    for (const k of kodlar) o = o.concat(await overpass(alanSorgusu(altFiltre(k)), ctx));
    return o;
  }
}

/* ---------- Birimler / sahiplik ---------- */
function birimler() {
  const liste = [];
  for (const kod of ILKELER) {
    if (kod === 'US') { for (const b of Object.keys(US_BOLGE)) liste.push({ dosya: b, kod: b, iso2: US_BOLGE[b].map((s) => 'US-' + s) }); }
    else liste.push({ dosya: kod, kod, iso1: kod });
  }
  return liste;
}
function geofabrikKodlari(kok) {
  const m = jsonOku(path.join(kok, 'state', 'osm_md5.json'), {});
  return new Set(m && typeof m === 'object' ? Object.keys(m) : []);
}
function adayMi(b, durum, sahipli, veriKlasoru, ctx) {
  if (ctx.zorla || ctx.mod === 'pilot') return true;
  if (sahipli.has(b.kod)) return false;                                                   // Geofabrik ulkeleri: dongu.py
  if (fs.existsSync(path.join(veriKlasoru, b.dosya + '.json')) && !durum[b.kod]) return false; // baska yoldan gelen dosya: dongu.py
  return true;
}

/* ---------- Python birlestirici ---------- */
function pythonBirlestir(cc, girdi, butceDk, veriKlasoru, ctx) {
  const args = [path.join(KOK, 'tools', 'dunya_birlestir.py'), '--ulke', cc, '--veri-klasoru', veriKlasoru, '--butce-dk', String(Math.max(1, Math.floor(butceDk))), '--zenginlestir', ctx.zengin ? '1' : '0'];
  if (girdi) args.push('--girdi', girdi);
  const r = spawnSync(process.env.PYTHON || 'python3', args, { cwd: ctx.kok, encoding: 'utf8', maxBuffer: 1 << 28, timeout: (Math.max(1, butceDk) + 20) * 60000, env: process.env });
  if (r.stdout) process.stdout.write(r.stdout.split('\n').filter((s) => s.trim()).slice(-60).join('\n') + '\n');
  if (r.stderr) process.stderr.write(r.stderr.split('\n').slice(-20).join('\n') + '\n');
  const satir = (r.stdout || '').split('\n').reverse().find((s) => s.startsWith('SONUC '));
  if (r.error || !satir) return { durum: 'atlandi', neden: r.error ? 'python_baslatilamadi: ' + r.error.message : 'sonuc_yok' };
  try { return JSON.parse(satir.slice(6)); } catch (e) { return { durum: 'atlandi', neden: 'sonuc_okunamadi' }; }
}

function gitGonder(cc, ctx) {
  if (!ctx.commit) return;
  try { spawnSync('bash', [path.join(KOK, 'tools', 'git_gonder.sh'), cc], { cwd: ctx.kok, stdio: 'inherit', timeout: 20 * 60000 }); }
  catch (e) { log('git hatasi:', e.message); }
}

/* ---------- Ana akis ---------- */
async function calistir(ayar) {
  const ctx = BAGLAM(ayar);
  const pilot = ctx.mod === 'pilot';
  if (pilot && !ctx.ulkeler) ctx.ulkeler = ['LU'];
  const veriKlasoru = path.join(ctx.kok, pilot ? 'pilot' : 'data');
  const durumYol = path.join(ctx.kok, 'tools', pilot ? 'durum-pilot.json' : 'durum.json');
  const hamKlasor = path.join(ctx.kok, 'work', 'tara');
  fs.mkdirSync(veriKlasoru, { recursive: true });
  fs.mkdirSync(hamKlasor, { recursive: true });
  let durum = jsonOku(durumYol, {}, true);
  if (!durum || typeof durum !== 'object' || Array.isArray(durum)) durum = {};
  const durumYaz = () => atomikYaz(durumYol, JSON.stringify(durum, null, 1));
  const eskidi = (iso) => !iso || !(Date.now() - Date.parse(iso) < ctx.yenileGun * 86400000);
  const sahipli = geofabrikKodlari(ctx.kok);

  let liste = birimler();
  if (ctx.ulkeler) {
    const bilinen = new Set(liste.map((b) => b.kod));
    for (const k of ctx.ulkeler) if (!bilinen.has(k) && !(k === 'US')) log('Bilinmeyen ulke kodu yoksayildi:', k);
    liste = liste.filter((b) => ctx.ulkeler.includes(b.kod) || (b.kod.startsWith('US_') && ctx.ulkeler.includes('US')));
  }
  const sirali = liste.filter((b) => adayMi(b, durum, sahipli, veriKlasoru, ctx))
    .sort((a, b) => (Date.parse((durum[a.kod] || {}).harita || 0) || 0) - (Date.parse((durum[b.kod] || {}).harita || 0) || 0));
  log('Mod:', ctx.mod, '| aday ulke:', sirali.length, '| sure:', ctx.sure, 'dk');

  for (const b of sirali) {
    if (ctx.kalanMs() < 15 * 60000) { log('Sure azaldi, cikiliyor; sonraki calisma kaldigi yerden devam eder.'); break; }
    if (ctx.ardisikHata >= ctx.ardisikSinir) { log('Art arda', ctx.ardisikHata, 'ulkede Overpass hatasi: sunucu ulasilamiyor olabilir, bu calisma bitiriliyor.'); break; }
    const d = durum[b.kod] || {};
    if (d.tamam && !eskidi(d.harita)) continue;
    if (d.sonraki && Date.parse(d.sonraki) > Date.now()) continue; // hata sonrasi bekleme suresi
    try {
      let girdi = null, osmSayisi = d.osm;
      const taramaTaze = !eskidi(d.harita);
      if (!taramaTaze) {
        log('>>', b.kod, 'taraniyor');
        const ogeler = await ulkeCek(b, ctx);
        const ham = hamKayitlar(ogeler, b.kod);
        osmSayisi = ham.length;
        log(b.kod, 'OSM ogesi:', ogeler.length, '| gecerli kayit:', ham.length);
        girdi = path.join(hamKlasor, b.kod + '.raw.json');
        atomikYaz(girdi, JSON.stringify(ham));
      }
      ctx.ardisikHata = 0;
      const butce = Math.min(ctx.ulkeDk, ctx.kalanMs() / 60000 - 12);
      const s = pythonBirlestir(b.dosya, girdi, butce, pilot ? 'pilot' : 'data', ctx);
      try { if (girdi) fs.unlinkSync(girdi); } catch (_) { /* yoksay */ }
      if (s.durum === 'tamam' || s.durum === 'bos') {
        const simdi = new Date().toISOString();
        durum[b.kod] = { ...d, harita: girdi ? simdi : d.harita, osm: osmSayisi, sayi: s.kayit || 0, kalan: s.kalan || 0, tamam: (s.kalan || 0) === 0 ? simdi : null, hata: null, sonraki: null };
        durumYaz();
        log(b.kod, 'durum:', s.durum, '| kayit:', s.kayit, '| motorda kalan:', s.kalan || 0);
        gitGonder(b.kod, ctx);
        durum = jsonOku(durumYol, durum, true) || durum; // git cakismasinda dosyalar geri sarilmis olabilir: diskteki gercegi al
      } else {
        throw new Error('birlestirici atladi: ' + s.neden);
      }
    } catch (e) {
      const n = ((d.hata && d.hata.n) || 0) + 1;
      const bekleDk = Math.min(24 * 60, 30 * 2 ** (n - 1));
      durum[b.kod] = { ...d, hata: { n, son: new Date().toISOString(), mesaj: String(e.message).slice(0, 200) }, sonraki: new Date(Date.now() + bekleDk * 60000).toISOString() };
      durumYaz();
      if (/Overpass/.test(e.message)) ctx.ardisikHata++;
      log('!!', b.kod, 'hata:', e.message, '| sonraki deneme', bekleDk, 'dk sonra');
    }
  }
}

if (require.main === module) {
  calistir(argumanlar(process.argv.slice(2))).catch((e) => { console.error('Beklenmeyen hata (veri degismedi):', e); }).finally(() => process.exit(0));
}
module.exports = { argumanlar, kategoriHesapla, kayitOlustur, hamKayitlar, overpass, ulkeCek, adayMi, birimler, calistir, ILKELER, US_BOLGE, BAGLAM };
