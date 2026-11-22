"""Calistirma:  python -m unittest discover -s testler -v"""
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

KOK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KOK / "tools"))
sys.path.insert(0, str(KOK / "testler"))
from lib import ortak, zengin as Z, osm_birlestir, kontrol, sira, topluluk, yayin  # noqa: E402
from sahte_firebase import SahteHTTP  # noqa: E402

ORNEK = json.loads((KOK / "testler" / "ornek_TR.json").read_text(encoding="utf-8"))
AYAR = ortak.ayar_yukle(KOK)


def kayit(i, lat=39.0, lon=35.0, **ek):
    k = {"id": i, "country_code": "TR", "latitude": lat, "longitude": lon, "name": {"tr": None, "en": None, "de": None, "ru": None, "ar": None},
         "name_local": None, "fee": None, "website": None, "phone": None, "notes": {"description": None, "note": None}, "category_ids": [1]}
    k.update(ek)
    return k


class ZenginSemasi(unittest.TestCase):
    def test_gercek_veri_donusur_gecerli_ve_ham_etiketsiz(self):
        d = copy.deepcopy(ORNEK)
        cevrilen, sorunlu = Z.toplu_cevir(d, "TR")
        self.assertGreater(cevrilen, 30)
        self.assertEqual(sorunlu, 0)
        for k in d:
            if "zengin" in k:
                self.assertEqual(Z.zengin_sorunlari(k["zengin"]), [])
                self.assertEqual(k["zengin"]["surum"], 1)
                self.assertTrue(k["zengin"]["kaynak"]["eski_metin"])
                self.assertNotIn("drinking_water", json.dumps(k["zengin"]))

    def test_donusumde_kritik_ad_turkce(self):
        d = copy.deepcopy(ORNEK)
        Z.toplu_cevir(d, "TR")
        adlar = {n["ad"] for k in d if "zengin" in k for n in k["zengin"]["kritik_noktalar"] if n["tur"] == "icme_suyu"}
        self.assertIn("İçme suyu", adlar)  # adsiz su noktalari Turkce etiketle; gercek adlar (Cesme vb.) aynen kalir
        self.assertFalse({a for a in adlar if a in Z.TUR_TR or Z.HAM_ETIKET.match(a)}, adlar)

    def test_metin_temizle_bos_satir_ve_bos_parca(self):
        m = Z.metin_temizle("KONUM: A.\nYAKIN ÇEVRE: İçme suyu: x (3 m). Yakın tesis: .\n\nDOĞA (kayıt): .")
        self.assertEqual(m, "KONUM: A.\nYAKIN ÇEVRE: İçme suyu: x (3 m).")

    def test_faz_belirleme(self):
        a = dict(AYAR)
        self.assertEqual(Z.faz_belirle(kayit("n1"), a), "yeni")
        z = {"surum": 1, "tarih": ortak.bugun(), "kaynak": {"eski_metin": True}}
        self.assertEqual(Z.faz_belirle(kayit("n1", zengin=z), a), "yukselt")
        z = {"surum": 2, "tarih": ortak.bugun(), "kaynak": {"eksik_adimlar": ["osm_cevre"], "deneme": {"osm_cevre": 1}}}
        self.assertEqual(Z.faz_belirle(kayit("n1", zengin=z), a), "tamir")
        z["kaynak"]["deneme"]["osm_cevre"] = 5  # deneme siniri doldu: sonsuza kadar denenmez
        self.assertIsNone(Z.faz_belirle(kayit("n1", zengin=z), a))
        z = {"surum": 2, "tarih": "2000-01-01", "kaynak": {}}
        self.assertEqual(Z.faz_belirle(kayit("n1", zengin=z), a), "tazele")
        z = {"surum": 2, "tarih": ortak.bugun(), "kaynak": {}}
        self.assertIsNone(Z.faz_belirle(kayit("n1", zengin=z), a))

    def test_sema_dogrulama_bozuk_veriyi_yakalar(self):
        z = Z.v2_cevir({"konum": {}, "kaynak": {}}, "TR")
        self.assertEqual(Z.zengin_sorunlari(z), [])
        z["kritik_noktalar"] = [{"tur": "icme_suyu", "ad": "drinking_water", "mesafe_m": 5}]
        self.assertTrue(Z.zengin_sorunlari(z))
        Z.zengin_duzelt(z)
        self.assertEqual(Z.zengin_sorunlari(z), [])
        self.assertEqual(z["kritik_noktalar"][0]["ad"], "İçme suyu")


