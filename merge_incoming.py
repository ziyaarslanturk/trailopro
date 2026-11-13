"""Fetch islerinin urettigi dosyalari osm/ katmanina isler, state/ i gunceller.
incoming/camp-<KOD>/<ULKE>.json  ->  osm/<ULKE>.json
"""
import glob, json, os, shutil
from camp_fetch import REGIONS, SPLITS

STATE = "state/geofabrik.json"
VALID = set(REGIONS) | {t for c in SPLITS.values() for t in c["targets"]}
MIN_RATIO = 0.5  # yeni dosya eskisinin yarisindan azsa (bozuk indirme suphesi) uzerine yazma


def count(path):
    try:
        with open(path, encoding="utf-8") as f:
            return len(json.load(f))
    except Exception:
        return None


def main():
    os.makedirs("osm", exist_ok=True)
    os.makedirs("state", exist_ok=True)

    # 1) Ilk calistirma: mevcut data/ dosyalari osm/ katmanina bir kez kopyalanir
    for p in glob.glob("data/*.json"):
        code = os.path.basename(p)[:-5]
        if code in VALID and not os.path.exists(f"osm/{code}.json"):
            shutil.copyfile(p, f"osm/{code}.json")

    # 2) Yeni uretilenleri isle
    md5s = json.loads(os.environ.get("MD5S") or "{}")
    state = {}
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            state = json.load(f)

    for d in sorted(glob.glob("incoming/camp-*")):
        key = os.path.basename(d)[len("camp-"):]
        ok = True
        for src in sorted(glob.glob(f"{d}/*.json")):
            code = os.path.basename(src)[:-5]
            if code not in VALID:
                continue
            dst = f"osm/{code}.json"
            new_n, old_n = count(src), count(dst)
            if new_n is None:
                print(f"[{code}] yeni dosya okunamadi, atlandi"); ok = False; continue
            if old_n and old_n >= 20 and new_n < old_n * MIN_RATIO:
                print(f"[{code}] UYARI: {old_n} -> {new_n} nokta, supheli dusus, eski dosya korundu")
                ok = False; continue
            shutil.copyfile(src, dst)
            print(f"[{code}] osm/ guncellendi: {old_n} -> {new_n}")
        if ok and key in md5s:
            state[key] = md5s[key]

    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
