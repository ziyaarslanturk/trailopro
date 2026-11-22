"""'zengin' alaninin semasi: eski duz metinden donusum, dogrulama, otomatik duzeltme, bekleyen kayit tespiti."""
import copy
import json
import math
import re
import sys

from . import ortak

if str(ortak.ARAC) not in sys.path:
    sys.path.insert(0, str(ortak.ARAC))
import zengin_donustur as _eski  # noqa: E402  (dogrulanmis eski ayristirici)

_E = ortak.json_oku(ortak.ARAC / "etiketler.json", {"tur": {}, "sinif": {}, "cevre_sinif": {}, "kritik_sinif": {}})
TUR_TR = _E["tur"]
CEVRE_ETIKET = _E["cevre_sinif"]
KRITIK_ETIKET = _E["kritik_sinif"]
KRITIK_TURLER = set(KRITIK_ETIKET)
CEVRE_ANAHTARLAR = set(CEVRE_ETIKET)
DOGA_ANAHTARLAR = {"kuslar", "memeliler", "surungenler", "bitkiler"}
DIL = {"TR": "tr", "DE": "de", "AT": "de", "CH": "de", "FR": "fr", "ES": "es", "IT": "it", "PT": "pt", "NL": "nl", "PL": "pl", "RU": "ru"}
HAM_ETIKET = re.compile(r"^[a-z0-9]+(_[a-z0-9]+)+$")


# ---------------------------------------------------------------- ad temizleme
def temiz_ad(ad, sinif_etiketi):
    """Ham OSM etiketini (drinking_water, kiosk...) Turkceye cevirir; cevrilemezse sinif etiketine, o da yoksa None."""
    if not isinstance(ad, str):
        return None
    a = ad.strip()
    if not a:
        return sinif_etiketi
    if a in TUR_TR:
        return TUR_TR[a] or sinif_etiketi
    if HAM_ETIKET.match(a):
        return sinif_etiketi
    return a


def _nokta(n, sinif_etiketi):
    if not isinstance(n, dict):
        return None
    ad = temiz_ad(n.get("ad"), sinif_etiketi)
    m = n.get("mesafe_m")
    if not ad or isinstance(m, bool) or not isinstance(m, (int, float)) or m < 0:
        return None
    o = {"ad": ad, "mesafe_m": int(m)}
    la, lo = n.get("enlem"), n.get("boylam")
    if isinstance(la, (int, float)) and isinstance(lo, (int, float)) and ortak.gecerli_koordinat(la, lo):
        o["enlem"], o["boylam"] = round(float(la), 6), round(float(lo), 6)
    return o


