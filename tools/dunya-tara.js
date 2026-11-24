#!/usr/bin/env node
'use strict';
/*
 * Trailo PRO - Dünya kamp alanı tarama + 5 dilli zenginleştirme aracı
 *
 * - Çok kaynaklı OSM çekimi: Geofabrik PBF -> OSM.fr PBF -> Geofabrik kırpılmış PBF -> 5 aynalı Overpass -> BBox
 * - Gerçek ülke/eyalet sınır poligonu ve addr:country kontrolü ile sınır taşması engellenir
 * - 5 dilde (tr, en, de, ru, ar) sıfır uydurma veri ile notes.description_i18n ve notes.note_i18n üretir
 * - Geriye dönük uyumluluk için notes.description ve notes.note (TR) alanlarını korur
 * - data/XX.json ile AYNI formatta yazar (US için US_WEST, US_SOUTH ... bölge dosyaları)
 * - Birbirine ESIK metre (aynı isimli kayıtlarda 300 m) içindeki noktalardan bilgisi az olanı atar
 *
 * Kullanım:
 *   node tools/dunya-tara.js --mod pilot            (LU, pilot/ klasörüne, kategori onayı gerekmez)
 *   node tools/dunya-tara.js --mod tam --commit     (tüm dünya, data/ klasörüne, kategori onayı gerekir)
 *   Seçenekler: --ulkeler AT,DE  --esik 110  --sure 330 (dakika)  --yenile-gun 30  --yakin-cevre 1|0
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  birimVerisiCek,
  birimYerelPoiCek,
  overpassSorgula,
  izgaradanYakinPoiler,
  POI_QL,
} = require('./osm-kaynak');

const KOK = path.resolve(__dirname, '..');
const UA = 'TrailoPRO-harvester/3.2 (https://github.com/ziyaarslanturk/trailopro)';

const ILKELER = ['AD','AE','AF','AG','AI','AL','AM','AO','AR','AS','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ','TC','TD','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VG','VI','VN','VU','WF','WS','XK','YE','YT','ZA','ZM','ZW'];

// ABD: mevcut dosya düzenine göre bölgeler (US_PACIFIC = AK + HI)
const US_BOLGE = {
  US_NORTHEAST: ['ME','NH','VT','MA','RI','CT','NY','NJ','PA'],
  US_MIDWEST: ['OH','IN','IL','MI','WI','MN','IA','MO','ND','SD','NE','KS'],
  US_SOUTH: ['DE','MD','DC','VA','WV','NC','SC','GA','FL','KY','TN','AL','MS','AR','LA','OK','TX'],
  US_WEST: ['MT','ID','WY','NV','UT','CO','AZ','NM','WA','OR','CA'],
  US_PACIFIC: ['AK','HI'],
};
const DIL = ['tr', 'en', 'de', 'ru', 'ar'];
const HAYIR_DEGERLER = new Set(['no', 'none', 'false', '0']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------- 5 Dilli Sözlük (tr, en, de, ru, ar) ---------- */
const METIN = {
  tr: {
    ayirac: ', ', ondalik: ',', m: 'm', km: 'km',
    konum: 'KONUM', koordinat: 'Koordinat', irtifa: 'İrtifa',
    yakinCevre: 'YAKIN ÇEVRE', olanaklar: 'OLANAKLAR', ucret: 'ÜCRET',
    kapasite: 'Kapasite', calismaSaatleri: 'Çalışma saatleri',
    rezervasyon: 'Rezervasyon', isletmeci: 'İşletmeci', adres: 'Adres',
    ucretDeger: { yes: 'ücretli', no: 'ücretsiz', donation: 'bağışa dayalı' },
    rezDeger: { required: 'zorunlu', recommended: 'önerilir', yes: 'var', no: 'yok' },
    notSablon: (tarih, kynk) => `Temel derleme (${tarih}): ${kynk}. Doğrulanmalı.`,
    olanak: {
      toilets: 'tuvalet', shower: 'duş', drinking_water: 'içme suyu', electricity: 'elektrik',
      wifi: 'wifi', dump: 'karavan atık boşaltma', laundry: 'çamaşırhane',
      openfire_yes: 'ateş yakmaya izinli', openfire_no: 'ateş yakmak yasak',
      bbq: 'mangal/piknik alanı', pool: 'havuz', sauna: 'sauna', shop: 'market',
      restaurant: 'restoran/bar', playground: 'çocuk parkı',
      dog_yes: 'köpek kabul edilir', dog_leashed: 'köpek tasmalı kabul edilir', dog_no: 'köpek kabul edilmez',
      tents_yes: 'çadır kabul edilir', tents_no: 'çadır kabul edilmez',
      caravans_yes: 'karavan kabul edilir', motorhome_yes: 'motokaravan kabul edilir',
      backcountry: 'yürüyüşle ulaşılan ilkel kamp (backcountry)',
      wheelchair: 'tekerlekli sandalye erişimi', nudism: 'naturist alan',
    },
    grup: {
      beach: 'Su/plaj', water: 'İçme suyu', toilet: 'Tuvalet/duş noktası',
      market: 'Market', fuel: 'Akaryakıt', health: 'Sağlık', place: 'Yerleşim',
      peak: 'Zirve', sight: 'Görülecek', stay: 'Yakın tesis',
    },
    poi: {
      beach: 'Plaj', beach_resort: 'Plaj tesisi', drinking_water: 'Su noktası',
      toilets: 'Tuvalet', shower: 'Duş', supermarket: 'Süpermarket',
      convenience: 'Market', general: 'Market', kiosk: 'Büfe',
      fuel: 'Akaryakıt istasyonu', pharmacy: 'Eczane', hospital: 'Hastane',
      clinic: 'Klinik', doctors: 'Doktor', peak: 'Zirve',
      attraction: 'Turistik nokta', museum: 'Müze', viewpoint: 'Manzara noktası',
      castle: 'Kale', ruins: 'Harabe', monument: 'Anıt',
      archaeological_site: 'Arkeolojik alan', hotel: 'Otel', hostel: 'Hostel',
      motel: 'Motel', guest_house: 'Pansiyon',
    },
  },
  en: {
    ayirac: ', ', ondalik: '.', m: 'm', km: 'km',
    konum: 'LOCATION', koordinat: 'Coordinates', irtifa: 'Elevation',
    yakinCevre: 'NEARBY', olanaklar: 'FACILITIES', ucret: 'FEE',
    kapasite: 'Capacity', calismaSaatleri: 'Opening hours',
    rezervasyon: 'Reservation', isletmeci: 'Operator', adres: 'Address',
    ucretDeger: { yes: 'paid', no: 'free', donation: 'donation' },
    rezDeger: { required: 'required', recommended: 'recommended', yes: 'available', no: 'not required' },
    notSablon: (tarih, kynk) => `Basic compilation (${tarih}): ${kynk}. Needs verification.`,
    olanak: {
      toilets: 'toilets', shower: 'shower', drinking_water: 'drinking water', electricity: 'electricity',
      wifi: 'Wi-Fi', dump: 'waste disposal', laundry: 'laundry',
      openfire_yes: 'open fire allowed', openfire_no: 'no open fire',
      bbq: 'BBQ/picnic area', pool: 'swimming pool', sauna: 'sauna', shop: 'shop',
      restaurant: 'restaurant/bar', playground: 'playground',
      dog_yes: 'dogs allowed', dog_leashed: 'dogs on leash', dog_no: 'no dogs',
      tents_yes: 'tents allowed', tents_no: 'no tents',
      caravans_yes: 'caravans allowed', motorhome_yes: 'motorhomes allowed',
      backcountry: 'backcountry camp',
      wheelchair: 'wheelchair accessible', nudism: 'naturist site',
    },
    grup: {
      beach: 'Water/beach', water: 'Drinking water', toilet: 'Toilet/shower',
      market: 'Shop', fuel: 'Fuel', health: 'Healthcare', place: 'Settlement',
      peak: 'Peak', sight: 'Sights', stay: 'Nearby lodging',
    },
    poi: {
      beach: 'Beach', beach_resort: 'Beach resort', drinking_water: 'Water point',
      toilets: 'Toilet', shower: 'Shower', supermarket: 'Supermarket',
      convenience: 'Convenience store', general: 'General store', kiosk: 'Kiosk',
      fuel: 'Fuel station', pharmacy: 'Pharmacy', hospital: 'Hospital',
      clinic: 'Clinic', doctors: 'Doctor', peak: 'Peak',
      attraction: 'Attraction', museum: 'Museum', viewpoint: 'Viewpoint',
      castle: 'Castle', ruins: 'Ruins', monument: 'Monument',
      archaeological_site: 'Archaeological site', hotel: 'Hotel', hostel: 'Hostel',
      motel: 'Motel', guest_house: 'Guest house',
    },
  },
  de: {
    ayirac: ', ', ondalik: ',', m: 'm', km: 'km',
    konum: 'LAGE', koordinat: 'Koordinaten', irtifa: 'Höhe',
    yakinCevre: 'UMGEBUNG', olanaklar: 'AUSSTATTUNG', ucret: 'GEBÜHR',
    kapasite: 'Kapazität', calismaSaatleri: 'Öffnungszeiten',
    rezervasyon: 'Reservierung', isletmeci: 'Betreiber', adres: 'Adresse',
    ucretDeger: { yes: 'kostenpflichtig', no: 'kostenlos', donation: 'Spende' },
    rezDeger: { required: 'erforderlich', recommended: 'empfohlen', yes: 'möglich', no: 'nicht erforderlich' },
    notSablon: (tarih, kynk) => `Basisdaten (${tarih}): ${kynk}. Bitte überprüfen.`,
    olanak: {
      toilets: 'Toiletten', shower: 'Dusche', drinking_water: 'Trinkwasser', electricity: 'Strom',
      wifi: 'WLAN', dump: 'Entsorgungsstation', laundry: 'Waschmaschine',
      openfire_yes: 'Lagerfeuer erlaubt', openfire_no: 'Lagerfeuer verboten',
      bbq: 'Grill-/Picknickplatz', pool: 'Schwimmbad', sauna: 'Sauna', shop: 'Geschäft',
      restaurant: 'Restaurant/Bar', playground: 'Spielplatz',
      dog_yes: 'Hunde erlaubt', dog_leashed: 'Hunde an der Leine', dog_no: 'keine Hunde',
      tents_yes: 'Zelte erlaubt', tents_no: 'keine Zelte',
      caravans_yes: 'Wohnwagen erlaubt', motorhome_yes: 'Wohnmobile erlaubt',
      backcountry: 'Wildcamp (Backcountry)',
      wheelchair: 'barrierefrei', nudism: 'FKK-Bereich',
    },
    grup: {
      beach: 'Wasser/Strand', water: 'Trinkwasser', toilet: 'WC/Dusche',
      market: 'Einkaufen', fuel: 'Tankstelle', health: 'Gesundheit', place: 'Ort',
      peak: 'Gipfel', sight: 'Sehenswürdigkeiten', stay: 'Unterkunft',
    },
    poi: {
      beach: 'Strand', beach_resort: 'Strandbad', drinking_water: 'Wasserstelle',
      toilets: 'Toilette', shower: 'Dusche', supermarket: 'Supermarkt',
      convenience: 'Laden', general: 'Gemischtwarenladen', kiosk: 'Kiosk',
      fuel: 'Tankstelle', pharmacy: 'Apotheke', hospital: 'Krankenhaus',
      clinic: 'Klinik', doctors: 'Arzt', peak: 'Gipfel',
      attraction: 'Sehenswürdigkeit', museum: 'Museum', viewpoint: 'Aussichtspunkt',
      castle: 'Burg/Schloss', ruins: 'Ruine', monument: 'Denkmal',
      archaeological_site: 'Archäologische Stätte', hotel: 'Hotel', hostel: 'Hostel',
      motel: 'Motel', guest_house: 'Pension',
    },
  },
  ru: {
    ayirac: ', ', ondalik: ',', m: 'м', km: 'км',
    konum: 'РАСПОЛОЖЕНИЕ', koordinat: 'Координаты', irtifa: 'Высота',
    yakinCevre: 'РЯДОМ', olanaklar: 'УДОБСТВА', ucret: 'ОПЛАТА',
    kapasite: 'Вместимость', calismaSaatleri: 'Часы работы',
    rezervasyon: 'Бронирование', isletmeci: 'Оператор', adres: 'Адрес',
    ucretDeger: { yes: 'платно', no: 'бесплатно', donation: 'пожертвование' },
    rezDeger: { required: 'обязательно', recommended: 'рекомендуется', yes: 'доступно', no: 'не требуется' },
    notSablon: (tarih, kynk) => `Базовая сводка (${tarih}): ${kynk}. Требует проверки.`,
    olanak: {
      toilets: 'туалет', shower: 'душ', drinking_water: 'питьевая вода', electricity: 'электричество',
      wifi: 'Wi-Fi', dump: 'слив для автодомов', laundry: 'прачечная',
      openfire_yes: 'костры разрешены', openfire_no: 'костры запрещены',
      bbq: 'зона барбекю/пикника', pool: 'бассейн', sauna: 'сауна', shop: 'магазин',
      restaurant: 'ресторан/бар', playground: 'детская площадка',
      dog_yes: 'можно с собаками', dog_leashed: 'собаки на поводке', dog_no: 'с собаками запрещено',
      tents_yes: 'палатки разрешены', tents_no: 'палатки запрещены',
      caravans_yes: 'караваны разрешены', motorhome_yes: 'автодома разрешены',
      backcountry: 'дикий кемпинг (бэккантри)',
      wheelchair: 'доступно для колясок', nudism: 'нудистская зона',
    },
    grup: {
      beach: 'Вода/пляж', water: 'Питьевая вода', toilet: 'Туалет/душ',
      market: 'Магазин', fuel: 'АЗС', health: 'Медицина', place: 'Населённый пункт',
      peak: 'Вершина', sight: 'Достопримечательности', stay: 'Жильё рядом',
    },
    poi: {
      beach: 'Пляж', beach_resort: 'Пляжный комплекс', drinking_water: 'Источник воды',
      toilets: 'Туалет', shower: 'Душ', supermarket: 'Супермаркет',
      convenience: 'Магазин', general: 'Магазин', kiosk: 'Киоск',
      fuel: 'АЗС', pharmacy: 'Аптека', hospital: 'Больница',
      clinic: 'Клиника', doctors: 'Врач', peak: 'Вершина',
      attraction: 'Достопримечательность', museum: 'Музей', viewpoint: 'Смотровая площадка',
      castle: 'Замок', ruins: 'Руины', monument: 'Памятник',
      archaeological_site: 'Археологический памятник', hotel: 'Отель', hostel: 'Хостел',
      motel: 'Мотель', guest_house: 'Гостевой дом',
    },
  },
  ar: {
    ayirac: '، ', ondalik: '.', m: 'م', km: 'كم',
    konum: 'الموقع', koordinat: 'الإحداثيات', irtifa: 'الارتفاع',
    yakinCevre: 'بالقرب من', olanaklar: 'المرافق', ucret: 'الرسوم',
    kapasite: 'السعة', calismaSaatleri: 'ساعات العمل',
    rezervasyon: 'الحجز', isletmeci: 'المشغّل', adres: 'العنوان',
    ucretDeger: { yes: 'مدفوع', no: 'مجاني', donation: 'تبرع' },
    rezDeger: { required: 'مطلوب', recommended: 'مستحسن', yes: 'متاح', no: 'غير مطلوب' },
    notSablon: (tarih, kynk) => `بيانات أساسية (${tarih}): ${kynk}. يُرجى التحقق.`,
    olanak: {
      toilets: 'دورات مياه', shower: 'دش', drinking_water: 'مياه شرب', electricity: 'كهرباء',
      wifi: 'واي فاي', dump: 'تصريف نفايات الكرفانات', laundry: 'غسيل ملابس',
      openfire_yes: 'يُسمح بإشعال النار', openfire_no: 'إشعال النار ممنوع',
      bbq: 'منطقة شواء/نزهة', pool: 'مسبح', sauna: 'ساونا', shop: 'متجر',
      restaurant: 'مطعم/مقهى', playground: 'ملعب أطفال',
      dog_yes: 'يُسمح بالكلاب', dog_leashed: 'يُسمح بالكلاب مقيدة', dog_no: 'الكلاب غير مسموحة',
      tents_yes: 'يُسمح بالخيام', tents_no: 'الخيام غير مسموحة',
      caravans_yes: 'يُسمح بالكرفانات', motorhome_yes: 'يُسمح بالبيوت المتنقلة',
      backcountry: 'تخييم بري',
      wheelchair: 'مناسب للكراسي المتحركة', nudism: 'منطقة طبيعية',
    },
    grup: {
      beach: 'شاطئ/مياه', water: 'مياه شرب', toilet: 'دورة مياه/دش',
      market: 'متجر', fuel: 'وقود', health: 'صحة', place: 'منطقة سكنية',
      peak: 'قمة', sight: 'معالم', stay: 'إقامة قريبة',
    },
    poi: {
      beach: 'شاطئ', beach_resort: 'منتجع شاطئي', drinking_water: 'نقطة مياه',
      toilets: 'دورة مياه', shower: 'دش', supermarket: 'سوبرماركت',
      convenience: 'بقالة', general: 'متجر عام', kiosk: 'كشك',
      fuel: 'محطة وقود', pharmacy: 'صيدلية', hospital: 'مستشفى',
      clinic: 'عيادة', doctors: 'طبيب', peak: 'قمة',
      attraction: 'معلم سياحي', museum: 'متحف', viewpoint: 'نقطة إطلالة',
      castle: 'قلعة', ruins: 'آثار', monument: 'نصب تذكاري',
      archaeological_site: 'موقع أثري', hotel: 'فندق', hostel: 'نزل',
      motel: 'موتيل', guest_house: 'دار ضيافة',
    },
  },
};

