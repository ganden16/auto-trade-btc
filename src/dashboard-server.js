const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db } = require('../config/db');
const logger = require('../services/logger');
const strategy = require('../config/strategy');
const notifier = require('../services/notifier');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  }
}));

// Security: Session token persisted in SQLite system_state or loaded from env
let apiToken = process.env.INTERNAL_API_TOKEN;
if (!apiToken) {
  try {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get('api_token');
    if (row && row.value) {
      apiToken = row.value;
    } else {
      apiToken = crypto.randomUUID();
      db.prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run('api_token', apiToken);
    }
  } catch (e) {
    apiToken = crypto.randomUUID();
  }
}

// Lazy load core reference to avoid circular require issues
let tradingCore = null;
const getTradingCore = () => {
  if (!tradingCore) {
    try {
      tradingCore = require('./trading-core');
    } catch (e) {
      // Handled if core still initializing
    }
  }
  return tradingCore;
};

// Auth Middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers['x-internal-token'] || req.query.token;
  if (token !== apiToken) {
    return res.status(403).json({ error: 'Forbidden: Invalid Token' });
  }
  next();
};

const getFullState = (reqMode = null) => {
  const core = getTradingCore();
  const currentEngineMode = strategy.api.isTestnet ? 'DEMO' : 'REAL';

  const positions = reqMode
    ? db.prepare('SELECT * FROM active_positions WHERE mode = ?').all(reqMode)
    : db.prepare('SELECT * FROM active_positions').all();
  const fills = reqMode
    ? db.prepare('SELECT * FROM position_fills WHERE mode = ? ORDER BY timestamp DESC LIMIT 50').all(reqMode)
    : db.prepare('SELECT * FROM position_fills ORDER BY timestamp DESC LIMIT 50').all();
  const history = reqMode
    ? db.prepare('SELECT * FROM trade_history WHERE mode = ? ORDER BY timestamp DESC LIMIT 500').all(reqMode)
    : db.prepare('SELECT * FROM trade_history ORDER BY timestamp DESC LIMIT 500').all();

  // Active positions for the current active trading engine mode
  const currentEnginePositions = db.prepare('SELECT * FROM active_positions WHERE mode = ?').all(currentEngineMode);

  const botInfo = {
    symbol: core ? core.symbol : 'BTCUSDT',
    interval: core ? core.interval : '5m',
    isTradingLocked: core ? core.isTradingLocked : false,
    degradedMode: core ? core.degradedMode : false,
    isTestnet: strategy.api.isTestnet,
    tradingMode: currentEngineMode,
    latestSentiment: core ? core.latestSentiment : { sentiment: 'NEUTRAL', confidence: 0, reason: '' },
    lastPrice: core ? core.lastPrice : null,
    lastIndicators: core ? core.lastIndicators : { ema50: null, rsi: null, macdHist: null, atr: null, adx: null, volume: null, volumeSma: null, mtfTrend: null },
    filterEvaluation: (() => {
      let f = core ? core.latestFilterEvaluation : null;
      if (currentEnginePositions.length === 0 && f && f.verdict === 'IN_POSITION') {
        f = Object.assign({}, f, {
          verdict: 'NO_SIGNAL_SCANNING',
          activePosition: null,
          blockedReasons: []
        });
        if (f.filters && f.filters.positionGuard) {
          f.filters = Object.assign({}, f.filters, {
            positionGuard: Object.assign({}, f.filters.positionGuard, {
              passed: true,
              value: 'Ready (0 Positions)',
              statusText: 'Pass (Ready for Entry)'
            })
          });
        }
      }
      return f;
    })(),
    latestNewsHeadline: core ? core.latestNewsHeadline : null,
    latestArticles: core ? (core.latestArticles || []) : [],
    strategy: {
      strategyMode: strategy.trading.strategyMode || 'KEY_LEVEL_SNIPER',
      keyLevels: strategy.trading.keyLevels || {},
      confluence: strategy.trading.confluence || {},
      trailingStop: strategy.trading.trailingStop || {},
      realityEngine: strategy.trading.realityEngine || {},
      leverage: strategy.trading.leverage,
      riskPerTradePct: strategy.trading.riskPerTradePct,
      floorSlPct: strategy.trading.floorSlPct,
      rrRatio: strategy.trading.rrRatio,
      maxHoldMinutes: strategy.trading.maxHoldMinutes || 60,
      slippageMaxPct: strategy.trading.slippageMaxPct,
      filters: strategy.trading.filters,
      ai: {
        model: strategy.ai.model || process.env.AI_MODEL_NAME || 'mimo-v2.6-flash',
        minVetoConfidence: strategy.ai.minVetoConfidence || 7,
        maxNewsAgeMinutes: strategy.ai.maxNewsAgeMinutes || 45,
        emergencyExitConf: strategy.ai.emergencyExitConf || 9,
        emergencyHaltEnabled: strategy.ai.emergencyHaltEnabled || false,
        requireConfluence: strategy.ai.requireConfluence || false
      }
    },
    reconciliationIntervalSec: Math.round((strategy.api.reconciliationIntervalMs || 15000) / 1000),
    whaleMetrics: core ? core.latestWhaleMetrics : null,
    liquidationMetrics: core ? core.latestLiquidationMetrics : null,
    cvdMetrics: core ? core.latestCvdMetrics : null,
    accountBalances: core ? core.latestAccountBalances : { DEMO: null, REAL: null },
    accountEquity: core ? (core.accountEquity ? core.accountEquity.toString() : null) : null,
    uptimeSeconds: core ? Math.floor((Date.now() - (core.startTime || Date.now())) / 1000) : 0
  };

  return { positions, fills, history, botInfo };
};

