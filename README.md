# TCDD Bilet Alarmı

TCDD e-bilet sisteminde dolu görünen seferleri düzenli aralıklarla kontrol eder ve boş koltuk açıldığında sesli ve görsel alarm verir. Kurulum, sunucu veya bağımlılık gerektirmez; tarayıcı sekmesinde çalışır.

---

## Özellikler

- Seçilen güzergâh için istenen sayıda günü belirli aralıklarla tarar
- Boş koltuk bulunduğunda üç kanaldan uyarı verir:
  - **Sesli alarm** — susturulana kadar çalar, sekme arka plandayken de duyulur
  - **Masaüstü bildirimi** — tarayıcı küçültülmüş olsa dahi görünür, kapatılana kadar ekranda kalır
  - **Tam ekran uyarı** — tren adı, kalkış saati, koltuk sayısı ve en düşük fiyat bilgisiyle
- **Bu sefere git** düğmesi, sefer listesinde ilgili günü açar, treni bulup işaretler
- Kalkış saati geçmiş seferleri listelemez
- Engelli koltukları varsayılan olarak hariç tutulur, isteğe bağlı dahil edilebilir
- Aynı sefer için tekrarlı uyarıları sınırlar (varsayılan: 10 dakika)
- Ayarlar arayüzden yapılır ve tarayıcıda saklanır; kod düzenlemeye gerek yoktur

---

## Kurulum

### Yöntem 1 — Tampermonkey (önerilir)

Bir kez kurulur, siteye her girişte hazır bekler.

1. [Tampermonkey](https://www.tampermonkey.net/) eklentisini tarayıcıya kurun
2. Eklenti panelinden **Yeni script oluştur** seçeneğine tıklayın
3. `tcdd-bilet-alarmi.user.js` dosyasının tamamını yapıştırın ve kaydedin (`Ctrl+S`)
4. [ebilet.tcddtasimacilik.gov.tr](https://ebilet.tcddtasimacilik.gov.tr) adresini açın
5. Sağ alttaki **🚄 Bilet Alarmı** düğmesine tıklayın

### Yöntem 2 — Tarayıcı konsolu

Eklenti kurmadan tek seferlik kullanım için.

1. [ebilet.tcddtasimacilik.gov.tr](https://ebilet.tcddtasimacilik.gov.tr) adresini açın
2. `F12` ile geliştirici araçlarını açıp **Console** sekmesine geçin
3. Konsol yapıştırmayı engelliyorsa istenen ifadeyi yazın (genellikle `allow pasting`)
4. `tcdd-bilet-alarmi.user.js` dosyasının tamamını yapıştırıp `Enter` tuşuna basın

Her iki yöntemde de ayar paneli açılır. Bilgileri doldurup **Takibi Başlat** düğmesine tıklayın.

> **Başlat düğmesi neden gerekli?** Tarayıcılar ses çalma ve bildirim gösterme iznini yalnızca kullanıcı etkileşiminden sonra verir. Bu tıklama olmadan alarm sessiz kalırdı. Düğmeye basıldığında kısa bir test sesi çalınır.

### Öneri: sefer listesi sayfasında başlatın

Sitede aramanızı bir kez yapın ve **sefer listesi ekranı açıkken** alarmı başlatın. Böylece bilet bulunduğunda **Bu sefere git** düğmesi doğrudan ilgili seferi açabilir. Ana sayfada başlatıldığında düğme sefer listesini yeni sekmede açar, ancak otomatik seçim yapamaz.

---

## Ayarlar

Ayarlar panelden yapılır ve tarayıcıda saklanır. Kod düzenlemesi gerekmez.

| Ayar | Açıklama | Varsayılan |
|---|---|---|
| Kalkış istasyonu | Otomatik tamamlamalı istasyon listesinden seçilir | GEBZE |
| Varış istasyonu | Otomatik tamamlamalı istasyon listesinden seçilir | ANKARA GAR |
| Kaç gün taransın | 1 = bugün, 2 = bugün ve yarın | 2 |
| Kontrol aralığı | Saniye cinsinden; en düşük 30 | 60 |
| Saat filtresi | `08:00, 12:40` biçiminde; boş bırakılırsa tüm saatler | boş |
| Engelli koltukları | Tekerlekli sandalye koltuklarının bildirilip bildirilmeyeceği | kapalı |

Varsayılan değerler dosyanın başındaki `VARSAYILAN` bloğundan değiştirilebilir. Bu değerler yalnızca kayıtlı ayar bulunmadığında kullanılır.

---

## Konsol komutları

| Komut | İşlev |
|---|---|
| `bbTest()` | Alarmı test eder; ses ve bildirim denetimi için |
| `bbSustur()` | Çalan alarmı susturur |
| `bbSefereGit()` | Son bulunan seferi açar |
| `bbDurdur()` | Takibi durdurur |
| `bbBaslat()` | Ayar panelini yeniden açar |
| `bbAyarlar()` | Geçerli ayarları döndürür |
| `bbIstasyonlar("ankara")` | İstasyon adı arar |

---

## Sık sorulan sorular

**Sekmeyi kapatabilir miyim?**
Hayır, alarm o sekmede çalışır. Sekme arka plana alınabilir veya tarayıcı küçültülebilir; ses ve masaüstü bildirimi bu durumlarda da çalışır.

**Kontrol aralığı ne olmalı?**
Varsayılan 60 saniye önerilir. Panel 30 saniyenin altına inilmesine izin vermez. Daha sık sorgulama sunucuya gereksiz yük bindirir ve engellenme riskini artırır.

**"Oturum anahtarı bulunamadı" hatası alıyorum.**
Sayfayı yenileyip (`F5`) alarmı yeniden başlatın. Bu anahtar tarayıcı oturumunuza aittir; script yalnızca okur, hiçbir yere göndermez.

**Bilet bulundu ancak satın alamadım.**
Boş koltuklar, özellikle yoğun güzergâhlarda hızla dolabilir. Alarm duyulduğunda **Bu sefere git** düğmesiyle ilerlemek en hızlı yoldur.

**Python sürümü var mı?**
Yok. TCDD sunucusu tarayıcı dışından gelen isteklere `403 Forbidden` yanıtı verdiği için harici istemciler çalışmaz. Proje bu nedenle tarayıcı içinde çalışacak biçimde tasarlanmıştır.

---

## Çalışma mantığı

Script, sitenin kendi kullandığı `train-availability` uç noktasına mevcut tarayıcı oturumuyla istek gönderir ve dönen sefer verisindeki boş koltuk sayılarını okur. Ek bir sunucu, hesap veya API anahtarı gerektirmez; yalnızca kullanıcının kendi oturumunda zaten erişilebilir olan veriyi işler.

Hiçbir kişisel veri toplanmaz, saklanmaz veya üçüncü taraflara aktarılmaz. Ayarlar yalnızca kullanıcının kendi tarayıcısında tutulur.

---

## Sorumluluk reddi

Bu proje eğitim ve kişisel kullanım amacıyla geliştirilmiştir ve **TCDD ile herhangi bir bağlantısı yoktur**. Resmî bir ürün değildir. Kullanım sorumluluğu tamamen kullanıcıya aittir.

Aracın makul aralıklarla (60 saniye ve üzeri) ve TCDD'nin kullanım koşullarına uygun biçimde kullanılması beklenir. TCDD API'sinde yapılacak değişiklikler script'in çalışmasını durdurabilir.
