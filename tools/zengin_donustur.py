#!/usr/bin/env python3
"""
ZENGIN HATTI - "baslat ve unut"

data/*.json (ulke dosyalari) icindeki duz metin notlarini kategorilere ayirir
ve sonucu zengin/<ULKE>.json olarak yazar.

  - data/ klasorune ASLA dokunmaz (mevcut uygulama bozulmaz).
  - Sadece Python standart kutuphanesi kullanir (kurulum gerektirmez).
  - Bir ulke ya da kayit bozuksa onu atlar, raporlar, digerlerine devam eder.
  - Yeni sonuc eskisinden belirgin sekilde kotuyse eski dosyayi korur.
  - Ayni veriyle tekrar calistirilirsa hicbir dosya degismez.

Kademeler (calisma/ altinda):  a_ham -> b_kategorili -> c_kontrol -> zengin/
"""
import html
import json
import os
import re
import shutil
import sys
import traceback
from pathlib import Path

SURUM = 1

YAKIN_ETIKET = {
    "Su/plaj": ("cevre", "su_plaj"),
    "İçme suyu": ("kritik", "icme_suyu"),
    "Tuvalet/duş noktası": ("kritik", "tuvalet_dus"),
    "Market": ("kritik", "market"),
    "Akaryakıt": ("kritik", "akaryakit"),
    "Sağlık": ("kritik", "saglik"),
    "Yerleşim": ("cevre", "yerlesim"),
    "Zirve": ("cevre", "zirve"),
    "Görülecek": ("cevre", "gorulecek"),
    "Yakın tesis": ("cevre", "yakin_tesis"),
}
OSM_TR = {
    "drinking_water": "İçme suyu",
    "toilets": "Tuvalet",
    "convenience": "Market",
    "fuel": "Akaryakıt",
    "pharmacy": "Eczane",
    "supermarket": "Süpermarket",
    "kiosk": "Büfe",
    "bakery": "Fırın",
    "shower": "Duş",
    "hospital": "Hastane",
    "clinic": "Klinik",
    "doctors": "Doktor",
}
DOGA_ETIKET = {"Kuşlar": "kuslar", "Memeliler": "memeliler", "Sürüngenler": "surungenler", "Bitkiler": "bitkiler"}
KORUMA_UYARI = "Kural ve yasakları kontrol et."
BASLIKLAR = r"(KONUM|YAKIN ÇEVRE|DOĞA|OLANAKLAR|ÜCRET|KORUMA ALANI|ÇEVRE BİLGİSİ)[:( ]"
MESAFE_DESEN = re.compile(r"\((\d+(?:,\d+)?) (m|km)\)")


# ------------------------------------------------------------------ donusum
def mesafe_m(sayi, birim):
    v = float(sayi.replace(",", "."))
    return int(round(v * 1000)) if birim == "km" else int(round(v))


def noktalar_ayikla(parca):
    out = []
    for m in re.finditer(r"\s*(.*?) \((\d+(?:,\d+)?) (m|km)\)\s*(?:,|$)", parca.strip().rstrip(".")):
        ad = m.group(1).strip()
        if not ad:
            continue
        out.append({"ad": OSM_TR.get(ad, ad), "mesafe_m": mesafe_m(m.group(2), m.group(3))})
    return out


def yakin_cevre_ayikla(metin):
    etiketler = "|".join(re.escape(k) for k in YAKIN_ETIKET)
    desen = re.compile(r"(?:^|(?<=\. ))(" + etiketler + r"): ")
    konumlar = [(m.start(), m.end(), m.group(1)) for m in desen.finditer(metin)]
    sonuc = {}
    for i, (_, bitis, etiket) in enumerate(konumlar):
        son = konumlar[i + 1][0] if i + 1 < len(konumlar) else len(metin)
        liste = noktalar_ayikla(metin[bitis:son])
        if liste:
            sonuc[etiket] = liste
    return sonuc


def doga_ayikla(metin):
    sonuc = {}
    desen = re.compile(r"(?:^|(?<=\. )|(?<=: ))(" + "|".join(DOGA_ETIKET) + r"): ")
    konumlar = [(m.start(), m.end(), m.group(1)) for m in desen.finditer(metin)]
    for i, (_, bitis, etiket) in enumerate(konumlar):
        son = konumlar[i + 1][0] if i + 1 < len(konumlar) else len(metin)
        parca = metin[bitis:son].strip().rstrip(".")
        ogeler = []
        for oge in re.split(r", (?![^()]*\))", parca):
            oge = oge.strip()
            if not oge:
                continue
            m = re.match(r"^(.*?) \((.*)\)$", oge)
            if m:
                ogeler.append({"bilimsel": m.group(1).strip(), "ingilizce": m.group(2).strip()})
            else:
                ogeler.append({"bilimsel": oge, "ingilizce": None})
        if ogeler:
            sonuc[DOGA_ETIKET[etiket]] = ogeler
    return sonuc


