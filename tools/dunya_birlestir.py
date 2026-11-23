#!/usr/bin/env python3
"""Dunya taramasinin urettigi ham OSM satirlarini data/<ULKE>.json'a GUVENLE birlestirir.
Ayni kod yolu dongu.py ile paylasilir (osm_birlestir + 100 m tekrar temizligi + zenginlestirme motoru + kontrol + atomik yayin).

  python tools/dunya_birlestir.py --ulke AD --girdi work/tara/AD.raw.json [--veri-klasoru data] [--butce-dk 40] [--zenginlestir 1]

Son satir: SONUC {json}.  Cikis kodu: 0 = tamam (ya da guvenle atlandi), baska = baslatilamadi. Veri dosyasi ASLA yarim yazilmaz,
okunamayan (bozuk) bir veri dosyasinin uzerine ASLA yazilmaz.
"""
import copy
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import ortak, zengin as Z, osm_birlestir, kontrol, yayin, tekrar  # noqa: E402


def argumanlar(argv):
    o = {"ulke": None, "girdi": None, "veri": "data", "butce": 40.0, "zengin": True}
    i = 1
    while i < len(argv):
        a = argv[i]
        v = argv[i + 1] if i + 1 < len(argv) else None
        if a == "--ulke":
            o["ulke"], i = (v or "").upper(), i + 2
        elif a == "--girdi":
            o["girdi"], i = v, i + 2
        elif a == "--veri-klasoru":
            o["veri"], i = v or "data", i + 2
        elif a == "--butce-dk":
            o["butce"], i = float(v or 40), i + 2
        elif a == "--zenginlestir":
            o["zengin"], i = (v or "1") not in ("0", "false"), i + 2
        else:
            i += 1
    return o


def sonuc(**kv):
    print("SONUC " + json.dumps(kv, ensure_ascii=False), flush=True)


def motor(cc, ham_yol, butce_dk, ayar):
    cmd = ["node", str(ortak.ARAC / "zenginlestir.js"), "--dosya", str(ham_yol), "--cc", cc, "--max-dakika", f"{butce_dk:.1f}",
           "--parca", str(int(ayar["parca"])), "--onbellek", str(ortak.KOK / "state" / "turce_adlar.json")]
    try:
        r = subprocess.run(cmd, cwd=str(ortak.KOK), timeout=int((butce_dk + 8) * 60))
        if r.returncode != 0:
            ortak.uyari(f"{cc}: motor hata koduyla bitti ({r.returncode}); tamamlanan parcalar kullanilacak")
    except subprocess.TimeoutExpired:
        ortak.uyari(f"{cc}: motor zaman asimina ugradi; tamamlanan parcalar kullanilacak")
    except Exception as e:
        ortak.uyari(f"{cc}: motor calistirilamadi: {e}")