class OsmBirlestirme(unittest.TestCase):
    def test_yeni_eklenir_mevcut_guncellenir_kullanici_korunur(self):
        mevcut = [kayit("n1", fee="no"), kayit("n2", 40, 36, _meta={"kullanici_alanlari": ["website"]}, website="https://benim.com")]
        osm = [kayit("n1", fee="yes"), kayit("n2", 40, 36, website="https://osm.com"), kayit("n3", 41, 37)]
        r = osm_birlestir.birlestir(mevcut, osm, AYAR, "TR")
        self.assertEqual(r["yeni"], 1)
        d = {k["id"]: k for k in mevcut}
        self.assertEqual(d["n1"]["fee"], "yes")
        self.assertEqual(d["n2"]["website"], "https://benim.com")
        self.assertIn("n3", d)

    def test_tekrar_birlesen_kimlik_yeniden_eklenmez(self):
        mevcut = [kayit("n1", _meta={"birlesen": ["n9"]})]
        r = osm_birlestir.birlestir(mevcut, [kayit("n1"), kayit("n9")], AYAR, "TR")
        self.assertEqual(r["yeni"], 0)
        self.assertEqual(r["birlesen_atlandi"], 1)

    def test_kaybolan_yer_ust_uste_n_yenilemede_silinir_kullaniciliysa_asla(self):
        mevcut = [kayit("n1"), kayit("n2"), kayit("n3", _meta={"kullanici_alanlari": ["name"]})]
        for tur in range(AYAR["osm_kayip_siniri"]):
            osm_birlestir.birlestir(mevcut, [kayit("n1")], AYAR, "TR")
            if tur < AYAR["osm_kayip_siniri"] - 1:
                self.assertEqual(len(mevcut), 3)
        self.assertEqual({k["id"] for k in mevcut}, {"n1", "n3"})

    def test_geri_gelen_yer_sayaci_sifirlar(self):
        mevcut = [kayit("n1"), kayit("n2")]
        osm_birlestir.birlestir(mevcut, [kayit("n1")], AYAR, "TR")
        self.assertEqual(mevcut[1]["_meta"]["osm_kayip"], 1)
        osm_birlestir.birlestir(mevcut, [kayit("n1"), kayit("n2")], AYAR, "TR")
        self.assertNotIn("osm_kayip", mevcut[1].get("_meta", {}))

    def test_supheli_dusus_uygulanmaz(self):
        mevcut = [kayit(f"n{i}", 39 + i / 100, 35) for i in range(40)]
        antes = copy.deepcopy(mevcut)
        r = osm_birlestir.birlestir(mevcut, [kayit("n1")], AYAR, "TR")
        self.assertTrue(r["uygulanmadi"])
        self.assertEqual(mevcut, antes)