def kaynak_ayikla(not_metni):
    not_metni = html.unescape(not_metni or "")
    tarih = re.search(r"(\d{4}-\d{2}-\d{2})", not_metni)
    kaynaklar = []
    m = re.search(r"\):\s*([^.]*)\.", not_metni)
    if m:
        kaynaklar = [s.strip() for s in m.group(1).split(",") if s.strip()]
    return {"tarih": tarih.group(1) if tarih else None, "kaynaklar": kaynaklar, "dogrulandi": False}


def donustur(kayit):
    """Bir kayit icin 'zengin' sozlugu dondurur; zenginlesmemis kayitta None."""
    notlar = kayit.get("notes")
    if not isinstance(notlar, dict):
        return None
    aciklama = html.unescape(notlar.get("description") or "")
    if not re.search(r"(?m)^" + BASLIKLAR, aciklama):
        return None

    z = {
        "surum": SURUM,
        "konum": {"adres": None, "irtifa_m": None},
        "olanaklar": [],
        "calisma_saati": None,
        "ucret": None,
        "kritik_noktalar": [],
        "cevre": {},
        "doga": {},
        "koruma_alani": None,
        "hakkinda": None,
        "ek_notlar": [],
        "kaynak": kaynak_ayikla(notlar.get("note")),
    }
    for satir in aciklama.split("\n"):
        satir = satir.strip()
        if not satir:
            continue
        if satir.startswith("KONUM:"):
            govde = satir[len("KONUM:"):].strip()
            m = re.match(r"^(.*?)\.? İrtifa: (-?\d+) m\.?$", govde)
            if m:
                z["konum"]["adres"] = m.group(1).strip()
                z["konum"]["irtifa_m"] = int(m.group(2))
            else:
                z["konum"]["adres"] = govde.rstrip(".")
        elif satir.startswith("YAKIN ÇEVRE:"):
            for etiket, liste in yakin_cevre_ayikla(satir[len("YAKIN ÇEVRE:"):].strip()).items():
                grup, tur = YAKIN_ETIKET[etiket]
                if grup == "kritik":
                    for o in liste:
                        z["kritik_noktalar"].append({"tur": tur, **o, "enlem": None, "boylam": None})
                else:
                    z["cevre"][tur] = liste
        elif satir.startswith("DOĞA"):
            govde = satir.split("): ", 1)[1] if "): " in satir else satir.split(": ", 1)[-1]
            z["doga"] = doga_ayikla(govde)
        elif satir.startswith("KORUMA ALANI"):
            govde = satir.split("): ", 1)[1] if "): " in satir else satir.split(": ", 1)[-1]
            z["koruma_alani"] = {"ad": govde.replace(KORUMA_UYARI, "").strip().rstrip("."), "uyari": KORUMA_UYARI}
        elif satir.startswith("ÇEVRE BİLGİSİ"):
            m = re.match(r"^ÇEVRE BİLGİSİ \(Wikipedia, (.*), (\d+(?:,\d+)?) (m|km)\): (.*)$", satir, re.S)
            if m:
                z["hakkinda"] = {
                    "baslik": m.group(1).strip(),
                    "mesafe_m": mesafe_m(m.group(2), m.group(3)),
                    "metin": m.group(4).strip(),
                    "kaynak": "Wikipedia",
                }
            else:
                z["ek_notlar"].append(satir)
        elif satir.startswith("OLANAKLAR:"):
            for oge in [s.strip() for s in satir[len("OLANAKLAR:"):].strip().rstrip(".").split(",")]:
                if not oge:
                    continue
                if oge.lower().startswith("saat:"):
                    z["calisma_saati"] = oge.split(":", 1)[1].strip()
                else:
                    z["olanaklar"].append(oge)
        elif satir.startswith("ÜCRET:"):
            z["ucret"] = satir[len("ÜCRET:"):].strip().rstrip(".")
        else:
            z["ek_notlar"].append(satir)
    return z


