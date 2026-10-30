# Project Rules - Bot Trading Next

## 1. Aturan Sinkronisasi Dokumentasi (MANDATORY & CRITICAL)
- **Sinkronisasi `prompt.md`:**
  Setiap kali ada perubahan kode, `.env`, `package.json`, `Dockerfile`, `docker-compose.yml`, arsitektur, mekanisme eksekusi, indikator teknikal, strategi, risk management, atau proses bisnis bot trading ini, **WAJIB** memperbarui dan menyelaraskan file [prompt.md](file:///home/alvin/Development/bot-trading-next/prompt.md).
  - Bahasa [prompt.md](file:///home/alvin/Development/bot-trading-next/prompt.md) wajib menggunakan **bahasa Inggris teknis formal (*Industry Standard High-Frequency Trading Specification*)**.
  - Seluruh skema DDL SQLite, alur diagram, tabel mitigasi error, parameter strategi, struktur file, hingga wireframe UI harus 100% identik dan konsisten dengan implementasi kode aktual, sehingga file prompt ini dapat digunakan di kemudian hari untuk mereproduksi kode yang sama persis tanpa celah ambigu.

- **Sinkronisasi `README.md`:**
  Setiap perubahan yang sama juga **WAJIB** disinkronkan ke dalam file [README.md](file:///home/alvin/Development/bot-trading-next/README.md) dalam **bahasa Indonesia formal yang baik, benar, dan mudah dipahami**.
  - **Gaya Bahasa & Nada:** Gunakan bahasa Indonesia formal yang lugas, mengalir alami, tidak kaku atau berbelit-belit, dan tidak berlebihan (*anti-lebay*).
  - **Minimalkan Ikon/Emoji:** Hindari penumpukan emoji yang berlebihan. Dokumentasi harus berpenampilan bersih (*clean*), elegan, dan profesional.
  - **Agnostik Pengguna & Relevan untuk Publik:** Seluruh panduan (instalasi, perintah shell, konfigurasi lingkungan) harus bersifat generik dan relevan dibaca orang lain. DILARANG mencantumkan path lokal personal (misalnya `/home/alvin/...`) atau kredensial/token pribadi; selalu gunakan placeholder generik standar.
  - **Kelengkapan Teknis:** Dokumentasi wajib mencakup deskripsi sistem, alur & strategi filter sinyal, kalkulasi risiko dengan contoh numerik riil (modal, leverage, SL, TP, fee, dan net profit), panduan konfigurasi platform eksternal (Binance, SumoPod, Telegram), serta petunjuk instalasi dan monitoring.

---

## 2. Batasan Arsitektur & Prinsip Sistem (NON-NEGOTIABLE)
- **Arsitektur Single-Process:**
  Trading Core engine (`src/trading-core.js`) dan Express Dashboard Server (`src/dashboard-server.js`) berjalan berdampingan dalam 1 proses Node.js di dalam container Docker demi efisiensi resource memori (~80MB) dan zero-latency memory sharing via Server-Sent Events (SSE). Jangan memisahkan proses ini kecuali diminta secara eksplisit oleh user.
- **SQLite Single Source of Truth:**
  Semua operasi database SQLite menggunakan driver `better-sqlite3` yang berjalan secara **sinkron (*strictly synchronous*)** dengan mode `WAL` (`journal_mode = WAL`). DILARANG membungkus kueri SQLite dalam promise async/await palsu.
- **Presisi Finansial:**
  Wajib menggunakan library `bignumber.js` untuk seluruh kalkulasi harga, kuantitas, nominal margin, dan indikator teknikal demi menghindari floating-point rounding drift.
- **Notifikasi Telegram Non-Blocking:**
  Layanan notifikasi eksternal murni menggunakan Telegram Bot API (`services/notifier.js`). Semua pemanggilan REST Telegram wajib diisolasi dalam blok `try ... catch` dengan timeout 5 detik agar kegagalan jaringan Telegram tidak pernah memblokir eksekusi trading Binance.
- **AI Gatekeeper (SumoPod):**
  Menggunakan endpoint `https://ai.sumopod.com/v1/chat/completions` dengan model MiMo (`mimo-v2.6-flash`). Sentimen AI berfungsi sebagai filter veto makro pra-eksekusi dan pemicu emergency exit jika sentimen ekstrem berlawanan arah dengan posisi aktif. Dilengkapi in-memory headline cache untuk menghemat kuota token AI.

---

## 3. Parameter Manajemen Risiko (Strategy Bounds)
- **Pair & Timeframe:** `BTCUSDT`, 5 Menit (`5m`), Leverage 25x.
- **Risk Per Trade:** Maksimal 1.5% dari Available Margin akun.
- **Stop Loss Floor:** 0.50% (Anti-noise wick guard, memberi ruang napas ~$415 pada harga BTC ~$83.000).
- **Take Profit Target:** 1.00% (Risk-to-Reward Ratio 1:2).
- **Margin Headroom Cap:** Posisi dibatasi maksimal 70% dari kapasitas margin yang tersedia untuk mencegah margin call / likuidasi paksa.
- **Dynamic Trailing Stop:** Aktif mengunci keuntungan saat floating profit melampaui `1.5 * ATR`.
- **Single Concurrent Position (Aturan 1 Posisi):** Maksimal hanya 1 posisi aktif dalam satu waktu (1 open position sampai close position). Tidak ada pyramiding, tidak ada averaging down / martingale, dan tidak ada hedging. Sinyal baru otomatis dilewati jika masih ada posisi aktif di database SQLite / Binance.

---

## 4. Alur Kerja Pengujian & Eksekusi (Testing Workflow)
- Karena Node.js dijalankan di dalam container Docker, semua pengujian unit test dan perintah terminal runtime wajib dieksekusi melalui Docker:
  ```bash
  docker exec bot-trading-next-bot-1 npm test
  ```
- Setiap modifikasi pada modul `config/strategy.js`, `services/indicators.js`, atau logika sizing wajib diverifikasi melalui unit test sebelum turn berakhir.
- Setelah perubahan kode di lingkungan Docker, jalankan `docker-compose restart bot` untuk menerapkan perubahan secara mulus.
