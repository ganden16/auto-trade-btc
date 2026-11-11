# MASTER PROMPT SPECIFICATION: RESILIENT HYBRID TRADING BOT (NODE.JS + BINANCE FUTURES + SUMOPOD AI)

# ROLE & OBJECTIVE
You are a Principal Financial Systems Architect and Distributed Systems Engineer specializing in High-Frequency Trading (HFT), Algorithmic Derivatives Execution, and Fault-Tolerant Architectures.

**Objective:** Build a complete, production-ready, autonomous hybrid trading system for Binance Futures Testnet (`BTCUSDT`, 5-minute interval, 50x leverage) equipped with:
1. **Key Level Sniper & Macro Confluence Trading Engine** with mathematically precise risk management (V5 Active Setup: 15m Multi-Timeframe Support/Resistance detection, 25% Rejection Wick confirmation, Stop Loss Floor 0.20%, Take Profit 0.40%, Gross 1:2.0 Risk-Reward Ratio, Net 1:1.00 Risk-Reward Ratio after round-trip taker commissions, trailing stop/break-even throttles disabled, 60-minute max hold exit, and Directional AI News Confluence activated).
2. **SumoPod AI Gatekeeper** (`https://ai.sumopod.com/v1/chat/completions` powered by MiMo LLM, default model `mimo-v2.6-flash`) for macro sentiment analysis, AI trade vetoing, and emergency position exits.
3. **Multi-Source RSS News Intelligence** (CoinDesk, Decrypt, Cointelegraph, and Binance Announcements via `rss-parser`).
4. **SQLite-First State Consistency & Redis Caching** (`better-sqlite3` synchronous WAL mode + `ioredis` ephemeral cache).
5. **Telegram Notifications Engine** (`services/notifier.js` supporting Telegram Bot API for real-time mobile trade and system alerts).
6. **Hierarchical Error Handling & Resilience Matrix** (Classified retry policies, exponential backoff, automated timestamp resynchronization, degraded mode, and auto-recovery).
7. **Real-Time WebSocket & Auto-Reconnect Pipeline** (Binance kline ticker stream + Server-Sent Events / SSE for live logs and UI updates).
8. **Real-time Glassmorphic Trading Terminal Dashboard** (Live price ticker flasher, visual range tracker, trade history, fill audits, and cyber log console).
9. **Dockerized Environment** (`node:20-alpine` with native build tools, `tini` PID 1, Redis 7, port `28080`).

---

## 1. CORE OPERATIONAL PHILOSOPHY (NON-NEGOTIABLE)
1. **Capital Preservation > Profit:** If uncertain or if API/technicals conflict, DO NOT TRADE.
2. **SQLite is the Single Source of Truth:** `better-sqlite3` runs strictly synchronously in WAL mode. Redis is an ephemeral cache rebuilt from SQLite upon boot.
3. **SumoPod AI as Macro Guard:** SumoPod analyzes global financial sentiment before trade execution. If AI sentiment contradicts technical signals (confidence > 5), the AI acts as a veto filter. If a held position contradicts severe sentiment (confidence >= 8), trigger an emergency market exit immediately.
4. **Synchronous vs. Asynchronous Separation:** Database operations MUST NEVER be wrapped in fake `async/await` promises. Database writes use synchronous transactions (`db.transaction`). Network operations (Binance REST, SumoPod AI, RSS, Notifier) use asynchronous promises with specialized error wrappers.
5. **Fee & Noise Resistance:** Scalp targets account for Binance round-trip taker commissions (0.10%). Stop Loss is configured at 0.20% (approx $152 on BTC at $76k) and Take Profit at 0.40% (Gross 1:2.0 RR, Net 1:1.00 RR, approx $304 on BTC at $76k) to deliver robust sniper targets with an empirical break-even win rate requirement of 50.0% after commissions, complemented by a 60-minute max hold rule to eliminate alpha decay.
6. **Single Concurrent Position & Multi-Environment Isolation Rule:** The system strictly isolates DEMO and REAL trading environments at the database schema level (`active_positions` uses composite `PRIMARY KEY (symbol, mode)`). Concurrently within each environment (`DEMO` or `REAL`), the engine enforces a strict one-active-position policy per symbol. If an active position exists in the active running engine mode, all new signal evaluations are immediately bypassed until that position is fully closed by Take Profit, Stop Loss, Trailing Stop, or Emergency Exit. This prevents margin overextension, eliminates martingale blowout risk on 50x leverage, and guarantees that switching between testnet and live execution never deletes, overwrites, or corrupts positions from either environment.
7. **No Placeholders or Truncations:** Output COMPLETE, fully functional code across all files. No `// TODO`, no `/* implement later */`, and no truncated snippets.

---

## 2. TECH STACK & SYSTEM ARCHITECTURE

### Runtime & Libraries (`package.json`)
* **Node.js:** `>= 18.0.0` (LTS Node 20 recommended).
* **Dependencies:**
  * `axios` (`^1.6.8`): REST API client with custom interceptors for Binance, SumoPod, and Notifier webhooks.
  * `better-sqlite3` (`^9.4.3`): Synchronous SQLite database driver for zero-latency local state persistence.
  * `bignumber.js` (`^9.1.2`): Mandatory for ALL financial calculations, prices, quantities, and indicators.
  * `cors` (`^2.8.5`): CORS middleware for the dashboard server.
  * `dotenv` (`^16.4.5`): Environment variable loader.
  * `express` (`^4.19.2`): HTTP API and Server-Sent Events (SSE) server on port `28080`.
  * `ioredis` (`^5.3.2`): In-memory Redis cache client.
  * `rss-parser` (`^3.13.0`): Multi-source RSS news ingestion engine.
  * `ws` (`^8.16.0`): Binance Futures WebSocket connection with automatic reconnect and message deduplication.

### Containerization & Deployment Strategy
* **Docker Container Architecture (`node:20-alpine`):**
  * Mandatory build dependencies: `RUN apk add --no-cache python3 make g++ tini` (required to compile native C++ bindings for `better-sqlite3` against `musl libc`).
  * Process manager: `ENTRYPOINT ["/sbin/tini", "--"]`.
  * Exposed port: `EXPOSE 28080`.
  * Auto-created directory: `RUN mkdir -p data`.
  * Startup command: `CMD ["npm", "start"]`.
* **Docker Compose (`docker-compose.yml`):**
  * `bot`: Builds the current context, `restart: on-failure:5`, `NODE_ENV=production`, ports `127.0.0.1:28080:28080` (bound strictly to loopback to eliminate unencrypted public HTTP exposure), depends on `redis`.
  * DNS Configuration: `dns: [8.8.8.8, 1.1.1.1]` (mandatory for reliable DNS resolution of SumoPod AI, Binance, and Webhooks inside Alpine container).
  * Host volume mounts: `./data:/app/data`, `./public:/app/public`, `./src:/app/src`, `./services:/app/services`, `./config:/app/config`, `./test:/app/test`, `./.env:/app/.env`.
  * `redis`: `redis:7-alpine`, ports `127.0.0.1:26379:6379` (bound strictly to loopback to eliminate public internet exposure), named volume `redis_data:/data`.
  * `build-app`: Automated standalone cross-compilation pipeline under profile `build`. Builds a standalone Windows x64 executable without host toolchain prerequisites.
  * `deploy-vps`: Automated deployment and container restart pipeline under profile `deploy` (`docker compose --profile deploy run --rm deploy-vps`), mounting `~/.ssh:/root/.ssh:ro` for zero-password cryptographic SSH key authentication and syncing source changes to remote VPS via SSH without exposing secrets or overwriting remote SQLite state.

### VPS Production Hardening & Security Architecture
* **Intrusion Prevention (Fail2ban):** Configured with systemd backend and UFW integration (`banaction = ufw`, `bantime = 86400`, `maxretry = 3`). Automatically bans external IP addresses attempting dictionary brute-force attacks on port 22.
* **Firewall Isolation (UFW):** Strict default deny incoming policy (`default deny incoming`, `default allow outgoing`). Ingress ports restricted strictly to 22 (SSH), 80 (HTTP redirect), and 443 (HTTPS). Insecure direct HTTP port 28080 is removed from UFW and bound exclusively to loopback `127.0.0.1`.
* **SSH Key-Only Cryptographic Authentication:** Passwords completely disabled across sshd configurations (`/etc/ssh/sshd_config` and `/etc/ssh/sshd_config.d/60-hardening.conf` with `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`). Authentication restricted exclusively to Ed25519 / RSA public keys (`PubkeyAuthentication yes`).
* **Automated TLS / HTTPS Reverse Proxy (Caddy):** Deployed alongside the bot with zero-configuration Let's Encrypt TLS issuance for wildcard DNS (`https://<VPS_IP>.sslip.io`). Configured with `flush_interval -1` on `reverse_proxy 127.0.0.1:28080` to stream Server-Sent Events (SSE) and price ticks with zero buffering. Automatic HTTP-to-HTTPS redirect ensures credentials and session tokens are never transmitted in cleartext over the network.

### Desktop Windows Standalone Portable Executable Architecture (Option A)
* **Design Philosophy:** Complete autonomy without requiring Docker, WSL, or Node.js on the client machine. The compiled binary (`build/bot-trading.exe`) is an all-in-one PE32+ executable packaging the Node.js 20 runtime, production dependencies, C++ native modules, and bot source code into a single binary.
* **Native C Launcher (`scripts/windows/launcher.c`):**
  * Implements an optimized Windows PE32+ entry point using MinGW-w64 (`x86_64-w64-mingw32-gcc`).
  * Embedded Resource Extraction: Reads the packaged ZIP bundle from Windows Resource `RT_RCDATA` (`scripts/windows/app.rc`), unpacks it to `%LOCALAPPDATA%\BotTradingNext\runtime` on initial launch or version update, and verifies checksum via `version.txt` for instantaneous secondary launches.
  * Local State Persistence: Automatically sets `DATA_DIR` to the current working directory (`%CD%`), guaranteeing that SQLite database (`data/trading.db`) and `.env` configuration file remain strictly persistent inside the folder from which the executable is launched. If `.env` is absent, creates one from `.env.example`.
  * Autonomous Browser Launch: Spawns the default desktop web browser to `http://localhost:28080` once the Express dashboard server is operational.
  * In-Memory Fallback Adapter: Automatically sets `USE_REDIS=false`, seamlessly delegating caching operations to the built-in `InMemoryCache` without requiring an external Redis server.
* **Hermetic Build Pipeline (`scripts/build-windows.sh` & `Dockerfile.builder`):**
  * Cross-compiles using Alpine Linux container with `mingw-w64-gcc`, `mingw-w64-binutils`, and `7zip`.
  * Fetches official Windows x64 Node.js binary (`node.exe`) and precompiled Windows ABI 115 `better_sqlite3.node` native addon.
  * Compiles launcher and resource manifest into a single portable binary in `./build/bot-trading.exe`. Executable via `docker compose --profile build run --rm build-app` or `npm run build:exe`.

---

## 3. ENVIRONMENT CONFIGURATION (`.env.example`)
```env
# Trading Mode: true = DEMO (Binance Testnet), false = REAL (Binance Live)
BINANCE_TESTNET=true

# Demo Account Credentials (Binance Futures Testnet)
BINANCE_TESTNET_API_KEY=your_binance_testnet_api_key
BINANCE_TESTNET_API_SECRET=your_binance_testnet_api_secret

# Real Production Account Credentials (Binance Futures Live)
BINANCE_REAL_API_KEY=your_binance_real_api_key
BINANCE_REAL_API_SECRET=your_binance_real_api_secret

# Fallback compatibility keys
BINANCE_API_KEY=
BINANCE_API_SECRET=

SUMOPOD_API_KEY=your_sumopod_api_key
AI_MODEL_NAME=mimo-v2.6-flash
REDIS_HOST=redis
REDIS_PORT=6379
PORT=28080
LOG_LEVEL=info

# Security & High-Impact Action Protection
DASHBOARD_PASSWORD=your_secure_password

# Optional Telegram Notifications
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Remote VPS Deployment (Optional)
VPS_IP=
VPS_USER=ubuntu
VPS_PASS=
```

