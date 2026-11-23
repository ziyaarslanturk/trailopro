"""Dunya taramasi (tools/dunya-tara.js + tools/dunya_birlestir.py) hata senaryolari ve uctan uca testler."""
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

KOK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KOK / "tools"))
from lib import zengin as Z, ortak  # noqa: E402


def kayit(i, lat, lon, **ek):
    k = {"id": i, "country_code": "AD", "latitude": lat, "longitude": lon, "name": {"tr": None, "en": None, "de": None, "ru": None, "ar": None},
         "name_local": None, "fee": None, "website": None, "phone": None, "notes": {"description": None, "note": None}, "category_ids": [1]}
    k.update(ek)
    return k


class Dunya(unittest.TestCase):
    def kur(self):
        t = Path(tempfile.mkdtemp(prefix="trailo-dunya-"))
        self.addCleanup(shutil.rmtree, t, True)
        for a in ("tools", "testler"):
            shutil.copytree(KOK / a, t / a, ignore=shutil.ignore_patterns("__pycache__", "_*.json"))
        for d in ("data", "ham", "state"):
            (t / d).mkdir()
        (t / "state" / "osm_md5.json").write_text('{"TR": "x", "DE": "y"}')
        return t

    def tara(self, t, *args, env=None):
        e = dict(os.environ, TRAILO_SAHTE_FETCH=str(t / "testler" / "sahte_overpass.js"), TRAILO_SAHTE_AG=str(t / "testler" / "sahte_ag.js"), TRAILO_HIZLI="1")
        e.update(env or {})
        e.pop("GITHUB_OUTPUT", None)
        r = subprocess.run(["node", "tools/dunya-tara.js", *args], cwd=t, env=e, capture_output=True, text=True, timeout=600)
        self.assertEqual(r.returncode, 0, "cikis kodu 0 olmali (hata verme)\n" + r.stdout[-1500:] + r.stderr[-1500:])
        return r

    def veri(self, t, cc="AD", klasor="data"):
        return json.loads((t / klasor / f"{cc}.json").read_text(encoding="utf-8"))

    def durum(self, t, dosya="durum.json"):
        return json.loads((t / "tools" / dosya).read_text(encoding="utf-8"))

    # ---------------------------------------------------------------- normal akis
    def test_yeni_ulke_olusur_kimlikler_kategoriler_tekrar_ve_zenginlestirme(self):
        t = self.kur()
        self.tara(t, "--mod", "tam", "--ulkeler", "AD")
        d = {k["id"]: k for k in self.veri(t)}
        self.assertEqual(sorted(d), ["a4", "a7", "n1"], "node n<id>, way a<2id>, relation a<2id+1>; otel/koordinatsiz/(0,0)/tekrar yok")
        self.assertEqual(d["n1"]["category_ids"], [1, 6, 7])
        self.assertEqual(d["a4"]["category_ids"], [2])
        self.assertEqual(d["n1"]["website"], "a.ad")
        self.assertEqual(d["n1"]["name"]["en"], "Camp A")
        self.assertEqual(d["n1"]["notes"]["description"], "guzel yer", "OSM'in kendi aciklamasi ezilmez")
        self.assertTrue(d["a4"]["notes"]["description"].startswith("KONUM:"), "aciklamasi olmayanlarda yapidan duz metin uretilir")
        for k in d.values():
            self.assertEqual(k["zengin"]["surum"], 2)
            self.assertEqual(Z.zengin_sorunlari(k["zengin"]), [])
            self.assertNotIn("_bekle", k)
        du = self.durum(t)["AD"]
        self.assertTrue(du["tamam"] and du["sayi"] == 3 and du["kalan"] == 0 and du["hata"] is None)
        man = json.loads((t / "data" / "manifest.json").read_text())["countries"]["AD"]
        self.assertEqual(man["count"], 3)
        once = (t / "data" / "AD.json").read_bytes()
        self.tara(t, "--mod", "tam", "--ulkeler", "AD")      # ikinci calisma: taze + tamam -> hicbir sey yapmaz
        self.assertEqual(once, (t / "data" / "AD.json").read_bytes())

    def test_eski_tarama_yenilenince_zenginlestirme_ve_kayitlar_korunur(self):
        t = self.kur()
        self.tara(t, "--mod", "tam", "--ulkeler", "AD")
        once = {k["id"]: k for k in self.veri(t)}
        du = self.durum(t)
        du["AD"]["harita"] = "2020-01-01T00:00:00Z"            # 30 gunden eski: yeniden taranir
        (t / "tools" / "durum.json").write_text(json.dumps(du))
        self.tara(t, "--mod", "tam", "--ulkeler", "AD")
        sonra = {k["id"]: k for k in self.veri(t)}
        self.assertEqual(sorted(sonra), sorted(once))
        for i in once:
            self.assertEqual(sonra[i]["zengin"], once[i]["zengin"], "mevcut zenginlestirme ezilmemeli")
        self.assertNotEqual(self.durum(t)["AD"]["harita"], "2020-01-01T00:00:00Z")

    def test_retry_429_ve_alt_bolgeye_bolme(self):
        t = self.kur()
        self.tara(t, "--mod", "tam", "--ulkeler", "AO,BR")
        self.assertEqual([k["id"] for k in self.veri(t, "AO")], ["n21"])
        self.assertEqual(sorted(k["id"] for k in self.veri(t, "BR")), ["n41", "n42"])

    def test_osm_sonucu_bos_olan_yeni_ulke_dosya_olusturmaz_ama_tamam_sayilir(self):
        t = self.kur()
        self.tara(t, "--mod", "tam", "--ulkeler", "AM")
        self.assertFalse((t / "data" / "AM.json").exists())
        self.assertTrue(self.durum(t)["AM"]["tamam"])

    # ---------------------------------------------------------------- hata senaryolari
    def test_overpass_hatalari_veri_olusturmaz_bekleme_suresi_koyar_cokmez(self):
        t = self.kur()
        self.tara(t, "--mod", "tam", "--ulkeler", "AF,AG,AL,AZ", "--sure", "600")
        for cc in ("AF", "AG", "AL", "AZ"):
            self.assertFalse((t / "data" / f"{cc}.json").exists(), f"{cc}: kismi/bozuk yanit veri uretmemeli")
        du = self.durum(t)
        for cc in ("AF", "AG", "AL", "AZ"):
            self.assertEqual(du[cc]["hata"]["n"], 1)
            self.assertGreater(du[cc]["sonraki"], ortak.simdi())
            self.assertFalse(du[cc].get("tamam"))
        self.tara(t, "--mod", "tam", "--ulkeler", "AF,AG,AL,AZ")   # bekleme suresi dolmadan tekrar denenmez
        self.assertEqual(self.durum(t)["AF"]["hata"]["n"], 1)

    def test_art_arda_overpass_hatasinda_calisma_erken_biter(self):
        t = self.kur()
        self.tara(t, "--mod", "tam", "--ulkeler", "AF,AG,AL,AZ,BR", "--sure", "600")   # sira: AF AG AL AZ BR
        self.assertNotIn("BR", self.durum(t), "4 ardisik Overpass hatasindan sonra durmali")
        self.assertFalse((t / "data" / "BR.json").exists())

    def test_bozuk_veri_dosyasinin_uzerine_yazilmaz(self):
        t = self.kur()
        (t / "data" / "AD.json").write_text("{bozuk", encoding="utf-8")
        self.tara(t, "--mod", "tam", "--ulkeler", "AD", "--zorla")
        self.assertEqual((t / "data" / "AD.json").read_text(encoding="utf-8"), "{bozuk")
        self.assertEqual(self.durum(t)["AD"]["hata"]["n"], 1)

    def test_osm_bos_donerse_mevcut_veri_silinmez(self):
        t = self.kur()
        mevcut = [kayit("n90", 42.0, 1.0, name_local="Eski"), kayit("a92", 42.1, 1.1)]
        (t / "data" / "AM.json").write_text(json.dumps(mevcut), encoding="utf-8")
        (t / "tools" / "durum.json").write_text(json.dumps({"AM": {"harita": "2020-01-01T00:00:00Z", "tamam": "2020-01-01T00:00:00Z"}}))
        self.tara(t, "--mod", "tam", "--ulkeler", "AM")
        self.assertEqual(len(self.veri(t, "AM")), 2)
        self.assertEqual(self.durum(t)["AM"]["hata"]["n"], 1)

    def test_bozuk_durum_dosyasi_yedeklenir_ve_devam_edilir(self):
        t = self.kur()
        (t / "tools" / "durum.json").write_text("{{{", encoding="utf-8")
        self.tara(t, "--mod", "tam", "--ulkeler", "AD")
        self.assertTrue(list((t / "tools").glob("durum.json.bozuk-*")))
        self.assertEqual(len(self.veri(t)), 3)

    def test_python_yoksa_cokmez_veri_olusmaz(self):
        t = self.kur()
        self.tara(t, "--mod", "tam", "--ulkeler", "AD", env={"PYTHON": "/yok/python"})
        self.assertFalse((t / "data" / "AD.json").exists())
        self.assertEqual(self.durum(t)["AD"]["hata"]["n"], 1)

    def test_gecersiz_argumanlar_ve_bilinmeyen_ulke_cokmez(self):
        t = self.kur()
        self.tara(t, "--mod", "xyz", "--sure", "abc", "--ulkeler", "ZZ,QQ", "--bekle", "-5")
        self.tara(t, "--mod", "tam", "--ulkeler", "ZZ")

    # ---------------------------------------------------------------- sahiplik / pilot
    def test_geofabrik_ulkeleri_ve_baska_yoldan_gelen_dosyalar_atlanir(self):
        t = self.kur()
        (t / "data" / "AM.json").write_text(json.dumps([kayit("n1", 42.0, 1.0)]), encoding="utf-8")   # durum yok: dongu.py'nin
        self.tara(t, "--mod", "tam", "--ulkeler", "TR,DE,AM")
        self.assertFalse((t / "tools" / "durum.json").exists() and {"TR", "DE", "AM"} & set(self.durum(t)))

    def test_pilot_data_klasorune_dokunmaz(self):
        t = self.kur()
        self.tara(t, "--mod", "pilot")
        self.assertEqual([k["id"] for k in self.veri(t, "LU", "pilot")], ["n51"])
        self.assertEqual(os.listdir(t / "data"), [])
        self.assertTrue((t / "tools" / "durum-pilot.json").exists())

    def test_dongu_dunya_taramasi_calisan_ulkeye_dokunmaz_tamamlaninca_kapsar(self):
        t = self.kur()
        (t / "data" / "AD.json").write_text(json.dumps([kayit("n1", 42.0, 1.0, name_local="X")]), encoding="utf-8")
        (t / "tools" / "durum.json").write_text(json.dumps({"AD": {"harita": ortak.simdi(), "tamam": None}}))
        env = dict(os.environ, TRAILO_SAHTE_AG=str(t / "testler" / "sahte_ag.js"), TRAILO_HIZLI="1")
        env.pop("GITHUB_OUTPUT", None)
        once = (t / "data" / "AD.json").read_bytes()
        r = subprocess.run([sys.executable, "tools/dongu.py", "calis"], cwd=t, env=env, capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout[-800:] + r.stderr[-800:])
        self.assertEqual(once, (t / "data" / "AD.json").read_bytes(), "dunya taramasi calisirken dongu dokunmamali")
        (t / "tools" / "durum.json").write_text(json.dumps({"AD": {"harita": ortak.simdi(), "tamam": ortak.simdi()}}))
        subprocess.run([sys.executable, "tools/dongu.py", "calis"], cwd=t, env=env, capture_output=True, text=True, timeout=300)
        self.assertEqual(self.veri(t)[0]["zengin"]["surum"], 2, "dunya taramasi bitince dongu dosyayi kapsar")

    def test_dongu_dunya_dosyalari_henuz_yoksa_sessizce_gecer(self):
        t = self.kur()           # data/ bos, durum.json yok
        env = dict(os.environ, TRAILO_HIZLI="1")
        env.pop("GITHUB_OUTPUT", None)
        r = subprocess.run([sys.executable, "tools/dongu.py", "calis"], cwd=t, env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout[-500:] + r.stderr[-500:])
        self.assertNotIn("Traceback", r.stderr)


