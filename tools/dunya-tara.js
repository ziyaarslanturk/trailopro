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
const VAR = (v)
