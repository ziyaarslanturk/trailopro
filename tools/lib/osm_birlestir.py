"""Taze OSM satirlarini calisma listesine (ham/) birlestirir. Kullanici verisini ve zenginlestirmeyi ezmez."""
import re

ID_OSM = re.compile(r"^[nwra]\d+$")
OSM_ALANLARI = ("name_local", "fee", "website", "phone")
DILLER = ("tr", "en", "de", "ru", "ar")


def _meta(k):
    m = k.get("_meta")
    if not isinstance(m, dict):
        m = {}
        k["_meta"] = m
    return m


def _gecerli(r):
    from . import ortak
    return (isinstance(r, dict) and isinstance(r.get("id"), str) and r["id"]
            and ortak.gecerli_koordinat(r.get("latitude"), r.get("longitude")))


def birlestir(kayitlar, osm, ayar, cc):
    """kayitlar listesini YERINDE gunceller. Dondurur: rapor sozlugu (uygulanamazsa uygulanmadi=True)."""
    rapor = {"yeni": 0, "guncellenen": 0, "birlesen_atlandi": 0, "kaldirilan": 0, "kayip_isaretli": 0, "uygulanmadi": None}
    osm = [r for r in osm if _gecerli(r)]
    mevcut = {k.get("id"): k for k in kayitlar if isinstance(k, dict)}
    osm_tipli = [k for k in kayitlar if isinstance(k, dict) and ID_OSM.match(str(k.get("id", "")))]
    # saglik kontrolu: bozuk/yarim indirme eski veriyi silmesin
    if len(osm_tipli) >= 20 and len(osm) < len(osm_tipli) * ayar["osm_min_oran"]:
        rapor["uygulanmadi"] = f"supheli_dusus eski={len(osm_tipli)} yeni={len(osm)}"
        return rapor
    if not osm and osm_tipli:
        rapor["uygulanmadi"] = "osm_bos"
        return rapor

    birlesen = set()
    for k in kayitlar:
        if isinstance(k, dict) and isinstance(k.get("_meta"), dict):
            birlesen.update(k["_meta"].get("birlesen") or [])
    osm_idler = set()
    for r in osm:
        rid = r["id"]
        osm_idler.add(rid)
        k = mevcut.get(rid)
        if k is None:
            if rid in birlesen:
                rapor["birlesen_atlandi"] += 1
                continue
            yeni = dict(r)
            yeni["country_code"] = cc
            yeni["notes"] = yeni.get("notes") if isinstance(yeni.get("notes"), dict) else {"description": None, "note": None}
            yeni["category_ids"] = list(yeni.get("category_ids") or [])
            kayitlar.append(yeni)
            mevcut[rid] = yeni
            rapor["yeni"] += 1
            continue
        m = k.get("_meta") if isinstance(k.get("_meta"), dict) else {}
        koru = set(m.get("kullanici_alanlari") or [])
        degisti = False
        if "konum" not in koru and (k.get("latitude") != r["latitude"] or k.get("longitude") != r["longitude"]):
            k["latitude"], k["longitude"] = r["latitude"], r["longitude"]
            degisti = True
        for f in OSM_ALANLARI:
            if f not in koru and r.get(f) and k.get(f) != r[f]:
                k[f] = r[f]
                degisti = True
        if "name" not in koru and isinstance(r.get("name"), dict):
            ad = k.get("name") if isinstance(k.get("name"), dict) else {}
            for d in DILLER:
                if r["name"].get(d) and ad.get(d) != r["name"][d]:
                    ad[d] = r["name"][d]
                    degisti = True
            k["name"] = ad
        yeni_kat = sorted(set(k.get("category_ids") or []) | set(r.get("category_ids") or []))
        if yeni_kat != (k.get("category_ids") or []):
            k["category_ids"] = yeni_kat
            degisti = True
        nt = k.get("notes") if isinstance(k.get("notes"), dict) else None
        if nt is not None and not nt.get("description") and isinstance(r.get("notes"), dict) and r["notes"].get("description"):
            nt["description"] = r["notes"]["description"]
            degisti = True
        if isinstance(k.get("_meta"), dict) and "osm_kayip" in k["_meta"]:
            del k["_meta"]["osm_kayip"]
            degisti = True
        if degisti:
            rapor["guncellenen"] += 1

    # OSM'den kaybolanlar: hemen silme, ust uste N yenilemede yoksa sil (kullanici verisi tasiyorsa asla)
    kalan = []
    for k in kayitlar:
        rid = k.get("id") if isinstance(k, dict) else None
        if isinstance(rid, str) and ID_OSM.match(rid) and rid not in osm_idler:
            m = _meta(k)
            m["osm_kayip"] = int(m.get("osm_kayip") or 0) + 1
            rapor["kayip_isaretli"] += 1
            if m["osm_kayip"] >= ayar["osm_kayip_siniri"] and not m.get("kullanici_alanlari") and m.get("kaynak") != "kullanici":
                rapor["kaldirilan"] += 1
                continue
        kalan.append(k)
    kayitlar[:] = kalan
    return rapor
