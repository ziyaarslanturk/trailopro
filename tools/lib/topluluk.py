"""Kullanicilarin Firebase'e ekledigi yerleri alir. Firestore (varsayilan) ya da Realtime Database.
Silme, veri GitHub'a basariyla yazildiktan SONRA yapilir (dongu.py temizle). Ayni kayit asla iki kez eklenmez."""
import json
import math
import os
import re

from . import ortak

BILINEN = {
    "id", "country_code", "country", "ulke", "latitude", "lat", "enlem", "longitude", "lng", "lon", "long", "boylam",
    "location", "konum", "geopoint", "coordinates", "name", "name_local", "ad", "isim", "fee", "ucret", "website", "web", "url",
    "phone", "telefon", "notes", "note", "description", "aciklama", "category_ids", "categories", "kategoriler",
    "created_at", "createdat", "timestamp", "uid", "user", "userid", "durum", "status",
}
DILLER = ("tr", "en", "de", "ru", "ar")
KONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


# ---------------------------------------------------------------- Firestore tip cozucu
def firestore_coz(v):
    if not isinstance(v, dict):
        return None
    if "stringValue" in v:
        return v["stringValue"]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "doubleValue" in v:
        return float(v["doubleValue"])
    if "booleanValue" in v:
        return bool(v["booleanValue"])
    if "nullValue" in v:
        return None
    if "timestampValue" in v:
        return v["timestampValue"]
    if "geoPointValue" in v:
        g = v["geoPointValue"]
        return {"latitude": g.get("latitude"), "longitude": g.get("longitude")}
    if "arrayValue" in v:
        return [firestore_coz(x) for x in (v["arrayValue"].get("values") or [])]
    if "mapValue" in v:
        return {k: firestore_coz(x) for k, x in (v["mapValue"].get("fields") or {}).items()}
    for k in ("referenceValue", "bytesValue"):
        if k in v:
            return str(v[k])
    return None