# ---------------------------------------------------------------- eski metinden v2
def v2_cevir(z, cc):
    """zengin_donustur.donustur() ciktisini (surum 1) guncel semaya cevirir."""
    k = z.get("konum") or {}
    ol, kisit, kapasite = [], [], None
    for o in z.get("olanaklar") or []:
        low = o.lower()
        if low.endswith("yasak"):
            kisit.append(o[:1].upper() + o[1:])
        elif low.startswith("kapasite "):
            kapasite = o[9:].strip() or None
        else:
            ol.append(o[:1].upper() + o[1:])
    saat = z.get("calisma_saati")
    u = z.get("ucret")
    durum, ayrinti = None, []
    if isinstance(u, str):
        for parca in [p.strip() for p in u.split(";") if p.strip()]:
            if parca == "Ücretli":
                durum = "ucretli"
            elif parca == "Ücretsiz":
                durum = "ucretsiz"
            else:
                parca = re.sub(r"^sitede geçen fiyat ifadeleri:\s*", "", parca)
                ayrinti += [x.strip() for x in parca.split(" | ") if x.strip()]
    kritik = []
    for n in z.get("kritik_noktalar") or []:
        tur = n.get("tur")
        c = _nokta(n, KRITIK_ETIKET.get(tur))
        if c and tur in KRITIK_TURLER:
            kritik.append({"tur": tur, **c})
    cevre = {}
    for anahtar, liste in (z.get("cevre") or {}).items():
        if anahtar in CEVRE_ANAHTARLAR:
            temiz = [c for c in (_nokta(n, CEVRE_ETIKET.get(anahtar)) for n in liste) if c]
            if temiz:
                cevre[anahtar] = temiz
    doga = {}
    for anahtar, liste in (z.get("doga") or {}).items():
        oge = [{"bilimsel": x.get("bilimsel"), "tr": None, "en": x.get("ingilizce")} for x in liste if isinstance(x, dict) and x.get("bilimsel")]
        if anahtar in DOGA_ANAHTARLAR and oge:
            doga[anahtar] = oge
    kor = z.get("koruma_alani")
    if isinstance(kor, dict) and kor.get("ad"):
        kor = {"ad": kor["ad"], "uyari": kor.get("uyari") or _eski.KORUMA_UYARI, "yaklasik": True}
    else:
        kor = None
    hk = z.get("hakkinda")
    if isinstance(hk, dict) and hk.get("metin"):
        hk = dict(hk)
        hk["url"] = "https://%s.wikipedia.org/wiki/%s" % (DIL.get(cc, "en"), str(hk.get("baslik", "")).replace(" ", "_"))
    else:
        hk = None
    kay = z.get("kaynak") if isinstance(z.get("kaynak"), dict) else {}
    tarih = kay.get("tarih") or ortak.bugun()
    return {
        "surum": 1, "tarih": tarih,
        "konum": {"adres": k.get("adres"), "il": None, "ilce": None, "koy": None, "ulke": None, "irtifa_m": k.get("irtifa_m")},
        "olanaklar": ol, "kisitlar": kisit, "kapasite": kapasite, "calisma_saati": saat,
        "sebeke": {"wifi": True if any(re.search(r"wi-?fi", o, re.I) for o in ol) else None,
                   "yirmidort_yedi": (saat.strip() == "24/7") if isinstance(saat, str) else None},
        "ucret": {"durum": durum, "ayrinti": ayrinti},
        "kritik_noktalar": kritik, "cevre": cevre, "doga": doga, "koruma_alani": kor, "hakkinda": hk,
        "iletisim": {"sosyal": [], "eposta": []}, "osm_notu": None,
        "ek_notlar": list(z.get("ek_notlar") or []),
        "kaynak": {"tarih": tarih, "kaynaklar": list(kay.get("kaynaklar") or []), "dogrulandi": bool(kay.get("dogrulandi", False)),
                   "eksik_adimlar": [], "deneme": {}, "alanlar": {}, "eski_metin": True},
    }


def toplu_cevir(kayitlar, cc):
    """zengin'i olmayan ama eski duz metni olan kayitlari cevirir. Dondurur: (cevrilen, sorunlu)."""
    cevrilen = sorunlu = 0
    for k in kayitlar:
        if isinstance(k.get("zengin"), dict):
            continue
        try:
            z = _eski.donustur(k)
            if z is None:
                continue
            if _eski.kayit_kontrol(k, z):
                sorunlu += 1
                continue
            v2 = v2_cevir(z, cc)
            if zengin_sorunlari(v2):
                sorunlu += 1
                continue
            k["zengin"] = v2
            cevrilen += 1
        except Exception:
            sorunlu += 1
    return cevrilen, sorunlu


