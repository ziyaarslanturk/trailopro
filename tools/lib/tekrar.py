"""Birbirine N metreden (varsayilan 100) yakin noktalardan EN AZ bilgisi olanlari siler, bilgisini kalana ekler.
Zincirleme silme olmaz: kalan bir kayit yalnizca KENDINE N metre icindekileri siler."""
import math

from . import ortak

DILLER = ("tr", "en", "de", "ru", "ar")
YOK = (None, "", [], {})


def _say(x):
    """Bir degerdeki bos olmayan yaprak sayisi."""
    if isinstance(x, dict):
        return sum(_say(v) for v in x.values())
    if isinstance(x, list):
        return sum(_say(v) for v in x)
    return 0 if x in YOK or x is False else 1


def bilgi_puani(k):
    """Ne kadar cok dolu alan varsa o kadar yuksek. Kayit iceriginden hesaplanir (hizli, deterministik)."""
    p = 0
    nm = k.get("name") if isinstance(k.get("name"), dict) else {}
    p += sum(1 for d in DILLER if nm.get(d))
    p += 3 if k.get("name_local") else 0                      # adi olan, adsizdan degerli
    p += sum(1 for f in ("fee", "website", "phone") if k.get(f))
    nt = k.get("notes") if isinstance(k.get("notes"), dict) else {}
    p += min(len(nt.get("description") or "") // 80, 5) + (1 if nt.get("note") else 0)
    p += min(len(k.get("category_ids") or []), 5)
    z = k.get("zengin")
    if isinstance(z, dict):
        p += 2 + _say({a: v for a, v in z.items() if a not in ("surum", "tarih", "kaynak")})
    return p


def _mesafe(a, b):
    p1, p2 = math.radians(a["latitude"]), math.radians(b["latitude"])
    dp, dl = p2 - p1, math.radians(b["longitude"] - a["longitude"])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 12742000 * math.asin(math.sqrt(h))


def _birlestir(kal, sil):
    """sil kaydinin bilgisini kal kaydinin BOS alanlarina ekler; silinen kimligi hatirlatir."""
    kopya = set()
    nm = kal.get("name") if isinstance(kal.get("name"), dict) else {}
    sn = sil.get("name") if isinstance(sil.get("name"), dict) else {}
    for d in DILLER:
        if not nm.get(d) and sn.get(d):
            nm[d] = sn[d]
            kopya.add("name")
    if nm:
        kal["name"] = nm
    for f in ("name_local", "fee", "website", "phone"):
        if not kal.get(f) and sil.get(f):
            kal[f] = sil[f]
            kopya.add("name" if f == "name_local" else f)
    kn = kal.get("notes") if isinstance(kal.get("notes"), dict) else {"description": None, "note": None}
    sn_ = sil.get("notes") if isinstance(sil.get("notes"), dict) else {}
    for f in ("description", "note"):
        if not kn.get(f) and sn_.get(f):
            kn[f] = sn_[f]
    kal["notes"] = kn
    kal["category_ids"] = sorted(set(kal.get("category_ids") or []) | set(sil.get("category_ids") or []))
    if not isinstance(kal.get("zengin"), dict) and isinstance(sil.get("zengin"), dict):
        kal["zengin"] = sil["zengin"]
    km = kal["_meta"] if isinstance(kal.get("_meta"), dict) else {}
    sm = sil.get("_meta") if isinstance(sil.get("_meta"), dict) else {}
    km["birlesen"] = sorted(set(km.get("birlesen") or []) | {sil.get("id")} | set(sm.get("birlesen") or []))
    # kullanicinin girdigi bilgi kalana gectiyse OSM yenilemesi onu ezmesin
    if sm.get("kaynak") == "kullanici" or sm.get("kullanici_alanlari"):
        koru = set(km.get("kullanici_alanlari") or []) | (kopya & {"name", "fee", "website", "phone"})
        if koru:
            km["kullanici_alanlari"] = sorted(koru)
    if sm.get("ek_alanlar") and not km.get("ek_alanlar"):
        km["ek_alanlar"] = sm["ek_alanlar"]
    kal["_meta"] = km


def temizle(kayitlar, metre=100.0, max_oran=0.6):
    """kayitlar listesini YERINDE temizler. Dondurur: rapor sozlugu.
    Silinecek orani max_oran'i asarsa (veri hatasi suphesi) hicbir sey silmez."""
    rapor = {"silinen": 0, "kume": 0, "uygulanmadi": None, "ornek": []}
    gecerli = [k for k in kayitlar if isinstance(k, dict) and isinstance(k.get("id"), str)
               and ortak.gecerli_koordinat(k.get("latitude"), k.get("longitude"))]
    if len(gecerli) < 2:
        return rapor
    # 1) hucre izgarasi (hucre ~ metre'nin 2 kati)
    hl = metre * 2 / 111320.0
    izgara = {}
    for i, k in enumerate(gecerli):
        c = max(math.cos(math.radians(k["latitude"])), 0.05)
        izgara.setdefault((math.floor(k["latitude"] / hl), math.floor(k["longitude"] * c / hl)), []).append(i)

    def komsular(i):
        k = gecerli[i]
        c = max(math.cos(math.radians(k["latitude"])), 0.05)
        cx, cy = math.floor(k["latitude"] / hl), math.floor(k["longitude"] * c / hl)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in izgara.get((cx + dx, cy + dy), ()):
                    if j != i:
                        yield j

    # 2) en cok bilgisi olandan baslayarak: kalan, kendine yakin ve daha az bilgili olanlari siler
    puan = [bilgi_puani(k) for k in gecerli]
    sira = sorted(range(len(gecerli)), key=lambda i: (-puan[i], gecerli[i]["id"]))
    silindi, plan = set(), []
    for i in sira:
        if i in silindi:
            continue
        for j in komsular(i):
            if j not in silindi and _mesafe(gecerli[i], gecerli[j]) <= metre:
                # i kalir: j daha once merkez olsaydi i zaten silinmis olurdu, yani j'nin puani i'den dusuk/esit
                silindi.add(j)
                plan.append((i, j))
    if len(silindi) > len(gecerli) * max_oran:
        rapor["uygulanmadi"] = f"cok fazla silinecek ({len(silindi)}/{len(gecerli)}); veri hatasi suphesi"
        return rapor
    # 3) uygula: kalan kayda birlestir, silineni listeden cikar
    for i, j in plan:
        _birlestir(gecerli[i], gecerli[j])
        if len(rapor["ornek"]) < 5:
            rapor["ornek"].append(f"{gecerli[i]['id']} <- {gecerli[j]['id']}")
    sil_idler = {id(gecerli[j]) for j in silindi}
    kayitlar[:] = [k for k in kayitlar if id(k) not in sil_idler]
    rapor["silinen"] = len(silindi)
    rapor["kume"] = len({i for i, _ in plan})
    return rapor