const ULKE_AD = {};
for (const d of DIL) {
  try { ULKE_AD[d] = new Intl.DisplayNames([d], { type: 'region' }); } catch { ULKE_AD[d] = null; }
}

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
function mesafeYaz(m, dil = 'tr') {
  const soz = METIN[dil] || METIN.tr;
  if (m < 1000) return Math.round(m) + ' ' + soz.m;
  return (m / 1000).toFixed(1).replace('.', soz.ondalik) + ' ' + soz.km;
}
const bos = (v) => v === undefined || v === null || String(v).trim() === '';
const temiz = (v) => (bos(v) ? null : String(v).trim());
const adNorm = (s) => (bos(s) ? '' : String(s).toLowerCase().replace(/\s+/g, ' ').trim());
const EVET = (v) => v === 'yes' || v === 'designated';
const VAR = (v) => !bos(v) && !HAYIR_DEGERLER.has(String(v).trim().toLowerCase());

/* ---------- Kategori kuralları (no/none/false ve tents=no korumalı) ---------- */
function kategoriYukle(kok) {
  const p = path.join(kok, 'tools', 'kategoriler.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function kategoriHesapla(etiket, kat) {
  const ids = [];
  for (const [id, k] of Object.entries(kat.kategoriler)) {
    const num = Number(id);
    if (num === 1 && String(etiket.tents || '').trim().toLowerCase() === 'no') continue;
    const eslesti = (k.kural || []).some(([key, val]) => {
      const t = etiket[key];
      if (t === undefined) return false;
      const parcalar = String(t).split(';').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!parcalar.length) return false;
      if (val === '*') return parcalar.some((p) => !HAYIR_DEGERLER.has(p));
      return parcalar.includes(String(val).toLowerCase());
    });
    if (eslesti) ids.push(num);
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
  const descI18n = {};
  for (const d of DIL) {
    ad[d] = temiz(t['name:' + d]);
    descI18n[d] = etiketMetni(t, d);
  }
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
    notes: {
      description: descI18n.tr,
      description_i18n: descI18n,
      note: null,
      note_i18n: null,
    },
    category_ids: kategoriHesapla(t, kat),
    _tags: t, // geçici: zenginleştirme için, yazarken silinir
  };
}

