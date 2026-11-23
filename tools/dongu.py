#!/usr/bin/env python3
"""TRAILO PRO - surekli iyilesen veri dongusu.

  python tools/dongu.py calis [--ulke TR [--osm]]   sirandaki (ya da elle verilen) ulkeyi isler; --osm: OSM'i de yenile
  python tools/dongu.py temizle             push basarili olduktan sonra Firebase'deki islenmis kayitlari siler

Tasarim kurallari:
  * data/ yalnizca kontrolden gecen, tam ve gecerli bir sonuc varsa degisir (atomik yazim). Hata = eski veri kalir.
  * Her adim tekrar calistirilabilir (idempotent). Ayni girdi iki kez islenirse ayni sonuc cikar.
  * Opsiyonel adimlar (OSM, Firebase, motor) coksa dongu durmaz; o adim atlanir ve raporlanir.
"""
import copy
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import ortak, zengin as Z, osm_birlestir, kontrol, yayin, sira, tekrar, topluluk  # noqa: E402

K = ortak.KOK
DATA, HAM, STATE, WORK = K / "data", K / "ham", K / "state", K / "work"
SIRA_YOL, OSM_YOL, TP_YOL, SIL_YOL = STATE / "sira.json", STATE / "osm_md5.json", STATE / "topluluk.json", WORK / "silinecek.json"


def ham_temizle():
    try:
        for p in HAM.iterdir():
            if p.name != ".gitkeep":
                p.unlink()
    except Exception:
        pass


def firebase_hazirla():
    try:
        return topluluk.Firebase.ortamdan()
    except Exception as e:
        ortak.uyari(f"Firebase hazirlanamadi: {e}")
        return None


def osm_degisenleri(ulkeler, durum, md5_durum, ayar):
    """son OSM yenilemesinden osm_min_gun gecmis ve Geofabrik'te md5'i degismis ulkeler -> yeni md5."""
    degisen = {}
    try:
        from lib import osm
        for c in ulkeler:
            son = ((durum.get("ulkeler") or {}).get(c) or {}).get("son_osm")
            if son and ortak.gun_farki(son) < ayar["osm_min_gun"]:
                continue
            m = osm.uzak_md5(c)
            if m and m != md5_durum.get(c):
                degisen[c] = m
    except Exception as e:
        ortak.uyari(f"OSM degisiklik kontrolu atlandi: {type(e).__name__}: {e}")
    return degisen


def motoru_calistir(cc, butce_dk, ayar):
    cmd = ["node", str(ortak.ARAC / "zenginlestir.js"), "--dosya", str(HAM / f"{cc}.json"), "--cc", cc,
           "--max-dakika", f"{butce_dk:.1f}", "--parca", str(int(ayar["parca"])), "--onbellek", str(STATE / "turce_adlar.json")]
    try:
        r = subprocess.run(cmd, cwd=str(K), timeout=int((butce_dk + 8) * 60))
        if r.returncode != 0:
            ortak.uyari(f"{cc}: motor hata koduyla bitti ({r.returncode}); tamamlanan parcalar kullanilacak")
        return True
    except subprocess.TimeoutExpired:
        ortak.uyari(f"{cc}: motor zaman asimina ugradi; tamamlanan parcalar kullanilacak")
    except FileNotFoundError:
        ortak.uyari("node bulunamadi; zenginlestirme atlandi")
    except Exception as e:
        ortak.uyari(f"motor calistirilamadi: {e}")
    return False


