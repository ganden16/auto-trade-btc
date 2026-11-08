# Bot Trading Algoritmik Hybrid

Sistem perdagangan otomatis derivatif berbasis Node.js yang menggabungkan analisis teknikal kuantitatif, penyaringan tren multilapis (*Sniper Filters*), dan filter makro berbasis kecerdasan buatan (*SumoPod AI / MiMo LLM*) pada kontrak Binance Futures.

[![Node.js](https://img.shields.io/badge/Node.js-20.x_LTS-green.svg)](https://nodejs.org/)
[![Binance Futures](https://img.shields.io/badge/Binance-Futures_Testnet-yellow.svg)](https://testnet.binancefuture.com/)
[![SumoPod AI](https://img.shields.io/badge/AI_Engine-SumoPod_MiMo-blue.svg)](https://sumopod.com/)
[![Database](https://img.shields.io/badge/Database-SQLite_WAL-orange.svg)](https://github.com/WiseLibs/better-sqlite3)
[![Cache](https://img.shields.io/badge/Cache-Redis_7-red.svg)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Deployment-Docker_Compose-blueviolet.svg)](https://www.docker.com/)

---

## Daftar Isi
1. [Gambaran Umum dan Prinsip Operasional](#1-gambaran-umum-dan-prinsip-operasional)
2. [Fitur Utama](#2-fitur-utama)
3. [Arsitektur Sistem dan Teknologi](#3-arsitektur-sistem-dan-teknologi)
4. [Alur Kerja dan Strategi Perdagangan](#4-alur-kerja-dan-strategi-perdagangan)
5. [Manajemen Risiko dan Simulasi Numerik](#5-manajemen-risiko-dan-simulasi-numerik)
6. [Layanan Eksternal Terkait](#6-layanan-eksternal-terkait)
7. [Prasyarat dan Persiapan Akun](#7-prasyarat-dan-persiapan-akun)
8. [Panduan Instalasi dan Pengoperasian](#8-panduan-instalasi-dan-pengoperasian)
9. [Dasbor Web dan Pemantauan](#9-dasbor-web-dan-pemantauan)
10. [Struktur Direktori Proyek](#10-struktur-direktori-proyek)
11. [Pengujian Unit Test](#11-pengujian-unit-test)
12. [Panduan Keamanan dan Praktik Operasional](#12-panduan-keamanan-dan-praktik-operasional)
13. [Riwayat Evolusi Strategi & Parameter Historis](#13-riwayat-evolusi-strategi--parameter-historis)

---

## 1. Gambaran Umum dan Prinsip Operasional

Sistem ini dirancang khusus untuk memperdagangkan kontrak derivatif **BTCUSDT** pada timeframe 5 menit (**5m**) dengan leverage **50x** di Binance Futures menggunakan mesin **Key Level Sniper & Macro Confluence Engine (Generasi V5 - Aktif)**. 

Sistem mengintegrasikan tiga pilar utama:
1. **Level Kunci Struktural & Validasi Sumbu Penolakan (15M S/R & Rejection Wick):** Pemicu utama transaksi berpatokan pada uji zona level Support dan Resistance 15 menit (berdasarkan rentang 24 lilin / 6 jam terakhir dengan toleransi $\pm 0,35\%$). Entri hanya dieksekusi jika terbentuk sumbu penolakan harga (*rejection wick* $\ge 25\%$ rentang lilin) atau lilin pembalikan arah, serta melarang keras transaksi di zona tengah (*mid-range chop*).
2. **Realitas Mikrostruktur & Dual-Stream WebSocket:** Memvalidasi aliran transaksi agresif (*Taker Buy/Sell Volume Ratio*), kedalaman buku pesanan (*Order Book Imbalance Top 20*), dan Cumulative Volume Delta (CVD) sub-detik. Dilengkapi pipeline WebSocket ganda: stream kline 5m dari akun aktif dan stream instrumen mikrostruktur langsung dari **Binance Mainnet** (`@forceOrder` likuidasi paksa & `@aggTrade` transaksi agregat) guna menjamin keaslian data likuiditas pasar baik pada mode DEMO maupun REAL.
3. **Penyaringan Berita & Konfluensi Makro AI (SumoPod MiMo LLM):** Model kecerdasan buatan SumoPod (`mimo-v2.6-flash`) mengevaluasi berita kripto global berdampak tinggi. AI bertindak sebagai filter konfluensi arah (LONG wajib Bullish/Netral, SHORT wajib Bearish/Netral) serta pemicu penutupan darurat (*emergency exit*) jika terdeteksi peristiwa katastropik nyata (*Black Swan*).

### Prinsip Perlindungan Modal
Prinsip utama bot ini adalah memprioritaskan keamanan modal dibandingkan mengejar frekuensi transaksi. Apabila harga berada di luar level kunci (area netral), likuiditas volume rendah, terjadi badai likuidasi beruntun (*falling knife*), atau terjadi pertentangan antara sinyal teknikal dengan sentimen makro AI, sistem akan memilih untuk **tidak masuk ke pasar (*no-trade state*)**.

### Kebijakan Satu Posisi Aktif (*Single Concurrent Position*)
Bot menerapkan aturan disiplin posisi tunggal:
* Hanya boleh ada **maksimal satu posisi terbuka** dalam satu waktu (dari pembukaan hingga penutupan tuntas).
* Selama posisi aktif berjalan, seluruh sinyal baru akan diabaikan secara otomatis.
* Tidak menerapkan strategi penambahan posisi bertingkat (*pyramiding*), perataan harga saat merugi (*averaging down*), maupun *martingale*. Pada leverage 50x, pendekatan tersebut membawa risiko likuidasi yang tidak dapat ditoleransi.
* Setiap siklus transaksi bersifat diskret dan tuntas: Sinyal &rarr; Eksekusi &rarr; Pengawalan Risiko (SL/TP) &rarr; Penutupan (TP/SL/Time Exit) &rarr; Pencatatan Realized PnL Bersih &rarr; Jeda Cooldown &rarr; Pencarian Sinyal Baru.

---

## 2. Fitur Utama

* **Mesin Key Level Sniper Multi-Timeframe (Generasi V5 - Aktif):** Mengidentifikasi area pantulan probabilitas tinggi pada Support dan Resisten 15 menit, memvalidasi sumbu penolakan harga $\ge 25\%$, dan memblokir 100% scalping impulsif di area tengah tanpa keunggulan lokasi struktural.
* **Mode Sniper Mikrostruktur Real-Time:** Memverifikasi ketidakseimbangan aliran pesanan taker, kedalaman buku pesanan (OBI $\ge 35\%$ sisi dominan), pergeseran delta Open Interest (OI), dan pemantauan badai likuidasi paksa untuk mencegah entri pisau jatuh (*falling knife*).
* **Konfluensi Makro AI Terarah (SumoPod MiMo):** Evaluasi berita finansial global berbobot makro secara real-time. Menolak entri jika berita berlawanan arah dengan tingkat keyakinan $\ge 7/10$, serta mendekopel penutupan darurat murni hanya untuk peristiwa *Black Swan* berkeyakinan $\ge 9/10$.
* **Batas Waktu Otomatis Posisi Tertahan (*Time-Based Stale Exit 60 Menit*):** Menutup otomatis posisi yang tertahan lebih dari 60 menit tanpa menyentuh TP maupun SL, mencegah pembusukan momentum (*alpha decay*) dan akumulasi potongan biaya *funding rate* 8 jam pada posisi yang bergerak lambat.
* **Stop Loss dan Take Profit Presisi Terkalibrasi (RR 1:2.0 Gross, RR 1:1.00 Net):** Batas Stop Loss diatur 0,20% dari harga masuk (~$152 pada BTC ~$76.000) dengan target Take Profit 0,40% (~$304 pada BTC). Menghasilkan rasio Risk-to-Reward bersih **1 : 1,00** setelah potongan biaya taker bolak-balik 0,10% Binance Futures, dengan tingkat kemenangan impas (*break-even win rate*) realistis sebesar **50,0%** (atau **47,6%** dengan TP Maker).
* **Ukuran Posisi Dinamis & Batas Aman Margin:** Menghitung ukuran lot berbasis risiko maksimal 1,0% dari saldo ekuitas terhadap jarak Stop Loss nyata. Pada leverage 50x, modal jaminan yang dikunci hanya ~10% dari modal, menyisakan 90% saldo bebas di dompet (jauh di bawah batas plafon margin 70%). Dilengkapi pengaman akun mikro (*Micro-Account Guard*) yang mengunci ke batas minimal 0,001 BTC.
* **Bypass Pemblokiran DNS & Failover Node Edge AWS CloudFront:** Modul DoH internal (`services/dns-resolver.js`) menyelesaikan domain Binance via Cloudflare dan Google DoH, memintas sensor ISP lokal (Trust Positif/IndiHome/Biznet), serta mendeteksi dan mengisolasi otomatis IP edge CloudFront yang terkena ban limit (`-1003`) pasca-insiden bursa.
* **Pipeline WebSocket Ganda (Dual-Stream Pipeline):** Menghubungkan kline 5m dari lingkungan aktif (Testnet/Live) dan menghubungkan stream mikrostruktur likuidasi (`@forceOrder`) serta agregat trade (`@aggTrade`) langsung ke Binance Mainnet agar data likuidasi tidak palsu atau kosong saat diuji di Testnet.
* **Rekonsiliasi Posisi Tersinkronisasi Cerdas:** Menangani kuantitas bertanda negatif dari API Binance Futures untuk posisi SHORT (`pos.positionAmt < 0`) yang disinkronkan secara konsisten dengan database SQLite setiap 15 detik, mencegah alarm palsu *Position Mismatch* serta mencegah penempatan order Stop Loss / Take Profit ganda di bursa.
* **Konsistensi Data SQLite WAL:** Database relasional lokal sinkron menggunakan driver `better-sqlite3` dalam mode Write-Ahead Logging (WAL) dengan batasan referensial `ON DELETE CASCADE`. Seluruh transaksi penutupan posisi dan audit riwayat dijalankan secara atomik.
* **Cache Cepat Redis:** Menyimpan snapshot harga dan posisi untuk akses latensi rendah. Jika Redis dimulai ulang, state akan direkonstruksi secara otomatis dari SQLite.
* **Notifikasi Telegram Real-Time:** Mengirimkan ringkasan eksekusi order, pembaruan posisi, realisasi PnL bersih saat posisi ditutup, serta pemberitahuan darurat ke Telegram dengan format rapi dan non-blocking.
* **Arsitektur Tunggal Ringan:** Mesin trading dan server dasbor Express berjalan dalam satu proses Node.js di dalam kontainer Docker, mengonsumsi memori relatif hemat (~80MB RAM) dengan komunikasi data zero-latency via Server-Sent Events (SSE).
* **Terminal Dasbor Pro Cyber-Glassmorphic:** Dilengkapi HUD ikhtisar ringkas, pelacak posisi aktif interaktif, bilah status radar pemindai, matriks 12 kartu gatekeeper simetris 6x2, konsol log multikategori, dan isolasi data mutlak antara lingkungan DEMO dan REAL.

---

## 3. Arsitektur Sistem dan Teknologi

```
 ┌──────────────────────────────────────────────────────────────┐
 │                      DOCKER CONTAINER                        │
 │                                                              │
 │   ┌──────────────────────┐        ┌──────────────────────┐   │
 │   │     TRADING CORE     │        │   DASHBOARD SERVER   │   │
 │   │ (Eksekusi, AI, Risk) │◄──────►│ (Express, SSE, REST) │   │
 │   └──────────┬───────────┘        └──────────┬───────────┘   │
 │              │ Memori Terbagi                │ Port 28080    │
 │              ▼                               ▼               │
 │   ┌──────────────────────┐        ┌──────────────────────┐   │
 │   │  Database SQLite WAL │        │   Antarmuka Web      │   │
 │   └──────────┬───────────┘        └──────────────────────┘   │
 │              │ Sinkronisasi Awal                             │
 │              ▼                                               │
 │   ┌──────────────────────┐                                   │
 │   │     REDIS CACHE      │                                   │
 │   └──────────────────────┘                                   │
 └──────────────┬───────────────────────────────┬───────────────┘
                │ Permintaan HTTPS / WSS        │ Notifikasi Outgoing
                ▼                               ▼
    ┌───────────────────────┐       ┌───────────────────────┐
    │ Binance Futures & WSS │       │  Telegram Bot API     │
    │ SumoPod AI Engine     │       │                       │
    └───────────────────────┘       └───────────────────────┘
```

### Komponen Perangkat Lunak
* **Runtime:** Node.js 20 LTS berbasis image Alpine Linux dengan pengelola proses `tini`.
* **Database & Cache:** `better-sqlite3` (driver relasional sinkron) dan `ioredis` (klien cache Redis 7).
* **Komputasi Finansial:** `bignumber.js` untuk aritmatika desimal presisi tinggi tanpa floating-point rounding issue.
* **Komunikasi Jaringan:** `axios` (HTTP client ber-interceptor HMAC SHA-256), `ws` (WebSocket client untuk kline feed), dan `rss-parser` (pengambil feed berita multi-kanal).
* **Antarmuka Pengguna:** Express.js yang melayani aset statis dan streaming data Server-Sent Events (SSE) pada port 28080.

---

## 4. Alur Kerja dan Strategi Perdagangan

### A. Sinkronisasi Saat Inisialisasi
1. **Sinkronisasi Waktu:** Bot mengambil stempel waktu server Binance melalui endpoint `GET /fapi/v1/time`, menghitung selisih waktu sistem lokal, dan mengompensasi seluruh permintaan REST berikutnya.
2. **Penyetelan Leverage:** Memastikan konfigurasi leverage kontrak BTCUSDT terpasang pada nilai 50x di bursa.
3. **Rekonsiliasi Status & Jaminan Notifikasi:** Membandingkan status posisi antara database SQLite lokal dengan Binance REST API setiap 15 detik. Jika posisi telah tertutup di bursa (misalnya terpicu saat bot offline), bot memperbarui database, membersihkan resting order, dan mengirim notifikasi `sendTradeClose`. Sebaliknya, jika terdeteksi posisi baru di bursa yang belum tercatat secara lokal (misalnya akibat latensi penyelesaian pencocokan order IOC), bot segera menyinkronkan posisi ke SQLite, memasang algo SL & limit TP di bursa, serta mengirim notifikasi `sendTradeOpen` ke Telegram sehingga tidak ada transaksi yang terlewat.
4. **Pemuatan Data Historis:** Mengunduh 500 candlestick 5m terakhir untuk menginisialisasi indikator teknikal.

### B. Pemantauan Candlestick & Aliran Harga Real-Time (WebSocket Feed)
1. Bot membuka koneksi WebSocket ke stream kline Binance Futures: `btcusdt@kline_5m` (disertai DNS-over-HTTPS resolver otomatis untuk melewati blokir DNS lokal).
2. **Arsitektur Ketahanan Socket:**
   * **Heartbeat & Pong Listener:** Mengirimkan frame `ping` setiap 10 detik dan memverifikasi balasan `pong` agar koneksi tidak mengalami stall di level router/NAT.
   * **Inactivity Watchdog:** Memantau jeda pesan. Jika tidak ada data kline yang diterima selama lebih dari 15 detik pada stream aktif, bot seketika menterminasi zombie socket dan melakukan rekoneksi ulang secara bersih.
   * **REST Fallback Watchdog:** Jika terjadi jeda transien atau saat WebSocket sedang rekoneksi, bot secara otomatis memanggil endpoint REST `/fapi/v1/ticker/price` setiap 5 detik agar harga pasar tidak pernah beku atau tertinggal.
3. **Penyaluran Sub-Detik:** Setiap pergerakan harga (`k.c`) disalurkan secara instan (sub-detik) ke antarmuka dasbor melalui event SSE `PRICE_TICK`.
4. Evaluasi strategi sinyal baru **hanya dieksekusi saat candlestick 5 menit resmi ditutup** (`k.x === true`).
5. Selama candlestick berjalan, setiap tick harga digunakan untuk menghitung unrealized PnL secara live dan mengevaluasi ambang batas Trailing Stop.

### C. Strategi Sinyal dan Gatekeeper Filter Realitas Pasar
Keputusan eksekusi trading bot digerakkan oleh **V5/V6 Key Level Sniper & Real-Time Microstructure Engine** yang menggabungkan level kunci Support & Resistance multi-timeframe dengan data mikrostruktur pesanan nyata:

1. **Uji Level Kunci S/R Multi-Timeframe (15m Swing Bounds):**
   * **Level Support & Resisten Dinamis:** Menghitung titik terendah (*Swing Low*) dan tertinggi (*Swing High*) dari 24 lilin 15 menit terakhir (rentang 6 jam).
   * **Kandidat LONG:** Harga menyentuh zona Support ($\pm 0,35\%$) DAN terkonfirmasi pantulan (*wick rejection* $\ge 25\%$ dari rentang candle atau candle hijau pembalikan).
   * **Kandidat SHORT:** Harga menyentuh zona Resisten ($\pm 0,35\%$) DAN terkonfirmasi penolakan (*upper wick rejection* $\ge 25\%$ atau candle merah pembalikan).
   * **Eliminasi Mid-Range Chop:** Transaksi dilarang keras ketika harga mengambang di area netral tengah antara Support dan Resisten.
2. **Filter Mikrostruktur 1 - Penjaga Kaskade Likuidasi (*Liquidation Cascade & Exhaustion Guard* via `@forceOrder` WebSocket):**
   * Mendengarkan siaran likuidasi paksa real-time Binance Futures.
   * **Anti-Falling Knife:** Posisi LONG ditolak jika terdeteksi badai likuidasi Long aktif melampaui ambang batas $\ge \$150.000$ USD dalam 60 detik terakhir. Posisi SHORT ditolak jika likuidasi Short $\ge \$150.000$ USD dalam 60 detik.
   * **Konfirmasi Pembalikan Arah (*Exhaustion Reversal*):** Jika terjadi lonjakan likuidasi besar $\ge \$250.000$ USD dalam 5 menit namun mereda $(< \$30.000$ USD dalam 60 detik) tepat di level Support/Resisten, sistem memvalidasi titik tersebut sebagai area pembalikan arah dengan probabilitas tinggi.
3. **Filter Mikrostruktur 2 - Ketimpangan Buku Pesanan (*Order Book Imbalance Top 20 Depth*):**
   * Mengukur rasio volume Bid terhadap total volume Bid dan Ask pada 20 kedalaman terbaik:
     $$OBI = \frac{\sum Q_{\text{bids}}}{\sum Q_{\text{bids}} + \sum Q_{\text{asks}}}$$
   * Posisi LONG mewajibkan $OBI \ge 0,35$ (minimal 35% Bid) dan posisi SHORT mewajibkan $OBI \le 0,65$ (minimal 35% Ask) dengan penghalusan anti-spoofing agar fluktuasi pesanan pasif sesaat tidak membatalkan eksekusi sah.
4. **Filter Mikrostruktur 3 - Delta Open Interest Real-time ($\Delta OI$ & Klasifikasi Rezim Institusional):**
   * Mengukur perubahan persentase Open Interest secara bergulir dalam interval 5 menit.
   * Mengklasifikasikan dinamika pasar menjadi 5 rezim:
     * `BULLISH_EXPANSION` ($\Delta P > 0, \Delta OI \ge +0,15\%$): Pembeli baru masuk agresif.
     * `SHORT_SQUEEZE` ($\Delta P > 0, \Delta OI \le -0,15\%$): Pompa harga akibat penutupan paksa posisi short.
     * `BEARISH_EXPANSION` ($\Delta P < 0, \Delta OI \ge +0,15\%$): Penjual baru masuk agresif.
     * `LONG_LIQUIDATION` ($\Delta P < 0, \Delta OI \le -0,15\%$): Penurunan tajam akibat kapitulasi likuidasi long.
     * `NEUTRAL_CONSOLIDATION`: Pergerakan harga tanpa pergeseran posisi kontrak yang signifikan.
5. **Filter Mikrostruktur 4 - Cumulative Volume Delta Sub-Detik (*Real-time CVD* via `@aggTrade`):**
   * Mendengarkan setiap transaksi pasar agresif via WebSocket `@aggTrade`.
   * Menghitung akumulasi volume beli versus jual per detik, memprioritaskan rasio order flow 5 menit terkini dibanding data taker REST yang mengalami latensi 30 detik.
6. **Filter Sniper 1 - Rezim Pasar & Kekuatan Tren ADX:**
   * Pada mode tren: mewajibkan $ADX \ge 22$.
   * Pada mode `KEY_LEVEL_SNIPER`: Nilai ADX rendah mencerminkan konsolidasi rentang S/R yang sehat. Filter menerapkan batas atas anti-blowout $ADX \le 38$ (`maxRangeThreshold: 38`) guna mencegah masuk ke pisau jatuh saat terjadi *breakdown/breakout* runaway liar.
7. **Filter Sniper 2 - Penjaga Kelelahan RSI (*RSI Exhaustion Guard* [35 - 65]):**
   * Mencegah aksi beli di pucuk (*overbought* RSI > 65) dan jual di dasar lembah (*oversold* RSI < 35).
8. **Filter Sniper 3 - Konfluensi Makro Multi-Timeframe 15m:**
   * Pada mode `KEY_LEVEL_SNIPER`, pengujian level Support atau Resisten 15m berfungsi sebagai konfluensi makro utama. Entri pembalikan arah (*mean-reversion bounce*) di Support diizinkan meski tren EMA 15m berstatus *Bearish*, asalkan terkonfirmasi penolakan sumbu (*rejection wick*) atau pembalikan lilin, mengeliminasi paradoks melingkar di mana harga di Support selalu berada di bawah EMA 15m. Pada mode tren terarah murni, keselarasan EMA tetap diwajibkan.
9. **Filter Gatekeeper 1 - Partisipasi Volume Likuiditas (Volume &ge; 0,70 * SMA 20 Volume):**
   * Memastikan volume penutupan lilin minimal 70% dari rata-rata volume 20 periode.
10. **Filter Gatekeeper 2 - Penjajaran Posisi Whale / Akun Trader Teratas (Top Trader L/S Ratio [0,85 - 1,80 / Key Level SHORT &le; 2,25]):**
   * Batas standar 0,85 - 1,80, dengan ambang batas atas posisi SHORT di level resisten dinaikkan menjadi 2,25 (`keyLevelMaxShortThreshold: 2.25`) guna mengakomodasi *structural long bias* bawaan dari akun institusional pada Binance Futures BTCUSDT.
11. **Filter Gatekeeper 3 - Penyelarasan Aliran Pesanan Taker (*Taker Buy/Sell Order Flow Ratio*):**
   * Pada mode Key Level, penyerapan pesanan limit di Support/Resisten mewajibkan rasio taker beli $\ge 0,85$ untuk LONG dan $\le 1,15$ untuk SHORT (`keyLevelMinLong: 0.85`, `keyLevelMaxShort: 1.15`), mencegah pembeli mengejar lilin yang sudah terlanjur melambung tinggi. Pada mode Reality murni: ambang batas momentum agresif [1,35 - 0,65].
12. **Filter Gatekeeper 4 - Veto Sentimen SumoPod AI & Radar Whale On-Chain (Freshness Guard 45 Menit):**
   * Menolak entry jika sentimen berita berlawanan arah dengan keyakinan $\ge 7/10$.
13. **Filter Gatekeeper 5 - Saringan Tingkat Pendanaan (*Funding Rate Guard* &le; $\pm 0,04\%$):**
   * Mencegah beban biaya fee pendanaan berlebih.
14. **Filter Gatekeeper 6 - Aturan Posisi Tunggal & Jeda Pasca-Loss (*Single Concurrent Position & 20m Cooldown*):**
   * Maksimal 1 posisi aktif berjalan dan jeda anti-revenge trading selama 20 menit pasca Stop Loss.

### D. Eksekusi Order di Bursa
Jika seluruh filter terpenuhi:
1. **Entry Order:** Dikirimkan sebagai order Aggressive Limit IOC (*Immediate-Or-Cancel*) pada harga pasar terbaik dengan batas toleransi slippage yang diperketat menjadi **0,05%** ($\approx \$38 - \$40$ di BTC) demi menjamin keterisian instan tanpa risiko *bad fill*.
2. **Stop Loss Pasif di Bursa:** Begitu order entry terisi (*FILLED*), bot segera mendaftarkan pesanan algo `STOP_MARKET` (`reduceOnly: true`) langsung di Binance.
3. **Take Profit Pasif di Bursa (Prioritas Maker Order):** Dipasang sebagai order Limit `reduceOnly: true` (GTC) di Binance. Saat harga menyentuh target TP, sistem memberikan jeda toleransi 800ms agar order pasif bursa terisi sebagai **Maker Order (Fee 0,020%)**, memangkas biaya komisi hingga 60% dibanding Taker.
4. **Notifikasi:** Rincian posisi dikirimkan seketika melalui bot Telegram.

### E. Manajemen Posisi Aktif dan Trailing Stop
* **Penonaktifan Trailing Stop & Break-Even Dini (Profit Preservation):** Pada konfigurasi aktif V5, fitur `trailingStop.enabled` dan `breakEven.enabled` dinonaktifkan (`false`) demi mencegah tercekiknya posisi yang sedang unggul oleh goyangan sumbu mikro (*micro-wick noise*), sehingga posisi memiliki ruang napas penuh untuk mencapai target Take Profit 0,40% (Gross RR 1:2.0). Namun, modul kode tetap siap pakai (*ready-to-use*): jika diaktifkan, ambang pemicu break-even terkalibrasi pada keuntungan $+0,25\%$ dengan buffer komisi $+0,05\%$.
* **Dynamic Trailing Stop Berjenjang (Opsional):** Jika diaktifkan, trailing stop aktif otomatis saat keuntungan berjalan melampaui `1.5 * ATR` dengan ambang pergeseran minimal $\ge 0,25 \times \text{ATR}$ guna mencegah banjir pembaruan mikro-tick.
* **Pencegahan Error Dual-Trigger:** Jika order pelindung di bursa tereksekusi mendahului perintah penutupan lokal, respons penolakan order `ReduceOnly` dikenali sebagai penutupan sah. Sistem langsung membersihkan data posisi lokal tanpa menimbulkan siklus error.
* **AI Emergency Exit (Dekopel Murni Black Swan & Keyakinan $\ge 9/10$):** Penutupan darurat posisi aktif didekopel dari sentimen berita editorial biasa. *Emergency Exit* hanya aktif jika terdeteksi peristiwa katastropik nyata (*Black Swan*: peretasan bursa `HACK`/`EXPLOIT`, penghentian jaringan/layanan `OUTAGE`/`HALT`, kebangkrutan `BANKRUPT`, penindakan hukum mendadak `ARREST`/`CRACKDOWN`, atau *depeg* stablecoin) dengan tingkat keyakinan $\ge 9/10$. Pergerakan harga harian normal dipercayakan sepenuhnya kepada Stop Loss ketat (0,20%) untuk melindungi ekspektansi rasio *Risk-Reward*.
* **Time-Based Stale Exit (`maxHoldMinutes: 60`):** Menutup otomatis posisi yang tertahan lebih dari 60 menit (setara 12 candle 5m) tanpa menyentuh TP maupun SL. Pada scalping 5 menit, tesis momentum pantulan harga seharusnya terwujud dalam 15-30 menit. Jika posisi terjebak stagnan, momentum telah kadaluwarsa (*alpha decay*), memicu risiko potongan biaya funding rate bursa, serta menyandera modal (*opportunity cost*) akibat aturan 1 posisi aktif. Penutupan berbasis waktu ini segera membebaskan margin dan kas untuk sinyal baru tanpa memicu jeda penalti post-loss 20 menit.
* **Interval Rekonsiliasi Posisi (15 Detik) & Pemantauan Harga Live (5 Detik):** Bot melakukan rekonsiliasi posisi aktif terhadap Binance REST API setiap 15 detik (`strategy.api.reconciliationIntervalMs: 15000`) dengan jeda backoff adaptif untuk mencegah penalti rate limit. Secara terpisah, watchdog harga (`ensureLivePrice`) memantau harga setiap 5 detik agar telemetri dasbor tidak pernah beku.

---

## 5. Manajemen Risiko dan Simulasi Numerik

Penentuan ukuran posisi (*position sizing*) dihitung berbasis risiko per transaksi terhadap Stop Loss, bukan sekadar persentase margin acak.

### Rumus Perhitungan Ukuran Posisi
$$\text{Risk Amount (USDT)} = \text{Available Margin} \times 1.0\%$$
$$\text{Stop Loss Distance} = \max\left(\text{Price} \times 0.20\%, \text{ATR} \times 1.0\right)$$
$$\text{Quantity (BTC)} = \frac{\text{Risk Amount}}{\text{Stop Loss Distance}}$$
$$\text{Batas Maksimal Margin} = \text{Available Margin} \times 70\%$$
$$\text{Margin Terpakai} = \frac{\text{Quantity} \times \text{Price}}{\text{Leverage (50x)}}$$

*(Apabila kalkulasi Margin Terpakai melampaui 70% dari margin bebas yang tersedia, ukuran lot otomatis dipangkas demi menjaga ketahanan akun terhadap margin call. Sebaliknya, pada akun bermodal mikro seperti $20 - $50 USDT di mana hasil pembulatan ukuran posisi berada di bawah batas minimum bursa, sistem secara adaptif menetapkan ukuran lot minimal Binance yakni 0,001 BTC selama margin yang dibutuhkan tetap berada jauh di bawah batas aman 70%).*

---

### Simulasi Numerik Riil (Contoh Akun Modal $1.000 USDT)

| Parameter | Nilai Simulasi | Penjelasan |
| :--- | :--- | :--- |
| **Modal Bebas (Available Margin)** | **$1.000,00 USDT** | Saldo margin bebas di akun Futures |
| **Batas Risiko per Transaksi (1.0%)** | **$10,00 USDT** | Kerugian maksimal saat mengenai Stop Loss |
| **Harga Masuk BTC (Entry Price)** | **$80.000,00** | Harga rata-rata eksekusi order |
| **Leverage Akun** | **50x** | Pengali daya beli kontrak (Scalper Engine) |
| **Jarak Stop Loss (Floor 0.20%)** | **-$160,00** | Level Stop Loss = **$79.840,00** |
| **Jarak Take Profit (0.40% / 1:2.0 Gross RR)** | **+$320,00** | Level Take Profit = **$80.320,00** |

#### 1. Perhitungan Besaran Kontrak (Position Sizing)
* **Ukuran Lot (Quantity):** $\frac{\$10,00}{\$160,00} = \mathbf{0.062\text{ BTC}}$ (dibulatkan ke 3 desimal bursa)
* **Nilai Total Kontrak (Notional Value):** $0.062 \times \$80.000 = \mathbf{\$4.960,00\text{ USDT}}$
* **Margin Nyata yang Dikunci Binance (Leverage 50x):** $\frac{\$4.960,00}{50} = \mathbf{\$99,20\text{ USDT}}$
  > *Catatan:* Dari saldo $1.000 USDT, jaminan margin yang dikunci hanya sebesar **$99,20 USDT (~9,92% dari total modal)**. Sisa saldo $900,80 USDT (90,08%) tetap bebas di dompet sebagai penyangga aman dari risiko likuidasi paksa (jauh di bawah batas plafon margin 70% = $700 USDT).

#### 2. Estimasi Biaya Transaksi (Binance Taker/Maker Fee)
* **Biaya Pembukaan Posisi (Entry Taker 0.05%):** $\$4.960 \times 0,05\% = \mathbf{\$2,48\text{ USDT}}$
* **Biaya Penutupan Posisi (Exit Taker 0.05% / Maker 0.02%):** $\$4.980 \times 0,05\% \approx \mathbf{\$2,49\text{ USDT}}$ (atau hanya $\$0,99$ jika terisi Maker)
* **Total Biaya Transaksi Bolak-Balik (Round-Trip):** $\approx \mathbf{\$3,47 - \$4,97\text{ USDT}}$ (~0,07% - 0,10% dari notional)

#### 3. Hasil Skenario A: Mengenai Take Profit (+0.40% di $80.320)
* **Keuntungan Kotor (Gross Profit):** $0.062 \text{ BTC} \times \$320 = \mathbf{+\$19,84\text{ USDT}}$
* **Potongan Biaya Transaksi:** $-\$4,97\text{ USDT}$ (Taker) atau $-\$3,47\text{ USDT}$ (Maker)
* **Laba Bersih Transaksi:** $\mathbf{+\$14,87\text{ USDT}}$ (Taker) hingga $\mathbf{+\$16,37\text{ USDT}}$ (Maker)
* **Tingkat Pengembalian Margin (ROI pada margin ~$100):** $+15,00\%$ (+1,49% dari total ekuitas akun)

#### 4. Hasil Skenario B: Mengenai Stop Loss (-0.20% di $79.840)
* **Kerugian Kotor (Gross Loss):** $0.062 \text{ BTC} \times (-\$160) = \mathbf{-\$9,92\text{ USDT}}$
* **Potongan Biaya Transaksi:** $-\$4,97\text{ USDT}$
* **Total Kerugian Bersih:** $\mathbf{-\$14,89\text{ USDT}}$
* **Sisa Saldo Akun:** **$985,11 USDT** (modal pokok tetap aman 98,51%).

#### 5. Ekspektasi Rasio Risiko terhadap Keuntungan Bersih (Net RR)
$$\text{Net RR} = \frac{\text{Net Profit}}{\text{Net Loss}} = \frac{\$14,87}{\$14,89} \approx \mathbf{1 : 1.00\text{ Net RR}}$$
Setelah memperhitungkan seluruh potongan biaya transaksi secara riil, model target terkalibrasi ini menghasilkan **Net Risk-to-Reward 1:1,00 (Taker)** (atau **1:1,10** jika order Take Profit terisi sebagai Maker). Tingkat kemenangan minimal (*break-even win rate*) yang dibutuhkan turun drastis menjadi **50,0%** (atau **47,6%** dengan TP Maker). Selain itu, posisi dibatasi batas waktu maksimal 60 menit (`maxHoldMinutes: 60`) untuk memangkas posisi stagnan (*alpha decay*) dan menghindari beban recurring funding fee bursa.

#### 6. Sistem Pembatas Kerugian Otomatis (Circuit Breaker)
* **Batas Kerugian Harian (Daily Loss Limit 5%):** Dihitung secara proporsional sebesar 5% dari saldo margin riil akun. Apabila total kerugian terealisasi pada hari berjalan (sejak 00:00 UTC) mencapai batas ini, sistem akan mengunci eksekusi perdagangan hingga pergantian hari UTC. Fitur ini dapat dinonaktifkan sementara untuk pengujian leluasa di akun demo via `strategy.risk.dailyLossLimitEnabled: false` atau `strategy.risk.disableInDemo: true`.
* **Jeda Kerugian Berurutan (Consecutive Loss Pause):** Jika bot mengalami 3 kali kerugian berturut-turut, sistem akan memasuki fase jeda selama 4 jam untuk menghindari transaksi berlebih pada kondisi pasar yang tidak menguntungkan. Fitur ini dapat dinonaktifkan sementara via `strategy.risk.consecutiveLossPause.enabled: false` atau `strategy.risk.disableInDemo: true`.
* **Pemisahan dan Isolasi Mutlak Data Demo dan Real pada Tingkat Basis Data:**
  * **Skema SQLite Composite Key:** Tabel `active_positions` menggunakan composite primary key `PRIMARY KEY (symbol, mode)`. Struktur ini memungkinkan posisi aktif akun DEMO dan REAL tersimpan berdampingan secara aman tanpa risiko saling menimpa, menghapus, atau mengalami tabrakan data saat pengguna beralih mode.
  * **Partisi Transaksi & Audit Log:** Tabel `position_fills`, `trade_history`, dan `system_logs` dilengkapi kolom `mode TEXT NOT NULL DEFAULT 'DEMO'` serta indeks komposit (`idx_active_positions_mode`, `idx_position_fills_mode_time`, `idx_trade_history_mode_time`, `idx_system_logs_mode_time`) untuk memastikan kueri riwayat dan pembatas kerugian terpartisi secara cepat dan tepat.
  * **Partisi Cache Redis:** Kunci cache ephemeral Redis diisolasi berdasarkan mode lingkungan (`pos:BTCUSDT:DEMO` dan `pos:BTCUSDT:REAL`).
  * **Independensi Evaluasi Risiko:** Seluruh riwayat transaksi, kalkulasi kerugian harian, evaluasi jeda kekalahan beruntun, dan eksposur margin dihitung secara terisolasi murni berdasarkan mode lingkungan yang sedang aktif, sehingga pengujian akun demo tidak akan pernah mengunci atau mempengaruhi akun riil.

---

## 6. Layanan Eksternal Terkait

1. **Binance Futures Testnet:**
   * Lingkungan pengujian resmi Binance Futures USDT-M.
   * Tautan: [https://testnet.binancefuture.com](https://testnet.binancefuture.com)
2. **Platform SumoPod AI:**
   * Penyedia endpoint API LLM kompatibel OpenAI untuk evaluasi sentimen berita finansial via model MiMo (mimo-v2.6-flash).
   * Tautan: [https://sumopod.com](https://sumopod.com)
3. **Telegram Bot API:**
   * Kanal pengiriman notifikasi instan untuk laporan transaksi dan peringatan sistem.
4. **Feed Berita Kripto:**
   * Pengambilan berkala feed RSS dari CoinDesk, Decrypt, Cointelegraph, dan pengumuman resmi Binance.

---

## 7. Prasyarat dan Persiapan Akun

Sebelum menjalankan bot, siapkan kredensial dari masing-masing platform berikut:

### 1. Kunci API Binance Futures Testnet
1. Akses [https://testnet.binancefuture.com](https://testnet.binancefuture.com) dan masuk menggunakan akun Anda.
2. Pada bagian bawah halaman dasbor, temukan bagian **API Key**.
3. Buat kunci baru, lalu simpan nilai **API Key** dan **Secret Key**.
4. Gunakan fitur *Faucet* di pojok kanan atas untuk menambahkan saldo modal pengujian (misalnya 1.000 - 10.000 USDT).

### 2. Kunci API SumoPod AI
1. Akses dasbor SumoPod di [https://sumopod.com](https://sumopod.com).
2. Dapatkan API Key Anda (berformat `sk-...`).
3. Endpoint yang digunakan adalah `https://ai.sumopod.com/v1/chat/completions` dengan model `mimo-v2.6-flash`.

### 3. Kredensial Notifikasi Telegram
1. **Membuat Bot Telegram:**
   * Buka aplikasi Telegram dan cari bot resmi `@BotFather`.
   * Jalankan perintah `/newbot` dan ikuti instruksi penamaan bot.
   * Salin token API yang diberikan (misalnya `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`) sebagai nilai `TELEGRAM_BOT_TOKEN`.
2. **Mendapatkan Chat ID Pengguna:**
   * Buka bot `@userinfobot` atau `@getmyid_bot` di Telegram.
   * Tekan tombol **Start** untuk melihat ID angka akun Anda (misalnya `123456789`). Simpan sebagai nilai `TELEGRAM_CHAT_ID`.
3. **Inisialisasi Obrolan:**
   * Buka ruang obrolan dengan bot baru yang telah Anda buat, lalu kirim satu pesan apa saja agar bot memiliki izin mengirim notifikasi ke akun Anda.

### 4. Kebutuhan Server / Komputer
* Docker Engine (versi 20.10 atau lebih baru)
* Docker Compose (versi 2.0 atau lebih baru)

---

## 8. Panduan Instalasi dan Pengoperasian

### Langkah 1: Kloning Repositori dan Masuk ke Direktori Proyek
```bash
git clone <URL_REPOSITORI_ANDA>
cd bot-trading-next
```

### Langkah 2: Menyiapkan File Konfigurasi Lingkungan (`.env`)
Salin file template konfigurasi:
```bash
cp .env.example .env
```

Buka file `.env` menggunakan editor teks pilihan Anda dan lengkapi nilai variabel berikut:
```env
# Mode Trading Aktif (true = Demo Testnet, false = Akun Asli/Real Live)
BINANCE_TESTNET=true

# Kredensial Akun DEMO (Binance Futures Testnet: https://testnet.binancefuture.com)
BINANCE_TESTNET_API_KEY=masukkan_api_key_testnet_di_sini
BINANCE_TESTNET_API_SECRET=masukkan_api_secret_testnet_di_sini

# Kredensial Akun ASLI / REAL (Binance Futures Live: https://fapi.binance.com)
BINANCE_REAL_API_KEY=masukkan_api_key_akun_asli_di_sini
BINANCE_REAL_API_SECRET=masukkan_api_secret_akun_asli_di_sini

# Kredensial SumoPod AI
SUMOPOD_API_KEY=masukkan_api_key_sumopod_di_sini
AI_MODEL_NAME=mimo-v2.6-flash

# Konfigurasi Cache dan Web Server
REDIS_HOST=redis
REDIS_PORT=6379
PORT=28080
LOG_LEVEL=info

# Notifikasi Telegram
TELEGRAM_BOT_TOKEN=masukkan_token_bot_telegram_di_sini
TELEGRAM_CHAT_ID=masukkan_chat_id_telegram_di_sini
```

> **Kemudahan Pengalihan Akun (Demo &harr; Real) & Isolasi Risiko:**
> Anda dapat mengisi kedua pasang kunci API di atas sekaligus. Untuk berpindah akun, Anda cukup:
> 1. Mengubah nilai `BINANCE_TESTNET=true` (untuk Demo) atau `BINANCE_TESTNET=false` (untuk Akun Asli), ATAU
> 2. Menekan tombol mode pada Dasbor Web dan menyetujui modal konfirmasi. Sistem akan mengalihkan mode dan memuat ulang bot secara otomatis.
> *Catatan Integritas Data:* Pengalihan mode sepenuhnya terisolasi; riwayat transaksi, PnL terealisasi, dan proteksi Kill Switch akun demo tersimpan secara terpisah dari akun riil.

### Langkah 3: Menjalankan Layanan Menggunakan Docker Compose
Jalankan perintah berikut untuk membangun image dan menyalakan kontainer di latar belakang:
```bash
docker-compose up -d --build
```

Perintah ini akan secara otomatis:
1. Mengunduh base image `node:20-alpine` dan `redis:7-alpine`.
2. Mengompilasi modul C++ database SQLite (`better-sqlite3`).
3. Mengonfigurasi volume data persisten pada direktori `./data`.
4. Menjalankan server aplikasi trading pada port `28080`.

### Langkah 4: Memeriksa Log Berjalan
Gunakan perintah berikut untuk memantau log aplikasi secara real-time:
```bash
docker-compose logs -f bot
```

Contoh keluaran log inisialisasi yang berhasil:
```text
Starting Resilient Trading Core...
Dashboard server running on port 28080
Time synced. Offset: -52ms
[BINANCE_LEVERAGE] Leverage for BTCUSDT set to 50x
Bootstrapping historical candles...
Bootstrapped 500 candles.
[MICRO_WS] Connected to Mainnet auxiliary stream for authentic liquidations & CVD.
WebSocket connected to btcusdt@kline_5m
```

### Langkah 5: Memperbarui Layanan Setelah Perubahan Konfigurasi
Jika Anda mengubah nilai pada file `.env` atau parameter strategi, muat ulang kontainer dengan perintah:
```bash
docker-compose restart bot
```

---

## 9. Dasbor Web dan Pemantauan

Setelah kontainer berjalan, buka browser dan akses alamat berikut:
**`http://localhost:28080`**

### Fitur Antarmuka Dasbor
* **Desain Kokpit Perdagangan Institusional (Apex Institutional Trading Cockpit):** Mengusung estetika terminal trading kelas dunia (TradingView Pro, Binance Pro Dark, Hyperliquid) yang mewah, bertenaga, dan nyaman di mata. Dibangun di atas fondasi deep midnight obsidian (`#07090e`, `#090d18`) dengan pendaran ambient cyan halus di bagian atas serta panel glassmorphic yang memiliki garis kilau atas (*inset rim highlight* `inset 0 1px 0 rgba(255, 255, 255, 0.08)`).
* **Tipografi Presisi Kontras Tinggi (Anti-Pudar, Jelas Terbaca):** Menghilangkan teks abu-abu gelap/pudar yang sulit dibaca pada latar belakang gelap:
  * Menggunakan hierarki tipografi standar industri dengan font modern `Inter` (label, judul kartu, berita) dan font monospace tabular `JetBrains Mono` (angka finansial tanpa getaran pergeseran karakter).
  * Variabel kontras tinggi yang terstandarisasi: teks primer putih bersih (`#ffffff`), teks sekunder silver terang (`#e2e8f0`), teks label dan header tabel (`#cbd5e1`), serta teks pembantu/timestamp slate terbaca (`#94a3b8`), menggantikan warna pudar sebelumnya yang tidak ramah mata.
  * Kartu performa dilengkapi komponen lencana standar: teks judul terstruktur (`Net Realized PnL`) dan pill badge mode/jangka waktu (`[All-Time • DEMO]`) dengan latar semi-transparan dan batas presisi.
* **Disiplin Polaritas Finansial Semantik (Bebas Silau, Cepat Dipindai):** Menghilangkan kebingungan kombinasi warna acak (*rainbow soup*) sekaligus menghindari tampilan abu-abu datar yang membosankan:
  * *Mint Emerald (`#10b981`):* Khusus untuk kondisi Bullish, posisi Long, profit, sinyal lolos filter (*Pass*), pantulan support, dan dominasi order beli (*Bid Wall*).
  * *Coral Rose (`#f43f5e`):* Khusus untuk kondisi Bearish, posisi Short, batas Stop Loss, pemblokiran filter (*Blocked*), penolakan resistance, dan dominasi order jual (*Ask Wall*).
  * *Electric Cyan (`#38bdf8`):* Aksen identitas terminal avionik, pin harga aktif, radar pemindai saat posisi kosong, dan penanda engine aktif.
  * *Warm Amber (`#f59e0b`):* Penanda mode Demo/Testnet dan peringatan risiko.
  * *Silvery Slate & Pure White (`#ffffff` / `#e2e8f0` / `#cbd5e1`):* Teks informatif netral dan seimbang yang kontras tinggi dan nyaman dipindai.
* **HUD Ikhtisar Ringkas & Padat (Compact Overview HUD):** 4 kartu metrik utama di bagian atas (Harga Pasar, Status Eksekusi, Sentimen AI, dan Performa Akun) disederhanakan dengan bantalan kompak (`8px 12px`) dan ukuran font angka proporsional (`1.18rem` menggantikan `1.65rem`). Mengeliminasi ruang kosong vertikal yang berlebihan, memangkas tinggi total HUD dari ~210px menjadi ~115px sehingga tidak mendominasi layar dan memberikan panggung visual utama kepada instrumen trading.
* **Tata Letak Seimbang 50/50 & Bebas Redundansi (Decluttered Workstation):** Grid utama (`.dashboard-main-grid`) menggunakan proporsi seimbang 50% / 50% (`1fr 1fr`) dengan jarak 14px. Menghilangkan elemen-elemen redundan seperti tombol switcher navigasi eksternal, banner 8 parameter statis, kartu checklist gatekeeper duplikat, dan deretan counter sumber berita, sehingga transisi layar mengalir langsung ke instrumen inti. Kolom kiri (Pelacak Posisi Aktif dan Riwayat Transaksi/Fills) dan kolom kanan (Penalaran Makro AI SumoPod dan Aliran Berita Kripto) memiliki tinggi yang seragam seimbang (~520px).
* **Bilah Status Sinyal & Parameter Taktis:** Parameter risiko disajikan secara ringkas pada pil tajuk header (Mode Engine `KEY_LEVEL_SNIPER`, `LEV 50x`, `RISK 1.0%`, `SL 0.20% • TP 0.40% (RR 2.0)`, dan `NET RR 1:1.0 (50.0% BE)`), sedangkan status sinyal real-time (`Signal: NEUTRAL / LONG / SHORT`) dan vonis filter (`Scanning Market...`, `ENTRY READY`, `BLOCKED`) tertanam langsung pada header bilah indikator pasar.
* **Kartu Sentimen AI SumoPod Dinamis:** Dilengkapi bilah indikator tingkat keyakinan (*confidence meter*) dengan gradien warna dinamis (hijau-cyan saat Bullish, merah-oranye saat Bearish, dan abu-abu saat Netral) serta kutipan penalaran makro bergaris tepi cyan.
* **Active Position Visual Tracker:** Indikator bilah rentang multi-stop interaktif yang menampilkan posisi harga saat ini di antara titik Stop Loss (`-0.20%`) dan Take Profit (`+0.40%`). Dilengkapi pin indikator cyan berpendar dengan drop glow 12px dan penanda Break-Even aktif (`(🛡️ BE ACTIVE)`).
* **Matriks Realitas Pasar & Gatekeeper V5 Simetris 6x2 (Key Level Sniper):** Menampilkan 12 metrik indikator dalam kisi terstruktur 6 kolom x 2 baris yang 100% simetris (6 kartu di baris 1 dan 6 kartu di baris 2). Dimensi kartu diperbesar dengan tinggi minimum `105px`, nilai tebal `1.05rem`, dan deskripsi multi-baris yang rapi tanpa terpotong kerdil:
  * **Baris 1 (Pemicu Utama & Realitas Volume):**
    1. *15M S/R Levels:* Level Support & Resistance 15m (rentang 24 candle / 6 jam) dengan uji zona toleransi $\pm 0.35\%$ dan konfirmasi sumbu penolakan (*rejection wick* $\ge 25\%$).
    2. *Taker Flow:* Taker Buy/Sell Volume Ratio ($L \ge 1.35$ | $S \le 0.65$).
    3. *Candle & Absorption:* Konfirmasi arah candle 5m hijau/merah dan penyerapan iceberg.
    4. *Depth Imbalance (OBI):* Rasio kedalaman order book Top 20 Bids vs Asks.
    5. *Whale Position:* Rasio Paus Top Trader L/S ($[0.85 - 1.80]$).
    6. *Vol / SMA (20):* Partisipasi volume riil vs SMA 20 ($\ge 70\%$).
  * **Baris 2 (Filter Gatekeeper & Konteks Likuiditas):**
    7. *AI Sentiment:* SumoPod MiMo LLM Macro Veto (konfluensi arah Support/Resistance).
    8. *ADX Trend (14):* Kekuatan tren pasar ($\ge 22$) untuk memblokir pasar choppy/sideways.
    9. *15M Confluence:* Konfluensi tren EMA 25 pada timeframe lebih tinggi (15 menit).
    10. *RSI Exhaustion (14):* Filter jenuh beli ($< 65$) dan jenuh jual ($> 35$).
    11. *Liquidations (60s):* Pemantauan likuidasi berantai 60 detik / 5 menit.
    12. *Open Interest:* Kedalaman kontrak aktif dan pergeseran delta OI Binance Futures.
* **AI Macro Reasoning Panel:** Menyajikan sentimen berita terbaru dari SumoPod AI (BULLISH/BEARISH/NEUTRAL), confidence score, headline pemicu, dan ringkasan analisa.
* **Tombol Darurat Panic Close & Halt (`/api/panic`):** Menutup posisi aktif seketika menggunakan market order, membatalkan seluruh order pelindung di Binance, mencatat realisasi PnL ke database, dan mengunci eksekusi trading hingga dibuka kembali melalui dasbor.
* **Terminal Konsol Live Bot Berkapasitas Penuh (Full-Width Pro Console):** Ditempatkan di bagian bawah membentang selebar layar (100% lebar dasbor) dengan area visual paling luas untuk memantau alur eksekusi bot secara mendalam. Dilengkapi tinggi viewport standar 520px (dapat diperluas ke 720px atau mode layar penuh 1-klik `⛶ Fullscreen`), kapasitas buffer memori hingga 1.000 log riwayat, tab filter kategori dengan badge penghitung instan (*All Logs*, *Filter Blocked*, *Signals & Scans*, *Orders & Positions*, *AI Macro*), pencarian kata kunci dinamis, tombol salin log, serta bilah status bawah yang menyajikan status koneksi stream SSE, utilisasi buffer, dan jumlah log aktif. Setiap baris log dilengkapi penanda lingkungan eksplisit (`[DEMO]` bernuansa amber atau `[REAL]` bernuansa emerald) untuk transparansi sumber eksekusi secara langsung.
* **Kartu Analitik Performa & Tabel Riwayat Terisolasi Mutlak (Timeframe & Mode Akun):** Memisahkan data transaksi akun Demo (Testnet) dan Real (Live) secara mutlak pada kartu metrik utama, pelacak posisi aktif, dan tabel riwayat transaksi:
  * Dilengkapi tombol beralih mode (`DEMO` / `REAL`) dan tombol pemilih jangka waktu evaluasi (`ALL`, `24H`, `3D`, `7D`, `14D`, `30D`).
  * **Telemetri Saldo Akun Real-Time (`accountBalances`):**
    * *Header Live Equity Pill:* Menyajikan nominal saldo aktif bursa saat ini (`BALANCE: $X.XX USDT`) langsung di bagian header di samping tombol status mode bot.
    * *Metrik Balance & Margin Tersedia:* Pada kisi metrik performa, disajikan nilai *Balance* dan *Avail Margin* riil bursa sesuai mode yang dipilih (`DEMO` vs `REAL`), yang beralih seketika saat tombol pil diklik.
  * Seluruh metrik (Net Realized PnL, Win Rate, rasio menang/kalah, total transaksi, open exposure, dan floating PnL) dihitung eksklusif berdasarkan mode dan rentang waktu yang dipilih. Nilai PnL telah memotong komisi transaksi bursa (Net PnL) secara presisi dengan mengekstrak harga eksekusi fill riil (*weighted average exit price*) langsung dari Binance untuk mengeliminasi deviasi harga saat rekonsiliasi, dan rincian potongan komisi (`Fee: -$X.XX`) ditampilkan langsung pada tabel Closed Trades.
  * Kartu posisi aktif (*Active Position Visual Tracker*) memfilter posisi secara ketat sesuai mode yang sedang diinspeksi. Jika tidak ada posisi pada mode tersebut, tampilan radar pemindaian otomatis disajikan.
  * Tabel *Order Fills* dan *Closed Trades* keduanya menyertakan kolom badge `Mode` (`DEMO` vs `REAL`) untuk transparansi riwayat eksekusi pada tingkat basis data.
  * Saat mode bot dialihkan melalui header dasbor, seluruh panel otomatis menyelaraskan diri mengikuti mode aktif tanpa memerlukan muat ulang halaman.
* **Persistensi Token Sesi:** Token autentikasi disimpan persisten di database SQLite. Jika kontainer atau server dimulai ulang, antarmuka browser akan tersambung kembali secara otomatis tanpa memicu galat 403 Forbidden.

---

## 10. Struktur Direktori Proyek

```
bot-trading-next/
├── .agents/
│   └── AGENTS.md             # Aturan pengembangan dan konvensi sistem
├── config/
│   ├── db.js                 # Inisialisasi SQLite mode WAL dan skema tabel
│   └── strategy.js           # Parameter perdagangan, batasan risiko, dan filter
├── data/
│   └── trading.db            # Berkas database SQLite fisik persisten (mode WAL)
├── public/
│   ├── dashboard.js          # Skrip antarmuka klien (SSE streaming, filter tab, DOM)
│   ├── index.html            # Tata letak antarmuka web dasbor
│   └── style.css             # Desain gaya visual gelap dasbor
├── services/
│   ├── ai.js                 # Klien integrasi SumoPod AI dan in-memory cache
│   ├── binance.js            # Klien REST Binance Futures dan HMAC SHA-256 signer
│   ├── dns-resolver.js       # Resolver DNS-over-HTTPS (DoH) untuk bypass blokir DNS ISP
│   ├── indicators.js         # Perhitungan matematis EMA, RSI, MACD, ATR, SMA, ADX
│   ├── logger.js             # Perekam log terformat dan event emitter
│   ├── news.js               # Pengambil dan pemfilter feed berita multi-kanal
│   └── notifier.js           # Klien pengirim pesan Telegram Bot API
├── src/
│   ├── dashboard-server.js   # Server Express REST API dan endpoint stream SSE
│   └── trading-core.js       # Engine utama eksekusi, WebSocket, dan siklus transaksi
├── test/
│   ├── indicators.test.js      # Pengujian unit kalkulasi indikator teknikal & level S/R
│   ├── news-filtering.test.js  # Pengujian filter berita, spam, anti-noise, dan deteksi darurat
│   ├── resilience.test.js      # Pengujian serialisasi error logger dan cache DoH DNS
│   └── risk-management.test.js # Pengujian formula ukuran posisi, SL/TP, pembatas loss, dan stale exit
├── .env.example              # Template variabel lingkungan
├── Dockerfile                # Konfigurasi pembuatan image Docker
├── docker-compose.yml        # Konfigurasi layanan kontainer bot dan Redis
├── package.json              # Daftar pustaka dependensi dan skrip proyek
├── prompt.md                 # Spesifikasi teknis arsitektur sistem (English)
└── README.md                 # Dokumentasi panduan operasional proyek (Bahasa Indonesia)
```

---

## 11. Pengujian Unit Test

Seluruh formula matematika, perhitungan indikator teknikal, deteksi level S/R, penanganan ketahanan jaringan, serta pembatasan risiko ukuran posisi divalidasi menggunakan test runner bawaan Node.js (`40 pengujian unit test`).

Jalankan rangkaian pengujian di dalam kontainer Docker:
```bash
docker exec bot-trading-next-bot-1 npm test
```

### Rincian Cakupan 4 Test Suite:
1. **Indicators Calculation Suite (8 Pengujian):**
   * Perhitungan EMA, SMA, ADX, dan agregasi lilin 5m ke 15m.
   * Ekstraksi level dinamis Support & Resisten 15m (rentang 24 lilin).
   * Evaluasi pantulan Support, penolakan Resistance, dan eliminasi *mid-range chop*.
   * Perhitungan rasio kedalaman buku pesanan (*Order Book Imbalance Top 20*).
2. **News & Macro Intelligence Filtering Suite (6 Pengujian):**
   * Pemblokiran spam, iklan airdrop, dan promosi token.
   * Penyaringan berita altcoin tanpa jangkar Bitcoin atau makro.
   * Validasi berita makro berdampak tinggi (kebijakan Fed, CPI, regulasi).
   * Deteksi kata kunci darurat (*Black Swan Emergency Halt*).
   * Pemfilteran opini/prediksi spekulatif analis.
   * Penjaga kesegaran berita (*News Freshness Guard* $\le 45$ menit).
3. **Resilience and Error Formatting Suite (2 Pengujian):**
   * Format serialisasi objek error tanpa menghasilkan output kosong `{}`.
   * Ketahanan cache *stale-on-error* DoH DNS saat koneksi internet terputus.
4. **Risk Management Logic Suite (24 Pengujian):**
   * Formula ukuran posisi (*position sizing*) berbasis risiko 1,0% ekuitas.
   * Perhitungan harga Stop Loss (0,20%) dan Take Profit (0,40%) posisi LONG dan SHORT.
   * Plafon batas aman margin 70% pada leverage 50x.
   * Pengaman akun modal mikro (penjepit ke lot minimum 0,001 BTC).
   * Isolasi mutlak status posisi, riwayat transaksi, dan Kill Switch mode DEMO vs REAL.
   * Filter Whale Top Trader Long/Short Ratio dengan kalibrasi resisten 2,25.
   * Filter Taker Order Flow Ratio dan konfirmasi lilin anti-iceberg.
   * Filter likuiditas volume $\ge 70\%$ SMA 20.
   * Perhitungan Net PnL dengan pemotongan biaya komisi bolak-balik bursa.
   * Filter tren ADX dan konfluensi timeframe 15m.
   * Sinkronisasi posisi bersign negatif Binance Futures (`positionAmt < 0`).
   * Filter pembatas tingkat pendanaan (*Funding Rate Guard*).
   * Jeda pendinginan pasca kerugian (*Post-Loss Cooldown* 20 menit).
   * Filter kelelahan jenuh beli/jual RSI [35 - 65].
   * Konfigurasi Key Level Sniper dan konfluensi arah SumoPod AI.
   * Resolusi paradoks tren MTF dan batas atas ADX rentang S/R.
   * Penutupan otomatis posisi tertahan (*Time-Based Stale Exit 60 Menit*).

---

## 12. Panduan Keamanan dan Praktik Operasional

1. **Keamanan Kredensial File `.env`:**
   Jangan pernah menyertakan atau melakukan commit berkas `.env` ke repositori publik (seperti GitHub). Selalu pastikan berkas `.env` tercantum dalam `.gitignore`.
2. **Ketahanan Jaringan, DNS-over-HTTPS (DoH), dan Dynamic Edge Failover:**
   Di Indonesia, penyedia jasa internet (ISP) kerap mengalami gangguan lookup DNS atau membajak port 53. Modul `services/dns-resolver.js` menggunakan DoH (Cloudflare `1.1.1.1` dan Google `8.8.8.8`) dengan pemaksaan rute IPv4, rotasi *round-robin*, dan mekanisme *domain pre-warming* serta penyimpanan IP *stale-on-error* (`lastKnownIps`). Apabila jaringan internet mengalami *drop* sesaat, bot tetap dapat menyelesaikan nama domain (`stream.binancefuture.com`, `fapi.binance.com`, dsb.) menggunakan IP cache terakhir, mengeliminasi galat `getaddrinfo EAI_AGAIN`. Selain itu, modul dilengkapi pendeteksi *shared proxy/edge ban* (`-1003`) otomatis yang langsung memasukkan node CloudFront bermasalah ke daftar hitam (*blacklisting*) sementara dan mengalihkan permintaan ke node sehat secara otomatis tanpa mengunci sistem bot.
3. **Kunci Konkurensi Asinkron & Penanganan Galat Transien:**
   Seluruh loop pemantauan latar belakang berkala (`ensureLivePrice`, `fetchWhaleMetrics`, `monitorNews`, `reconcilePositions`) dilindungi oleh kunci status in-flight (`isEnsuringPrice`, `isFetchingWhale`, `isMonitoringNews`, `isReconciling`). Saat koneksi internet terputus sementara, bot tidak akan meluncurkan panggilan API bertumpuk (*thundering herd*). Rekonsiliasi posisi berkala yang gagal akibat putusnya koneksi jaringan akan ditunda secara elegan (`[RECONCILE_NOTE]`) ke siklus berikutnya tanpa memicu alarm galat palsu.
4. **Serialisasi Galat Lengkap pada Konsol Bot:**
   Modul `services/logger.js` memformat objek galat (*Error instances*) secara eksplisit dengan menyajikan nama galat, pesan deskriptif, dan kode API terkait. Hal ini mencegah objek galat terkonversi menjadi objek kosong `{}` pada terminal maupun Dasbor Konsol Live.
5. **Pengujian Bertahap di Testnet:**
   Disarankan menjalankan bot pada Binance Futures Testnet minimal selama 1 hingga 2 minggu guna mengevaluasi perilaku eksekusi di berbagai kondisi pasar (sideways, volatilitas tinggi, maupun rilis berita berdampak besar).
6. **Ketersediaan Server:**
   Gunakan Virtual Private Server (VPS) dengan koneksi jaringan yang stabil dan latensi rendah ke server bursa untuk memastikan bot dapat merespons pergerakan pasar secara konsisten tanpa terputus saat komputer pribadi dimatikan.
7. **Pemantauan Berkala:**
   Meskipun bot beroperasi secara otonom, pengguna disarankan tetap memantau laporan notifikasi Telegram dan ketersediaan dasbor secara berkala. Tombol Panic Close pada dasbor dapat digunakan kapan saja jika diperlukan intervensi manual segera.

---

## 13. Riwayat Evolusi Strategi & Parameter Historis

Bagian ini mendokumentasikan secara permanen riwayat evolusi parameter dan arsitektur strategi trading yang pernah digunakan dalam sistem. Dokumentasi ini berfungsi sebagai catatan historis komprehensif agar pengembang maupun sistem di masa mendatang dapat memahami konteks, batasan empiris, dan alasan peralihan di setiap tahapan.

### Matriks Perbandingan Evolusi Parameter Antar-Generasi

| Metrik Parameter | Generasi 1: Conservative Multi-Indicator Sniper (V1) | Generasi 2: Softened Scalp Transition (V2) | Generasi 3: High-Frequency Micro-Scalp (V3) | Generasi 4: Order Flow Sniper Engine (V4) | Generasi 5: Key Level Sniper Engine (V5 - AKTIF) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Status Strategi** | Diarsipkan (*Inception*) | Diarsipkan (*Fase 2*) | Diarsipkan (*Fase 3*) | Diarsipkan (*Fase 4*) | **AKTIF DIGUNAKAN DI PRODUKSI** |
| **Mode Strategi** | `LAGGING_INDICATORS` | `LAGGING_INDICATORS` | `LAGGING_INDICATORS` | `ORDER_FLOW_SNIPER` | `KEY_LEVEL_SNIPER` |
| **Simbol & Timeframe** | 5m BTCUSDT | 5m BTCUSDT | 5m BTCUSDT | 5m BTCUSDT | **5m BTCUSDT (Konteks S/R MTF 15m)** |
| **Leverage Akun** | 25x Cross / Isolated | 25x Cross / Isolated | 50x Cross / Isolated | 50x Cross / Isolated | **50x Cross / Isolated** |
| **Risiko per Transaksi** | 1,5% Modal Bebas | 1,5% Modal Bebas | 1,5% Modal Bebas | 1,0% Modal Bebas | **1,0% Modal Bebas (Sizing Terukur)** |
| **Jarak Stop Loss** | Max(2 * ATR, 0,50% Harga) | Max(2 * ATR, 0,50% Harga) | Max(2 * ATR, 0,30% Harga) | Max(1,5 * ATR, 0,75% Harga) | **Max(1,0 * ATR, 0,20% Harga)** (~$152 pada BTC $76k) |
| **Target Take Profit** | 1,00% Harga (RR 1:2,0) | 0,75% Harga (RR 1:1,5) | 0,50% Harga (RR 1:1,67) | 1,50% Harga (Gross RR 1:2,0) | **0,40% Harga (Gross RR 1:2,0 / Calibrated Sniper)** |
| **Biaya Taker Bolak-Balik** | 0,10% (0,05% in + 0.05% out) | 0,10% | 0,10% | 0,10% | **0,10% (Standar Taker Binance Futures)** |
| **Hasil Bersih Win / Loss** | +0,90% / -0,60% | +0,65% / -0,60% | +0,40% / -0,40% | +1,40% / -0,85% | **+0,30% / -0,30% (Break-Even Win Rate: 50,0%)** |
| **Net Risk-to-Reward Ratio** | 1 : 1,50 Net | 1 : 1,08 Net | 1 : 1,00 Net | 1 : 1,65 Net | **1 : 1,00 Net (Taker) / 1 : 1,10 Net (Maker TP)** |
| **Trailing Stop & Break-Even**| Tidak Ada | Tidak Ada | Tidak Ada | +0,50% Profit -> Geser SL ke Entry | **DINONAKTIFKAN (Cegah pencekikan profit dini)** |
| **Pemicu Utama Eksekusi** | EMA50 + MACD Hist + RSI | EMA50 + MACD Hist + RSI | EMA50 + MACD Hist + RSI | Imbalance Order Flow + Candle | **Uji Zona S/R 15m + Rejection Wick (Pinbar/Pantulan)** |
| **Pemicu Sinyal LONG** | Close > EMA50, MACD > 0, RSI < 65 | Close > EMA50, MACD > 0, RSI < 65 | Close > EMA50, MACD > 0, RSI < 65 | Rasio Taker &ge; 1,35 DAN Candle Hijau | **Uji Zona Support [&plusmn;0,35%] + Lower Wick &ge; 25% + AI Netral/Bullish** |
| **Pemicu Sinyal SHORT** | Close < EMA50, MACD < 0, RSI > 35 | Close < EMA50, MACD < 0, RSI > 35 | Close < EMA50, MACD < 0, RSI > 35 | Rasio Taker &le; 0,65 DAN Candle Merah | **Uji Zona Resisten [&plusmn;0,35%] + Upper Wick &ge; 25% + AI Netral/Bearish** |
| **Saringan Mid-Range Chop** | Tidak Ada | Tidak Ada | Tidak Ada | Tidak Ada | **Memblokir transaksi di zona tengah netral (Menunggu S/R)** |
| **Filter Partisipasi Volume** | &ge; 1,20 * SMA(20) Volume | &ge; 0,60 * SMA(20) Volume | &ge; 0,45 * SMA(20) Volume | &ge; 0,70 * SMA(20) Volume | **&ge; 0,70 * SMA(20) Volume Standar Likuiditas** |
| **Filter Kekuatan Tren ADX** | ADX &ge; 20 (Wajib Lolos) | ADX &ge; 15 (Relaksasi) | ADX &ge; 15 (Relaksasi) | ADX &ge; 22 (Active Sniper) | **ADX &ge; 22 (Membuang Pasar Sideways Tanpa Tren)** |
| **Konfluensi Tren 15m MTF** | 15m EMA50 (Wajib Lolos) | 15m EMA25 (Relaksasi) | 15m EMA25 (Relaksasi) | 15m EMA25 Confluence | **Rentang S/R 15m (24 Candle) + EMA25 MTF** |
| **Funding Rate Guard** | Tidak Ada | Tidak Ada | Tidak Ada | Max +/- 0,04% | **Max +/- 0,04% (Cegah Penalti Biaya Sesi Funding)** |
| **Rasio Posisi Top Trader** | [0,90 - 1,60] | [0,85 - 1,65] | [0,85 - 1,80] | [0,85 - 1,80] | **[0,85 - 1,80] Kalibrasi Bias Long Struktural BTC** |
| **Veto Makro AI (SumoPod)** | Veto Sentimen (Keyakinan > 5) | Veto Sentimen (Keyakinan > 5) | Veto Sentimen (Keyakinan > 5) | Veto Sentimen (Keyakinan &ge; 7) | **Konfluensi Arah: Wajib searah/netral dengan setup level kunci** |
| **Jeda Pasca-Loss (Cooldown)**| Tidak Ada | Tidak Ada | Tidak Ada | 20 Menit Pasca Stop Loss | **20 Menit Jeda Pasca Terkena Stop Loss** |
| **Aturan Posisi Tunggal** | Disiplin Maks 1 Posisi | Disiplin Maks 1 Posisi | Disiplin Maks 1 Posisi | Disiplin Maks 1 Posisi | **Disiplin Maks 1 Posisi** |
| **Batas Durasi Maksimal (Time Stop)** | Tidak Ada | Tidak Ada | Tidak Ada | Tidak Ada | **60 Menit (Pruning Stale Position / Anti-Funding Decay)** |

---

### Analisis Rinci dan Rasionalitas Peralihan Antar-Generasi

#### 1. Generasi 1 (V1) - *Conservative Multi-Indicator Sniper*
* **Hipotesis Desain:** Menggabungkan 7 filter ortogonal sekaligus (EMA 50, histogram MACD, batas RSI, ADX &ge; 20, tren MTF 15m EMA 50, partisipasi volume 120%, posisi paus, dan veto AI) dengan harapan membuang 100% false breakout dan menghasilkan win rate sangat tinggi dengan RR 1:2.
* **Kelemahan Empiris:** Terjadi kelaparan sinyal ekstrim (*signal starvation / analysis paralysis*). Selama berhari-hari pemantauan, bot hampir tidak pernah membuka posisi karena seluruh filter indikator saling bertentangan. Indikator moving average dan MACD bersifat lagging (menoleh ke masa lalu); pada saat seluruh indikator akhirnya selaras pada timeframe 5 menit, gelombang pergerakan harga biasanya sudah mendekati akhir (*exhaustion wick*), sehingga entri terlambat dan rentan terkena koreksi.

#### 2. Generasi 2 (V2) - *Softened Scalp Transition*
* **Hipotesis Desain:** Melonggarkan batasan filter indikator (ambang batas ADX diturunkan ke 15, volume diturunkan ke 0,60x, EMA MTF dipercepat ke 25, dan TP dipangkas ke 0,75%) untuk meningkatkan peluang transaksi.
* **Kelemahan Empiris:** Meskipun penolakan filter berkurang, ketergantungan pada arah EMA 50 dan histogram MACD tetap menyebabkan keterlambatan entri. Target kenaikan harga 0,75% (~$625 pada BTC) juga terbukti masih terlalu berat untuk dipertahankan dalam satu siklus impuls 5 menit tanpa pullback.

#### 3. Generasi 3 (V3) - *High-Frequency Micro-Scalp*
* **Hipotesis Desain:** Menaikkan leverage ke 50x, memperketat Stop Loss floor ke 0,30% (~$250 pada BTC) dan target Take Profit ke 0,50% (~$418 pada BTC, RR 1:1,67) guna mempercepat perputaran transaksi (*high-turnover*).
* **Kelemahan Empiris:** Penggunaan leverage 50x efektif mengefisienkan modal per trade, tetapi logika pemicu entri yang masih berpijak pada persilangan rata-rata harga teknikal klasik tetap lambat merespons dinamika likuiditas mikrostruktur yang sebenarnya terjadi di buku pesanan.

#### 4. Generasi 4 (V4) - *Order Flow Sniper Engine*
* **Transformasi Paradigma:** Menggantikan indikator lambat dengan realitas aliran mikrostruktur pesanan taker (`takerBuySellRatio >= 1.35` / `<= 0.65`) dan konfirmasi candle.
* **Kelemahan Empiris:**
  1. **Asimetri Negatif Trailing Stop & Break-Even Dini:** Mekanisme break-even menggeser Stop Loss ke `Entry + 0.10%` segera setelah profit mengambang menyentuh $+0.50\%$. Pada pergerakan harga BTC 5 menit yang memiliki rentang wick normal $0.20\% - 0.40\%$, hampir seluruh posisi yang sedang unggul terkena penutupan dini (*premature stop-out*) pada profit receh ($+\$1.7 - +\$12.0$, bahkan minus setelah fee komisi). Sebaliknya, posisi yang berlawanan arah langsung tersapu menuju Stop Loss penuh ($-0.75\% = -\$35$ sampai $-\$45$). Hal ini merusak rasio Risk-to-Reward riil di akun trading karena target Take Profit $+1.50\%$ ($+\$70$) tidak pernah diberi kesempatan bernapas untuk tercapai.
  2. **Scalping Impulsif Tanpa Level Struktural:** Lonjakan taker imbalance 5 menit kerap terjadi di tengah rentang harga (*no man's land*) atau persis di bawah resisten kuat, memicu entri scalping impulsif yang rentan terjebak *fakeout*.

#### 5. Generasi 5 (V5 - AKTIF) - *Key Level Sniper Engine & Profit Preservation*
* **Penyempurnaan Arsitektur:**
  1. **Penonaktifan Trailing Stop & Break-Even Dini:** Parameter `trailingStop.enabled` dan `trailingStop.breakEven.enabled` dinonaktifkan secara eksplisit (`false`). Posisi perdagangan diberikan ruang napas penuh untuk bergerak menuju target Take Profit terencana (1:2,0 RR kotor), mencegah tercekiknya posisi oleh sumbu mikro sesaat sehingga nominal kemenangan sebanding secara matematis dengan risiko Stop Loss.
  2. **Level Kunci Support & Resistance Multi-Timeframe (15m S/R):** Sistem menghitung Swing Highs dan Swing Lows dinamis berbasis 24 candle agregat 15 menit (jendela rolling 6 jam). Transaksi hanya diizinkan pada area level kunci bervolume tinggi ($\pm 0,35\%$ zona toleransi):
     * **Beli (LONG) di Zona Support:** Dilakukan saat harga menguji Support dan membentuk sumbu bawah penolakan (*lower wick rejection / hammer / pinbar* $\ge 25\%$ rentang candle) atau candle pantulan hijau.
     * **Jual/Short di Zona Resistance:** Dilakukan saat harga menguji Resistance dan membentuk sumbu atas penolakan (*upper wick rejection / shooting star / pinbar* $\ge 25\%$ rentang candle) atau candle pembalikan merah.
  3. **Eliminasi Mid-Range Chop:** Bila harga berada di area tengah netral di antara Support dan Resistance, sistem menolak entri (`NO_SIGNAL_SCANNING`), menghentikan scalping buta di sembarang titik harga.
  4. **Konfluensi Berita Makro & Sentimen AI (SumoPod):** Berita dan sentimen makro AI diintegrasikan sebagai filter konfluensi arah: transaksi LONG di Support hanya sah jika sentimen AI bernilai Netral atau Bullish (dilarang keras jika Bearish); transaksi SHORT di Resistance hanya sah jika sentimen AI bernilai Netral atau Bearish (dilarang keras jika Bullish).
  5. **Target Presisi Terkalibrasi & Batas Waktu 60 Menit (SL 0,20% • TP 0,40% • Max 60M):** Target diselaraskan secara presisi ke Stop Loss 0,20% (~$152 pada BTC) dan Take Profit 0,40% (~$304 pada BTC) yang menghasilkan Net RR 1:1,00 setelah potongan komisi bolak-balik bursa (0,10%), serta menurunkan batas *break-even win rate* impas menjadi 50,0%. Dilengkapi pengaman durasi (*Time-Based Stale Exit 60 Menit*) yang mengeksekusi penutupan pasar otomatis jika transaksi terjebak stagnan lebih dari 1 jam guna mencegah pembusukan momentum (*alpha decay*) dan penalti berulang biaya funding rate 8 jam.