class Firebase:
    def __init__(self, tur="firestore", proje=None, koleksiyon="yeni_yerler", ulke_alani="country_code", rtdb_url=None, http=None, token_fn=None):
        self.tur, self.proje, self.koleksiyon, self.ulke_alani = tur, proje, koleksiyon, ulke_alani
        self.rtdb_url = (rtdb_url or "").rstrip("/")
        self._http, self._token_fn, self._tok = http, token_fn, None

    @classmethod
    def ortamdan(cls, env=None, http=None, token_fn=None):
        """Ayar yoksa None doner (adim sessizce atlanir)."""
        env = os.environ if env is None else env
        ham = (env.get("FIREBASE_SERVIS_HESABI") or "").strip()
        if not ham and token_fn is None:
            return None
        sa = {}
        if ham:
            try:
                sa = json.loads(ham)
            except Exception:
                ortak.uyari("FIREBASE_SERVIS_HESABI gecerli JSON degil; topluluk adimi atlandi")
                return None
        tur = (env.get("FIREBASE_TUR") or "firestore").lower()
        fb = cls(tur=tur, proje=env.get("FIREBASE_PROJE") or sa.get("project_id"),
                 koleksiyon=env.get("FIREBASE_KOLEKSIYON") or "yeni_yerler", ulke_alani=env.get("FIREBASE_ULKE_ALANI") or "country_code",
                 rtdb_url=env.get("FIREBASE_RTDB_URL"), http=http, token_fn=token_fn)
        if token_fn is None:
            fb._token_fn = lambda: _token_al(sa)
        if tur == "firestore" and not fb.proje:
            ortak.uyari("Firestore icin proje kimligi bulunamadi")
            return None
        if tur == "rtdb" and not fb.rtdb_url:
            ortak.uyari("RTDB icin FIREBASE_RTDB_URL gerekli")
            return None
        return fb

    # -- http
    def _h(self):
        if self._http is None:
            import requests
            self._http = requests
        return self._http

    def _baslik(self):
        if not self._tok:
            self._tok = self._token_fn()
        return {"Authorization": "Bearer " + self._tok}

    def _istek(self, yontem, url, **kw):
        son = None
        for i in range(3):
            try:
                r = getattr(self._h(), yontem)(url, headers=self._baslik(), timeout=60, **kw)
                if r.status_code == 401:
                    self._tok = None
                elif r.status_code < 500 and r.status_code != 429:
                    return r
                son = r
            except Exception as e:
                son = e
            import time
            time.sleep(2 * (i + 1))
        raise RuntimeError(f"Firebase istegi basarisiz: {url} {getattr(son, 'status_code', son)}")

    # -- firestore
    def _fs_sorgu(self, sq):
        url = f"https://firestore.googleapis.com/v1/projects/{self.proje}/databases/(default)/documents:runQuery"
        r = self._istek("post", url, json={"structuredQuery": sq})
        if r.status_code != 200:
            raise RuntimeError(f"Firestore sorgu hatasi {r.status_code}: {str(getattr(r, 'text', ''))[:200]}")
        return [x["document"] for x in r.json() if isinstance(x, dict) and "document" in x]

    def say(self):
        """Ulke -> bekleyen kayit sayisi."""
        sayim = {}
        if self.tur == "rtdb":
            for _, veri in self._rtdb_hepsi():
                c = str((veri or {}).get(self.ulke_alani) or "").upper()
                if c:
                    sayim[c] = sayim.get(c, 0) + 1
            return sayim
        docs = self._fs_sorgu({"from": [{"collectionId": self.koleksiyon}], "select": {"fields": [{"fieldPath": self.ulke_alani}]}, "limit": 5000})
        for d in docs:
            c = str(firestore_coz((d.get("fields") or {}).get(self.ulke_alani) or {}) or "").upper()
            if c:
                sayim[c] = sayim.get(c, 0) + 1
        return sayim

    def getir(self, cc, sinir=500):
        """[(ref, belge_id, veri)]"""
        if self.tur == "rtdb":
            return [(f"{self.koleksiyon}/{i}", i, v) for i, v in self._rtdb_hepsi()
                    if isinstance(v, dict) and str(v.get(self.ulke_alani) or "").upper() == cc][:sinir]
        docs = self._fs_sorgu({"from": [{"collectionId": self.koleksiyon}],
                               "where": {"fieldFilter": {"field": {"fieldPath": self.ulke_alani}, "op": "EQUAL", "value": {"stringValue": cc}}},
                               "limit": sinir})
        out = []
        for d in docs:
            ad = d.get("name", "")
            out.append((ad, ad.rsplit("/", 1)[-1], {k: firestore_coz(v) for k, v in (d.get("fields") or {}).items()}))
        return out

    def sil(self, ref):
        try:
            if self.tur == "rtdb":
                r = self._istek("delete", f"{self.rtdb_url}/{ref}.json")
            else:
                r = self._istek("delete", f"https://firestore.googleapis.com/v1/{ref}")
            return r.status_code in (200, 204, 404)
        except Exception as e:
            ortak.log(f"  silinemedi {ref}: {e}")
            return False

    def _rtdb_hepsi(self):
        r = self._istek("get", f"{self.rtdb_url}/{self.koleksiyon}.json")
        v = r.json() if r.status_code == 200 else None
        return list(v.items()) if isinstance(v, dict) else []


def _token_al(sa):
    from google.oauth2 import service_account
    from google.auth.transport.requests import Request
    c = service_account.Credentials.from_service_account_info(
        sa, scopes=["https://www.googleapis.com/auth/datastore", "https://www.googleapis.com/auth/firebase.database", "https://www.googleapis.com/auth/userinfo.email"])
    c.refresh(Request())
    return c.token


# ---------------------------------------------------------------- normalize
def _metin(x, n):
    if x is None or isinstance(x, (dict, list, bool)):
        return None
    s = KONTROL.sub("", str(x)).strip()
    return s[:n] or None


