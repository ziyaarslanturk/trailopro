"""Geofabrik'te degisen bolgeleri bulur. Sadece md5 dosyalarini okur (cok hafif).
Kullanim: python check_updates.py [force]
  force: bos = sadece degisenler | ALL = hepsi | TR OM GCC ... = bunlar
Sonucu GITHUB_OUTPUT'a yazar: any, matrix, md5s
"""
import json, os, sys, time
import requests
from camp_fetch import REGIONS, SPLITS, GF, TARGET_TO_GROUP

STATE = "state/geofabrik.json"


def remote_md5(path):
    url = f"{GF}/{path}-latest.osm.pbf.md5"
    for i in range(3):
        try:
            r = requests.get(url, timeout=60)
            parts = r.text.split()
            if r.status_code == 200 and parts:
                return parts[0]
        except Exception as e:
            print(f"  md5 alinamadi ({e})")
        time.sleep(5 * (i + 1))
    return None


def units():
    u = dict(REGIONS)
    for g, cfg in SPLITS.items():
        u[g] = cfg["path"]
    return u


def forced(force):
    f = force.upper().split()
    if not f:
        return set()
    if "ALL" in f:
        return set(units())
    out = set()
    for c in f:
        out.add(TARGET_TO_GROUP.get(c, c))  # OM -> GCC, GB -> GB_IE
    return out


def main(force=""):
    state = {}
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            state = json.load(f)
    force_set = forced(force)
    changed = {}
    for code, path in units().items():
        md5 = remote_md5(path)
        if md5 is None:
            print(f"[{code}] md5 okunamadi, bu tur atlaniyor")
            continue
        if code in force_set or state.get(code) != md5:
            changed[code] = md5
            print(f"[{code}] degisti/zorunlu -> islenecek")
        else:
            print(f"[{code}] ayni")
    result = {
        "any": "true" if changed else "false",
        "matrix": json.dumps({"code": list(changed)}),
        "md5s": json.dumps(changed),
    }
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a", encoding="utf-8") as f:
            for k, v in result.items():
                f.write(f"{k}={v}\n")
    print(f"Islenecek bolge sayisi: {len(changed)}")
    return result


if __name__ == "__main__":
    main(" ".join(sys.argv[1:]))