function etiketMetni(t, dil = 'tr') {
  const soz = METIN[dil] || METIN.tr;
  const O = soz.olanak;
  const ol = [];
  const ekle = (kosul, anahtar) => { if (kosul) ol.push(O[anahtar]); };

  ekle(EVET(t.toilets), 'toilets');
  ekle(EVET(t.shower), 'shower');
  ekle(EVET(t.drinking_water), 'drinking_water');
  ekle(VAR(t.power_supply) || VAR(t.electricity), 'electricity');
  ekle(EVET(t.internet_access) || t.internet_access === 'wlan' || t.internet_access === 'wifi', 'wifi');
  ekle(EVET(t.sanitary_dump_station), 'dump');
  ekle(EVET(t.washing_machine) || EVET(t.laundry), 'laundry');
  ekle(EVET(t.openfire) || EVET(t.campfire), 'openfire_yes');
  ekle(t.openfire === 'no', 'openfire_no');
  ekle(EVET(t.bbq) || EVET(t.picnic_table), 'bbq');
  ekle(EVET(t.swimming_pool), 'pool');
  ekle(EVET(t.sauna), 'sauna');
  ekle(VAR(t.shop), 'shop');
  ekle(EVET(t.restaurant) || EVET(t.bar), 'restaurant');
  ekle(EVET(t.playground), 'playground');
  ekle(t.dog === 'yes' || t.pets === 'yes', 'dog_yes');
  ekle(t.dog === 'leashed', 'dog_leashed');
  ekle(t.dog === 'no', 'dog_no');
  ekle(EVET(t.tents), 'tents_yes');
  ekle(t.tents === 'no', 'tents_no');
  ekle(EVET(t.caravans), 'caravans_yes');
  ekle(EVET(t.motorhome), 'motorhome_yes');
  ekle(t.backcountry === 'yes', 'backcountry');
  ekle(EVET(t.wheelchair), 'wheelchair');
  ekle(VAR(t.nudism), 'nudism');

  const satir = [];
  if (t.capacity) satir.push(`${soz.kapasite}: ${t.capacity}.`);
  if (t.opening_hours) satir.push(`${soz.calismaSaatleri}: ${t.opening_hours}.`);
  if (t.reservation) {
    satir.push(`${soz.rezervasyon}: ${soz.rezDeger[t.reservation] || t.reservation}.`);
  }
  if (t.operator) satir.push(`${soz.isletmeci}: ${t.operator}.`);
  if (t['addr:street']) {
    const adr = [t['addr:street'], t['addr:housenumber'], t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ');
    satir.push(`${soz.adres}: ${adr}.`);
  }

  const bolum = [];
  if (ol.length) bolum.push(`${soz.olanaklar}: ${ol.join(soz.ayirac)}.`);
  const ucret = ucretMetni(t, dil);
  if (ucret) bolum.push(`${soz.ucret}: ${ucret}`);
  if (satir.length) bolum.push(satir.join(' '));
  return bolum.length ? bolum.join('\n') : null;
}

function ucretMetni(t, dil = 'tr') {
  const soz = METIN[dil] || METIN.tr;
  const f = t.fee;
  if (!f && !t.charge) return null;
  const parca = [];
  if (f) parca.push(soz.ucretDeger[f] || String(f));
  if (t.charge) parca.push(String(t.charge));
  return parca.join(soz.ayirac) + '.';
}

/* ---------- Bilgi puanı + mesafe ve aynı-isim tekilleştirme ---------- */
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
  const ayniAdEsik = Math.max(esik, 300);
  const sirali = kayitlar
    .map((r) => ({ r, p: puan(r), normAd: adNorm(r.name_local) }))
    .sort((a, b) => b.p - a.p || (b.r._eski ? 1 : 0) - (a.r._eski ? 1 : 0) || (a.r.id < b.r.id ? -1 : 1));
  const HUCRE = 0.004; // ~444 m
  const izgara = new Map();
  const kalan = [];
  for (const item of sirali) {
    const { r, normAd } = item;
    const cy = Math.floor(r.latitude / HUCRE);
    const cx = Math.floor((r.longitude * Math.max(Math.cos((r.latitude * Math.PI) / 180), 0.05)) / HUCRE);
    const span = 3;
    let tekrar = false;
    for (let dy = -1; dy <= 1 && !tekrar; dy++) {
      for (let dx = -span; dx <= span && !tekrar; dx++) {
        const liste = izgara.get(cy + dy + ',' + (cx + dx));
        if (!liste) continue;
        for (const k of liste) {
          const d = mesafe(r.latitude, r.longitude, k.r.latitude, k.r.longitude);
          if (d <= esik || (normAd.length >= 3 && normAd === k.normAd && d <= ayniAdEsik)) {
            tekrar = true;
            break;
          }
        }
      }
    }
    if (tekrar) continue;
    const anahtar = cy + ',' + cx;
    if (!izgara.has(anahtar)) izgara.set(anahtar, []);
    izgara.get(anahtar).push(item);
    kalan.push(r);
  }
  return { kalan, silinen: kayitlar.length - kalan.length };
}

