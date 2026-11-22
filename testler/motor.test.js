// Calistirma:  node --test testler/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

const MOTOR = path.resolve(__dirname, '../tools/zenginlestir.js');
const SAHTE = path.resolve(__dirname, 'sahte_ag.js');

const kayit = (id, lat, lon, ek = {}) => ({
  id, country_code: 'TR', latitude: lat, longitude: lon,
  name: { tr: null, en: null, de: null, ru: null, ar: null }, name_local: null, fee: null, website: null, phone: null,
  notes: { description: null, note: null }, category_ids: [1], ...ek,
});
const LEGACY_METIN = 'KONUM: Eski Mahalle, Aydın. İrtifa: 10 m.\nOLANAKLAR: Duş.\nYAKIN ÇEVRE: İçme suyu: drinking_water (820 m). Yakın tesis: .\nDOĞA (çevredeki gözlem kayıtları, bilimsel ad): Kuşlar: Larus michahellis.';

function ornekVeri() {
  const onder = kayit('n26861211', 37.867778, 27.264444, { name_local: 'Önder Camping', name: { tr: null, en: 'Önder Camping', de: null, ru: null, ar: null }, _bekle: 'yeni' });
  const kopya = kayit('n999', 37.86779, 27.26445, { _bekle: 'yeni' });                         // adsiz, Önder'in 1 m yaninda
  const alan = kayit('a2000000002', 37.5, 27.0, { name_local: 'Alan Kamp', _bekle: 'yeni' });  // osmium 'a' kimligi (way 1000000001)
  const eski = kayit('n555', 37.9, 27.3, {
    name_local: 'Legacy Kamp', _bekle: 'yukselt', notes: { description: LEGACY_METIN, note: 'Otomatik derleme (2026-11-21): OSM. Doğrulanmalı.' },
    zengin: { surum: 1, tarih: '2026-11-21', konum: { adres: 'Eski Mahalle, Aydın', il: null, ilce: null, koy: null, ulke: null, irtifa_m: 10 }, olanaklar: ['Duş'], kisitlar: [], kapasite: null, calisma_saati: null,
      sebeke: { wifi: null, yirmidort_yedi: null }, ucret: { durum: null, ayrinti: [] }, kritik_noktalar: [{ tur: 'icme_suyu', ad: 'İçme suyu', mesafe_m: 820 }], cevre: {}, doga: { kuslar: [{ bilimsel: 'Larus michahellis', tr: null, en: null }] },
      koruma_alani: null, hakkinda: null, iletisim: { sosyal: [], eposta: [] }, osm_notu: null, ek_notlar: [], kaynak: { tarih: '2026-11-21', kaynaklar: ['OSM'], dogrulandi: false, eksik_adimlar: [], deneme: {}, alanlar: {}, eski_metin: true } },
  });
  const dokunulmaz = kayit('n3', 38.5, 28.5, { name_local: 'Uzak Kamp' });
  const bozuk = kayit('n6', null, null, { name_local: 'Koordinatsiz' });
  return [onder, kopya, alan, eski, dokunulmaz, bozuk];
}

