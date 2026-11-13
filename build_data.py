"""osm/ katmanindan uygulamanin indirdigi data/ dosyalarini ve data/manifest.json u uretir.
(Ileride community/ katmani da burada birlestirilecek.)
"""
import glob, hashlib, json, os, shutil
from datetime import datetime, timezone
from camp_fetch import SPLITS

MANIFEST = "data/manifest.json"


def main():
    os.makedirs("data", exist_ok=True)
    # Eski ara dosyalar uygulamaya lazim degil
    for g in SPLITS:
        p = f"data/{g}.json"
        if os.path.exists(p):
            os.remove(p)

    old = {}
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            old = json.load(f)
    old_c = old.get("countries", {})
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    new_c = {}
    for p in sorted(glob.glob("osm/*.json")):
        code = os.path.basename(p)[:-5]
        with open(p, "rb") as f:
            raw = f.read()
        sha = hashlib.sha256(raw).hexdigest()
        dst = f"data/{code}.json"
        if not (os.path.exists(dst) and open(dst, "rb").read() == raw):
            shutil.copyfile(p, dst)
        prev = old_c.get(code, {})
        new_c[code] = {
            "count": len(json.loads(raw)),
            "size": len(raw),
            "sha256": sha,
            "updated": prev["updated"] if prev.get("sha256") == sha else now,
        }

    manifest = {"countries": new_c}
    if manifest != old:  # degisiklik yoksa dosyaya dokunma (gereksiz commit olmasin)
        with open(MANIFEST, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1, sort_keys=True)
        print("manifest guncellendi")
    else:
        print("manifest ayni")


if __name__ == "__main__":
    main()