def _ilk(veri, anahtarlar):
    for a in anahtarlar:
        if veri.get(a) not in (None, ""):
            return veri[a]
    return None


def _fee(x):
    if isinstance(x, bool):
        return "yes" if x else "no"
    s = (_metin(x, 40) or "").lower()
    if s in ("yes", "evet", "true", "ucretli", "ücretli", "paid"):
        return "yes"
    if s in ("no", "hayir", "hayır", "false", "ucretsiz", "ücretsiz", "free"):
        return "no"
    return s or None


def _site(x):
    s = _metin(x, 300)
    if not s or " " in s:
        return None
    if re.match(r"^https?://", s, re.I):
        return s
    return "https://" + s if "." in s else None


def bbox_hesapla(kayitlar, tolerans):
    pts = [(k["latitude"], k["longitude"]) for k in kayitlar if isinstance(k, dict) and ortak.gecerli_koordinat(k.get("latitude"), k.get("longitude"))]
    if len(pts) < 20:
        return None
    la, lo = [p[0] for p in pts], [p[1] for p in pts]
    return (min(la) - tolerans, max(la) + tolerans, min(lo) - tolerans, max(lo) + tolerans)


def normalize(doc_id, veri, cc, bbox, bugun):
    """Dondurur: (kayit | None, red_nedeni | None, yeni_alan_anahtarlari)"""
    if not isinstance(veri, dict):
        return None, "veri_sozluk_degil", []
    v = {str(k): x for k, x in veri.items()}
    vl = {k.lower(): x for k, x in v.items()}
    lat, lon = _ilk(vl, ("latitude", "lat", "enlem")), _ilk(vl, ("longitude", "lng", "lon", "long", "boylam"))
    if lat is None or lon is None:
        g = _ilk(vl, ("location", "konum", "geopoint", "coordinates"))
        if isinstance(g, dict):
            gl = {str(k).lower(): x for k, x in g.items()}
            lat, lon = _ilk(gl, ("latitude", "lat")), _ilk(gl, ("longitude", "lng", "lon"))
    try:
        lat, lon = float(lat), float(lon)
    except Exception:
        return None, "koordinat_yok", []
    if not ortak.gecerli_koordinat(lat, lon):
        return None, "koordinat_gecersiz", []
    if bbox and not (bbox[0] <= lat <= bbox[1] and bbox[2] <= lon <= bbox[3]):
        return None, "ulke_bolgesi_disinda", []
    temiz = re.sub(r"[^A-Za-z0-9_-]", "", str(doc_id))[:60]
    if not temiz:
        return None, "id_gecersiz", []
    ad = {d: None for d in DILLER}
    yerel = None
    n = _ilk(vl, ("name", "ad", "isim"))
    if isinstance(n, dict):
        for d in DILLER:
            ad[d] = _metin(n.get(d), 120)
        yerel = _metin(n.get("local") or n.get("name_local") or next((x for x in n.values() if isinstance(x, str) and x.strip()), None), 120)
    else:
        yerel = _metin(n, 120)
        if yerel:
            ad["tr" if cc == "TR" else "en"] = yerel
    yerel = _metin(vl.get("name_local"), 120) or yerel
    notlar = vl.get("notes") if isinstance(vl.get("notes"), dict) else {}
    acik = _metin(_ilk(notlar, ("description",)) or _ilk(vl, ("description", "aciklama")), 2000)
    kat = _ilk(vl, ("category_ids", "categories", "kategoriler"))
    kat = sorted({int(x) for x in kat if isinstance(x, (int, float)) and not isinstance(x, bool) and 0 < int(x) < 100}) if isinstance(kat, list) else []
    kayit = {
        "id": "u_" + temiz, "country_code": cc, "latitude": round(lat, 6), "longitude": round(lon, 6),
        "name": ad, "name_local": yerel, "fee": _fee(_ilk(vl, ("fee", "ucret"))),
        "website": _site(_ilk(vl, ("website", "web", "url"))),
        "phone": (lambda p: p if p and re.search(r"\d", p) else None)(re.sub(r"[^0-9+()\-. ]", "", _metin(_ilk(vl, ("phone", "telefon")), 40) or "")[:40].strip()),
        "notes": {"description": acik, "note": _metin(_ilk(notlar, ("note",)), 500)},
        "category_ids": kat,
    }
    saglanan = ["konum"]
    if any(ad.values()) or yerel:
        saglanan.append("name")
    for a in ("fee", "website", "phone"):
        if kayit[a]:
            saglanan.append(a)
    if kat:
        saglanan.append("category_ids")
    ek, yeni = {}, []
    for k, x in v.items():
        if k.lower() in BILINEN or not re.match(r"^[A-Za-z][A-Za-z0-9_]{0,40}$", k) or len(ek) >= 20:
            continue
        if isinstance(x, str) and x.strip():
            ek[k] = _metin(x, 300)
        elif isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x):
            ek[k] = x
        elif isinstance(x, bool):
            ek[k] = x
        elif isinstance(x, list) and all(isinstance(i, (str, int, float)) and not isinstance(i, bool) for i in x):
            ek[k] = [(_metin(i, 100) if isinstance(i, str) else i) for i in x[:20]]
        else:
            continue
        yeni.append(k)
    kayit["_meta"] = {"kaynak": "kullanici", "kullanici_alanlari": saglanan, "eklenme": bugun}
    if ek:
        kayit["_meta"]["ek_alanlar"] = ek
    return kayit, None, yeni