/* ---------- İrtifa: Open-Meteo -> Open-Elevation -> OSM ele etiketi ---------- */
async function irtifaAl(noktalar) {
  const degerler = [];
  const kaynaklar = [];

  for (let i = 0; i < noktalar.length; i += 100) {
    const dilim = noktalar.slice(i, i + 100);
    const url =
      'https://api.open-meteo.com/v1/elevation?latitude=' +
      dilim.map((p) => p.latitude).join(',') +
      '&longitude=' +
      dilim.map((p) => p.longitude).join(',');

    let deger = null;
    let kaynak = null;

    for (let d = 0; d < 3 && !deger; d++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 429) {
          await sleep(4000 * (d + 1));
          continue;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        if (Array.isArray(j.elevation)) {
          deger = j.elevation;
          kaynak = 'Open-Meteo';
        }
      } catch {
        await sleep(2000 * (d + 1));
      }
    }

    if (!deger) {
      try {
        const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            locations: dilim.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const j = await res.json();
          if (Array.isArray(j.results)) {
            deger = j.results.map((x) => (x && Number.isFinite(x.elevation) ? x.elevation : null));
            kaynak = 'Open-Elevation';
          }
        }
      } catch {
        // Yalnızca OSM ele etiketi varsa kullanılacak
      }
    }

    for (let k = 0; k < dilim.length; k++) {
      let m = deger && deger[k] !== undefined && deger[k] !== null && Number.isFinite(deger[k])
        ? Math.round(deger[k])
        : null;
      let kynk = m !== null ? kaynak : null;

      if (m === null && dilim[k]._tags && dilim[k]._tags.ele) {
        const parsed = parseFloat(String(dilim[k]._tags.ele).replace(',', '.'));
        if (Number.isFinite(parsed)) {
          m = Math.round(parsed);
          kynk = 'OSM';
        }
      }
      degerler.push(m);
      kaynaklar.push(kynk);
    }

    if (i + 100 < noktalar.length) await sleep(600);
  }
  return { degerler, kaynaklar };
}

