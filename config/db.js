const Database = require('better-sqlite3');
const Redis = require('ioredis');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// SQLite Database
const dbPath = path.join(dataDir, 'trading.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency and synchronous=NORMAL for durability vs performance
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Schema setup
const initializeDb = () => {
  db.exec(`
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
  `);

  // Migration: Ensure active_positions has composite PK (symbol, mode)
  try {
    const tableInfo = db.prepare("PRAGMA table_info(active_positions)").all();
    if (tableInfo && tableInfo.length > 0) {
      const pkCols = tableInfo.filter(c => c.pk > 0);
      if (pkCols.length === 1 && pkCols[0].name === 'symbol') {
        db.exec(`
          CREATE TABLE IF NOT EXISTS active_positions_v2 (
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
            updated_at INTEGER NOT NULL,
            mode TEXT NOT NULL DEFAULT 'DEMO',
            PRIMARY KEY (symbol, mode)
          );
          INSERT OR IGNORE INTO active_positions_v2 
          SELECT symbol, side, entry_price, qty, unrealized_pnl, sl_id, tp_id, sl_price, tp_price, trailing_sl, atr_at_entry, updated_at, COALESCE(mode, 'DEMO') 
          FROM active_positions;
          DROP TABLE active_positions;
          ALTER TABLE active_positions_v2 RENAME TO active_positions;
        `);
      }
    }
  } catch(e) {
    console.error('Migration active_positions error:', e);
  }

  // Column additions and backfills
  try { db.exec('ALTER TABLE active_positions ADD COLUMN sl_price TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE active_positions ADD COLUMN tp_price TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE active_positions ADD COLUMN trailing_sl TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE active_positions ADD COLUMN atr_at_entry TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE active_positions ADD COLUMN is_be_active INTEGER DEFAULT 0'); } catch(e) {}
  try { db.exec("ALTER TABLE active_positions ADD COLUMN mode TEXT NOT NULL DEFAULT 'DEMO'"); } catch(e) {}
  try { db.exec("UPDATE active_positions SET mode = 'DEMO' WHERE mode IS NULL"); } catch(e) {}

  try { db.exec("ALTER TABLE position_fills ADD COLUMN mode TEXT NOT NULL DEFAULT 'DEMO'"); } catch(e) {}
  try { db.exec("UPDATE position_fills SET mode = 'DEMO' WHERE mode IS NULL"); } catch(e) {}

  try { db.exec("ALTER TABLE trade_history ADD COLUMN mode TEXT NOT NULL DEFAULT 'DEMO'"); } catch(e) {}
  try { db.exec("UPDATE trade_history SET mode = 'DEMO' WHERE mode IS NULL"); } catch(e) {}

  try { db.exec("ALTER TABLE system_logs ADD COLUMN mode TEXT NOT NULL DEFAULT 'DEMO'"); } catch(e) {}
  try { db.exec("UPDATE system_logs SET mode = 'DEMO' WHERE mode IS NULL"); } catch(e) {}

  // Mode and timestamp indexes for fast partitioned queries
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_active_positions_mode ON active_positions (mode);
      CREATE INDEX IF NOT EXISTS idx_position_fills_mode_time ON position_fills (mode, timestamp);
      CREATE INDEX IF NOT EXISTS idx_trade_history_mode_time ON trade_history (mode, timestamp);
      CREATE INDEX IF NOT EXISTS idx_system_logs_mode_time ON system_logs (mode, timestamp);
    `);
  } catch(e) {}
};

initializeDb();

// Redis setup
const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  retryStrategy: (times) => {
    return Math.min(times * 50, 2000);
  }
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

module.exports = {
  db,
  redis
};