# ---------------------------------------------------------------- dogrulama
def _sayi(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _nokta_sorun(n, yol, tur_gerekli):
    s = []
    if not isinstance(n, dict):
        return [yol + ":nesne_degil"]
    if not isinstance(n.get("ad"), str) or not n["ad"].strip():
        s.append(yol + ":ad")
    elif n["ad"] in TUR_TR or HAM_ETIKET.match(n["ad"]):
        s.append(yol + ":ham_etiket")
    if not _sayi(n.get("mesafe_m")) or n["mesafe_m"] < 0:
        s.append(yol + ":mesafe")
    if tur_gerekli and n.get("tur") not in KRITIK_TURLER:
        s.append(yol + ":tur")
    if ("enlem" in n or "boylam" in n) and not ortak.gecerli_koordinat(n.get("enlem"), n.get("boylam")):
        s.append(yol + ":koordinat")
    return s


def zengin_sorunlari(z):
    """Sorun listesi dondurur; bos liste = gecerli."""
    if not isinstance(z, dict):
        return ["zengin:nesne_degil"]
    s = []
    if not isinstance(z.get("surum"), int) or z["surum"] < 1:
        s.append("surum")
    for a in ("konum", "cevre", "doga", "sebeke", "ucret", "iletisim", "kaynak"):
        if not isinstance(z.get(a), dict):
            s.append(a + ":sozluk_degil")
    for a in ("olanaklar", "kisitlar", "kritik_noktalar", "ek_notlar"):
        if not isinstance(z.get(a), list):
            s.append(a + ":liste_degil")
    if s:
        return s
    if any(not isinstance(x, str) for x in z["olanaklar"] + z["kisitlar"]):
        s.append("olanaklar:metin_degil")
    for i, n in enumerate(z["kritik_noktalar"]):
        s += _nokta_sorun(n, f"kritik[{i}]", True)
    for a, liste in z["cevre"].items():
        if a not in CEVRE_ANAHTARLAR or not isinstance(liste, list):
            s.append(f"cevre.{a}:gecersiz")
            continue
        for i, n in enumerate(liste):
            s += _nokta_sorun(n, f"cevre.{a}[{i}]", False)
    for a, liste in z["doga"].items():
        if a not in DOGA_ANAHTARLAR or not isinstance(liste, list):
            s.append(f"doga.{a}:gecersiz")
            continue
        for x in liste:
            if not isinstance(x, dict) or not isinstance(x.get("bilimsel"), str) or not x["bilimsel"].strip():
                s.append(f"doga.{a}:bilimsel")
    if z["ucret"].get("durum") not in (None, "ucretli", "ucretsiz"):
        s.append("ucret.durum")
    kor = z.get("koruma_alani")
    if kor is not None and not (isinstance(kor, dict) and isinstance(kor.get("ad"), str)):
        s.append("koruma_alani")
    hk = z.get("hakkinda")
    if hk is not None and not (isinstance(hk, dict) and isinstance(hk.get("metin"), str)):
        s.append("hakkinda")
    return s


def zengin_duzelt(z):
    """Ham etiket gibi kucuk sorunlari yerinde onarir (kritik/cevre listelerini temizler). Gecersiz ogeyi atar."""
    if not isinstance(z, dict):
        return z
    if isinstance(z.get("kritik_noktalar"), list):
        yeni = []
        for n in z["kritik_noktalar"]:
            if isinstance(n, dict) and n.get("tur") in KRITIK_TURLER:
                c = _nokta(n, KRITIK_ETIKET.get(n["tur"]))
                if c:
                    o = {"tur": n["tur"], **c}
                    if n.get("alt") in ("tuvalet", "dus"):
                        o["alt"] = n["alt"]
                    yeni.append(o)
        z["kritik_noktalar"] = yeni
    if isinstance(z.get("cevre"), dict):
        yeni = {}
        for a, liste in z["cevre"].items():
            if a in CEVRE_ANAHTARLAR and isinstance(liste, list):
                t = [c for c in (_nokta(n, CEVRE_ETIKET.get(a)) for n in liste) if c]
                if t:
                    yeni[a] = t
        z["cevre"] = yeni
    return z


# ---------------------------------------------------------------- metin temizligi (eski uygulamalar icin duz metin)
_BOS_BASLIK = re.compile(r"^(KONUM|OLANAKLAR|ÜCRET|YAKIN ÇEVRE|DOĞA[^:]*|KORUMA ALANI[^:]*)\s*:\s*\.?\s*$")
_BOS_ALT = re.compile(r"(?:(?<=\. )|^)[A-Za-zÇĞİÖŞÜçğıöşü/ ]+: \.(?=\s|$)")


def metin_temizle(m):
    """'Yakin tesis: .' gibi bos parcalari ve bos satirlari atar."""
    if not isinstance(m, str):
        return m
    out = []
    for satir in m.split("\n"):
        satir = _BOS_ALT.sub("", satir).strip()
        satir = re.sub(r"\.\s*\.", ".", satir)
        if satir and not _BOS_BASLIK.match(satir):
            out.append(satir)
    return "\n".join(out)


# ---------------------------------------------------------------- bekleyen kayit
def faz_belirle(k, ayar):
    """Kayit motorda hangi fazda islenmeli? None = guncel, dokunma."""
    z = k.get("zengin")
    if not isinstance(z, dict):
        return "yeni"
    surum = z.get("surum") if isinstance(z.get("surum"), int) else 0
    kay = z.get("kaynak") if isinstance(z.get("kaynak"), dict) else {}
    if surum < ayar["hedef_surum"]:
        return "yukselt" if kay.get("eski_metin") else "tazele"
    deneme = kay.get("deneme") if isinstance(kay.get("deneme"), dict) else {}
    if any((deneme.get(a, 0) or 0) < ayar["deneme_siniri"] for a in (kay.get("eksik_adimlar") or [])):
        return "tamir"
    if ortak.gun_farki(z.get("tarih")) > ayar["yenile_gun"]:
        return "tazele"
    return None


def bekleyen_say(kayitlar, ayar):
    return sum(1 for k in kayitlar if isinstance(k, dict) and faz_belirle(k, ayar))
