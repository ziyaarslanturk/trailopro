import json, os, subprocess, sys, time, hashlib
import requests

GF = "https://download.geofabrik.de"
REGIONS = {
    # Mevcut ülkeler
    "TR": "europe/turkey", "DE": "europe/germany", "FR": "europe/france",
    "IT": "europe/italy", "ES": "europe/spain", "AT": "europe/austria",
    "CH": "europe/switzerland", "NL": "europe/netherlands", "BE": "europe/belgium",
    "GR": "europe/greece", "HR": "europe/croatia", "PT": "europe/portugal",
    "NO": "europe/norway", "SE": "europe/sweden",
    "GCC": "asia/gcc-states", "JO": "asia/jordan", "EG": "africa/egypt",
    "MA": "africa/morocco", "RU": "russia",
    "US_WEST": "north-america/us-west", "US_SOUTH": "north-america/us-south",
    "US_MIDWEST": "north-america/us-midwest",
    "US_NORTHEAST": "north-america/us-northeast",
    "US_PACIFIC": "north-america/us-pacific",
    
    # Eklenen ülkeler (Geofabrik dosya adlandırmasına göre uygun yollar)
    "OM": "asia/oman",
    "CZ": "europe/czech-republic",
    "IE": "europe/ireland-and-northern-ireland",
    "BH": "asia/gcc-states", # Geofabrik'te Bahreyn GCC içinde geçer
    "AE": "asia/gcc-states", # Geofabrik'te BAE GCC içinde geçer
    "GB": "europe/great-britain",
    "DZ": "africa/algeria",
    "DK": "europe/denmark",
    "FI": "europe/finland",
    "QA": "asia/gcc-states", # Geofabrik'te Katar GCC içinde geçer
    "KW": "asia/gcc-states", # Geofabrik'te Kuveyt GCC içinde geçer
    "LU": "europe/luxembourg",
    "PL": "europe/poland",
    "SA": "asia/gcc-states", # Geofabrik'te Suudi Arabistan GCC içinde geçer
    "TN": "africa/tunisia"
}

# Not: GCC (Körfez Ülkeleri - Suudi Arabistan, BAE, Umman, Kuveyt, Katar, Bahreyn vb.) 
# Geofabrik üzerinde tek bir dosya olarak (asia/gcc-states.osm.pbf) sunulduğu için,
# Bu ülkeler tek tek değil, mevcut GCC bölgesi (asia/gcc-states) indirilerek işlenebilir.
# Umman'ın "asia/oman" adında ayrı dosyası da olsa da, genellikle bölge bazlı
# indirme tercih edilir. Mevcut kodda GCC zaten tanımlı, bu yüzden GCC indirildiğinde
# SA, AE, QA, BH, KW ülkelerinin verileri de gelecektir.

WORK, OUT = "work", "out"
os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)

def download(url, dest, retries=50):
    """Kaldigi yerden devam eden indirme. 404 olursa hemen durur."""
    for attempt in range(retries):
        try:
            have = os.path.getsize(dest) if os.path.exists(dest) else 0
            h = {"Range": f"bytes={have}-"} if have else {}
            with requests.get(url, headers=h, stream=True, timeout=60) as r:
                if r.status_code == 404:
                    raise FileNotFoundError("404 adres yanlis: " + url)
                if r.status_code == 416:
                    return
                r.raise_for_status()
                mode = "ab" if r.status_code == 206 else "wb"
                with open(dest, mode) as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            return
        except FileNotFoundError:
            raise
        except Exception as e:
            wait = min(60, 2 ** min(attempt, 6))
            print(f"  hata ({e}); {wait}s sonra devam...")
            time.sleep(wait)
    raise RuntimeError("indirme basarisiz: " + url)

def verify_md5(pbf, url):
    expected = None
    for i in range(5):
        try:
            r = requests.get(url + ".md5", timeout=60)
            parts = r.text.split()
            if r.status_code == 200 and parts:
                expected = parts[0]
                break
        except Exception as e:
            print(f"  md5 alinamadi ({e})")
        time.sleep(10 * (i + 1))
    if expected is None:
        print("  md5 hic alinamadi, osmium ile dosya kontrol ediliyor")
        return subprocess.run(["osmium", "fileinfo", pbf],
                              capture_output=True).returncode == 0
    h = hashlib.md5()
    with open(pbf, "rb") as f:
        for b in iter(lambda: f.read(1 << 24), b""):
            h.update(b)
    return h.hexdigest() == expected

def yes(v): return v in ("yes", "designated", "permissive", "true")

