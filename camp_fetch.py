import json, os, subprocess, sys, time, hashlib
import requests

GF = "https://download.geofabrik.de"
REGIONS = {
    "TR": "europe/turkey", "DE": "europe/germany", "FR": "europe/france",
    "IT": "europe/italy", "ES": "europe/spain", "AT": "europe/austria",
    "CH": "europe/switzerland", "NL": "europe/netherlands", "BE": "europe/belgium",
    "GR": "europe/greece", "HR": "europe/croatia", "PT": "europe/portugal",
    "NO": "europe/norway", "SE": "europe/sweden",
    "GCC": "asia/gcc-states", "JO": "asia/jordan", "EG": "africa/egypt",
    "MA": "africa/morocco", "RU": "russia",
    "US_WEST": "north-america/us/west", "US_SOUTH": "north-america/us/south",
    "US_MIDWEST": "north-america/us/midwest",
    "US_NORTHEAST": "north-america/us/northeast",
    "US_PACIFIC": "north-america/us/pacific",
}
WORK, OUT = "work", "out"
os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)

def download(url, dest, retries=50):
    """Kaldigi yerden devam eden indirme (Range). Hata olursa bekleyip tekrar dener."""
    for attempt in range(retries):
        try:
            have = os.path.getsize(dest) if os.path.exists(dest) else 0
            h = {"Range": f"bytes={have}-"} if have else {}
            with requests.get(url, headers=h, stream=True, timeout=60) as r:
                if r.status_code == 416:
                    return
                r.raise_for_status()
                mode = "ab" if r.status_code == 206 else "wb"
                with open(dest, mode) as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            return
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
    if yes(t.get("supervised", "")) or