class KategoriUyumu(unittest.TestCase):
    def test_js_kategori_kurallari_osm_cek_ile_birebir_ayni(self):
        try:
            import importlib.util
            old = os.getcwd()
            tmp = tempfile.mkdtemp()
            os.chdir(tmp)
            spec = importlib.util.spec_from_file_location("osm_cek_t", KOK / "tools" / "osm_cek.py")
            m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(m)
            os.chdir(old)
        except Exception as e:
            self.skipTest(f"osm_cek yuklenemedi: {e}")
        anahtar = ["tents", "caravans", "motorhome", "drinking_water", "power_supply", "openfire", "campfire", "fireplace", "toilets", "shower", "shop", "restaurant",
                   "food", "internet_access", "parking", "capacity:parking", "dog", "pets", "fishing", "supervised", "security", "beach", "natural", "bbq", "barbecue",
                   "playground", "firewood", "horse", "riding", "4wd_only", "swimming", "swimming_pool", "tourism"]
        deger = ["yes", "no", "designated", "permissive", "true", "wlan", "wifi", "20", "beach", "camp_site", "caravan_site", "", "x"]
        rnd = random.Random(7)
        vakalar = []
        for _ in range(400):
            t = {k: rnd.choice(deger) for k in rnd.sample(anahtar, rnd.randint(0, 9))}
            t["tourism"] = rnd.choice(["camp_site", "caravan_site"])
            vakalar.append(t)
        js = "const {kategoriHesapla}=require('./tools/dunya-tara.js');const v=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(JSON.stringify(v.map(kategoriHesapla)))"
        r = subprocess.run(["node", "-e", js], cwd=KOK, input=json.dumps(vakalar), capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), [m.build_categories(t) for t in vakalar])


if __name__ == "__main__":
    unittest.main()
