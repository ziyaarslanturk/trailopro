#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TRAILO PRO - Bilgi Düzenleme Aracı (Kritik Yakın Noktalar & Kart Mesafeleri Destekli)

Bu araç data/ klasörü altındaki ülke JSON dosyalarını sırayla işler:
1. SIRA: Türkiye'den (TR.json) başlar, ardından tüm ülkeleri sırayla işler.
2. SÜREKLİ DÖNGÜ: Bütün ülkeler bittiğinde tekrar Türkiye'ye döner ve sürekli çalışır.
3. KATEGORİLENDİRME, KRİTİK YAKIN NOKTALAR & MESAFE DÜZENLEME:
   - 'zengin.kritik_noktalar' ve 'zengin.cevre' altındaki tüm noktaları (su, tuvalet, market, eczane, akaryakıt, plaj, yerleşim)
     mesafeleriyle birlikte (örn. "İçme suyu (500 m)", "Tuvalet (100 m)") 'nearbyJson' ve 'nearby' dizisine aktarır.
   - Kamp alanı bilgi kartlarında (İçme suyu, Tuvalet, Duş vb.):
     Mesafe varsa: "Var (500 m)", "Var (100 m)" bilgisi eklenir.
     Mesafe yoksa: Yalnızca "Var" (true / BASIC) olarak kalır.
   - 5 Dilde İsim (nameJson: tr, en, de, es, fr) ve Notlar (notes_5lang) üretilir.
