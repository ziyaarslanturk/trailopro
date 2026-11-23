"""Yayin oncesi son kontrol. Bozuk kaydi duzeltir ya da eski surume dondurur; supheli dususte yayini durdurur."""
import copy

from . import ortak, zengin as Z


def temizle_gecici(k):
    k.pop("_bekle", None)
    m = k.get("_meta")
    if isinstance(m, dict):
        for a in [a for a, v in m.items() if v in (None, [], {}, "")]:
            del m[a]
        if not m:
            k.pop("_meta", None)


def kontrol_et(eski, yeni, ayar, cc, haric=0):
    """eski/yeni: kayit listeleri (eski None olabilir). haric: bu turda bilerek silinen (tekrar) kayit sayisi.
    Dondurur: (temiz_liste, rapor, yayinlanabilir_mi)."""
    rapor = {"atilan": 0, "geri_alinan_zengin": 0, "silinen_zengin": 0, "duzeltilen": 0, "tekrar_id": 0, "mesaj": []}
    eski_map = {k.get("id"): k for k in (eski or []) if isinstance(k, dict)}
    temiz, gorulen = [], set()
    for k in yeni:
        if not isinstance(k, dict):
            rapor["atilan"] += 1
            continue
        temizle_gecici(k)
        kid = k.get("id")
        if not isinstance(kid, str) or not kid or kid in gorulen:
            rapor["tekrar_id" if kid in gorulen else "atilan"] += 1
            continue
        if not ortak.gecerli_koordinat(k.get("latitude"), k.get("longitude")):
            # eski verideki bozuk koordinatli kayit korunur (kaybetmeyiz), yeni gelen atilir
            if kid not in eski_map:
                rapor["atilan"] += 1
                continue
        k["country_code"] = cc
        if not isinstance(k.get("notes"), dict):
            k["notes"] = {"description": None, "note": None}
        if isinstance(k["notes"].get("description"), str):
            d = Z.metin_temizle(k["notes"]["description"]) if k["notes"]["description"].startswith(("KONUM:", "OLANAKLAR:", "ÜCRET:", "YAKIN ÇEVRE:", "DOĞA")) else k["notes"]["description"]
            if d != k["notes"]["description"]:
                k["notes"]["description"] = d or None
                rapor["duzeltilen"] += 1
        z = k.get("zengin")
        if z is not None:
            if Z.zengin_sorunlari(z):
                z = Z.zengin_duzelt(copy.deepcopy(z))
                if Z.zengin_sorunlari(z):
                    onceki = (eski_map.get(kid) or {}).get("zengin")
                    if isinstance(onceki, dict) and not Z.zengin_sorunlari(onceki):
                        k["zengin"] = onceki
                        rapor["geri_alinan_zengin"] += 1
                    else:
                        k.pop("zengin", None)
                        rapor["silinen_zengin"] += 1
                else:
                    k["zengin"] = z
                    rapor["duzeltilen"] += 1
        gorulen.add(kid)
        temiz.append(k)
    ok = True
    if eski and len(eski) >= 20 and len(temiz) + haric < len(eski) * ayar["min_kayit_orani"]:
        ok = False
        rapor["mesaj"].append(f"kayit sayisi supheli dustu: {len(eski)} -> {len(temiz)} (bilerek silinen {haric})")
    if not temiz and eski:
        ok = False
        rapor["mesaj"].append("sonuc bos")
    return temiz, rapor, ok
