import copy
import json
import shutil
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
L = ["tr", "en", "de", "ru", "ar"]


class FakeWorld:
    """Vikipedi / Wikidata / Commons'un kucuk bir taklidi."""

    def __init__(self):
        self.calls = []
        self.fail = False
        # baslik -> (qid, {dil: sayfa basligi})
        self.items = {
            "Camping": ("Q1", {l: "Camping-" + l for l in L}),
            "Tent": ("Q2", {"en": "Tent"}),
            "First aid": ("Q3", {l: "FirstAid-" + l for l in L}),
            "Snakebite": ("Q4", {"en": "Snakebite", "tr": "Yılan ısırığı"}),
        }
        self.rev = {}
        self.text = {}
        long_text = "Giriş cümlesi burada. " * 3
        for _, (q, links) in self.items.items():
            for lang, title in links.items():
                self.rev[(lang, title)] = 100
                self.text[(lang, title)] = (
                    long_text + "\n\n== Genel ==\nGenel bilgi metni.\n\n=== Alt ===\nAlt bölüm metni.\n\n"
                    "== References ==\nkaynak\n\n== Kaynakça ==\nkaynak\n"
                )
        self.images = {("en", "Camping-en"): "Camp.jpg", ("en", "Tent"): "Tent_nc.jpg"}
        self.licenses = {"File:Camp.jpg": ("CC BY-SA 4.0", '<a href="x">Ali Veli</a>'), "File:Tent nc.jpg": ("CC BY-NC 4.0", "X")}

    def fetch(self, url):
        if self.fail:
            raise build.FetchError("ag yok")
        u = urllib.parse.urlparse(url)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        self.calls.append((u.netloc, q.get("action"), q.get("prop"), q.get("titles") or q.get("ids")))
        host = u.netloc
        if host == "www.wikidata.org":
            return self.wikidata(q)
        if host == "commons.wikimedia.org":
            pages = []
            for t in q["titles"].split("|"):
                lic = self.licenses.get(t)
                pages.append({"title": t, "imageinfo": [{"extmetadata": {
                    "LicenseShortName": {"value": lic[0]}, "Artist": {"value": lic[1]}}}]} if lic else {"title": t, "missing": True})
            return {"query": {"pages": pages}}
        return self.wikipedia(host.split(".")[0], q)

    def wikidata(self, q):
        if "titles" in q:
            it = self.items.get(q["titles"])
            return {"entities": {it[0]: {"id": it[0], "type": "item"}} if it else {"-1": {"site": "enwiki", "title": q["titles"], "missing": ""}}}
        out = {}
        for qid in q["ids"].split("|"):
            for t, (id_, links) in self.items.items():
                if id_ == qid:
                    out[qid] = {"id": qid,
                                "sitelinks": {l + "wiki": {"site": l + "wiki", "title": v} for l, v in links.items() if l + "wiki" in q["sitefilter"].split("|")},
                                "labels": {"tr": {"language": "tr", "value": "Etiket " + t}} if "tr" in q["languages"] else {}}
        return {"entities": out}

    def wikipedia(self, lang, q):
        if q.get("prop") == "info":
            pages = []
            for t in q["titles"].split("|"):
                r = self.rev.get((lang, t))
                pages.append({"pageid": 1, "title": t, "lastrevid": r} if r else {"title": t, "missing": True})
            return {"query": {"pages": pages}}
        t = q["titles"]
        page = {"pageid": 1, "title": t, "extract": self.text[(lang, t)]}
        img = self.images.get((lang, t))
        if img:
            page["pageimage"] = img
            page["thumbnail"] = {"source": "https://upload.example/" + img, "width": 640, "height": 480}
        return {"query": {"pages": [page]}}

    def extract_calls(self):
        return [c for c in self.calls if c[2] and "extracts" in c[2]]


def make_root(tmp):
    k = Path(tmp) / "knowledge"
    k.mkdir()
    cats = json.loads((REPO / "knowledge/categories.json").read_text(encoding="utf-8"))
    (k / "categories.json").write_text(json.dumps(cats, ensure_ascii=False), encoding="utf-8")
    topics = {"schema": 1, "categories": {
        "camping": ["Camping", "Tent"],
        "first_aid": ["First aid", {"t": "Snakebite", "notice": "poisonous"}],
        "plants": ["Yok Boyle Madde"],
    }}
    (k / "topics.json").write_text(json.dumps(topics), encoding="utf-8")
    return Path(tmp)