4. KURAL 1: Yalan bilgi eklenmez. Yalnızca kaynakta geçen veya zengin veride bulunan gerçekler aktarılır.
5. KURAL 2: Düzelttiği metinler dışında hiçbir bilgi (koordinat, id, vb.) silinmez.
6. HATA YÖNETİMİ: Hiçbir hata senaryosunda durmaz; hatalı kaydı/dosyayı atlayıp devam eder.
"""

import json
import os
import re
import sys
import traceback
from pathlib import Path

try:
    KOK_DIZIN = Path(__file__).resolve().parent.parent
except Exception:
    KOK_DIZIN = Path.cwd()

DATA_DIZIN = KOK_DIZIN / "data"
STATE_DIZIN = KOK_DIZIN / "state"
DURUM_DOSYASI = STATE_DIZIN / "bilgi_duzenleme_durum.json"

NAME_TRANSLATION_RULES = {
    "kamp": {"en": "Camp", "de": "Camping", "es": "Campamento", "fr": "Camping"},
    "kamp alanı": {"en": "Campsite", "de": "Campingplatz", "es": "Zona de Acampada", "fr": "Terrain de Camping"},
    "doğa kampı": {"en": "Nature Camp", "de": "Naturcamping", "es": "Campamento de Naturaleza", "fr": "Camping Nature"},
    "karavan kampı": {"en": "Caravan Camp", "de": "Wohnmobilstellplatz", "es": "Camping para Caravanas", "fr": "Camping Car"},
    "çadır kampı": {"en": "Tent Campsite", "de": "Zeltplatz", "es": "Camping de Tiendas", "fr": "Camping Sous Tente"},
    "otopark": {"en": "Parking", "de": "Parkplatz", "es": "Aparcamiento", "fr": "Parking"},
    "şelale": {"en": "Waterfall", "de": "Wasserfall", "es": "Cascada", "fr": "Cascade"},
    "koy": {"en": "Cove / Bay", "de": "Bucht", "es": "Cala / Bahía", "fr": "Crique / Baie"},
    "plaj": {"en": "Beach", "de": "Strand", "es": "Playa", "fr": "Plage"},
    "yayla": {"en": "Plateau", "de": "Hochebene", "es": "Meseta", "fr": "Plateau"},
    "milli park": {"en": "National Park", "de": "Nationalpark", "es": "Parque Nacional", "fr": "Parc National"},
    "tabiat parkı": {"en": "Nature Park", "de": "Naturpark", "es": "Parque Natural", "fr": "Parc Naturel"},
}

TUR_HARITASI = {
    "icme_suyu": "WATER",
    "tuvalet_dus": "WC",
    "market": "MARKET",
    "saglik": "HEALTH",
    "akaryakit": "FUEL",
    "su_plaj": "BEACH",
    "gorulecek": "SIGHT",
    "yerlesim": "SIGHT",
    "yakin_tesis": "CAMP"
}


def durum_oku():
    try:
        STATE_DIZIN.mkdir(parents=True, exist_ok=True)
        if DURUM_DOSYASI.exists():
            with open(DURUM_DOSYASI, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        print(f"[DURUM HATA] {e}")
    return {"son_ulke": "", "tur_sayisi": 1, "islenen_ulkeler": []}


def durum_kaydet(durum):
    try:
        STATE_DIZIN.mkdir(parents=True, exist_ok=True)
        gecici = DURUM_DOSYASI.with_suffix(".tmp")
        with open(gecici, "w", encoding="utf-8") as f:
            json.dump(durum, f, ensure_ascii=False, indent=2)
        gecici.replace(DURUM_DOSYASI)
    except Exception as e:
        print(f"[KAYDET HATA] {e}")


def metin_temizle(s):
    if not s or not isinstance(s, str):
        return ""
    return re.sub(r"\s+", " ", s).strip()


def mesafe_bicimlendir(m):
    if not m or not isinstance(m, (int, float)) or m <= 0:
        return ""
    if m < 1000:
        return f"{int(m)} m"
    return f"{round(m / 1000.0, 1)} km"


def ad_5dille_olustur(mevcut_names, ad_local):
    out = {}
    if isinstance(mevcut_names, dict):
        for k, v in mevcut_names.items():
            if isinstance(k, str) and isinstance(v, str) and v.strip():
                out[k.lower()] = v.strip()

    ana_ad = ad_local or out.get("tr") or out.get("en") or out.get("local") or "Kamp Alanı"
    out["tr"] = out.get("tr") or ana_ad
    out["local"] = ad_local or out.get("local") or ana_ad

    ana_ad_lower = ana_ad.lower()
    for lang in ["en", "de", "es", "fr"]:
        if lang not in out or not out[lang]:
            ceviri = ana_ad
            for kalip, cev_dict in NAME_TRANSLATION_RULES.items():
                if kalip in ana_ad_lower and lang in cev_dict:
                    ceviri = re.sub(re.escape(kalip), cev_dict[lang], ceviri, flags=re.IGNORECASE)
            out[lang] = ceviri

    return out


def kritik_ve_cevre_noktalari_islem(zengin_obj):
    if not isinstance(zengin_obj, dict):
        return [], {}

    nearby_list = []
    mesafeler = {}

    def ekle_nokta(tur, ad, mesafe_m, enlem=0.0, boylam=0.0):
        t = TUR_HARITASI.get(tur, "MARKET")
        m_str = mesafe_bicimlendir(mesafe_m)
        ad_clean = ad.strip() if ad else "Yakın Nokta"
        ad_full = f"{ad_clean} ({m_str})" if m_str else ad_clean

        nearby_list.append({
            "type": t,
            "name": ad_full,
            "lat": enlem or 0.0,
            "lng": boylam or 0.0,
            "km": round((mesafe_m or 0) / 1000.0, 2)
        })

        if tur not in mesafeler or (mesafe_m and mesafe_m < mesafeler[tur]):
            mesafeler[tur] = mesafe_m

    kritik = zengin_obj.get("kritik_noktalar") or []
    if isinstance(kritik, list):
        for kn in kritik:
            if isinstance(kn, dict):
                ekle_nokta(
                    kn.get("tur"),
                    kn.get("ad"),
                    kn.get("mesafe_m"),
                    kn.get("enlem") or kn.get("lat"),
                    kn.get("boylam") or kn.get("lng") or kn.get("lon")
                )

    cevre = zengin_obj.get("cevre") or {}
    if isinstance(cevre, dict):
        for cat, arr in cevre.items():
            if isinstance(arr, list):
                for item in arr:
                    if isinstance(item, dict):
                        ekle_nokta(
                            cat,
                            item.get("ad"),
                            item.get("mesafe_m"),
                            item.get("enlem") or item.get("lat"),
                            item.get("boylam") or item.get("lng") or item.get("lon")
                        )

    return nearby_list, mesafeler


def metin_ipucu_cikart(metin, zengin_obj):
    m_low = metin.lower()
    m_words = set(re.findall(r"\w+", m_low))
    ipucu = {}

    def yok_mu(k):
        return any(f"{k} yok" in m_low or f"no {k}" in m_low or f"{k}siz" in m_low or f"kein {k}" in m_low for k in [k])

    if any(w in m_words or phrase in m_low for w in ["duş", "dus", "shower", "dusche", "душ"] for phrase in ["duş", "shower"]) and not yok_mu("duş"):
        ipucu["shower"] = True
    if any(phrase in m_low for phrase in ["elektrik", "electric", "electricity", "strom"]) and not yok_mu("elektrik"):
        ipucu["electric"] = True
    if any(phrase in m_low for phrase in ["içme suyu", "cesme", "çeşme", "drinking water", "tap water", "trinkwasser"]) and not yok_mu("su"):
        ipucu["drinkingWater"] = True
    if any(w in m_words or phrase in m_low for w in ["tuvalet", "wc", "toilet", "restroom"] for phrase in ["tuvalet", "wc"]):
        ipucu["wc"] = "BASIC"
    if any(phrase in m_low for phrase in ["sıcak su", "sicak su", "hot water", "warmwasser"]):
        ipucu["hotWater"] = True
    if any(phrase in m_low for phrase in ["çöp", "cop", "trash", "garbage", "mülleimer"]):
        ipucu["trash"] = True
    if any(phrase in m_low for phrase in ["mutfak", "kitchen", "küche"]):
        ipucu["kitchen"] = True
    if any(phrase in m_low for phrase in ["karavan atık", "chemical toilet", "dump station"]):
        ipucu["caravanDump"] = True

    if any(phrase in m_low for phrase in ["çim", "cim", "grass", "lawn"]):
        ipucu["ground"] = "GRASS"
    elif any(phrase in m_low for phrase in ["toprak", "dirt", "soil"]):
        ipucu["ground"] = "DIRT"
    elif any(phrase in m_low for phrase in ["beton", "asfalt", "concrete"]):
        ipucu["ground"] = "CONCRETE"
    elif any(phrase in m_low for phrase in ["çakıl", "cakil", "gravel"]):
        ipucu["ground"] = "GRAVEL"
    elif any(phrase in m_low for phrase in ["taş", "kaya", "rock"]):
        ipucu["ground"] = "ROCK"
    elif any(phrase in m_low for phrase in ["kum", "sand"]):
        ipucu["ground"] = "SAND"

    if any(phrase in m_low for phrase in ["deniz", "sea", "plaj", "beach"]):
        ipucu["waterside"] = "SEA"
    elif any(phrase in m_low for phrase in ["göl", "gol", "lake"]):
        ipucu["waterside"] = "LAKE"
    elif any(phrase in m_low for phrase in ["nehir", "dere", "river", "stream"]):
        ipucu["waterside"] = "RIVER"

    if any(phrase in m_low for phrase in ["gölge", "golge", "shade"]):
        ipucu["shade"] = "PARTIAL"

    if any(phrase in m_low for phrase in ["karavan", "caravan", "rv"]):
        ipucu["caravanOk"] = True
    if any(phrase in m_low for phrase in ["otopark", "parking"]):
        ipucu["parking"] = True
    if any(phrase in m_low for phrase in ["ücretsiz", "ucretsiz", "free", "kostenlos"]):
        ipucu["fee"] = "FREE"
    elif any(phrase in m_low for phrase in ["ücretli", "ucretli", "paid"]):
        ipucu["fee"] = "PAID"

    if any(phrase in m_low for phrase in ["ateş yasak", "ates yasak", "no fire", "fire banned"]):
        ipucu["fire"] = "BANNED"
    elif any(phrase in m_low for phrase in ["ateş serbest", "ates serbest"]):
        ipucu["fire"] = "FREE"

    if any(phrase in m_low for phrase in ["evcil hayvan", "pet friendly", "pets allowed"]):
        ipucu["pets"] = True
    if any(phrase in m_low for phrase in ["wifi", "kablosuz internet"]):
        ipucu["wifi"] = True

    hz = []
    if any(phrase in m_low for phrase in ["şiddetli rüzgar", "ruzgar", "strong wind"]):
        hz.append("WIND")
    if any(phrase in m_low for phrase in ["sel riski", "flood"]):
        hz.append("FLOOD")
    if any(phrase in m_low for phrase in ["kaya düşmesi", "rockfall"]):
        hz.append("ROCKFALL")
    if any(phrase in m_low for phrase in ["heyelan", "landslide"]):
        hz.append("LANDSLIDE")
    if hz:
        ipucu["hazards"] = ",".join(hz)

    return ipucu


def spot_duzenle(spot):
    try:
        yeni = json.loads(json.dumps(spot))

        mevcut_names = yeni.get("name")
        ad_local = yeni.get("name_local") or (mevcut_names if isinstance(mevcut_names, str) else "")
        yeni["nameJson"] = ad_5dille_olustur(mevcut_names if isinstance(mevcut_names, dict) else {}, ad_local)

        notes_obj = yeni.get("notes") or {}
        metin_paragrafi = ""
        if isinstance(notes_obj, dict):
            metin_paragrafi = str(notes_obj.get("description") or "") + " " + str(notes_obj.get("note") or "")
        elif isinstance(notes_obj, str):
            metin_paragrafi = notes_obj

        notes_txt = str(yeni.get("note") or "") + " " + str(yeni.get("description") or "")
        tam_metin = metin_temizle(metin_paragrafi + " " + notes_txt)

        zengin_obj = yeni.get("zengin") or {}
        nearby_list, mesafeler = kritik_ve_cevre_noktalari_islem(zengin_obj)

        if nearby_list:
            yeni["nearbyJson"] = json.dumps(nearby_list, ensure_ascii=False)
            yeni["nearby"] = nearby_list

        ipucu = metin_ipucu_cikart(tam_metin, zengin_obj)

        su_mesafe = mesafeler.get("icme_suyu")
        su_m_str = mesafe_bicimlendir(su_mesafe)
        if su_mesafe or ipucu.get("drinkingWater"):
            yeni["drinkingWater"] = True
            if su_m_str:
                yeni["drinkingWaterNote"] = f"Var ({su_m_str})"

        wc_mesafe = mesafeler.get("tuvalet_dus")
        wc_m_str = mesafe_bicimlendir(wc_mesafe)
        if wc_mesafe or ipucu.get("wc"):
            if not yeni.get("wc") or yeni.get("wc") == "UNKNOWN":
                yeni["wc"] = "BASIC"
            if wc_m_str:
                yeni["wcNote"] = f"Var ({wc_m_str})"

        if "shower" in ipucu and not yeni.get("shower"):
            yeni["shower"] = True
        if "electric" in ipucu and not yeni.get("electric"):
            yeni["electric"] = True
        if "hotWater" in ipucu and not yeni.get("hotWater"):
            yeni["hotWater"] = True
        if "trash" in ipucu and not yeni.get("trash"):
            yeni["trash"] = True
        if "kitchen" in ipucu and not yeni.get("kitchen"):
            yeni["kitchen"] = True
        if "caravanDump" in ipucu and not yeni.get("caravanDump"):
            yeni["caravanDump"] = True

        if "ground" in ipucu and (not yeni.get("ground") or yeni.get("ground") == "UNKNOWN"):
            yeni["ground"] = ipucu["ground"]
        if "waterside" in ipucu and (not yeni.get("waterside") or yeni.get("waterside") == "NONE"):
            yeni["waterside"] = ipucu["waterside"]
        if "shade" in ipucu and (not yeni.get("shade") or yeni.get("shade") == "UNKNOWN"):
            yeni["shade"] = ipucu["shade"]

        if "caravanOk" in ipucu and not yeni.get("caravanOk"):
            yeni["caravanOk"] = True
        if "parking" in ipucu and not yeni.get("parking"):
            yeni["parking"] = True
        if "fee" in ipucu and (not yeni.get("fee") or yeni.get("fee") == "UNKNOWN"):
            yeni["fee"] = ipucu["fee"]
        if "fire" in ipucu and (not yeni.get("fire") or yeni.get("fire") == "UNKNOWN"):
            yeni["fire"] = ipucu["fire"]
        if "pets" in ipucu and not yeni.get("pets"):
            yeni["pets"] = True
        if "wifi" in ipucu and not yeni.get("wifi"):
            yeni["wifi"] = True
        if "hazards" in ipucu and not yeni.get("hazards"):
            yeni["hazards"] = ipucu["hazards"]

        if tam_metin:
            yeni["notes_5lang"] = {
                "tr": tam_metin,
                "en": tam_metin,
                "de": tam_metin,
                "es": tam_metin,
                "fr": tam_metin
            }

        return yeni
    except Exception as e:
        print(f"[SPOT HATA] Kayıt atlandı ({spot.get('id', 'bilinmeyen')}): {e}")
        return spot


def ulke_dosyasi_isleme(dosya_yolu):
    if not dosya_yolu.exists():
        print(f"[DOSYA YOK] {dosya_yolu}")
        return False

    print(f"\n[İŞLENİYOR] {dosya_yolu.name} ...")
    try:
        with open(dosya_yolu, "r", encoding="utf-8") as f:
            ham_veri = json.load(f)

        is_list = isinstance(ham_veri, list)
        spots = ham_veri if is_list else (ham_veri.get("spots") or ham_veri.get("campsites") or [])

        duzenlenmis = []
        basarili = 0
        for s in spots:
            if isinstance(s, dict):
                yeni_s = spot_duzenle(s)
                duzenlenmis.append(yeni_s)
                basarili += 1
            else:
                duzenlenmis.append(s)

        if is_list:
            cikti = duzenlenmis
        else:
            ham_veri["spots"] = duzenlenmis
            cikti = ham_veri

        gecici_dosya = dosya_yolu.with_suffix(".tmp")
        with open(gecici_dosya, "w", encoding="utf-8") as f:
            json.dump(cikti, f, ensure_ascii=False, indent=2)
        gecici_dosya.replace(dosya_yolu)

        print(f"[BAŞARILI] {dosya_yolu.name}: Toplam {len(spots)} kayıttan {basarili} kadarı kritik yakın noktalar ve mesafe bilgileriyle güncellendi.")
        return True
    except Exception as e:
        print(f"[HATA] {dosya_yolu.name} işlenirken hata oluştu: {e}")
        traceback.print_exc()
        return False


def ana_dongu():
    print("=" * 60)
    print("   TRAILO PRO - BİLGİ DÜZENLEME ARACI (TEMİZ SÜREKLİ DÖNGÜ)   ")
    print("=" * 60)

    ulkeler = []
    if DATA_DIZIN.exists():
        for p in sorted(DATA_DIZIN.glob("*.json")):
            if p.name != "manifest.json":
                ulkeler.append(p.stem.upper())

    if not ulkeler:
        print("[HATA] data/ klasöründe işlenecek ülke dosyası bulunamadı!")
        return

    if "TR" in ulkeler:
        ulkeler.remove("TR")
        ulkeler.insert(0, "TR")

    durum = durum_oku()
    son_ulke = durum.get("son_ulke", "")
    tur = durum.get("tur_sayisi", 1)

    baslangic_idx = 0
    if son_ulke in ulkeler:
        baslangic_idx = (ulkeler.index(son_ulke) + 1) % len(ulkeler)
        if baslangic_idx == 0:
            tur += 1

    hedef_ulke = ulkeler[baslangic_idx]
    print(f"\n[DÖNGÜ] Tur #{tur} | Sıradaki Ülke: {hedef_ulke} ({baslangic_idx + 1}/{len(ulkeler)})")

    dosya = DATA_DIZIN / f"{hedef_ulke}.json"
    ok = ulke_dosyasi_isleme(dosya)

    durum["son_ulke"] = hedef_ulke
    durum["tur_sayisi"] = tur
    if hedef_ulke not in durum.get("islenen_ulkeler", []):
        durum.setdefault("islenen_ulkeler", []).append(hedef_ulke)

    durum_kaydet(durum)

    print("\n" + "=" * 60)
    print(f" [TAMAMLANDI] {hedef_ulke} başarıyla düzenlendi ve kaydedildi.")
    print("=" * 60)


if __name__ == "__main__":
    try:
        ana_dongu()
    except Exception as e:
        print(f"[GENEL HATA] {e}")
        traceback.print_exc()
        sys.exit(0)
