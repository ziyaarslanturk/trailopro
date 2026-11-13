import json, os, subprocess, sys, time, hashlib, math
import requests

GF = "https://download.geofabrik.de"
REGIONS = {
    "TR": "europe/turkey", "DE": "europe/germany", "FR": "europe/france",
    "IT": "europe/italy", "ES": "europe/spain", "AT": "europe/austria",
    "CH": "europe/switzerland", "NL": "europe/netherlands", "BE": "europe/belgium",
    "GR": "europe/greece", "HR": "europe/croatia", "PT": "europe/portugal",
    "NO": "europe/norway", "SE": "europe/sweden",
    "JO": "asia/jordan", "EG": "africa/egypt",
    "MA": "africa/morocco", "RU": "russia",
    "US_WEST": "north-america/us-west", "US_SOUTH": "north-america/us-south",
    "US_MIDWEST": "north-america/us-midwest",
    "US_NORTHEAST": "north-america/us-northeast",
    "US_PACIFIC": "north-america/us-pacific",
    # --- YENI: tek dosyasi olan ulkeler ---
    "CZ": "europe/czech-republic", "DK": "europe/denmark",
    "FI": "europe/finland", "LU": "europe/luxembourg",
    "PL": "europe/poland", "DZ": "africa/algeria", "TN": "africa/tunisia",
}

# --- YENI: tek dosyadan inip ulke sinirlarina gore bolunen bolgeler ---
# Cikti: targets listesindeki her ulke icin ayri OUT/<KOD>.json
SPLITS = {
    "GCC":   {"path": "asia/gcc-states",
              "targets": ["OM", "BH", "AE", "QA", "KW", "SA"]},
    "GB_IE": {"path": "europe/britain-and-ireland",
              "targets": ["GB", "IE"]},
}
TARGET_TO_GROUP = {t: g for g, c in SPLITS.items() for t in c["targets"]}

WORK, OUT, CACHE = "work", "out", "cache"
os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)

# Ulke sinirlari (Natural Earth 1:10m admin-0). Bir kez inip cache/ icinde kalir.
NE_URLS = [
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson",
    "https://github.com/nvkelso/natural-earth-vector/raw/master/geojson/ne_10m_admin_0_countries.geojson",
]
NE_FILE = f"{CACHE}/ne_countries.geojson"
SNAP_KM = 20  # hicbir sinira dusmeyen (kiyi/deniz) nokta en yakin ulkeye en fazla bu kadar uzaksa atanir


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


# ======================= YENI: ULKE BOLME ADIMI =======================

def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))

def iso2(props):
    p = {k.upper(): v for k, v in props.items()}
    for k in ("ISO_A2_EH", "ISO_A2"):
        v = p.get(k)
        if isinstance(v, str) and len(v) == 2 and v.isalpha():
            return v.upper()
    return None

def load_countries():
    from shapely.geometry import shape
    from shapely import make_valid

    data = None
    if os.path.exists(NE_FILE):
        try:
            with open(NE_FILE, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            os.remove(NE_FILE)
    if data is None:
        part = NE_FILE + ".part"
        for u in NE_URLS:
            try:
                print(f"  sinir verisi indiriliyor: {u}")
                if os.path.exists(part): os.remove(part)
                download(u, part, retries=5)
                with open(part, encoding="utf-8") as f:
                    data = json.load(f)
                os.replace(part, NE_FILE)
                break
            except Exception as e:
                print(f"  olmadi ({e})")
        if data is None:
            raise RuntimeError(
                "Ulke sinir dosyasi indirilemedi. ne_10m_admin_0_countries.geojson "
                f"dosyasini elle indirip {NE_FILE} olarak koyun ve tekrar calistirin.")

    labels, geoms = [], []
    for i, ft in enumerate(data["features"]):
        if not ft.get("geometry"): continue
        g = shape(ft["geometry"])
        if not g.is_valid: g = make_valid(g)
        labels.append(iso2(ft["properties"]) or f"?{i}")
        geoms.append(g)
    return labels, geoms

def snap_country(pt, tree, geoms, labels):
    """Hicbir poligonun icine dusmeyen nokta: SNAP_KM icindeki en yakin ulke."""
    from shapely.ops import nearest_points
    best, best_d = None, SNAP_KM
    for j in tree.query(pt.buffer(0.5)).tolist():
        q = nearest_points(geoms[j], pt)[0]
        d = haversine_km(pt.y, pt.x, q.y, q.x)
        if d <= best_d:
            best, best_d = labels[j], d
    return best

def split_rows(rows, targets):
    import numpy as np
    import shapely
    from shapely import STRtree

    labels, geoms = load_countries()
    tree = STRtree(geoms)
    buckets = {t: [] for t in targets}
    if not rows:
        return buckets, 0, 0

    pts = shapely.points(np.array([[r["longitude"], r["latitude"]] for r in rows]))
    pi, gi = tree.query(pts, predicate="intersects")
    hits = {}
    for a, b in zip(pi.tolist(), gi.tolist()):
        hits.setdefault(a, []).append(labels[b])

    snapped = dropped = 0
    for i, r in enumerate(rows):
        h = hits.get(i)
        if h:
            c = next((x for x in h if x in buckets), h[0])
        else:
            c = snap_country(pts[i], tree, geoms, labels)
            if c in buckets: snapped += 1
        if c in buckets:
            r2 = dict(r); r2["country_code"] = c
            buckets[c].append(r2)
        else:
            dropped += 1  # hedef disindaki ulke (ornek: Yemen, Iran, Man Adasi) veya acik deniz
    return buckets, snapped, dropped

def run_split(group):
    cfg = SPLITS[group]
    cached = f"{CACHE}/{group}.json"
    legacy = f"{OUT}/{group}.json"
    if os.path.exists(legacy):
        os.replace(legacy, cached)  # eski GCC.json out/ icindeyse cache/ e tasi, yeniden indirme
    elif not os.path.exists(cached):
        process(group, cfg["path"])
        os.replace(legacy, cached)
    with open(cached, encoding="utf-8") as f:
        rows = json.load(f)

    print(f"[{group}] {len(rows)} nokta ulkelere bolunuyor: {', '.join(cfg['targets'])}")
    buckets, snapped, dropped = split_rows(rows, cfg["targets"])
    for code, items in buckets.items():
        dest = f"{OUT}/{code}.json"
        if os.path.exists(dest):
            print(f"[{code}] zaten var, atlaniyor"); continue
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, separators=(",", ":"))
        print(f"[{code}] {len(items)} nokta -> {dest}")
    print(f"[{group}] kiyidan en yakin ulkeye atanan: {snapped}, hedef disi birakilan: {dropped}")


def expand(args):
    out = []
    for a in args:
        a = a.upper()
        out += SPLITS[a]["targets"] if a in SPLITS else [a]
    return out

if __name__ == "__main__":
    everything = list(REGIONS) + [t for g in SPLITS.values() for t in g["targets"]]
    todo = expand(sys.argv[1:]) if sys.argv[1:] else everything
    done_groups = set()
    for code in todo:
        if os.path.exists(f"{OUT}/{code}.json"):
            print(f"[{code}] zaten var, atlaniyor"); continue
        if code in REGIONS:
            process(code, REGIONS[code])
        elif code in TARGET_TO_GROUP:
            g = TARGET_TO_GROUP[code]
            if g not in done_groups:
                run_split(g); done_groups.add(g)
        else:
            print(f"[{code}] bilinmeyen kod, atlaniyor")