# ---------------------------------------------------------------- ana islem
def isle(fb, cc, kayitlar, durum, ayar):
    """Firebase'deki bekleyenleri kayitlar listesine ekler (YERINDE). Dondurur: (rapor, silinecek)."""
    rapor = {"gelen": 0, "eklenen": 0, "reddedilen": 0, "onceden_islenmis": 0, "yeni_alanlar": {}}
    silinecek = []
    bugun = ortak.bugun()
    islenen = durum.setdefault("islenen", {})
    red = durum.setdefault("reddedilen", {})
    yeni_alan = durum.setdefault("yeni_alanlar", {})
    belgeler = fb.getir(cc, int(ayar["topluluk_ust_sinir"]))
    rapor["gelen"] = len(belgeler)
    idler = {k.get("id") for k in kayitlar if isinstance(k, dict)}
    bbox = bbox_hesapla(kayitlar, ayar["bolge_toleransi_derece"])
    for ref, doc_id, veri in belgeler:
        if doc_id in islenen or doc_id in red:
            rapor["onceden_islenmis"] += 1
            silinecek.append({"ref": ref, "id": doc_id})
            continue
        try:
            kayit, neden, alanlar = normalize(doc_id, veri, cc, bbox, bugun)
        except Exception as e:
            kayit, neden, alanlar = None, f"hata:{type(e).__name__}", []
        if kayit is None:
            red[doc_id] = {"neden": neden, "tarih": bugun, "veri": json.dumps(veri, ensure_ascii=False, default=str)[:1000]}
            rapor["reddedilen"] += 1
        else:
            if kayit["id"] not in idler:
                kayitlar.append(kayit)
                idler.add(kayit["id"])
                rapor["eklenen"] += 1
            islenen[doc_id] = bugun
            for a in alanlar:
                yeni_alan[a] = yeni_alan.get(a, 0) + 1
                rapor["yeni_alanlar"][a] = rapor["yeni_alanlar"].get(a, 0) + 1
        silinecek.append({"ref": ref, "id": doc_id})
    for sozluk, sinir in ((islenen, 20000), (red, 2000)):  # durum dosyasi buyumesin
        if len(sozluk) > sinir:
            for k in sorted(sozluk, key=lambda x: str(sozluk[x] if isinstance(sozluk[x], str) else sozluk[x].get("tarih")))[:len(sozluk) - sinir]:
                del sozluk[k]
    return rapor, silinecek