function calistir(dir, veri, ek = {}, args = []) {
  const f = path.join(dir, 'ham', 'TR.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(veri));
  const r = spawnSync(process.execPath, [MOTOR, '--dosya', f, '--cc', 'TR', '--parca', '2', '--onbellek', path.join(dir, 'state', 'turce.json'), ...args],
    { cwd: dir, env: { ...process.env, TRAILO_SAHTE_AG: SAHTE, ...ek }, encoding: 'utf8', timeout: 120000 });
  return { r, cikti: JSON.parse(fs.readFileSync(f, 'utf8')), f };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailo-'));
const bul = (liste, id) => liste.find(x => x.id === id);

test('yeni kayit: yapilandirilmis alanlar, koordinat, Turkce ad, tekrar hafizasi', () => {
  const dir = tmp(), { r, cikti } = calistir(dir, ornekVeri());
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const o = bul(cikti, 'n26861211'), z = o.zengin;
  assert.ok(z, 'zengin yok'); assert.equal(z.surum, 2);
  // tekrar temizligi + hafiza
  assert.equal(bul(cikti, 'n999'), undefined, 'kopya silinmeliydi');
  assert.ok(o._meta.birlesen.includes('n999'), 'silinen kimlik hatirlanmali');
  // kritik noktalar: Turkce ad + koordinat
  const kr = t => z.kritik_noktalar.filter(x => x.tur === t);
  assert.equal(kr('icme_suyu')[0].ad, 'İçme suyu');
  assert.ok(Number.isFinite(kr('icme_suyu')[0].enlem) && Number.isFinite(kr('icme_suyu')[0].boylam));
  assert.equal(kr('tuvalet_dus')[0].alt, 'dus');
  assert.ok(kr('market').some(x => x.ad === 'Market') && kr('market').some(x => x.ad === 'Setur Market'));
  assert.equal(kr('saglik')[0].ad, 'Oksijen Eczanesi');
  assert.equal(kr('akaryakit')[0].ad, 'Moil');
  // cevre
  assert.equal(z.cevre.yerlesim[0].ad, 'Türkmen'); assert.equal(z.cevre.zirve[0].ad, 'Pilav Tepe');
  assert.ok(z.cevre.su_plaj.some(x => x.ad === 'Test Şelalesi'));
  assert.ok(!z.cevre.yakin_tesis, '50 m icindeki komsu yakin tesis sayilmamali');
  assert.match(z.koruma_alani.ad, /Dilek/);
  // tesis
  assert.ok(['Duş', 'Tuvalet', 'Wi-Fi'].every(x => z.olanaklar.includes(x)), JSON.stringify(z.olanaklar));
  assert.equal(z.calisma_saati, '24/7'); assert.equal(z.sebeke.yirmidort_yedi, true); assert.equal(z.sebeke.wifi, true);
  assert.deepEqual(z.kisitlar, ['Evcil hayvan yasak']);
  assert.equal(z.ucret.durum, 'ucretli'); assert.ok(z.ucret.ayrinti.some(x => /25/.test(x)));
  // doga: Latince + Turkce
  const kus = Object.fromEntries(z.doga.kuslar.map(x => [x.bilimsel, x]));
  assert.equal(kus['Larus michahellis'].tr, 'Gümüş martı'); assert.equal(kus['Hirundo rustica'].tr, null); assert.equal(kus['Hirundo rustica'].en, 'Barn Swallow');
  assert.equal(z.doga.bitkiler[0].tr, 'Zakkum');
  // hakkinda, konum
  assert.equal(z.hakkinda.baslik, 'Kuşadası'); assert.match(z.hakkinda.url, /^https:\/\/tr\.wikipedia\.org\/wiki\//);
  assert.match(z.konum.adres, /Kuşadası/); assert.ok(Number.isFinite(z.konum.irtifa_m));
  assert.deepEqual(z.kaynak.eksik_adimlar, []); assert.equal(z.kaynak.dogrulandi, false);
  // ham etiket sizmamali, bos satir olmamali
  assert.ok(!/"ad":"[a-z]+_[a-z_]+"/.test(JSON.stringify(z)), 'ham OSM etiketi sizdi');
  assert.match(o.notes.description, /^KONUM:/); assert.ok(!/Yakın tesis: \./.test(o.notes.description)); assert.ok(!/\n\n/.test(o.notes.description));
  assert.ok(!('_bekle' in o));
  // Turkce onbellek kaydedildi
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state', 'turce.json'), 'utf8'))['2481139'].tr, 'Gümüş martı');
});

test("osmium 'a' kimligi (way) etiketleri bulunur; OSM aciklamasi osm_notu olur", () => {
  const { cikti } = calistir(tmp(), ornekVeri());
  const z = bul(cikti, 'a2000000002').zengin;
  assert.ok(z.olanaklar.includes('Duş') && z.olanaklar.includes('Elektrik'));
  assert.equal(z.ucret.durum, 'ucretsiz'); assert.equal(z.osm_notu, 'OSM aciklama metni');
});

test('eski (v1) kayit yukseltilir: eski bolumler korunur, koordinat ve Turkce ad eklenir', () => {
  const { cikti } = calistir(tmp(), ornekVeri());
  const o = bul(cikti, 'n555'), z = o.zengin;
  assert.equal(z.surum, 2); assert.deepEqual(z.olanaklar, ['Duş'], 'osm_id calismadi, eski olanaklar korunmali');
  assert.equal(z.konum.adres, 'Eski Mahalle, Aydın'); assert.equal(z.kaynak.eski_metin, undefined);
  assert.ok(z.kritik_noktalar.every(x => Number.isFinite(x.enlem)), 'koordinatlar eklenmeli');
  assert.equal(z.doga.kuslar.find(x => x.bilimsel === 'Larus michahellis').tr, 'Gümüş martı');
  assert.match(o.notes.description, /^KONUM: Eski Mahalle, Aydın/);
  assert.ok(!/Yakın tesis: \./.test(o.notes.description) && !/drinking_water/.test(o.notes.description));
});

test('bayraksiz ve koordinatsiz kayitlara dokunulmaz', () => {
  const v = ornekVeri(), { cikti } = calistir(tmp(), v);
  assert.deepEqual(bul(cikti, 'n3'), v[4]); assert.deepEqual(bul(cikti, 'n6'), v[5]);
});

test('ag hatasi: eski bolum korunur, eksik adim isaretlenir, deneme sayilir', () => {
  const dir = tmp(), ilk = calistir(dir, ornekVeri()).cikti;
  const onceki = JSON.parse(JSON.stringify(bul(ilk, 'n26861211').zengin));
  const veri = ilk.map(k => k.id === 'n26861211' ? { ...k, _bekle: 'tamir' } : k);
  fs.rmSync(path.join(dir, 'work'), { recursive: true, force: true });  // hucre onbellegi yok (yeni runner)
  const { r, cikti } = calistir(dir, veri, { SAHTE_OVERPASS_HATA: '1', SAHTE_GBIF_HATA: '1' });
  assert.equal(r.status, 0, r.stderr);
  const z = bul(cikti, 'n26861211').zengin;
  assert.deepEqual(z.kritik_noktalar, onceki.kritik_noktalar, 'basarisiz adimda eski veri silinmemeli');
  assert.deepEqual(z.doga, onceki.doga);
  assert.ok(z.kaynak.eksik_adimlar.includes('osm_cevre') && z.kaynak.eksik_adimlar.includes('gbif'), JSON.stringify(z.kaynak));
  assert.equal(z.kaynak.deneme.osm_cevre, 1);
});

test('degismeyen girdi tekrar calisinca ayni sonucu verir (idempotent)', () => {
  const dir = tmp(), ilk = calistir(dir, ornekVeri()).cikti;
  const veri = ilk.map(k => k.id === 'n26861211' ? { ...k, _bekle: 'tazele' } : k);
  const { cikti } = calistir(dir, veri);
  assert.deepEqual(bul(cikti, 'n26861211').zengin, bul(ilk, 'n26861211').zengin);
  assert.deepEqual(bul(cikti, 'n3'), bul(ilk, 'n3'));
});

test('sure dolunca dosya gecerli kalir, bekleyenler isaretli kalir', () => {
  const { r, cikti } = calistir(tmp(), ornekVeri(), {}, ['--max-dakika', '0.00001']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /"durdu":true/);
  assert.ok(Array.isArray(cikti) && cikti.some(k => k._bekle), 'islenmeyenlerin bayragi kalmali');
});

test('bozuk dosya: motor cokmeden hata kodu verir, dosyayi bozmaz', () => {
  const dir = tmp(), f = path.join(dir, 'ham', 'TR.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{bozuk');
  const r = spawnSync(process.execPath, [MOTOR, '--dosya', f, '--cc', 'TR'], { cwd: dir, env: { ...process.env, TRAILO_SAHTE_AG: SAHTE }, encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.equal(fs.readFileSync(f, 'utf8'), '{bozuk');
});

test('eski hucre onbellegi (30 gunden eski) kullanilmaz, taze olan kullanilir', () => {
  const zlib = require('zlib');
  const dir = tmp(); calistir(dir, ornekVeri());
  const yol = path.join(dir, 'work', 'TR.hucre.json.gz');
  const x = JSON.parse(zlib.gunzipSync(fs.readFileSync(yol)));
  assert.ok(x.t && Object.keys(x.h).some(k => k.startsWith('gb:')), 'onbellek yazilmadi');
  // taze onbellek + GBIF hatasi: hucreden okunur, eksik olmaz
  const veri = () => calistir(dir, ornekVeri().map(k => k.id === 'n26861211' ? { ...k, _bekle: 'tazele' } : k), { SAHTE_GBIF_HATA: '1' }).cikti;
  assert.deepEqual(bul(veri(), 'n26861211').zengin.kaynak.eksik_adimlar, []);
  // 40 gunluk onbellek: atilir, GBIF hatasi gorunur
  x.t = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10);
  fs.writeFileSync(yol, zlib.gzipSync(JSON.stringify(x)));
  assert.ok(bul(veri(), 'n26861211').zengin.kaynak.eksik_adimlar.includes('gbif'));
});
