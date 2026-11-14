# Bilgi paketleri (Vikipedi)

Kamp, hayatta kalma, ilk yardım, hastalıklar, bitki, ağaç, mantar, hayvan, hava, gökyüzü ve doğa rotaları konularında
**5 dilde** (tr, en, de, ru, ar) çevrimdışı bilgi. Uygulama bu klasörden indirir.

## Dosyalar
| Dosya | Ne işe yarar |
|---|---|
| `topics.json` | Hangi maddeler dahil (İngilizce Vikipedi başlığı, kategori başına). **Elle düzenlenir.** |
| `categories.json` | Kategori adları (5 dil), uyarı metinleri (5 dil), kaynak/lisans metni. **Elle düzenlenir.** |
| `index.json` | Otomatik. Sürüm, kategori listesi, her paketin yolu, boyutu, `sha256` değeri. Uygulama önce bunu okur. |
| `packs/<dil>/<kategori>.json` | Otomatik. Bir dilde bir kategorinin tüm maddeleri (özet, bölümler, kaynak bağlantısı, uygun lisanslı görsel bilgisi). |
| `report.json` | Otomatik. Bulunamayan maddeler, ayrım sayfaları, eski haliyle korunan paketler, hatalar. |
| `cache/qids.json` | Otomatik. İngilizce başlık → Wikidata kimliği önbelleği. |

Örnek adres: `https://raw.githubusercontent.com/ziyaarslanturk/trailopro/main/knowledge/index.json`

## Her gün ne olur
`.github/workflows/knowledge.yml` her gün 03:17 UTC'de çalışır: testler → `tools/knowledge/build.py` → değişiklik varsa commit.
Vikipedi'de madde sürümü değişmediyse hiçbir şey indirilmez ve commit atılmaz.

## Bozulmaya karşı korumalar
- Paket geçerli değilse (boş, tekrarlı madde, kısa özet, yanlış bağlantı, 8 MB üstü) yazılmaz; **eski paket kalır**.
- Yeni paket eskisinden %30'dan fazla küçülürse yazılmaz; eski paket kalır.
- Ağ/Vikipedi hatasında hiçbir dosya silinmez; hata `report.json`'a yazılır.
- Testler geçmezse paket üretilmez.
- Dosyalar deterministiktir: içerik aynıysa baytlar aynıdır, gereksiz commit olmaz.
- Bir dilde madde yoksa İngilizce metin kullanılır ve madde `"fb": true` ile işaretlenir (uygulama "İngilizce" diye gösterebilir).

## Lisans ve kaynak
Metinler Vikipedi'den, **CC BY-SA 4.0**. Her maddede `url` (kaynak bağlantısı) vardır; uygulamada gösterilmelidir.
Görseller yalnızca serbest lisanslıysa (CC0, kamu malı, CC BY, CC BY-SA) eklenir; `img` alanında dosya, lisans, yazar ve Commons sayfası yazar. NC/ND/GFDL görseller alınmaz.

## Uyarı kodları (`notice`)
`medical`, `foraging`, `poisonous`, `wildlife`. Metinleri `index.json > notices` içinde 5 dilde hazırdır; uygulama ilgili maddede göstermelidir.

## Konu ekleme / çıkarma
`topics.json` içine İngilizce Vikipedi başlığını yaz (tırnak içinde, kategori listesine). Tehlikeli bir tür ise
`{"t": "Amanita phalloides", "notice": "poisonous"}` biçiminde yaz. Sonra Actions > "Bilgi paketlerini güncelle" > Run workflow.
Başlık bulunamazsa `report.json > missing` içinde görünür.

## Yerelde deneme
```
python -m unittest discover -s tools/knowledge -p "test_*.py"
python tools/knowledge/build.py --only first_aid --limit 5     # küçük deneme
```
