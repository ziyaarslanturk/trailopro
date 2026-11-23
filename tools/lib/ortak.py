"""Ortak yardimcilar: atomik yazma, guvenli okuma, ayarlar, gunluk. Sadece standart kutuphane."""
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

KOK = Path(__file__).resolve().parents[2]
ARAC = KOK / "tools"

VARSAYILAN_AYAR = {
    "hedef_surum": 2,         # zengin sema surumu; arttirilirsa tum kayitlar siradan yeniden islenir
    "yenile_gun": 90,         # zenginlestirilmis kayit bu kadar gunden eskiyse tazelenir
    "deneme_siniri": 5,       # basarisiz adim en fazla bu kadar tekrar denenir
    "max_dakika": 300,        # bir calismanin toplam suresi (workflow zaman asimindan kisa olmali)
    "yedek_dakika": 10,       # commit/push icin ayrilan sure
    "topluluk_dakika": 40,    # kullanici kaydi olan ulkede zenginlestirmeye ayrilan en fazla sure
    "parca": 150,             # motor bir seferde kac kaydi isleyip dosyaya yazar
    "osm_min_gun": 7,         # bir ulke icin OSM'i en sik bu kadar gunde bir yenile
    "osm_kayip_siniri": 3,    # OSM'de ust uste bu kadar yenilemede gorunmeyen yer silinir
    "osm_min_oran": 0.5,      # OSM dosyasi eskisinin yarisindan azsa supheli sayilir, uygulanmaz
    "min_kayit_orani": 0.8,   # yeni liste eskisinin %80'inden azsa yayinlanmaz
    "tekrar_mesafe_m": 100,   # birbirine bu kadar metre yakin noktalardan en az bilgili olan silinir
    "tekrar_max_oran": 0.6,   # bir seferde kayitlarin bundan fazlasi silinecekse veri hatasi sanilir, hicbiri silinmez
    "topluluk_ust_sinir": 500,
    "bolge_toleransi_derece": 3.0,
}


def bugun():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def simdi():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def gun_farki(tarih):
    try:
        d = datetime.strptime(str(tarih)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - d).total_seconds() / 86400
    except Exception:
        return float("inf")


def log(*a):
    print(*a, flush=True)


def uyari(mesaj):
    print(f"::warning::{mesaj}", flush=True)


def yaz_atomik(yol, metin):
    yol = Path(yol)
    yol.parent.mkdir(parents=True, exist_ok=True)
    gecici = yol.with_name(yol.name + ".tmp")
    with open(gecici, "w", encoding="utf-8", newline="\n") as f:
        f.write(metin)
        f.flush()
        os.fsync(f.fileno())
    os.replace(gecici, yol)


def json_str(obj, girinti=None):
    if girinti:
        return json.dumps(obj, ensure_ascii=False, indent=girinti, sort_keys=True) + "\n"
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def json_yaz(yol, obj, girinti=None):
    yaz_atomik(yol, json_str(obj, girinti))


def json_oku(yol, varsayilan=None):
    """Dosya yok ya da bozuksa varsayilan doner (cokmez)."""
    try:
        with open(yol, encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return varsayilan


def ayar_yukle(kok=None):
    kok = Path(kok) if kok else KOK
    a = dict(VARSAYILAN_AYAR)
    ek = json_oku(kok / "ayar.json", {})
    if isinstance(ek, dict):
        for k, v in ek.items():
            if k in a and type(v) in (int, float) and not isinstance(v, bool):
                a[k] = v
    return a


ULKE_DOSYA = re.compile(r"^([A-Z][A-Z_]*)\.json$")


def ulke_listesi(data_dir):
    try:
        return sorted(m.group(1) for n in os.listdir(data_dir) if (m := ULKE_DOSYA.match(n)))
    except Exception:
        return []


def gecerli_koordinat(lat, lon):
    try:
        return (not isinstance(lat, bool) and not isinstance(lon, bool)
                and -90 <= float(lat) <= 90 and -180 <= float(lon) <= 180
                and not (float(lat) == 0 and float(lon) == 0)
                and float(lat) == float(lat) and float(lon) == float(lon))
    except Exception:
        return False


def ozet_yaz(satirlar):
    """GitHub 'Job summary' alanina yazar (yoksa sessizce gecer)."""
    yol = os.environ.get("GITHUB_STEP_SUMMARY")
    if not yol:
        return
    try:
        with open(yol, "a", encoding="utf-8") as f:
            f.write("\n".join(satirlar) + "\n")
    except Exception:
        pass


def cikti_yaz(**kv):
    """GITHUB_OUTPUT'a anahtar=deger yazar."""
    yol = os.environ.get("GITHUB_OUTPUT")
    if not yol:
        return
    try:
        with open(yol, "a", encoding="utf-8") as f:
            for k, v in kv.items():
                f.write(f"{k}={v}\n")
    except Exception:
        pass