---

## 4. DATABASE SCHEMA & SYNCHRONOUS STATE PERSISTENCE (`config/db.js`)
* **SQLite Engine Configuration:**
  ```javascript
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  ```
* **Complete DDL Schema:**
  ```sql
  CREATE TABLE IF NOT EXISTS historical_candles (
    startTime TEXT PRIMARY KEY,
    open TEXT NOT NULL,
    high TEXT NOT NULL,
    low TEXT NOT NULL,
    close TEXT NOT NULL,
    volume TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS active_positions (
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price TEXT NOT NULL,
    qty TEXT NOT NULL,
    unrealized_pnl TEXT,
    sl_id TEXT,
    tp_id TEXT,
    sl_price TEXT,
    tp_price TEXT,
    trailing_sl TEXT,
    atr_at_entry TEXT,
    is_be_active INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL,
    mode TEXT NOT NULL DEFAULT 'DEMO',
    PRIMARY KEY (symbol, mode)
  );

  CREATE TABLE IF NOT EXISTS position_fills (
    id TEXT PRIMARY KEY,
    position_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    fill_price TEXT NOT NULL,
    fill_qty TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    mode TEXT NOT NULL DEFAULT 'DEMO'
  );

  CREATE TABLE IF NOT EXISTS trade_history (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    side TEXT NOT NULL,
    price TEXT NOT NULL,
    qty TEXT NOT NULL,
    pnl TEXT,
    commission TEXT,
    mode TEXT NOT NULL DEFAULT 'DEMO'
  );

  CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT,
    mode TEXT NOT NULL DEFAULT 'DEMO'
  );

  CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- High-Performance Partitioning Indexes
  CREATE INDEX IF NOT EXISTS idx_active_positions_mode ON active_positions (mode);
  CREATE INDEX IF NOT EXISTS idx_position_fills_mode_time ON position_fills (mode, timestamp);
  CREATE INDEX IF NOT EXISTS idx_trade_history_mode_time ON trade_history (mode, timestamp);
  CREATE INDEX IF NOT EXISTS idx_system_logs_mode_time ON system_logs (mode, timestamp);
  ```
* **Synchronous Atomic Transaction Rule:**
  All order fill insertions and position deletions MUST execute inside synchronous transactions:
  ```javascript
  const insertTx = db.transaction(() => {
    db.prepare('INSERT INTO active_positions (...) VALUES (...)').run(...);
    db.prepare('INSERT INTO position_fills (...) VALUES (...)').run(...);
  });
  insertTx(); // Synchronous atomic execution
  ```
* **Redis Synchronization:**
  Redis serves as an ephemeral fast cache partitioned by symbol and trading environment (`pos:BTCUSDT:DEMO` vs `pos:BTCUSDT:REAL`). Redis is updated ONLY AFTER the SQLite transaction completes. If Redis fails, log a warning and proceed without rolling back SQLite.

---

## 5. TRADING STRATEGY & RISK RULES (`config/strategy.js`)
* **Symbol & Timeframe:** `BTCUSDT`, `5m` candle intervals, memory cap of 500 candles.
* **Strategy Execution Mode:** `KEY_LEVEL_SNIPER` (Multi-Timeframe Key Level Support & Resistance + Rejection Wick + Macro News Confluence, V5 Active).
* **Multi-Horizon Key Levels (15m S/R Bounds):**
  * Rolling Tactical Lookback: `24` aggregated 15m candles (6 hours of tactical swing action).
  * Rolling Macro Lookback: `96` aggregated 15m candles (24 hours of macro daily swing bounds).
  * Multi-Horizon Anchoring (`multiHorizon: true`): Evaluates both tactical 6h S/R and institutional 24h daily high/low structural levels simultaneously.
  * Zone Proximity Tolerance: `0.35%` (`zoneTolerancePct: 0.35`). Price within 0.35% of Support is classified in Support Zone; price within 0.35% of Resistance is classified in Resistance Zone.
  * Rejection Wick Guard: Minimum `25%` of total candle range (`minRejectionWickPct: 0.25`) must form a rejection shadow (lower wick for Support absorption, upper wick for Resistance rejection) OR display a directional bounce candle (`Close > Open` for LONG, `Close < Open` for SHORT).
  * Mid-Range Chop Elimination: Trades are strictly prohibited in the neutral middle zone between Support and Resistance.
* **Dynamic Confluence Scoring Engine (`confluence`):**
  * Resolves under-trading and binary over-filtering friction by evaluating a weighted 100-point confluence matrix:
    - Key Level Location & Rejection Wick Quality: Up to `25 pts` (Macro 24h S/R bounce = 25 pts, Tactical 6h = 20 pts).
    - Taker Order Flow / Real-Time CVD Aggression: Up to `20 pts`.
    - Order Book Imbalance (Top 20 Depth): Up to `15 pts`.
    - Whale Top Trader Position Ratio: Up to `10 pts`.
    - Volume Participation vs SMA 20: Up to `10 pts`.
    - Higher Timeframe 15m Trend Confluence: Up to `10 pts`.
    - SumoPod AI Macro Sentiment Confluence: Up to `10 pts`.
  * Minimum Confluence Score Threshold: `70 pts` (`minScore: 70`).
  * Hard Safety Veto Decoupling: Non-negotiable safety conditions unconditionally veto execution regardless of score (Active Position running, Risk Kill Switch / Daily Loss locked, Liquidation Cascade $\ge \$150k$ in 60s, Runaway ADX blowout $> 38$, or high-conviction AI Black Swan).
* **Leverage:** `50x` Cross/Isolated Margin (auto-configured on Binance via REST API on startup).
* **Position Sizing Matrix:**
  * Risk per trade: `1.0%` of total margin equity.
  * Stop Loss Distance Formula: `actualSlDist = max(1.0 * ATR, entryPrice * 0.20%)`.
  * Theoretical Size: `qty = (equity * 1.0%) / actualSlDist`.
  * **Margin Headroom Guard:** Size is strictly capped so usable margin does not exceed `70%` of `availableBalance`:
    `maxQty = (availableBalance * 0.70 * leverage) / price`. Clamped to `min(qty, maxQty)`.
  * Minimum Notional: `$10 USD`.
  * Step Size Precision: 3 decimal places (`0.001 BTC`), rounded down (`BigNumber.ROUND_DOWN`).
  * **Micro-Account Sizing Guard:** For small equity balances (e.g., $15 – $30 USDT) where theoretical 1.5% risk sizing computes below `0.001 BTC`, the engine automatically clamps to the exchange minimum lot size (`0.001 BTC`), provided the required margin (`0.001 * price / leverage` ≈ $1.67 USDT at 50x) remains safely within the 70% available margin headroom.
* **Anti-Noise & Fee-Resilient Target Setup (SL & TP):**
  * Stop Loss Floor: `0.20%` of entry price (or `1.0 * ATR`, whichever is larger). Approx $152 on BTC at $76k.
  * Take Profit Target: 1:2.0 Risk-Reward ratio = `0.40%` of entry price (or `2.0 * actualSlDist`). Approx $304 on BTC at $76k.
  * Mathematical Expectancy & Net Fee Accounting: Binance round-trip taker commissions are `0.10%` (0.05% entry + 0.05% exit). Gross win +0.40% yields net +0.30% (or +0.33% if TP is Maker). Gross loss -0.20% yields net -0.30%. Net Risk-Reward is `1:1.00` (Taker) or `1:1.10` (Maker TP), requiring an empirical win rate of `50.0%` to break even.
* **Trend Regime & Directional Alignment Engine (`trendRegime`):**
  * Evaluates multi-timeframe trend alignment combining 15m EMA 25, 5m EMA 50, and ADX 14 (`adxTrendThreshold: 20`).
  * Classifies real-time market regimes into `STRONG_BEARISH`, `STRONG_BULLISH`, `MILD_BEARISH`, `MILD_BULLISH`, and `SIDEWAYS_RANGE`.
  * **Strict Trend Alignment Enforcement (`strictTrendAlignment: true`):**
    * **Sideways / Range Regime (`DUAL_DIRECTION`):** Range-bound oscillation when ADX < 20 unconditionally enforces true sideways mode. Breakout and breakdown entries are strictly prohibited to prevent fakeout whipsaws, enabling classic two-way mean-reversion trading (Long at Support bounce, Short at Resistance rejection with rejection wick confirmation). Multi-timeframe counter-trend vetoes are relaxed during sideways ranges, permitting high-probability structural S/R tests.
    * **Bearish Regime (`SHORTS_ONLY`):** Active only in confirmed trending markets (ADX >= 20). Strictly prohibits suicidal counter-trend LONG entries at Support to prevent catching falling knives during heavy downtrends. Actively hunts for trend-aligned SHORTs via Resistance/EMA pullback retests or confirmed Support breakdown continuation (`keyLevelSetup.isBreakdown`, `breakdownSellTakerRatio: 0.85`, red candle confirmation).
    * **Bullish Regime (`LONGS_ONLY`):** Active only in confirmed trending markets (ADX >= 20). Strictly prohibits suicidal counter-trend SHORT entries at Resistance to prevent getting crushed by short squeezes during heavy rallies. Actively hunts for trend-aligned LONGs via Support/EMA pullback bounces or confirmed Resistance breakout continuation (`keyLevelSetup.isBreakout`, `breakoutBuyTakerRatio: 1.15`, green candle confirmation).
* **Trailing Stop & Break-Even Disablement (Preserving Positive Expectancy):**
  * `trailingStop.enabled: false` & `trailingStop.breakEven.enabled: false`.
  * **Empirical Rationale:** Active trailing stop and tight break-even (+0.50% profit moving SL to Entry + 0.10%) repeatedly choked winning trades prematurely at negligible net gains (+$1.7 to +$7.0, or negative after commissions) due to routine 5m BTC volatility wicks (0.20% - 0.40%), while losing trades suffered full Stop Losses (-$35 to -$45). Disabling premature trailing stop and break-even restores full breathing room, allowing winning trades to reach the planned 1:2 Take Profit (+1.50% ≈ +$60 to +$75) and establishing genuine positive expectancy.