def calis(zorla=None, osm_zorla=False):
    t0 = time.time()
    os.chdir(K)
    ayar = ortak.ayar_yukle()
    durum = ortak.json_oku(SIRA_YOL, None)
    ilk = not isinstance(durum, dict)
    if ilk:
        durum = {}
    durum.setdefault("ulkeler", {})
    md5_durum = ortak.json_oku(OSM_YOL, {})
    md5_durum = md5_durum if isinstance(md5_durum, dict) else {}
    ulkeler = ortak.ulke_listesi(DATA)
    # Dunya taramasi (tools/dunya-tara.js) bir ulkeyi olusturuyor/zenginlestiriyorsa (durum.json'da var ama 'tamam' yok) ona dokunma.
    # Henuz olusturmadigi ulkeler zaten data/ icinde yok, listeye hic girmez (sessizce atlanir).
    dunya = ortak.json_oku(K / "tools" / "durum.json", {})
    dunya = dunya if isinstance(dunya, dict) else {}
    mesgul = {c for c, v in dunya.items() if isinstance(v, dict) and not v.get("tamam") and c not in (ortak.json_oku(OSM_YOL, {}) or {})}
    if mesgul:
        ortak.log(f"Dunya taramasi uzerinde calisiyor, atlanan ulkeler: {sorted(mesgul)}")
    ulkeler = [c for c in ulkeler if c not in mesgul or c == zorla]
    if zorla and zorla not in ulkeler:
        ulkeler.append(zorla)
    if ilk:  # ilk calismada OSM yenilemesi hemen baslamasin; once mevcut veri zenginlessin
        for c in ulkeler:
            durum["ulkeler"].setdefault(c, {}).setdefault("son_osm", ortak.bugun())

    # ---- girdiler
    bekleyen, boyut = {}, {}
    for c in ulkeler:
        liste = ortak.json_oku(DATA / f"{c}.json", [])
        bekleyen[c] = Z.bekleyen_say(liste, ayar) if isinstance(liste, list) else 0
        try:
            boyut[c] = (DATA / f"{c}.json").stat().st_size
        except Exception:
            boyut[c] = 0
    fb = firebase_hazirla()
    tp_say = {}
    if fb:
        try:
            tp_say = fb.say()
        except Exception as e:
            ortak.uyari(f"Firebase sayimi basarisiz: {e}")
    osm_deg = ({zorla: None} if osm_zorla else {}) if zorla else osm_degisenleri(ulkeler, durum, md5_durum, ayar)
    cc, neden = sira.sec(ulkeler, durum, bekleyen, tp_say, osm_deg, boyut, zorla)
    ortak.log(f"Secim: {cc or '-'} ({neden}) | bekleyen: {sum(bekleyen.values())} kayit | topluluk: {sum(tp_say.values())} | OSM degisen: {len(osm_deg)}")
    if not cc:
        ortak.ozet_yaz(["## Döngü", "Yapılacak iş yok; bir sonraki zamanlanmış çalışmada tekrar kontrol edilecek."])
        ortak.cikti_yaz(ilerleme="false", ulke="")
        ortak.json_yaz(SIRA_YOL, durum, girinti=1)
        return 0

    sonuc = ulke_isle(cc, neden, ayar, durum, md5_durum, osm_deg, fb, t0)
    ortak.json_yaz(SIRA_YOL, durum, girinti=1)
    ortak.cikti_yaz(ilerleme="true" if sonuc.get("degisti") else "false", ulke=cc)
    return 0


