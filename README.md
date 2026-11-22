# TRAILO PRO – kendini iyileştiren veri döngüsü

```
data/<ÜLKE>.json ─► ham/ (o an işlenen tek ülke)
                      ├─ eski düz metin → yapılandırılmış alan (tek seferlik, otomatik)
                      ├─ OSM yenile: yeni yerler eklenir, kaybolanlar 3 turda silinir
                      ├─ Firebase: kullanıcı kayıtları eklenir
                      └─ motor: yakın noktalar (koordinatlı), doğa (Latince + Türkçe ad), Wikipedia, adres, irtifa…
                    ─► kontrol ─► data/<ÜLKE>.json ─► sıradaki ülke
```
`data/` her an tam ve geçerlidir: sonuç kontrolden geçmezse eski dosya aynen kalır.

## Kurulum (bir kez)
1. Bu klasörün içeriğini repoya koy (`data/` zaten orada). Önce **Testler** workflow'unun yeşil olduğunu gör.
2. Firebase kullanıyorsan: *Settings → Secrets → Actions* içine `FIREBASE_SERVIS_HESABI` (servis hesabı JSON'unun tamamı).
   *Variables* içine (varsayılanlar parantezde): `FIREBASE_TUR` (`firestore` | `rtdb`), `FIREBASE_KOLEKSIYON` (`yeni_yerler`), `FIREBASE_ULKE_ALANI` (`country_code`), RTDB için `FIREBASE_RTDB_URL`.
   Servis hesabına Firestore/RTDB okuma+silme yetkisi ver. Ayarlı değilse bu adım sessizce atlanır.
3. **Önce küçük bir deneme:** *Actions → Dongu → Run workflow*, ülke = `LU`. Bitince `data/LU.json` içinde `zengin` alanını ve Actions özetini kontrol et. Sorun yoksa ülke kutusunu boş bırakıp çalıştır; sonrası kendi kendine döner (6 saatte bir + iş varsa kendini tetikler).

## Önemli kurallar
- **Çift kayıt olmaz:** kullanıcı kaydı `u_<belgeId>` kimliğiyle girer; aynı kimlik ikinci kez eklenmez. Firebase'den silme, ancak veri GitHub'a başarıyla yazıldıktan sonra yapılır. Silme başarısız olursa kayıt tekrar eklenmez, bir sonraki turda yeniden silinmeyi dener.
- Kullanıcı kaydı OSM'e yakınsa (≤50 m) motor tek kayıta birleştirir; kullanıcının girdiği alanlar OSM tarafından ezilmez (`_meta.kullanici_alanlari`).
- Kullanıcı belgesinde tanımadığımız alan varsa `_meta.ek_alanlar` içine alınır ve `state/topluluk.json → yeni_alanlar` altında sayılır (hangi alanı şemaya terfi ettireceğine sen karar verirsin).
- Geçersiz koordinatlı / ülke bölgesi dışındaki kullanıcı kayıtları reddedilir; nedeni `state/topluluk.json → reddedilen` içinde saklanır.
- Bir adım ağ hatasıyla başarısız olursa o kaydın **eski bilgisi silinmez**; `zengin.kaynak.eksik_adimlar` işaretlenir ve 5 kereye kadar yeniden denenir.
- Şemayı büyütürsen `ayar.json` içinde `hedef_surum`'u artır: tüm kayıtlar sırayla yeniden işlenir.

## Uygulama tarafı
`zengin` alanını oku; boş bölüm = kart gösterme. Eski uygulama sürümleri için `notes.description` düz metni hâlâ üretilir (yapıdan türetilir, boş satır içermez). Eski sürümler bırakılınca `tools/zenginlestir.js` içindeki `duzMetin` çağrısı kaldırılabilir; dosyalar yaklaşık %40 küçülür.

## Bilinen sınırlar (dürüst liste)
- Hız, ücretsiz API limitlerine bağlı (Overpass, Nominatim 1 istek/sn, GBIF). Eski veriler hızlıca yapıya çevrilir; koordinat ve Türkçe ad ekleme tüm ülkelerde günler sürebilir. Daha hızlısı için Geofabrik dosyasından yerel indeks (API'siz) yapılabilir.
- Türkçe bitki/hayvan adları GBIF'te olan kadardır; olmayanlarda Latince + İngilizce görünür.
- Geofabrik'te GCC ve GB_IE tek dosya; bu iki grup için OSM yenilemesi her ülke için ayrı indirir (en sık haftada bir).
- Gerçek ağ erişimli parçalar (Overpass, Geofabrik, Firebase) yalnızca sahte yanıtlarla test edildi; ilk gerçek çalışmayı `LU` ile izle.

## Testler
`node --test testler/motor.test.js` ve `python -m unittest discover -s testler`