def build_categories(t):
    c = []
    if t.get("tents") != "no" and (t.get("tourism") == "camp_site" or yes(t.get("tents", ""))): c.append(1)
    if t.get("tourism") == "caravan_site" or yes(t.get("caravans", "")) or yes(t.get("motorhome", "")): c.append(2)
    if yes(t.get("drinking_water", "")): c.append(3)
    if yes(t.get("power_supply", "")): c.append(4)
    if yes(t.get("openfire", "")) or yes(t.get("campfire", "")) or yes(t.get("fireplace", "")): c.append(5)
    if yes(t.get("toilets", "")): c.append(6)
    if yes(t.get("shower", "")): c.append(7)
    if yes(t.get("shop", "")) or yes(t.get("restaurant", "")) or yes(t.get("food", "")): c.append(8)
    if t.get("internet_access") in ("wlan", "yes", "wifi"): c.append(10)
    if yes(t.get("parking", "")) or t.get("capacity:parking"): c.append(11)
    if yes(t.get("dog", "")) or yes(t.get("pets", "")): c.append(12)
    if yes(t.get("fishing", "")): c.append(15)
    if yes(t.get("supervised", "")) or yes(t.get("security", "")): c.append(16)
    if yes(t.get("beach", "")) or t.get("natural") == "beach": c.append(17)
    if yes(t.get("bbq", "")) or yes(t.get("barbecue", "")): c.append(18)
    if yes(t.get("playground", "")): c.append(19)
    if yes(t.get("firewood", "")): c.append(20)
    if yes(t.get("horse", "")) or yes(t.get("riding", "")): c.append(22)
    if yes(t.get("4wd_only", "")): c.append(23)
    if yes(t.get("swimming", "")) or yes(t.get("swimming_pool", "")): c.append(24)
    return c

def centroid(geom):
    t, co = geom["type"], geom["coordinates"]
    if t == "Point": return co[1], co[0]
    pts = []
    def walk(x):
        if isinstance(x[0], (int, float)): pts.append(x)
        else:
            for y in x: walk(y)
    walk(co)
    return sum(p[1] for p in pts) / len(pts), sum(p[0] for p in pts) / len(pts)

def process(code, path):
    pbf = f"{WORK}/{code}.osm.pbf"
    filt = f"{WORK}/{code}.camp.osm.pbf"
    gj = f"{WORK}/{code}.geojson"
    url = f"{GF}/{path}-latest.osm.pbf"

    print(f"[{code}] indiriliyor: {url}")
    download(url, pbf)
    if not verify_md5(pbf, url):
        os.remove(pbf); raise RuntimeError(f"{code}: dosya dogrulanamadi, tekrar calistirin")

    subprocess.run(["osmium", "tags-filter", pbf, "nwr/tourism=camp_site,caravan_site",
                    "-o", filt, "--overwrite"], check=True)
    subprocess.run(["osmium", "export", filt, "-o", gj, "--overwrite",
                    "-f", "geojson", "--add-unique-id=type_id"], check=True)

    rows = []
    with open(gj, encoding="utf-8") as f:
        for ft in json.load(f)["features"]:
            t = ft["properties"]
            if t.get("tourism") not in ("camp_site", "caravan_site"): continue
            lat, lon = centroid(ft["geometry"])
            rows.append({
                "id": ft.get("id") or t.get("@id"),
                "country_code": code,
                "latitude": round(lat, 6), "longitude": round(lon, 6),
                "name": {l: t.get(f"name:{l}") or (t.get("name") if l == "en" and not t.get("name:en") else None)
                         for l in ("tr", "en", "de", "ru", "ar")},
                "name_local": t.get("name"),
                "fee": t.get("fee"),
                "website": t.get("website") or t.get("contact:website"),
                "phone": t.get("phone") or t.get("contact:phone"),
                "notes": {"description": t.get("description"), "note": t.get("note")},
                "category_ids": build_categories(t),
            })
    with open(f"{OUT}/{code}.json", "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[{code}] {len(rows)} nokta -> {OUT}/{code}.json")
    for p in (pbf, filt, gj): os.remove(p)

if __name__ == "__main__":
    todo = sys.argv[1:] or list(REGIONS)
    
    # Körfez ülkeleri GCC'de birleşiktir. Gereksiz indirmeleri engellemek için GCC listede varsa, alt ülkelerini todo'dan çıkar
    if "GCC" in todo:
        for gcc_country in ["BH", "AE", "QA", "KW", "SA"]:
            if gcc_country in todo:
                todo.remove(gcc_country)
                print(f"[{gcc_country}] GCC bölgesine dahil olduğu için atlanıyor (asia/gcc-states)")

    for code in todo:
        if os.path.exists(f"{OUT}/{code}.json"):
            print(f"[{code}] zaten var, atlaniyor")
            continue
        
        try:
            process(code, REGIONS[code])
        except Exception as e:
            print(f"[{code}] islenirken hata olustu: {e}")

    # Otomatik Git Push İşlemi
    try:
        print("\nGit depoya push işlemi başlatılıyor...")
        subprocess.run(["git", "add", f"{OUT}/*.json"], check=True)
        # Commit mesajı, değişiklik yoksa hata vermemesi için kontrol edilir
        status = subprocess.run(["git", "status", "--porcelain"], capture_output=True, text=True)
        if status.stdout.strip():
            subprocess.run(["git", "commit", "-m", "Yeni kamp alanlari verileri eklendi"], check=True)
            subprocess.run(["git", "push"], check=True)
            print("Git Push işlemi başarıyla tamamlandı.")
        else:
            print("Değişiklik yok, push işlemi atlandı.")
    except subprocess.CalledProcessError as e:
        print(f"Git işlemi sırasında bir hata oluştu: {e}")