app.get('/api/session-token', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({ token: apiToken });
});

app.get('/api/account-balances', authMiddleware, async (req, res) => {
  try {
    const Binance = require('../services/binance');
    const balances = await Binance.getAccountBalances();
    res.json({ success: true, balances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/state', authMiddleware, (req, res) => {
  try {
    const reqMode = req.query.mode ? req.query.mode.toUpperCase() : null;
    const state = getFullState(reqMode);
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: 'Database Error: ' + error.message });
  }
});

app.get('/api/news', authMiddleware, async (req, res) => {
  const core = getTradingCore();
  if (req.query.refresh === 'true' && core && typeof core.monitorNews === 'function') {
    try {
      await core.monitorNews();
    } catch (e) {
      console.warn('[NEWS] Manual refresh failed:', e.message);
    }
  }
  res.json({
    latestNewsHeadline: core ? core.latestNewsHeadline : null,
    latestSentiment: core ? core.latestSentiment : null,
    articles: core ? (core.latestArticles || []) : []
  });
});

app.get('/api/whale', authMiddleware, async (req, res) => {
  const core = getTradingCore();
  if (req.query.refresh === 'true' && core && typeof core.fetchWhaleMetrics === 'function') {
    try {
      await core.fetchWhaleMetrics();
    } catch (e) {
      console.warn('[WHALE] Manual refresh failed:', e.message);
    }
  }
  res.json({
    whaleMetrics: core ? core.latestWhaleMetrics : null,
    liquidationMetrics: core ? core.latestLiquidationMetrics : null,
    cvdMetrics: core ? core.latestCvdMetrics : null
  });
});

app.get('/api/logs', authMiddleware, (req, res) => {
  const reqMode = req.query.mode ? req.query.mode.toUpperCase() : null;
  res.json({ logs: logger.getRecentLogs(reqMode) });
});

app.get('/api/fills', authMiddleware, (req, res) => {
  try {
    const reqMode = req.query.mode ? req.query.mode.toUpperCase() : null;
    const fills = reqMode 
      ? db.prepare('SELECT * FROM position_fills WHERE mode = ? ORDER BY timestamp DESC LIMIT 50').all(reqMode)
      : db.prepare('SELECT * FROM position_fills ORDER BY timestamp DESC LIMIT 50').all();
    res.json({ fills });
  } catch (error) {
    res.status(500).json({ error: 'Database Error: ' + error.message });
  }
});

app.get('/api/history', authMiddleware, (req, res) => {
  try {
    const reqMode = req.query.mode ? req.query.mode.toUpperCase() : null;
    const history = reqMode
      ? db.prepare('SELECT * FROM trade_history WHERE mode = ? ORDER BY timestamp DESC LIMIT 500').all(reqMode)
      : db.prepare('SELECT * FROM trade_history ORDER BY timestamp DESC LIMIT 500').all();
    res.json({ history });
  } catch (error) {
    res.status(500).json({ error: 'Database Error: ' + error.message });
  }
});

// Active SSE Clients tracking for graceful shutdown & zero-error disconnects
const sseClients = new Set();

const closeAllSseClients = () => {
  for (const client of sseClients) {
    try {
      client.write('event: shutdown\ndata: {"status":"restarting"}\n\n');
      client.end();
    } catch (e) {}
  }
  sseClients.clear();
};

// Server-Sent Events for real-time updates and live logs
app.get('/api/stream', (req, res) => {
  const token = req.query.token;
  if (token !== apiToken) {
    console.warn(`[SSE_AUTH_FAIL] Unauthorized stream request. Query token: ${token ? token.slice(0, 8) + '...' : 'empty'}`);
    return res.status(403).end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  sseClients.add(res);

  // Send initial full snapshot including recent logs
  try {
    const initialState = getFullState();
    res.write(`data: ${JSON.stringify({ 
      type: 'INIT_STATE', 
      data: initialState,
      logs: logger.getRecentLogs()
    })}\n\n`);
  } catch (e) {
    console.error('SSE Init Error:', e);
  }

  // Realtime Log Listener
  const onNewLog = (logEntry) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'LOG', data: logEntry })}\n\n`);
    } catch (e) {
      // Socket closed
    }
  };
  logger.on('log', onNewLog);

  // Realtime Sub-second Price Tick Listener
  const core = getTradingCore();
  const onPriceTick = (tick) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'PRICE_TICK', data: tick })}\n\n`);
    } catch (e) {
      // Socket closed
    }
  };
  const onLiquidationEvent = (liq) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'LIQUIDATION_EVENT', data: liq })}\n\n`);
    } catch (e) {
      // Socket closed
    }
  };
  if (core && typeof core.on === 'function') {
    core.on('tick', onPriceTick);
    core.on('liquidation', onLiquidationEvent);
  }

  // Periodic state snapshot push every 1.5s
  const intervalId = setInterval(() => {
    try {
      const state = getFullState();
      res.write(`data: ${JSON.stringify({ type: 'STATE_UPDATE', data: state })}\n\n`);
    } catch (e) {
      // Stream closed or error
    }
  }, 1500);

  req.on('close', () => {
    clearInterval(intervalId);
    logger.removeListener('log', onNewLog);
    if (core && typeof core.removeListener === 'function') {
      core.removeListener('tick', onPriceTick);
      core.removeListener('liquidation', onLiquidationEvent);
    }
    sseClients.delete(res);
  });
});

function verifyDashboardPassword(providedPassword) {
  const envPath = path.resolve(__dirname, '../.env');
  let configuredPassword = (process.env.DASHBOARD_PASSWORD || process.env.ADMIN_PASSWORD || '').trim();
  
  if (!configuredPassword && fs.existsSync(envPath)) {
    try {
      const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
      configuredPassword = (parsed.DASHBOARD_PASSWORD || parsed.ADMIN_PASSWORD || '').trim();
    } catch (e) {}
  }

  if (!configuredPassword) {
    return true;
  }

  if (typeof providedPassword !== 'string') return false;
  return providedPassword.trim() === configuredPassword;
}

app.post('/api/panic', authMiddleware, async (req, res) => {
  const { password } = req.body || {};
  if (!verifyDashboardPassword(password)) {
    return res.status(401).json({ error: 'Password keamanan salah atau belum dimasukkan!' });
  }

  const core = getTradingCore();
  console.warn("[EMERGENCY] PANIC BUTTON TRIGGERED! Closing positions & halting trading...");
  if (core && typeof core.panicCloseAndHalt === 'function') {
    try {
      const result = await core.panicCloseAndHalt();
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message, isTradingLocked: true });
    }
  } else {
    if (core) core.isTradingLocked = true;
    notifier.sendAlert("PANIC HALT TRIGGERED", "Manual emergency panic button triggered via Web Terminal. All trade execution is HALTED.", "ERROR");
    return res.json({ status: 'PANIC_INITIATED', isTradingLocked: true });
  }
});

app.post('/api/unlock', authMiddleware, (req, res) => {
  const { password } = req.body || {};
  if (!verifyDashboardPassword(password)) {
    return res.status(401).json({ error: 'Password keamanan salah atau belum dimasukkan!' });
  }

  const core = getTradingCore();
  if (core) {
    core.isTradingLocked = false;
    if (core.lastHaltHeadline) {
      core.acknowledgedHaltHeadline = core.lastHaltHeadline;
    }
  }
  console.log("[SYSTEM] Trading unlocked via Dashboard.");
  notifier.sendAlert("SYSTEM UNLOCKED", "Bot trading execution has been manually unlocked via Web Terminal.", "INFO");
  res.json({ status: 'UNLOCKED', isTradingLocked: false });
});

app.post('/api/switch-mode', authMiddleware, async (req, res) => {
  const { targetMode, password } = req.body || {};
  if (!verifyDashboardPassword(password)) {
    return res.status(401).json({ error: 'Password keamanan salah atau belum dimasukkan!' });
  }

  if (targetMode !== 'DEMO' && targetMode !== 'REAL') {
    return res.status(400).json({ error: 'Mode tidak valid. Harus DEMO atau REAL.' });
  }

  const isTestnet = targetMode === 'DEMO';
  const envVal = isTestnet ? 'true' : 'false';

  const envPath = path.resolve(__dirname, '../.env');

  // Validasi proteksi: Pastikan kredensial akun real sudah terisi jika ingin switch ke REAL
  if (targetMode === 'REAL') {
    let hasKeys = !!(process.env.BINANCE_REAL_API_KEY && process.env.BINANCE_REAL_API_SECRET);
    if (!hasKeys && fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const kMatch = content.match(/^BINANCE_REAL_API_KEY=(.+)$/m);
      const sMatch = content.match(/^BINANCE_REAL_API_SECRET=(.+)$/m);
      if (kMatch && kMatch[1].trim() && sMatch && sMatch[1].trim()) {
        hasKeys = true;
      }
    }

    if (!hasKeys) {
      return res.status(400).json({
        error: 'Kredensial Akun Riil (BINANCE_REAL_API_KEY & BINANCE_REAL_API_SECRET) belum terisi di .env! Harap lengkapi terlebih dahulu.'
      });
    }
  }

  try {
    // 1. Catat ke SQLite system_state (Single Source of Truth)
    db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('trading_mode', targetMode);

    // 2. Perbarui file .env
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf8');
      if (/^BINANCE_TESTNET=.*$/m.test(envContent)) {
        envContent = envContent.replace(/^BINANCE_TESTNET=.*$/m, `BINANCE_TESTNET=${envVal}`);
      } else {
        envContent = `BINANCE_TESTNET=${envVal}\n` + envContent;
      }
      fs.writeFileSync(envPath, envContent, 'utf8');
    }

    // 3. Sinkronkan variabel in-memory saat ini
    process.env.BINANCE_TESTNET = envVal;
    strategy.api.isTestnet = isTestnet;
    strategy.api.baseUrl = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
    strategy.api.wsUrl = isTestnet ? 'wss://stream.binancefuture.com/ws' : 'wss://fstream.binance.com/market/ws';
    const Binance = require('../services/binance');
    Binance.reconfigure();

    notifier.sendAlert("PENGALIHAN MODE TRADING", `Mode trading dialihkan ke: ${targetMode}. Sistem memuat ulang engine...`, "INFO");

    res.json({
      success: true,
      mode: targetMode,
      isTestnet,
      message: `Berhasil beralih ke mode ${targetMode}. Bot akan memuat ulang dalam 1 detik.`
    });

    // Mulai ulang proses bot secara aman agar semua koneksi (REST, WS, Streams) terinisialisasi ulang
    setTimeout(() => {
      console.log(`[MODE_SWITCH] Switched trading mode to ${targetMode}. Restarting process...`);
      closeAllSseClients();
      process.exit(0);
    }, 1000);
  } catch (error) {
    console.error('[MODE_SWITCH_ERROR]', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 28080;
const server = app.listen(PORT, () => {
  console.log(`Dashboard server running on port ${PORT}`);

  // Auto-launch default browser on Windows desktop / standalone mode
  const shouldOpenBrowser = process.env.AUTO_OPEN_BROWSER === 'true' || 
    (process.platform === 'win32' && process.env.AUTO_OPEN_BROWSER !== 'false');

  if (shouldOpenBrowser) {
    const dashboardUrl = `http://localhost:${PORT}`;
    setTimeout(() => {
      try {
        const { exec } = require('child_process');
        if (process.platform === 'win32') {
          exec(`start "" "${dashboardUrl}"`);
        } else if (process.platform === 'darwin') {
          exec(`open "${dashboardUrl}"`);
        } else {
          exec(`xdg-open "${dashboardUrl}"`);
        }
        console.log(`[DESKTOP_UI] Opening trading dashboard in browser: ${dashboardUrl}`);
      } catch (err) {
        console.warn(`[DESKTOP_UI] Browser auto-launch failed: ${err.message}`);
      }
    }, 1500);
  }
});

module.exports = { app, server, closeAllSseClients };