* **Kill Switches & Position Bounds:**
  * **Single Position Enforcement:** Maximum of 1 active position allowed concurrently. If a position is active, incoming technical signals are bypassed immediately until the trade is completed.
  * **Time-Based Stale Position Exit (`maxHoldMinutes: 30`):** If an active position remains open for longer than 30 minutes (6 5m candles) without triggering Take Profit or Stop Loss, the engine initiates an automated market exit (`TIME_LIMIT_EXIT`). In 5m micro-scalping, prolonged sideways consolidation indicates momentum alpha decay, incurs recurring 8-hour funding rate fees, and blocks the single-position engine from capturing fresh trading opportunities. Stale exits do not trigger the post-loss penalty cooldown, allowing immediate scanning for high-momentum setups.
  * **Daily Loss Limit (Mode-Isolated):** Maximum daily loss capped at `5%` of actual account margin equity (dynamically tracked from Binance `totalMarginBalance` / `availableBalance`). Evaluated strictly against net realized daily PnL of the active trading mode (`SELECT pnl FROM trade_history WHERE timestamp >= startOfDayUtc AND mode = ?`). Resets at 00:00 UTC. Historical demo trades cannot trigger kill switches on real accounts and vice versa. Can be dynamically bypassed via `strategy.risk.dailyLossLimitEnabled: false` or `strategy.risk.disableInDemo: true` for uninterrupted development and demo testing.
  * **Consecutive Loss Pause (Mode-Isolated):** After 3 consecutive losing trades in the current trading mode (`SELECT pnl, timestamp FROM trade_history WHERE mode = ? ORDER BY timestamp DESC LIMIT 3`), trading pauses for 4 hours to prevent churn during adverse conditions. Can be dynamically bypassed via `strategy.risk.consecutiveLossPause.enabled: false` or `strategy.risk.disableInDemo: true` during strategy development.
  * **Exchange Reconciliation & State Recovery:** Periodic active position reconciliation against Binance REST API every `15 seconds` (`15000 ms`) with adaptive rate-limit cooldown backoff.
  * **Signed Position Quantity Synchronization:** Binance Futures REST API returns signed amounts (negative `pos.positionAmt` for SHORT positions) while SQLite `active_positions` stores positive magnitude `qty` alongside explicit `side` ('LONG' | 'SHORT'). The reconciliation logic evaluates sync state via `(exchangeQty.abs().isEqualTo(localQty.abs()) && exchangeSide === localSide)`, preventing false `[CRITICAL] Position Mismatch!` alarms and eliminating duplicate Stop Loss algo / Take Profit limit orders on exchange. Newly discovered external positions are inserted with normalized positive quantity, and duplicate order placement is strictly guarded (`wasDbEmpty || !dbPos.sl_id || !dbPos.tp_id`).
  * **Asynchronous Match Engine Settlement Guard:** During limit order execution (`executeTrade`), introduces a 400ms settlement window verifying fills via `Binance.getOrder(symbol, orderId)` and `getAccountInfo()` to guarantee immediate fill detection before fallback handling.
  * **Accurate Net Realized PnL & Commission Fee Deduction:** When positions are closed (via `closePosition`, `panicCloseAndHalt`, or external reconciliation), `calculateNetPnlAndCommission` queries `Binance.getUserTrades(symbol, limit, startTime)` to retrieve both the exact volume-weighted exit fill price (`actualExitPrice`) and the exact exchange-incurred commission fees across entry and exit fills. This eliminates price drift between client tick prices and exchange execution fills. If exchange API is unreachable, deterministic fallback computes round-trip taker fees (`(entryNotional + exitNotional) * 0.0004`). Recorded `trade_history.pnl` represents strictly Net Realized PnL (`grossPnl - commission`) and `trade_history.commission` records the fee in USDT, ensuring dashboard analytics and daily loss kill switches mirror actual account equity without fee distortion.

---

## 6. TECHNICAL INDICATORS & KEY LEVEL ENGINE (`services/indicators.js`)
Implement mathematical calculations using **ONLY `bignumber.js`** with 8 decimal places precision (`ROUND_HALF_UP`):
1. **EMA (Exponential Moving Average):** Seeded with SMA of the first `period` elements, then smoothed with multiplier `k = 2 / (period + 1)`. Period: 50.
2. **RSI (Relative Strength Index):** Wilder's smoothed average gain and loss over 14 periods. Returns 0 to 100.
3. **MACD (Moving Average Convergence Divergence):** Fast EMA (12), Slow EMA (26), Signal EMA (9), and Histogram = `MACD - Signal`.
4. **ATR (Average True Range):** True Range `TR = max(high - low, |high - prevClose|, |low - prevClose|)` smoothed with Wilder's technique over 14 periods.
5. **SMA (Simple Moving Average):** Rolling mean across `period` (used for volume baseline with period 20).
6. **ADX (Average Directional Index):** Wilder's directional movement index measuring trend strength over 14 periods. Returns 0 to 100.
7. **Candle Aggregator (`aggregateCandles`):** Groups 5m candles into 15m intervals to calculate higher-timeframe trend bias and Key Levels without extra network streams.
8. **Support & Resistance Extractor (`calculateSupportResistance`):** Identifies highest high (Resistance) and lowest low (Support) across tactical lookback (default: 24 15m candles = 6 hours) and macro lookback (default: 96 15m candles = 24 hours daily bounds). Returns both tactical and macro swing anchors.
9. **Key Level Setup Evaluator (`evaluateKeyLevelSetup`):** Calculates whether current candle is testing Support or Resistance across tactical or macro daily levels within zone tolerance ($\pm 0.35\%$), measures lower/upper wick ratios for pinbar absorption, and verifies directional bounce.
10. **Order Book Imbalance Calculator (`calculateOrderBookImbalance`):** Evaluates Level 2 Depth (top 20 bids and asks) to compute $OBI = \sum Q_{bids} / (\sum Q_{bids} + \sum Q_{asks})$, returning bid volume, ask volume, depth ratio, and level count.
* **Trade Signal Triggers (Key Level Sniper & Real-Time Microstructure Engine):**
  * **Key Level Setup Triggers:**
    * **LONG Setup (Buy at Support):**
      1. Price tests Tactical or 24h Macro Support Zone: `Low <= Support * 1.0035` AND `Close >= Support * 0.9965`. Testing Macro 24h Support earns maximum 25-point confluence weighting.
      2. Rejection Confirmation: Lower wick ratio $\ge 25\%$ of total range (hammer/pinbar) OR Bullish candle bounce (`Close > Open`).
      3. Taker Flow Guard: Real-time CVD / Taker Buy/Sell ratio not in severe capitulation (`Taker Ratio >= 0.60`).
      4. Macro News Confluence: SumoPod AI sentiment must NOT be `BEARISH` (cancels LONG if confidence $\ge 7$; reinforced if Bullish).
    * **SHORT Setup (Sell at Resistance):**
      1. Price tests Tactical or 24h Macro Resistance Zone: `High >= Resistance * 0.9965` AND `Close <= Resistance * 1.0035`.
      2. Rejection Confirmation: Upper wick ratio $\ge 25\%$ of total range (shooting star/pinbar) OR Bearish candle bounce (`Close < Open`).
      3. Taker Flow Guard: Real-time CVD / Taker Buy/Sell ratio not in severe parabolic panic buying (`Taker Ratio <= 1.65`).
      4. Macro News Confluence: SumoPod AI sentiment must NOT be `BULLISH` (cancels SHORT if confidence $\ge 7$; reinforced if Bearish).
    * **Mid-Range Neutral State:** When price floats between Support and Resistance zones, trade verdict remains `NO_SIGNAL_SCANNING`, eliminating mid-range scalping chop.
  * **Microstructure Filter 1 (Liquidation Cascade & Exhaustion Guard):** Subscribes to Binance WebSocket `@forceOrder`. Tracks rolling 60s and 5m liquidated USD volume. Rejects LONG if Long liquidations $\ge \$150k$ in 60s (falling knife guard); rejects SHORT if Short liquidations $\ge \$150k$ in 60s (squeeze guard). Confirms high-probability reversal when 5m liquidation burst $\ge \$250k$ drops to calm state ($< \$30k$ in 60s) at S/R.
  * **Microstructure Filter 2 (Order Book Imbalance Guard - OBI Top 20):** Evaluates `/fapi/v1/depth` top 20 levels. Rejects LONG if Bids $< 35\%$ of depth ($OBI < 0.35$); rejects SHORT if Bids $> 65\%$ of depth ($OBI > 0.65$) with anti-spoofing smoothing.
  * **Microstructure Filter 3 (Real-time Delta Open Interest - $\Delta OI$):** Computes rolling 5-minute $\Delta OI\%$. Classifies market into `BULLISH_EXPANSION` ($\Delta P > 0, \Delta OI \ge 0.15\%$), `SHORT_SQUEEZE` ($\Delta P > 0, \Delta OI \le -0.15\%$), `BEARISH_EXPANSION` ($\Delta P < 0, \Delta OI \ge 0.15\%$), `LONG_LIQUIDATION` ($\Delta P < 0, \Delta OI \le -0.15\%$), or `NEUTRAL_CONSOLIDATION`. Guards against fakeout expansions.
  * **Microstructure Filter 4 (Real-Time Sub-Second Cumulative Volume Delta - CVD):** Subscribes to Binance WebSocket `@aggTrade`. Tracks rolling market buy vs market sell volume per tick. Prioritizes real-time 5m CVD ratio over delayed 30s-polled REST taker ratio.
  * **Sniper Mode Filter 1 (ADX Regime & Trend Strength Filter):** For trend-following modes: `ADX(14) >= 22`. For S/R Key Level mode: Low ADX represents healthy range-bound oscillation; enforces anti-blowout ceiling `ADX(14) <= 38` (`maxRangeThreshold: 38`) to guard against runaway trend breakdown/breakout blowouts.
  * **Sniper Mode Filter 2 (RSI Exhaustion Guard):** `RSI(14) [35 - 65]`. Disallows LONG when RSI > 65; disallows SHORT when RSI < 35.
  * **Sniper Mode Filter 3 (Multi-Timeframe 15m Macro Confluence):** In `KEY_LEVEL_SNIPER` mode, testing 15m Support or Resistance establishes macro level confluence; counter-trend mean-reversion bounces (e.g., buying Support when 15m EMA is Bearish) are permitted with confirmed rejection wick/candle bounce, eliminating the circular paradox where price at Support is always below the 15m EMA. In trend-following mode, strict `BULLISH` for Long / `BEARISH` for Short is enforced.
  * **Gatekeeper Guard 1 (Volume Participation):** `Current Candle Volume >= 0.70 * SMA(20) Volume`. Ensures liquid market execution.
  * **Gatekeeper Guard 2 (Whale Top Trader Position Alignment):** Standard bounds `[0.85 - 1.80]`, with calibrated Key Level Resistance upper threshold `keyLevelMaxShortThreshold: 2.25` reflecting structural long bias of Binance BTC futures.
  * **Gatekeeper Guard 3 (Taker Buy/Sell Order Flow Ratio Alignment):** In Reality mode: `[1.35 - 0.65]`. In Key Level mode: limit order absorption requires `Taker Ratio >= 0.85` for LONG and `<= 1.15` for SHORT (`keyLevelMinLong: 0.85`, `keyLevelMaxShort: 1.15`), preventing chasing blown-out candles.
  * **Gatekeeper Guard 4 (AI Macro Sentiment Veto & Confluence):** Cancels opposing entries when AI confidence $\ge 7$. Emergency market exit triggered only on verified black-swan events (confidence $\ge 9$).
  * **Gatekeeper Guard 5 (Single Concurrent Position):** Strictly 1 active trade at any time.
  * **Gatekeeper Guard 6 (Post Stop-Loss Anti-Revenge Cooldown):** Enforces a mandatory 20-minute trading pause immediately following any Stop Loss execution.
  * **Gatekeeper Guard 7 (Dynamic Confluence Scoring Engine):** Calculates weighted confluence score across 7 market pillars (Key Level 25 pt, Taker Flow 20 pt, OBI 15 pt, Whale 10 pt, Volume 10 pt, MTF Trend 10 pt, AI Macro 10 pt). Unconditionally blocked by Hard Vetoes (falling knife, runaway ADX, active position, drawdown lock, AI black swan). Approves trade entry when score $\ge 70$ points.

---

## 7. MULTI-SOURCE RSS NEWS & ON-CHAIN WHALE INTELLIGENCE (`services/news.js`)
Free, resilient news aggregation without paywalled API keys:
* **Concurrent Sources (`Promise.allSettled` via `rss-parser`):**
  1. Google News RSS (Binance Announcements): `https://news.google.com/rss/search?q=binance+announcement+when:7d&hl=en-US&gl=US&ceid=US:en`
  2. Cointelegraph Binance: `https://cointelegraph.com/rss/tag/binance`
  3. Cointelegraph Whale Alerts: `https://cointelegraph.com/rss/tag/whale`
  4. Google News RSS (Whale Alerts & Large Transactions): `https://news.google.com/rss/search?q=bitcoin+whale+alert+OR+whale+wallet+when:7d&hl=en-US&gl=US&ceid=US:en`
  5. CoinDesk Outbound: `https://www.coindesk.com/arc/outboundfeeds/rss/`
  6. Decrypt Feed: `https://decrypt.co/feed`
  7. Cointelegraph Main: `https://cointelegraph.com/rss`