/* ---------- Yakın çevre (5 dilde, tekrar temizlemeli) ---------- */
const GRUPLAR = [
  { key: 'beach', test: (t) => t.natural === 'beach' || t.leisure === 'beach_resort', adet: 1, azami: 10000, poiKey: (t) => t.natural || t.leisure || 'beach' },
  { key: 'water', test: (t) => t.amenity === 'drinking_water', adet: 2, azami: 5000, poiKey: () => 'drinking_water' },
  { key: 'toilet', test: (t) => t.amenity === 'toilets' || t.amenity === 'shower', adet: 1, azami: 3000, poiKey: (t) => (t.amenity === 'shower' ? 'shower' : 'toilets') },
  { key: 'market', test: (t) => /^(supermarket|convenience|general|kiosk)$/.test(t.shop || ''), adet: 2, azami: 10000, poiKey: (t) => t.shop || 'convenience' },
  { key: 'fuel', test: (t) => t.amenity === 'fuel', adet: 1, azami: 10000, poiKey: () => 'fuel' },
  { key: 'health', test: (t) => /^(pharmacy|hospital|clinic|doctors)$/.test(t.amenity || ''), adet: 1, azami: 10000, poiKey: (t) => t.amenity || 'pharmacy' },
  { key: 'place', test: (t) => !!t.place && !!temiz(t.name), adet: 2, azami: 10000, poiKey: () => null },
  { key: 'peak', test: (t) => t.natural === 'peak', adet: 2, azami: 10000, poiKey: () => 'peak' },
  { key: 'sight', test: (t) => /^(attraction|museum|viewpoint)$/.test(t.tourism || '') || !!t.historic, adet: 3, azami: 10000, poiKey: (t) => t.tourism || t.historic || 'attraction' },
  { key: 'stay', test: (t) => /^(hotel|hostel|motel|guest_house)$/.test(t.tourism || ''), adet: 1, azami: 5000, poiKey: (t) => t.tourism || 'hotel' },
];

