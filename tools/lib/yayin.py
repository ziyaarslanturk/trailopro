"""data/<ULKE>.json ve manifest.json'u atomik gunceller. Icerik ayniysa dosyaya dokunmaz (git gurultusu yok)."""
import hashlib
import json
from pathlib import Path

from . import ortak


def yayinla(cc, liste, data_dir):
    data_dir = Path(data_dir)
    metin = ortak.json_str(liste)
    b = metin.encode("utf-8")
    hedef = data_dir / f"{cc}.json"
    try:
        eski = hedef.read_bytes()
    except Exception:
        eski = None
    degisti = eski != b
    if degisti:
        ortak.yaz_atomik(hedef, metin)
    sha = hashlib.sha256(b).hexdigest()
    yol = data_dir / "manifest.json"
    man = ortak.json_oku(yol, {})
    if not isinstance(man, dict):
        man = {}
    ulkeler = man.get("countries") if isinstance(man.get("countries"), dict) else {}
    onceki = ulkeler.get(cc) if isinstance(ulkeler.get(cc), dict) else {}
    kayit = {"count": len(liste), "size": len(b), "sha256": sha,
             "updated": onceki.get("updated") if onceki.get("sha256") == sha and onceki.get("updated") else ortak.simdi()}
    if onceki != kayit:
        ulkeler[cc] = kayit
        man["countries"] = dict(sorted(ulkeler.items()))
        ortak.json_yaz(yol, man, girinti=1)
    return {"degisti": degisti, "adet": len(liste), "boyut": len(b)}
