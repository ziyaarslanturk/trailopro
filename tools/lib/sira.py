"""Sirada hangi ulke var? Oncelik: elle > kullanici kaydi bekleyen > OSM degisen > zenginlestirilecek kayit bekleyen."""


def _son(durum, cc):
    return ((durum.get("ulkeler") or {}).get(cc) or {}).get("son_islem") or ""


def sec(ulkeler, durum, bekleyen, topluluk, osm_degisen, boyut=None, zorla=None):
    """Dondurur: (ulke, neden) ya da (None, 'is yok')."""
    boyut = boyut or {}
    if zorla:
        return zorla, "elle"

    def anahtar(c):  # en eski islenen once; esitse TR once, sonra kucuk dosya
        return (_son(durum, c), c != "TR", boyut.get(c, 0), c)

    t = [c for c in ulkeler if topluluk.get(c, 0) > 0]
    if t:
        return sorted(t, key=lambda c: (-topluluk[c],) + anahtar(c))[0], "topluluk"
    o = [c for c in ulkeler if c in osm_degisen]
    if o:
        return sorted(o, key=anahtar)[0], "osm"
    b = [c for c in ulkeler if bekleyen.get(c, 0) > 0]
    if b:
        return sorted(b, key=anahtar)[0], "zenginlestirme"
    return None, "is yok"
