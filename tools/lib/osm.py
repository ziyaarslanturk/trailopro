"""Geofabrik/OSM: degisiklik kontrolu ve ulke verisini cekme. osm_cek.py (eski camp_fetch) yeniden kullanilir."""
import json
import os
import shutil
import sys
import time

from . import ortak

if str(ortak.ARAC) not in sys.path:
    sys.path.insert(0, str(ortak.ARAC))


def _modul():
    import osm_cek  # requests/osmium gerektirir; sadece gerektiginde yuklenir
    return osm_cek


def birim_yolu(cc):
    """Ulke kodu -> Geofabrik yolu. Bilinmiyorsa None."""
    m = _modul()
    if cc in m.REGIONS:
        return m.REGIONS[cc]
    g = m.TARGET_TO_GROUP.get(cc)
    return m.SPLITS[g]["path"] if g else None


def gecerli_ulkeler():
    m = _modul()
    return set(m.REGIONS) | {t for c in m.SPLITS.values() for t in c["targets"]}


def uzak_md5(cc, http=None):
    """Geofabrik md5; alinamazsa None (degisiklik yok sayilir)."""
    try:
        yol = birim_yolu(cc)
        if not yol:
            return None
        import requests
        http = http or requests
        url = f"{_modul().GF}/{yol}-latest.osm.pbf.md5"
        for i in range(3):
            try:
                r = http.get(url, timeout=30)
                p = r.text.split()
                if r.status_code == 200 and p:
                    return p[0]
            except Exception:
                pass
            time.sleep(3 * (i + 1))
    except Exception as e:
        ortak.log(f"  md5 hatasi {cc}: {e}")
    return None


def cek(cc):
    """Ulkenin taze OSM kamp satirlarini dondurur; basarisizsa None (cagiran veriyi degistirmez)."""
    m = _modul()
    for d in ("out", "cache", "work"):
        os.makedirs(d, exist_ok=True)
    hedef = f"out/{cc}.json"
    if os.path.exists(hedef):
        os.remove(hedef)
    if cc in m.REGIONS:
        m.process(cc, m.REGIONS[cc])
    elif cc in m.TARGET_TO_GROUP:
        g = m.TARGET_TO_GROUP[cc]
        for yol in [f"cache/{g}.json", f"out/{g}.json"] + [f"out/{t}.json" for t in m.SPLITS[g]["targets"]]:
            if os.path.exists(yol):
                os.remove(yol)  # eski grup onbellegi kullanilmasin
        m.run_split(g)
    else:
        return None
    satirlar = ortak.json_oku(hedef, None)
    shutil.rmtree("out", ignore_errors=True)
    return satirlar if isinstance(satirlar, list) else None
