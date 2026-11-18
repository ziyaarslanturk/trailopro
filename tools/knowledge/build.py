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

Zenginlestirme (SCHEMA 1 ile uyumlu, yalnizca EKLEME yapar; eski alanlar degismez):
  * gallery   : Wikidata P18 + Commons kategorisinden en fazla 6 serbest lisansli gorsel (u,f,lic,by,p,w,h)
  * facts     : bilimsel ad, IUCN durumu, boy/agirlik/omur/yukseklik (Wikidata'da varsa)
  * taxonomy  : takson zinciri (ust siniftan tur'e)
  * en_extra  : yerel dildeki metin cok kisaysa Ingilizce metin (needs_translation=true)
  Zenginlestirme hata verirse temel paketler yine yazilir; onceki zengin alanlar korunur.
  categories.json'da bir kategoriye "facts": ["scientific_name","iucn","mass","length","lifespan","height","taxonomy"]
  yazilirsa yalnizca bu alanlar o kategoride gosterilir (yazilmazsa hepsi; Wikidata'da olmayan alan zaten gelmez).
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

GALLERY_MAX = 6
GALLERY_MIN_WIDTH = 600
GALLERY_REFRESH_DAYS = 30
THIN_CHARS = 1500
EN_EXTRA_CHARS = 8000
OK_MIME = ("image/jpeg", "image/png", "image/webp")
BAD_FILE = re.compile(
    r"(icon|logo|flag|symbol|stub|question_book|commons-|pencil|status_iucn|red_x|ambox|edit-|"
    r"crystal|nuvola|padlock|increase|decrease|steady)", re.I)
IUCN = {
    "Q211005": "LC", "Q719675": "NT", "Q278113": "VU", "Q11394": "EN", "Q219127": "CR",
    "Q237350": "EW", "Q239509": "EX", "Q3245245": "DD", "Q3350324": "NE",
}
QUANT = {"mass": "P2067", "length": "P2043", "lifespan": "P2250", "height": "P2048"}
ALL_FACTS = {"scientific_name", "iucn", "taxonomy"} | set(QUANT)

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


def commons_page(file_title):
    return "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(file_title.replace(" ", "_"), safe=":_(),'!*-.~")


def parse_claims(c):
    """Wikidata 'claims' sozlugunden ihtiyac duyulan alanlari ayiklar (bozuk veriye dayanikli)."""
    c = c or {}

    def vals(pid):
        st = [s for s in (c.get(pid) or []) if isinstance(s, dict) and s.get("rank") != "deprecated"]
        st.sort(key=lambda s: s.get("rank") != "preferred")
        out = []
        for s in st:
            dv = (s.get("mainsnak") or {}).get("datavalue")
            if dv and "value" in dv:
                out.append(dv["value"])
        return out

    def eid(pid):
        v = vals(pid)
        return v[0].get("id") if v and isinstance(v[0], dict) else None

    def string(pid):
        v = vals(pid)
        return v[0] if v and isinstance(v[0], str) else None

    quant = {}
    for key, pid in QUANT.items():
        v = vals(pid)
        if v and isinstance(v[0], dict) and "amount" in v[0]:
            try:
                amt = float(v[0]["amount"])
            except (TypeError, ValueError):
                continue
            unit = str(v[0].get("unit", "")).rsplit("/", 1)[-1]
            quant[key] = (amt, unit if unit.startswith("Q") else "")
    return {"sci": string("P225"), "rank": eid("P105"), "parent": eid("P171"), "iucn": eid("P141"),
            "p18": string("P18"), "p373": string("P373"), "quant": quant}


def fmt_number(x):
    x = round(x, 4)
    return int(x) if x == int(x) else x


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
        self.report = {"missing": [], "disambiguation": [], "fallback": {}, "kept_previous": [], "invalid": [], "errors": [], "thin": []}
        self.commons = {}
        self.taxa, self.labels = {}, {}
        self.cats = load_json(self.k / "categories.json")
        self.topics = topic_list(load_json(self.k / "topics.json"))
        meta = {c["id"] for c in self.cats["categories"]}
        for c in self.topics:
            if c not in meta:
                raise ValueError("categories.json'da yok: " + c)
        self.facts_cfg = {c["id"]: c.get("facts") for c in self.cats["categories"]}

    # ---- yollar
    def pack_path(self, lang, cat):
        return self.k / "packs" / lang / (cat + ".json")

    def save_cache(self, name, obj):
        path = self.k / "cache" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(obj, ensure_ascii=False, indent=0, sort_keys=True) + "\n", encoding="utf-8")

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
                d = self.wiki.api("commons.wikimedia.org", action="query", prop="imageinfo",
                                  iiprop="extmetadata|url|size|mime", iiurlwidth="800", redirects="1",
                                  iiextmetadatafilter="LicenseShortName|Artist", titles="|".join(titles))
            except FetchError as e:
                self.report["errors"].append("commons:%s" % e)
                continue
            q = d.get("query", {})
            alias = {}
            for key in ("normalized", "redirects"):
                for r in q.get(key, []):
                    alias[r["from"]] = r["to"]
            got = {}
            for p in q.get("pages", []):
                ii0 = (p.get("imageinfo") or [{}])[0]
                ii = ii0.get("extmetadata", {})
                got[p.get("title")] = (ii.get("LicenseShortName", {}).get("value"), ii.get("Artist", {}).get("value"),
                                       {"u": ii0.get("thumburl") or ii0.get("url"), "w": ii0.get("width"),
                                        "h": ii0.get("height"), "mime": ii0.get("mime")})
            for n, t in zip(batch, titles):
                x = t
                for _ in range(4):
                    x = alias.get(x, x)
                lic, artist, extra = got.get(x, (None, None, {}))
                if license_ok(lic):
                    self.commons[n] = dict(extra, lic=lic.strip(), by=strip_html(artist), file=x)
                else:
                    self.commons[n] = None
        return {n: self.commons.get(n) for n in names}

    # ---- zenginlestirme (hata verirse temel paketler etkilenmez)
    def _guard(self, name, fn):
        try:
            return fn()
        except Exception as e:  # zenginlestirme asla ana akisi bozmamali
            self.report["errors"].append("%s:%s" % (name, e))
            return None

    def wd_claims(self, qids):
        info = {}
        for i in range(0, len(qids), 25):
            d = self.wiki.api("www.wikidata.org", action="wbgetentities", ids="|".join(qids[i:i + 25]), props="claims")
            for qid, ent in (d.get("entities") or {}).items():
                if "missing" not in ent:
                    info[qid] = parse_claims(ent.get("claims"))
        return info

    def load_taxa(self, info):
        cache = load_json(self.k / "cache" / "taxa.json", {})
        self.taxa = cache
        todo = {x["parent"] for x in info.values() if x.get("parent")}
        for _ in range(25):
            ids = sorted(t for t in todo if t not in cache)
            if not ids:
                break
            for i in range(0, len(ids), 50):
                d = self.wiki.api("www.wikidata.org", action="wbgetentities", ids="|".join(ids[i:i + 50]), props="claims")
                got = d.get("entities") or {}
                for qid in ids[i:i + 50]:
                    ent = got.get(qid) or {}
                    x = parse_claims(ent.get("claims")) if "missing" not in ent else {}
                    cache[qid] = {"n": x.get("sci"), "r": x.get("rank"), "p": x.get("parent")}
            todo = {cache[q]["p"] for q in ids if cache.get(q, {}).get("p")}
        self.save_cache("taxa.json", cache)

    def fetch_labels(self, info):
        cache = load_json(self.k / "cache" / "labels.json", {})
        self.labels = cache
        need = set()
        for x in info.values():
            need.update([x.get("rank"), x.get("iucn")] + [u for _, u in x.get("quant", {}).values()])
        need.update(t.get("r") for t in self.taxa.values())
        ids = sorted(q for q in need if q and q not in cache)
        langs = list(dict.fromkeys(list(self.langs) + ["en"]))
        for i in range(0, len(ids), 50):
            d = self.wiki.api("www.wikidata.org", action="wbgetentities", ids="|".join(ids[i:i + 50]),
                              props="labels", languages="|".join(langs))
            got = d.get("entities") or {}
            for qid in ids[i:i + 50]:
                lb = (got.get(qid) or {}).get("labels") or {}
                cache[qid] = {l: lb[l]["value"] for l in langs if l in lb}
        self.save_cache("labels.json", cache)

    def label(self, qid, lang):
        d = self.labels.get(qid) or {}
        return d.get(lang) or d.get("en") or ""

    def gallery_items(self, x):
        names, first = [], None
        if x.get("p18"):
            first = x["p18"].replace(" ", "_")
            names.append(first)
        if x.get("p373"):
            d = self.wiki.api("commons.wikimedia.org", action="query", list="categorymembers",
                              cmtitle="Category:" + x["p373"], cmtype="file", cmlimit="40")
            for m in (d.get("query") or {}).get("categorymembers", []):
                names.append(m["title"].split(":", 1)[1].replace(" ", "_"))
        names = list(dict.fromkeys(names))
        meta = self.image_meta(names)
        good = []
        for n in names:
            m = meta.get(n)
            if (m and m.get("u") and m.get("mime") in OK_MIME and (m.get("w") or 0) >= GALLERY_MIN_WIDTH
                    and not BAD_FILE.search(n)):
                good.append((n, m))
        good.sort(key=lambda nm: (nm[0] != first, -(nm[1].get("w") or 0), nm[0]))
        return [{"u": m["u"], "f": m["file"], "lic": m["lic"], "by": m["by"], "p": commons_page(m["file"]),
                 "w": m.get("w"), "h": m.get("h")} for n, m in good[:GALLERY_MAX]]

    def galleries(self, info):
        cache = load_json(self.k / "cache" / "gallery.json", {})
        now = datetime.strptime(self.today, "%Y-%m-%d")
        out = {}
        for q, x in sorted(info.items()):
            c = cache.get(q)
            if c and not self.force and (now - datetime.strptime(c["at"], "%Y-%m-%d")).days < GALLERY_REFRESH_DAYS:
                out[q] = c["items"]
                continue
            if not x.get("p18") and not x.get("p373"):
                out[q] = []
                continue
            try:
                items = self.gallery_items(x)
            except FetchError as e:
                self.report["errors"].append("gallery:%s:%s" % (q, e))
                out[q] = c["items"] if c else None  # None: onceki paketteki galeri korunur
                continue
            cache[q] = {"at": self.today, "items": items}
            out[q] = items
        self.save_cache("gallery.json", cache)
        return out

    def enrich(self, qids):
        info = self._guard("claims", lambda: self.wd_claims(qids)) or {}
        self._guard("taxa", lambda: self.load_taxa(info))
        self._guard("labels", lambda: self.fetch_labels(info))
        gal = self._guard("gallery", lambda: self.galleries(info)) or {}
        for q, x in info.items():
            x["gallery"] = gal.get(q)
        return info

    def fact_keys(self, cat):
        cfg = self.facts_cfg.get(cat)
        return ALL_FACTS if cfg is None else set(cfg) & ALL_FACTS

    def facts_for(self, x, lang, keys):
        f = {}
        if "scientific_name" in keys and x.get("sci"):
            f["scientific_name"] = x["sci"]
        if "iucn" in keys and IUCN.get(x.get("iucn")):
            f["iucn"] = {"code": IUCN[x["iucn"]], "label": self.label(x["iucn"], lang)}
        for k in QUANT:
            if k in keys and k in x.get("quant", {}):
                amt, unit = x["quant"][k]
                f[k] = {"v": fmt_number(amt), "unit": self.label(unit, lang) if unit else ""}
        return f

    def taxonomy_for(self, x, lang):
        chain, seen = [], set()
        if x.get("sci"):
            chain.append((x.get("rank"), x["sci"]))
        q = x.get("parent")
        while q and q not in seen and len(chain) < 30:
            seen.add(q)
            t = self.taxa.get(q) or {}
            if t.get("n"):
                chain.append((t.get("r"), t["n"]))
            q = t.get("p")
        return [{"rank": self.label(r, lang), "name": n} for r, n in reversed(chain) if r]

    def decorate(self, a, lang, q, cat, extra, art):
        """Maddeye zengin alanlari ekler; veri yoksa o alanin ESKI degeri korunur (silinmez)."""
        a.pop("en_extra", None)
        x = extra.get(q)
        if x:
            keys = self.fact_keys(cat)
            f = self.facts_for(x, lang, keys)
            tx = self.taxonomy_for(x, lang) if "taxonomy" in keys else []
            for k, v in (("facts", f), ("taxonomy", tx)):
                if v:
                    a[k] = v
                else:
                    a.pop(k, None)
            g = x.get("gallery")
            if g is not None:
                if g:
                    a["gallery"] = g
                    if not a.get("img"):
                        a["img"] = {k: g[0][k] for k in ("u", "f", "lic", "by", "p")}
                else:
                    a.pop("gallery", None)
        if lang != "en" and not a.get("fb"):
            chars = len(a.get("summary", "")) + sum(len(s["t"]) for s in a.get("sections", []))
            en = art.get(("en", q))
            if chars < THIN_CHARS and en:
                secs, total = [], 0
                for s in en.get("sections", []):
                    if total + len(s["t"]) > EN_EXTRA_CHARS:
                        break
                    total += len(s["t"])
                    secs.append(s)
                if en.get("summary") or secs:
                    a["en_extra"] = {"lang": "en", "needs_translation": True, "summary": en.get("summary", ""), "sections": secs}
                    self.report["thin"].append({"title": a["title"], "where": lang})

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
                        art[key]["img"] = {"u": src, "f": m["file"], "lic": m["lic"], "by": m["by"], "p": commons_page(m["file"])}
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

        extra = self.enrich(qids)

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
                    self.decorate(a, lang, q, cat, extra, art)
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
        for k in ("missing", "disambiguation", "invalid", "thin"):
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
    print("paket: %d | eksik: %d | ayrim sayfasi: %d | gecersiz: %d | eski korunan: %d | hata: %d | kisa(en_extra): %d"
          % (len(b.index["packs"]), len(r["missing"]), len(r["disambiguation"]), len(r["invalid"]), len(r["kept_previous"]), len(r["errors"]), len(r["thin"])))
    if not b.index["packs"]:
        print("HATA: hic paket yok", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
