# Dünya kamp taraması (Trailo PRO)

`tools/dunya-tara.js` her ülke için OpenStreetMap'ten (Overpass) `tourism=camp_site` ve `caravan_site` kayıtlarını çeker.
Ham satırları `tools/dunya_birlestir.py`'a verir. O da `data/XX.json` ile **güvenle** birleştirir ve sırasıyla şunları yapar:

1. Aynı OSM kimliği varsa günceller (zenginleştirme ve kullanıcı bilgisi korunur), yeni kimlik varsa ekler.
2. **Birbirine 100 m'den yakın noktalardan en az bilgili olanı siler**, bilgisini kalana ekler.
3. Zenginleştirme motorunu (`zenginlestir.js`) çalıştırır: OSM etiketleri, yakın çevre (koordinatlı), adres, irtifa, Wikipedia, doğa (Latince + Türkçe ad).
4. Kontrol eder, `data/XX.json` ve `manifest.json`'u atomik yazar (yarım dosya oluşmaz).

Kategori numaraları projedeki gerçek kurallardan gelir (`osm_cek.py` ile birebir aynı; testle doğrulanır). Taslak kategori tablosuna (`kategoriler.json`) artık gerek yok, silinebilir.

## Kimlik şeması
node → `n<id>`, way → `a<2·id>`, relation → `a<2·id+1>` (osmium ile aynı), böylece Geofabrik tabanlı döngüyle aynı yer aynı kimliği alır.

## Kim hangi ülkeyi yönetir
- Geofabrik ülkeleri (`state/osm_md5.json` içindekiler) ve elle/başka yoldan gelen mevcut dosyalar → **Dongu** (`tools/dongu.py`).
- Henüz olmayan ya da bu aracın ürettiği ülkeler → **Dünya taraması**. Bir ülke için tarama/zenginleştirme sürerken Dongu ona dokunmaz; `tools/durum.json` içinde `tamam` yazınca Dongu da kapsar (stale yenileme, sürüm yükseltme vb.).
- Dünya taraması henüz bir ülkeyi oluşturmadıysa `data/` içinde dosya olmadığı için Dongu onu sessizce atlar.

## Çalıştırma
1. Actions → "Dünya kamp taraması" → Run workflow → mod **pilot** (LU, çıktı `pilot/`). Sonucu kontrol et.
2. Sorun yoksa mod **tam** (ya da zamanlama: 6 saatte bir). Durum `tools/durum.json` içinde tutulur; bitince ülkeler 30 günde bir yenilenir.
3. Yerel deneme: `node tools/dunya-tara.js --mod pilot --ulkeler LU`

## Hata senaryoları (hepsi testle sınanır: `python -m unittest testler.test_dunya`)
| Durum | Davranış |
|---|---|
| Overpass 429/5xx, zaman aşımı, bozuk/kesik JSON, "out of memory" uyarılı kısmi yanıt | Yeniden dener (3 sunucu, bekleme artarak); olmazsa **hiç veri yazmaz**, ülkeyi 30 dk → en çok 24 saat bekletip yeniden dener |
| Art arda 4 ülkede Overpass hatası | Çalışmayı erken bitirir (sunucu kapalıdır) |
| Büyük ülkede tek sorgu olmuyor | Alt bölgelere (ISO3166-2) bölerek çeker; alt bölgelerden biri başarısızsa kısmi sonuç **kabul edilmez** |
| OSM boş/şüpheli küçük sonuç dönerse, ülkenin verisi varsa | Uygulanmaz, mevcut veri korunur |
| `data/XX.json` bozuk | Üzerine **asla** yazılmaz, ülke atlanır |
| `durum.json` bozuk | Yedeklenir (`.bozuk-…`), boştan devam edilir |
| Python/node yok, motor çöker, süre biter | Tamamlanan parçalar kullanılır ya da ülke atlanır; veri yarım yazılmaz |
| Git push çakışması | `git_gonder.sh` eski tabana dayalı sonucu atar, durum dosyası da geri sarılır, sonraki çalışma yeniden yapar |
| Geçersiz argüman/ülke kodu | Yok sayılır, çökmez; çıkış kodu her zaman 0 |