# ------------------------------------------------------------------- kontrol
def kayit_kontrol(kayit, z):
    """Sorun listesi dondurur (bos liste = temiz)."""
    sorun = []
    aciklama = html.unescape((kayit.get("notes") or {}).get("description") or "")
    # 1) YAKIN CEVRE: metindeki mesafeli oge sayisi == ayrisan oge sayisi
    for satir in aciklama.split("\n"):
        if satir.startswith("YAKIN ÇEVRE:"):
            beklenen = len(MESAFE_DESEN.findall(satir))
            bulunan = len(z["kritik_noktalar"]) + sum(len(v) for v in z["cevre"].values())
            if beklenen != bulunan:
                sorun.append(f"yakin_cevre_sayi beklenen={beklenen} bulunan={bulunan}")
        if satir.startswith("DOĞA") and not z["doga"]:
            sorun.append("doga_bos")
        if satir.startswith("KONUM:") and not z["konum"]["adres"]:
            sorun.append("konum_bos")
    # 2) sema / tip kontrolu
    for n in z["kritik_noktalar"]:
        if not (isinstance(n.get("tur"), str) and isinstance(n.get("ad"), str)
                and isinstance(n.get("mesafe_m"), int) and n["mesafe_m"] >= 0):
            sorun.append("kritik_nokta_bozuk")
            break
    for grup, liste in z["cevre"].items():
        for n in liste:
            if not (isinstance(n.get("ad"), str) and isinstance(n.get("mesafe_m"), int) and n["mesafe_m"] >= 0):
                sorun.append("cevre_bozuk")
                break
    return sorun


# ----------------------------------------------------------------- dosya isleri
def yaz_atomik(yol, icerik_str):
    yol = Path(yol)
    yol.parent.mkdir(parents=True, exist_ok=True)
    gecici = yol.with_name(yol.name + ".tmp")
    with open(gecici, "w", encoding="utf-8") as f:
        f.write(icerik_str)
        f.flush()
        os.fsync(f.fileno())
    os.replace(gecici, yol)


def json_str(veri):
    return json.dumps(veri, ensure_ascii=False, separators=(",", ":"), sort_keys=False)


def oku_json(yol):
    with open(yol, encoding="utf-8-sig") as f:
        return json.load(f)


def kopyala_degismediyse_atla(kaynak_str, hedef):
    """Icerik ayniysa dosyayi yeniden yazma (git gurultusu olmasin)."""
    hedef = Path(hedef)
    try:
        if hedef.exists() and hedef.read_text(encoding="utf-8") == kaynak_str:
            return False
    except Exception:
        pass
    yaz_atomik(hedef, kaynak_str)
    return True


