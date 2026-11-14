#!/usr/bin/env python3
"""
Trailo PRO bilgi paketi uretici.

Vikipedi/Wikidata'dan, knowledge/topics.json'daki secili maddeleri 5 dilde (tr, en, de, ru, ar) ceker ve
knowledge/packs/<dil>/<kategori>.json dosyalarini uretir. Uygulama bu dosyalari GitHub'dan indirir.

Tasarim kurallari (bozulmama garantisi):
  * Her gun calisir ama YALNIZCA degisen maddeyi indirir (surum numarasi lastrevid ile karsilastirilir).
  * Cikti deterministiktir: icerik ayni ise dosya baytlari ayni olur, boylece gereksiz commit olmaz.
  * Hicbir paket dogrulanmadan yazilmaz. Dogrulama basarisizsa ya da paket oncekinden belirgin kucukse ESKI PAKET KORUNUR.
  * Agda hata olursa (yeniden denemelerden sonra) eski veri silinmez.
  * Yalnizca standart kutuphane kullanilir (bagimlilik yok).
"""
import argparse
import hashlib
import html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 1
LICENSE = "CC BY-SA 4.0"
MAX_ARTICLE_CHARS = 60000
MAX_PACK_BYTES = 8 * 1024 * 1024
REGRESSION_RATIO = 0.7

# Atlanacak bolumler (kaynakca, baglantilar vb.), dil basina kucuk harfle
SKIP_SECTIONS = {
    "tr": {"kaynakça", "dış bağlantılar", "harici bağlantılar", "notlar", "dipnotlar", "ayrıca bakınız", "konuyla ilgili yayınlar", "kaynaklar", "bibliyografya", "dış kaynaklar"},
    "en": {"references", "external links", "further reading", "see also", "notes", "bibliography", "sources", "footnotes"},
    "de": {"einzelnachweise", "weblinks", "literatur", "siehe auch", "anmerkungen", "quellen", "fußnoten"},
    "ru": {"примечания", "литература", "ссылки", "см. также", "источники", "комментарии"},
    "ar": {"مراجع", "المراجع", "وصلات خارجية", "روابط خارجية", "انظر أيضًا", "انظر أيضاً", "هوامش", "ملاحظات", "قراءة موسعة", "المصادر"},
}

ALL_SKIP = set().union(*SKIP_SECTIONS.values())

# Serbest lisansli gorsel kabul listesi (NC / ND ve GFDL kabul edilmez)
LICENSE_OK = re.compile(r"^(CC0\b|Public domain|PD\b|PD-|CC BY(-SA)? [1-4]\.\d\b)", re.I)
LICENSE_BAD = re.compile(r"\b(NC|ND)\b", re.I)

HEADING = re.compile(r"^(={2,6})\s*(.*?)\s*\1\s*$")
TAG = re.compile(r"</?[A-Za-z][^>]{0,80}>")


class FetchError(Exception):
    pass


# ---------------------------------------------------------------------------- ag
class Http:
    """Nazik istemci: User-Agent, istekler arasi bekleme, 429/5xx icin ustel geri cekilme."""

    def __init__(self, user_agent, delay=0.2, retries=5, sleep=time.sleep):
        self.ua = user_agent
        self.delay = delay
        self.retries = retries
        self.sleep = sleep

    def fetch(self, url):
        last = None
        for attempt in range(self.retries):
            self.sleep(self.delay)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": self.ua, "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = json.loads(r.read().decode("utf-8"))
                err = data.get("error") if isinstance(data, dict) else None
                if err and err.get("code") in ("maxlag", "ratelimited", "readonly", "internal_api_error_DBConnectionError"):
                    raise FetchError("api:" + str(err.get("code")))
                return data
            except urllib.error.HTTPError as e:
                last = e
                if e.code not in (429, 500, 502, 503, 504):
                    raise FetchError("http %s %s" % (e.code, url))
                wait = e.headers.get("Retry-After") if e.headers else None
                self.sleep(min(int(wait), 120) if wait and wait.isdigit() else min(2 ** attempt * 2, 60))
            except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError, FetchError) as e:
                last = e
                self.sleep(min(2 ** attempt * 2, 60))
        raise FetchError("%s (%s)" % (url, last))


class Wiki:
    def __init__(self, fetch):
        self.fetch = fetch

    def api(self, host, **params):
        q = {"format": "json", "formatversion": "2"}
        if host.endswith("wikipedia.org") or host.endswith("wikimedia.org"):
            q["maxlag"] = "5"
        q.update(params)
        return self.fetch("https://%s/w/api.php?%s" % (host, urllib.parse.urlencode(q)))


