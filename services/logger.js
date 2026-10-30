const EventEmitter = require('events');

class Logger extends EventEmitter {
  constructor() {
    super();
    this.logs = [];
    this.maxLogs = 300;
    this.initInterceptor();
  }

  initInterceptor() {
    const originalLog = console.log.bind(console);
    const originalWarn = console.warn.bind(console);
    const originalError = console.error.bind(console);

    console.log = (...args) => {
      originalLog(...args);
      this.record('INFO', args);
    };

    console.warn = (...args) => {
      originalWarn(...args);
      this.record('WARN', args);
    };

    console.error = (...args) => {
      originalError(...args);
      this.record('ERROR', args);
    };
  }

  record(level, args) {
    const message = args
      .map(arg => {
        if (arg instanceof Error) {
          return arg.stack ? `${arg.name || 'Error'}: ${arg.message}` : (arg.message || String(arg));
        }
        if (typeof arg === 'object' && arg !== null) {
          if (arg.message && (arg.stack || arg.code)) {
            return `${arg.name || 'Error'}: ${arg.message}`;
          }
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(' ');

    const mode = (process.env.BINANCE_TESTNET === 'false') ? 'REAL' : 'DEMO';
    const entry = {
      id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toLocaleTimeString('id-ID', { hour12: false }),
      fullTime: new Date().toISOString(),
      level: level,
      message: message,
      msg: message,
      mode: mode
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    if (process.env.NODE_ENV !== 'test') {
      try {
        const { db } = require('../config/db');
        db.prepare('INSERT INTO system_logs (timestamp, level, message, context, mode) VALUES (?, ?, ?, ?, ?)')
          .run(Date.now(), level, message, null, mode);
      } catch (e) {}
    }

    this.emit('log', entry);
  }

  getRecentLogs(targetMode = null) {
    if (targetMode) {
      return this.logs.filter(l => (l.mode || 'DEMO').toUpperCase() === targetMode.toUpperCase());
    }
    return this.logs;
  }
}

const loggerInstance = new Logger();
module.exports = loggerInstance;
