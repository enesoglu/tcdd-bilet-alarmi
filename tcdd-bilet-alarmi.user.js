// ==UserScript==
// @name         TCDD Bilet Alarmı
// @namespace    https://github.com/
// @version      1.1.0
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
    saatFiltresi: "",            // "08:00, 12:40" gibi; boş = tüm saatler
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

  function saatFiltresiDizi() {
    return (AYAR.saatFiltresi || "")
      .split(",").map(s => s.trim()).filter(Boolean);
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
      "#bb-panel .onay{display:flex;align-items:center;gap:9px;margin-bottom:15px;color:#b9c3cd;font:600 13px system-ui}";
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

  async function istasyonBul() {
    const liste = await istasyonListesi();
    const bul = ad => liste.find(p => esit(p.name, ad)) ||
                      liste.find(p => buyuk(p.name).includes(buyuk(ad)));
    const dep = bul(AYAR.binis), arr = bul(AYAR.inis);
    if (!dep) throw new Error(`"${AYAR.binis}" istasyonu bulunamadı.`);
    if (!arr) throw new Error(`"${AYAR.inis}" istasyonu bulunamadı.`);
    return { dep, arr };
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

    const data = await r.json(), simdi = Date.now(), saatler = saatFiltresiDizi();

    for (const leg of data.trainLegs || [])
      for (const a of leg.trainAvailabilities || [])
        for (const t of a.trains || []) {
          const seg = (t.trainSegments || []).find(s => s.departureStationId === istasyonlar.dep.id)
                    || (t.trainSegments || [])[0];
          if (!seg) continue;

          const kalkis = zaman(seg.departureTime);
          if (kalkis.getTime() < simdi) continue;                     // kalkmış sefer
          const saat = saatMetni(kalkis), gun = tarihEtiketi(kalkis);
          if (saatler.length && !saatler.includes(saat)) continue;

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
    if (calisiyor) { console.log("%cTakip zaten çalışıyor. Durdurmak için: bbDurdur()", "color:orange"); return; }
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

    const gun = alan("Kaç gün taransın?", "number", AYAR.gunSayisi, { min: 1, max: 30 });
    const aralik = alan("Kontrol aralığı (sn)", "number", AYAR.aralikSn, { min: EN_KISA_ARALIK, max: 3600 });
    const saatler = alan("Saat filtresi (isteğe bağlı)", "text", AYAR.saatFiltresi, { placeholder: "boş = tüm saatler · ör. 08:00, 12:40" });

    const satir = el("div", null); satir.className = "satir";
    satir.append(gun.l, aralik.l);

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
      "▶  TAKİBİ BAŞLAT");

    const not = el("div", "font:400 12.5px/1.5 system-ui;color:#8d99a6;margin-top:16px;text-align:center;",
      "Ses ve masaüstü bildirimi için başlat düğmesine tıklamanız gerekir. " +
      "Ardından bu sekmeyi arka plana alabilirsiniz.");

    const iptal = el("button",
      "width:100%;font:600 14px system-ui;margin-top:10px;padding:10px;border:0;border-radius:8px;background:transparent;color:#7f8c9a;cursor:pointer;",
      "Kapat");
    iptal.onclick = () => k.remove();

    btn.onclick = async () => {
      const yeni = {
        binis: binis.i.value.trim(),
        inis: inis.i.value.trim(),
        gunSayisi: Math.max(1, parseInt(gun.i.value, 10) || 1),
        aralikSn: Math.max(EN_KISA_ARALIK, parseInt(aralik.i.value, 10) || VARSAYILAN.aralikSn),
        saatFiltresi: saatler.i.value.trim(),
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

    kutu.append(binis.l, inis.l, satir, saatler.l, onayKutu, uyari, btn, iptal, not);
    k.appendChild(kutu);
    document.body.appendChild(k);
  }

  window.bbBaslat = () => { panelAc(); return "Ayar paneli açıldı."; };

  /* -------------------------- GİRİŞ NOKTASI ------------------------ */
  ayarlariYukle();
  const userscriptMi = typeof GM_info !== "undefined";

  if (userscriptMi) {
    // Eklenti modunda her sayfada paneli açmak yerine küçük bir düğme gösterilir
    const fab = el("button",
      `position:fixed;right:18px;bottom:18px;z-index:2147483645;font:700 15px system-ui;` +
      `padding:12px 20px;border:0;border-radius:24px;background:${RENK.yesil};color:#fff;cursor:pointer;` +
      "box-shadow:0 4px 16px rgba(0,0,0,.3);", "🚄 Bilet Alarmı");
    fab.title = "TCDD Bilet Alarmı ayarlarını aç";
    fab.onclick = panelAc;
    const ekle = () => document.body && document.body.appendChild(fab);
    if (document.body) ekle(); else window.addEventListener("DOMContentLoaded", ekle);
  } else {
    // Konsola yapıştırma modunda panel doğrudan açılır
    panelAc();
    console.log("%cAyarları kontrol edip BAŞLAT düğmesine tıklayın.", `color:${RENK.yesil};font-size:15px;font-weight:bold`);
  }
})();