def ulke_isle(cc, neden, ayar, durum, md5_durum, osm_deg, fb, t0):
    ozet = [f"## {cc} ({neden})"]
    sonuc = {"degisti": False}
    d = durum["ulkeler"].setdefault(cc, {})
    d["son_islem"] = ortak.simdi()  # basarisiz olsa bile sira ilerlesin (ayni ulkede takilmayalim)
    data_yol = DATA / f"{cc}.json"
    eski = ortak.json_oku(data_yol, None)
    if data_yol.exists() and not isinstance(eski, list):
        ortak.uyari(f"{cc}: data dosyasi okunamadi; hicbir sey degistirilmedi")
        return sonuc
    kayitlar = [k for k in (copy.deepcopy(eski) if isinstance(eski, list) else []) if isinstance(k, dict)]

    cevrilen, sorunlu = Z.toplu_cevir(kayitlar, cc)
    ozet.append(f"- eski metinden yapıya çevrilen: {cevrilen} (sorunlu {sorunlu})")

    # ---- OSM
    osm_uygulandi, yeni_md5 = False, None
    if cc in osm_deg or not data_yol.exists():
        try:
            from lib import osm
            satirlar = osm.cek(cc)
            if satirlar is None:
                ortak.uyari(f"{cc}: OSM verisi alinamadi; mevcut veriyle devam")
            else:
                r = osm_birlestir.birlestir(kayitlar, satirlar, ayar, cc)
                if r["uygulanmadi"]:
                    ortak.uyari(f"{cc}: OSM uygulanmadi ({r['uygulanmadi']})")
                else:
                    osm_uygulandi, yeni_md5 = True, osm_deg.get(cc) or osm.uzak_md5(cc)
                ozet.append(f"- OSM: {r}")
        except Exception as e:
            ortak.uyari(f"{cc}: OSM adimi atlandi: {type(e).__name__}: {e}")

    # ---- topluluk
    tp_durum = ortak.json_oku(TP_YOL, {})
    tp_durum = tp_durum if isinstance(tp_durum, dict) else {}
    silinecek, tp_eklenen = [], 0
    if fb:
        try:
            r, silinecek = topluluk.isle(fb, cc, kayitlar, tp_durum, ayar)
            tp_eklenen = r["eklenen"]
            ozet.append(f"- topluluk: {r}")
        except Exception as e:
            ortak.uyari(f"{cc}: topluluk adimi atlandi: {type(e).__name__}: {e}")

    # ---- birbirine 100 m'den yakin noktalar: en az bilgili olan silinir, sonraki adimlar temiz listeyle baslar
    tk = {"silinen": 0}
    try:
        tk = tekrar.temizle(kayitlar, ayar["tekrar_mesafe_m"], ayar["tekrar_max_oran"])
        if tk["uygulanmadi"]:
            ortak.uyari(f"{cc}: tekrar temizligi uygulanmadi ({tk['uygulanmadi']})")
        ozet.append(f"- {int(ayar['tekrar_mesafe_m'])} m tekrar temizliği: {tk['silinen']} kayıt silindi (örnek: {', '.join(tk['ornek']) or '-'})")
    except Exception as e:
        ortak.uyari(f"{cc}: tekrar temizligi atlandi: {type(e).__name__}: {e}")

    # ---- bekleyen kayitlar -> motor
    bekle = 0
    for k in kayitlar:
        f = Z.faz_belirle(k, ayar)
        if f:
            k["_bekle"] = f
            bekle += 1
        else:
            k.pop("_bekle", None)
    ham_yol = HAM / f"{cc}.json"
    ortak.json_yaz(ham_yol, kayitlar)
    butce = ayar["max_dakika"] - (time.time() - t0) / 60 - ayar["yedek_dakika"]
    if neden == "topluluk":
        butce = min(butce, ayar["topluluk_dakika"])
    if bekle and butce >= 3:
        motoru_calistir(cc, butce, ayar)
    elif bekle:
        ortak.log(f"{cc}: motora ayrilacak sure kalmadi ({butce:.1f} dk); bekleyenler sonraki turda")

    ham = ortak.json_oku(ham_yol, None)
    if not isinstance(ham, list):
        ortak.uyari(f"{cc}: motor ciktisi okunamadi; motor oncesi liste kullaniliyor")
        ham = kayitlar
    kalan = sum(1 for k in ham if isinstance(k, dict) and k.get("_bekle"))

    # ---- kontrol + yayin
    temiz, kr, ok = kontrol.kontrol_et(eski, ham, ayar, cc, haric=tk["silinen"])
    ozet.append(f"- kontrol: {kr}")
    if not ok:
        ortak.uyari(f"{cc}: kontrol basarisiz, YAYINLANMADI: {kr['mesaj']}")
        ozet.append("- **yayınlanmadı** (eski veri korundu)")
        ham_temizle()
        ortak.ozet_yaz(ozet)
        return sonuc
    y = yayin.yayinla(cc, temiz, DATA)
    sonuc.update(y)
    d["bekleyen"] = Z.bekleyen_say(temiz, ayar)
    if osm_uygulandi:
        d["son_osm"] = ortak.bugun()
        if yeni_md5:
            md5_durum[cc] = yeni_md5
            ortak.json_yaz(OSM_YOL, md5_durum, girinti=1)
    if fb or tp_durum:
        ortak.json_yaz(TP_YOL, tp_durum, girinti=1)
    ortak.json_yaz(SIL_YOL, silinecek)
    ham_temizle()
    ozet.append(f"- yayınlandı: {y['adet']} kayıt, değişti={y['degisti']}; motorda kalan bekleyen: {kalan}; Firebase'den silinecek: {len(silinecek)}")
    ortak.ozet_yaz(ozet)
    ortak.log("\n".join(ozet))
    return sonuc


def temizle():
    os.chdir(K)
    liste = ortak.json_oku(SIL_YOL, [])
    if not isinstance(liste, list) or not liste:
        ortak.log("Silinecek Firebase kaydi yok.")
        return 0
    fb = firebase_hazirla()
    if not fb:
        ortak.log("Firebase ayarli degil; silme atlandi.")
        return 0
    ok = 0
    for x in liste:
        if isinstance(x, dict) and x.get("ref") and fb.sil(x["ref"]):
            ok += 1
    ortak.log(f"Firebase: {ok}/{len(liste)} kayit silindi (silinemeyenler sonraki turda tekrar denenir).")
    try:
        SIL_YOL.unlink()
    except Exception:
        pass
    return 0


def main(argv):
    komut = argv[1] if len(argv) > 1 else "calis"
    zorla, osm_zorla = None, "--osm" in argv
    if "--ulke" in argv:
        i = argv.index("--ulke")
        zorla = (argv[i + 1] if i + 1 < len(argv) else "").strip().upper() or None
    try:
        return calis(zorla, osm_zorla) if komut == "calis" else temizle() if komut == "temizle" else 2
    except Exception:
        # Beklenmeyen hata: veriye dokunulmadi (yayin en son adim). Isi kirmizi yapma, iz birak.
        traceback.print_exc()
        ortak.uyari("Dongu beklenmeyen bir hatayla durdu; data/ degismedi. Log'a bakin.")
        ortak.cikti_yaz(ilerleme="false", ulke="")
        ham_temizle()
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
