# Pafta

NCZ çizimlerini telefonda açmak, koordinat okumak, mesafe ve alan ölçmek ve noktaları NCN, GSI, Excel ya da CSV olarak dışa aktarmak için ücretsiz bir uygulama.

NCZ okuma kısmı (`ncz.js`), Erdinç Örsan ÜNAL'ın GPL lisanslı [Jeomatik NCZ Reader](https://github.com/erdincunal/Jeomatik-NCZ-Reader) projesindeki `ncz_pure.py` dosyasından JavaScript'e aktarılarak türetilmiştir (Copyright © 2026 Erdinç Örsan ÜNAL, GPL-2.0-or-later).

iOS sürümünün Apple App Store üzerinden dağıtılması için telif sahibinden GPL'e ek bir dağıtım izni alınmıştır (10 Ekim 2026). İznin metni: [docs/ios-ek-izin.md](docs/ios-ek-izin.md). Bu izin GPL lisansını ya da başkalarının bu lisanstaki haklarını değiştirmez. Pafta, Jeomatik tarafından yayımlanmış ya da resmi olarak desteklenen bir uygulama değildir.

Netcad, Netcad Yazılım A.Ş.'nin tescilli markasıdır. Pafta, Netcad Yazılım A.Ş. ile bağlantılı değildir.

Lisans: GNU GPL, sürüm 2 veya sonrası.

## Klasörler

- `app/src/main/assets/` — uygulamanın arayüzü (`index.html`) ve NCZ okuyucu (`ncz.js`)
- `app/` — Android kabuğu (WebView, dosya açma/kaydetme, alt banner reklam)
- `docs/` — gizlilik politikası
- `store/` — Google Play görselleri