# ------------------------------------------------------------------ metin isleme
def clean(text):
    text = unicodedata.normalize("NFC", text or "")
    text = text.replace("\r", "").replace("\u200b", "").replace("\ufeff", "")
    text = TAG.sub("", text)
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _join(lines):
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def parse_extract(text, lang):
    """'== Baslik ==' isaretli duz metni ozet + bolumlere ayirir; kaynakca vb. bolumleri atar."""
    skip = ALL_SKIP  # dilden bagimsiz: kaynakca benzeri bolumler her dilde atlanir
    lead, sections, cur, skip_level = [], [], None, None
    for line in clean(text).split("\n"):
        m = HEADING.match(line.strip())
        if m:
            level, title = len(m.group(1)), m.group(2).strip()
            if skip_level is not None and level > skip_level:
                continue
            skip_level = None
            if title.casefold() in skip:
                skip_level, cur = level, None
                continue
            cur = {"h": title, "l": level, "lines": []}
            sections.append(cur)
            continue
        if skip_level is not None:
            continue
        (cur["lines"] if cur else lead).append(line)
    out, total = [], 0
    for s in sections:
        body = _join(s["lines"])
        if not body:
            continue
        if total + len(body) > MAX_ARTICLE_CHARS:
            break
        total += len(body)
        out.append({"h": s["h"], "l": s["l"], "t": body})
    summary = _join(lead)
    if not summary and out:
        summary = out[0]["t"].split("\n\n")[0]
    if len(summary) > 3000:
        cut = summary[:3000]
        summary = cut[: cut.rfind("\n\n")] if "\n\n" in cut else cut
    return summary, out


def license_ok(name):
    name = (name or "").strip()
    return bool(LICENSE_OK.match(name)) and not LICENSE_BAD.search(name)


def strip_html(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]*>", "", s or ""))).strip()[:120]


# ------------------------------------------------------------------ is mantigi
def load_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def topic_list(topics):
    """{kategori: [ (baslik, bildirim|None) ]} ve tekrar/eksik denetimi."""
    out, seen = {}, set()
    for cat, items in topics["categories"].items():
        lst = []
        for it in items:
            title, notice = (it, None) if isinstance(it, str) else (it["t"], it.get("notice"))
            if title in seen:
                raise ValueError("konu birden fazla kategoride: " + title)
            seen.add(title)
            lst.append((title, notice))
        out[cat] = lst
    return out


def validate_article(a, lang):
    errs = []
    if not str(a.get("id", "")).startswith("Q"):
        errs.append("id")
    if not a.get("title") or not a.get("n"):
        errs.append("title")
    if len(a.get("summary", "")) < 20:
        errs.append("summary")
    if not str(a.get("url", "")).startswith("https://%s.wikipedia.org/wiki/" % a.get("lang", lang)):
        errs.append("url")
    for s in a.get("sections", []):
        if not (isinstance(s.get("h"), str) and isinstance(s.get("t"), str) and s["t"]):
            errs.append("section")
            break
    return errs


def validate_pack(pack):
    errs = []
    if pack.get("schema") != SCHEMA:
        errs.append("schema")
    if not pack.get("articles"):
        errs.append("bos paket")
    ids = [a["id"] for a in pack.get("articles", [])]
    if len(ids) != len(set(ids)):
        errs.append("tekrarlayan madde")
    if len(serialize_pack(pack)) > MAX_PACK_BYTES:
        errs.append("cok buyuk")
    return errs


def serialize_pack(pack):
    """Her madde ayri satirda: git farklari kucuk kalir, icerik deterministiktir."""
    head = {k: v for k, v in pack.items() if k != "articles"}
    head_s = json.dumps(head, ensure_ascii=False, separators=(",", ":"))[:-1]
    arts = ",\n".join(json.dumps(a, ensure_ascii=False, separators=(",", ":")) for a in pack["articles"])
    return (head_s + ',"articles":[\n' + arts + "\n]}\n").encode("utf-8")