def main(kok="."):
    kok = Path(kok)
    veri_dir = kok / "data"
    calisma = kok / "calisma"
    a_dir, b_dir, c_dir = calisma / "a_ham", calisma / "b_kategorili", calisma / "c_kontrol"
    cikti = kok / "zengin"

    if calisma.exists():
        shutil.rmtree(calisma, ignore_errors=True)
    for d in (a_dir, b_dir, c_dir):
        d.mkdir(parents=True, exist_ok=True)

    rapor = {"ulkeler": {}, "atlanan_dosyalar": {}, "genel": {}}
    ozet = []

    if not veri_dir.is_dir():
        rapor["genel"]["durum"] = "data klasoru bulunamadi - hicbir sey yapilmadi"
        yaz_atomik(cikti / "_rapor.json", json_str(rapor))
        print("UYARI: data/ klasoru yok.")
        return 0

    dosyalar = sorted(p for p in veri_dir.glob("*.json") if p.is_file())

    # ---- KADEME A: ham kopya ------------------------------------------------
    ham = {}
    for p in dosyalar:
        try:
            veri = oku_json(p)
            if not (isinstance(veri, list) and veri and all(isinstance(x, dict) for x in veri[:50])
                    and any("notes" in x for x in veri[:50])):
                rapor["atlanan_dosyalar"][p.name] = "kamp listesi degil"
                continue
            shutil.copyfile(p, a_dir / p.name)
            ham[p.stem] = veri
        except Exception as e:  # bozuk json vb.
            rapor["atlanan_dosyalar"][p.name] = f"okunamadi: {type(e).__name__}"

    # ---- KADEME B: kategorile ------------------------------------------------
    for ulke, veri in ham.items():
        r = {"toplam": len(veri), "donusen": 0, "zenginlesmemis": 0, "bos_damgali": [], "sorunlu": {}}
        cikis = []
        for k in veri:
            try:
                kid = k.get("id")
                z = donustur(k)
                if z is None:
                    r["zenginlesmemis"] += 1
                    damga = (k.get("notes") or {}).get("note") or ""
                    if isinstance(damga, str) and "Otomatik derleme" in damga:
                        r["bos_damgali"].append(kid)
                    continue
                cikis.append({"id": kid, "zengin": z})
            except Exception as e:
                r["sorunlu"][str(k.get("id"))] = f"donusum_hatasi:{type(e).__name__}"
        yaz_atomik(b_dir / f"{ulke}.json", json_str(cikis))
        rapor["ulkeler"][ulke] = r

    # ---- KADEME C: kontrol ----------------------------------------------------
    for ulke, veri in ham.items():
        r = rapor["ulkeler"][ulke]
        kayit_by_id = {}
        for k in veri:
            kayit_by_id.setdefault(k.get("id"), k)
        try:
            adaylar = oku_json(b_dir / f"{ulke}.json")
        except Exception as e:
            r["durum"] = f"b_okunamadi:{type(e).__name__}"
            continue
        temiz, gorulen = [], set()
        for a in adaylar:
            kid = a.get("id")
            if kid in gorulen or kid not in kayit_by_id:
                r["sorunlu"][str(kid)] = "id_tekrar_ya_da_yok"
                continue
            gorulen.add(kid)
            sorun = kayit_kontrol(kayit_by_id[kid], a["zengin"])
            if sorun:
                r["sorunlu"][str(kid)] = ";".join(sorun)  # bu kayit yayina GIRMEZ
                continue
            temiz.append(a)
        r["donusen"] = len(temiz)
        yaz_atomik(c_dir / f"{ulke}.json", json_str(temiz))

    # ---- KADEME D: yayinla (zengin/) -----------------------------------------
    cikti.mkdir(parents=True, exist_ok=True)
    degisen = 0
    for ulke in ham:
        r = rapor["ulkeler"][ulke]
        c_yol = c_dir / f"{ulke}.json"
        if not c_yol.exists():
            r.setdefault("durum", "yayinlanmadi")
            continue
        yeni_str = c_yol.read_text(encoding="utf-8")
        hedef = cikti / f"{ulke}.json"
        # gerileme korumasi: yeni sonuc eskisinin yarisindan azsa eskiyi koru
        if hedef.exists():
            try:
                eski_say = len(oku_json(hedef))
                if eski_say > 20 and r["donusen"] < eski_say * 0.5:
                    r["durum"] = f"eski_korundu (eski={eski_say}, yeni={r['donusen']})"
                    continue
            except Exception:
                pass
        if kopyala_degismediyse_atla(yeni_str, hedef):
            degisen += 1
        r["durum"] = "tamam"

    # rapor (zaman damgasi YOK -> degisiklik yoksa git degisikligi de yok)
    rapor["genel"] = {
        "ulke_sayisi": len(ham),
        "atlanan_dosya": len(rapor["atlanan_dosyalar"]),
    }
    rapor_kisa = json.loads(json_str(rapor))
    for r in rapor_kisa["ulkeler"].values():
        r["bos_damgali_sayi"] = len(r.pop("bos_damgali"))
        sor = r.pop("sorunlu")
        r["sorunlu_sayi"] = len(sor)
        r["sorunlu_ornek"] = dict(list(sor.items())[:20])
    kopyala_degismediyse_atla(json.dumps(rapor_kisa, ensure_ascii=False, indent=1), cikti / "_rapor.json")

    ozet.append("## Zengin hattı özeti\n")
    ozet.append("| Ülke | Toplam | Dönüşen | Zenginleşmemiş | Boş damgalı | Sorunlu | Durum |")
    ozet.append("|---|---|---|---|---|---|---|")
    for ulke, r in rapor["ulkeler"].items():
        ozet.append(f"| {ulke} | {r['toplam']} | {r['donusen']} | {r['zenginlesmemis']} | "
                    f"{len(r['bos_damgali'])} | {len(r['sorunlu'])} | {r.get('durum', '-')} |")
    if rapor["atlanan_dosyalar"]:
        ozet.append("\nAtlanan dosyalar: " + ", ".join(f"{k} ({v})" for k, v in rapor["atlanan_dosyalar"].items()))
    (calisma / "ozet.md").write_text("\n".join(ozet) + "\n", encoding="utf-8")
    print("\n".join(ozet))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
    except Exception:
        # beklenmeyen bir sey olsa bile is "kirmizi" olmasin, ama iz birakilsin
        traceback.print_exc()
        try:
            Path("calisma").mkdir(exist_ok=True)
            Path("calisma/ozet.md").write_text("## Zengin hattı BEKLENMEYEN HATA\n\nLog'a bakın.\n", encoding="utf-8")
        except Exception:
            pass
        sys.exit(0)