def run(root, world, **kw):
    b = build.Builder(root, build.Wiki(world.fetch), L, "2026-11-14", log=lambda *a: None, **kw)
    b.run()
    return b


class ParseTests(unittest.TestCase):
    def test_sections_and_skip(self):
        s, sec = build.parse_extract("Lead metni burada.\n\n== A ==\nBir\n\n=== A1 ===\nİki\n\n== References ==\nx\n\n=== Alt ===\ny\n\n== B ==\nÜç", "en")
        self.assertEqual(s, "Lead metni burada.")
        self.assertEqual([x["h"] for x in sec], ["A", "A1", "B"])
        self.assertEqual(sec[1]["l"], 3)

    def test_turkish_skip_and_html(self):
        _, sec = build.parse_extract("Özet <b>kalın</b>.\n\n== Kaynakça ==\nk\n\n== Belirtiler ==\nAteş", "tr")
        self.assertEqual([x["h"] for x in sec], ["Belirtiler"])

    def test_license_filter(self):
        for ok in ("CC BY-SA 4.0", "CC BY 3.0", "CC0", "Public domain", "PD-old"):
            self.assertTrue(build.license_ok(ok), ok)
        for bad in ("CC BY-NC 4.0", "CC BY-ND 2.0", "GFDL", "", None, "Fair use"):
            self.assertFalse(build.license_ok(bad), bad)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = make_root(self.tmp)
        self.world = FakeWorld()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def pack(self, lang, cat):
        return json.loads((self.root / "knowledge/packs" / lang / (cat + ".json")).read_text(encoding="utf-8"))

    def test_full_build(self):
        b = run(self.root, self.world)
        for lang in L:
            self.assertTrue((self.root / "knowledge/packs" / lang / "camping.json").exists())
        tr = {a["id"]: a for a in self.pack("tr", "camping")["articles"]}
        self.assertFalse(tr["Q1"]["fb"])
        self.assertEqual(tr["Q1"]["lang"], "tr")
        self.assertEqual(tr["Q1"]["n"], "Etiket Camping")
        self.assertTrue(tr["Q2"]["fb"])           # Tent: tr maddesi yok -> Ingilizce
        self.assertEqual(tr["Q2"]["lang"], "en")
        self.assertEqual([s["h"] for s in tr["Q1"]["sections"]], ["Genel", "Alt"])
        en = {a["id"]: a for a in self.pack("en", "camping")["articles"]}
        self.assertEqual(en["Q1"]["img"]["lic"], "CC BY-SA 4.0")
        self.assertEqual(en["Q1"]["img"]["by"], "Ali Veli")
        self.assertIsNone(en["Q2"]["img"])        # NC lisansli gorsel gosterilmez
        fa = {a["id"]: a for a in self.pack("tr", "first_aid")["articles"]}
        self.assertEqual(fa["Q3"]["notice"], "medical")
        self.assertEqual(fa["Q4"]["notice"], "poisonous")
        self.assertNotIn("notice", tr["Q1"])
        self.assertEqual(len(b.index["version"]), 12)
        self.assertTrue(any(m["title"] == "Yok Boyle Madde" for m in b.report["missing"]))
        self.assertFalse((self.root / "knowledge/packs/tr/plants.json").exists())  # bos kategori yazilmaz

    def test_incremental_and_deterministic(self):
        run(self.root, self.world)
        files = {p: p.read_bytes() for p in (self.root / "knowledge").rglob("*.json") if "cache" not in p.parts}
        self.world.calls.clear()
        run(self.root, self.world)
        self.assertEqual(self.world.extract_calls(), [])      # degisen yok -> metin indirilmez
        again = {p: p.read_bytes() for p in (self.root / "knowledge").rglob("*.json") if "cache" not in p.parts}
        self.assertEqual(files, again)                         # bayt bayt ayni -> commit yok

    def test_only_changed_article_is_refetched(self):
        run(self.root, self.world)
        before = (self.root / "knowledge/packs/de/camping.json").read_bytes()
        self.world.rev[("tr", "Camping-tr")] = 101
        self.world.text[("tr", "Camping-tr")] += "\n\n== Yeni ==\nEklendi"
        self.world.calls.clear()
        run(self.root, self.world)
        self.assertEqual(len(self.world.extract_calls()), 1)
        self.assertIn("Yeni", [s["h"] for s in self.pack("tr", "camping")["articles"][0]["sections"]])
        self.assertEqual(before, (self.root / "knowledge/packs/de/camping.json").read_bytes())

    def test_network_failure_keeps_everything(self):
        run(self.root, self.world)
        before = {p: p.read_bytes() for p in (self.root / "knowledge").rglob("*.json") if "cache" not in p.parts and p.name != "report.json"}
        self.world.fail = True
        b = run(self.root, self.world)
        after = {p: p.read_bytes() for p in (self.root / "knowledge").rglob("*.json") if "cache" not in p.parts and p.name != "report.json"}
        self.assertEqual(before, after)
        self.assertTrue(b.index["packs"])
        self.assertTrue(b.report["errors"])

    def test_page_failure_reuses_previous(self):
        run(self.root, self.world)
        self.world.rev[("tr", "Camping-tr")] = 105
        orig = self.world.wikipedia

        def flaky(lang, q):
            if q.get("prop") and "extracts" in q["prop"]:
                raise build.FetchError("kesildi")
            return orig(lang, q)
        self.world.wikipedia = flaky
        run(self.root, self.world)
        tr = {a["id"]: a for a in self.pack("tr", "camping")["articles"]}
        self.assertEqual(tr["Q1"]["rev"], 100)                 # eski madde korundu

    def test_regression_guard(self):
        b = run(self.root, self.world)
        path = self.root / "knowledge/packs/en/camping.json"
        big = self.pack("en", "camping")
        art = big["articles"][0]
        big["articles"] = [dict(art, id="Q%d" % (100 + i)) for i in range(10)]
        big["count"] = 10
        path.write_bytes(build.serialize_pack(big))
        before = path.read_bytes()
        small = dict(big, articles=big["articles"][:3], count=3)
        b.write_pack("en", "camping", small)
        self.assertEqual(before, path.read_bytes())
        self.assertTrue(b.report["kept_previous"])

    def test_invalid_pack_rejected(self):
        self.assertTrue(build.validate_pack({"schema": 1, "articles": []}))
        a = {"id": "Q1", "n": "x", "title": "x", "lang": "tr", "summary": "kisa", "url": "https://tr.wikipedia.org/wiki/x", "sections": []}
        self.assertIn("summary", build.validate_article(a, "tr"))
        a["summary"] = "yeterince uzun bir ozet metni var burada"
        self.assertEqual(build.validate_article(a, "tr"), [])
        a["url"] = "http://evil.example/"
        self.assertIn("url", build.validate_article(a, "tr"))

    def test_duplicate_topic_rejected(self):
        with self.assertRaises(ValueError):
            build.topic_list({"categories": {"a": ["X"], "b": ["X"]}})


class RealDataTests(unittest.TestCase):
    """Depodaki gercek konu ve kategori dosyalari tutarli mi?"""

    def test_files_consistent(self):
        cats = json.loads((REPO / "knowledge/categories.json").read_text(encoding="utf-8"))
        topics = build.topic_list(json.loads((REPO / "knowledge/topics.json").read_text(encoding="utf-8")))
        ids = {c["id"] for c in cats["categories"]}
        self.assertEqual(set(topics), ids)
        for c in cats["categories"]:
            self.assertEqual(set(c["name"]), set(L))
            self.assertTrue(all(c["name"].values()))
            if c["notice"]:
                self.assertIn(c["notice"], cats["notices"])
        for code, txt in cats["notices"].items():
            self.assertEqual(set(txt), set(L), code)
            self.assertTrue(all(v.strip() for v in txt.values()), code)
        self.assertEqual(set(cats["attribution"]), set(L))
        for items in topics.values():
            for _, notice in items:
                if notice:
                    self.assertIn(notice, cats["notices"])


if __name__ == "__main__":
    unittest.main()