function yakinCevreMetni(r, poiler, dil = 'tr') {
  const soz = METIN[dil] || METIN.tr;
  const kampAdNorm = adNorm(r.name_local);
  const kampDilAdNorm = adNorm(r.name && r.name[dil]);
  const parcalar = [];

  for (const g of GRUPLAR) {
    const adaylar = [];
    for (const p of poiler) {
      if (!g.test(p.tags)) continue;
      if (p.tags === r._tags) continue;
      const hamAd = temiz(p.tags['name:' + dil]) || temiz(p.tags.name);
      const normAd = adNorm(hamAd || p.tags.name);
      const d = mesafe(r.latitude, r.longitude, p.lat, p.lon);
      if (d > g.azami) continue;
      if (normAd && (normAd === kampAdNorm || normAd === kampDilAdNorm) && d < 250) continue;

      const pKey = g.poiKey(p.tags);
      const gorunenAd = hamAd || (pKey ? soz.poi[pKey] : null);
      if (!gorunenAd) continue;
      adaylar.push({ d, ad: gorunenAd, normAd, lat: p.lat, lon: p.lon });
    }

    adaylar.sort((a, b) => a.d - b.d);

    const sec = [];
    const gorulenAdlar = new Set();
    for (const a of adaylar) {
      if (sec.length >= g.adet) break;
      if (a.normAd && gorulenAdlar.has(a.normAd)) continue;
      const yakinTekrar = sec.some(
        (s) => s.ad === a.ad && mesafe(s.lat, s.lon, a.lat, a.lon) < 100
      );
      if (yakinTekrar) continue;
      if (a.normAd) gorulenAdlar.add(a.normAd);
      sec.push(a);
    }

    if (sec.length) {
      parcalar.push(
        soz.grup[g.key] + ': ' +
        sec.map((s) => `${s.ad} (${mesafeYaz(s.d, dil)})`).join(soz.ayirac) + '.'
      );
    }
  }
  return parcalar.length ? `${soz.yakinCevre}: ${parcalar.join(' ')}` : null;
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

function konumMetni(r, irtifa, dil = 'tr') {
  const soz = METIN[dil] || METIN.tr;
  const t = r._tags || {};
  const parca = [
    t['addr:suburb'] || t['addr:neighbourhood'],
    t['addr:city'] || t['addr:town'] || t['addr:village'] || t['addr:municipality'],
    t['addr:state'] || t['addr:province'],
  ].filter(Boolean);
  const kod = r.country_code.startsWith('US_') ? 'US' : r.country_code;
  let ulke = null;
  try { ulke = ULKE_AD[dil] ? ULKE_AD[dil].of(kod) : null; } catch { /* yoksay */ }
  if (ulke) parca.push(ulke);
  let m = `${soz.konum}: ` + (parca.length ? parca.join(soz.ayirac) + '.' : `${soz.koordinat} ${r.latitude}, ${r.longitude}.`);
  if (irtifa !== null && irtifa !== undefined) m += ` ${soz.irtifa}: ${irtifa} ${soz.m}.`;
  return m;
}

function derlemeNotu(bugun, irtifaKaynagi, dil = 'tr') {
  const soz = METIN[dil] || METIN.tr;
  const kaynaklar = ['OSM'];
  if (irtifaKaynagi && irtifaKaynagi !== 'OSM') kaynaklar.push(irtifaKaynagi);
  return soz.notSablon(bugun, kaynaklar.join(', '));
}

function kaydi5DildeDoldur(r, irtifa, irtKaynak, yakinPoiler, bugun, yakinCevreAcik) {
  const yeniDescI18n = {};
  const yeniNoteI18n = {};
  const eskiDescI18n = (r.notes && r.notes.description_i18n) || {};

  for (const d of DIL) {
    const parcalar = [konumMetni(r, irtifa, d)];
    if (yakinCevreAcik && yakinPoiler) {
      const yc = yakinCevreMetni(r, yakinPoiler, d);
      if (yc) parcalar.push(yc);
    }
    const mevcutDesc = eskiDescI18n[d] || (d === 'tr' ? (r.notes && r.notes.description) : null);
    if (mevcutDesc) parcalar.push(mevcutDesc);
    yeniDescI18n[d] = parcalar.join('\n');
    yeniNoteI18n[d] = derlemeNotu(bugun, irtKaynak, d);
  }

  r.notes.description = yeniDescI18n.tr;
  r.notes.description_i18n = yeniDescI18n;
  r.notes.note = yeniNoteI18n.tr;
  r.notes.note_i18n = yeniNoteI18n;
}

async function zenginlestir(birim, kayitlar, ayar, saatDolduMu, kaydet, yerelPoiIzgarasi) {
  const hedef = kayitlar.filter(
    (r) => !(r.notes && r.notes.note && /^(Otomatik|Temel) derleme/.test(r.notes.note))
  );
  if (!hedef.length) return true;

  const bugun = new Date().toISOString().slice(0, 10);
  let poiIzgarasi = yerelPoiIzgarasi;

  if (ayar.yakinCevre && !poiIzgarasi) {
    poiIzgarasi = await birimYerelPoiCek(birim, ayar, hedef);
  }

  // HIZLI YOL: Yerel PBF POI ızgarası (0 Overpass isteği)
  if (!ayar.yakinCevre || poiIzgarasi) {
    log('zenginleştirilecek', hedef.length, 'kayıt (yerel PBF POI ızgarası — 5 dil — 0 Overpass isteği)');
    const PAKET = 200;
    for (let i = 0; i < hedef.length; i += PAKET) {
      if (saatDolduMu()) return false;
      const dilim = hedef.slice(i, i + PAKET);
      const { degerler: irt, kaynaklar: irtKaynak } = await irtifaAl(dilim);
      dilim.forEach((r, idx) => {
        const yakin = ayar.yakinCevre && poiIzgarasi
          ? izgaradanYakinPoiler(poiIzgarasi, r.latitude, r.longitude)
          : null;
        kaydi5DildeDoldur(r, irt[idx], irtKaynak[idx], yakin, bugun, Boolean(ayar.yakinCevre));
      });
      if ((i + PAKET) % 2000 === 0 && i + PAKET < hedef.length) {
        kaydet();
        log('ara kayıt:', Math.min(i + PAKET, hedef.length), '/', hedef.length);
      }
    }
    return true;
  }

  // YEDEK YOL: PBF olmayan küçük ada/bölgelerde 5 aynalı Overpass karo sorgusu
  const KARO = 0.2, MARJ = 0.1;
  const karolar = new Map();
  for (const r of hedef) {
    const k = Math.floor(r.latitude / KARO) + ',' + Math.floor(r.longitude / KARO);
    if (!karolar.has(k)) karolar.set(k, []);
    karolar.get(k).push(r);
  }
  log('zenginleştirilecek', hedef.length, 'kayıt,', karolar.size, 'Overpass karosu (5 dil)');
  let islenen = 0, say = 0;
  for (const [k, liste] of karolar) {
    if (saatDolduMu()) return false;
    const [cy, cx] = k.split(',').map(Number);
    const s = (cy * KARO - MARJ).toFixed(4);
    const w = (cx * KARO - MARJ).toFixed(4);
    const n = ((cy + 1) * KARO + MARJ).toFixed(4);
    const e = ((cx + 1) * KARO + MARJ).toFixed(4);
    const bbox = '(' + s + ',' + w + ',' + n + ',' + e + ')';
    const sorgu = '[out:json][timeout:110];(' + POI_QL.map((q) => q + bbox + ';').join('') + ');out center tags;';
    const poiler = poiNoktalari(await overpassSorgula(sorgu, ayar, 2));
    const { degerler: irt, kaynaklar: irtKaynak } = await irtifaAl(liste);
    liste.forEach((r, i) => {
      kaydi5DildeDoldur(r, irt[i], irtKaynak[i], poiler, bugun, true);
    });
    islenen += liste.length;
    if (++say % 25 === 0) { kaydet(); log('ara kayıt:', islenen, '/', hedef.length); }
  }
  return true;
}

/* ---------- Dosya ve Git işlemleri ---------- */
function dosyaOku(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; } }
function temizYaz(kayitlar) {
  return JSON.stringify(kayitlar.map((r) => {
    const { _tags, _eski, ...gerisi } = r; // eslint-disable-line no-unused-vars
    return gerisi;
  }), null, 0);
}
function manifestGuncelle(klasor, kod, kayitSayisi, metin) {
  const p = path.join(klasor, 'manifest.json');
  let m = { countries: {} };
  try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* yeni */ }
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
function gitKaydet(kok, mesaj, yollar) {
  const calis = (args) => execFileSync('git', args, { cwd: kok, stdio: 'pipe' }).toString();
  try {
    const mevcutlar = yollar.filter((y) => fs.existsSync(path.resolve(kok, y)));
    if (!mevcutlar.length) return;
    calis(['add', ...mevcutlar]);
    const degisen = calis(['diff', '--cached', '--name-only']).trim();
    if (!degisen) return;
    calis(['-c', 'user.name=trailopro-bot', '-c', 'user.email=bot@users.noreply.github.com', 'commit', '-m', mesaj.replace(/"/g, '')]);
    for (let i = 0; i < 4; i++) {
      try {
        calis(['pull', '--rebase', '-X', 'theirs', '-q']);
        calis(['push', '-q']);
        return;
      } catch {
        log('push yeniden deneniyor');
      }
    }
  } catch (e) {
    log('git hatası:', e.message);
  }
}

function birimler(ayar) {
  const liste = [];
  for (const kod of ILKELER) {
    if (kod === 'US') {
      for (const b of Object.keys(US_BOLGE)) {
        liste.push({ dosya: b, kod: b, iso2: US_BOLGE[b].map((s) => 'US-' + s) });
      }
    } else {
      liste.push({ dosya: kod, kod, iso1: kod });
    }
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
  const veriKlasorAd = pilot ? 'pilot' : 'data';
  const durumDosyaAd = path.join('tools', pilot ? 'durum-pilot.json' : 'durum.json');
  const veriKlasoru = path.join(ayar.kok, veriKlasorAd);
  const durumYol = path.join(ayar.kok, durumDosyaAd);
  fs.mkdirSync(veriKlasoru, { recursive: true });
  const durum = fs.existsSync(durumYol) ? JSON.parse(fs.readFileSync(durumYol, 'utf8')) : {};
  const bitis = Date.now() + ayar.sure * 60000;
  const saatDolduMu = () => Date.now() > bitis;
  const yenileMs = ayar.yenileGun * 86400000;
  const gitYollari = [veriKlasorAd, durumDosyaAd];

  fs.writeFileSync(durumYol, JSON.stringify(durum, null, 1));

  const sirali = birimler(ayar).sort(
    (a, b) => (Date.parse((durum[a.kod] || {}).harita || 0) || 0) - (Date.parse((durum[b.kod] || {}).harita || 0) || 0)
  );

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
      let yerelPoiIzgarasi = null;
      if (!harita) {
        log('>>', b.kod, 'taranıyor');
        const { ogeler, poiIzgarasi, kaynak } = await birimVerisiCek(b, ayar, kayitlar);
        yerelPoiIzgarasi = poiIzgarasi;
        const yeni = ogeler.map((e) => kayitOlustur(e, b.kod, kat)).filter(Boolean);
        const once = kayitlar.length;

        // Önceki dosyada sadece tek-dilli otomatik kayıt varsa, aynı ID'li yeni OSM kaydıyla 5 dile yükselt
        const yeniIdler = new Set(yeni.map((y) => y.id));
        const korunanEski = kayitlar.filter(
          (r) => !(yeniIdler.has(r.id) && r.notes && /^(Otomatik|Temel) derleme/.test(r.notes.note || '') && !r.notes.description_i18n)
        );
        const t = tekillestir(korunanEski.concat(yeni), ayar.esik);
        kayitlar = t.kalan;
        log(b.kod, 'kaynak:', kaynak, '| OSM:', yeni.length, '| önceki:', once, '| kalan:', kayitlar.length, '| elenen:', t.silinen);
        durum[b.kod] = { ...d, kaynak, harita: new Date().toISOString(), osm: yeni.length, elenen: t.silinen, sayi: kayitlar.length };
        delete durum[b.kod].hata;
        kaydet();
        if (ayar.commit) gitKaydet(ayar.kok, veriKlasorAd + ': ' + b.kod + ' taraması (' + kayitlar.length + ' nokta)', gitYollari);
      }

      const bitti = await zenginlestir(
        b,
        kayitlar,
        ayar,
        saatDolduMu,
        () => {
          kaydet();
          if (ayar.commit) gitKaydet(ayar.kok, veriKlasorAd + ': ' + b.kod + ' zenginleştirme (ara)', gitYollari);
        },
        yerelPoiIzgarasi
      );

      if (bitti) {
        durum[b.kod] = { ...durum[b.kod], tamam: new Date().toISOString() };
        delete durum[b.kod].hata;
      }
      kaydet();
      if (ayar.commit) gitKaydet(ayar.kok, veriKlasorAd + ': ' + b.kod + (bitti ? ' tamamlandı' : ' kısmen zenginleştirildi'), gitYollari);
    } catch (e) {
      log('!!', b.kod, 'hata:', e.message, '- atlandı, sonra yeniden denenecek');
      durum[b.kod] = { ...d, hata: e.message, sonDeneme: new Date().toISOString() };
      fs.writeFileSync(durumYol, JSON.stringify(durum, null, 1));
    }
  }
}

if (require.main === module) {
  calistir(argumanlar(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { mesafe, mesafeYaz, puan, tekillestir, kayitOlustur, kategoriHesapla, etiketMetni, yakinCevreMetni, konumMetni, temizYaz, manifestGuncelle, calistir, argumanlar, US_BOLGE, ILKELER, birimler };
