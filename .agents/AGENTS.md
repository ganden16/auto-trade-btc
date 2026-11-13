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
  Layanan notifikasi eksternal murni menggunakan Telegram Bot API (`services/notifier.js`). Semua pemanggilan REST Telegram wajib diisolasi dalam blok `try ... catch` dengan timeout 8 detik (`8000 ms`) agar kegagalan jaringan Telegram tidak pernah memblokir eksekusi trading Binance.
- **AI Gatekeeper (SumoPod):**
  Menggunakan endpoint `https://ai.sumopod.com/v1/chat/completions` dengan model GLM (`glm-5.3-flash`). Sentimen AI berfungsi sebagai filter veto makro pra-eksekusi (`minVetoConfidence: 7`) dan komponen skor konfluensi. Fitur emergency exit berbasis berita saat ini dinonaktifkan pada konfigurasi aktif (`emergencyHaltEnabled: false`, threshold `emergencyExitConf: 9`). Dilengkapi in-memory headline cache untuk menghemat kuota token AI.

---

## 3. Parameter Manajemen Risiko (Strategy Bounds)
- **Lingkungan Aktif Saat Ini:** **Mode DEMO (`BINANCE_TESTNET=true`)**. Jangan beralih ke akun REAL tanpa persetujuan eksplisit user dan pengaktifan penuh kill switch.
- **Pair & Timeframe:** `BTCUSDT`, 5 Menit (`5m`), Leverage **50x** (`strategy.trading.leverage`).
- **Risk Per Trade:** Maksimal **1.0%** dari Equity/Margin akun (`riskPerTradePct: 1.0`).
- **Stop Loss Floor:** **0.50%** (`floorSlPct: 0.50`, atau `2.0 * ATR` jika lebih besar).
- **Take Profit Target:** **1.00%** (Risk-to-Reward Ratio **1:2.0** via `rrRatio: 2.0`, terikat ke jarak SL).
- **Time-Based Stale Exit:** **30 menit** (`maxHoldMinutes: 30`, 6 candle 5m).
- **Margin Headroom Cap:** Posisi dibatasi maksimal **70%** dari `availableBalance` untuk mencegah margin call / likuidasi paksa.
- **Trailing Stop & Break-Even:** **Dinonaktifkan** (`trailingStop.enabled: false`, `breakEven.enabled: false`) agar posisi memiliki ruang penuh menuju target TP `1:2.0` tanpa terpotong noise mikro; modul tetap tersedia jika diaktifkan di masa depan (`activationAtrMultiplier: 1.5`).
- **Loss Cooldown & Kill Switch:** `lossCooldown` aktif (**20 menit** pasca Stop Loss di DEMO & REAL). `dailyLossLimitEnabled` (`5%`) dan `consecutiveLossPause` (`3` loss -> jeda `4` jam) dinonaktifkan sementara selama pengujian DEMO (`disableInDemo: true`), dan **wajib diaktifkan** sebelum beralih ke REAL.
- **Single Concurrent Position (Aturan 1 Posisi):** Maksimal hanya 1 posisi aktif dalam satu waktu (1 open position sampai close position). Tidak ada pyramiding, tidak ada averaging down / martingale, dan tidak ada hedging. Sinyal baru otomatis dilewati jika masih ada posisi aktif di database SQLite / Binance.

---

## 4. Alur Kerja Pengujian & Eksekusi (Testing Workflow)
- Bot produksi **tidak berjalan di mesin lokal**, melainkan di VPS (lihat Bagian 5). Seluruh pengujian unit test dan perintah terminal runtime dieksekusi melalui container Docker di VPS:
  ```bash
  ssh "$VPS_USER@$VPS_IP" 'docker exec -w /app bot-trading-bot-1 npm test'
  ```
- Setiap modifikasi pada modul `config/strategy.js`, `services/indicators.js`, atau logika sizing wajib diverifikasi melalui unit test. Unit test **hanya dijalankan atas permintaan eksplisit user** (sesuai aturan global); jika user belum meminta, tawarkan perintah di atas di akhir respons.
- Setelah perubahan kode, terapkan dengan sinkronisasi ke VPS (Bagian 5.3). Restart container dilakukan otomatis oleh skrip deploy.

---

## 5. Operasional VPS (Produksi) — WAJIB