* **Deduplication & Noise Cleansing:**
  * Deduplication: Case-insensitive title hashing using JavaScript `Set`.
  * Spam / Promo Purge: Regex `spamKeywordsRegex` (`/\b(PRESALE|ICO|AIRDROP|REMITTIX|PEPETO|\d+X|MEMECOIN|MEME COIN|SPONSORED|GIVEAWAY|LOTTERY|CASINO|PRESALES|BUY NOW|BONUS|PROMO|REFERRAL|OPENPR|PRNEWSWIRE|GLOBENEWSWIRE|PRESS RELEASE)\b/i`) discards sponsored press releases, spam coin promotions, and syndication wire distributions before ingest.
  * Altcoin Noise Isolation: Regex `altcoinNoiseRegex` (`/\b(ETH|ETHEREUM|SOL|SOLANA|XRP|RIPPLE|DOGE|DOGECOIN|SHIB|SHIBA|PEPE|CARDANO|ADA|BNB|AVAX|SUNDOG|TRX|NEAR|SUI|APT)\b/i`) eliminates pure altcoin chatter unless explicitly anchored to Bitcoin/macro developments (`BTC`, `BITCOIN`, `SAYLOR`, `STRATEGY`, `FED`, `CPI`, `INFLATION`, `ETF`, `SEC`).
  * Speculative Opinion & Prediction Purge: Regex `opinionKeywordsRegex` (`/\b(ANALYST(?:S)?|PREDICTS?|PREDICTION(?:S)?|FORECAST(?:S)?|COULD\s+(?:HIT|REACH|DROP|SURGE)|WILL\s+(?:HIT|REACH|DROP|SURGE)|TARGETS?|PRICE\s+TARGET|BELIEVES?|EXPECTS?|SPECULATES?|OPINION|CASE\s+FOR)\b/i`) eliminates opinion commentaries, analyst price forecasts, and speculative clickbait from polluting macro sentiment.
  * News Freshness Guard (`isFresh`): Articles older than `strategy.ai.maxNewsAgeMinutes` (`45 minutes`) are classified as fully priced-in by the 5m market. Stale headlines are rejected and automatically decay sentiment back to clean `NEUTRAL` (confidence 0), preventing multi-hour lagging news from vetoing live order flow setups.
* **Keyword Classifications & Filtering:**
  * `macroKeywordsRegex`: `/\b(BTC|BITCOIN|FED|FOMC|POWELL|CPI|INFLATION|RATE|SEC|CFTC|DOJ|ETF|BLACKROCK|SAYLOR|STRATEGY|INFLOW|OUTFLOW|WHALE|HALVING|CRASH|RALLY|DUMP|PUMP|LIQUIDATION|LIQUIDITY|VOLATILITY)\b/i`
  * `haltKeywordsRegex`: `/\b(MAINTENANCE|OUTAGE|EXPLOIT(?:ED|S)?|HACK(?:ED|ING|S)?|(?:TRADING|MARKET|NETWORK|EXCHANGE)\s+HALTS?|HALTS?\s+(?:TRADING|WITHDRAWALS?|DEPOSITS?|NETWORK|OPERATIONS?)|(?:TRADING|WITHDRAWAL|DEPOSIT|NETWORK)\s+SUSPEND(?:ED|S)?|SUSPEND(?:ED|S)?\s+(?:TRADING|WITHDRAWALS?|DEPOSITS?|SERVICES?))\b/i`
  * `isHighImpactMacro(title, pubDate)`: Returns `true` only if title matches `macroKeywordsRegex`, is NOT spam (`!isSpam(title)`), is NOT isolated altcoin noise (`!isPureAltcoin(title)`), is NOT opinion commentary (`!isOpinion(title)`), and (if `pubDate` provided) satisfies the 45-minute freshness window (`isFresh(pubDate)`).
* **Emergency Halt Decoupled (`emergencyHaltEnabled: false`):** Automatic trading engine locking (`isTradingLocked = true`) from generic RSS news keywords is permanently disabled by default. This prevents false emergency halts caused by routine editorial reporting (such as quarterly audit reviews, retroactive security post-mortems, or isolated exchange maintenance notices). Trading state remains active (`isTradingLocked = false`), reserving system-level locks strictly for manual user panic triggers or unrecoverable fatal database exceptions.
* **Target Article Selection:** Trading engine queries `recentArticles.find(a => News.isHighImpactMacro(a.title, a.isoDate || a.pubDate))`. If no fresh high-impact macro headline is found within 45 minutes, system automatically resets sentiment to `NEUTRAL` (confidence 0, reason: "No fresh BTC/macro headline within 45m"), ensuring pure technical execution.

---

## 8. SUMOPOD AI GATEKEEPER INTEGRATION (`services/ai.js`)
* **Endpoint:** `POST https://ai.sumopod.com/v1/chat/completions` (OpenAI-compatible schema).
* **Authentication:** `Authorization: Bearer process.env.SUMOPOD_API_KEY`.
* **Model:** `process.env.AI_MODEL_NAME || "mimo-v2.6-flash"`.
* **Payload Structure:**
  ```json
  {
    "model": "mimo-v2.6-flash",
    "messages": [
      {
        "role": "system",
        "content": "You are a financial sentiment analyzer specialized in Bitcoin (BTC) and macroeconomic markets. Reply ONLY in JSON format: {\"sentiment\": \"BULLISH\" | \"BEARISH\" | \"NEUTRAL\", \"confidence\": 1-10, \"reason\": \"<string>\"}"
      },
      {
        "role": "user",
        "content": "Analyze the directional impact of this crypto/macro headline specifically on BITCOIN (BTC): \"<headline>\""
      }
    ],
    "response_format": { "type": "json_object" }
  }
  ```
* **Performance & Token Conservation (Deduplication):**
  * Compare `targetArticle.title` with `lastAnalyzedHeadline`. If identical, reuse `latestSentiment` without making a new network request to conserve API credits.
  * Request Timeout: `25,000 ms` (25 seconds).
* **Degraded Mode & Auto-Recovery:**
  * If SumoPod fails 3 consecutive times, enter Degraded Mode.
  * Wait for a 120-second cooldown period, then attempt auto-recovery on the next news cycle (`[AI_RETRY] Attempting auto-recovery from Degraded Mode...`).
* **AI Decision Filters & Execution Protections:**
  * **Pre-Trade Veto Guard (`minVetoConfidence: 7`, `requireConfluence: true`):** If Technical Signal is LONG and AI Sentiment is BEARISH with confidence $\ge 7$, cancel entry. If Technical Signal is SHORT and AI is BULLISH with confidence $\ge 7$, cancel entry. Confidence below 7 does not veto, filtering out mild journalistic bias.
  * **News Halt Decoupling (`emergencyHaltEnabled: false`):** Automatic emergency exit closures and trading halt locks triggered by news headlines are deactivated. Position risk is governed strictly by the 0.20% Hard Stop Loss and 0.40% Take Profit boundaries (1:2.0 RR), preventing position liquidation or premature bot halting from ordinary editorial headlines.

---

## 9. BINANCE FUTURES REST SERVICE (`services/binance.js` & `services/dns-resolver.js`)
* **DNS-over-HTTPS (DoH) Bypass & Edge Failover (`services/dns-resolver.js`):**
  * Built-in DoH resolver with HTTPS agent (`lookup` hook) querying Cloudflare (`https://1.1.1.1/dns-query`) and Google (`https://dns.google/resolve`) with a 10-minute memory TTL and round-robin IP distribution.
  * Completely bypasses transparent DNS poisoning and censorship imposed by regional ISPs (such as Biznet/IndiHome/Kominfo Trust Positif sinkhole `202.169.44.80`), ensuring direct, low-latency TLS connections to AWS CloudFront CDN endpoints for both REST API (`httpsAgent`) and WebSockets (`ws.agent`).
  * **Dynamic Edge Node Failover & Banned Proxy Isolation:**
    * Features `markBadIp(ip, durationMs)` and `hasHealthyIps(hostname)` methods with runtime blacklisting of degraded edge nodes.
    * Automatically detects CloudFront shared-proxy rate limit bans (`-1003: IP(...) banned until ...`). When a specific edge node IP triggers an upstream egress ban, that node is blacklisted for the duration of the ban and the request is marked transient (`isTransient: true`), triggering immediate failover to alternate healthy edge nodes without freezing the global trading engine.
* **Authentication:** HMAC-SHA256 request signing with secret key and synchronized server timestamp.
* **Time Synchronization:**
  * Fetch Binance server time from `GET /fapi/v1/time` on boot and calculate `timeOffset`.
  * On API error code `-1021` (Timestamp out of sync), automatically re-sync time and retry.
* **Order Execution Types:**
  * **Entry:** Aggressive LIMIT orders with `timeInForce: 'IOC'` (Immediate-Or-Cancel) at best bid/ask +/- 0.10% slippage headroom.
  * **Stop Loss on Exchange:** Placed via Conditional Algo Order: `POST /fapi/v1/algoOrder` with `{ algoType: 'CONDITIONAL', type: 'STOP_MARKET', triggerPrice: stopPrice, quantity: qty, reduceOnly: 'true' }`.
  * **Take Profit on Exchange:** Placed via Limit Order: `POST /fapi/v1/order` with `{ type: 'LIMIT', price: tpPrice, quantity: qty, reduceOnly: 'true', timeInForce: 'GTC' }` (prioritizes passive Maker fill at 0.020% fee with 800ms grace period before fallback market exit).
  * **Emergency / Close:** `POST /fapi/v1/order` with `type: 'MARKET', reduceOnly: 'true'`.

---

## 10. TELEGRAM NOTIFICATIONS (`services/notifier.js`)
The bot provides optional, non-blocking real-time alert notifications via **Telegram Bot API**. If credentials are not specified in `.env`, the service silently bypasses without disrupting trading operations.

* **Configuration:**
  * Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
* **Event Handlers:**
  1. `sendTradeOpen({ symbol, side, qty, price, slPrice, tpPrice, leverage })`: Dispatches an alert with side emoji (🟢 LONG / 🔴 SHORT), formatted prices, Stop Loss (-0.30%), and Take Profit (+0.50%).
  2. `sendTradeClose({ symbol, side, qty, exitPrice, pnl, reason })`: Dispatches real-time realized PnL with win/loss status (💰 WIN / 🛑 LOSS) and closing trigger reason.
  3. `sendTrailingStop({ symbol, side, newSlPrice, currentPrice })`: Dispatches profit protection updates when the trailing stop tightens. Throttled to a minimum 30-second interval (`lastTrailingNotifyTime`) to prevent notification flooding on active market movements.
  4. `sendAlert(title, message, level)`: Dispatches emergency trading halt alerts, panic triggers, and system unlock events.
* **Timestamp Localization:** All message timestamps are formatted to Western Indonesia Time (`WIB` / `Asia/Jakarta` timezone) via `formatWIB()` (`DD MMM YYYY HH:mm:ss WIB`) for immediate human readability.
* **Network Resilience & Failure Isolation:**
  * Uses `dnsResolver.getAgent()` to route `api.telegram.org`, `ai.sumopod.com`, and Binance REST/WebSocket connections strictly over IPv4 (`family: 4`) via Cloudflare (`1.1.1.1`) and Google (`8.8.8.8`) DNS-over-HTTPS. This completely avoids Docker container IPv6 routing issues (`connect ENETUNREACH 2001:...`) and bypasses local ISP DNS poisoning/EAI_AGAIN lookup errors.
  * **Stale-On-Error DNS Cache & Domain Pre-Warming:** Features startup pre-warming and 3-minute background cache refresh for critical hostnames (`stream.binancefuture.com`, `testnet.binancefuture.com`, `fapi.binance.com`, `fstream.binance.com`, `ai.sumopod.com`, `api.telegram.org`). If DoH queries encounter transient network timeouts, the resolver falls back to `lastKnownIps` (stale-while-revalidate), guaranteeing zero downtime from DNS resolution hiccups.
  * Employs automatic retry mechanism with up to 3 attempts and exponential backoff delay (1s, 2s) to withstand transient network spikes or packet drops.
  * Configured with an 8-second request timeout and isolated within `try ... catch` blocks so notification delivery failures never block Binance trading execution or compromise engine stability.

