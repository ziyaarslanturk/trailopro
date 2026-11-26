#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
TRAILO PRO - Yeni Bilgi Düzenleme Botu
- Uzun metinlerden il, ilçe, imkanlar, zemin, ulaşım, kurallar vb. çıkarır.
- Kritik noktalara navigasyon bağlantısı (lat, lng, navUrl) ve mesafe kutucuğu için veri ekler.
- Orijinal metinlere dokunmaz.
- 5 dile çeviri/destek sağlar.
- Dosyaları sıkıştırarak (minified JSON) kaydeder.
- Türkiye'den (TR.json) başlar, hatalarda durmaz.
"""

import json
import os
import re
import traceback
from pathlib import Path

try:
    KOK_DIZIN = Path(__file__).resolve().parent.parent
except Exception:
    KOK_DIZIN = Path.cwd()

DATA_DIZIN = KOK_DIZIN / "data"
STATE_DIZIN = KOK_DIZIN / "state"
DURUM_DOSYASI = STATE_DIZIN / "yeni_bot_durum.json"

LANGS = ["tr", "en", "de", "es", "fr"]

DICT_TRANSLATE = {
    "Tuvalet": {"en": "Toilet", "de": "Toilette", "es": "Baño", "fr": "Toilettes"},
    "Duş": {"en": "Shower", "de": "Dusche", "es": "Ducha", "fr": "Douche"},
    "İçme Suyu": {"en": "Drinking Water", "de": "Trinkwasser", "es": "Agua Potable", "fr": "Eau Potable"},
    "Toprak zemin": {"en": "Dirt ground", "de": "Erdboden", "es": "Suelo de tierra", "fr": "Sol en terre"},
    "Çim zemin": {"en": "Grass ground", "de": "Grasboden", "es": "Suelo de hierba", "fr": "Sol en herbe"},
    "Çakıl zemin": {"en": "Gravel ground", "de": "Kiesboden", "es": "Suelo de grava", "fr": "Sol en gravier"},
    "Asfalt zemin": {"en": "Asphalt ground", "de": "Asphaltboden", "es": "Suelo de asfalto", "fr": "Sol en asphalte"},
    "Kum zemin": {"en": "Sand ground", "de": "Sandboden", "es": "Suelo de arena", "fr": "Sol de sable"},
    "Ormanlık alan": {"en": "Forest area", "de": "Waldgebiet", "es": "Área forestal", "fr": "Zone forestière"},
    "Dağlık alan": {"en": "Mountainous area", "de": "Bergiges Gebiet", "es": "Zona montañosa", "fr": "Zone montagneuse"},
    "Şebeke var": {"en": "Network available", "de": "Netz verfügbar", "es": "Red disponible", "fr": "Réseau disponible"},
    "Şebeke zayıf veya yok": {"en": "Weak/No network", "de": "Schwaches/Kein Netz", "es": "Red débil/nula", "fr": "Réseau faible/aucun"},
    "Araçla ulaşım": {"en": "Vehicle access", "de": "Zufahrt mit dem Fahrzeug", "es": "Acceso en vehículo", "fr": "Accès en véhicule"},
    "Toplu taşıma": {"en": "Public transport", "de": "Öffentliche Verkehrsmittel", "es": "Transporte público", "fr": "Transports en commun"},
    "Sadece yaya": {"en": "Pedestrian only", "de": "Nur für Fußgänger", "es": "Solo peatonal", "fr": "Piétons uniquement"},
    "Ücretsiz kamp": {"en": "Free camping", "de": "Kostenloses Camping", "es": "Acampada libre", "fr": "Camping gratuit"},
    "Ücretli kamp": {"en": "Paid camping", "de": "Kostenpflichtiges Camping", "es": "Camping de pago", "fr": "Camping payant"},
    "Ateş yakılabilir": {"en": "Fire allowed", "de": "Feuer erlaubt", "es": "Fuego permitido", "fr": "Feu autorisé"},
    "Ateş yakmak yasak": {"en": "Fire banned", "de": "Feuer verboten", "es": "Fuego prohibido", "fr": "Feu interdit"},
    "Yaban hayatı aktif": {"en": "Wildlife active", "de": "Wildtiere aktiv", "es": "Vida silvestre activa", "fr": "Faune active"},
    "Güvenlik/Jandarma devriyesi var": {"en": "Security/Patrol available", "de": "Sicherheitsdienst/Patrouille vorhanden", "es": "Seguridad/Patrulla disponible", "fr": "Sécurité/Patrouille disponible"}
}

def translate_dict(text_tr):
    if not text_tr: return {}
    out = {"tr": text_tr}
    for lang in ["en", "de", "es", "fr"]:
        out[lang] = DICT_TRANSLATE.get(text_tr, {}).get(lang, text_tr)
    return out

def get_state():
    try:
        STATE_DIZIN.mkdir(parents=True, exist_ok=True)
        if DURUM_DOSYASI.exists():
            with open(DURUM_DOSYASI, "r", encoding="utf-8") as f:
                return json.load(f)
    except:
        pass
    return {"last_country": "", "processed": []}

def save_state(st):
    try:
        STATE_DIZIN.mkdir(parents=True, exist_ok=True)
        with open(DURUM_DOSYASI, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print("State kaydetme hatasi:", e)

def parse_distances(m):
    if not m or m <= 0: return ""
    if m < 1000: return f"{int(m)} m"
    return f"{round(m/1000.0, 1)} km"

def extract_info_from_text(text):
    text_low = text.lower()
    extracted = {}
    
    # Zemin ve Arazi
    if "toprak" in text_low: extracted["ground"] = "Toprak zemin"
    elif "çim" in text_low or "cim " in text_low: extracted["ground"] = "Çim zemin"
    elif "çakıl" in text_low or "cakil" in text_low: extracted["ground"] = "Çakıl zemin"
    elif "kum" in text_low: extracted["ground"] = "Kum zemin"
    elif "asfalt" in text_low or "beton" in text_low: extracted["ground"] = "Asfalt zemin"
    elif "orman" in text_low: extracted["ground"] = "Ormanlık alan"
    elif "dağ" in text_low or "yayla" in text_low: extracted["ground"] = "Dağlık alan"

    # Ulaşım
    if "toplu taşıma" in text_low or "otobüs" in text_low or "dolmuş" in text_low:
        extracted["transport"] = "Toplu taşıma"
    elif "araçla" in text_low or "araba" in text_low or "otopark" in text_low:
        extracted["transport"] = "Araçla ulaşım"
    elif "yürüme" in text_low or "patika" in text_low or "yaya" in text_low:
        extracted["transport"] = "Sadece yaya"

    # Kurallar ve İzinler
    if "ücretsiz" in text_low or "bedava" in text_low: extracted["fee"] = "Ücretsiz kamp"
    elif "ücretli" in text_low or "fiyat" in text_low: extracted["fee"] = "Ücretli kamp"
    
    if "ateş yasak" in text_low or "ateş yakmak yasak" in text_low or "ateş yakılamaz" in text_low: extracted["fire"] = "Ateş yakmak yasak"
    elif "ateş yakılabilir" in text_low or "ateş serbest" in text_low or "ateş imkanı" in text_low: extracted["fire"] = "Ateş yakılabilir"

    # Şebeke
    if "şebeke çekiyor" in text_low or "telefon çekiyor" in text_low or "internet var" in text_low or "şebeke var" in text_low:
        extracted["network"] = "Şebeke var"
    elif "şebeke yok" in text_low or "çekmiyor" in text_low or "telefon çekmiyor" in text_low or "internet yok" in text_low:
        extracted["network"] = "Şebeke zayıf veya yok"

    # Güvenlik ve yaban hayatı
    if "ayı" in text_low or "yaban domuzu" in text_low or "kurt" in text_low or "yaban hayatı" in text_low:
        extracted["wildlife"] = "Yaban hayatı aktif"
    if "güvenli" in text_low or "jandarma" in text_low or "bekçi" in text_low or "güvenlik" in text_low:
        extracted["security"] = "Güvenlik/Jandarma devriyesi var"

    # İl / İlçe Yakalama Denemesi
    m_il = re.search(r'(?i)(?:il|şehir):\s*([\wÇĞİÖŞÜçğıöşü]+)', text)
    if m_il: extracted["city"] = m_il.group(1).strip()
    m_ilce = re.search(r'(?i)(?:ilçe):\s*([\wÇĞİÖŞÜçğıöşü]+)', text)
    if m_ilce: extracted["district"] = m_ilce.group(1).strip()
    
    # Kalabalık skoru
    if "çok kalabalık" in text_low or "yoğun" in text_low: extracted["crowd"] = 80
    elif "sakin" in text_low or "ıssız" in text_low or "kimsesiz" in text_low: extracted["crowd"] = 20
    else: extracted["crowd"] = 50

    return extracted

def process_spot(spot):
    try:
        new_spot = dict(spot)
        
        # Orijinal metinler birleşimi
        notes_obj = spot.get("notes", {})
        notes_str = str(spot.get("note", "")) + " " + str(spot.get("description", ""))
        if isinstance(notes_obj, dict):
            notes_str += " " + str(notes_obj.get("description", "")) + " " + str(notes_obj.get("note", ""))
        elif isinstance(notes_obj, str):
            notes_str += " " + notes_obj
            
        full_text = notes_str.strip()
        
        # Satır aralarından bilgi çıkarma
        ex = extract_info_from_text(full_text)
        
        # Orijinal yapıya dokunmadan detaylı architecture verisi oluşturma
        details = new_spot.get("details", {})
        if not isinstance(details, dict):
            details = {}
            
        if ex.get("city") or ex.get("district"):
            details["location"] = {"city": ex.get("city", ""), "district": ex.get("district", ""), "neighborhood": ""}
        if ex.get("ground"):
            details["groundTerrain"] = translate_dict(ex.get("ground"))
        if ex.get("transport"):
            details["transportation"] = translate_dict(ex.get("transport"))
            
        if ex.get("fee") or ex.get("fire"):
            rules = details.get("rulesPermissions", {})
            if isinstance(rules, dict):
                if ex.get("fee"): rules["fee"] = translate_dict(ex.get("fee"))
                if ex.get("fire"): rules["fire"] = translate_dict(ex.get("fire"))
                details["rulesPermissions"] = rules
                
        if ex.get("network"):
            details["networkStatus"] = translate_dict(ex.get("network"))
        if ex.get("wildlife"):
            details["securityWildlife"] = translate_dict(ex.get("wildlife"))
        elif ex.get("security"):
            details["securityWildlife"] = translate_dict(ex.get("security"))
            
        if ex.get("crowd"):
            details["crowdScore"] = ex.get("crowd")
            
        new_spot["details"] = details
        
        # Yakın Noktalar ve Mesafeler (Kritik Noktalar)
        zengin = spot.get("zengin", {})
        nearby_list = []
        
        def add_nearby(item, t_type):
            lat = item.get("enlem") or item.get("lat") or 0.0
            lng = item.get("boylam") or item.get("lng") or item.get("lon") or 0.0
            m = item.get("mesafe_m", 0)
            
            nb = {
                "name": item.get("ad", "Nokta"),
                "type": t_type,
                "lat": float(lat),
                "lng": float(lng),
                "distanceM": float(m) if m else 0.0,
                "distanceStr": parse_distances(m),
            }
            # Navigasyon linki
            if lat and lng and float(lat) != 0.0:
                nb["navUrl"] = f"google.navigation:q={lat},{lng}"
                nb["geoUrl"] = f"geo:{lat},{lng}?q={lat},{lng}"
            nearby_list.append(nb)

        for kn in zengin.get("kritik_noktalar", []):
            if isinstance(kn, dict): add_nearby(kn, kn.get("tur", "MARKET"))
            
        for cat, arr in zengin.get("cevre", {}).items():
            if isinstance(arr, list):
                for item in arr:
                    if isinstance(item, dict): add_nearby(item, cat)
                    
        if nearby_list:
            new_spot["nearbyJson"] = json.dumps(nearby_list, separators=(',', ':'), ensure_ascii=False)
            new_spot["nearby"] = nearby_list
            
        return new_spot
    except Exception as e:
        # Hata vermeden orijinali dön
        print("Spot hatasi:", e)
        return spot

def process_file(filepath):
    if not filepath.exists(): return False
    print(f"İşleniyor: {filepath.name}")
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        is_list = isinstance(data, list)
        spots = data if is_list else (data.get("spots") or data.get("campsites") or [])
        
        new_spots = []
        for s in spots:
            if isinstance(s, dict):
                new_spots.append(process_spot(s))
            else:
                new_spots.append(s)
                
        out_data = new_spots if is_list else data
        if not is_list: out_data["spots"] = new_spots
        
        # Sıkıştırma (minified)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(out_data, f, ensure_ascii=False, separators=(',', ':'))
        print(f"Başarılı: {filepath.name} (Sıkıştırıldı)")
        return True
    except Exception as e:
        print(f"Hata {filepath.name}: {e}")
        return False

def main():
    countries = []
    if not DATA_DIZIN.exists():
        print("Data dizini bulunamadı!")
        return

    for p in sorted(DATA_DIZIN.glob("*.json")):
        if p.name != "manifest.json":
            countries.append(p.name)
            
    if not countries:
        return
        
    if "TR.json" in countries:
        countries.remove("TR.json")
        countries.insert(0, "TR.json")
        
    state = get_state()
    last = state.get("last_country", "")
    
    idx = 0
    if last in countries:
        try:
            idx = (countries.index(last) + 1) % len(countries)
        except ValueError:
            idx = 0
            
    target = countries[idx]
    
    success = process_file(DATA_DIZIN / target)
    if success:
        state["last_country"] = target
        if target not in state.get("processed", []):
            state.setdefault("processed", []).append(target)
        save_state(state)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        traceback.print_exc()
