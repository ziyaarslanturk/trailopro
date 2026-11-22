"""Firestore REST'in bellekteki sahtesi (sadece testlerde)."""


def tip(v):
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if v is None:
        return {"nullValue": None}
    if isinstance(v, list):
        return {"arrayValue": {"values": [tip(x) for x in v]}}
    if isinstance(v, dict):
        if set(v) == {"latitude", "longitude"}:
            return {"geoPointValue": v}
        return {"mapValue": {"fields": {k: tip(x) for k, x in v.items()}}}
    return {"stringValue": str(v)}


class Yanit:
    def __init__(self, kod, govde=None):
        self.status_code, self._g, self.text = kod, govde, str(govde)[:200]

    def json(self):
        return self._g


class SahteHTTP:
    def __init__(self, belgeler, koleksiyon="yeni_yerler"):
        self.docs = {f"projects/p/databases/(default)/documents/{koleksiyon}/{i}": {k: tip(v) for k, v in d.items()} for i, d in belgeler.items()}
        self.silinen = []

    def post(self, url, json=None, headers=None, timeout=None):
        q = json["structuredQuery"]
        sonuc = []
        for ad, f in self.docs.items():
            w = q.get("where", {}).get("fieldFilter")
            if w and f.get(w["field"]["fieldPath"], {}).get("stringValue") != w["value"]["stringValue"]:
                continue
            doc = {"name": ad, "fields": f}
            if q.get("select"):
                izin = {x["fieldPath"] for x in q["select"]["fields"]}
                doc["fields"] = {k: v for k, v in f.items() if k in izin}
            sonuc.append({"document": doc})
        return Yanit(200, sonuc[: q.get("limit", 100)] or [{"readTime": "x"}])

    def delete(self, url, headers=None, timeout=None):
        ad = url.split("/v1/", 1)[1]
        self.docs.pop(ad, None)
        self.silinen.append(ad)
        return Yanit(200, {})

    def get(self, url, headers=None, timeout=None):
        return Yanit(404, None)