class Topluluk(unittest.TestCase):
    def test_normalize_gecerli_ve_gecersiz(self):
        k, neden, yeni = topluluk.normalize("abc/../1", {"country_code": "TR", "lat": 40.1, "lng": 30.2, "name": "Dere Kamp", "fee": "ücretsiz", "website": "dere.com", "telefon": "0 532 111 22 33", "renk": "mavi"}, "TR", None, "2026-11-22")
        self.assertIsNone(neden)
        self.assertEqual(k["id"], "u_abc1")
        self.assertEqual((k["fee"], k["website"], k["name"]["tr"]), ("no", "https://dere.com", "Dere Kamp"))
        self.assertEqual(k["_meta"]["ek_alanlar"], {"renk": "mavi"})
        self.assertEqual(yeni, ["renk"])
        self.assertEqual(topluluk.normalize("x", {"name": "a"}, "TR", None, "d")[1], "koordinat_yok")
        self.assertEqual(topluluk.normalize("x", {"lat": 0, "lng": 0}, "TR", None, "d")[1], "koordinat_gecersiz")
        self.assertEqual(topluluk.normalize("x", {"lat": 10, "lng": 10}, "TR", (35, 43, 25, 45), "d")[1], "ulke_bolgesi_disinda")
        self.assertEqual(topluluk.normalize("x", "metin", "TR", None, "d")[1], "veri_sozluk_degil")

    def test_geopoint_ve_ic_ice_yapilar(self):
        k, _, _ = topluluk.normalize("g1", {"location": {"latitude": 38.5, "longitude": 27.5}, "name": {"tr": "Ada", "en": "Island"}, "category_ids": [1, 3, "x", 500]}, "TR", None, "d")
        self.assertEqual((k["latitude"], k["name"]["en"], k["category_ids"]), (38.5, "Island", [1, 3]))

    def test_isle_ayni_belge_iki_kez_eklenmez_ve_silinecek_listelenir(self):
        http = SahteHTTP({"d1": {"country_code": "TR", "latitude": 40.0, "longitude": 30.0, "name": "A"}, "d2": {"country_code": "TR", "name": "koordinatsiz"}, "d3": {"country_code": "DE", "latitude": 50.0, "longitude": 10.0}})
        fb = topluluk.Firebase(http=http, token_fn=lambda: "t", proje="p")
        self.assertEqual(fb.say(), {"TR": 2, "DE": 1})
        durum, kayitlar = {}, []
        r, sil = topluluk.isle(fb, "TR", kayitlar, durum, AYAR)
        self.assertEqual((r["eklenen"], r["reddedilen"], len(sil)), (1, 1, 2))
        self.assertIn("d2", durum["reddedilen"])
        # silme basarisiz olduysa: ayni belge tekrar gelir, tekrar EKLENMEZ, tekrar silinecek olarak isaretlenir
        r2, sil2 = topluluk.isle(fb, "TR", kayitlar, durum, AYAR)
        self.assertEqual((r2["eklenen"], len(kayitlar), len(sil2), r2["onceden_islenmis"]), (0, 1, 2, 2))
        self.assertTrue(all(fb.sil(x["ref"]) for x in sil2))
        self.assertEqual(list(http.docs), [n for n in http.docs if n.endswith("/d3")])


class Kontrol(unittest.TestCase):
    def test_bozuk_zengin_eski_surume_doner_yoksa_silinir(self):
        iyi = Z.v2_cevir({"konum": {}, "kaynak": {}}, "TR")
        eski = [kayit("n1", zengin=copy.deepcopy(iyi)), kayit("n2")]
        yeni = copy.deepcopy(eski)
        yeni[0]["zengin"]["ucret"]["durum"] = "belki"
        yeni[1]["zengin"] = {"surum": "x"}
        temiz, rapor, ok = kontrol.kontrol_et(eski, yeni, AYAR, "TR")
        self.assertTrue(ok)
        self.assertEqual(temiz[0]["zengin"], iyi)
        self.assertNotIn("zengin", temiz[1])
        self.assertEqual((rapor["geri_alinan_zengin"], rapor["silinen_zengin"]), (1, 1))

    def test_kayit_kaybi_yayini_durdurur(self):
        eski = [kayit(f"n{i}", 39 + i / 100) for i in range(50)]
        _, rapor, ok = kontrol.kontrol_et(eski, eski[:20], AYAR, "TR")
        self.assertFalse(ok)
        self.assertTrue(rapor["mesaj"])

    def test_gecici_alanlar_temizlenir_tekrar_id_atilir(self):
        yeni = [kayit("n1", _bekle="yeni", _meta={"osm_kayip": None, "birlesen": []}), kayit("n1")]
        temiz, rapor, ok = kontrol.kontrol_et(None, yeni, AYAR, "TR")
        self.assertEqual(len(temiz), 1)
        self.assertNotIn("_bekle", temiz[0])
        self.assertNotIn("_meta", temiz[0])
        self.assertEqual(rapor["tekrar_id"], 1)

    def test_bos_satir_ve_bos_parca_duz_metinden_atilir(self):
        k = kayit("n1", notes={"description": "KONUM: A.\nYAKIN ÇEVRE: İçme suyu: x (3 m). Yakın tesis: .\n\nOLANAKLAR: .", "note": None})
        temiz, _, _ = kontrol.kontrol_et(None, [k], AYAR, "TR")
        self.assertEqual(temiz[0]["notes"]["description"], "KONUM: A.\nYAKIN ÇEVRE: İçme suyu: x (3 m).")