---

## 11. ERROR HANDLING, TRY-CATCH HIERARCHY & IMMORTALITY MATRIX

Implement rigorous, hierarchical error handling across all subsystems. Avoid generic empty `catch (e)` blocks.

### A. Error Classification Matrix
| Error Type | Examples | Classification | System Action | Retry Policy |
| :--- | :--- | :--- | :--- | :--- |
| **Transient Network** | `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND` | Transient (`isTransient: true`) | Log warning, wait exponential delay | Exponential Backoff (1s, 2s, 4s, 8s, max 32s, max 5 retries) |
| **Binance Rate Limit** | HTTP 429 / API code `-1003` (`TOO_MANY_REQUESTS` / weight exceeded) | Dynamic (`isTransient: true` on edge IP ban with healthy nodes; `false` on global account ban) | Blacklist bad edge node in DnsResolver, failover to alternate healthy edge IP | Exponential Backoff (1s, 2s, 4s, 8s, max 16s, max 5 retries); global cooldown only if all nodes exhausted |
| **Binance Time Sync** | API code `-1021` (Timestamp out of sync) | Transient (`isTransient: true`) | Re-sync server time via `syncTime()`, re-sign | Retry with new timestamp |
| **Binance Invalid Signature** | API code `-1022` (`INVALID_SIGNATURE`) | Non-Transient (`isTransient: false`) | Log fatal auth failure, verify API credentials | No retry. Configuration check required. |
| **ReduceOnly Rejected** | `ReduceOnly Order is rejected` on close | Expected Exchange Race Condition | Position already closed by exchange conditional SL/TP; cancel lingering orders, log audit to `trade_history`, clear DB `active_positions`, and unlock | No retry. Immediate DB cleanup. |
| **Business Logic** | Insufficient margin, order min lot size, invalid symbol | Non-Transient (`isTransient: false`) | Log error, cancel current action, notify | No retry. Skip trade cycle. |
| **AI LLM Outage** | 3 consecutive SumoPod timeouts or 500 errors | Degraded (`degradedMode: true`) | Enter Degraded Mode, skip AI veto, allow pure technicals | 120s cooldown, auto-recovery retry |
| **News Feed Outage** | RSS endpoint 404 or connection reset | Handled via `Promise.allSettled` | Keep working feeds, deduplicate remaining | Fallback to remaining feeds |
| **SQLite DB Error** | Constraint violation, disk I/O error | Fatal Local State | Trigger transaction rollback, enter `isTradingLocked` | Exit process cleanly for Docker to restart |

### B. Custom Binance Error Class & Axios Interceptors
```javascript
class BinanceError extends Error {
  constructor(message, code, isTransient) {
    super(message);
    this.code = code;
    this.isTransient = isTransient;
  }
}

// Axios Interceptor
client.interceptors.response.use(
  res => res,
  err => {
    if (!err.response) return Promise.reject(new BinanceError('Network Error', 'ECONNRESET', true));
    const status = err.response.status;
    const code = err.response.data?.code;
    const msg = err.response.data?.msg;

    if (status === 429 || code === -1003) {
      return Promise.reject(new BinanceError(`Rate Limit (${code || status}: ${msg || 'Too Many Requests'})`, code ? String(code) : '429', true));
    }
    if (code === -1021) {
      return Promise.reject(new BinanceError(`Timestamp Out of Sync (-1021: ${msg || 'Invalid Timestamp'})`, '-1021', true));
    }
    if (code === -1022) {
      return Promise.reject(new BinanceError(`Invalid Signature (-1022: ${msg || 'Signature not valid'})`, '-1022', false));
    }
    return Promise.reject(new BinanceError(msg || 'API Error', code, false));
  }
);
```

### C. Exponential Backoff Retry Runner (`handleApiError`)
```javascript
async handleApiError(operation, maxRetries = 5, contextName = 'API') {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BinanceError && error.isTransient) {
        retries++;
        const delay = Math.min(Math.pow(2, retries) * 1000, 16000); // Capped at 16s
        console.warn(`[TRANSIENT_RETRY] ${contextName} encountered ${error.message}. Retrying in ${delay}ms (Attempt ${retries}/${maxRetries})`);
        if (error.code === '-1021') await this.syncTime();
        await new Promise(res => setTimeout(res, delay));
      } else {
        console.error(`Non-transient API Error for ${contextName}: ${error.message}`);
        throw error;
      }
    }
  }
  throw new Error(`Max retries reached for ${contextName}`);
}
```
* **Routine Background Polling Protection:** Periodic non-critical requests (`getTickerPrice`, `getTopTraderRatio`, `getTakerRatio`, `getOpenInterest`) are constrained to `maxRetries = 2` to prevent long 62-second retry hangs during transient network degradation, while critical trading operations (`placeOrder`, `closePosition`, `setStopLoss`, `setTakeProfit`) utilize `maxRetries = 5`.

---

## 12. WEBSOCKET ENGINE, AUTO-RECONNECT & REAL-TIME PIPELINES

The system maintains two independent real-time data pipelines:

### A. Binance Futures WebSocket (`services/binance.js`)
* **Endpoint:** `wss://stream.binancefuture.com/ws/btcusdt@kline_5m` (Testnet) or `wss://fstream.binance.com/market/ws/btcusdt@kline_5m` (Mainnet dedicated Market stream endpoint).
* **Lifecycle & Auto-Reconnect Mechanics:**
  1. `ws.on('open')`: Log connection and clear local buffer (`this.wsBuffer = []`) to prevent data gaps or candle duplicates upon reconnect.
  2. `ws.on('message')`: Parse incoming payload. Mark socket as alive, update `lastWsMessageTime = Date.now()`. If event is `kline`:
     * Push to local buffer (capped at 50 to prevent unbounded memory growth).
     * Forward payload to `onCandleMsg(payload)`.
  3. `Heartbeat & Inactivity Watchdog`:
     * Periodic watchdog timer runs every 10 seconds.
     * **Inactivity Check:** If `Date.now() - this.lastWsMessageTime > 15000` (no messages for >15s on an active kline stream), automatically terminates zombie TCP connection and re-triggers reconnection.
     * **Ping/Pong Heartbeat:** Sends `ws.ping()` every 10s. If no pong is received before the next interval, connection is terminated.
     * Responds to server ping frames (`ws.on('ping')`) with immediate `ws.pong()`.
  4. `ws.on('close')`: Log warning and schedule clean debounced reconnection:
     ```javascript
     this.ws.on('close', (code, reason) => {
       console.warn(`WebSocket closed [${code}]: ${reason || 'Connection lost'}. Reconnecting in 2s...`);
       this.scheduleWsReconnect(symbol, onCandleMsg);
     });
     ```
  5. `ws.on('error')`: Log error and call `this.ws.terminate()` to immediately force clean socket termination and trigger scheduled reconnection.
* **REST Price Fallback Watchdog & Concurrency Locks (`src/trading-core.js`):**
  * Periodically runs `ensureLivePrice()` every 5 seconds and inside `reconcilePositions()`.
  * If `Date.now() - this.lastPriceTime > 5000` (e.g. During transient WebSocket reconnection or network flap), queries REST endpoint `/fapi/v1/ticker/price` via `Binance.getTickerPrice(symbol)` to guarantee `lastPrice` is never stale or frozen.
  * **Asynchronous Concurrency Locks:** The trading engine implements dedicated in-flight locks (`this.isEnsuringPrice`, `this.isFetchingWhale`, `this.isMonitoringNews`, `this.isReconciling`) across all periodic loops. This prevents thundering-herd pileups and cascading concurrent retry loops when internet connectivity is temporarily interrupted.
  * **Graceful Periodic Reconciliation:** Periodic background reconciliation (`reconcilePositions()`) catches network hiccups and defers to the next cycle (`[RECONCILE_NOTE] Periodic reconciliation deferred`) without emitting false alarm critical errors.
* **Candle Tick vs. Candle Close Logic:**
  * **On every tick (`k.c` price update):** Invoke `this.setLivePrice(Number(k.c), 'BINANCE_WS')`, update `this.lastPriceTime = Date.now()`, emit throttled `tick` event for SSE streaming, and invoke `evaluatePositionRisk(this.lastPrice)` for real-time unrealized PnL calculation and dynamic trailing stop monitoring.
  * **On candle close (`k.x === true`):** Insert candle into SQLite synchronously (`INSERT OR REPLACE INTO historical_candles`) and invoke `evaluateTradeLogic()`.

### B. Dashboard Server-Sent Events (SSE) Pipeline (`src/dashboard-server.js`)
* **Endpoint:** `GET /api/stream?token=<session_token>`.
* **Streaming Headers:**
  ```javascript
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  ```
* **Event Broadcasting Protocol:**
  1. `INIT_STATE`: Emitted once upon client connection, containing active positions, fills, history, bot state, and initial 300 logs.
  2. `PRICE_TICK`: Emitted in sub-second real-time whenever `TradingCore` receives a price update (`type: 'PRICE_TICK'`, data: `{ symbol, price, source, time }`). Bypasses the 1.5s SQLite snapshot delay to deliver instant ticker updates.
  3. `LOG`: Broadcast immediately whenever `console.log`, `console.warn`, or `console.error` is invoked (via `logger.on('log', onNewLog)`).
  4. `STATE_UPDATE`: Periodic heartbeat pushed every 1,500 ms containing updated positions, last price, indicators, and uptime.
  5. Cleanup on disconnect: Clear interval, remove logger listener, and detach `tick` EventEmitter listener on `req.on('close')`.
* **Dual-Feed Frontend Architecture (`dashboard.js`):**
  * Primary / Sub-Second Feed: Client initializes direct browser WebSocket to Binance Futures (`initDirectBinanceWs`).
  * Fallback / ISP Resilience Feed: If direct browser WebSocket is blocked by ISP DNS poisoning (e.g. Internet Positif), it fails silently and the client seamlessly relies on the backend SSE `PRICE_TICK` stream (which bypasses DNS poisoning via backend DoH resolver).
  * Auto-Reconnect: Listens to `eventSource.onerror` and reconnects with exponential backoff (`scheduleReconnect(2000)`). Re-syncs immediately on tab visibility change (`visibilitychange`).

### C. Institutional Cockpit UI & Workstation Architecture (`public/style.css` & `public/dashboard.js`)
* **Balanced Dual-Column Command Workspace (`.dashboard-main-grid`):**
  * Configured with an equal 50% / 50% split (`grid-template-columns: 1fr 1fr; gap: 14px;`) across standard and high-resolution displays.
  * Expands the right-hand column (AI Macro Intelligence & Live Crypto News Feed) by ~200px, eliminating cramped layouts and ensuring comfortable horizontal breathing room for live wire headlines, analytical quotes, and source tags.
* **Compact High-Density Overview HUD (`.metrics-grid` & `.metric-card`):**
  * Tightened card padding (`8px 12px;`), compact value scale (`1.18rem`, down from `1.65rem`), and streamlined margins (`4px`).
  * Prevents the 4 overview cards (Market Price, Execution State, AI Sentiment, Performance & Exposure) from dominating the vertical viewport, reducing overall HUD height from ~210px to ~115px.
* **Symmetric 6x2 Market Reality Matrix (`.indicator-chips-grid` & `.ind-chip`):**
  * Exactly 12 indicator cards structured in a responsive 6-column grid (`grid-template-columns: repeat(6, 1fr); gap: 10px;` with fallback to 4 columns on `<1400px`):
    * **Row 1 (Primary Triggers & Core Reality):** 15M S/R Levels, Taker Order Flow, Candle Direction & Absorption, Vol/SMA 20, Whale Top Trader L/S, Open Interest.
    * **Row 2 (Sniper Filters & Market Context):** AI Macro Sentiment, ADX Trend Strength (14), 15M EMA Confluence, RSI Exhaustion Guard (14), Liquidation Cascade (60s), Order Book Depth Imbalance (OBI Top 20).
  * Guarantees 100% geometric symmetry (no stranded orphaned single cards in row 2) and increases card min-height to `105px` with multi-line description wrapping.