class Builder:
    def __init__(self, root, wiki, langs, today, force=False, only=None, limit=None, log=print):
        self.root = Path(root)
        self.k = self.root / "knowledge"
        self.wiki, self.langs, self.today = wiki, langs, today
        self.force, self.only, self.limit, self.log = force, only, limit, log
        self.report = {"missing": [], "disambiguation": [], "fallback": {}, "kept_previous": [], "invalid": [], "errors": []}
        self.commons = {}
        self.cats = load_json(self.k / "categories.json")
        self.topics = topic_list(load_json(self.k / "topics.json"))
        meta = {c["id"] for c in self.cats["categories"]}
        for c in self.topics:
            if c not in meta:
                raise ValueError("categories.json'da yok: " + c)

    # ---- yollar
    def pack_path(self, lang, cat):
        return self.k / "packs" / lang / (cat + ".json")

    # ---- Wikidata
    def resolve_qids(self, titles):
        path = self.k / "cache" / "qids.json"
        cache = load_json(path, {})
        for t in titles:
            if t in cache:
                continue
            try:
                d = self.wiki.api("www.wikidata.org", action="wbgetentities", sites="enwiki", titles=t, redirects="yes", props="info")
            except FetchError as e:
                self.report["errors"].append("qid:%s:%s" % (t, e))
                continue
            for qid, ent in (d.get("entities") or {}).items():
                if "missing" in ent or not str(ent.get("id", qid)).startswith("Q"):
                    self.report["missing"].append({"title": t, "where": "wikidata"})
                else:
                    cache[t] = ent.get("id", qid)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cache, ensure_ascii=False, indent=0, sort_keys=True) + "\n", encoding="utf-8")
        return cache

    def entities(self, qids):
        out = {}
        sites = "|".join(l + "wiki" for l in self.langs)
        for i in range(0, len(qids), 50):
            batch = qids[i:i + 50]
            d = self.wiki.api("www.wikidata.org", action="wbgetentities", ids="|".join(batch), props="sitelinks|labels",
                              languages="|".join(self.langs), sitefilter=sites)
            for qid, ent in (d.get("entities") or {}).items():
                if "missing" in ent:
                    continue
                out[qid] = {
                    "links": {l: ent.get("sitelinks", {}).get(l + "wiki", {}).get("title") for l in self.langs},
                    "labels": {l: ent.get("labels", {}).get(l, {}).get("value") for l in self.langs},
                }
        return out

    # ---- Vikipedi
    def infos(self, lang, titles):
        res = {}
        for i in range(0, len(titles), 50):
            batch = titles[i:i + 50]
            d = self.wiki.api(lang + ".wikipedia.org", action="query", prop="info", titles="|".join(batch), redirects="1")
            q = d.get("query", {})
            alias = {}
            for key in ("normalized", "redirects"):
                for r in q.get(key, []):
                    alias[r["from"]] = r["to"]
            by_title = {p["title"]: p for p in q.get("pages", [])}
            for t in batch:
                x = t
                for _ in range(4):
                    x = alias.get(x, x)
                p = by_title.get(x)
                if p and not p.get("missing") and not p.get("invalid"):
                    res[t] = {"title": p["title"], "rev": p.get("lastrevid", 0)}
        return res

    def page(self, lang, title):
        d = self.wiki.api(lang + ".wikipedia.org", action="query", prop="extracts|pageimages|pageprops", explaintext="1",
                          exsectionformat="wiki", piprop="thumbnail|name", pithumbsize="640", ppprop="disambiguation",
                          redirects="1", titles=title)
        pages = d.get("query", {}).get("pages", [])
        return pages[0] if pages else None

    def image_meta(self, names):
        todo = [n for n in names if n not in self.commons]
        for i in range(0, len(todo), 50):
            batch = todo[i:i + 50]
            titles = ["File:" + n.replace("_", " ") for n in batch]
            try:
                d = self.wiki.api("commons.wikimedia.org", action="query", prop="imageinfo", iiprop="extmetadata",
                                  iiextmetadatafilter="LicenseShortName|Artist", titles="|".join(titles))
            except FetchError as e:
                self.report["errors"].append("commons:%s" % e)
                continue
            got = {}
            for p in d.get("query", {}).get("pages", []):
                ii = (p.get("imageinfo") or [{}])[0].get("extmetadata", {})
                got[p.get("title")] = (ii.get("LicenseShortName", {}).get("value"), ii.get("Artist", {}).get("value"))
            for n, t in zip(batch, titles):
                lic, artist = got.get(t, (None, None))
                self.commons[n] = {"lic": lic.strip(), "by": strip_html(artist), "file": t} if license_ok(lic) else None
        return {n: self.commons.get(n) for n in names}

    # ---- onceki paketler
    def previous(self):
        prev = {}
        for lang in self.langs:
            for cat in self.topics:
                p = load_json(self.pack_path(lang, cat))
                for a in (p or {}).get("articles", []):
                    prev[(lang, a["id"])] = a
        return prev

    # ---- ana akis
    def run(self):
        titles_by_cat = self.topics
        if self.only:
            titles_by_cat = {c: v for c, v in self.topics.items() if c in self.only}
        if self.limit:
            titles_by_cat = {c: v[: self.limit] for c, v in titles_by_cat.items()}
        all_titles = [t for v in titles_by_cat.values() for t, _ in v]
        qid_of = self.resolve_qids(all_titles)
        for t in all_titles:
            if t not in qid_of and not any(m["title"] == t for m in self.report["missing"]):
                self.report["missing"].append({"title": t, "where": "wikidata"})
        qids = sorted({qid_of[t] for t in all_titles if t in qid_of})
        try:
            ents = self.entities(qids)
        except FetchError as e:
            # Wikidata'ya ulasilamadi: hicbir seyi bozmadan mevcut paketlerle yetin
            self.report["errors"].append("entities:%s" % e)
            self.write_index()
            self.write_report()
            return 0
        prev = self.previous()
        art = {}  # (lang, qid) -> madde
        langs = ["en"] + [l for l in self.langs if l != "en"] if "en" in self.langs else list(self.langs)

        for lang in langs:
            wanted = []
            for t in all_titles:
                q = qid_of.get(t)
                e = ents.get(q) if q else None
                if e and e["links"].get(lang):
                    wanted.append((q, e["links"][lang]))
            try:
                info = self.infos(lang, [w[1] for w in wanted])
            except FetchError as e:
                self.report["errors"].append("infos:%s:%s" % (lang, e))
                info = None
            new_images = {}
            for q, title in wanted:
                p = prev.get((lang, q))
                if info is None:
                    if p:
                        art[(lang, q)] = p
                    continue
                i = info.get(title)
                if not i:
                    self.report["missing"].append({"title": title, "where": lang})
                    continue
                if p and not self.force and not p.get("fb") and p.get("rev") == i["rev"] and p.get("title") == i["title"]:
                    art[(lang, q)] = p
                    continue
                try:
                    pg = self.page(lang, i["title"])
                except FetchError as e:
                    self.report["errors"].append("page:%s:%s:%s" % (lang, title, e))
                    if p:
                        art[(lang, q)] = p
                    continue
                if not pg or pg.get("missing"):
                    continue
                if "disambiguation" in (pg.get("pageprops") or {}):
                    self.report["disambiguation"].append({"title": title, "where": lang})
                    continue
                summary, sections = parse_extract(pg.get("extract", ""), lang)
                a = {
                    "id": q, "n": ents[q]["labels"].get(lang) or i["title"], "title": i["title"], "lang": lang, "fb": False,
                    "rev": i["rev"], "url": "https://%s.wikipedia.org/wiki/%s" % (lang, urllib.parse.quote(i["title"].replace(" ", "_"), safe="_(),'!*-.~")),
                    "summary": summary, "sections": sections, "img": None,
                }
                th = pg.get("thumbnail")
                if th and pg.get("pageimage"):
                    new_images[(lang, q)] = (pg["pageimage"], th.get("source"))
                art[(lang, q)] = a
            if new_images:
                meta = self.image_meta(sorted({v[0] for v in new_images.values()}))
                for key, (name, src) in new_images.items():
                    m = meta.get(name)
                    if m and src:
                        art[key]["img"] = {"u": src, "f": m["file"], "lic": m["lic"], "by": m["by"],
                                           "p": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(m["file"].replace(" ", "_"), safe=":_(),'!*-.~")}
            # Dilde madde yoksa Ingilizce metin (etiketli) kullanilir
            if lang != "en":
                fb = 0
                for t in all_titles:
                    q = qid_of.get(t)
                    if not q or (lang, q) in art or ("en", q) not in art:
                        continue
                    a = dict(art[("en", q)])
                    a["fb"] = True
                    a["n"] = (ents.get(q, {}).get("labels", {}).get(lang)) or a["n"]
                    art[(lang, q)] = a
                    fb += 1
                self.report["fallback"][lang] = fb

        # paketleri yaz
        notice_of = {c["id"]: c.get("notice") for c in self.cats["categories"]}
        built = 0
        for cat, items in titles_by_cat.items():
            for lang in self.langs:
                arts = []
                for t, topic_notice in items:
                    q = qid_of.get(t)
                    a = art.get((lang, q)) if q else None
                    if not a:
                        continue
                    a = dict(a)
                    a["cat"] = cat
                    nt = topic_notice or notice_of.get(cat)
                    if nt:
                        a["notice"] = nt
                    else:
                        a.pop("notice", None)
                    bad = validate_article(a, lang)
                    if bad:
                        self.report["invalid"].append({"title": t, "where": lang, "why": bad})
                        continue
                    arts.append(a)
                pack = {"schema": SCHEMA, "lang": lang, "category": cat, "license": LICENSE,
                        "source": "https://%s.wikipedia.org" % lang, "count": len(arts), "articles": arts}
                if self.write_pack(lang, cat, pack):
                    built += 1
        self.write_index()
        self.write_report()
        return built

    def write_pack(self, lang, cat, pack):
        path = self.pack_path(lang, cat)
        old = load_json(path)
        errs = validate_pack(pack)
        if errs:
            self.report["kept_previous"].append({"pack": "%s/%s" % (lang, cat), "why": errs})
            return path.exists()
        if old and old.get("count", 0) >= 5 and pack["count"] < REGRESSION_RATIO * old["count"]:
            self.report["kept_previous"].append({"pack": "%s/%s" % (lang, cat), "why": "madde sayisi %d -> %d" % (old["count"], pack["count"])})
            return True
        data = serialize_pack(pack)
        if path.exists() and path.read_bytes() == data:
            return True
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)
        return True

    def write_index(self):
        old = load_json(self.k / "index.json", {})
        old_by = {(p["lang"], p["category"]): p for p in old.get("packs", [])}
        packs, counts = [], {}
        for c in self.cats["categories"]:
            for lang in self.langs:
                path = self.pack_path(lang, c["id"])
                if not path.exists():
                    continue
                data = path.read_bytes()
                sha = hashlib.sha256(data).hexdigest()
                pk = json.loads(data.decode("utf-8"))
                o = old_by.get((lang, c["id"]))
                updated = o["updated"] if o and o.get("sha256") == sha else self.today
                packs.append({"lang": lang, "category": c["id"], "path": "packs/%s/%s.json" % (lang, c["id"]),
                              "sha256": sha, "bytes": len(data), "articles": pk.get("count", 0), "updated": updated})
                counts.setdefault(c["id"], {})[lang] = pk.get("count", 0)
        version = hashlib.sha256("".join("%s/%s:%s;" % (p["lang"], p["category"], p["sha256"]) for p in packs).encode()).hexdigest()[:12]
        idx = {
            "schema": SCHEMA, "version": version, "updated": max([p["updated"] for p in packs], default=self.today),
            "license": LICENSE, "languages": self.langs, "attribution": self.cats["attribution"], "notices": self.cats["notices"],
            "categories": [dict(c, counts=counts.get(c["id"], {})) for c in self.cats["categories"] if c["id"] in counts],
            "packs": packs,
        }
        self.index = idx
        (self.k / "index.json").write_text(json.dumps(idx, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    def write_report(self):
        r = self.report
        for k in ("missing", "disambiguation", "invalid"):
            r[k] = sorted(r[k], key=lambda x: json.dumps(x, sort_keys=True))
        (self.k / "report.json").write_text(json.dumps(r, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    ap.add_argument("--langs", default="tr,en,de,ru,ar")
    ap.add_argument("--only", default="", help="virgullu kategori kimlikleri")
    ap.add_argument("--limit", type=int, default=0, help="hata ayiklama: kategori basina ilk N konu")
    ap.add_argument("--force", action="store_true", help="degismemis maddeleri de yeniden indir")
    ap.add_argument("--delay", type=float, default=0.2)
    a = ap.parse_args(argv)
    ua = os.environ.get("WIKI_USER_AGENT", "TrailoPRO-KnowledgeBot/1.0 (https://github.com/ziyaarslanturk/trailopro)")
    wiki = Wiki(Http(ua, delay=a.delay).fetch)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    b = Builder(a.root, wiki, a.langs.split(","), today, force=a.force,
                only=[x for x in a.only.split(",") if x] or None, limit=a.limit or None)
    built = b.run()
    r = b.report
    print("paket: %d | eksik: %d | ayrim sayfasi: %d | gecersiz: %d | eski korunan: %d | hata: %d"
          % (len(b.index["packs"]), len(r["missing"]), len(r["disambiguation"]), len(r["invalid"]), len(r["kept_previous"]), len(r["errors"])))
    if not b.index["packs"]:
        print("HATA: hic paket yok", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
