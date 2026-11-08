const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const dnsResolver = require('./dns-resolver');
const { db } = require('../config/db');
const strategy = require('../config/strategy');
const BigNumber = require('bignumber.js');

class BinanceError extends Error {
  constructor(message, code, isTransient) {
    super(message);
    this.code = code;
    this.isTransient = isTransient;
  }
}

class BinanceService {
  constructor() {
    this.timeOffset = 0;
    this.ws = null;
    this.wsBuffer = [];
    this.messageQueue = [];
    this.wsHeartbeatTimer = null;
    this.wsReconnectTimer = null;
    this.lastWsMessageTime = 0;
    this.cachedBalances = null;
    this.cachedBalancesTime = 0;
    this.rateLimitBannedUntil = 0;
    this.reconfigure();
  }

  reconfigure() {
    this.isTestnet = strategy.api.isTestnet;
    this.apiKey = this.isTestnet
      ? (process.env.BINANCE_TESTNET_API_KEY || process.env.BINANCE_API_KEY)
      : (process.env.BINANCE_REAL_API_KEY || process.env.BINANCE_API_KEY);
    this.apiSecret = this.isTestnet
      ? (process.env.BINANCE_TESTNET_API_SECRET || process.env.BINANCE_API_SECRET)
      : (process.env.BINANCE_REAL_API_SECRET || process.env.BINANCE_API_SECRET);
    this.baseUrl = strategy.api.baseUrl;
    this.wsUrl = strategy.api.wsUrl;
    this.agent = dnsResolver.getAgent();
    
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 5000,
      httpsAgent: this.agent,
      headers: {
        'X-MBX-APIKEY': this.apiKey
      }
    });

    // Public Market Intelligence Client: Always points to Binance Mainnet for authentic statistics
    // (Testnet lacks whale order flow, top trader positioning, and provides arbitrary fake open interest)
    this.publicClient = axios.create({
      baseURL: 'https://fapi.binance.com',
      timeout: 5000,
      httpsAgent: this.agent
    });
    
    this.setupInterceptors();
  }

  setupInterceptors() {
    const errorInterceptor = error => {
      if (!error.response) {
        return Promise.reject(new BinanceError('Network Error', 'ECONNRESET', true));
      }
      
      const status = error.response.status;
      const code = error.response.data?.code;
      const msg = error.response.data?.msg;
      
      if (status === 429 || code === -1003) {
        if (code === -1003 && msg) {
          const match = msg.match(/banned until (\d+)/);
          const banUntil = match ? parseInt(match[1], 10) : (Date.now() + 60000);
          const remoteIp = error.request?.socket?.remoteAddress;
          if (remoteIp) {
            dnsResolver.markBadIp(remoteIp, Math.max(banUntil - Date.now(), 60000));
            console.warn(`[DNS_FAILOVER] Node ${remoteIp} encountered proxy ban (-1003). Blacklisting node.`);
          }

          let hostname = null;
          try {
            const fullUrl = error.config?.url?.startsWith('http')
              ? error.config.url
              : `${error.config?.baseURL || ''}${error.config?.url || ''}`;
            hostname = new URL(fullUrl).hostname;
          } catch (e) {}

          const hasHealthyIps = hostname ? dnsResolver.hasHealthyIps(hostname) : false;
          if (hasHealthyIps) {
            return Promise.reject(new BinanceError(`Edge node ban encountered on ${remoteIp || 'unknown'}, retrying via healthy node`, '-1003', true));
          }

          this.rateLimitBannedUntil = banUntil;
        } else if (status === 429) {
          this.rateLimitBannedUntil = Date.now() + 60000;
        }
        return Promise.reject(new BinanceError(`Rate Limit (${code || status}: ${msg || 'Too Many Requests'})`, code ? String(code) : '429', false));
      }
      
      if (code === -1021) { // Timestamp out of sync
        return Promise.reject(new BinanceError(`Timestamp Out of Sync (-1021: ${msg || 'Invalid Timestamp'})`, '-1021', true));
      }
      
      if (code === -1022) { // Real Binance Invalid Signature
        return Promise.reject(new BinanceError(`Invalid Signature (-1022: ${msg || 'Signature not valid'})`, '-1022', false));
      }
      
      return Promise.reject(new BinanceError(msg || 'API Error', code, false));
    };

    this.client.interceptors.response.use(response => response, errorInterceptor);
    if (this.publicClient) {
      this.publicClient.interceptors.response.use(response => response, errorInterceptor);
    }
  }

  async syncTime() {
    try {
      const response = await this.client.get('/fapi/v1/time');
      const serverTime = response.data.serverTime;
      this.timeOffset = serverTime - Date.now();
      console.log(`Time synced. Offset: ${this.timeOffset}ms`);
    } catch (error) {
      console.error('Failed to sync time:', error.message);
    }
  }

  getTimestamp() {
    return Date.now() + this.timeOffset;
  }

  signRequest(queryString) {
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  async handleApiError(operation, maxRetries = 5, contextName = 'API') {
    if (this.rateLimitBannedUntil && Date.now() < this.rateLimitBannedUntil) {
      const waitSec = Math.ceil((this.rateLimitBannedUntil - Date.now()) / 1000);
      throw new BinanceError(`Binance rate limit cooldown active (${waitSec}s remaining)`, '-1003', false);
    }

    let retries = 0;
    while (retries < maxRetries) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof BinanceError && error.isTransient) {
          retries++;
          const delay = Math.min(Math.pow(2, retries) * 1000, 16000); // Exponential backoff capped at 16s
          console.warn(`[TRANSIENT_RETRY] ${contextName} encountered ${error.message}. Retrying in ${delay}ms (Attempt ${retries}/${maxRetries})`);
          
          if (error.code === '-1021') {
            await this.syncTime(); // Re-sync time
          }
          
          await new Promise(res => setTimeout(res, delay));
        } else {
          console.error(`Non-transient API Error for ${contextName}: ${error.message}`);
          throw error;
        }
      }
    }
    throw new Error(`Max retries reached for ${contextName}`);
  }

  async request(method, endpoint, params = {}) {
    if (!this.apiKey || !this.apiSecret) throw new Error("Missing Binance API Keys");

    return this.handleApiError(async () => {
      const queryParams = Object.assign({}, params);
      if (!queryParams.recvWindow) {
        queryParams.recvWindow = 10000;
      }
      queryParams.timestamp = this.getTimestamp();
      const queryString = Object.keys(queryParams)
        .map(key => `${key}=${encodeURIComponent(queryParams[key])}`)
        .join('&');
      
      const signature = this.signRequest(queryString);
      const url = `${endpoint}?${queryString}&signature=${signature}`;
      
      const response = await this.client({
        method: method,
        url: url
      });
      return response.data;
    }, 5, `${method} ${endpoint}`);
  }

  async placeOrder(symbol, side, qty, price = null, type = 'LIMIT') {
    if (!symbol || !side || !qty) throw new Error("Invalid order params");
    const params = {
      symbol: symbol,
      side: side,
      type: type,
      quantity: qty
    };
    if (type === 'LIMIT') {
      if (!price) throw new Error("Price is required for LIMIT order");
      params.price = price;
      params.timeInForce = 'IOC'; // Aggressive limit orders
    }
    return this.request('POST', '/fapi/v1/order', params);
  }

  async getOrder(symbol, orderId) {
    if (!symbol || !orderId) return null;
    return this.request('GET', '/fapi/v1/order', { symbol, orderId });
  }

  async closePosition(symbol, side, qty) {
    if (!symbol || !side || !qty) throw new Error("Invalid closePosition params");
    const closeSide = (side === 'LONG' || side === 'BUY') ? 'SELL' : 'BUY';
    const params = {
      symbol: symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: qty,
      reduceOnly: 'true'
    };
    return this.request('POST', '/fapi/v1/order', params);
  }

  async setStopLoss(symbol, side, qty, stopPrice) {
    if (!symbol || !side || !qty || !stopPrice) throw new Error("Invalid Stop Loss params");
    const closeSide = (side === 'LONG' || side === 'BUY') ? 'SELL' : 'BUY';
    const params = {
      symbol: symbol,
      side: closeSide,
      algoType: 'CONDITIONAL',
      type: 'STOP_MARKET',
      triggerPrice: stopPrice,
      quantity: qty,
      reduceOnly: 'true'
    };
    return this.request('POST', '/fapi/v1/algoOrder', params);
  }

  async setTakeProfit(symbol, side, qty, tpPrice) {
    if (!symbol || !side || !qty || !tpPrice) throw new Error("Invalid Take Profit params");
    const closeSide = (side === 'LONG' || side === 'BUY') ? 'SELL' : 'BUY';
    const params = {
      symbol: symbol,
      side: closeSide,
      type: 'LIMIT',
      price: tpPrice,
      quantity: qty,
      reduceOnly: 'true',
      timeInForce: 'GTC'
    };
    return this.request('POST', '/fapi/v1/order', params);
  }

  async cancelOrder(symbol, orderId) {
    if (!symbol || !orderId) return;
    try {
      return await this.request('DELETE', '/fapi/v1/order', { symbol, orderId });
    } catch (e) {
      // Ignored if already executed or canceled
    }
  }

  async cancelAlgoOrder(symbol, algoId) {
    if (!symbol || !algoId) return;
    try {
      return await this.request('DELETE', '/fapi/v1/algoOrder', { symbol, algoId });
    } catch (e) {
      // Ignored if already executed or canceled
    }
  }

  async cancelAllOpenOrders(symbol) {
    if (!symbol) return;
    try {
      await this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol });
    } catch (e) {
      // Ignored if no open orders
    }
  }

  async getOpenAlgoOrders(symbol) {
    if (!symbol) return [];
    try {
      return await this.request('GET', '/fapi/v1/openAlgoOrders', { symbol });
    } catch (e) {
      return [];
    }
  }

  async cancelAllAlgoOrders(symbol) {
    if (!symbol) return;
    try {
      const openAlgos = await this.getOpenAlgoOrders(symbol);
      if (Array.isArray(openAlgos)) {
        for (const algo of openAlgos) {
          if (algo.algoId) {
            await this.cancelAlgoOrder(symbol, algo.algoId);
          }
        }
      }
    } catch (e) {
      // Ignored
    }
  }

  async getUserTrades(symbol, limit = 10, startTime = null) {
    if (!symbol) return [];
    try {
      const params = { symbol, limit };
      if (startTime) params.startTime = startTime;
      return await this.request('GET', '/fapi/v1/userTrades', params);
    } catch (e) {
      console.warn(`[USER_TRADES_WARN] Failed to fetch user trades for ${symbol}: ${e.message}`);
      return [];
    }
  }

  async getKlines(symbol, interval, limit = 500) {
    if (!symbol) throw new Error("Symbol missing");
    return this.handleApiError(async () => {
      const response = await this.client.get('/fapi/v1/klines', {
        params: { symbol, interval, limit }
      });
      return response.data.map(k => ({
        startTime: k[0].toString(),
        open: k[1],
        high: k[2],
        low: k[3],
        close: k[4],
        volume: k[5]
      }));
    }, 5, 'GET /fapi/v1/klines');
  }
  
  async getAccountInfo() {
      return this.request('GET', '/fapi/v2/account');
  }

  async getFundingRate(symbol) {
    if (!symbol) return null;
    try {
      const client = this.publicClient || this.client;
      const res = await client.get('/fapi/v1/premiumIndex', {
        params: { symbol },
        timeout: 5000
      });
      if (res && res.data) {
        return {
          symbol: res.data.symbol,
          markPrice: res.data.markPrice,
          lastFundingRate: parseFloat(res.data.lastFundingRate || 0),
          nextFundingTime: res.data.nextFundingTime
        };
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  async getAccountBalances() {
    if (this.cachedBalances && (Date.now() - this.cachedBalancesTime < 10000)) {
      return this.cachedBalances;
    }

    const fetchModeBalance = async (isTestnet) => {
      const apiKey = isTestnet
        ? (process.env.BINANCE_TESTNET_API_KEY || process.env.BINANCE_API_KEY)
        : (process.env.BINANCE_REAL_API_KEY || process.env.BINANCE_API_KEY);
      const apiSecret = isTestnet
        ? (process.env.BINANCE_TESTNET_API_SECRET || process.env.BINANCE_API_SECRET)
        : (process.env.BINANCE_REAL_API_SECRET || process.env.BINANCE_API_SECRET);
      const baseURL = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';

      if (!apiKey || !apiSecret) return null;

      try {
        const timestamp = this.getTimestamp();
        const queryString = `timestamp=${timestamp}&recvWindow=10000`;
        const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
        const url = `${baseURL}/fapi/v2/account?${queryString}&signature=${signature}`;
        const res = await axios.get(url, {
          headers: { 'X-MBX-APIKEY': apiKey },
          httpsAgent: this.agent,
          timeout: 5000
        });
        const usdt = (res.data.assets || []).find(a => a.asset === 'USDT');
        return {
          totalMarginBalance: res.data.totalMarginBalance || '0',
          availableBalance: res.data.availableBalance || '0',
          walletBalance: usdt?.walletBalance || res.data.totalWalletBalance || '0',
          unrealizedProfit: usdt?.unrealizedProfit || res.data.totalUnrealizedProfit || '0'
        };
      } catch (err) {
        return null;
      }
    };

    const [demoBal, realBal] = await Promise.allSettled([
      fetchModeBalance(true),
      fetchModeBalance(false)
    ]);

    this.cachedBalances = {
      DEMO: demoBal.status === 'fulfilled' && demoBal.value ? demoBal.value : (this.cachedBalances?.DEMO || null),
      REAL: realBal.status === 'fulfilled' && realBal.value ? realBal.value : (this.cachedBalances?.REAL || null),
      updatedAt: Date.now()
    };
    this.cachedBalancesTime = Date.now();
    return this.cachedBalances;
  }

  async setLeverage(symbol, leverage) {
    if (!symbol || !leverage) return;
    try {
      const res = await this.request('POST', '/fapi/v1/leverage', {
        symbol: symbol,
        leverage: parseInt(leverage, 10)
      });
      console.log(`[BINANCE_LEVERAGE] Leverage for ${symbol} set to ${res.leverage}x`);
      return res;
    } catch (e) {
      console.warn(`[BINANCE_LEVERAGE_NOTE] Failed to set leverage: ${e.message}`);
    }
  }

  async getTickerPrice(symbol = 'BTCUSDT') {
    if (!symbol) throw new Error("Symbol missing");
    return this.handleApiError(async () => {
      const response = await this.client.get('/fapi/v1/ticker/price', {
        params: { symbol }
      });
      return response.data;
    }, 2, 'GET /fapi/v1/ticker/price');
  }

  async getTopTraderRatio(symbol = 'BTCUSDT', period = '5m') {
    if (!symbol) throw new Error("Symbol missing");
    return this.handleApiError(async () => {
      const response = await this.publicClient.get('/futures/data/topLongShortPositionRatio', {
        params: { symbol, period, limit: 1 }
      });
      if (Array.isArray(response.data) && response.data.length > 0) {
        const item = response.data[0];
        return {
          symbol: item.symbol,
          longAccount: parseFloat(item.longAccount),
          shortAccount: parseFloat(item.shortAccount),
          longShortRatio: parseFloat(item.longShortRatio),
          timestamp: item.timestamp
        };
      }
      return null;
    }, 2, 'GET topLongShortPositionRatio');
  }

  async getTakerRatio(symbol = 'BTCUSDT', period = '5m') {
    if (!symbol) throw new Error("Symbol missing");
    return this.handleApiError(async () => {
      const response = await this.publicClient.get('/futures/data/takerlongshortRatio', {
        params: { symbol, period, limit: 1 }
      });
      if (Array.isArray(response.data) && response.data.length > 0) {
        const item = response.data[0];
        return {
          buyVol: parseFloat(item.buyVol),
          sellVol: parseFloat(item.sellVol),
          buySellRatio: parseFloat(item.buySellRatio),
          timestamp: item.timestamp
        };
      }
      return null;
    }, 2, 'GET takerlongshortRatio');
  }

  async getOpenInterest(symbol = 'BTCUSDT') {
    if (!symbol) throw new Error("Symbol missing");
    return this.handleApiError(async () => {
      const response = await this.publicClient.get('/fapi/v1/openInterest', {
        params: { symbol }
      });
      return {
        symbol: response.data.symbol,
        openInterest: parseFloat(response.data.openInterest),
        time: response.data.time
      };
    }, 2, 'GET openInterest');
  }

  async getOrderBookDepth(symbol = 'BTCUSDT', limit = 20) {
    if (!symbol) throw new Error("Symbol missing");
    if (this.rateLimitBannedUntil && Date.now() < this.rateLimitBannedUntil) {
      return null;
    }
    return this.handleApiError(async () => {
      const client = this.publicClient || this.client;
      const response = await client.get('/fapi/v1/depth', {
        params: { symbol, limit }
      });
      return response.data;
    }, 2, 'GET /fapi/v1/depth').catch(() => null);
  }

  connectWS(symbol, handlers) {
    if (!symbol) throw new Error("Symbol missing for WS");
    const onCandleMsg = typeof handlers === 'function' ? handlers : (handlers?.onCandleMsg || null);
    const onLiquidationMsg = typeof handlers === 'object' ? (handlers?.onLiquidationMsg || null) : null;
    const onAggTradeMsg = typeof handlers === 'object' ? (handlers?.onAggTradeMsg || null) : null;

    const streamName = `${symbol.toLowerCase()}@kline_${strategy.trading.interval}`;

    // Clean up previous socket & timers if any
    if (this.wsHeartbeatTimer) {
      clearInterval(this.wsHeartbeatTimer);
      this.wsHeartbeatTimer = null;
    }
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch (e) {}
      this.ws = null;
    }

    this.lastWsMessageTime = Date.now();
    let isAlive = true;

    try {
      this.ws = new WebSocket(`${this.wsUrl}/${streamName}`, { lookup: dnsResolver.lookup.bind(dnsResolver) });
    } catch (err) {
      console.error(`[WS_INIT_ERR] Failed to initialize WebSocket for ${streamName}:`, err.message);
      this.scheduleWsReconnect(symbol, handlers);
      return;
    }

    this.ws.on('open', () => {
      console.log(`WebSocket connected to ${streamName}`);
      isAlive = true;
      this.lastWsMessageTime = Date.now();
      this.wsBuffer = [];

      // Subscribe to forceOrder and aggTrade on the main socket
      try {
        const subs = [
          `${symbol.toLowerCase()}@forceOrder`,
          `${symbol.toLowerCase()}@aggTrade`
        ];
        this.ws.send(JSON.stringify({
          method: 'SUBSCRIBE',
          params: subs,
          id: 1001
        }));
      } catch (e) {}

      // Heartbeat & Inactivity Watchdog (every 10s)
      this.wsHeartbeatTimer = setInterval(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        
        // Inactivity Watchdog: Kline stream should send ticks multiple times per second
        if (Date.now() - this.lastWsMessageTime > 20000) {
          console.warn(`[WS_WATCHDOG] Inactivity detected (>20s without messages on ${streamName}). Terminating zombie socket...`);
          try { this.ws.terminate(); } catch (e) {}
          return;
        }

        if (isAlive === false) {
          console.warn(`[WS_HEARTBEAT] Ping timeout on ${streamName}. Terminating broken connection...`);
          try { this.ws.terminate(); } catch (e) {}
          return;
        }

        isAlive = false;
        try { this.ws.ping(); } catch (e) {}
      }, 10000);
    });

    this.ws.on('pong', () => {
      isAlive = true;
    });

    this.ws.on('ping', () => {
      isAlive = true;
      try { this.ws.pong(); } catch (e) {}
    });

    this.ws.on('message', (data) => {
      isAlive = true;
      this.lastWsMessageTime = Date.now();
      try {
        const payload = JSON.parse(data);
        if (payload.e === 'kline') {
          this.wsBuffer.push(payload);
          if (this.wsBuffer.length > 50) this.wsBuffer.shift();
          if (onCandleMsg) onCandleMsg(payload);
        } else if (payload.e === 'forceOrder') {
          if (onLiquidationMsg) onLiquidationMsg(payload);
        } else if (payload.e === 'aggTrade') {
          if (onAggTradeMsg) onAggTradeMsg(payload);
        }
      } catch (err) {
        console.error("WS Parse Error", err);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.warn(`WebSocket closed [${code}]: ${reason || 'Connection lost'}. Reconnecting in 2s...`);
      this.scheduleWsReconnect(symbol, handlers);
    });

    this.ws.on('error', (err) => {
      console.error("WebSocket error:", err.message);
      try { this.ws.terminate(); } catch (e) {}
    });

    // On Testnet: Testnet does not produce genuine liquidations or liquid market order flow.
    // Connect an auxiliary read-only listener to Mainnet WebSocket for authentic forceOrder & aggTrade
    if (this.isTestnet && (onLiquidationMsg || onAggTradeMsg)) {
      this.connectAuxiliaryMicrostructureWS(symbol, { onLiquidationMsg, onAggTradeMsg });
    }
  }

  connectAuxiliaryMicrostructureWS(symbol, handlers = {}) {
    if (this.microWs) {
      try {
        this.microWs.removeAllListeners();
        this.microWs.terminate();
      } catch (e) {}
      this.microWs = null;
    }

    const mainnetWsUrl = 'wss://fstream.binance.com/ws';
    try {
      this.microWs = new WebSocket(mainnetWsUrl, { lookup: dnsResolver.lookup.bind(dnsResolver) });
    } catch (e) {
      return;
    }

    this.microWs.on('open', () => {
      console.log(`[MICRO_WS] Connected to Mainnet auxiliary stream for authentic liquidations & CVD.`);
      try {
        this.microWs.send(JSON.stringify({
          method: 'SUBSCRIBE',
          params: [
            `${symbol.toLowerCase()}@forceOrder`,
            `${symbol.toLowerCase()}@aggTrade`
          ],
          id: 2002
        }));
      } catch (err) {}
    });

    this.microWs.on('message', (data) => {
      try {
        const payload = JSON.parse(data);
        if (payload.e === 'forceOrder' && handlers.onLiquidationMsg) {
          handlers.onLiquidationMsg(payload);
        } else if (payload.e === 'aggTrade' && handlers.onAggTradeMsg) {
          handlers.onAggTradeMsg(payload);
        }
      } catch (e) {}
    });

    this.microWs.on('error', () => {
      try { this.microWs.terminate(); } catch (e) {}
    });

    this.microWs.on('close', () => {
      setTimeout(() => {
        if (this.isTestnet) {
          this.connectAuxiliaryMicrostructureWS(symbol, handlers);
        }
      }, 5000);
    });
  }

  scheduleWsReconnect(symbol, handlers, delayMs = 2000) {
    if (this.wsHeartbeatTimer) {
      clearInterval(this.wsHeartbeatTimer);
      this.wsHeartbeatTimer = null;
    }
    if (this.wsReconnectTimer) return; // Already scheduled
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      this.connectWS(symbol, handlers);
    }, delayMs);
  }
}

module.exports = new BinanceService();
