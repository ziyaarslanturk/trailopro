# Dünya kamp taraması (Trailo PRO)

Tüm ülkeler için OpenStreetMap'ten kamp alanlarını çeker, `data/XX.json` ile aynı formatta yazar,
birbirine 110 m (ayarlanabilir) içindeki noktalardan bilgisi az olanı eler, kayıtları zenginleştirir
ve GitHub'a kendisi commit'ler. ABD, mevcut düzene göre 5 bölge dosyasına bölünür
(US_NORTHEAST, US_MIDWEST, US_SOUTH, US_WEST, US_PACIFIC).

## Kurulum (bir kez)
1. Bu zip'in içindeki `tools/` klasörünü ve `.github/workflows/dunya-tara.yml` dosyasını repoya (trailopro) kopyalayın, commit + push.
2. GitHub > Settings > Actions > General > Workflow permissions > "Read and write permissions" seçili olsun.

## Çalıştırma
1. Actions > "Dünya kamp taraması" > Run workflow > mod: **pilot** (sadece LU; çıktı `pilot/` klasörüne). Çıktıyı kontrol edin.
2. Pilot çıktısı iyiyse mod: **tam** (veya zamanlama) tüm dünyayı tarar. Kategori tablosu uygulamadaki `packs.json` ile aynıdır (`tools/kategoriler.json`, onaylı).
3. Tam mod 6 saatte bir kendiliğinden devam eder; durum `tools/durum.json` ve her kaydın `notes.note` alanında tutulur. Bitince ülkeler 30 günde bir yenilenir.

## Notlar
- Zenginleştirme: OSM etiketleri (OLANAKLAR, ÜCRET), KONUM + irtifa (Open-Meteo), YAKIN ÇEVRE (Overpass).
  Not işareti "Temel derleme". DOĞA (GBIF) ve ÇEVRE BİLGİSİ (Wikipedia) için mevcut zenginlestir aracı sonradan çalıştırılır.
- Mevcut `data/XX.json` dosyaları silinmez; yeni noktalarla birleştirilir, 110 m içinde olanlardan bilgisi çok olan kalır.
- Yerel deneme: `node tools/dunya-tara.js --mod pilot --ulkeler LU`