* **High-Contrast Typography Standard (Anti-Faded Grey Hierarchy):**
  * Built on pure `Inter` (UI elements, labels, headlines) and `JetBrains Mono` (tabular numbers, badges, code).
  * Design tokens engineered for dark obsidian (`#07090e`, `#0c101a`) backgrounds to guarantee WCAG-compliant readability without washed-out low-contrast text:
    * `--text-primary: #ffffff` (Hero metrics, primary values, active states).
    * `--text-secondary: #e2e8f0` (Secondary values, descriptions, quotes).
    * `--text-muted: #cbd5e1` (Table headers, chip names, parameters, filters).
    * `--text-dim: #94a3b8` (Auxiliary labels, timestamps, border accents, log times).
* **Standardized Performance & Exposure Cockpit Component:**
  * Replaces unstyled raw text strings with a structured micro-component:
    * `.perf-pnl-title`: Uppercase semi-bold slate header (`Net Realized PnL`).
    * `.perf-context-pill`: JetBrains Mono badge (`[All-Time • DEMO]`) with subtle border and crisp white contrast.

---

## 13. COMPLETE END-TO-END SYSTEM LIFECYCLE & TRADING FLOW

```
[SYSTEM BOOT]
     │
     ├── 1. Logger Interceptor initialized (console -> EventEmitter buffer)
     ├── 2. Binance Time Synced (serverTime - Date.now() -> timeOffset)
     ├── 3. Leverage configured on Binance (50x)
     ├── 4. Initial Position Reconciliation against Binance REST API
     ├── 5. Bootstrap 500 Historical Candles from Binance REST -> SQLite (WAL mode)
     ├── 6. Binance WebSocket Connected (btcusdt@kline_5m)
     ├── 7. Start 15s Periodic Position Reconciliation Loop (with Adaptive Rate-Limit Backoff)
     ├── 8. Start 5m News Ingestion & SumoPod AI Analysis Loop
     └── 9. Dashboard Express Server & SSE Stream Launched on Port 28080
            │
            ▼
[EVENT-DRIVEN REAL-TIME LOOPS]
     │
     ├── A. ON WS TICK (Every Price Change):
     │      ├── Update lastPrice & flash UI indicator
     │      └── IF Position Active:
     │           ├── Calculate Unrealized PnL -> Update SQLite active_positions
     │           ├── Trailing Stop Check (Profit > 1.5 ATR? Tighten SL in SQLite & Binance Algo)
     │           │     └── Dispatch Notifier.sendTrailingStop()
     │           ├── Check TP / SL Trigger -> Market Close position if hit
     │           └── Check AI Emergency Exit (Confidence >= 8 contradict position? Close now)
     │
     ├── B. ON WS CANDLE CLOSE (k.x === true, Every 5 Minutes):
     │      ├── Save candle to SQLite historical_candles
     │      ├── Calculate EMA50, RSI14, MACD, ATR14 using bignumber.js
     │      ├── Guard 1: Active position already exists? SKIP ENTRY.
     │      ├── Guard 2: Kill switches active (Daily Loss >= 5% OR 3 consecutive losses)? SKIP.
     │      ├── Check Signal:
     │      │     LONG: Close > EMA50 && MACD Hist > 0 && RSI < 65
     │      │     SHORT: Close < EMA50 && MACD Hist < 0 && RSI > 35
     │      ├── Guard 3: AI Veto (AI Sentiment contradicts signal with confidence > 5)? SKIP.
     │      └── Execute Order:
     │           ├── Calculate SL distance = max(1.0*ATR, price * 0.20%)
     │           ├── Calculate Position Size & Clamp to Safe Margin Capacity (70% available margin)
     │           ├── Send Aggressive Limit IOC Order to Binance (+/- 0.05% slippage headroom)
     │           └── IF Filled:
     │                ├── Synchronous SQLite Transaction (INSERT active_positions + position_fills)
     │                ├── Sync to Redis cache (pos:BTCUSDT)
     │                ├── Place Conditional Algo Stop Loss on Binance (/fapi/v1/algoOrder)
     │                ├── Place GTC Limit Take Profit on Binance (/fapi/v1/order)
     │                └── Dispatch Notifier.sendTradeOpen() to Telegram
     │
     └── C. ON NEWS LOOP (Every 5 Minutes):
            ├── Fetch 5 RSS feeds concurrently via rss-parser (Promise.allSettled)
            ├── Deduplicate titles with Set & Categorize Source
            ├── Check Emergency Halt Keywords -> Lock bot & dispatch Notifier.sendAlert() if critical
            ├── Deduplication Check: If headline matches lastAnalyzedHeadline, reuse sentiment
            └── Call SumoPod AI (MiMo LLM, model mimo-v2.6-flash) for sentiment analysis (BULLISH/BEARISH/NEUTRAL, conf 1-10)
```

---

## 14. PRO TRADING TERMINAL UI & VISUAL SPECIFICATION (`public/`)

The dashboard is a **state-of-the-art, dark cyber-glassmorphism financial terminal** engineered with Vanilla HTML5, CSS3, and JavaScript (zero heavy frameworks, zero external CDN dependencies like React/Tailwind).

### A. Visual Layout Wireframe
```
+---------------------------------------------------------------------------------------------------------+
| [BRAND ICON] RESILIENT BOT CORE • PRO TERMINAL | BTCUSDT•5M | LEV 50x | RISK 1.0% | SL 0.20%•TP 0.40%  |
|                                       [DEMO / REAL] [MODAL: $3,066.32] [LIVE SSE] [🔓 UNLOCK] [🚨 PANIC]|
+---------------------------------------------------------------------------------------------------------+
| [METRIC 1: LIVE PRICE]      | [METRIC 2: EXECUTION]     | [METRIC 3: HERO AI]       | [METRIC 4: PERF & EXPOSURE]|
| $83,421.5 ▲ (flash green)   | RUNNING (ACTIVE)          | BULLISH (Conf: 8/10)      | [DEMO] [REAL] (Mode Pills) |
| Last candle: $83,420.0      | Uptime: 2h 15m            | SumoPod MiMo LLM          | [ALL][24h][3d][7d][14d][30d|
| Binance Futures             | Auto Reconcile: 15s       | Veto Guard: Active        | Realized PnL: +$142.50     |
|                             |                           |                           | Win Rate: 68.4% (13W / 6L) |
|                             |                           |                           | Modal: $3,066 | Avail: $3,066|
+---------------------------------------------------------------------------------------------------------+
| KEY LEVEL SNIPER & MARKET TRIGGERS STRIP (V5) --- [Signal: NEUTRAL] [Scanning Market...] --- [LEGEND]    |
| [15M S/R LEVELS]   | [TAKER FLOW]      | [CANDLE & ABSORB] | [VOL / SMA (20)]  | [WHALE POS] | [OPEN INT]    |
| [AI SENTIMENT]     | [ADX TREND (14)]  | [15M CONFLUENCE]  | [RSI EXHAUSTION]  | [LIQUIDATE] | [DEPTH (OBI)] |
+-------------------------------------------------------------+-------------------------------------------+
| LEFT COLUMN (1fr): EXECUTION & POSITION COCKPIT             | RIGHT COLUMN (1fr): AI MACRO & NEWS CENTER|
|                                                             |                                           |
| 1. ACTIVE POSITION VISUAL TRACKER CARD                      | 1. AI MACRO REASONING & DECISION FILTER   |
|    - Idle: Radar sweep pulse animation                      |    - Active Headline Evaluated by LLM     |
|    - Active Trade:                                          |    - Model: SumoPod mimo-v2.6-flash       |
|      [LONG] BTCUSDT  0.177 BTC                              |    - Veto Status: Active (Neutral/Armed)  |
|      PnL: +$74.20 (ROI: +21.5% at 50x)                      |    - Rationale Quote: Macro reasoning...  |
|      [SL $82,990]----[ENTRY]--●--[TP $84,240]               |                                           |
|      (Interactive range bar + live pin + BE guard)          | 2. LIVE MULTI-PLATFORM NEWS FEED CARD     |
|                                                             |    - Feed Filter Tabs:                    |
| 2. TRADE HISTORY & ORDER FILLS CARD                         |      [All Feeds] [⭐ AI Evaluated]         |
|    - Tabs: [Closed Trades (PnL)] [Order Fills (DB)]         |      [🔥 BTC & Macro] [🐋 Whale Radar]    |
|    - Real-time PnL & Order ID tables with Fee audit         |      [🏛️ Binance News]                     |
|    - Height-balanced to match right column (~520px)         |    - Instant Search input filter          |
|                                                             |    - News cards with relative time tags   |
+-------------------------------------------------------------+-------------------------------------------+
| FULL-WIDTH PRO LIVE BOT CONSOLE LOGS TERMINAL (MAXIMUM SPACE & EXPANDABLE VIEWPORT)                     |
| [PRO TERMINAL] [● LIVE SSE] [0 Blocked] | Tools: [Search 220px][Scroll:ON][Height:520px][⛶ Fullscreen]   |
| Tabs: [All Logs (142)] [🚫 Filter Blocked (6)] [🎯 Signals & Scans (48)] [⚡ Orders & Positions (12)] [🤖 AI] |
| Terminal Viewport (520px / 720px / Fullscreen Overlay, font 0.82rem mono, 1000-log buffer capacity):     |
|   [15:28:10] [SYS]   [INFO]    Connecting to bot SSE stream...                                           |
|   [15:28:12] [TRADE] [BLOCKED] [FILTER_BLOCKED] Long signal blocked: Whale ratio 0.82 < 0.85             |
|   [15:28:15] [TRADE] [TRADE]   [ORDER_FLOW_REALITY] Market order LONG 0.177 BTC submitted                |
| Status Bar: [● SSE Active | Buffer: 142/1000] | [Category: All Logs] | [Displaying: 142 logs]             |
+---------------------------------------------------------------------------------------------------------+
```

### B. Design Tokens & Visual Hierarchy (`style.css`)
* **Color Palette & Apex Cockpit Institutional System (Vibrant, Luxurious, and Disciplined):**
  * Background Root: `#07090e` base with multi-stop obsidian depth and an atmospheric electric cyan top ambient radial glow (`radial-gradient(ellipse 90% 50% at 50% -15%, rgba(14, 165, 233, 0.16) 0%, transparent 65%)` and `linear-gradient(180deg, #090d18 0%, #05070c 100%)`).
  * Surface Glassmorphic Panels: `#0c101a` to `#161e30` gradient with precision top inner rim highlight (`box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 8px 24px -4px rgba(0, 0, 0, 0.6)`), border `1px solid rgba(255, 255, 255, 0.08)`, and smooth cyan glow elevation on hover.
  * Strict Semantic Financial Polarity (Zero Rainbow Confusion, Pure Functional Glanceability):
    * Bullish / Profit / Passed / Long: Luminous Mint Emerald `#10b981` (`rgba(16, 185, 129, 0.12)` subtle tint, `rgba(16, 185, 129, 0.35)` border).
    * Bearish / Loss / Blocked / Short / Panic: Luminous Coral Rose `#f43f5e` (`rgba(244, 63, 94, 0.12)` subtle tint, `rgba(244, 63, 94, 0.35)` border).
    * Cockpit Signature / Scanner / Active Brand: Electric Cyan `#38bdf8` (`rgba(56, 189, 248, 0.12)` subtle tint, `rgba(56, 189, 248, 0.35)` border).
    * Warning / Scanning / Demo Mode: Warm Amber `#f59e0b` (`rgba(245, 158, 11, 0.12)` subtle tint, `rgba(245, 158, 11, 0.35)` border).
    * Neutral / Normal / Balanced: Silvery Slate `#94a3b8` / `#cbd5e1` and crisp white (`#ffffff`).
  * Semantic Microstructure Indicators: Primary numerical values across the Top HUD metric cards, Tactical Strategy Quick-Bar, Indicator Microstructure Chips, and Gatekeeper Matrix dynamically inherit semantic color cues (e.g. Bullish Green vs Bearish Red on Candle, Trending Green on ADX, Buy Zone Support Green vs Sell Zone Resist Red on Key Levels, Bid Wall Green vs Ask Wall Red on OBI) with clean white fallback for neutral states.
  * AI Macro Sentiment Card: Features a dynamic gradient confidence bar (`linear-gradient(90deg, #10b981, #38bdf8)` for BULLISH, `linear-gradient(90deg, #f43f5e, #fb923c)` for BEARISH, `linear-gradient(90deg, #64748b, #94a3b8)` for NEUTRAL) and an executive intelligence briefing quote box with electric cyan accent border.
  * Anti-Jitter Typography: `Inter` (300, 400, 500, 600, 700, 800) for razor-sharp labels, headings, and news feed telemetry; `JetBrains Mono` with strictly enforced `font-variant-numeric: tabular-nums lining-nums;` across all price tickers, metric values, table cells, and indicator chips to eliminate micro-shifting width jitter.