class Sira(unittest.TestCase):
    def test_oncelikler(self):
        u = ["AT", "DE", "TR"]
        d = {"ulkeler": {"AT": {"son_islem": "2026-01-02"}, "DE": {"son_islem": "2026-01-01"}}}
        self.assertEqual(sira.sec(u, d, {"AT": 5}, {"DE": 2}, {"AT": "x"}), ("DE", "topluluk"))
        self.assertEqual(sira.sec(u, d, {"AT": 5}, {}, {"AT": "x"}), ("AT", "osm"))
        self.assertEqual(sira.sec(u, d, {"AT": 5, "DE": 1}, {}, {}), ("DE", "zenginlestirme"))   # en eski once
        self.assertEqual(sira.sec(u, {}, {"AT": 1, "TR": 1}, {}, {}), ("TR", "zenginlestirme"))   # hic islenmemis: TR once
        self.assertEqual(sira.sec(u, d, {}, {}, {}), (None, "is yok"))
        self.assertEqual(sira.sec(u, d, {}, {}, {}, zorla="XX"), ("XX", "elle"))


class Yayin(unittest.TestCase):
    def test_ayni_icerik_dosyaya_dokunmaz_manifest_tarihi_degismez(self):
        with tempfile.TemporaryDirectory() as t:
            l = [kayit("n1")]
            a = yayin.yayinla("TR", l, t)
            self.assertTrue(a["degisti"])
            man1 = (Path(t) / "manifest.json").read_text(encoding="utf-8")
            b = yayin.yayinla("TR", l, t)
            self.assertFalse(b["degisti"])
            self.assertEqual(man1, (Path(t) / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(json.loads(man1)["countries"]["TR"]["count"], 1)


# ------------------------------------------------------------------ uctan uca
SURUCU = r'''
import sys, json
sys.path.insert(0, "tools"); sys.path.insert(0, "testler")
import dongu
from lib import topluluk
from sahte_firebase import SahteHTTP
import os
from lib import osm
if os.path.exists("testler/_osm_satirlari.json"):
    _s = json.load(open("testler/_osm_satirlari.json", encoding="utf-8"))
    osm.cek = lambda cc: _s
    osm.uzak_md5 = lambda cc, http=None: "yeni_md5"
docs = json.load(open("testler/_firebase_belgeler.json", encoding="utf-8")) if os.path.exists("testler/_firebase_belgeler.json") else {}
http = SahteHTTP(docs)
dongu.firebase_hazirla = lambda: topluluk.Firebase(http=http, token_fn=lambda: "t", proje="p")
_args, _cur = [], []
for a in sys.argv[1:] + ["+"]:
    if a == "+":
        _args.append(_cur); _cur = []
    else:
        _cur.append(a)
for grup in _args:
    dongu.main(["dongu.py"] + grup)
json.dump(sorted(http.docs), open("testler/_kalan_belgeler.json", "w"))
'''


class UctanUca(unittest.TestCase):
    def kur(self, belgeler=None):
        t = Path(tempfile.mkdtemp(prefix="trailo-e2e-"))
        self.addCleanup(shutil.rmtree, t, True)
        for a in ("tools", "testler"):
            shutil.copytree(KOK / a, t / a, ignore=shutil.ignore_patterns("__pycache__", "_*.json"))
        for d in ("data", "ham", "state"):
            (t / d).mkdir()
        (t / "ham" / ".gitkeep").write_text("")
        (t / "data" / "TR.json").write_text(json.dumps(ORNEK, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        (t / "ayar.json").write_text(json.dumps({"parca": 25}))
        if belgeler is not None:
            (t / "testler" / "_firebase_belgeler.json").write_text(json.dumps(belgeler, ensure_ascii=False), encoding="utf-8")
        return t

    def calistir(self, t, *komutlar, firebase=False):
        firebase = firebase or (t / "testler" / "_osm_satirlari.json").exists()
        env = dict(os.environ, TRAILO_SAHTE_AG=str(t / "testler" / "sahte_ag.js"))
        env.pop("GITHUB_OUTPUT", None)
        env.pop("FIREBASE_SERVIS_HESABI", None)
        if firebase:
            r = subprocess.run([sys.executable, "-c", SURUCU, *komutlar], cwd=t, env=env, capture_output=True, text=True, timeout=600)
        else:
            r = subprocess.run([sys.executable, "tools/dongu.py", *komutlar], cwd=t, env=env, capture_output=True, text=True, timeout=600)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
        return r

    def veri(self, t):
        return json.loads((t / "data" / "TR.json").read_text(encoding="utf-8"))

    def test_tam_dongu_ve_ikinci_calisma_degismez(self):
        t = self.kur()
        r = self.calistir(t, "calis")
        d = self.veri(t)
        self.assertGreaterEqual(len(d), 55)
        for k in d:
            self.assertIn("zengin", k, k["id"])
            self.assertEqual(Z.zengin_sorunlari(k["zengin"]), [], k["id"])
            self.assertEqual(k["zengin"]["surum"], 2, k["id"])
            self.assertNotIn("_bekle", k)
        man = json.loads((t / "data" / "manifest.json").read_text(encoding="utf-8"))["countries"]["TR"]
        self.assertEqual(man["count"], len(d))
        self.assertEqual([p.name for p in (t / "ham").iterdir()], [".gitkeep"], "ham/ islem sonunda bos kalmali")
        sira_durum = json.loads((t / "state" / "sira.json").read_text(encoding="utf-8"))
        self.assertEqual(sira_durum["ulkeler"]["TR"]["bekleyen"], 0)
        # ikinci calisma: yapilacak is yok, dosya ayni
        once = (t / "data" / "TR.json").read_bytes()
        self.calistir(t, "calis")
        self.assertEqual(once, (t / "data" / "TR.json").read_bytes())

    def test_eski_duz_metin_korunur_ve_yapidan_uretilir(self):
        t = self.kur()
        self.calistir(t, "calis")
        for k in self.veri(t):
            ac = k["notes"].get("description") or ""
            self.assertNotIn("Yakın tesis: .", ac)
            self.assertNotIn("\n\n", ac)
            self.assertNotIn("drinking_water", ac)

    def surucu_args(self, komutlar):
        return komutlar

    def test_osm_yenilemesi_yeni_yer_ekler_zenginlestirir_md5_kaydeder(self):
        t = self.kur()
        satirlar = [{k: v for k, v in x.items() if k not in ("zengin", "_meta")} for x in ORNEK]
        satirlar.append(kayit("n88888888", 37.0, 28.5, name_local="Yeni OSM Kampi"))
        (t / "testler" / "_osm_satirlari.json").write_text(json.dumps(satirlar, ensure_ascii=False), encoding="utf-8")
        self.calistir(t, "calis", "--ulke", "TR", "--osm")
        d = {k["id"]: k for k in self.veri(t)}
        self.assertTrue("n88888888" in d, "yeni OSM yeri eklenmedi")
        self.assertEqual(d["n88888888"]["zengin"]["surum"], 2)
        self.assertEqual(json.loads((t / "state" / "osm_md5.json").read_text())["TR"], "yeni_md5")
        self.assertEqual(json.loads((t / "state" / "sira.json").read_text())["ulkeler"]["TR"]["son_osm"], ortak.bugun())

    def test_supheli_kucuk_osm_dosyasi_veriyi_silmez(self):
        t = self.kur()
        (t / "testler" / "_osm_satirlari.json").write_text(json.dumps([kayit("n1")]), encoding="utf-8")
        self.calistir(t, "calis", "--ulke", "TR", "--osm")
        self.assertGreaterEqual(len(self.veri(t)), 55)
        self.assertFalse((t / "state" / "osm_md5.json").exists(), "uygulanmayan OSM'in md5'i kaydedilmemeli (sonra tekrar denensin)")

    def test_bozuk_data_dosyasina_dokunulmaz(self):
        t = self.kur()
        (t / "data" / "TR.json").write_text("{bozuk", encoding="utf-8")
        self.calistir(t, "calis")
        self.assertEqual((t / "data" / "TR.json").read_text(encoding="utf-8"), "{bozuk")

    def test_motor_yoksa_dongu_cokmez_ve_eski_veri_gecerli_kalir(self):
        t = self.kur()
        (t / "tools" / "zenginlestir.js").unlink()
        self.calistir(t, "calis")
        d = self.veri(t)
        self.assertGreaterEqual(len(d), 55)  # donusturulen yapi yine yayinlanir
        self.assertTrue(any(k.get("zengin", {}).get("surum") == 1 for k in d))

    def test_firebase_kullanici_kaydi_eklenir_sonra_silinir_tekrar_eklenmez(self):
        belgeler = {
            "iyi1": {"country_code": "TR", "latitude": 36.75, "longitude": 28.0, "name": "Kullanici Kampi", "website": "kamp.example.com", "yeniAlan": "deger"},
            "bos": {"country_code": "TR", "name": "koordinatsiz"},
            "alman": {"country_code": "DE", "latitude": 50.0, "longitude": 10.0, "name": "Alman Kampi"},
        }
        t = self.kur(belgeler)
        self.calistir(t, "calis", "+", "temizle", firebase=True)
        d = {k["id"]: k for k in self.veri(t)}
        self.assertIn("u_iyi1", d)
        u = d["u_iyi1"]
        self.assertEqual(u["name_local"], "Kullanici Kampi")
        self.assertEqual(u["_meta"]["kaynak"], "kullanici")
        self.assertEqual(u["_meta"]["ek_alanlar"], {"yeniAlan": "deger"})
        self.assertEqual(u["zengin"]["surum"], 2)
        kalan = json.loads((t / "testler" / "_kalan_belgeler.json").read_text())
        self.assertEqual(kalan, ["projects/p/databases/(default)/documents/yeni_yerler/alman"], "TR belgeleri silinmeli, DE kalmali")
        tp = json.loads((t / "state" / "topluluk.json").read_text(encoding="utf-8"))
        self.assertIn("iyi1", tp["islenen"])
        self.assertEqual(tp["reddedilen"]["bos"]["neden"], "koordinat_yok")
        self.assertEqual(tp["yeni_alanlar"], {"yeniAlan": 1})
        # belge silinemeseydi bile ayni kimlikle ikinci kez eklenmezdi: durumu geri yukleyip tekrar dene
        (t / "testler" / "_firebase_belgeler.json").write_text(json.dumps({"iyi1": belgeler["iyi1"]}), encoding="utf-8")
        self.calistir(t, "calis", firebase=True)
        self.assertEqual(sum(1 for k in self.veri(t) if k["id"] == "u_iyi1"), 1)


if __name__ == "__main__":
    unittest.main()
