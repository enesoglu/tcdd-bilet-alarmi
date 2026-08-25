// ==UserScript==
// @name         TCDD Bilet Alarmı
// @namespace    https://github.com/
// @version      1.3.0
// @description  TCDD e-bilet sitesinde boş koltuk çıkınca sesli ve görsel alarm verir, bulunan seferin üzerine götürür.
// @author       Enes Yıldız
// @license      MIT
// @match        https://ebilet.tcddtasimacilik.gov.tr/*
// @icon         https://ebilet.tcddtasimacilik.gov.tr/favicon.ico
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * TCDD Bilet Alarmı
 * https://github.com/
 *
 * Ayarlar arayüzden yapılır; bu dosyayı düzenlemeye gerek yoktur.
 * Aşağıdaki VARSAYILANLAR yalnızca ilk açılışta kullanılır ve
 * arayüzden yapılan değişiklikler tarayıcıda saklanır.
 *
 * Kurulum ve kullanım: README.md
 * Lisans: MIT
 */

(() => {
  "use strict";

  /* ---------------------------------------------------------------
     VARSAYILAN AYARLAR
     Bunları değiştirmek zorunda değilsiniz; arayüzdeki "Ayarlar"
     bölümünden düzenleyebilirsiniz. Buradaki değerler yalnızca
     kayıtlı ayar bulunmadığında geçerlidir.
     --------------------------------------------------------------- */
  const VARSAYILAN = {
    binis: "GEBZE",              // Kalkış istasyonu
    inis: "ANKARA GAR",          // Varış istasyonu
    gunSayisi: 2,                // 1 = bugün, 2 = bugün + yarın, 7 = bir hafta
    // Zaman filtresi — boş bırakılırsa tüm seferler izlenir. Virgülle ayrılır:
    //   "08:00"                 belirli kalkış saati (her gün)
    //   "17:00-23:59"           saat aralığı (her gün)
    //   "26.08"                 yalnızca o tarih (tüm saatler)
    //   "26.08 17:00-23:59"     o tarihte, o saat aralığında
    saatFiltresi: "",
    engelliKoltukDahil: false,   // Tekerlekli sandalye koltukları da bildirilsin mi
    aralikSn: 60,                // Kontroller arası bekleme (saniye)
    tekrarBildirimSn: 600,       // Aynı tren için tekrar uyarı aralığı (saniye)
  };

  const AYAR_ANAHTARI = "tcddBiletAlarmiAyarlar";
  const EN_KISA_ARALIK = 30;     // Sunucuya yük bindirmemek için alt sınır

  /* =============================================================== */

  if (!location.hostname.endsWith("tcddtasimacilik.gov.tr")) {
    alert("Bu script ebilet.tcddtasimacilik.gov.tr adresinde çalıştırılmalıdır.");
    return;
  }
  if (window.__bbYuklendi) { console.log("%cBilet Alarmı zaten yüklü.", "color:orange"); return; }
  window.__bbYuklendi = true;

  const API = "https://web-api-prod-ytp.tcddtasimacilik.gov.tr/tms/train/train-availability?environment=dev&userId=1";
  const CDN = "https://cdn-api-prod-ytp.tcddtasimacilik.gov.tr/datas/station-pairs-INTERNET.json?environment=dev&userId=1";
  const IST = "Europe/Istanbul";
  const AYLAR = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];

  let AYAR = { ...VARSAYILAN };
  const sonBildirim = {};
  let calisiyor = false, durduruldu = false, istasyonlar = null, hataSayaci = 0, sonBulunan = null;
  let ctx = null, alarmAcik = false, alarmTimer = null, baslikTimer = null;
  const orjBaslik = document.title;

  /* ------------------------- AYAR SAKLAMA ------------------------- */
  function ayarlariYukle() {
    try {
      const kayitli = JSON.parse(localStorage.getItem(AYAR_ANAHTARI) || "{}");
      AYAR = { ...VARSAYILAN, ...kayitli };
    } catch (e) {
      AYAR = { ...VARSAYILAN };
    }
  }

  function ayarlariKaydet(yeni) {
    AYAR = { ...AYAR, ...yeni };
    try { localStorage.setItem(AYAR_ANAHTARI, JSON.stringify(AYAR)); } catch (e) {}
  }

  /* Zaman filtresini çözümler. Desteklenen biçimler:
       "08:00"  ·  "17:00-23:59"  ·  "26.08"  ·  "26.08 17:00-23:59"     */
  function filtreCozumle() {
    return filtreCozumleMetin(AYAR.saatFiltresi);
  }

  function filtreCozumleMetin(metin) {
    const ham = (metin || "").split(",").map(s => s.trim()).filter(Boolean);
    const kurallar = [];
    for (const p of ham) {
      const m = p.match(/^(?:(\d{1,2})[.\/](\d{1,2})\s*)?(?:(\d{1,2}):(\d{2})\s*(?:-\s*(\d{1,2}):(\d{2}))?)?$/);
      if (!m) { console.warn(`Zaman filtresi anlaşılamadı, yok sayılıyor: "${p}"`); continue; }
      const [, gg, aa, s1, d1, s2, d2] = m;
      if (!gg && !s1) continue;
      const iki = n => String(n).padStart(2, "0");
      kurallar.push({
        tarih: gg ? `${iki(gg)}.${iki(aa)}` : null,
        bas: s1 ? `${iki(s1)}:${d1}` : null,
        bit: s2 ? `${iki(s2)}:${d2}` : (s1 ? `${iki(s1)}:${d1}` : null),
      });
    }
    return kurallar;
  }

  /* Kayıtlı filtre metninden panelin ihtiyaç duyduğu parçaları çıkarır */
  function tarihFiltresiCozumle(metin) {
    return [...new Set(filtreCozumleMetin(metin).filter(k => k.tarih).map(k => k.tarih))];
  }
  function saatFiltresiCozumle(metin) {
    return filtreCozumleMetin(metin)
      .filter(k => k.tarih && k.bas && k.bas === k.bit)
      .map(k => `${k.tarih} ${k.bas}`);
  }

  /* Seçilen günlerin bugünden itibaren kaç günlük tarama gerektirdiği */
  function gerekenGunSayisi(gunKumesi) {
    if (!gunKumesi || !gunKumesi.size) return VARSAYILAN.gunSayisi;
    const bugun = new Date(); bugun.setHours(0, 0, 0, 0);
    let enUzak = 1;
    for (const g of gunKumesi) {
      const [gg, aa] = g.split(".").map(Number);
      for (let i = 0; i < 400; i++) {
        const d = new Date(bugun); d.setDate(bugun.getDate() + i);
        if (d.getDate() === gg && d.getMonth() + 1 === aa) { enUzak = Math.max(enUzak, i + 1); break; }
      }
    }
    return enUzak;
  }

  function filtreyeUyuyor(kurallar, gun, saat) {
    if (!kurallar.length) return true;
    return kurallar.some(k =>
      (!k.tarih || k.tarih === gun) &&
      (!k.bas || (saat >= k.bas && saat <= k.bit)));
  }

  /* ---------------------------- SAAT -----------------------------
     TCDD API'si kalkış saatlerini UTC olarak, ancak sonunda "Z"
     eki olmadan gönderir (ör. "2026-07-31T13:30:00" = 16:30 TSİ).
     Bu nedenle "Z" eklenerek UTC olarak çözülür ve İstanbul
     saatine çevrilir. */
  const zaman = s => new Date(/[Zz]|[+-]\d{2}:\d{2}$/.test(s) ? s : s + "Z");

  const _fmt = new Intl.DateTimeFormat("tr-TR", {
    timeZone: IST, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  });
  function _parcala(d) {
    const p = {};
    for (const x of _fmt.formatToParts(d)) if (x.type !== "literal") p[x.type] = x.value;
    return p;
  }
  const saatMetni = d => { const p = _parcala(d); return `${p.hour}:${p.minute}`; };
  const tarihEtiketi = d => { const p = _parcala(d); return `${p.day}.${p.month}`; };

  /* ----------------------------- SES ----------------------------- */
  function sesHazirla() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function birSiren() {
    try {
      const c = sesHazirla(), t0 = c.currentTime;
      for (let i = 0; i < 4; i++) {
        const o = c.createOscillator(), g = c.createGain();
        o.connect(g); g.connect(c.destination);
        o.type = "sawtooth";
        const t = t0 + i * 0.45;
        o.frequency.setValueAtTime(700, t);
        o.frequency.linearRampToValueAtTime(1500, t + 0.22);
        o.frequency.linearRampToValueAtTime(700, t + 0.42);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.45, t + 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
        o.start(t); o.stop(t + 0.45);
      }
    } catch (e) { console.warn("Ses çalınamadı:", e.message); }
  }

  function alarmBaslat() {
    if (alarmAcik) return;
    alarmAcik = true;
    birSiren();
    alarmTimer = setInterval(birSiren, 2000);
    baslikTimer = setInterval(() => {
      document.title = document.title.startsWith("🚨") ? "🔴 BİLET VAR!" : "🚨 BİLET VAR!";
    }, 700);
  }

  function alarmSustur() {
    alarmAcik = false;
    clearInterval(alarmTimer); clearInterval(baslikTimer);
    document.title = orjBaslik;
    document.getElementById("bb-uyari")?.remove();
    return "Alarm susturuldu.";
  }

  /* --------------------------- ARAYÜZ ---------------------------- */
  const RENK = { yesil: "#27ae60", kirmizi: "#c0392b", koyu: "rgba(20,30,40,.94)" };

  function stilEkle() {
    if (document.getElementById("bb-stil")) return;
    const s = document.createElement("style");
    s.id = "bb-stil";
    s.textContent =
      "@keyframes bbYanip{from{background:rgba(192,57,43,.97)}to{background:rgba(140,20,10,.97)}}" +
      "#bb-uyari button:hover,#bb-panel button:hover{opacity:.88}" +
      "#bb-panel input[type=text],#bb-panel input[type=number]{width:100%;box-sizing:border-box;" +
      "padding:9px 11px;margin-top:5px;border:1px solid #56626e;border-radius:6px;" +
      "background:#1b242e;color:#fff;font:400 15px system-ui}" +
      "#bb-panel label{display:block;margin-bottom:13px;font:600 13px system-ui;color:#b9c3cd;text-align:left}" +
      "#bb-panel .satir{display:flex;gap:14px}#bb-panel .satir>*{flex:1}" +
      "#bb-panel .onay{display:flex;align-items:center;gap:9px;margin-bottom:15px;color:#b9c3cd;font:600 13px system-ui}" +
      // Takvim hücreleri
      "#bb-panel .bb-gun{aspect-ratio:1;border:1px solid #56626e;border-radius:7px;background:#1b242e;" +
      "color:#dfe6ec;font:600 14px system-ui;cursor:pointer;padding:0;transition:.12s}" +
      "#bb-panel .bb-gun:hover{border-color:#8d99a6;background:#22303d}" +
      "#bb-panel .bb-gun.bugun{border-color:#8d99a6}" +
      `#bb-panel .bb-gun.secili{background:${RENK.yesil};border-color:${RENK.yesil};color:#fff}` +
      "#bb-panel input[type=checkbox]{accent-color:" + RENK.yesil + "}";
    document.head.appendChild(s);
  }

  function el(tag, stil, metin) {
    const e = document.createElement(tag);
    if (stil) e.style.cssText = stil;
    if (metin !== undefined) e.textContent = metin;
    return e;
  }

  /* ------------------------ UYARI EKRANI ------------------------- */
  function ekranUyarisi(baslik, satirlar) {
    stilEkle();
    document.getElementById("bb-uyari")?.remove();
    const k = el("div",
      "position:fixed;inset:0;z-index:2147483647;background:rgba(192,57,43,.97);color:#fff;" +
      "font:600 20px/1.6 system-ui,Segoe UI,Arial,sans-serif;display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;text-align:center;white-space:pre-line;padding:40px;" +
      "animation:bbYanip 1s infinite alternate;");
    k.id = "bb-uyari";

    const bilgi = el("div", "font-size:26px;margin-bottom:28px;max-width:900px;", `🚄 ${baslik}\n\n${satirlar}`);

    const btnAl = el("button",
      `font:700 20px system-ui;padding:16px 34px;margin:8px;border:0;border-radius:8px;background:#fff;color:${RENK.kirmizi};cursor:pointer;`,
      "BU SEFERE GİT →");
    btnAl.onclick = () => { alarmSustur(); sefereGit(); };

    const btnSus = el("button",
      "font:700 20px system-ui;padding:16px 34px;margin:8px;border:2px solid #fff;border-radius:8px;background:transparent;color:#fff;cursor:pointer;",
      "SUSTUR");
    btnSus.onclick = alarmSustur;

    k.append(bilgi, btnAl, btnSus);
    document.body.appendChild(k);
  }

  function masaustuBildirim(baslik, govde) {
    try {
      if (window.Notification && Notification.permission === "granted") {
        const n = new Notification("🚄 " + baslik, {
          body: govde, requireInteraction: true, tag: "bb-" + Date.now()
        });
        n.onclick = () => { window.focus(); n.close(); };
      }
    } catch (e) { console.warn("Bildirim gösterilemedi:", e.message); }
  }

  function tamAlarm(baslik, satirlar) {
    alarmBaslat();
    ekranUyarisi(baslik, satirlar);
    masaustuBildirim(baslik, satirlar.replace(/\n/g, " "));
  }

  /* ------------------ BULUNAN SEFERE YÖNLENDİRME ------------------
     Sefer listesi sayfasındaysa doğru gün sekmesine geçer, ilgili
     treni bulup ortalar, işaretler ve açar. */
  function sefereGit() {
    const liste = "https://ebilet.tcddtasimacilik.gov.tr/sefer-listesi";
    if (!sonBulunan) { window.open(liste, "_blank"); return; }

    const { gun, no } = sonBulunan;                 // gun: "31.07"
    const [gg, aa] = gun.split(".");
    const hedefGun = `${parseInt(gg, 10)} ${AYLAR[parseInt(aa, 10) - 1]}`;

    if (!location.pathname.includes("sefer-listesi")) {
      window.open(liste, "_blank");
      console.log(`%cAçılan sekmede "${hedefGun}" gününe ve ${no} numaralı trene tıklayın.`,
                  `color:${RENK.kirmizi};font-size:14px;font-weight:bold`);
      return;
    }

    const gunBtn = [...document.querySelectorAll("button")].find(b =>
      b.innerText.replace(/\s+/g, " ").trim().startsWith(hedefGun) && b.offsetParent !== null);
    if (gunBtn) gunBtn.click();

    setTimeout(() => {
      // En küçük (en derindeki) eşleşen eleman seçilir; aksi hâlde tüm sayfa eşleşir
      const kart = [...document.querySelectorAll("p, span, div")]
        .filter(e => (e.innerText || "").includes(`: ${no}`) && e.children.length <= 2)
        .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0];
      if (!kart) {
        console.warn(`${no} numaralı tren listede bulunamadı. "${hedefGun}" gününü elle seçin.`);
        return;
      }
      const hedef = kart.closest("[class*='trip'],[class*='sefer'],[class*='card'],[class*='Departure']")
                 || kart.parentElement || kart;
      hedef.scrollIntoView({ behavior: "smooth", block: "center" });
      hedef.style.outline = `4px solid ${RENK.yesil}`;
      hedef.style.borderRadius = "8px";
      setTimeout(() => { try { kart.click(); } catch (e) {} }, 600);
    }, 2500);
  }

  /* -------------------------- İSTASYONLAR ------------------------- */
  const buyuk = s => String(s).toLocaleUpperCase("tr").trim();
  const esit = (a, b) => buyuk(a) === buyuk(b);
  let _istasyonKes = null;

  async function istasyonListesi() {
    if (!_istasyonKes) _istasyonKes = await fetch(CDN).then(r => r.json());
    return _istasyonKes;
  }

  async function istasyonBul(hedef) {
    const { binis, inis } = hedef || AYAR;
    const liste = await istasyonListesi();
    const bul = ad => liste.find(p => esit(p.name, ad)) ||
                      liste.find(p => buyuk(p.name).includes(buyuk(ad)));
    const dep = bul(binis), arr = bul(inis);
    if (!dep) throw new Error(`"${binis}" istasyonu bulunamadı.`);
    if (!arr) throw new Error(`"${inis}" istasyonu bulunamadı.`);
    return { dep, arr };
  }

  /* Belirli bir gün için sefer listesi (panelde seçim yapmak üzere).
     gun: "26.08" · dönen: [{saat, no, tip, bos}] */
  async function seferleriGetir(ist, gun) {
    const token = localStorage.getItem("AUTH_TOKEN");
    if (!token) throw new Error("Oturum anahtarı bulunamadı. Sayfayı yenileyin.");
    const [gg, aa] = gun.split(".").map(Number);
    const bugun = new Date(); bugun.setHours(0, 0, 0, 0);
    let hedef = null;
    for (let i = 0; i < 400; i++) {
      const d = new Date(bugun); d.setDate(bugun.getDate() + i);
      if (d.getDate() === gg && d.getMonth() + 1 === aa) { hedef = d; break; }
    }
    if (!hedef) return [];
    const iki = n => String(n).padStart(2, "0");
    const tarih = `${iki(hedef.getDate())}-${iki(hedef.getMonth() + 1)}-${hedef.getFullYear()} 00:00:00`;

    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token, "unit-id": "3895" },
      body: JSON.stringify({
        searchRoutes: [{
          departureStationId: ist.dep.id, departureStationName: ist.dep.name,
          arrivalStationId: ist.arr.id, arrivalStationName: ist.arr.name, departureDate: tarih
        }],
        passengerTypeCounts: [{ id: 0, count: 1 }], searchReservation: false
      })
    });
    if (!r.ok) return [];
    const data = await r.json(), simdi = Date.now(), cikti = [];
    for (const leg of data.trainLegs || [])
      for (const a of leg.trainAvailabilities || [])
        for (const t of a.trains || []) {
          const seg = (t.trainSegments || []).find(s => s.departureStationId === ist.dep.id)
                    || (t.trainSegments || [])[0];
          if (!seg) continue;
          const kalkis = zaman(seg.departureTime);
          if (kalkis.getTime() < simdi) continue;
          const { toplam } = koltukSay(t);
          cikti.push({ saat: saatMetni(kalkis), no: t.number, tip: t.type || "", bos: toplam });
        }
    return cikti.sort((a, b) => a.saat.localeCompare(b.saat));
  }

  /* ------------------------- SEFER SORGUSU ------------------------ */
  function tarihMetni(gunSonra) {
    const d = new Date(); d.setDate(d.getDate() + gunSonra);
    const p = n => String(n).padStart(2, "0");
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} 00:00:00`;
  }

  function koltukSay(tren) {
    const sinif = {}; let enUcuz = null;
    for (const f of tren.availableFareInfo || [])
      for (const cc of f.cabinClasses || []) {
        const kod = cc.cabinClass?.code, ad = cc.cabinClass?.name || kod;
        if (kod === "DSB" && !AYAR.engelliKoltukDahil) continue;   // tekerlekli sandalye
        sinif[ad] = Math.max(sinif[ad] ?? 0, cc.availabilityCount || 0);
        for (const b of cc.bookingClassAvailabilities || [])
          if ((b.availability || 0) > 0 && b.price && (enUcuz === null || b.price < enUcuz)) enUcuz = b.price;
      }
    for (const k in sinif) if (!sinif[k]) delete sinif[k];
    return { sinif, enUcuz, toplam: Object.values(sinif).reduce((a, b) => a + b, 0) };
  }

  async function gunKontrol(gunSonra) {
    const token = localStorage.getItem("AUTH_TOKEN");
    if (!token) throw new Error("Oturum anahtarı bulunamadı. Sayfayı yenileyip tekrar başlatın.");

    const body = {
      searchRoutes: [{
        departureStationId: istasyonlar.dep.id, departureStationName: istasyonlar.dep.name,
        arrivalStationId: istasyonlar.arr.id, arrivalStationName: istasyonlar.arr.name,
        departureDate: tarihMetni(gunSonra)
      }],
      passengerTypeCounts: [{ id: 0, count: 1 }],
      searchReservation: false
    };

    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token, "unit-id": "3895" },
      body: JSON.stringify(body)
    });

    if (r.status === 400) {
      const j = await r.json().catch(() => ({}));
      if (j.code === 604) return;                    // bu tarihte uygun sefer yok
      throw new Error(j.message || "HTTP 400");
    }
    if (!r.ok) throw new Error(`HTTP ${r.status} — sayfayı yenileyip tekrar başlatın`);

    const data = await r.json(), simdi = Date.now(), kurallar = filtreCozumle();

    for (const leg of data.trainLegs || [])
      for (const a of leg.trainAvailabilities || [])
        for (const t of a.trains || []) {
          const seg = (t.trainSegments || []).find(s => s.departureStationId === istasyonlar.dep.id)
                    || (t.trainSegments || [])[0];
          if (!seg) continue;

          const kalkis = zaman(seg.departureTime);
          if (kalkis.getTime() < simdi) continue;                     // kalkmış sefer
          const saat = saatMetni(kalkis), gun = tarihEtiketi(kalkis);
          if (!filtreyeUyuyor(kurallar, gun, saat)) continue;

          const { sinif, enUcuz, toplam } = koltukSay(t);
          const ad = t.commercialName || t.name || t.number;
          const detay = Object.entries(sinif).map(([k, v]) => `${k}: ${v}`).join(", ");
          console.log(`   ${gun} ${saat}  ${ad} → ${toplam ? "%c" + detay : "yer yok"}`,
                      toplam ? `color:${RENK.yesil};font-weight:bold` : "");

          if (toplam > 0) {
            const key = `${gun}|${t.number}`;
            if (simdi - (sonBildirim[key] || 0) >= AYAR.tekrarBildirimSn * 1000) {
              sonBildirim[key] = simdi;
              sonBulunan = { ad, gun, saat, no: t.number, detay, toplam };
              tamAlarm("BİLET BULUNDU!",
                `${ad}   (Tren no: ${t.number})\n${gun} saat ${saat}   ${AYAR.binis} → ${AYAR.inis}\n` +
                `${toplam} boş koltuk (${detay})` + (enUcuz ? `\nEn düşük fiyat: ${enUcuz} TL` : ""));
            }
          }
        }
  }

  /* ---------------------------- DÖNGÜ ----------------------------- */
  async function dongu() {
    calisiyor = true;
    while (!durduruldu) {
      console.log(`%c### Kontrol: ${saatMetni(new Date())}`, "color:#2980b9;font-weight:bold");
      try {
        for (let g = 0; g < AYAR.gunSayisi && !durduruldu; g++) {
          await gunKontrol(g);
          await new Promise(r => setTimeout(r, 800));   // istekler arası bekleme
        }
        hataSayaci = 0;
      } catch (e) {
        hataSayaci++;
        console.warn(`Hata (${hataSayaci}/5): ${e.message}`);
        if (hataSayaci >= 5) {
          tamAlarm("BİLET ALARMI DURDU", `Üst üste hata:\n${e.message}\n\nSayfayı yenileyip tekrar başlatın.`);
          durduruldu = true;
          break;
        }
      }
      for (let i = 0; i < AYAR.aralikSn * 2 && !durduruldu; i++) await new Promise(r => setTimeout(r, 500));
    }
    calisiyor = false;
    console.log("%cBilet Alarmı durdu.", "color:orange;font-weight:bold");
  }

  /* ----------------------- KONSOL KOMUTLARI ----------------------- */
  window.bbSustur = alarmSustur;
  window.bbDurdur = () => { durduruldu = true; alarmSustur(); return "Durduruluyor..."; };
  window.bbSefereGit = () => { sefereGit(); return sonBulunan ? `${sonBulunan.gun} ${sonBulunan.saat} / tren ${sonBulunan.no}` : "Henüz bilet bulunmadı."; };
  window.bbAyarlar = () => ({ ...AYAR });
  window.bbTest = () => {
    tamAlarm("TEST ALARMI", "Bu bir denemedir.\nSes duyuluyor ve bu ekran görünüyorsa kurulum tamamdır.\nSUSTUR ile kapatabilirsiniz.");
    return "Test alarmı çalıştı. Susturmak için: bbSustur()";
  };
  window.bbIstasyonlar = async (arama = "") => {
    const liste = await istasyonListesi();
    const sonuc = liste.filter(p => buyuk(p.name).includes(buyuk(arama))).map(p => p.name);
    console.log(sonuc.length ? sonuc.join("\n") : "Eşleşen istasyon yok.");
    return `${sonuc.length} istasyon bulundu.`;
  };

  /* -------------------------- AYAR PANELİ -------------------------- */
  function panelAc() {
    stilEkle();
    document.getElementById("bb-panel")?.remove();
    ayarlariYukle();

    const k = el("div",
      `position:fixed;inset:0;z-index:2147483646;background:${RENK.koyu};color:#fff;` +
      "font:400 16px/1.6 system-ui,Segoe UI,Arial,sans-serif;display:flex;align-items:center;" +
      "justify-content:center;padding:24px;overflow:auto;");
    k.id = "bb-panel";

    const kutu = el("div", "width:100%;max-width:460px;background:#243140;border-radius:14px;padding:30px;box-shadow:0 12px 40px rgba(0,0,0,.5);");
    kutu.append(
      el("div", "font:700 23px system-ui;margin-bottom:4px;text-align:center;", "🚄 TCDD Bilet Alarmı"),
      el("div", "font:400 14px system-ui;color:#8d99a6;margin-bottom:24px;text-align:center;", "Boş koltuk çıktığında sizi uyarır")
    );

    // Takip sürüyorsa durum çubuğu göster; ayarlar değiştirilip yeniden başlatılabilir
    if (calisiyor) {
      const durum = el("div",
        "display:flex;align-items:center;gap:10px;background:#1d3b2a;border:1px solid #27ae60;" +
        "border-radius:9px;padding:11px 14px;margin-bottom:18px;");
      durum.append(
        el("span", "font:700 13px system-ui;color:#2ecc71;flex:1;",
           `Takip çalışıyor · ${AYAR.binis} → ${AYAR.inis}`));
      const dur = el("button",
        "font:700 12px system-ui;padding:7px 14px;border:0;border-radius:6px;background:#c0392b;color:#fff;cursor:pointer;flex:none;",
        "DURDUR");
      dur.onclick = () => { window.bbDurdur(); k.remove(); panelAc(); };
      durum.appendChild(dur);
      kutu.appendChild(durum);
      kutu.appendChild(el("div", "font:400 12px/1.5 system-ui;color:#8d99a6;margin:-10px 0 16px;",
        "Ayarları değiştirip yeniden başlatırsanız mevcut takip durdurulup yenisi başlar."));
    }

    // İstasyon önerileri
    const liste = document.createElement("datalist");
    liste.id = "bb-istasyon-listesi";
    istasyonListesi().then(ist => {
      ist.forEach(p => { const o = document.createElement("option"); o.value = p.name; liste.appendChild(o); });
    }).catch(() => {});
    kutu.appendChild(liste);

    function alan(baslik, tip, deger, ekstra = {}) {
      const l = el("label", null, baslik);
      const i = document.createElement("input");
      i.type = tip; i.value = deger;
      Object.assign(i, ekstra);
      l.appendChild(i);
      return { l, i };
    }

    const binis = alan("Kalkış istasyonu", "text", AYAR.binis, { placeholder: "ör. GEBZE" });
    const inis  = alan("Varış istasyonu", "text", AYAR.inis, { placeholder: "ör. ANKARA GAR" });
    binis.i.setAttribute("list", "bb-istasyon-listesi");
    inis.i.setAttribute("list", "bb-istasyon-listesi");

    const aralik = alan("Kontrol aralığı (sn)", "number", AYAR.aralikSn, { min: EN_KISA_ARALIK, max: 3600 });

    /* ---- Takvim: hangi günler izlensin ---- */
    const secilenGunler = new Set(tarihFiltresiCozumle(AYAR.saatFiltresi));
    const takvimBaslik = el("label", null, "Hangi günler izlensin?");
    const takvim = el("div", "display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin-top:6px;");
    const gunEtiketleri = el("div", "display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin-top:6px;");
    ["Pt","Sa","Ça","Pe","Cu","Ct","Pz"].forEach(g =>
      gunEtiketleri.appendChild(el("div", "text-align:center;font:700 11px system-ui;color:#6d7a87;", g)));

    const bugun = new Date();
    const gunHucreleri = new Map();
    // Bugünden itibaren 30 gün; hafta hizası için baştaki boşluklar
    const ilkGunIndeksi = (bugun.getDay() + 6) % 7;                 // Pazartesi = 0
    for (let i = 0; i < ilkGunIndeksi; i++) takvim.appendChild(el("div"));

    for (let i = 0; i < 30; i++) {
      const d = new Date(bugun); d.setDate(bugun.getDate() + i);
      const iki = n => String(n).padStart(2, "0");
      const anahtar = `${iki(d.getDate())}.${iki(d.getMonth() + 1)}`;
      const h = el("button", null, String(d.getDate()));
      h.type = "button";
      h.dataset.gun = anahtar;
      h.title = d.toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" });
      h.className = "bb-gun";
      if (secilenGunler.has(anahtar)) h.classList.add("secili");
      if (i === 0) h.classList.add("bugun");
      h.onclick = () => {
        if (secilenGunler.has(anahtar)) secilenGunler.delete(anahtar); else secilenGunler.add(anahtar);
        h.classList.toggle("secili");
        seferleriTazele();
      };
      gunHucreleri.set(anahtar, h);
      takvim.appendChild(h);
    }
    takvimBaslik.append(gunEtiketleri, takvim);
    const takvimNot = el("div", "font:400 12px system-ui;color:#6d7a87;margin:-6px 0 14px;",
      "Hiç gün seçilmezse bugünden itibaren 2 gün izlenir.");

    /* ---- Sefer seçimi: seçilen günlerin gerçek seferleri ---- */
    const seferBaslik = el("label", null, "Hangi seferler izlensin?");
    const seferKutu = el("div",
      "margin-top:6px;max-height:190px;overflow:auto;background:#1b242e;border:1px solid #56626e;" +
      "border-radius:8px;padding:10px;");
    seferBaslik.appendChild(seferKutu);

    const secilenSeferler = new Set(saatFiltresiCozumle(AYAR.saatFiltresi));
    let seferTazeleNo = 0;

    async function seferleriTazele() {
      const benimNo = ++seferTazeleNo;
      const gunler = [...secilenGunler].sort();
      seferKutu.children.length = 0;
      seferKutu.textContent = "";

      if (!binis.i.value.trim() || !inis.i.value.trim()) {
        seferKutu.appendChild(el("div", "color:#6d7a87;font:400 13px system-ui;", "Önce istasyonları girin."));
        return;
      }
      if (!gunler.length) {
        seferKutu.appendChild(el("div", "color:#6d7a87;font:400 13px system-ui;",
          "Takvimden gün seçin; o günün seferleri burada listelenir. Seçim yapılmazsa tüm seferler izlenir."));
        return;
      }
      seferKutu.appendChild(el("div", "color:#6d7a87;font:400 13px system-ui;", "Seferler yükleniyor..."));

      let ist;
      try {
        ist = await istasyonBul({ binis: binis.i.value.trim(), inis: inis.i.value.trim() });
      } catch (e) {
        if (benimNo !== seferTazeleNo) return;
        seferKutu.textContent = "";
        seferKutu.appendChild(el("div", "color:#e74c3c;font:400 13px system-ui;", e.message));
        return;
      }

      const hepsi = [];
      for (const g of gunler) {
        try {
          const list = await seferleriGetir(ist, g);
          list.forEach(s => hepsi.push({ ...s, gun: g }));
        } catch (e) { /* o gün için sefer yok veya hata; sessizce geç */ }
      }
      if (benimNo !== seferTazeleNo) return;

      seferKutu.textContent = "";
      if (!hepsi.length) {
        seferKutu.appendChild(el("div", "color:#6d7a87;font:400 13px system-ui;",
          "Seçilen günlerde sefer bulunamadı."));
        return;
      }

      let oncekiGun = null;
      for (const s of hepsi) {
        if (s.gun !== oncekiGun) {
          oncekiGun = s.gun;
          const bugunMu = gunHucreleri.get(s.gun);
          seferKutu.appendChild(el("div",
            "font:700 12px system-ui;color:#8d99a6;margin:8px 0 5px;",
            bugunMu ? bugunMu.title : s.gun));
        }
        const anahtar = `${s.gun} ${s.saat}`;
        const sat = el("div",
          "display:flex;align-items:center;gap:9px;padding:6px 4px;border-radius:5px;cursor:pointer;");
        const kutucuk = document.createElement("input");
        kutucuk.type = "checkbox";
        kutucuk.checked = secilenSeferler.has(anahtar);
        kutucuk.style.cssText = "width:16px;height:16px;cursor:pointer;flex:none";
        kutucuk.onchange = () => {
          if (kutucuk.checked) secilenSeferler.add(anahtar); else secilenSeferler.delete(anahtar);
        };
        sat.onclick = e => { if (e.target !== kutucuk) { kutucuk.checked = !kutucuk.checked; kutucuk.onchange(); } };
        const durum = s.bos > 0
          ? el("span", "color:#2ecc71;font:700 12px system-ui;flex:none;", `${s.bos} boş`)
          : el("span", "color:#e74c3c;font:600 12px system-ui;flex:none;", "dolu");
        sat.append(kutucuk,
          el("span", "font:700 14px system-ui;color:#fff;flex:none;width:46px;", s.saat),
          el("span", "font:400 12.5px system-ui;color:#8d99a6;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
             `${s.tip || ""} ${s.no}`.trim()),
          durum);
        seferKutu.appendChild(sat);
      }
    }

    const satir = el("div", null); satir.className = "satir";
    satir.append(aralik.l);

    const onayKutu = el("div", null); onayKutu.className = "onay";
    const onay = document.createElement("input");
    onay.type = "checkbox"; onay.checked = !!AYAR.engelliKoltukDahil; onay.id = "bb-dsb";
    onay.style.cssText = "width:17px;height:17px;cursor:pointer";
    const onayEtiket = el("label", "margin:0;cursor:pointer;color:#b9c3cd;font:600 13px system-ui", "Engelli koltukları da bildirilsin");
    onayEtiket.setAttribute("for", "bb-dsb");
    onayKutu.append(onay, onayEtiket);

    const uyari = el("div", "min-height:20px;color:#e74c3c;font:600 13px system-ui;margin-bottom:10px;text-align:center;");

    const btn = el("button",
      `width:100%;font:700 18px system-ui;padding:16px;border:0;border-radius:9px;background:${RENK.yesil};color:#fff;cursor:pointer;margin-top:6px;`,
      calisiyor ? "▶  YENİDEN BAŞLAT" : "▶  TAKİBİ BAŞLAT");

    const not = el("div", "font:400 12.5px/1.5 system-ui;color:#8d99a6;margin-top:16px;text-align:center;",
      "Ses ve masaüstü bildirimi için başlat düğmesine tıklamanız gerekir. " +
      "Ardından bu sekmeyi arka plana alabilirsiniz.");

    const iptal = el("button",
      "width:100%;font:600 14px system-ui;margin-top:10px;padding:10px;border:0;border-radius:8px;background:transparent;color:#7f8c9a;cursor:pointer;",
      "Kapat");
    iptal.onclick = () => k.remove();

    btn.onclick = async () => {
      // Takvim ve sefer seçimlerinden filtre metnini üret
      const secimler = [...secilenSeferler].filter(s => secilenGunler.has(s.split(" ")[0]));
      const seferliGunler = new Set(secimler.map(s => s.split(" ")[0]));
      const saatsizGunler = [...secilenGunler].filter(g => !seferliGunler.has(g));
      const filtre = [...secimler, ...saatsizGunler].sort().join(", ");

      const yeni = {
        binis: binis.i.value.trim(),
        inis: inis.i.value.trim(),
        gunSayisi: gerekenGunSayisi(secilenGunler),
        aralikSn: Math.max(EN_KISA_ARALIK, parseInt(aralik.i.value, 10) || VARSAYILAN.aralikSn),
        saatFiltresi: filtre,
        engelliKoltukDahil: onay.checked,
      };
      if (!yeni.binis || !yeni.inis) { uyari.textContent = "Kalkış ve varış istasyonlarını girin."; return; }
      if (esit(yeni.binis, yeni.inis)) { uyari.textContent = "Kalkış ve varış istasyonu aynı olamaz."; return; }

      ayarlariKaydet(yeni);
      uyari.style.color = "#8d99a6";
      uyari.textContent = "İstasyonlar doğrulanıyor...";
      btn.disabled = true;

      try {
        istasyonlar = await istasyonBul();
      } catch (e) {
        uyari.style.color = "#e74c3c";
        uyari.textContent = e.message + ' Konsola bbIstasyonlar("ankara") yazarak arayabilirsiniz.';
        btn.disabled = false;
        return;
      }

      // Zaten çalışan bir döngü varsa önce onu durdur ve bitmesini bekle
      if (calisiyor) {
        durduruldu = true;
        for (let i = 0; i < 30 && calisiyor; i++) await new Promise(r => setTimeout(r, 100));
      }

      sesHazirla();
      birSiren();                                    // ses testi
      try {
        if (window.Notification && Notification.permission !== "granted") await Notification.requestPermission();
      } catch (e) {}

      k.remove();
      console.log("%c🚄 Takip başladı.", `color:${RENK.yesil};font-size:15px;font-weight:bold`);
      console.log(`Rota: ${istasyonlar.dep.name} → ${istasyonlar.arr.name} · ${AYAR.gunSayisi} gün · ${AYAR.aralikSn} sn`);
      console.log('Komutlar: bbTest() · bbSustur() · bbSefereGit() · bbDurdur() · bbAyarlar() · bbIstasyonlar("ankara")');
      if (window.Notification && Notification.permission !== "granted")
        console.warn("Masaüstü bildirim izni verilmedi. Ses ve ekran uyarısı yine de çalışır. " +
                     "İzin için adres çubuğundaki kilit simgesi > Bildirimler.");

      durduruldu = false; hataSayaci = 0;
      dongu();
    };

    kutu.append(binis.l, inis.l, takvimBaslik, takvimNot, seferBaslik, satir, onayKutu, uyari, btn, iptal, not);
    k.appendChild(kutu);
    document.body.appendChild(k);

    // İstasyon değişince sefer listesini tazele
    let yaz = null;
    [binis.i, inis.i].forEach(i => {
      i.addEventListener("change", () => seferleriTazele());
      i.addEventListener("input", () => { clearTimeout(yaz); yaz = setTimeout(seferleriTazele, 700); });
    });
    seferleriTazele();
  }

  window.bbBaslat = () => { panelAc(); return "Ayar paneli açıldı."; };

  /* -------------------------- GİRİŞ NOKTASI ------------------------ */
  ayarlariYukle();
  const userscriptMi = typeof GM_info !== "undefined";

  if (userscriptMi) {
    // Eklenti modunda her sayfada paneli açmak yerine küçük bir düğme gösterilir
    const fab = el("button",
      `position:fixed;right:24px;bottom:24px;z-index:2147483645;font:700 19px/1 system-ui;` +
      `padding:20px 30px;border:0;border-radius:34px;background:${RENK.yesil};color:#fff;cursor:pointer;` +
      "box-shadow:0 6px 22px rgba(0,0,0,.38);display:flex;align-items:center;gap:10px;", "🚄 Bilet Alarmı");
    fab.title = "TCDD Bilet Alarmı ayarlarını aç";
    fab.onclick = panelAc;
    // Takip sürerken düğme durumu yansıtsın
    setInterval(() => {
      fab.textContent = calisiyor ? "🚄 Takip açık" : "🚄 Bilet Alarmı";
      fab.style.background = calisiyor ? "#1e8449" : RENK.yesil;
    }, 1000);
    const ekle = () => document.body && document.body.appendChild(fab);
    if (document.body) ekle(); else window.addEventListener("DOMContentLoaded", ekle);
  } else {
    // Konsola yapıştırma modunda panel doğrudan açılır
    panelAc();
    console.log("%cAyarları kontrol edip BAŞLAT düğmesine tıklayın.", `color:${RENK.yesil};font-size:15px;font-weight:bold`);
  }
})();