def calis(o):
    t0 = time.time()
    os.chdir(ortak.KOK)
    cc = o["ulke"]
    if not cc or not cc.replace("_", "").isalpha():
        sonuc(durum="atlandi", neden="gecersiz_ulke")
        return 0
    ayar = ortak.ayar_yukle()
    veri_dir = Path(o["veri"])
    veri_dir = veri_dir if veri_dir.is_absolute() else ortak.KOK / veri_dir
    yol = veri_dir / f"{cc}.json"

    # --- mevcut dosya: yoksa yeni ulke; VARSA ama okunamiyorsa ASLA dokunma
    eski = None
    if yol.exists():
        eski = ortak.json_oku(yol, None)
        if not isinstance(eski, list):
            ortak.uyari(f"{cc}: mevcut veri dosyasi okunamadi; hicbir sey yazilmadi")
            sonuc(durum="atlandi", neden="mevcut_dosya_bozuk")
            return 0
    kayitlar = [k for k in (copy.deepcopy(eski) if eski else []) if isinstance(k, dict)]

    # --- yeni OSM satirlari (girdi yoksa: sadece zenginlestirmeye devam)
    osm_rapor, osm_uygulandi = None, False
    if o["girdi"]:
        raw = ortak.json_oku(o["girdi"], None)
        if not isinstance(raw, list):
            sonuc(durum="atlandi", neden="girdi_okunamadi")
            return 0
        if not raw and not kayitlar:
            sonuc(durum="bos", neden="osm_sonucu_bos_ve_dosya_yok", kayit=0)
            return 0
        Z.toplu_cevir(kayitlar, cc)
        osm_rapor = osm_birlestir.birlestir(kayitlar, raw, ayar, cc)
        if osm_rapor["uygulanmadi"]:
            ortak.uyari(f"{cc}: OSM sonucu uygulanmadi ({osm_rapor['uygulanmadi']}); veri korundu")
            sonuc(durum="atlandi", neden=osm_rapor["uygulanmadi"])
            return 0
        osm_uygulandi = True
    else:
        if not kayitlar:
            sonuc(durum="bos", neden="dosya_yok", kayit=0)
            return 0
        Z.toplu_cevir(kayitlar, cc)

    # --- 100 m tekrar kurali
    tk = {"silinen": 0}
    try:
        tk = tekrar.temizle(kayitlar, ayar["tekrar_mesafe_m"], ayar["tekrar_max_oran"])
        if tk["uygulanmadi"]:
            ortak.uyari(f"{cc}: tekrar temizligi uygulanmadi ({tk['uygulanmadi']})")
    except Exception as e:
        ortak.uyari(f"{cc}: tekrar temizligi atlandi: {type(e).__name__}: {e}")

    # --- zenginlestirme (motor)
    bekle = 0
    for k in kayitlar:
        f = Z.faz_belirle(k, ayar) if o["zengin"] else None
        if f:
            k["_bekle"], bekle = f, bekle + 1
        else:
            k.pop("_bekle", None)
    ham = ortak.KOK / "work" / "tara" / f"ham-{cc}.json"
    ortak.json_yaz(ham, kayitlar)
    butce = min(o["butce"], ayar["max_dakika"]) - (time.time() - t0) / 60
    if bekle and butce >= 2:
        motor(cc, ham, butce, ayar)
    sonrasi = ortak.json_oku(ham, None)
    if not isinstance(sonrasi, list):
        ortak.uyari(f"{cc}: motor ciktisi okunamadi; motor oncesi liste kullaniliyor")
        sonrasi = kayitlar
    kalan = sum(1 for k in sonrasi if isinstance(k, dict) and k.get("_bekle"))

    # --- kontrol + atomik yayin
    temiz, kr, ok = kontrol.kontrol_et(eski, sonrasi, ayar, cc, haric=tk["silinen"] + (osm_rapor or {}).get("kaldirilan", 0))
    try:
        ham.unlink()
    except Exception:
        pass
    if not ok:
        ortak.uyari(f"{cc}: kontrol basarisiz, YAYINLANMADI: {kr['mesaj']}")
        sonuc(durum="atlandi", neden="kontrol_basarisiz", mesaj=kr["mesaj"])
        return 0
    if not temiz:
        sonuc(durum="bos", neden="sonuc_bos", kayit=0)
        return 0
    y = yayin.yayinla(cc, temiz, veri_dir)
    sonuc(durum="tamam", kayit=y["adet"], degisti=y["degisti"], kalan=kalan, tekrar_silinen=tk["silinen"],
          osm=osm_rapor and {k: v for k, v in osm_rapor.items() if k != "uygulanmadi"}, osm_uygulandi=osm_uygulandi, kontrol=kr)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(calis(argumanlar(sys.argv)))
    except SystemExit:
        raise
    except Exception as e:  # beklenmeyen: veriye dokunulmadi (yayin son adim)
        import traceback
        traceback.print_exc()
        ortak.uyari(f"dunya_birlestir beklenmeyen hata: {type(e).__name__}: {e}")
        sonuc(durum="atlandi", neden="beklenmeyen_hata")
        sys.exit(0)