* **Micro-Animations & Visual Effects:**
  * Clean, quiet status dots with soft breathing pulse animations.
  * Sub-second price tick flashes: `@keyframes flashGreen` and `@keyframes flashRed` smoothly highlighting price changes.
  * 52px Electric Cyan radar scanner animation with pulsating core (`box-shadow: 0 0 15px rgba(56, 189, 248, 0.15)`) active during idle scanning phases.
* **Visual Range Tracker (Active Position):**
  * Unified Range Calculation: 0% is strictly Stop Loss (left/rose) and 100% is strictly Take Profit (right/emerald) for both LONG and SHORT positions.
  * In-Place DOM Updates: Client updates `pin.style.left` and text nodes directly without re-rendering container innerHTML, preserving active CSS transition easing.
  * Dynamic range track with multi-stop linear gradient (Rose on left, Emerald on right), glowing white entry marker, electric cyan current price pin with 12px drop glow (`box-shadow: 0 0 12px rgba(56, 189, 248, 0.85)`), and Break-Even lock tag (`(🛡️ BE ACTIVE)`).

### C. Client-Side Mechanics (`dashboard.js`)
* **English Industry-Standard User Interface:** All dashboard controls, chips, status pills, table headers, Gatekeeper verdicts, category tabs, and modal dialogues are standardized in professional financial English.
* **Trading Mode Switcher & Two-Factor Step-Up Modal:** Header features an interactive mode badge (`DEMO (TESTNET)` in amber vs `REAL (LIVE)` in red). Clicking the badge opens a glassmorphic confirmation modal (`#switchModeModal`) requiring both a user acknowledgment checkbox and authentication password verification (`DASHBOARD_PASSWORD`) before dispatching `POST /api/switch-mode` with `{ targetMode, password }`. The backend validates the password against `.env` via `verifyDashboardPassword()`, writes the updated `BINANCE_TESTNET` value to `.env`, logs the state mutation to SQLite `system_state`, dispatches a Telegram security notification, and restarts the engine cleanly.
* **High-Impact Emergency Action Modals (Panic Halt & Unlock):** Replacing legacy browser prompts, triggering Panic Close (`/api/panic`) or Unlock Trading (`/api/unlock`) activates a dedicated glassmorphic security modal (`#securityActionModal`) demanding confirmation and `DASHBOARD_PASSWORD` authentication. The backend rejects unauthenticated payloads with `401 Unauthorized`, safeguarding live capital against accidental clicks or unauthorized dashboard access.
* **Persistent Session Token & Auto-Reauthentication:** Server persists `apiToken` in SQLite `system_state` across restarts (or env `INTERNAL_API_TOKEN`). Client fetches `/api/session-token` on load and automatically re-fetches and retries any request on `403` via `authenticatedFetch()`. Both `/api/session-token` and static dashboard assets (`dashboard.js`, `index.html`) enforce `Cache-Control: no-store, no-cache, must-revalidate` alongside query string version cache-busting (`?v=...`) to eliminate stale script execution.
* **Persistent SSE Connection & ReadyState Lifecycle:** Reconnects automatically on network drops with exponential backoff and refreshes instantly when the browser tab becomes visible via `document.addEventListener('visibilitychange')`. Client initialization evaluates `document.readyState` directly, ensuring immediate SSE streaming and token bootstrap even when the script executes after the initial `DOMContentLoaded` event has fired.
* **Database-Level Data Separation & Multi-Environment Analytics (`Metric 4`):**
  * Full-Stack Isolation: DEMO and REAL trading datasets are partitioned from SQLite schema primitives (`active_positions (symbol, mode)`, `position_fills`, `trade_history`, `system_logs`) up through Redis keys (`pos:BTCUSDT:DEMO` / `pos:BTCUSDT:REAL`), Express REST APIs (`?mode=DEMO|REAL`), and frontend UI tables.
  * Performance & Exposure Card: Features segmented mode toggle pills (`[DEMO]` vs `[REAL]`) and interactive timeframe filter buttons (`ALL`, `24H`, `3D`, `7D`, `14D`, `30D`). When the bot trading mode is switched in the header modal, the performance card, active positions, order fills, and closed trades table automatically align to the active mode (`lastKnownBotMode !== currentTradingMode`). Historical calculations (Realized PnL, Win Rate, Win/Loss count, Total Trades count, Open Exposure, and Floating PnL) strictly filter database records by `mode` and timestamp cutoffs.
  * Active Position Visual Card: Position rendering and open exposure sums strictly evaluate active positions matching the selected performance mode. If no position exists in the selected mode, an animated radar scanning state is displayed.
  * Order Fills & Closed Trades Tables: Both tables feature dedicated `Mode` badge columns (`[DEMO]` in amber vs `[REAL]` in emerald), ensuring complete visual clarity on order provenance.
* **Pre-Trade Open Position Gatekeeper Radar:** Displays an interactive real-time checklist and status breakdown for all 6 active Order Flow Reality entry rules (Taker Order Flow Imbalance, Candle Direction & Microstructure Absorption Guard, Volume Participation SMA 20, Whale Top Trader L/S Ratio, SumoPod AI Macro Veto, and Single Concurrent Position Guard). Non-active legacy filters (ADX, MTF 15m) are excluded from the radar view. Features live verdict badges (`ENTRY_READY`, `BLOCKED_BY_FILTER`, `IN_POSITION`, `NO_SIGNAL_SCANNING`), visual indicator status cards (`PASS` / `BLOCKED`), and dynamic reason pills highlighting exact criteria preventing trades. When an active position is closed (externally on Binance, via TP/SL, or panic exit), `clearActivePositionFilterState()` immediately resets verdict from `IN_POSITION` to `NO_SIGNAL_SCANNING`, perfectly synchronized across SSE streaming and frontend rendering without waiting for subsequent 5m candle closes.
* **Dual-Platform Capital & Equity Telemetry (`accountBalances`):**
  * Header Live Equity Pill (`#headerEquityPill`): Prominently displays the active engine's current margin balance (`BALANCE: $X.XX USDT`) in real-time next to the mode button.
  * Performance & Exposure Grid (`#perfEquityText`, `#perfAvailText`): Renders Total Margin Balance (labeled `Balance`) and Available Margin partitioned strictly by the selected performance mode (`DEMO` vs `REAL`), updating instantly on mode toggle clicks.
  * Switch Mode Confirmation Modal (`#switchModeModal`): Automatically inspects and displays target platform available balance (`Live Balance: $19.54 USDT` or `Demo Balance: $4,248.06 USDT`) before execution.
  * Backend API Endpoint: `GET /api/account-balances` backed by `Binance.getAccountBalances()` with an in-memory 10-second TTL cache, preventing exchange rate-limiting while maintaining sub-second UI responsiveness.
* **Full-Width High-Capacity Live Bot Console Terminal (Maximum Space):** Positioned directly beneath the dual-column analytics grid, spanning 100% of dashboard container width. Features a 520px standard viewport (expandable to 720px and 1-click fullscreen overlay `⛶ Fullscreen`), 1000-log in-memory buffer, category-specific counter badges, instant keyword search, visible logs copy button, and a real-time status bar displaying SSE connection health, buffer utilization, active filter criteria, and rendered logs count. Log messages feature color-coded syntax highlights (`[BLOCKED]`, `[SIGNAL]`, `[APPROVED]`, `[SCAN]`, `[AI]`, `[TRADE]`, `[WARN]`, `[ERROR]`) as well as explicit `[DEMO]` / `[REAL]` environment badges.
* **Resilient Error Serialization in Logger (`services/logger.js`):** The logger intercepts `console.log`, `console.warn`, and `console.error`. Standard JavaScript `Error` instances (and error-like objects with `message` / `stack` / `code`) are explicitly formatted with their descriptive name, message, and call trace rather than serialized with `JSON.stringify()` (which renders standard non-enumerable Error instances as empty objects `{}`). This guarantees complete visibility into network errors and exchange rejection reasons across both container terminal logs and the frontend Live Console.

---

## 15. UNIT TEST SUITE (`test/`)
Using native Node.js test runner (`node --test test/*.test.js`):
* `test/indicators.test.js`:
  1. Verifies mathematical accuracy of EMA with known price arrays and insufficient data handling.
  2. Verifies SMA calculation correctness across rolling windows.
  3. Verifies ADX trend strength calculation on simulated strong trending data (ADX > 20).
  4. Verifies `aggregateCandles` 5m-to-15m bucket grouping, max high, min low, volume sum, and candle counts.
* `test/news-filtering.test.js`:
  1. Verifies spam and promotional press release suppression.
  2. Verifies pure altcoin noise filtering without Bitcoin/macro anchors.
  3. Verifies high-impact macro headlines passing through to SumoPod AI.
  4. Verifies emergency halt keyword triggers immediately locking system state.
* `test/resilience.test.js`:
  1. Verifies Logger Error serialization prevents empty `{}` outputs and preserves error messages and levels.
  2. Verifies DnsResolver stale-on-error cache fallback persists and prevents lookup failures during transient outages.
* `test/risk-management.test.js`:
  1. Position sizing formula calculation against 1.5% equity risk.
  2. Long SL and TP price levels with 0.20% floor SL and 1:2.0 RR (0.40% TP).
  3. Short SL and TP price levels with 0.20% floor SL and 1:2.0 RR (0.40% TP).
  4. Trailing stop activation threshold (`1.5 * ATR`).
  5. Position sizing with actual Stop Loss distance and margin capacity safeguard (clamping to 70% available margin headroom at 50x leverage).
  6. Trailing stop anti-noise step threshold prevents micro-tick churn (`0.25 * ATR`).
  7. Micro-account sizing guard clamping safely to 0.001 BTC minimum exchange lot size.
  8. Kill switch strict isolation between DEMO and REAL trading modes.
  9. Whale Top Trader Long/Short ratio filter enforcement [0.85 - 1.80].
  10. Taker buy/sell order flow ratio filter and reality triggers (Long >= 1.15, Short <= 0.85).
  11. Order flow reality trigger & candle microstructure absorption guard (Long requires green candle, Short requires red candle).
  12. Volume participation filter enforcing active liquidity (>= 0.70 * SMA 20).
  13. Database schema strictly isolates `active_positions` by `(symbol, mode)` composite key, preventing collision or mutual deletion between DEMO and REAL modes.
  14. Net PnL calculation strictly deducts round-trip exchange commission fees.
  15. ADX Trend Strength Filter blocks trades in sideways choppy markets (ADX < 20).
  16. Multi-Timeframe 15m Trend Filter enforces trend confluence between 5m signal and 15m EMA 25 trend.
  17. Position reconciliation logic correctly synchronizes signed Binance positions (`pos.positionAmt < 0` for SHORT) matching positive DB quantity and signed side.

---

## 16. HISTORICAL STRATEGY EVOLUTION & ARCHIVE SPECIFICATION
This section establishes the authoritative, permanent record of strategy configurations traversed across the project lifecycle. Future agents and human architects must refer to this chronicle to understand previous baselines, trade-offs, and empirical findings.