### 5.1 Lingkungan VPS
- Bot trading berjalan 24/7 di VPS. Mesin lokal hanya dipakai untuk **mengedit kode sumber**; database, log, dan state runtime lokal **bukan** sumber kebenaran.
- Kredensial koneksi dibaca dari file `.env` lokal: `VPS_IP` dan `VPS_USER`. Autentikasi memakai SSH key `~/.ssh/id_ed25519` (tanpa password). Jangan menulis IP, password, atau token ke file yang ter-commit. Muat variabel sebelum perintah SSH:
  ```bash
  export $(grep -E '^VPS_(IP|USER)=' .env | xargs) && ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" 'hostname'
  ```
- Peta lokasi di VPS:

  | Item | Lokasi |
  |---|---|
  | Direktori proyek | `/home/ubuntu/bot-trading` |
  | Container bot / redis | `bot-trading-bot-1` / `bot-trading-redis-1` |
  | Database SQLite (host) | `/home/ubuntu/bot-trading/data/trading.db` |
  | Database SQLite (di container) | `/app/data/trading.db` |
  | Backup database | `/home/ubuntu/bot-trading/data/backups/`, `data/trading.db.backup-*` |

### 5.2 Semua Pengecekan Dilakukan di VPS
Setiap pengecekan **log, database, file, konfigurasi runtime, status container, maupun performa trading** wajib dilakukan langsung di VPS yang tersambung — bukan di lokal.
- **Status & resource:**
  ```bash
  ssh "$VPS_USER@$VPS_IP" 'cd /home/ubuntu/bot-trading && docker compose ps && docker stats --no-stream'
  ```
- **Log runtime (stdout container):**
  ```bash
  ssh "$VPS_USER@$VPS_IP" 'docker logs --since 6h bot-trading-bot-1 2>&1 | tail -300'
  ```
- **Database (strictly read-only):** VPS tidak memiliki CLI `sqlite3`; gunakan Node.js + `better-sqlite3` di dalam container dengan opsi `{ readonly: true, fileMustExist: true }`. Skrip analisis ditulis di lokal (folder scratch) lalu di-pipe lewat stdin:
  ```bash
  ssh "$VPS_USER@$VPS_IP" 'docker exec -i -w /app bot-trading-bot-1 node -' < script-analisis.js
  ```
  Tabel utama: `trade_history`, `active_positions`, `position_fills`, `system_logs`, `historical_candles`, `system_state`.
- **File:** bandingkan checksum lokal vs VPS (`md5sum`) sebelum menyimpulkan kode yang sedang berjalan.
- DILARANG keras melakukan operasi tulis/hapus pada database VPS, menghapus backup, mengubah `.env` VPS, atau menjalankan perintah destruktif lainnya tanpa konfirmasi eksplisit user. Seluruh larangan destruktif pada aturan global berlaku penuh di VPS.

### 5.3 Sinkronisasi Kode ke VPS Setiap Akhir Respons
- Setiap respons yang mengubah file yang di-deploy (`src/`, `config/`, `services/`, `public/`, `test/`, `Dockerfile`, `docker-compose.yml`, `package.json`, `.env.example`, `README.md`, `prompt.md`) **wajib diakhiri dengan sinkronisasi ke VPS**:
  ```bash
  npm run deploy:vps   # alias: bash scripts/deploy-vps.sh
  ```
  Skrip ini mengirim file via SSH (mengecualikan `.env`, `data/*.db*`, `node_modules`, `.git`), lalu menjalankan `docker compose up -d && docker compose restart bot` di VPS.
- Jika `package.json` (dependensi) atau `Dockerfile` berubah, image wajib di-rebuild di VPS setelah sinkronisasi:
  ```bash
  ssh "$VPS_USER@$VPS_IP" 'cd /home/ubuntu/bot-trading && docker compose up -d --build bot'
  ```
- **Verifikasi pasca-deploy (wajib):**
  1. Checksum file yang diubah identik antara lokal dan VPS.
  2. `docker compose ps` menunjukkan container `bot` berstatus `Up`.
  3. `docker logs --tail 60 bot-trading-bot-1` menunjukkan boot bersih (`Bootstrapped 500 candles`, `WebSocket connected`) tanpa error/stack trace baru.
- Sinkronisasi ke VPS **bukan** operasi git; aturan larangan `git add/commit/push` tetap berlaku.
- Jika sinkronisasi gagal (SSH/network), laporkan error secara eksplisit kepada user di akhir respons — jangan menganggap perubahan sudah aktif.