### Comparative Strategy Evolution Matrix
| Specification Metric | Generation 1: Conservative Multi-Indicator Sniper (V1) | Generation 2: Softened Scalp Transition (V2) | Generation 3: High-Frequency Micro-Scalp (V3) | Generation 4: Order Flow Sniper Engine (V4) | Generation 5: Key Level Sniper Engine (V5 - ACTIVE) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Status** | Archived (Inception) | Archived (Phase 2) | Archived (Phase 3) | Archived (Phase 4) | **ACTIVE PRODUCTION ENGINE** |
| **Strategy Mode** | `LAGGING_INDICATORS` | `LAGGING_INDICATORS` | `LAGGING_INDICATORS` | `ORDER_FLOW_SNIPER` | `KEY_LEVEL_SNIPER` |
| **Timeframe & Symbol** | 5m BTCUSDT | 5m BTCUSDT | 5m BTCUSDT | 5m BTCUSDT | **5m BTCUSDT (15m Multi-Timeframe S/R Context)** |
| **Leverage** | 25x Cross / Isolated | 25x Cross / Isolated | 50x Cross / Isolated | 50x Cross / Isolated | **50x Cross / Isolated** |
| **Risiko per Transaksi** | 1.5% Available Margin | 1.5% Available Margin | 1.5% Available Margin | 1.0% Available Margin | **1.0% Available Margin (Institutional Sizing)** |
| **Stop Loss Distance** | Max(2 * ATR, 0.50% Entry) | Max(2 * ATR, 0.50% Entry) | Max(2 * ATR, 0.30% Entry) | Max(1.5 * ATR, 0.75% Entry) | **Max(1.0 * ATR, 0.20% Entry)** (~$152 on BTC $76k) |
| **Take Profit Target** | 1.00% Entry (RR 1:2.0) | 0.75% Entry (RR 1:1.5) | 0.50% Entry (RR 1:1.67) | 1.50% Entry (Gross RR 1:2.0) | **0.40% Entry (Gross RR 1:2.0 / Calibrated Sniper)** |
| **Round-Trip Fee (Taker)** | 0.10% (0.05% in + 0.05% out) | 0.10% | 0.10% | 0.10% | **0.10% (0.05% in + 0.05% out standard Binance)** |
| **Net Win / Net Loss** | +0.90% Net / -0.60% Net | +0.65% Net / -0.60% Net | +0.40% Net / -0.40% Net | +1.40% Net / -0.85% Net | **+0.30% Net / -0.30% Net (50.0% Win Rate Break-Even)** |
| **Net Risk-Reward Ratio** | 1:1.50 Net | 1:1.08 Net | 1:1.00 Net | 1:1.65 Net | **1:1.00 Net (Taker) / 1:1.10 Net (Maker TP)** |
| **Trailing Stop & Break-Even**| None | None | None | +0.50% Profit -> BE + 0.10% Fee | **DISABLED (Eliminates premature profit throttling)** |
| **Primary Entry Trigger** | EMA50 + MACD Hist + RSI | EMA50 + MACD Hist + RSI | EMA50 + MACD Hist + RSI | Taker Imbalance + Candle Confirmation | **15M S/R Zone Test + Rejection Wick (Pinbar/Bounce)** |
| **Long Entry Rule** | Close > EMA50, MACD > 0, RSI < 65 | Close > EMA50, MACD > 0, RSI < 65 | Close > EMA50, MACD > 0, RSI < 65 | Taker >= 1.35 + Close > Open | **Test Support Zone [+/-0.35%] + Lower Wick >= 25% + AI Bullish/Neutral** |
| **Short Entry Rule** | Close < EMA50, MACD < 0, RSI > 35 | Close < EMA50, MACD < 0, RSI > 35 | Close < EMA50, MACD < 0, RSI > 35 | Taker <= 0.65 + Close < Open | **Test Resist Zone [+/-0.35%] + Upper Wick >= 25% + AI Bearish/Neutral** |
| **Mid-Range Filter** | None | None | None | None | **Eliminates mid-range scalping chop (Awaits S/R test)** |
| **Volume Participation** | >= 1.20 * SMA(20) | >= 0.60 * SMA(20) | >= 0.45 * SMA(20) | >= 0.70 * SMA(20) | **>= 0.70 * SMA(20) Liquidity Standard** |
| **ADX Trend Strength** | ADX >= 20 | ADX >= 15 | ADX >= 15 | ADX >= 22 | **ADX >= 22 (Eliminates non-trending chop)** |
| **Multi-Timeframe 15m** | 15m EMA50 | 15m EMA25 | 15m EMA25 | 15m EMA25 Confluence | **15m S/R Range (24 candles) + 15m EMA25 Confluence** |
| **AI Macro Gatekeeper** | Veto (conf > 5) | Veto (conf > 5) | Veto (conf > 5) | Veto (conf >= 7) | **Directional Confluence: Bullish/Neutral on Long, Bearish/Neutral on Short** |
| **Post-Loss Cooldown** | None | None | None | 20 Minutes | **20 Minutes Anti-Revenge Cooldown** |
| **Position Guard** | Single Concurrent Position | Single Concurrent Position | Single Concurrent Position | Single Concurrent Position | **Single Concurrent Position** |
| **Time-Based Exit (Max Hold)** | None | None | None | None | **30 Minutes (Prunes Stale Positions / Stops Funding Decay)** |

### Detailed Evolutionary Analysis & Empirical Rationale

#### 1. Generation 1 (V1) - The Conservative Multi-Indicator Trend Follower
* **Hypothesis:** By stacking 7 orthogonal technical and macro filters (EMA 50, MACD histogram, RSI 42–65, ADX >= 20, 15m EMA 50 trend confirmation, 1.2x Volume, Whale positioning, and AI veto), false breakouts could be eliminated and win rate maximized.
* **Empirical Limitation:** Indicator latency and severe multi-filter conflict caused extreme trade starvation (0 positions opened across hundreds of candles). Moving averages (EMA 50) and MACD histograms are backward-looking lag indicators; by the time all 7 indicators synchronized on a 5-minute chart, the impulse move had already exhausted itself, resulting in entries right at cycle exhaustion wicks.

#### 2. Generation 2 (V2) - The Softened Scalp Transition
* **Hypothesis:** Retain the indicator foundation but relax gating thresholds (ADX threshold from 20 to 15, volume from 1.2x to 0.60x, 15m MTF EMA from 50 to 25, Take Profit from 1.00% to 0.75%) to increase opportunity capture.
* **Empirical Limitation:** While filter rejection softened slightly, entries remained delayed due to lagging indicator dependency. The 0.75% TP target on BTC (~$625) still required substantial trending expansion that 5m scalp candles rarely maintained without encountering retracements.

#### 3. Generation 3 (V3) - The High-Frequency Micro-Scalp
* **Hypothesis:** Elevate leverage to 50x, contract Stop Loss floor to 0.30% (~$250 on BTC) and Take Profit to 0.50% (~$418 on BTC, 1:1.67 RR), while further relaxing volume to 0.45x SMA 20.
* **Empirical Limitation:** High leverage successfully reduced capital tie-up per trade, but moving average and momentum indicators still produced lagging triggers. Scalping on 50x leverage requires real-time order execution matching immediate order book aggression, not lagging moving average crossovers.

#### 4. Generation 4 (V4) - The Pure Market Reality & Order Flow Engine
* **Core Philosophy Shift:** Replaced all lagging indicators with market order flow imbalance (`takerBuySellRatio >= 1.35` / `<= 0.65`) and candle confirmation.
* **Empirical Limitation:** While entry latency was eliminated, two severe issues emerged:
  1. **Premature Trailing Stop & Break-Even Choke (Negative Asymmetry):** The break-even mechanism shifted Stop Loss to `Entry + 0.10%` as soon as floating profit reached $+0.50\%$. In routine 5m BTC market noise, normal retracement wicks oscillate $0.20\% - 0.40\%$. Almost every winning trade was stopped out prematurely at entry or micro-profits (+$1.7 to +$12.0, or negative after commissions), whereas losing trades absorbed the full -$35 to -$45 Stop Loss. The bot never reached its planned 1:2.0 Take Profit ($+$70).
  2. **Scalping in "No Man's Land" (Mid-Range Chop):** Taker volume imbalance spikes frequently occurred in the middle of trading ranges or right below key resistance/above support, resulting in entries without structural location advantage.

#### 5. Generation 5 (V5 - ACTIVE) - Key Level Sniper Engine & Profit Preservation
* **Core Architectural Shift:**
  1. **Elimination of Premature Trailing Stop & Break-Even Throttling:** `trailingStop.enabled` and `trailingStop.breakEven.enabled` are explicitly set to `false`. Trades are given uninterrupted room to breathe, allowing winning positions to run to the full Take Profit target (1:2.0 RR = $+1.50\% \approx +\$60$ to $+\$75$ on $4,900 equity) rather than getting choked by micro-wicks at entry.
  2. **15M Multi-Timeframe Key Support & Resistance:** System calculates dynamic Swing Highs and Swing Lows across 24 15m aggregated candles (6-hour rolling window). Trades are permitted ONLY when price is testing Key Levels ($\pm 0.35\%$ proximity zone):
     * **BUY (LONG) at Support Zone:** Entered when price tests Support with a lower wick rejection (pinbar/hammer $\ge 25\%$ range) or green bounce candle.
     * **SELL (SHORT) at Resistance Zone:** Entered when price tests Resistance with an upper wick rejection (shooting star/pinbar $\ge 25\%$ range) or red rejection candle.
  3. **Mid-Range Chop Filter:** When price is floating in the neutral middle zone between Support and Resistance, trades are strictly prohibited (`NO_SIGNAL_SCANNING`), completely ending blind scalping.
  4. **Directional Macro News & AI Confluence:** News is elevated from a passive veto to an active directional confluence filter: LONG at Support requires Bullish or Neutral sentiment (strictly forbidden if Bearish); SHORT at Resistance requires Bearish or Neutral sentiment (strictly forbidden if Bullish).

---

## 17. PROJECT FILE STRUCTURE
Generate the following file hierarchy:
```
├── .env.example
├── Dockerfile
├── Dockerfile.builder
├── docker-compose.yml
├── package.json
├── build/
│   ├── .gitignore
│   ├── .gitkeep
│   └── bot-trading.exe (Windows Standalone Executable, Git-ignored)
├── config/
│   ├── db.js
│   └── strategy.js
├── scripts/
│   ├── build-windows.sh
│   ├── deploy-vps.sh
│   └── windows/
│       ├── app.rc
│       └── launcher.c
├── services/
│   ├── ai.js
│   ├── binance.js
│   ├── dns-resolver.js
│   ├── indicators.js
│   ├── logger.js
│   ├── news.js
│   └── notifier.js
├── src/
│   ├── dashboard-server.js
│   └── trading-core.js
├── public/
│   ├── dashboard.js
│   ├── index.html
│   └── style.css
└── test/
    ├── indicators.test.js
    └── risk-management.test.js
```

---

## 18. CODE GENERATION INSTRUCTIONS
1. Output each file completely and sequentially according to the structure above.
2. Ensure `better-sqlite3` is called strictly synchronously without unnecessary async wrappers.
3. Use `bignumber.js` for all mathematical calculations to eliminate floating-point drift.
4. Ensure the SumoPod endpoint `https://ai.sumopod.com/v1/chat/completions` and `mimo-v2.6-flash` model schema are strictly adhered to.
5. Implement the `Notifier` service with non-blocking failure isolation for Telegram Bot API.
6. Implement the classified `BinanceError` interceptor with exponential backoff and -1021 auto time re-sync.
7. Implement the full WebSocket auto-reconnect logic and Server-Sent Events real-time pipeline.
8. Provide complete, fully functional HTML, CSS, and client-side JavaScript for the dashboard matching the exact cyber-glassmorphism layout wireframe and visual specifications above.
