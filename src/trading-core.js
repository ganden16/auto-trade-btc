require('../services/logger');
const Binance = require('../services/binance');
const AI = require('../services/ai');
const News = require('../services/news');
const Indicators = require('../services/indicators');
const Notifier = require('../services/notifier');
const { db, redis } = require('../config/db');
const strategy = require('../config/strategy');
const BigNumber = require('bignumber.js');

// Ensure precision
BigNumber.config({ DECIMAL_PLACES: 8, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });
const EventEmitter = require('events');

class TradingCore extends EventEmitter {
  constructor() {
    super();
    this.symbol = strategy.trading.symbol;
    this.interval = strategy.trading.interval;
    this.isTradingLocked = false;
    this.degradedMode = false;
    this.latestSentiment = { sentiment: 'NEUTRAL', confidence: 0, reason: 'Kondisi makro normal (tidak ada berita berdampak tinggi dalam 45m)' };
    this.newsFailures = 0;
    this.startTime = Date.now();
    this.accountEquity = new BigNumber(1000);
    this.lastPrice = null;
    this.lastPriceTime = 0;
    this.lastTickEmitTime = 0;
    this.lastIndicators = { ema50: null, rsi: null, macdHist: null, atr: null, adx: null, volume: null, volumeSma: null, mtfTrend: null };
    this.latestNewsHeadline = null;
    this.lastAnalyzedHeadline = null;
    this.latestArticles = [];
    this.isUpdatingExchangeSl = false;
    this.isReconciling = false;
    this.isEnsuringPrice = false;
    this.isFetchingWhale = false;
    this.isMonitoringNews = false;
    this.latestWhaleMetrics = {
      topTraderRatio: null,
      longAccount: null,
      shortAccount: null,
      takerBuySellRatio: null,
      takerBuyVol: null,
      takerSellVol: null,
      openInterest: null,
      deltaOi5m: 0,
      deltaOiPct: 0,
      oiRegime: 'NEUTRAL_CONSOLIDATION',
      orderBookImbalance: null,
      bidVolumeTop20: null,
      askVolumeTop20: null,
      orderBookRatio: null,
      latestWhaleAlert: null,
      updatedAt: 0
    };
    this.latestFilterEvaluation = null;
    this.latestAccountBalances = { DEMO: null, REAL: null, updatedAt: 0 };
    this.lastStopLossTime = 0;
    this.latestFundingRate = null;
    this.tpGraceStartTime = null;

    // Real-Time Microstructure Engine (Liquidation, CVD, and Depth)
    this.liquidationEvents = [];
    this.latestLiquidationEvent = null;
    this.latestLiquidationMetrics = {
      longLiq60s: 0,
      shortLiq60s: 0,
      longLiq5m: 0,
      shortLiq5m: 0,
      totalLiq60s: 0,
      totalLiq5m: 0,
      lastEvent: null,
      updatedAt: 0
    };
    this.aggTradeBuffer = [];
    this.lastCvdUpdateTime = 0;
    this.latestCvdMetrics = {
      buyUsd1m: 0,
      sellUsd1m: 0,
      buyUsd5m: 0,
      sellUsd5m: 0,
      cvd1m: 0,
      cvd5m: 0,
      realtimeTakerRatio5m: 1.0,
      realtimeTakerRatio1m: 1.0,
      updatedAt: 0
    };
    this.oiSnapshots = [];
  }

  clearActivePositionFilterState() {
    if (this.latestFilterEvaluation && this.latestFilterEvaluation.verdict === 'IN_POSITION') {
      this.latestFilterEvaluation.verdict = 'NO_SIGNAL_SCANNING';
      this.latestFilterEvaluation.activePosition = null;
      this.latestFilterEvaluation.blockedReasons = [];
      if (this.latestFilterEvaluation.filters && this.latestFilterEvaluation.filters.positionGuard) {
        this.latestFilterEvaluation.filters.positionGuard.passed = true;
        this.latestFilterEvaluation.filters.positionGuard.value = 'Ready (0 Positions)';
        this.latestFilterEvaluation.filters.positionGuard.statusText = 'Pass (Ready for Entry)';
      }
    }
  }

  setLivePrice(price, source = 'BINANCE_WS') {
    if (!price || isNaN(price)) return;
    const numPrice = Number(price);
    const prevPrice = this.lastPrice;
    this.lastPrice = numPrice;
    this.lastPriceTime = Date.now();

    const now = Date.now();
    if (now - this.lastTickEmitTime >= 100 || prevPrice !== numPrice) {
      this.lastTickEmitTime = now;
      this.emit('tick', {
        symbol: this.symbol,
        price: numPrice,
        source: source,
        time: now
      });
    }
  }

  async ensureLivePrice() {
    if (this.isEnsuringPrice) return;
    if (Date.now() - this.lastPriceTime > 5000) {
      this.isEnsuringPrice = true;
      try {
        const ticker = await Binance.getTickerPrice(this.symbol);
        if (ticker && ticker.price) {
          this.setLivePrice(Number(ticker.price), 'BINANCE_REST_FALLBACK');
        }
      } catch (err) {
        // Handled silently
      } finally {
        this.isEnsuringPrice = false;
      }
    }
  }

  onLiquidationMsg(payload) {
    try {
      if (!payload || payload.e !== 'forceOrder' || !payload.o) return;
      const o = payload.o;
      const side = o.S; // 'SELL' = Long liquidated; 'BUY' = Short liquidated
      const qty = parseFloat(o.q || 0);
      const price = parseFloat(o.p || o.ap || this.lastPrice || 0);
      const usdValue = Math.round(qty * price);
      const time = o.T || Date.now();

      const liqEvent = {
        side: side === 'SELL' ? 'LONG_LIQ' : 'SHORT_LIQ',
        symbol: o.s || this.symbol,
        qty: qty,
        price: price,
        usdValue: usdValue,
        time: time
      };

      this.liquidationEvents.push(liqEvent);
      this.latestLiquidationEvent = liqEvent;

      // Keep events within last 10 minutes
      const cutoff = Date.now() - 600000;
      this.liquidationEvents = this.liquidationEvents.filter(e => e.time >= cutoff);

      this.updateLiquidationMetrics();
      this.emit('liquidation', liqEvent);
    } catch (err) {
      // Non-blocking
    }
  }

  updateLiquidationMetrics() {
    const now = Date.now();
    const cutoff60s = now - 60000;
    const cutoff5m = now - 300000;

    let longLiq60s = 0;
    let shortLiq60s = 0;
    let longLiq5m = 0;
    let shortLiq5m = 0;

    for (const ev of this.liquidationEvents) {
      if (ev.time >= cutoff60s) {
        if (ev.side === 'LONG_LIQ') longLiq60s += ev.usdValue;
        else if (ev.side === 'SHORT_LIQ') shortLiq60s += ev.usdValue;
      }
      if (ev.time >= cutoff5m) {
        if (ev.side === 'LONG_LIQ') longLiq5m += ev.usdValue;
        else if (ev.side === 'SHORT_LIQ') shortLiq5m += ev.usdValue;
      }
    }

    this.latestLiquidationMetrics = {
      longLiq60s,
      shortLiq60s,
      longLiq5m,
      shortLiq5m,
      totalLiq60s: longLiq60s + shortLiq60s,
      totalLiq5m: longLiq5m + shortLiq5m,
      lastEvent: this.latestLiquidationEvent,
      updatedAt: now
    };
  }

  onAggTradeMsg(payload) {
    try {
      if (!payload || payload.e !== 'aggTrade') return;
      const qty = parseFloat(payload.q || 0);
      const price = parseFloat(payload.p || 0);
      const isMakerBuyer = payload.m === true; // true = Market Sell, false = Market Buy
      const usd = qty * price;
      const time = payload.T || Date.now();

      this.aggTradeBuffer.push({
        time: time,
        isBuy: !isMakerBuyer,
        usd: usd,
        qty: qty
      });

      const cutoff5m = Date.now() - 300000;
      while (this.aggTradeBuffer.length > 0 && this.aggTradeBuffer[0].time < cutoff5m) {
        this.aggTradeBuffer.shift();
      }

      const now = Date.now();
      if (now - this.lastCvdUpdateTime >= 1000) {
        this.lastCvdUpdateTime = now;
        this.updateCvdMetrics();
      }
    } catch (err) {}
  }

  updateCvdMetrics() {
    const now = Date.now();
    const cutoff1m = now - 60000;
    const cutoff5m = now - 300000;

    let buyUsd1m = 0;
    let sellUsd1m = 0;
    let buyUsd5m = 0;
    let sellUsd5m = 0;

    for (const t of this.aggTradeBuffer) {
      if (t.time >= cutoff1m) {
        if (t.isBuy) buyUsd1m += t.usd;
        else sellUsd1m += t.usd;
      }
      if (t.time >= cutoff5m) {
        if (t.isBuy) buyUsd5m += t.usd;
        else sellUsd5m += t.usd;
      }
    }

    const cvd5m = buyUsd5m - sellUsd5m;
    const cvd1m = buyUsd1m - sellUsd1m;
    const takerRatio5m = sellUsd5m > 0 ? buyUsd5m / sellUsd5m : 1.0;
    const takerRatio1m = sellUsd1m > 0 ? buyUsd1m / sellUsd1m : 1.0;

    this.latestCvdMetrics = {
      buyUsd1m: Math.round(buyUsd1m),
      sellUsd1m: Math.round(sellUsd1m),
      buyUsd5m: Math.round(buyUsd5m),
      sellUsd5m: Math.round(sellUsd5m),
      cvd1m: Math.round(cvd1m),
      cvd5m: Math.round(cvd5m),
      realtimeTakerRatio5m: Number(takerRatio5m.toFixed(2)),
      realtimeTakerRatio1m: Number(takerRatio1m.toFixed(2)),
      updatedAt: now
    };
  }

  async fetchWhaleMetrics() {
    if (this.isFetchingWhale) return this.latestWhaleMetrics;
    this.isFetchingWhale = true;
    try {
      const [topTrader, taker, oi, funding, depth] = await Promise.allSettled([
        Binance.getTopTraderRatio(this.symbol, '5m'),
        Binance.getTakerRatio(this.symbol, '5m'),
        Binance.getOpenInterest(this.symbol),
        Binance.getFundingRate(this.symbol),
        Binance.getOrderBookDepth(this.symbol, 20)
      ]);

      const metrics = Object.assign({}, this.latestWhaleMetrics);
      if (topTrader.status === 'fulfilled' && topTrader.value) {
        metrics.topTraderRatio = topTrader.value.longShortRatio;
        metrics.longAccount = topTrader.value.longAccount;
        metrics.shortAccount = topTrader.value.shortAccount;
      }
      if (taker.status === 'fulfilled' && taker.value) {
        metrics.takerBuySellRatio = taker.value.buySellRatio;
        metrics.takerBuyVol = taker.value.buyVol;
        metrics.takerSellVol = taker.value.sellVol;
      }
      if (oi.status === 'fulfilled' && oi.value) {
        metrics.openInterest = oi.value.openInterest;
        const currentOi = oi.value.openInterest;
        const now = Date.now();
        this.oiSnapshots.push({
          time: now,
          oi: currentOi,
          price: this.lastPrice || 0
        });

        this.oiSnapshots = this.oiSnapshots.filter(s => s.time >= now - 15 * 60 * 1000);

        const target5m = now - 5 * 60 * 1000;
        let closestSnap = null;
        let minDiff = Infinity;
        for (const snap of this.oiSnapshots) {
          const diff = Math.abs(snap.time - target5m);
          if (diff < minDiff && (now - snap.time >= 60000)) {
            minDiff = diff;
            closestSnap = snap;
          }
        }

        if (closestSnap && closestSnap.oi > 0) {
          const deltaOi = currentOi - closestSnap.oi;
          const deltaPct = (deltaOi / closestSnap.oi) * 100;
          const priceDiff = (this.lastPrice || 0) - closestSnap.price;

          metrics.deltaOi5m = Number(deltaOi.toFixed(2));
          metrics.deltaOiPct = Number(deltaPct.toFixed(3));

          if (deltaPct >= 0.15 && priceDiff > 0) {
            metrics.oiRegime = 'BULLISH_EXPANSION';
          } else if (deltaPct <= -0.15 && priceDiff > 0) {
            metrics.oiRegime = 'SHORT_SQUEEZE';
          } else if (deltaPct >= 0.15 && priceDiff < 0) {
            metrics.oiRegime = 'BEARISH_EXPANSION';
          } else if (deltaPct <= -0.15 && priceDiff < 0) {
            metrics.oiRegime = 'LONG_LIQUIDATION';
          } else {
            metrics.oiRegime = 'NEUTRAL_CONSOLIDATION';
          }
        }
      }
      if (funding.status === 'fulfilled' && funding.value) {
        this.latestFundingRate = funding.value.lastFundingRate;
        metrics.fundingRate = funding.value.lastFundingRate;
      }
      if (depth.status === 'fulfilled' && depth.value) {
        const obiData = Indicators.calculateOrderBookImbalance(depth.value);
        if (obiData) {
          metrics.orderBookImbalance = obiData.obi;
          metrics.bidVolumeTop20 = obiData.bidVol;
          metrics.askVolumeTop20 = obiData.askVol;
          metrics.orderBookRatio = obiData.ratio;
        }
      }
      metrics.updatedAt = Date.now();
      this.latestWhaleMetrics = metrics;
      return metrics;
    } catch (err) {
      console.warn('[WHALE_METRICS] Error fetching whale data:', err.message);
      return this.latestWhaleMetrics;
    } finally {
      this.isFetchingWhale = false;
    }
  }

  async start() {
    console.log("Starting Resilient Trading Core...");
    await Binance.syncTime();
    
    // Set leverage on Binance
    await Binance.setLeverage(this.symbol, strategy.trading.leverage || 25);
    
    // Reconciliation on startup
    await this.reconcilePositions();

    // Initial balances fetch
    Binance.getAccountBalances().then(bals => {
      if (bals) this.latestAccountBalances = bals;
    }).catch(() => {});

    // Bootstrap historical data
    await this.bootstrapData();

    // Ensure live price immediately on startup
    await this.ensureLivePrice();

    // Bootstrap initial Whale & Smart Money metrics
    await this.fetchWhaleMetrics();

    // Start WebSocket with multi-stream handlers (Kline, Force Order Liquidation, AggTrade CVD)
    Binance.connectWS(this.symbol, {
      onCandleMsg: this.onWsMessage.bind(this),
      onLiquidationMsg: this.onLiquidationMsg.bind(this),
      onAggTradeMsg: this.onAggTradeMsg.bind(this)
    });
    
    // Start Reconciliation Loop
    setInterval(() => this.reconcilePositions(), strategy.api.reconciliationIntervalMs);

    // Watchdog to guarantee live price is never stale (every 5 seconds)
    setInterval(() => this.ensureLivePrice(), 5000);

    // Start Whale & Smart Money Metrics Loop (every 30 seconds)
    setInterval(() => this.fetchWhaleMetrics(), 30000);

    // Start News Monitoring Loop (5 mins)
    this.monitorNews();
    setInterval(() => this.monitorNews(), 5 * 60 * 1000);

    // Periodic Binance Server Time Synchronization (every 30 mins)
    setInterval(() => Binance.syncTime(), 30 * 60 * 1000);
  }

  async monitorNews() {
      if (this.isMonitoringNews) return;
      this.isMonitoringNews = true;
      try {
          const articles = await News.fetchBinanceAnnouncements();
          this.newsFailures = 0; // reset on success

          if (articles && articles.length > 0) {
              this.latestArticles = articles.slice(0, 100).map(a => {
                  let source = a._feedSource || 'Crypto News';
                  const link = (a.link || '').toLowerCase();
                  const titleUpper = (a.title || '').toUpperCase();

                  if (a.isBinance || a._feedSource === 'Binance' || link.includes('binance') || titleUpper.includes('BINANCE')) {
                      source = 'Binance';
                  } else if (link.includes('coindesk')) {
                      source = 'CoinDesk';
                  } else if (link.includes('decrypt')) {
                      source = 'Decrypt';
                  } else if (link.includes('cointelegraph')) {
                      source = 'Cointelegraph';
                  }

                  return {
                      title: a.title,
                      link: a.link || '#',
                      pubDate: a.isoDate || a.pubDate || new Date().toISOString(),
                      source: source,
                      isBinance: source === 'Binance' || a.isBinance === true || titleUpper.includes('BINANCE'),
                      isMacro: News.macroKeywords.test(a.title),
                      isHalt: strategy.ai.emergencyHaltEnabled === true && News.haltKeywords.test(a.title),
                      isWhale: a.isWhale === true || source === 'Whale Alert'
                  };
              });

              const whaleArticle = articles.find(a => a.isWhale === true);
              if (whaleArticle) {
                  this.latestWhaleMetrics.latestWhaleAlert = {
                      title: whaleArticle.title,
                      pubDate: whaleArticle.isoDate || whaleArticle.pubDate || new Date().toISOString(),
                      source: whaleArticle._feedSource || 'Whale Alert',
                      link: whaleArticle.link || '#'
                  };
              }

              const recentArticles = articles.slice(0, 20); // check latest 20 across all platforms
              if (strategy.ai.emergencyHaltEnabled === true) {
                  for (const article of recentArticles) {
                      if (News.haltKeywords.test(article.title)) {
                          if (this.acknowledgedHaltHeadline === article.title) {
                              continue;
                          }
                          console.error(`[EMERGENCY_HALT] Critical announcement detected: ${article.title}`);
                          this.isTradingLocked = true;
                          this.lastHaltHeadline = article.title;
                          Notifier.sendAlert("EMERGENCY TRADING HALT", `Critical announcement detected: "${article.title}". Trading locked system-wide.`, "ERROR");
                          return;
                      }
                  }
              }

              const maxAge = strategy.ai.maxNewsAgeMinutes || 45;
              const targetArticle = recentArticles.find(a => {
                  const pDate = a.isoDate || a.pubDate;
                  return News.isHighImpactMacro(a.title, pDate);
              });

              if (targetArticle) {
                  const articleDate = targetArticle.isoDate || targetArticle.pubDate;
                  const ageMinutes = Math.round((Date.now() - new Date(articleDate).getTime()) / 60000);
                  this.latestNewsHeadline = targetArticle.title;

                  // Deduplication check: Avoid re-analyzing the same headline and wasting API tokens
                  if (this.lastAnalyzedHeadline === targetArticle.title && this.latestSentiment) {
                      console.log(`[AI_CACHE] Fresh headline unchanged ("${targetArticle.title.substring(0, 45)}..."). Reusing previous sentiment (${this.latestSentiment.sentiment}). No API tokens spent.`);
                      return;
                  }

                  console.log(`[AI_ANALYSIS] Fresh headline detected (${ageMinutes}m ago). Analyzing with SumoPod AI: "${targetArticle.title}"`);
                  const sentiment = await AI.getSentiment(targetArticle.title);
                  this.lastAnalyzedHeadline = targetArticle.title;
                  this.latestSentiment = {
                      ...sentiment,
                      headline: targetArticle.title,
                      pubDate: articleDate,
                      analyzedAt: Date.now()
                  };
                  this.degradedMode = false;
                  console.log(`[AI_SENTIMENT_SUCCESS] Result: ${sentiment.sentiment} (${sentiment.confidence}/10) - ${sentiment.reason}`);
              } else {
                  // No fresh high-impact macro or BTC news detected within maxAge minutes; maintain clean neutral bias
                  if (!this.latestSentiment || this.latestSentiment.sentiment !== 'NEUTRAL' || (this.latestSentiment.confidence && this.latestSentiment.confidence > 0)) {
                      console.log(`[AI_SENTIMENT] No fresh macro headlines within ${maxAge}m. Resetting sentiment to NEUTRAL (clean market).`);
                      this.latestSentiment = { sentiment: 'NEUTRAL', confidence: 0, reason: `No fresh BTC/macro headline within ${maxAge}m` };
                      this.latestNewsHeadline = null;
                      this.lastAnalyzedHeadline = null;
                  }
              }
          }
      } catch (e) {
          console.warn("News monitoring deferred:", e.message);
          this.newsFailures++;
          if (this.newsFailures >= 3) {
              console.warn("News fetching failed repeatedly. Entering Degraded Mode.");
              this.degradedMode = true;
          }
      } finally {
          this.isMonitoringNews = false;
      }
  }

  async reconcilePositions() {
    if (this.isReconciling) return;
    this.isReconciling = true;
    try {
      if (Binance.rateLimitBannedUntil && Date.now() < Binance.rateLimitBannedUntil) {
        const remainingSec = Math.ceil((Binance.rateLimitBannedUntil - Date.now()) / 1000);
        if (!this.lastRateLimitLogTime || (Date.now() - this.lastRateLimitLogTime > 60000)) {
          console.warn(`[RECONCILE_NOTE] Periodic reconciliation paused: Binance rate limit cooldown active (${remainingSec}s remaining). Polling will resume automatically once ban expires.`);
          this.lastRateLimitLogTime = Date.now();
        }
        return;
      }
      const accountInfo = await Binance.getAccountInfo();
      if (accountInfo) {
        const bal = accountInfo.totalMarginBalance || accountInfo.availableBalance;
        if (bal) {
          this.accountEquity = new BigNumber(bal);
        }
      }
      if (!this.latestAccountBalances || (Date.now() - (this.latestAccountBalances.updatedAt || 0) > 20000)) {
        Binance.getAccountBalances().then(bals => {
          if (bals) this.latestAccountBalances = bals;
        }).catch(() => {});
      }
      if (this.isTradingLocked) return;
      const pos = (accountInfo && accountInfo.positions) ? accountInfo.positions.find(p => p.symbol === this.symbol) : null;
      if (!pos && (!accountInfo || !accountInfo.positions)) return;
      
      const currentMode = strategy.api.isTestnet ? 'DEMO' : 'REAL';
      const dbPos = db.prepare('SELECT * FROM active_positions WHERE symbol = ? AND mode = ?').get(this.symbol, currentMode);
      
      const exchangeQty = new BigNumber(pos ? pos.positionAmt : 0);
      const localQty = new BigNumber(dbPos ? dbPos.qty : 0);
      const exchangeSide = exchangeQty.isGreaterThan(0) ? 'LONG' : (exchangeQty.isLessThan(0) ? 'SHORT' : null);
      const localSide = dbPos ? dbPos.side : null;

      const isSynced = (exchangeQty.isZero() && (!dbPos || localQty.isZero())) ||
        (!exchangeQty.isZero() && dbPos && exchangeQty.abs().isEqualTo(localQty.abs()) && exchangeSide === localSide);

      if (!isSynced) {
        console.error(`[CRITICAL] Position Mismatch! Exchange: ${exchangeQty} (${exchangeSide || 'FLAT'}), DB: ${localQty} (${localSide || 'FLAT'}). Prioritizing Exchange.`);
        
        // Sync DB to Exchange
        if (exchangeQty.isZero()) {
            if (this.isReconcilingExit) return;
            this.isReconcilingExit = true;
            try {
              if (dbPos && dbPos.sl_id) {
                await Binance.cancelAlgoOrder(this.symbol, dbPos.sl_id).catch(() => {});
              }
              await Binance.cancelAllAlgoOrders(this.symbol).catch(() => {});
              await Binance.cancelAllOpenOrders(this.symbol).catch(() => {});

              const lastExitPrice = (this.lastPrice || (dbPos ? dbPos.entry_price : '0')).toString();
              const pnlData = await this.calculateNetPnlAndCommission(dbPos, lastExitPrice, dbPos ? dbPos.qty : '0', dbPos ? dbPos.side : 'LONG');
              const finalExitPrice = pnlData.exitPrice || lastExitPrice;

              let wasRecorded = false;
              const insertTx = db.transaction(() => {
                const activeStillExists = db.prepare('SELECT 1 FROM active_positions WHERE symbol = ? AND mode = ?').get(this.symbol, currentMode);
                if (!activeStillExists) return; // Already cleaned up and recorded by closePosition

                if (dbPos) {
                  db.prepare(`
                    INSERT INTO trade_history (id, timestamp, side, price, qty, pnl, commission, mode)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  `).run(Date.now().toString(), Date.now(), dbPos.side === 'LONG' ? 'SELL' : 'BUY', finalExitPrice, dbPos.qty, pnlData.netPnl, pnlData.commission, currentMode);
                }
                db.prepare('DELETE FROM position_fills WHERE position_id = ? AND mode = ?').run(this.symbol, currentMode);
                db.prepare('DELETE FROM active_positions WHERE symbol = ? AND mode = ?').run(this.symbol, currentMode);
                wasRecorded = true;
              });
              insertTx();
              if (wasRecorded) {
                redis.del(`pos:${this.symbol}:${currentMode}`);
                this.clearActivePositionFilterState();
                if (pnlData && new BigNumber(pnlData.netPnl).isNegative()) {
                  this.lastStopLossTime = Date.now();
                }
                this.tpGraceStartTime = null;
                if (dbPos) {
                  Notifier.sendTradeClose({ symbol: this.symbol, side: dbPos.side, qty: dbPos.qty, exitPrice: finalExitPrice, pnl: pnlData.netPnl, commission: pnlData.commission, grossPnl: pnlData.grossPnl, reason: 'EXTERNAL_EXCHANGE_SYNC' });
                }
                console.log(`[CLEANUP_SUCCESS] Position closed externally on Binance. Cleared local database and recorded Net PnL $${pnlData.netPnl} (Fee: -$${pnlData.commission}).`);
              }
            } finally {
              this.isReconcilingExit = false;
            }
        } else {
            const side = exchangeSide;
            const wasDbEmpty = !dbPos;
            const atrVal = (this.lastIndicators && this.lastIndicators.atr) ? this.lastIndicators.atr : 100;
            const { slPrice, tpPrice } = this.calculateSlTp(side, pos.entryPrice, atrVal);
            const currentMode = strategy.api.isTestnet ? 'DEMO' : 'REAL';

            db.prepare(`
                INSERT INTO active_positions (symbol, side, entry_price, qty, sl_price, tp_price, atr_at_entry, updated_at, entry_time, mode) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol, mode) DO UPDATE SET 
                  qty = excluded.qty, 
                  side = excluded.side, 
                  entry_price = excluded.entry_price,
                  sl_price = COALESCE(active_positions.sl_price, excluded.sl_price),
                  tp_price = COALESCE(active_positions.tp_price, excluded.tp_price),
                  atr_at_entry = COALESCE(active_positions.atr_at_entry, excluded.atr_at_entry),
                  entry_time = COALESCE(active_positions.entry_time, excluded.entry_time),
                  updated_at = excluded.updated_at
            `).run(this.symbol, side, pos.entryPrice, exchangeQty.abs().toString(), slPrice, tpPrice, atrVal.toString(), Date.now(), Date.now(), currentMode);
            
            console.log(`[RECONCILE] Synced ${side} position: Entry ${pos.entryPrice}, Qty ${exchangeQty.abs()}, SL ${slPrice}, TP ${tpPrice}`);
            if (wasDbEmpty || !dbPos.sl_id || !dbPos.tp_id) {
              await this.placeExchangeSlTp(side, exchangeQty.abs().toString(), slPrice, tpPrice);
            }

            if (wasDbEmpty) {
              Notifier.sendTradeOpen({
                symbol: this.symbol,
                side: side,
                qty: exchangeQty.abs().toString(),
                price: pos.entryPrice,
                slPrice: slPrice,
                tpPrice: tpPrice,
                leverage: strategy.trading.leverage
              });
            }
        }
      } else if (!exchangeQty.isZero() && dbPos && (!dbPos.sl_id || !dbPos.tp_id)) {
        const atrVal = (this.lastIndicators && this.lastIndicators.atr) ? this.lastIndicators.atr : 100;
        const { slPrice, tpPrice } = this.calculateSlTp(dbPos.side, dbPos.entry_price, atrVal);
        db.prepare('UPDATE active_positions SET sl_price = ?, tp_price = ?, atr_at_entry = ? WHERE symbol = ? AND mode = ?')
          .run(slPrice, tpPrice, atrVal.toString(), this.symbol, currentMode);
        console.log(`[SL/TP_ASSIGNED] Set SL: ${slPrice}, TP: ${tpPrice} for active position`);
        await this.placeExchangeSlTp(dbPos.side, new BigNumber(dbPos.qty).abs().toString(), slPrice, tpPrice);
      }
    } catch (e) {
      const isRateLimit = (e.code === '-1003') || (e.message && e.message.includes('rate limit'));
      if (isRateLimit) {
        const remainingSec = Binance.rateLimitBannedUntil ? Math.ceil((Binance.rateLimitBannedUntil - Date.now()) / 1000) : 60;
        if (!this.lastRateLimitLogTime || (Date.now() - this.lastRateLimitLogTime > 60000)) {
          console.warn(`[RECONCILE_NOTE] Periodic reconciliation paused: Binance rate limit cooldown active (${remainingSec}s remaining). Polling will resume automatically once ban expires.`);
          this.lastRateLimitLogTime = Date.now();
        }
      } else {
        console.warn(`[RECONCILE_NOTE] Periodic reconciliation deferred: ${e.message || 'Transient network error'}. Bot will retry in ${Math.round(strategy.api.reconciliationIntervalMs / 1000)}s.`);
      }
    } finally {
      this.isReconciling = false;
    }
  }

  async bootstrapData() {
    console.log("Bootstrapping historical candles...");
    try {
      const klines = await Binance.getKlines(this.symbol, this.interval, strategy.trading.maxMemoryCandles);
      
      const insert = db.prepare('INSERT OR IGNORE INTO historical_candles (startTime, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?)');
      const insertMany = db.transaction((candles) => {
        for (const c of candles) {
          if (new BigNumber(c.volume).isZero()) continue; // Reject zero volume
          insert.run(c.startTime, c.open, c.high, c.low, c.close, c.volume);
        }
      });
      
      insertMany(klines);
      console.log(`Bootstrapped ${klines.length} candles.`);

      if (klines && klines.length > 0) {
        this.setLivePrice(Number(klines[klines.length - 1].close), 'BOOTSTRAP');
      }
      await this.evaluateTradeLogic();
    } catch (e) {
      console.warn(`[BOOTSTRAP_WARN] Failed to bootstrap historical candles: ${e.message}. Using existing SQLite data & WebSocket.`);
      const countRow = db.prepare('SELECT count(*) as count FROM historical_candles').get();
      if (countRow && countRow.count > 0) {
        console.log(`[BOOTSTRAP_DB] Found ${countRow.count} candles in local SQLite database.`);
        const lastCandle = db.prepare('SELECT close FROM historical_candles ORDER BY CAST(startTime AS INTEGER) DESC LIMIT 1').get();
        if (lastCandle && lastCandle.close) {
          this.setLivePrice(Number(lastCandle.close), 'BOOTSTRAP_DB');
        }
      }
    }
  }

  async onWsMessage(payload) {
    if (this.isTradingLocked) return;
    
    const k = payload.k;
    if (k && k.c) {
      this.setLivePrice(Number(k.c), 'BINANCE_WS');
      await this.evaluatePositionRisk(this.lastPrice);
    }

    if (k.x) { // Candle closed
        try {
           const insert = db.prepare('INSERT OR REPLACE INTO historical_candles (startTime, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?)');
           insert.run(k.t.toString(), k.o, k.h, k.l, k.c, k.v);
           
           await this.evaluateTradeLogic();
        } catch (e) {
            console.error("Error processing WS message", e);
        }
    }
  }
  
  async evaluateTradeLogic() {
      if (this.isTradingLocked) return;
      
      const candles = db.prepare(`SELECT * FROM historical_candles ORDER BY CAST(startTime AS INTEGER) DESC LIMIT ${strategy.trading.maxMemoryCandles}`).all().reverse();
      
      if (candles.length < 100) return; // Need enough data
      
      const closes = candles.map(c => Number(c.close));
      const ema50 = Indicators.calculateEMA(closes, 50);
      const rsi = Indicators.calculateRSI(closes, 14);
      const macd = Indicators.calculateMACD(closes, 12, 26, 9);
      const atr = Indicators.calculateATR(candles, 14);
      
      if (!ema50 || !rsi || !macd || !atr) return;
      
      const lastCandle = candles[candles.length - 1];
      const lastClose = new BigNumber(lastCandle.close);
      const lastOpen = new BigNumber(lastCandle.open);
      const lastHigh = new BigNumber(lastCandle.high);
      const lastLow = new BigNumber(lastCandle.low);
      const isCandleGreen = lastClose.isGreaterThan(lastOpen);
      const isCandleRed = lastClose.isLessThan(lastOpen);
      const lastEma50 = ema50[ema50.length - 1];
      const lastRsi = rsi[rsi.length - 1];
      const lastMacdHist = macd.histogram[macd.histogram.length - 1];
      const currentAtr = atr[atr.length - 1];

      const filterConfig = strategy.trading.filters || {};

      // 1. ADX Calculation (Trend Strength)
      const adxPeriod = filterConfig.adx?.period || 14;
      const adxSeries = Indicators.calculateADX(candles, adxPeriod);
      const currentAdx = adxSeries && adxSeries.length > 0 ? Number(adxSeries[adxSeries.length - 1].toFixed(2)) : null;

      // 2. Volume SMA Calculation (Liquidity Participation)
      const volPeriod = filterConfig.volume?.period || 20;
      const volumes = candles.map(c => Number(c.volume || 0));
      const volSmaSeries = Indicators.calculateSMA(volumes, volPeriod);
      const currentVol = volumes[volumes.length - 1];
      const currentVolSma = volSmaSeries && volSmaSeries.length > 0 ? Number(volSmaSeries[volSmaSeries.length - 1].toFixed(2)) : null;

      // 3. Multi-Timeframe (15m) Trend Confirmation
      const mtfMinutes = filterConfig.multiTimeframe?.higherIntervalMinutes || 15;
      const mtfEmaPeriod = filterConfig.multiTimeframe?.higherEmaPeriod || 25;
      const agg15 = Indicators.aggregateCandles(candles, mtfMinutes);
      let mtfTrend = 'NEUTRAL';
      let mtfEma50 = null;
      if (agg15 && agg15.length >= mtfEmaPeriod) {
        const closes15 = agg15.map(c => Number(c.close));
        const ema15 = Indicators.calculateEMA(closes15, mtfEmaPeriod);
        if (ema15 && ema15.length > 0) {
          mtfEma50 = Number(ema15[ema15.length - 1].toFixed(2));
          const last15Close = closes15[closes15.length - 1];
          mtfTrend = last15Close >= mtfEma50 ? 'BULLISH' : 'BEARISH';
        }
      }

      // 3.5 Support & Resistance Multi-Timeframe Key Levels (Solusi 2: Multi-Horizon S/R)
      const keyLevelsCfg = strategy.trading.keyLevels || {};
      const keyLevelsLookback = keyLevelsCfg.lookbackCandles || 24;
      const macroLookback = keyLevelsCfg.macroLookbackCandles || 96;
      const keyLevels = (agg15 && agg15.length >= 3)
        ? Indicators.calculateSupportResistance(agg15, keyLevelsLookback, macroLookback)
        : Indicators.calculateSupportResistance(candles, keyLevelsLookback, macroLookback);

      let keyLevelSetup = null;
      if (keyLevels) {
        keyLevelSetup = Indicators.evaluateKeyLevelSetup(lastCandle, keyLevels, {
          zoneTolerancePct: keyLevelsCfg.zoneTolerancePct || 0.35,
          minRejectionWickPct: keyLevelsCfg.minRejectionWickPct || 0.25
        });
      }

      // 3.6 Trend Regime & Market Alignment Engine
      const trendRegimeCfg = strategy.trading.trendRegime || {};
      const adxTrendThreshold = trendRegimeCfg.adxTrendThreshold || 20;
      const isTrendingMarket = currentAdx !== null ? currentAdx >= adxTrendThreshold : true;
      const is15mBullish = mtfTrend === 'BULLISH';
      const is15mBearish = mtfTrend === 'BEARISH';
      const is5mBullish = lastClose.isGreaterThan(lastEma50);
      const is5mBearish = lastClose.isLessThan(lastEma50);

      let marketRegime = 'SIDEWAYS_RANGE';
      let trendBias = 'DUAL_DIRECTION'; // 'LONGS_ONLY' | 'SHORTS_ONLY' | 'DUAL_DIRECTION'

      if (is15mBearish && is5mBearish && isTrendingMarket) {
        marketRegime = 'STRONG_BEARISH';
        trendBias = 'SHORTS_ONLY';
      } else if (is15mBullish && is5mBullish && isTrendingMarket) {
        marketRegime = 'STRONG_BULLISH';
        trendBias = 'LONGS_ONLY';
      } else if (is15mBearish) {
        marketRegime = 'MILD_BEARISH';
        trendBias = trendRegimeCfg.strictTrendAlignment !== false ? 'SHORTS_ONLY' : 'BEARISH_BIAS';
      } else if (is15mBullish) {
        marketRegime = 'MILD_BULLISH';
        trendBias = trendRegimeCfg.strictTrendAlignment !== false ? 'LONGS_ONLY' : 'BULLISH_BIAS';
      } else {
        marketRegime = 'SIDEWAYS_RANGE';
        trendBias = 'DUAL_DIRECTION';
      }

      this.setLivePrice(lastClose.toNumber(), 'CANDLE_CLOSE');
      this.lastIndicators = {
        ema50: Number(lastEma50.toFixed(2)),
        rsi: Number(lastRsi.toFixed(2)),
        macdHist: Number(lastMacdHist.toFixed(2)),
        atr: Number(currentAtr.toFixed(2)),
        adx: currentAdx,
        volume: Number(currentVol.toFixed(2)),
        volumeSma: currentVolSma,
        mtfTrend: mtfTrend,
        mtfEma50: mtfEma50,
        marketRegime: marketRegime,
        trendBias: trendBias,
        keyLevels: keyLevels ? {
          support: Number(keyLevels.support.toFixed(2)),
          resistance: Number(keyLevels.resistance.toFixed(2)),
          macroSupport: keyLevels.macroSupport ? Number(keyLevels.macroSupport.toFixed(2)) : Number(keyLevels.support.toFixed(2)),
          macroResistance: keyLevels.macroResistance ? Number(keyLevels.macroResistance.toFixed(2)) : Number(keyLevels.resistance.toFixed(2)),
          midPoint: Number(keyLevels.midPoint.toFixed(2)),
          rangePct: Number(keyLevels.rangePct.toFixed(2))
        } : null,
        keyLevelSetup: keyLevelSetup,
        candle: {
          open: Number(lastOpen.toFixed(2)),
          close: Number(lastClose.toFixed(2)),
          direction: isCandleGreen ? 'GREEN' : (isCandleRed ? 'RED' : 'DOJI'),
          changePct: Number((((lastClose.minus(lastOpen)).dividedBy(lastOpen)).multipliedBy(100)).toFixed(2))
        }
      };

      // 1. Calculate Base Setup: Key Level Sniper (V5) vs Order Flow Reality (V4) vs Legacy Lagging Indicators (V1-V3)
      const isKeyLevelMode = strategy.trading.strategyMode === 'KEY_LEVEL_SNIPER' || strategy.trading.keyLevels?.enabled;
      const isRealityMode = strategy.trading.strategyMode === 'ORDER_FLOW_REALITY' || strategy.trading.strategyMode === 'ORDER_FLOW_SNIPER' || (!isKeyLevelMode && strategy.trading.realityEngine?.enabled);
      const realityCfg = strategy.trading.realityEngine || {};
      const minTakerLong = realityCfg.minTakerBuySellRatioLong || 1.15;
      const maxTakerShort = realityCfg.maxTakerBuySellRatioShort || 0.85;
      const requireCandle = realityCfg.requireCandleConfirmation !== false;

      // Real-Time CVD vs Historical REST Taker Flow
      const hasCvd = this.latestCvdMetrics && (this.latestCvdMetrics.buyUsd5m + this.latestCvdMetrics.sellUsd5m) > 10000;
      const effectiveTakerRatio = hasCvd ? this.latestCvdMetrics.realtimeTakerRatio5m : (this.latestWhaleMetrics?.takerBuySellRatio ?? null);
      const takerRatio = effectiveTakerRatio !== null && !isNaN(effectiveTakerRatio) ? effectiveTakerRatio : (this.latestWhaleMetrics?.takerBuySellRatio ?? null);
      const hasValidTakerRatio = takerRatio !== null && takerRatio !== undefined && !isNaN(takerRatio);

      let baseLong = false;
      let baseShort = false;
      let signalType = 'NEUTRAL';
      const blockedReasons = [];

      if (isKeyLevelMode) {
        // V5 Key Level Sniper: Multi-Timeframe (15m) Support & Resistance + Trend Regime Confluence
        const isTestingSupport = keyLevelSetup && keyLevelSetup.isAtSupport;
        const isTestingResistance = keyLevelSetup && keyLevelSetup.isAtResistance;
        const strictTrend = trendRegimeCfg.strictTrendAlignment !== false;

        if (isTestingSupport) {
          // If trend is Bearish (SHORTS_ONLY), DO NOT BUY SUPPORT (suicidal knife catch)
          if (strictTrend && trendBias === 'SHORTS_ONLY') {
            signalType = 'NEUTRAL';
            blockedReasons.push(`Harga di Support ($${keyLevels?.support.toFixed(1)}), tetapi Trend Makro adalah BEARISH (${marketRegime}). DILARANG entry LONG melawan arus tren turun.`);
            // Check for breakdown continuation SHORT
            if (trendRegimeCfg.allowBreakoutEntries && (keyLevelSetup?.isBreakdown || (hasValidTakerRatio && takerRatio <= (trendRegimeCfg.breakdownSellTakerRatio || 0.85) && isCandleRed))) {
              signalType = 'SHORT';
              baseShort = true;
              console.log(`[TREND_BREAKDOWN] 5m Bearish Breakdown detected @ $${lastClose.toFixed(1)} below Support (Taker: ${takerRatio ? takerRatio.toFixed(2) : 'N/A'}, Candle: RED). Opening SHORT with trend!`);
            }
          } else {
            // Trend is Bullish or Sideways: Normal Support Bounce
            signalType = 'LONG';
            const hasConfirm = !keyLevelsCfg.requireConfirmation || (keyLevelSetup && keyLevelSetup.hasBullishRejection);
            const takerAllowed = !hasValidTakerRatio || takerRatio >= 0.60;
            baseLong = hasConfirm && takerAllowed;

            if (!hasConfirm) {
              blockedReasons.push(`Harga di Support ($${keyLevels?.support.toFixed(1)}), namun belum ada konfirmasi pantulan / lower wick rejection >= ${Math.round((keyLevelsCfg.minRejectionWickPct || 0.25) * 100)}%.`);
            }
            if (!takerAllowed) {
              blockedReasons.push(`Harga di Support ($${keyLevels?.support.toFixed(1)}), namun Taker Sell sangat agresif (${takerRatio.toFixed(2)} < 0.60). Risiko breakdown support.`);
            }
          }
        } else if (isTestingResistance) {
          // If trend is Bullish (LONGS_ONLY), DO NOT SHORT RESISTANCE (suicidal short squeeze)
          if (strictTrend && trendBias === 'LONGS_ONLY') {
            signalType = 'NEUTRAL';
            blockedReasons.push(`Harga di Resistance ($${keyLevels?.resistance.toFixed(1)}), tetapi Trend Makro adalah BULLISH (${marketRegime}). DILARANG entry SHORT melawan arus tren naik.`);
            // Check for breakout continuation LONG
            if (trendRegimeCfg.allowBreakoutEntries && (keyLevelSetup?.isBreakout || (hasValidTakerRatio && takerRatio >= (trendRegimeCfg.breakoutBuyTakerRatio || 1.15) && isCandleGreen))) {
              signalType = 'LONG';
              baseLong = true;
              console.log(`[TREND_BREAKOUT] 5m Bullish Breakout detected @ $${lastClose.toFixed(1)} above Resistance (Taker: ${takerRatio ? takerRatio.toFixed(2) : 'N/A'}, Candle: GREEN). Opening LONG with trend!`);
            }
          } else {
            // Trend is Bearish or Sideways: Normal Resistance Rejection
            signalType = 'SHORT';
            const hasConfirm = !keyLevelsCfg.requireConfirmation || (keyLevelSetup && keyLevelSetup.hasBearishRejection);
            const takerAllowed = !hasValidTakerRatio || takerRatio <= 1.65;
            baseShort = hasConfirm && takerAllowed;

            if (!hasConfirm) {
              blockedReasons.push(`Harga di Resistance ($${keyLevels?.resistance.toFixed(1)}), namun belum ada konfirmasi penolakan / upper wick rejection >= ${Math.round((keyLevelsCfg.minRejectionWickPct || 0.25) * 100)}%.`);
            }
            if (!takerAllowed) {
              blockedReasons.push(`Harga di Resistance ($${keyLevels?.resistance.toFixed(1)}), namun Taker Buy sangat agresif (${takerRatio.toFixed(2)} > 1.65). Risiko breakout resistance.`);
            }
          }
        } else {
          // Mid-Range: Check for Pullback / Retest in direction of strong trend
          if (trendRegimeCfg.allowBreakoutEntries && strictTrend && trendBias === 'SHORTS_ONLY') {
            const emaRef = mtfEma50 || (lastEma50 ? lastEma50.toNumber() : null);
            const isNearEma = emaRef && lastHigh && (Math.abs(lastHigh.toNumber() - emaRef) / emaRef < 0.004);
            if (isNearEma && hasValidTakerRatio && takerRatio <= 0.85 && isCandleRed) {
              signalType = 'SHORT';
              baseShort = true;
              console.log(`[TREND_PULLBACK] 5m Bearish Pullback Retest of EMA detected @ $${lastClose.toFixed(1)} (Taker: ${takerRatio.toFixed(2)}, Candle: RED). Opening SHORT with trend!`);
            }
          } else if (trendRegimeCfg.allowBreakoutEntries && strictTrend && trendBias === 'LONGS_ONLY') {
            const emaRef = mtfEma50 || (lastEma50 ? lastEma50.toNumber() : null);
            const isNearEma = emaRef && lastLow && (Math.abs(lastLow.toNumber() - emaRef) / emaRef < 0.004);
            if (isNearEma && hasValidTakerRatio && takerRatio >= 1.15 && isCandleGreen) {
              signalType = 'LONG';
              baseLong = true;
              console.log(`[TREND_PULLBACK] 5m Bullish Pullback Retest of EMA detected @ $${lastClose.toFixed(1)} (Taker: ${takerRatio.toFixed(2)}, Candle: GREEN). Opening LONG with trend!`);
            }
          }

          if (!baseLong && !baseShort) {
            signalType = 'NEUTRAL';
            const supText = keyLevels ? `$${keyLevels.support.toFixed(1)}` : 'N/A';
            const resText = keyLevels ? `$${keyLevels.resistance.toFixed(1)}` : 'N/A';
            blockedReasons.push(`Harga $${lastClose.toFixed(1)} berada di zona netral (Support: ${supText} | Resisten: ${resText} | Regime: ${marketRegime}). Menunggu setup searah tren.`);
          }
        }
      } else if (isRealityMode) {
        // Pure Market Reality Order Flow Engine:
        // Entry driven by aggressive taker order flow imbalance confirmed by candle completion
        if (hasValidTakerRatio) {
          const takerLongActive = takerRatio >= minTakerLong;
          const takerShortActive = takerRatio <= maxTakerShort;
          if (takerLongActive) signalType = 'LONG';
          else if (takerShortActive) signalType = 'SHORT';

          baseLong = takerLongActive && (!requireCandle || isCandleGreen);
          baseShort = takerShortActive && (!requireCandle || isCandleRed);

          if (takerLongActive && requireCandle && !isCandleGreen) {
            blockedReasons.push(`Taker Buy Dominan (${takerRatio.toFixed(2)} >= ${minTakerLong}) terdeteksi, namun Candle ${isCandleRed ? 'Merah' : 'Doji'} (Absorpsi Iceberg Sell). Menolak entry long semu.`);
          } else if (takerShortActive && requireCandle && !isCandleRed) {
            blockedReasons.push(`Taker Sell Dominan (${takerRatio.toFixed(2)} <= ${maxTakerShort}) terdeteksi, namun Candle ${isCandleGreen ? 'Hijau' : 'Doji'} (Absorpsi Iceberg Buy). Menolak entry short semu.`);
          }
        }
      } else {
        // Legacy Multi-Indicator Trend Follower (V1-V3):
        baseLong = lastClose.isGreaterThan(lastEma50) && lastMacdHist.isGreaterThan(0) && lastRsi.isLessThan(65);
        baseShort = lastClose.isLessThan(lastEma50) && lastMacdHist.isLessThan(0) && lastRsi.isGreaterThan(35);
        signalType = baseLong ? 'LONG' : (baseShort ? 'SHORT' : 'NEUTRAL');
      }

      // 2. Active Position Check (Single Concurrent Position)
      const currentMode = strategy.api.isTestnet ? 'DEMO' : 'REAL';
      const activePos = db.prepare('SELECT * FROM active_positions WHERE symbol = ? AND mode = ?').get(this.symbol, currentMode);

      // 3. Sniper Filter 1: ADX Trend Strength Filter
      const adxThreshold = filterConfig.adx?.threshold || 15;
      const adxMaxRange = filterConfig.adx?.maxRangeThreshold || 38;
      let adxPassed = true;
      if (filterConfig.adx?.enabled && currentAdx !== null) {
        if (isKeyLevelMode) {
          // Key Level Sniper mode trades range bounces between S/R. Low ADX indicates healthy consolidation.
          // High ADX (> 38) indicates extreme runaway trend blowout / falling knife breakdown.
          adxPassed = currentAdx <= adxMaxRange;
        } else {
          // Trend following / momentum mode requires active directional trend
          adxPassed = currentAdx >= adxThreshold;
        }
      }

      // 4. Sniper Filter 2: Volume Participation Filter
      const volMultiplier = filterConfig.volume?.minMultiplier ?? 1.00;
      const minVolRequired = currentVolSma !== null ? currentVolSma * volMultiplier : null;
      const volPassed = !filterConfig.volume?.enabled || (currentVolSma !== null && currentVol >= minVolRequired);

      // 5. Sniper Filter 3: Multi-Timeframe (15m) Trend & Key Level Confluence Filter
      let mtfPassed = true;
      if (filterConfig.multiTimeframe?.enabled) {
        if (isKeyLevelMode) {
          const strictTrend = trendRegimeCfg.strictTrendAlignment !== false;
          if (strictTrend) {
            if (baseLong && mtfTrend === 'BEARISH') {
              mtfPassed = false;
              blockedReasons.push(`Multi-Timeframe 15m Trend adalah BEARISH (${mtfTrend}). Entry LONG diblokir demi memproteksi modal dari pisau jatuh.`);
            } else if (baseShort && mtfTrend === 'BULLISH') {
              mtfPassed = false;
              blockedReasons.push(`Multi-Timeframe 15m Trend adalah BULLISH (${mtfTrend}). Entry SHORT diblokir demi memproteksi modal dari lonjakan breakout.`);
            } else {
              const hasConfirm = baseLong
                ? (!keyLevelsCfg.requireConfirmation || (keyLevelSetup && keyLevelSetup.hasBullishRejection) || keyLevelSetup?.isBreakout)
                : (baseShort ? (!keyLevelsCfg.requireConfirmation || (keyLevelSetup && keyLevelSetup.hasBearishRejection) || keyLevelSetup?.isBreakdown) : true);
              mtfPassed = hasConfirm;
            }
          } else {
            const hasConfirm = baseLong
              ? (!keyLevelsCfg.requireConfirmation || (keyLevelSetup && keyLevelSetup.hasBullishRejection))
              : (baseShort ? (!keyLevelsCfg.requireConfirmation || (keyLevelSetup && keyLevelSetup.hasBearishRejection)) : true);
            mtfPassed = hasConfirm;
          }
        } else {
          // Trend following mode: strict EMA trend alignment required
          if (baseLong && mtfTrend !== 'BULLISH') mtfPassed = false;
          else if (baseShort && mtfTrend !== 'BEARISH') mtfPassed = false;
          else if (!baseLong && !baseShort) mtfPassed = (mtfTrend === 'BULLISH' || mtfTrend === 'BEARISH');
        }
      }

      // 6. Sniper Filter 4: Top Trader Long/Short Position Ratio (Whale Positioning)
      const whaleConfig = filterConfig.whale || {};
      const ttRatio = this.latestWhaleMetrics?.topTraderRatio;
      const minLong = whaleConfig.topTraderRatio?.minLongThreshold || 0.85;
      const maxShort = isKeyLevelMode
        ? (whaleConfig.topTraderRatio?.keyLevelMaxShortThreshold || 2.25)
        : (whaleConfig.topTraderRatio?.maxShortThreshold || 1.80);
      let ttPassed = true;
      if (whaleConfig.enabled && whaleConfig.topTraderRatio?.enabled && ttRatio !== null && ttRatio !== undefined && !isNaN(ttRatio)) {
        if (baseLong && ttRatio < minLong) ttPassed = false;
        else if (baseShort && ttRatio > maxShort) ttPassed = false;
        else if (!baseLong && !baseShort) ttPassed = (ttRatio >= minLong && ttRatio <= maxShort);
      }

      // 7. Sniper Filter 5: Taker Buy/Sell Order Flow Ratio (Market Aggression)
      let takerPassed = true;
      const minLongTaker = isKeyLevelMode
        ? (whaleConfig.takerVolumeRatio?.keyLevelMinLong || 0.85)
        : (isRealityMode ? minTakerLong : (whaleConfig.takerVolumeRatio?.minBuySellRatioForLong || 1.15));
      const maxShortTaker = isKeyLevelMode
        ? (whaleConfig.takerVolumeRatio?.keyLevelMaxShort || 1.15)
        : (isRealityMode ? maxTakerShort : (whaleConfig.takerVolumeRatio?.maxBuySellRatioForShort || 0.85));
      if (isRealityMode) {
        takerPassed = hasValidTakerRatio && (baseLong ? takerRatio >= minTakerLong : (baseShort ? takerRatio <= maxTakerShort : true));
      } else if (whaleConfig.enabled && whaleConfig.takerVolumeRatio?.enabled && hasValidTakerRatio) {
        if (baseLong && takerRatio < minLongTaker) takerPassed = false;
        else if (baseShort && takerRatio > maxShortTaker) takerPassed = false;
        else if (!baseLong && !baseShort) takerPassed = (takerRatio >= minLongTaker && takerRatio <= maxShortTaker);
      }

      // 8. AI Macro Sentiment Veto & Directional Confluence (SumoPod AI)
      let aiSentiment = this.degradedMode ? { sentiment: 'NEUTRAL', confidence: 0 } : this.latestSentiment;
      let aiPassed = true;
      let aiConfluenceNote = 'Netral';
      if (!this.degradedMode && aiSentiment) {
        const minVetoConf = strategy.ai.minVetoConfidence || 7;
        const conf = aiSentiment.confidence || 0;
        if (baseLong && aiSentiment.sentiment === 'BEARISH' && conf >= minVetoConf) {
          aiPassed = false;
          aiConfluenceNote = `Veto BEARISH (${conf}/10)`;
        } else if (baseShort && aiSentiment.sentiment === 'BULLISH' && conf >= minVetoConf) {
          aiPassed = false;
          aiConfluenceNote = `Veto BULLISH (${conf}/10)`;
        } else if (baseLong && aiSentiment.sentiment === 'BULLISH') {
          aiConfluenceNote = `Katalis Bullish (${conf}/10)`;
        } else if (baseShort && aiSentiment.sentiment === 'BEARISH') {
          aiConfluenceNote = `Katalis Bearish (${conf}/10)`;
        } else {
          aiConfluenceNote = `Netral / Aman (${conf}/10)`;
        }
      }

      // 9. Sniper Filter 6: Funding Rate Guard
      const fundingConfig = filterConfig.fundingRate || {};
      let fundingPassed = true;
      if (fundingConfig.enabled && this.latestFundingRate !== undefined && this.latestFundingRate !== null) {
        const maxRate = fundingConfig.maxAbsoluteRate || 0.0004;
        if (baseLong && this.latestFundingRate > maxRate) fundingPassed = false;
        else if (baseShort && this.latestFundingRate < -maxRate) fundingPassed = false;
      }

      // 10. Sniper Filter 7: RSI Exhaustion Guard (Anti-Selling-Bottom & Anti-Buying-Top)
      const rsiConfig = filterConfig.rsi || {};
      let rsiPassed = true;
      const maxLongRsi = rsiConfig.maxLongRsi || 65;
      const minShortRsi = rsiConfig.minShortRsi || 35;
      if (rsiConfig.enabled && lastRsi) {
        if (baseLong && lastRsi.isGreaterThan(maxLongRsi)) rsiPassed = false;
        else if (baseShort && lastRsi.isLessThan(minShortRsi)) rsiPassed = false;
        else if (!baseLong && !baseShort) rsiPassed = (lastRsi.gte(minShortRsi) && lastRsi.lte(maxLongRsi));
      }

      // 11. Sniper Filter 8: Liquidation Cascade & Exhaustion Guard
      const liqConfig = filterConfig.liquidation || {};
      let liqPassed = true;
      let liqNote = 'Tenang / Normal';
      const maxLiq60s = liqConfig.maxCascadeUsd60s || 150000;
      const minExhaustion5m = liqConfig.minExhaustionUsd5m || 250000;
      const calm60s = liqConfig.exhaustionCalmUsd60s || 30000;

      const longLiq60s = this.latestLiquidationMetrics?.longLiq60s || 0;
      const shortLiq60s = this.latestLiquidationMetrics?.shortLiq60s || 0;
      const longLiq5m = this.latestLiquidationMetrics?.longLiq5m || 0;
      const shortLiq5m = this.latestLiquidationMetrics?.shortLiq5m || 0;

      if (liqConfig.enabled) {
        if (baseLong) {
          if (longLiq60s >= maxLiq60s) {
            liqPassed = false;
            liqNote = `Badai Likuidasi Long ($${Math.round(longLiq60s / 1000)}k / 60s)`;
            blockedReasons.push(`Badai likuidasi Long aktif ($${Math.round(longLiq60s / 1000)}k USD / 60s). Bahaya pisau jatuh (falling knife), menunggu kaskade mereda.`);
          } else if (longLiq5m >= minExhaustion5m && longLiq60s <= calm60s) {
            liqNote = `Exhaustion Reversal ($${Math.round(longLiq5m / 1000)}k 5m)`;
          }
        } else if (baseShort) {
          if (shortLiq60s >= maxLiq60s) {
            liqPassed = false;
            liqNote = `Badai Likuidasi Short ($${Math.round(shortLiq60s / 1000)}k / 60s)`;
            blockedReasons.push(`Badai likuidasi Short aktif ($${Math.round(shortLiq60s / 1000)}k USD / 60s). Bahaya short squeeze spike, menunggu kaskade mereda.`);
          } else if (shortLiq5m >= minExhaustion5m && shortLiq60s <= calm60s) {
            liqNote = `Exhaustion Reversal ($${Math.round(shortLiq5m / 1000)}k 5m)`;
          }
        }
      }

      // 12. Sniper Filter 9: Order Book Imbalance Guard (Top 20 Depth)
      const obConfig = filterConfig.orderBook || {};
      let obPassed = true;
      const currentObi = this.latestWhaleMetrics?.orderBookImbalance;
      const minLongObi = obConfig.minLongObi || 0.40;
      const maxShortObi = obConfig.maxShortObi || 0.60;

      if (obConfig.enabled && currentObi !== null && currentObi !== undefined) {
        if (baseLong && currentObi < minLongObi) {
          obPassed = false;
          blockedReasons.push(`Order Book Imbalance Asks dominan (Bids ${(currentObi * 100).toFixed(0)}% < ${minLongObi * 100}%). Tembok jual menekan support.`);
        } else if (baseShort && currentObi > maxShortObi) {
          obPassed = false;
          blockedReasons.push(`Order Book Imbalance Bids dominan (Bids ${(currentObi * 100).toFixed(0)}% > ${maxShortObi * 100}%). Tembok beli menahan resisten.`);
        }
      }

      // 13. Sniper Filter 10: Real-time Delta Open Interest (ΔOI) Guard
      const oiConfig = filterConfig.openInterestDelta || {};
      let oiDeltaPassed = true;
      const oiRegime = this.latestWhaleMetrics?.oiRegime || 'NEUTRAL_CONSOLIDATION';
      const deltaOiPct = this.latestWhaleMetrics?.deltaOiPct || 0;

      if (oiConfig.enabled) {
        if (baseLong && oiRegime === 'LONG_LIQUIDATION' && longLiq60s >= maxLiq60s) {
          oiDeltaPassed = false;
          blockedReasons.push(`OI Delta negatif (${deltaOiPct.toFixed(2)}%) menandakan kapitulasi likuidasi long masih berlangsung.`);
        } else if (baseShort && oiRegime === 'SHORT_SQUEEZE' && shortLiq60s >= maxLiq60s) {
          oiDeltaPassed = false;
          blockedReasons.push(`OI Delta negatif (${deltaOiPct.toFixed(2)}%) menandakan short squeeze paksa masih berlangsung.`);
        }
      }

      // 14. Risk & Kill Switch Check
      const riskPassed = this.checkKillSwitches() && !this.isTradingLocked;

      if (activePos) {
        blockedReasons.push(`Active position running (${activePos.side} ${activePos.qty} BTC @ $${activePos.entry_price}). Single Concurrent Position rule.`);
      }
      if (baseLong || baseShort || (isRealityMode && signalType !== 'NEUTRAL') || (isKeyLevelMode && signalType !== 'NEUTRAL')) {
        if (!adxPassed) {
          if (isKeyLevelMode) {
            blockedReasons.push(`ADX (${currentAdx ?? 'N/A'}) > ceiling ${adxMaxRange}. Pasar sedang breakout runaway ekstrem, risiko support breakdown / resistance breakout.`);
          } else {
            blockedReasons.push(`ADX (${currentAdx ?? 'N/A'}) < threshold ${adxThreshold}. Sideways / choppy market condition.`);
          }
        }
        if (!rsiPassed) {
          blockedReasons.push(`RSI (${lastRsi ? lastRsi.toFixed(1) : 'N/A'}) exhaustion: ${baseLong ? `Overbought > ${maxLongRsi}` : `Oversold < ${minShortRsi}`}. Pullback reversal risk.`);
        }
        if (!volPassed) {
          blockedReasons.push(`Volume (${currentVol.toFixed(1)}) < minimum ${minVolRequired ? minVolRequired.toFixed(1) : 'N/A'} (${Math.round(volMultiplier * 100)}% of SMA 20 ${currentVolSma ?? 'N/A'}). Fakeout risk.`);
        }
        if (!mtfPassed) {
          if (isKeyLevelMode) {
            blockedReasons.push(`Multi-Timeframe 15m Key Level setup: Konfirmasi pantulan / wick rejection di level kunci 15m belum memadai.`);
          } else {
            blockedReasons.push(`Multi-Timeframe 15m trend (${mtfTrend}) contradicts 5m ${signalType} setup. Rejecting counter-trend entry.`);
          }
        }
        if (!ttPassed) {
          blockedReasons.push(`Whale Top Trader L/S Ratio (${ttRatio ? ttRatio.toFixed(2) : 'N/A'}) outside safe bounds [${minLong} - ${maxShort}].`);
        }
        if (!takerPassed) {
          blockedReasons.push(`Taker Order Flow Ratio (${takerRatio ? takerRatio.toFixed(2) : 'N/A'}) outside safe bounds [${minLongTaker} - ${maxShortTaker}].`);
        }
        if (!fundingPassed) {
          blockedReasons.push(`Funding Rate (${(this.latestFundingRate * 100).toFixed(4)}%) exceeded threshold (+/- ${(fundingConfig.maxAbsoluteRate * 100).toFixed(4)}%). Settlement fee risk.`);
        }
        if (!aiPassed) {
          blockedReasons.push(`SumoPod AI Macro Veto active: Sentimen berita ${aiSentiment.sentiment} (${aiSentiment.confidence}/10) berlawanan dengan setup ${signalType}.`);
        }
        if (!riskPassed) {
          blockedReasons.push(`Account risk kill switch or daily drawdown protection is locked.`);
        }
      }

      // 14.5 Solusi 3: Dynamic Confluence Scoring Engine & Hard Safety Vetoes
      const confluenceCfg = strategy.trading.confluence || {};
      const useConfluence = confluenceCfg.enabled !== false;
      const minConfluenceScore = confluenceCfg.minScore || 70;

      // Hard safety vetoes that unconditionally block trades (regardless of score)
      const hardVetoReasons = [];
      if (activePos) {
        hardVetoReasons.push(`Active position running (${activePos.side} ${activePos.qty} BTC @ $${activePos.entry_price}). Single Concurrent Position rule.`);
      }
      if (!riskPassed) {
        hardVetoReasons.push(`Account risk kill switch or daily drawdown protection is locked.`);
      }
      if (baseLong && longLiq60s >= maxLiq60s) {
        hardVetoReasons.push(`Badai likuidasi Long aktif ($${Math.round(longLiq60s / 1000)}k USD / 60s). Bahaya falling knife.`);
      } else if (baseShort && shortLiq60s >= maxLiq60s) {
        hardVetoReasons.push(`Badai likuidasi Short aktif ($${Math.round(shortLiq60s / 1000)}k USD / 60s). Bahaya short squeeze.`);
      }
      if (isKeyLevelMode && currentAdx !== null && currentAdx > adxMaxRange) {
        hardVetoReasons.push(`ADX (${currentAdx}) melampaui batas ceiling anti-blowout ${adxMaxRange}. Pasar runaway ekstrem.`);
      }
      if (!this.degradedMode && aiSentiment && aiSentiment.confidence >= 8) {
        if (baseLong && aiSentiment.sentiment === 'BEARISH') {
          hardVetoReasons.push(`SumoPod AI Hard Veto: Sentimen BEARISH kuat (${aiSentiment.confidence}/10).`);
        } else if (baseShort && aiSentiment.sentiment === 'BULLISH') {
          hardVetoReasons.push(`SumoPod AI Hard Veto: Sentimen BULLISH kuat (${aiSentiment.confidence}/10).`);
        }
      }

      // Confluence Scoring Calculation (Max 100 Points)
      let confluenceScore = 0;
      const scoreBreakdown = {};

      if (baseLong || baseShort || (isRealityMode && signalType !== 'NEUTRAL') || (isKeyLevelMode && signalType !== 'NEUTRAL')) {
        // 1. Key Level Location & Rejection Wick Quality (Max 25 pts)
        let keyLevelScore = 0;
        if (isKeyLevelMode && keyLevelSetup) {
          if (keyLevelSetup.isMacroLevel && (keyLevelSetup.hasBullishRejection || keyLevelSetup.hasBearishRejection)) {
            keyLevelScore = 25; // 24h Macro S/R test with confirmed rejection wick
          } else if (keyLevelSetup.isAtSupport || keyLevelSetup.isAtResistance) {
            if (keyLevelSetup.hasBullishRejection || keyLevelSetup.hasBearishRejection) {
              keyLevelScore = 20; // Tactical 6h S/R test with confirmed rejection wick
            } else {
              keyLevelScore = 15; // At S/R with moderate wick or reversal
            }
          } else if (keyLevelSetup.isBreakout || keyLevelSetup.isBreakdown) {
            keyLevelScore = 20; // Trend continuation breakout/breakdown
          }
        } else if (isRealityMode) {
          keyLevelScore = 20;
        }
        scoreBreakdown.keyLevel = keyLevelScore;
        confluenceScore += keyLevelScore;

        // 2. Order Flow Aggression / Taker Ratio (Max 20 pts)
        let takerScore = 0;
        if (hasValidTakerRatio) {
          if (baseLong && takerRatio >= (whaleConfig.takerVolumeRatio?.minBuySellRatioForLong || 1.15)) takerScore = 20;
          else if (baseShort && takerRatio <= (whaleConfig.takerVolumeRatio?.maxBuySellRatioForShort || 0.85)) takerScore = 20;
          else if (baseLong && takerRatio >= (whaleConfig.takerVolumeRatio?.keyLevelMinLong || 0.85)) takerScore = 15;
          else if (baseShort && takerRatio <= (whaleConfig.takerVolumeRatio?.keyLevelMaxShort || 1.15)) takerScore = 15;
          else if (baseLong && takerRatio >= 0.70) takerScore = 10;
          else if (baseShort && takerRatio <= 1.30) takerScore = 10;
        } else {
          takerScore = 10;
        }
        scoreBreakdown.takerFlow = takerScore;
        confluenceScore += takerScore;

        // 3. Order Book Depth Imbalance (OBI Top 20) (Max 15 pts)
        let obScore = 0;
        if (currentObi !== null && currentObi !== undefined) {
          if (baseLong && currentObi >= 0.50) obScore = 15;
          else if (baseShort && currentObi <= 0.50) obScore = 15;
          else if (baseLong && currentObi >= minLongObi) obScore = 10;
          else if (baseShort && currentObi <= maxShortObi) obScore = 10;
        } else {
          obScore = 10;
        }
        scoreBreakdown.orderBook = obScore;
        confluenceScore += obScore;

        // 4. Whale Top Trader Position Ratio (Max 10 pts)
        let whaleScore = 0;
        if (ttRatio !== null && !isNaN(ttRatio)) {
          if (baseLong && ttRatio >= 1.0 && ttRatio <= 1.80) whaleScore = 10;
          else if (baseShort && ttRatio <= 1.60) whaleScore = 10;
          else if (baseLong && ttRatio >= minLong) whaleScore = 7;
          else if (baseShort && ttRatio <= maxShort) whaleScore = 7;
        } else {
          whaleScore = 7;
        }
        scoreBreakdown.whale = whaleScore;
        confluenceScore += whaleScore;

        // 5. Volume Participation vs SMA 20 (Max 10 pts)
        let volScore = 0;
        if (currentVolSma !== null) {
          if (currentVol >= currentVolSma * 1.0) volScore = 10;
          else if (currentVol >= currentVolSma * volMultiplier) volScore = 8;
          else if (currentVol >= currentVolSma * 0.50) volScore = 5;
        } else {
          volScore = 7;
        }
        scoreBreakdown.volume = volScore;
        confluenceScore += volScore;

        // 6. 15M Multi-Timeframe Trend Confluence (Max 10 pts)
        let mtfScore = 0;
        if (baseLong && mtfTrend === 'BULLISH') mtfScore = 10;
        else if (baseShort && mtfTrend === 'BEARISH') mtfScore = 10;
        else if (mtfTrend === 'NEUTRAL' || marketRegime === 'SIDEWAYS_RANGE') mtfScore = 6;
        else if (keyLevelSetup && keyLevelSetup.isMacroLevel) mtfScore = 8;
        scoreBreakdown.mtf = mtfScore;
        confluenceScore += mtfScore;

        // 7. SumoPod AI Macro Sentiment Confluence (Max 10 pts)
        let aiScore = 0;
        if (aiSentiment) {
          if (baseLong && aiSentiment.sentiment === 'BULLISH') aiScore = 10;
          else if (baseShort && aiSentiment.sentiment === 'BEARISH') aiScore = 10;
          else if (aiSentiment.sentiment === 'NEUTRAL') aiScore = 7;
          else if (aiSentiment.confidence < (strategy.ai.minVetoConfidence || 7)) aiScore = 4;
        } else {
          aiScore = 7;
        }
        scoreBreakdown.ai = aiScore;
        confluenceScore += aiScore;
      }

      this.lastIndicators.confluenceScore = confluenceScore;

      // Determine Overall Verdict with Confluence Engine
      let verdict = 'NO_SIGNAL_SCANNING';
      if (activePos) {
        verdict = 'IN_POSITION';
      } else if (baseLong || baseShort || (isRealityMode && signalType !== 'NEUTRAL') || (isKeyLevelMode && signalType !== 'NEUTRAL')) {
        if (useConfluence) {
          if (hardVetoReasons.length > 0) {
            verdict = 'BLOCKED_BY_FILTER';
            blockedReasons.unshift(...hardVetoReasons);
          } else if (confluenceScore >= minConfluenceScore) {
            verdict = 'ENTRY_READY';
            blockedReasons.length = 0;
          } else {
            verdict = 'BLOCKED_BY_FILTER';
            blockedReasons.push(`Confluence Score (${confluenceScore}/100) berada di bawah ambang batas minimum ${minConfluenceScore} poin.`);
          }
        } else {
          verdict = blockedReasons.length > 0 ? 'BLOCKED_BY_FILTER' : 'ENTRY_READY';
        }
      }

      const candleGuardPassed = isRealityMode ? (!requireCandle || (signalType === 'LONG' ? isCandleGreen : (signalType === 'SHORT' ? isCandleRed : true))) : true;

      const evalFilters = {
        taker: {
          name: isKeyLevelMode ? 'Key Level Taker Flow (Absorption)' : (isRealityMode ? 'Taker Order Flow Trigger' : 'Taker Order Flow Pressure'),
          passed: takerPassed,
          value: takerRatio !== null && !isNaN(takerRatio) ? `Ratio ${Number(takerRatio).toFixed(2)}` : 'N/A',
          threshold: isKeyLevelMode ? `L >= ${minLongTaker} | S <= ${maxShortTaker}` : (isRealityMode ? `L >= ${minTakerLong} | S <= ${maxTakerShort}` : `Bounds [${minLongTaker} - ${maxShortTaker}]`),
          statusText: takerPassed
            ? (isKeyLevelMode ? 'Pass (Absorption Confirmed)' : (isRealityMode ? 'Pass (Imbalance Confirmed)' : 'Pass (Balanced Flow)'))
            : 'Blocked (Counter Flow)'
        },
        cvd: {
          name: 'Real-time CVD / Sub-second Taker Flow',
          passed: takerPassed,
          value: hasCvd ? `CVD 5m: ${this.latestCvdMetrics.cvd5m >= 0 ? '+' : ''}$${Math.round(this.latestCvdMetrics.cvd5m / 1000)}k (Ratio ${this.latestCvdMetrics.realtimeTakerRatio5m})` : `REST Ratio: ${takerRatio ? takerRatio.toFixed(2) : 'N/A'}`,
          threshold: `Bounds [${minLongTaker} - ${maxShortTaker}]`,
          statusText: takerPassed ? 'Pass (Flow Aligned)' : 'Blocked (Counter Flow)'
        },
        liquidation: {
          name: 'Liquidation Cascade & Exhaustion Guard',
          passed: liqPassed,
          value: `60s: L $${Math.round(longLiq60s / 1000)}k / S $${Math.round(shortLiq60s / 1000)}k | 5m: $${Math.round((longLiq5m + shortLiq5m) / 1000)}k`,
          threshold: `Max Cascade <= $${Math.round(maxLiq60s / 1000)}k/60s`,
          statusText: liqPassed ? `Pass (${liqNote})` : `Blocked (${liqNote})`
        },
        orderBook: {
          name: 'Order Book Imbalance (Top 20 Depth)',
          passed: obPassed,
          value: currentObi !== null && currentObi !== undefined ? `Bids ${(currentObi * 100).toFixed(1)}% | Asks ${((1 - currentObi) * 100).toFixed(1)}% (Ratio ${this.latestWhaleMetrics?.orderBookRatio ?? '1.0'})` : 'N/A',
          threshold: `L >= ${(minLongObi * 100).toFixed(0)}% Bids | S <= ${(maxShortObi * 100).toFixed(0)}% Bids`,
          statusText: obPassed ? 'Pass (Liquidity Support)' : 'Blocked (Adverse Depth Wall)'
        },
        openInterest: {
          name: 'Real-time Delta Open Interest (5m)',
          passed: oiDeltaPassed,
          value: `${oiRegime} (ΔOI: ${deltaOiPct > 0 ? '+' : ''}${deltaOiPct.toFixed(2)}%)`,
          threshold: 'Expansion Confluence',
          statusText: oiDeltaPassed ? `Pass (${oiRegime})` : 'Blocked (Liquidation Flush)'
        },
        candle: {
          name: 'Candle Direction & Absorption Guard',
          passed: candleGuardPassed,
          value: `${isCandleGreen ? 'GREEN (Bull)' : (isCandleRed ? 'RED (Bear)' : 'DOJI')} ($${lastOpen.toFixed(1)} -> $${lastClose.toFixed(1)})`,
          threshold: isRealityMode ? 'Aligned with Taker Flow' : 'Candle Confirmation',
          statusText: isRealityMode ? (candleGuardPassed ? (isCandleGreen ? 'Pass (Bullish Confirm)' : (isCandleRed ? 'Pass (Bearish Confirm)' : 'Neutral')) : 'Blocked (Absorption Reject)') : 'Pass'
        },
        volume: {
          name: 'Volume Participation (SMA 20)',
          passed: volPassed,
          value: `${currentVol.toFixed(1)} / ${minVolRequired ? minVolRequired.toFixed(1) : 'N/A'}`,
          threshold: `>= ${Math.round(volMultiplier * 100)}% SMA 20`,
          statusText: volPassed ? 'Pass (Liquid Market)' : 'Blocked (Dry Volume)'
        },
        whale: {
          name: 'Whale Position (Top Trader L/S)',
          passed: ttPassed,
          value: ttRatio !== null && !isNaN(ttRatio) ? `Ratio ${Number(ttRatio).toFixed(2)}` : 'N/A',
          threshold: `Bounds [${minLong} - ${maxShort}]`,
          statusText: ttPassed ? 'Pass (Whales Aligned)' : 'Blocked (Whales Opposing)'
        },
        ai: {
          name: 'AI Macro Gatekeeper & Confluence (SumoPod)',
          passed: aiPassed,
          value: `${aiSentiment.sentiment || 'NEUTRAL'} (${aiSentiment.confidence || 0}/10)`,
          threshold: 'No Bearish on Support / No Bullish on Resistance',
          statusText: aiPassed ? `Pass (${aiConfluenceNote})` : `Blocked (AI Veto ${aiSentiment.sentiment})`
        },
        positionGuard: {
          name: 'Single Position & Risk Guard',
          passed: !activePos && riskPassed,
          value: activePos ? `Active: ${activePos.side}` : (this.isTradingLocked ? 'Halted' : 'Ready (0 Positions)'),
          threshold: 'Max 1 Active Position',
          statusText: (!activePos && riskPassed) ? 'Pass (Ready for Entry)' : (activePos ? 'Blocked (Position Active)' : 'Blocked (Risk Kill Switch)')
        },
        funding: {
          name: 'Funding Rate Guard',
          passed: fundingPassed,
          value: this.latestFundingRate !== null && this.latestFundingRate !== undefined ? `${(this.latestFundingRate * 100).toFixed(4)}%` : 'N/A',
          threshold: fundingConfig.maxAbsoluteRate ? `<= +/- ${(fundingConfig.maxAbsoluteRate * 100).toFixed(4)}%` : 'Bypass',
          statusText: fundingPassed ? 'Pass (Normal Rate)' : 'Blocked (Extreme Funding)'
        }
      };

      if (isKeyLevelMode && keyLevels) {
        const isTestingSupport = keyLevelSetup && keyLevelSetup.isAtSupport;
        const isTestingResistance = keyLevelSetup && keyLevelSetup.isAtResistance;
        const keyLevelPassed = isTestingSupport || isTestingResistance;

        evalFilters.keyLevel = {
          name: keyLevelSetup?.isMacroLevel ? 'Multi-Horizon S/R Zone (Macro 24H Anchor)' : '15M Support & Resistance Zone',
          passed: keyLevelPassed,
          value: `S: $${keyLevelSetup?.supportPrice || Number(keyLevels.support).toFixed(1)} | R: $${keyLevelSetup?.resistancePrice || Number(keyLevels.resistance).toFixed(1)}`,
          threshold: `Within +/- ${keyLevelsCfg.zoneTolerancePct || 0.35}% Zone`,
          statusText: isTestingSupport
            ? (keyLevelSetup?.isMacroLevel ? 'Pass (Macro 24H Support Tested)' : 'Pass (Tactical Support Tested)')
            : (isTestingResistance ? (keyLevelSetup?.isMacroLevel ? 'Pass (Macro 24H Resistance Tested)' : 'Pass (Tactical Resistance Tested)') : 'Blocked (Floating in Mid-Range)')
        };

        const rejectionPassed = baseLong
          ? (keyLevelSetup && keyLevelSetup.hasBullishRejection)
          : (baseShort ? (keyLevelSetup && keyLevelSetup.hasBearishRejection) : true);

        evalFilters.rejection = {
          name: 'Rejection Wick & Bounce Guard',
          passed: rejectionPassed,
          value: keyLevelSetup
            ? `Wick: Lower ${(keyLevelSetup.lowerWickRatio * 100).toFixed(0)}% / Upper ${(keyLevelSetup.upperWickRatio * 100).toFixed(0)}%`
            : 'N/A',
          threshold: `>= ${Math.round((keyLevelsCfg.minRejectionWickPct || 0.25) * 100)}% Wick or Directional Bounce`,
          statusText: rejectionPassed
            ? 'Pass (Rejection Confirmed)'
            : 'Blocked (No Rejection / Direct Pierce)'
        };
      }

      if (useConfluence) {
        evalFilters.confluence = {
          name: 'Confluence Score Engine',
          passed: confluenceScore >= minConfluenceScore && hardVetoReasons.length === 0,
          value: `${confluenceScore}/100 Pts (Min ${minConfluenceScore})`,
          threshold: `>= ${minConfluenceScore} Pts Confluence`,
          statusText: (confluenceScore >= minConfluenceScore && hardVetoReasons.length === 0)
            ? `Pass (Score ${confluenceScore}/100 - Strong Confluence)`
            : (hardVetoReasons.length > 0 ? `Blocked (Hard Veto Active)` : `Blocked (Score ${confluenceScore}/100 < ${minConfluenceScore} Min)`)
        };
      }

      if (!isRealityMode || filterConfig.adx?.enabled) {
        let adxThresh = `>= ${adxThreshold}`;
        let adxStatus = filterConfig.adx?.enabled ? (adxPassed ? 'Pass (Trending Market)' : 'Blocked (Choppy / Sideways)') : 'Bypass (Order Flow Focus)';
        if (isKeyLevelMode) {
          adxThresh = `<= ${adxMaxRange} (Range Bound)`;
          adxStatus = adxPassed
            ? `Pass (Healthy Range Oscillation: ADX ${currentAdx ?? 'N/A'})`
            : `Blocked (Extreme Runaway Trend: ADX ${currentAdx ?? 'N/A'} > ${adxMaxRange})`;
        }
        evalFilters.adx = {
          name: isKeyLevelMode ? 'Market Regime (ADX 14)' : 'Trend Strength (ADX 14)',
          passed: adxPassed,
          value: currentAdx !== null ? `ADX ${currentAdx}` : 'N/A',
          threshold: adxThresh,
          statusText: adxStatus
        };
      }
      if (!isRealityMode || filterConfig.multiTimeframe?.enabled) {
        let mtfThresh = filterConfig.multiTimeframe?.enabled ? (baseLong ? 'Must Be BULLISH' : (baseShort ? 'Must Be BEARISH' : 'Trend Aligned')) : 'Bypass (Reality Mode)';
        let mtfStatus = filterConfig.multiTimeframe?.enabled ? (mtfPassed ? `Pass (${mtfTrend})` : `Blocked (Counter 15M Trend ${mtfTrend})`) : 'Bypass (Order Flow Focus)';
        if (isKeyLevelMode) {
          mtfThresh = trendBias === 'SHORTS_ONLY' ? 'BEARISH ONLY' : (trendBias === 'LONGS_ONLY' ? 'BULLISH ONLY' : '15M S/R Zone');
          mtfStatus = mtfPassed
            ? `Pass (${marketRegime}: ${trendBias})`
            : `Blocked (Counter-Trend ${mtfTrend} vs ${signalType})`;
        }
        evalFilters.mtf = {
          name: isKeyLevelMode ? '15M Trend & Market Regime' : '15M Trend Confluence (EMA 25)',
          passed: mtfPassed,
          value: `${mtfTrend} • ${marketRegime}`,
          threshold: mtfThresh,
          statusText: mtfStatus
        };
      }
      if (filterConfig.rsi?.enabled) {
        evalFilters.rsi = {
          name: 'RSI Exhaustion Guard (14)',
          passed: rsiPassed,
          value: lastRsi !== null ? `RSI ${lastRsi.toFixed(1)}` : 'N/A',
          threshold: `L <= ${maxLongRsi} | S >= ${minShortRsi}`,
          statusText: rsiPassed ? 'Pass (Healthy Zone)' : (baseLong ? 'Blocked (Overbought Exhaustion)' : 'Blocked (Oversold Exhaustion)')
        };
      }

      // Store structured evaluation for Dashboard UI & SSE stream
      this.latestFilterEvaluation = {
        updatedAt: Date.now(),
        candleClosePrice: Number(lastClose.toFixed(2)),
        signal: signalType,
        verdict: verdict,
        confluenceScore: confluenceScore,
        minConfluenceScore: minConfluenceScore,
        scoreBreakdown: scoreBreakdown,
        blockedReasons: blockedReasons,
        activePosition: activePos ? { side: activePos.side, qty: activePos.qty, entryPrice: activePos.entry_price } : null,
        filters: evalFilters
      };

      // Realtime Detailed Logging
      if (activePos) {
        console.log(`[FILTER_BLOCKED] 5m Candle closed @ $${lastClose.toFixed(1)}. New entry blocked: Single concurrent position rule (Active ${activePos.side} ${activePos.qty} BTC position on ${this.symbol} is running).`);
        return;
      }

      if (!baseLong && !baseShort) {
        const candleType = isCandleGreen ? 'GREEN' : (isCandleRed ? 'RED' : 'DOJI');
        console.log(`[CANDLE_SCAN] 5m closed @ $${lastClose.toFixed(1)} | Mode: ${strategy.trading.strategyMode || 'ORDER_FLOW_SNIPER'} | Taker: ${hasValidTakerRatio ? takerRatio.toFixed(2) : 'N/A'} (L>=${minTakerLong}/S<=${maxTakerShort}) | Candle: ${candleType} | Standing by.`);
        return;
      }

      console.log(`[SIGNAL_DETECTED] 5m ${signalType} setup detected @ $${lastClose.toFixed(1)} (Mode: ${strategy.trading.strategyMode || 'ORDER_FLOW_SNIPER'}, Taker: ${hasValidTakerRatio ? takerRatio.toFixed(2) : 'N/A'}, Candle: ${isCandleGreen ? 'GREEN' : 'RED'}). Checking Gatekeeper filters...`);

      if (blockedReasons.length > 0) {
        for (const reason of blockedReasons) {
          console.log(`[FILTER_BLOCKED] ${signalType} BLOCKED: ${reason}`);
        }
        return;
      }

      console.log(`[SIGNAL_PASSED] Gatekeeper Confluence APPROVED for ${signalType} (Score: ${confluenceScore}/100 >= ${minConfluenceScore})! Executing order...`);
      const side = baseLong ? 'BUY' : 'SELL';
      await this.executeTrade(side, lastClose, currentAtr);
  }

  async executeTrade(side, price, atr) {
      this.isTradingLocked = true;
      try {
          const currentMode = strategy.api.isTestnet ? 'DEMO' : 'REAL';
          const dbPos = db.prepare('SELECT * FROM active_positions WHERE symbol = ? AND mode = ?').get(this.symbol, currentMode);
          if (dbPos) {
              console.log(`Position already exists (${currentMode}). Skipping entry.`);
              return;
          }
          
          let equity = new BigNumber(1000); 
          let availableBalance = new BigNumber(1000);
          try {
              const acc = await Binance.getAccountInfo();
              if (acc && acc.totalMarginBalance) {
                  equity = new BigNumber(acc.totalMarginBalance);
              }
              if (acc && acc.availableBalance) {
                  availableBalance = new BigNumber(acc.availableBalance);
              }
          } catch (e) {
              // Fallback to default
          }

          const priceBn = new BigNumber(price);
          const atrBn = new BigNumber(atr);

          // Position sizing based on actual Stop Loss distance so loss is exactly riskPerTradePct
          const actualSlDist = this.calculateSlDistance(priceBn, atrBn);
          const riskAmt = equity.multipliedBy(strategy.trading.riskPerTradePct).dividedBy(100);
          let qty = riskAmt.dividedBy(actualSlDist);

          // Margin safety cap: prevent exceeding available balance on Binance (with 70% safety headroom)
          const leverage = new BigNumber(strategy.trading.leverage || 25);
          const maxUsableMargin = availableBalance.multipliedBy(0.70);
          const maxQty = maxUsableMargin.multipliedBy(leverage).dividedBy(priceBn);

          if (qty.isGreaterThan(maxQty)) {
              console.log(`[RISK_CAP] Sized qty ${qty.toFixed(4)} exceeds safe margin capacity ${maxQty.toFixed(4)}. Clamping to safe limit.`);
              qty = maxQty;
          }

          // Min notional
          const notional = qty.multipliedBy(priceBn);
          if (notional.isLessThan(strategy.trading.minNotionalUSD)) {
             qty = new BigNumber(strategy.trading.minNotionalUSD).dividedBy(priceBn);
          }
          
          // Format qty to expected step size (simplified: 3 decimals)
          let qtyStr = qty.decimalPlaces(3, BigNumber.ROUND_DOWN).toString();
          if (new BigNumber(qtyStr).isLessThanOrEqualTo(0)) {
              // Micro-account support (e.g. $20 USDT): Check if minimum exchange lot size (0.001 BTC)
              // fits safely within margin headroom capacity (<= 70% available balance)
              const minStepSize = new BigNumber(0.001);
              const minLotMargin = minStepSize.multipliedBy(priceBn).dividedBy(leverage);
              if (minLotMargin.isLessThanOrEqualTo(maxUsableMargin)) {
                  qtyStr = minStepSize.toString();
                  console.log(`[MICRO_ACCOUNT] Clamping to minimum exchange lot size ${qtyStr} BTC (Margin required: $${minLotMargin.toFixed(2)} USDT / Safe Cap: $${maxUsableMargin.toFixed(2)} USDT)`);
              } else {
                  console.warn("[TRADE_SKIP] Calculated quantity after rounding is 0. Insufficient margin for min lot size.");
                  return;
              }
          }
          
          // Calculate aggressive limit price with slippage protection
          const slippage = new BigNumber(strategy.trading.slippageMaxPct).dividedBy(100);
          const limitPrice = side === 'BUY'
              ? price.multipliedBy(new BigNumber(1).plus(slippage)).decimalPlaces(1, BigNumber.ROUND_HALF_UP).toString()
              : price.multipliedBy(new BigNumber(1).minus(slippage)).decimalPlaces(1, BigNumber.ROUND_HALF_UP).toString();

          console.log(`Executing ${side} order for ${qtyStr} at limit price ${limitPrice} (approx ${price})`);
          
          const order = await Binance.placeOrder(this.symbol, side, qtyStr, limitPrice, 'LIMIT');
          
          // Sync DB within sync transaction
          let fillQty = order.executedQty;
          let fillPrice = order.avgPrice;

          // Fallback verification if IOC filled but response executedQty was initially 0
          if (new BigNumber(fillQty || 0).isLessThanOrEqualTo(0)) {
            try {
              // Allow 400ms for Binance matching engine settlement & account balance update
              await new Promise(res => setTimeout(res, 400));
              if (order && order.orderId) {
                const checkedOrder = await Binance.getOrder(this.symbol, order.orderId).catch(() => null);
                if (checkedOrder && new BigNumber(checkedOrder.executedQty || 0).isGreaterThan(0)) {
                  fillQty = checkedOrder.executedQty;
                  fillPrice = (new BigNumber(checkedOrder.avgPrice || 0).isGreaterThan(0)) ? checkedOrder.avgPrice : (checkedOrder.price || limitPrice);
                  console.log(`[ORDER_FILL_VERIFIED] Verified fill via getOrder: Qty ${fillQty} @ ${fillPrice}`);
                }
              }

              if (new BigNumber(fillQty || 0).isLessThanOrEqualTo(0)) {
                const acc = await Binance.getAccountInfo().catch(() => null);
                const p = acc && acc.positions && acc.positions.find(item => item.symbol === this.symbol);
                if (p && parseFloat(p.positionAmt) !== 0) {
                  fillQty = Math.abs(parseFloat(p.positionAmt)).toString();
                  fillPrice = p.entryPrice;
                  console.log(`[ORDER_FILL_VERIFIED] Verified fill directly on exchange: Qty ${fillQty} @ ${fillPrice}`);
                }
              }
            } catch (err) {
              console.warn(`[FILL_CHECK_WARN] ${err.message}`);
            }
          }

          if (new BigNumber(fillQty || 0).isGreaterThan(0)) {
               const finalFillPrice = (new BigNumber(fillPrice || 0).isGreaterThan(0)) ? fillPrice : price.toString();
               const { slPrice, tpPrice } = this.calculateSlTp(side === 'BUY' ? 'LONG' : 'SHORT', finalFillPrice, atr);
               console.log(`[ORDER_FILLED] Executed ${side} for ${fillQty} @ ${finalFillPrice}. Set SL: ${slPrice}, TP: ${tpPrice}`);

               const currentMode = strategy.api.isTestnet ? 'DEMO' : 'REAL';
               const insertTx = db.transaction(() => {
                   db.prepare(`
                       INSERT INTO active_positions (symbol, side, entry_price, qty, sl_price, tp_price, atr_at_entry, updated_at, entry_time, mode) 
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(symbol, mode) DO UPDATE SET
                         side = excluded.side,
                         entry_price = excluded.entry_price,
                         qty = excluded.qty,
                         sl_price = excluded.sl_price,
                         tp_price = excluded.tp_price,
                         atr_at_entry = excluded.atr_at_entry,
                         entry_time = COALESCE(active_positions.entry_time, excluded.entry_time),
                         updated_at = excluded.updated_at
                   `).run(this.symbol, side === 'BUY' ? 'LONG' : 'SHORT', finalFillPrice, fillQty, slPrice, tpPrice, atr.toString(), Date.now(), Date.now(), currentMode);
                   
                   db.prepare(`
                       INSERT INTO position_fills (id, position_id, order_id, fill_price, fill_qty, timestamp, mode)
                       VALUES (?, ?, ?, ?, ?, ?, ?)
                   `).run(Date.now().toString(), this.symbol, order.orderId ? order.orderId.toString() : Date.now().toString(), finalFillPrice, fillQty, Date.now(), currentMode);
               });
               insertTx();
               redis.set(`pos:${this.symbol}:${currentMode}`, JSON.stringify({side: side, price: finalFillPrice, qty: fillQty, sl: slPrice, tp: tpPrice, mode: currentMode}));
               await this.placeExchangeSlTp(side === 'BUY' ? 'LONG' : 'SHORT', fillQty, slPrice, tpPrice);
               Notifier.sendTradeOpen({
                 symbol: this.symbol,
                 side: side === 'BUY' ? 'LONG' : 'SHORT',
                 qty: fillQty,
                 price: finalFillPrice,
                 slPrice: slPrice,
                 tpPrice: tpPrice,
                 leverage: strategy.trading.leverage
               });
          } else {
               console.warn("Order was completely unfilled (IOC).");
          }
      } catch (e) {
          console.error("Trade Execution Error:", e);
      } finally {
          this.isTradingLocked = false;
      }
  }

  checkKillSwitches() {
    try {
      const currentMode = strategy.api.isTestnet ? 'DEMO' : 'REAL';

      // 1. Post Stop-Loss Cooldown Period (Enforced in BOTH Demo and Real to prevent revenge trading)
      if (this.lastStopLossTime === 0) {
        try {
          const lastLossTrade = db.prepare('SELECT timestamp, pnl FROM trade_history WHERE mode = ? ORDER BY timestamp DESC LIMIT 1').get(currentMode);
          if (lastLossTrade && new BigNumber(lastLossTrade.pnl || 0).isNegative()) {
            this.lastStopLossTime = Number(lastLossTrade.timestamp);
          }
        } catch (err) {}
      }

      if (strategy.risk.lossCooldown?.enabled && this.lastStopLossTime > 0) {
        const cooldownMs = (strategy.risk.lossCooldown.minutes || 20) * 60 * 1000;
        const elapsed = Date.now() - this.lastStopLossTime;
        if (elapsed < cooldownMs) {
          const remainingMins = Math.ceil((cooldownMs - elapsed) / 60000);
          console.warn(`[KILL_SWITCH_ACTIVE] [${currentMode}] Post Stop Loss cooling period active. Trading paused for ${remainingMins} more minutes.`);
          return false;
        }
      }

      // Bypass general daily loss limit and consecutive pause for development & demo testing if requested
      if (strategy.risk.disableInDemo && strategy.api.isTestnet) {
        return true;
      }

      // 2. Daily Loss Limit (5% of actual equity, Net Realized PnL, reset at 00:00 UTC)
      if (strategy.risk.dailyLossLimitEnabled) {
        const now = new Date();
        const startOfDayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        const tradesToday = db.prepare('SELECT pnl FROM trade_history WHERE timestamp >= ? AND mode = ?').all(startOfDayUtc, currentMode);

        let netDailyPnl = new BigNumber(0);
        for (const t of tradesToday) {
          netDailyPnl = netDailyPnl.plus(new BigNumber(t.pnl || 0));
        }

        const equity = (this.accountEquity && this.accountEquity.isGreaterThan(0))
          ? this.accountEquity
          : new BigNumber(1000);
        const maxDailyLoss = equity.multipliedBy(strategy.risk.dailyLossLimitPct).dividedBy(100);

        // Kill Switch activates ONLY when net daily PnL is negative and exceeds maxDailyLoss
        if (netDailyPnl.isNegative() && netDailyPnl.abs().isGreaterThanOrEqualTo(maxDailyLoss)) {
          console.warn(`[KILL_SWITCH_ACTIVE] [${currentMode}] Daily loss limit exceeded (Net PnL -$${netDailyPnl.abs().toFixed(2)} >= -$${maxDailyLoss.toFixed(2)} based on $${equity.toFixed(2)} equity). Trading locked until 00:00 UTC.`);
          return false;
        }
      }

      // 3. Consecutive Losses (pause 4h after 3 consecutive losses)
      if (strategy.risk.consecutiveLossPause && strategy.risk.consecutiveLossPause.enabled) {
        const recentTrades = db.prepare('SELECT pnl, timestamp FROM trade_history WHERE mode = ? ORDER BY timestamp DESC LIMIT ?')
          .all(currentMode, strategy.risk.consecutiveLossPause.count);

        if (recentTrades.length >= strategy.risk.consecutiveLossPause.count) {
          const allLosses = recentTrades.every(t => new BigNumber(t.pnl || 0).isNegative());
          if (allLosses) {
            const lastTradeTime = recentTrades[0].timestamp;
            const pauseDurationMs = strategy.risk.consecutiveLossPause.pauseHours * 60 * 60 * 1000;
            if (Date.now() - lastTradeTime < pauseDurationMs) {
              const remainingMins = Math.ceil((pauseDurationMs - (Date.now() - lastTradeTime)) / 60000);
              console.warn(`[KILL_SWITCH_ACTIVE] [${currentMode}] 3 consecutive losses detected. Trading paused for ${remainingMins} more minutes.`);
              return false;
            }
          }
        }
      }

      return true;
    } catch (e) {
      console.error("Error evaluating kill switches:", e.message);
      return true;
    }
  }

  calculateSlDistance(entryPrice, atr) {
    const entryPriceNum = new BigNumber(entryPrice);
    const atrVal = new BigNumber(atr || 100);
    const baseSlDist = atrVal.multipliedBy(strategy.trading.baseSlAtrMultiplier);
    const floorSlDist = entryPriceNum.multipliedBy(strategy.trading.floorSlPct).dividedBy(100);
    return BigNumber.maximum(baseSlDist, floorSlDist);
  }

  calculateSlTp(side, entryPrice, atr) {
    const entryPriceNum = new BigNumber(entryPrice);
    const slDist = this.calculateSlDistance(entryPriceNum, atr);
    const tpDist = slDist.multipliedBy(strategy.trading.rrRatio);

    let slPrice, tpPrice;
    if (side === 'LONG' || side === 'BUY') {
      slPrice = entryPriceNum.minus(slDist).decimalPlaces(1, BigNumber.ROUND_DOWN);
      tpPrice = entryPriceNum.plus(tpDist).decimalPlaces(1, BigNumber.ROUND_UP);
    } else {
      slPrice = entryPriceNum.plus(slDist).decimalPlaces(1, BigNumber.ROUND_UP);
      tpPrice = entryPriceNum.minus(tpDist).decimalPlaces(1, BigNumber.ROUND_DOWN);
    }

    return { slPrice: slPrice.toString(), tpPrice: tpPrice.toString() };
  }

  async calculateNetPnlAndCommission(pos, exitPrice, activeQty, activeSide) {
    const entryPriceBn = new BigNumber(pos && pos.entry_price ? pos.entry_price : exitPrice);
    let exitPriceBn = new BigNumber(exitPrice);
    const qtyBn = new BigNumber(activeQty).abs();
    const isLong = (activeSide === 'LONG' || activeSide === 'BUY');
    const exitSide = isLong ? 'SELL' : 'BUY';

    // 1. Fetch actual commission and real execution exit price from Binance API if available
    let totalCommission = null;
    let actualExitPrice = null;
    try {
      const startTime = (pos && pos.updated_at) ? Math.max(0, Number(pos.updated_at) - 10000) : null;
      const recentTrades = await Binance.getUserTrades(this.symbol, 10, startTime);
      if (Array.isArray(recentTrades) && recentTrades.length > 0) {
        const cycleTrades = startTime
          ? recentTrades.filter(t => Number(t.time) >= startTime)
          : recentTrades.slice(-2);

        if (cycleTrades.length > 0) {
          let feeSum = new BigNumber(0);
          let exitWeightedSum = new BigNumber(0);
          let exitQtySum = new BigNumber(0);

          for (const t of cycleTrades) {
            feeSum = feeSum.plus(new BigNumber(t.commission || 0));
            if (t.side === exitSide) {
              const tQty = new BigNumber(t.qty || 0);
              exitWeightedSum = exitWeightedSum.plus(new BigNumber(t.price || 0).multipliedBy(tQty));
              exitQtySum = exitQtySum.plus(tQty);
            }
          }

          if (exitQtySum.isGreaterThan(0)) {
            actualExitPrice = exitWeightedSum.dividedBy(exitQtySum);
            exitPriceBn = actualExitPrice;
            console.log(`[REAL_EXIT_PRICE] Retrieved exact Binance fill exit price: $${exitPriceBn.toFixed(2)}`);
          }

          if (feeSum.isGreaterThan(0)) {
            totalCommission = feeSum;
            console.log(`[REAL_COMMISSION] Retrieved exact Binance commission from ${cycleTrades.length} trade fills: $${totalCommission.toFixed(4)} USDT`);
          }
        }
      }
    } catch (err) {
      console.warn(`[COMMISSION_PULL_WARN] ${err.message}. Using deterministic fee calculation.`);
    }

    // 2. Gross PnL from price movement
    const diff = isLong ? exitPriceBn.minus(entryPriceBn) : entryPriceBn.minus(exitPriceBn);
    const grossPnl = diff.multipliedBy(qtyBn);

    // 3. Fallback: Deterministic calculation based on standard Binance Futures taker fee (0.04% per order)
    if (!totalCommission || totalCommission.isZero()) {
      const entryNotional = entryPriceBn.multipliedBy(qtyBn);
      const exitNotional = exitPriceBn.multipliedBy(qtyBn);
      const takerFeeRate = new BigNumber(0.0004); // 0.04% taker fee rate
      totalCommission = entryNotional.plus(exitNotional).multipliedBy(takerFeeRate);
      console.log(`[ESTIMATED_COMMISSION] Calculated round-trip taker commission: $${totalCommission.toFixed(4)} USDT`);
    }

    // 4. Net PnL = Gross PnL - Commission
    const netPnl = grossPnl.minus(totalCommission);

    return {
      exitPrice: exitPriceBn.toFixed(2),
      grossPnl: grossPnl.toFixed(2),
      commission: totalCommission.toFixed(2),
      netPnl: netPnl.toFixed(2)
    };
  }

  async evaluatePositionRisk(currentPrice) {
    if (!currentPrice || this.isTradingLocked) return;
    try {
      const currentMode = strategy.api.isTestnet ? 'DEMO' : 'REAL';
      const pos = db.prepare('SELECT * FROM active_positions WHERE symbol = ? AND mode = ?').get(this.symbol, currentMode);
      if (!pos) return;

      const currPrice = new BigNumber(currentPrice);
      const entryPrice = new BigNumber(pos.entry_price);
      const qty = new BigNumber(pos.qty).abs();
      const isLong = pos.side === 'LONG';

      // 1. Calculate Unrealized PnL
      const priceDiff = isLong ? currPrice.minus(entryPrice) : entryPrice.minus(currPrice);
      const unrealizedPnl = priceDiff.multipliedBy(qty).decimalPlaces(2, BigNumber.ROUND_HALF_UP).toString();

      db.prepare('UPDATE active_positions SET unrealized_pnl = ?, updated_at = ? WHERE symbol = ? AND mode = ?')
        .run(unrealizedPnl, Date.now(), this.symbol, currentMode);

      const atr = pos.atr_at_entry ? new BigNumber(pos.atr_at_entry) : new BigNumber(currPrice).multipliedBy(0.01);

      // 2. Break-Even Stop Loss Guard (+0.10% Fee Buffer)
      let activeSl = pos.trailing_sl ? new BigNumber(pos.trailing_sl) : new BigNumber(pos.sl_price || 0);
      const beCfg = strategy.trading.trailingStop?.breakEven;
      if (beCfg?.enabled && !pos.is_be_active) {
        const triggerPct = new BigNumber(beCfg.triggerProfitPct || 0.50);
        const feePct = new BigNumber(beCfg.feeBufferPct || 0.10);
        const profitPct = isLong
          ? currPrice.minus(entryPrice).dividedBy(entryPrice).multipliedBy(100)
          : entryPrice.minus(currPrice).dividedBy(entryPrice).multipliedBy(100);

        if (profitPct.isGreaterThanOrEqualTo(triggerPct)) {
          const beSlPrice = isLong
            ? entryPrice.multipliedBy(new BigNumber(1).plus(feePct.dividedBy(100))).decimalPlaces(1, BigNumber.ROUND_DOWN)
            : entryPrice.multipliedBy(new BigNumber(1).minus(feePct.dividedBy(100))).decimalPlaces(1, BigNumber.ROUND_UP);

          const shouldMoveBe = isLong
            ? beSlPrice.isGreaterThan(activeSl)
            : (activeSl.isZero() || beSlPrice.isLessThan(activeSl));

          if (shouldMoveBe) {
            activeSl = beSlPrice;
            db.prepare('UPDATE active_positions SET trailing_sl = ?, is_be_active = 1 WHERE symbol = ? AND mode = ?')
              .run(activeSl.toString(), this.symbol, currentMode);
            console.log(`[BREAK_EVEN_SL] Profit reached +${profitPct.toFixed(2)}% (>= +${triggerPct}%). Secured SL to Break-Even + Fee at ${activeSl}`);
            await this.updateExchangeSl(pos.side, qty.toString(), activeSl.toString());
            Notifier.sendTrailingStop({
              symbol: this.symbol,
              side: pos.side,
              newSlPrice: activeSl.toString(),
              currentPrice: currPrice.toString(),
              note: 'Break-Even Guard (+Fee)'
            });
          }
        }
      }

      // 3. Trailing Stop Logic
      const trailCfg = strategy.trading.trailingStop;
      if (trailCfg?.enabled) {
        const profitDistance = priceDiff;
        const activationDistance = atr.multipliedBy(trailCfg.activationAtrMultiplier);

        if (profitDistance.isGreaterThan(activationDistance)) {
          const gainedAtrUnits = profitDistance.dividedBy(atr).integerValue(BigNumber.ROUND_FLOOR);
          const tightening = gainedAtrUnits.multipliedBy(trailCfg.tightenAtrMultiplier);
          let trailDist = atr.multipliedBy(trailCfg.startTrailAtrMultiplier).minus(atr.multipliedBy(tightening));
          const minTrailDist = atr.multipliedBy(trailCfg.minTrailAtrMultiplier);
          if (trailDist.isLessThan(minTrailDist)) trailDist = minTrailDist;

          const candidateSl = isLong ? currPrice.minus(trailDist) : currPrice.plus(trailDist);
          const minStep = atr.multipliedBy(0.25); // Step threshold: at least 0.25 * ATR to prevent micro-tick spam

          const shouldTighten = isLong
            ? candidateSl.isGreaterThan(activeSl.plus(minStep))
            : (activeSl.isZero() || candidateSl.isLessThan(activeSl.minus(minStep)));

          if (shouldTighten) {
            activeSl = isLong
              ? candidateSl.decimalPlaces(1, BigNumber.ROUND_DOWN)
              : candidateSl.decimalPlaces(1, BigNumber.ROUND_UP);

            db.prepare('UPDATE active_positions SET trailing_sl = ? WHERE symbol = ? AND mode = ?').run(activeSl.toString(), this.symbol, currentMode);
            console.log(`[TRAILING_STOP] Tightened SL for ${this.symbol} to ${activeSl} (Step >= 0.25 ATR)`);
            await this.updateExchangeSl(pos.side, qty.toString(), activeSl.toString());
            Notifier.sendTrailingStop({ symbol: this.symbol, side: pos.side, newSlPrice: activeSl.toString(), currentPrice: currPrice.toString() });
          }
        }
      }

      // 4. AI Emergency Black Swan Exit Check (Decoupled from standard editorial sentiment, restricted to Black Swans)
      if (strategy.ai.emergencyHaltEnabled === true && !this.degradedMode && this.latestSentiment && this.latestSentiment.confidence >= (strategy.ai.emergencyExitConf || 9)) {
        const headline = (this.latestSentiment.headline || '').toUpperCase();
        const isBlackSwan = headline && (
          News.haltKeywords.test(headline) ||
          /\b(HACK|EXPLOIT|OUTAGE|INSOLVEN|BANKRUPT|ARREST|CRACKDOWN|EMERGENCY|DEPEG|SECURITY BREACH)\b/i.test(headline)
        );

        if (isBlackSwan) {
          if ((isLong && this.latestSentiment.sentiment === 'BEARISH') ||
              (!isLong && this.latestSentiment.sentiment === 'BULLISH')) {
            console.warn(`[EMERGENCY_EXIT] Black Swan event confirmed in headline ("${this.latestSentiment.headline}"): ${this.latestSentiment.sentiment} (${this.latestSentiment.confidence}/10). Closing position immediately!`);
            await this.closePosition('AI_EMERGENCY_EXIT', currPrice, unrealizedPnl);
            return;
          }
        }
      }

      // 5. Take Profit Check (Passive Limit Maker Priority)
      if (pos.tp_price) {
        const tpPrice = new BigNumber(pos.tp_price);
        const isTpHit = isLong ? currPrice.isGreaterThanOrEqualTo(tpPrice) : currPrice.isLessThanOrEqualTo(tpPrice);
        if (isTpHit) {
          if (!this.tpGraceStartTime) {
            this.tpGraceStartTime = Date.now();
            console.log(`[TAKE_PROFIT_TRIGGERED] Price reached TP ${tpPrice}. Awaiting passive Limit Maker fill on Binance...`);
            return;
          }
          if (Date.now() - this.tpGraceStartTime < 800) {
            return; // 800ms window for resting limit order execution
          }
          console.log(`[TAKE_PROFIT_TRIGGERED] Grace period elapsed. Closing position with PnL: $${unrealizedPnl}`);
          this.tpGraceStartTime = null;
          await this.closePosition('TAKE_PROFIT', currPrice, unrealizedPnl);
          return;
        } else {
          this.tpGraceStartTime = null;
        }
      }

      // 5. Stop Loss Check
      if (!activeSl.isZero()) {
        const isSlHit = isLong ? currPrice.isLessThanOrEqualTo(activeSl) : currPrice.isGreaterThanOrEqualTo(activeSl);
        if (isSlHit) {
          console.warn(`[STOP_LOSS_TRIGGERED] Price reached SL ${activeSl}. Closing position with PnL: $${unrealizedPnl}`);
          await this.closePosition('STOP_LOSS', currPrice, unrealizedPnl);
          return;
        }
      }

      // 6. Time-Based Stale Exit Check (Alpha Decay & Funding Fee Guard)
      const maxHoldMin = strategy.trading.maxHoldMinutes || 60;
      if (maxHoldMin > 0) {
        const fill = db.prepare('SELECT timestamp FROM position_fills WHERE position_id = ? AND mode = ? ORDER BY timestamp DESC LIMIT 1').get(this.symbol, currentMode);
        const entryTime = (fill && fill.timestamp) ? Number(fill.timestamp) : (pos.entry_time || pos.updated_at);
        const elapsedMinutes = (Date.now() - entryTime) / 60000;

        if (elapsedMinutes >= maxHoldMin) {
          console.warn(`[TIME_LIMIT_EXIT] Position reached max hold duration (${elapsedMinutes.toFixed(1)}m >= ${maxHoldMin}m). Pruning stale position with PnL: $${unrealizedPnl}`);
          await this.closePosition('TIME_LIMIT_EXIT', currPrice, unrealizedPnl);
          return;
        }
      }
    } catch (e) {
      console.error("Error evaluating position risk:", e.message);
    }
  }

  async closePosition(reason, exitPrice, pnl) {
    this.isTradingLocked = true;
    try {
      const currentMode = strategy.api.isTestnet ? 'DEMO' : 'REAL';
      const pos = db.prepare('SELECT * FROM active_positions WHERE symbol = ? AND mode = ?').get(this.symbol, currentMode);
      if (!pos) return;

      const qty = new BigNumber(pos.qty).abs().toString();
      console.log(`Closing ${pos.side} position for ${qty} on ${this.symbol} due to ${reason}...`);

      let alreadyClosedOnExchange = false;
      try {
        await Binance.closePosition(this.symbol, pos.side, qty);
      } catch (err) {
        if (err.message && err.message.includes('ReduceOnly Order is rejected')) {
          console.warn(`[REDUCE_ONLY_NOTE] Position already closed on Binance (triggered by exchange SL/TP). Continuing cleanup.`);
          alreadyClosedOnExchange = true;
        } else {
          const acc = await Binance.getAccountInfo().catch(() => null);
          const p = acc && acc.positions && acc.positions.find(item => item.symbol === this.symbol);
          if (p && parseFloat(p.positionAmt) === 0) {
            console.warn(`[EXCHANGE_ZERO_NOTE] Exchange position is 0. Continuing cleanup.`);
            alreadyClosedOnExchange = true;
          } else {
            throw err;
          }
        }
      }

      await Binance.cancelAllOpenOrders(this.symbol).catch(() => {});
      if (pos.sl_id) {
        await Binance.cancelAlgoOrder(this.symbol, pos.sl_id).catch(() => {});
      }
      await Binance.cancelAllAlgoOrders(this.symbol).catch(() => {});

      // Calculate Net PnL and Commission
      const pnlData = await this.calculateNetPnlAndCommission(pos, exitPrice, qty, pos.side);

      const finalExitPrice = (pnlData.exitPrice || exitPrice).toString();
      let wasRecorded = false;
      const insertTx = db.transaction(() => {
        const activeStillExists = db.prepare('SELECT 1 FROM active_positions WHERE symbol = ? AND mode = ?').get(this.symbol, currentMode);
        if (!activeStillExists) return;

        db.prepare(`
          INSERT INTO trade_history (id, timestamp, side, price, qty, pnl, commission, mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(Date.now().toString(), Date.now(), pos.side === 'LONG' ? 'SELL' : 'BUY', finalExitPrice, qty, pnlData.netPnl, pnlData.commission, currentMode);

        db.prepare('DELETE FROM position_fills WHERE position_id = ? AND mode = ?').run(this.symbol, currentMode);
        db.prepare('DELETE FROM active_positions WHERE symbol = ? AND mode = ?').run(this.symbol, currentMode);
        wasRecorded = true;
      });
      insertTx();
      if (!wasRecorded) return;

      redis.del(`pos:${this.symbol}:${currentMode}`);
      this.clearActivePositionFilterState();
      this.tpGraceStartTime = null;
      if (reason === 'STOP_LOSS' || (reason && reason.includes('STOP_LOSS'))) {
        this.lastStopLossTime = Date.now();
      }
      console.log(`[POSITION_CLOSED] ${pos.side} position closed successfully at approx ${exitPrice}. Gross: $${pnlData.grossPnl}, Fee: -$${pnlData.commission}, Net PnL: $${pnlData.netPnl}`);
      Notifier.sendTradeClose({
        symbol: this.symbol,
        side: pos.side,
        qty: qty,
        exitPrice: finalExitPrice,
        pnl: pnlData.netPnl,
        commission: pnlData.commission,
        grossPnl: pnlData.grossPnl,
        reason: reason
      });
    } catch (err) {
      console.error(`Failed to close position: ${err.message}`);
    } finally {
      if (reason !== 'MANUAL_PANIC_CLOSE') {
        this.isTradingLocked = false;
      }
    }
  }

  async panicCloseAndHalt() {
    this.isTradingLocked = true;
    console.warn(`[EMERGENCY_PANIC] Initiating immediate panic close and halt for ${this.symbol}...`);
    let closedDetails = null;

    try {
      // 1. Cancel all resting open orders and algo orders immediately on Binance
      try {
        await Binance.cancelAllOpenOrders(this.symbol);
      } catch (err) {
        console.warn(`[PANIC_CANCEL_ORDERS_WARN] ${err.message}`);
      }
      try {
        await Binance.cancelAllAlgoOrders(this.symbol);
      } catch (err) {
        console.warn(`[PANIC_CANCEL_ALGO_WARN] ${err.message}`);
      }

      // 2. Check local DB position
      const currentMode = strategy.api.isTestnet ? 'DEMO' : 'REAL';
      const pos = db.prepare('SELECT * FROM active_positions WHERE symbol = ? AND mode = ?').get(this.symbol, currentMode);

      // 3. Check exchange position directly on Binance as validation/fallback
      let remoteQty = null;
      let remoteSide = null;
      try {
        const accountInfo = await Binance.getAccountInfo();
        const p = accountInfo.positions && accountInfo.positions.find(item => item.symbol === this.symbol);
        if (p && parseFloat(p.positionAmt) !== 0) {
          const amt = parseFloat(p.positionAmt);
          remoteQty = Math.abs(amt).toString();
          remoteSide = amt > 0 ? 'LONG' : 'SHORT';
        }
      } catch (err) {
        console.warn(`[PANIC_EXCHANGE_CHECK_WARN] ${err.message}`);
      }

      const activeSide = pos ? pos.side : remoteSide;
      const activeQty = pos ? new BigNumber(pos.qty).abs().toString() : remoteQty;

      if (activeSide && activeQty && Number(activeQty) > 0) {
        console.log(`[PANIC] Executing MARKET close for ${activeSide} ${activeQty} on ${this.symbol}...`);
        await Binance.closePosition(this.symbol, activeSide, activeQty);

        // Cancel any lingering orders again after market close
        await Binance.cancelAllOpenOrders(this.symbol).catch(() => {});
        await Binance.cancelAllAlgoOrders(this.symbol).catch(() => {});

        const exitPrice = (this.lastPrice || (pos ? pos.entry_price : '0')).toString();

        // Calculate Net PnL and Commission
        const pnlData = await this.calculateNetPnlAndCommission(pos, exitPrice, activeQty, activeSide);

        const finalExitPrice = (pnlData.exitPrice || exitPrice).toString();
        // Clear SQLite DB & record in trade_history
        const insertTx = db.transaction(() => {
          db.prepare(`
            INSERT INTO trade_history (id, timestamp, side, price, qty, pnl, commission, mode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(Date.now().toString(), Date.now(), activeSide === 'LONG' ? 'SELL' : 'BUY', finalExitPrice, activeQty, pnlData.netPnl, pnlData.commission, currentMode);

          db.prepare('DELETE FROM position_fills WHERE position_id = ? AND mode = ?').run(this.symbol, currentMode);
          db.prepare('DELETE FROM active_positions WHERE symbol = ? AND mode = ?').run(this.symbol, currentMode);
        });
        insertTx();
        redis.del(`pos:${this.symbol}:${currentMode}`);
        this.clearActivePositionFilterState();

        closedDetails = {
          symbol: this.symbol,
          side: activeSide,
          qty: activeQty,
          exitPrice: finalExitPrice,
          pnl: pnlData.netPnl,
          commission: pnlData.commission,
          grossPnl: pnlData.grossPnl,
          reason: 'MANUAL_PANIC_CLOSE'
        };

        await Notifier.sendTradeClose(closedDetails);
      }

      await Notifier.sendAlert(
        "🚨 PANIC HALT TRIGGERED",
        closedDetails
          ? `Tombol Panic ditekan! Posisi aktif (${closedDetails.side} ${closedDetails.qty} BTC) telah DITUTUP secara instan di market Binance dan seluruh order dibatalkan. Eksekusi trading DIKUNCI (LOCKED).`
          : "Tombol Panic ditekan! Seluruh open order dibatalkan dan eksekusi trading DIKUNCI (LOCKED). Tidak ada posisi aktif.",
        "ERROR"
      );

      return {
        status: 'PANIC_COMPLETED',
        positionClosed: Boolean(closedDetails),
        details: closedDetails,
        isTradingLocked: true
      };
    } catch (err) {
      console.error(`[PANIC_CRITICAL_ERROR] Failed during panic close: ${err.message}`);
      await Notifier.sendAlert(
        "🚨 PANIC HALT ERROR",
        `Gagal menutup posisi saat Panic Halt: ${err.message}. Harap cek Binance langsung!`,
        "ERROR"
      );
      throw err;
    } finally {
      this.isTradingLocked = true; // MUST STAY LOCKED!
    }
  }

  async placeExchangeSlTp(side, qty, slPrice, tpPrice) {
    try {
      const currentMode = strategy.api.isTestnet ? 'DEMO' : 'REAL';
      const currentPos = db.prepare('SELECT sl_id, tp_id FROM active_positions WHERE symbol = ? AND mode = ?').get(this.symbol, currentMode);
      if (currentPos && currentPos.sl_id) {
        await Binance.cancelAlgoOrder(this.symbol, currentPos.sl_id);
      }
      await Binance.cancelAllAlgoOrders(this.symbol);
      await Binance.cancelAllOpenOrders(this.symbol);

      const slRes = await Binance.setStopLoss(this.symbol, side, qty, slPrice);
      const slId = slRes ? (slRes.algoId || slRes.orderId) : null;
      console.log(`[BINANCE_SL_SUCCESS] Stop Loss Algo Order placed on Binance @ ${slPrice} (Algo ID: ${slId})`);

      const tpRes = await Binance.setTakeProfit(this.symbol, side, qty, tpPrice);
      const tpId = tpRes ? tpRes.orderId : null;
      console.log(`[BINANCE_TP_SUCCESS] Take Profit Limit Order placed on Binance @ ${tpPrice} (Order ID: ${tpId})`);

      db.prepare('UPDATE active_positions SET sl_id = ?, tp_id = ? WHERE symbol = ? AND mode = ?')
        .run(slId ? slId.toString() : null, tpId ? tpId.toString() : null, this.symbol, currentMode);
    } catch (err) {
      console.warn(`[EXCHANGE_ORDER_NOTE] Conditional exchange order: ${err.message}. Local real-time monitoring active.`);
    }
  }

  async updateExchangeSl(side, qty, newSlPrice) {
    if (this.isUpdatingExchangeSl) {
      console.log(`[TRAILING_SL_SKIP] Exchange SL update already in flight. Skipping overlapping call.`);
      return;
    }
    this.isUpdatingExchangeSl = true;
    try {
      const currentMode = strategy.api.isTestnet ? 'DEMO' : 'REAL';
      // 1. Purge existing algo orders first so Binance never accumulates duplicate/double conditional orders
      const pos = db.prepare('SELECT sl_id FROM active_positions WHERE symbol = ? AND mode = ?').get(this.symbol, currentMode);
      if (pos && pos.sl_id) {
        await Binance.cancelAlgoOrder(this.symbol, pos.sl_id).catch(() => {});
      }
      await Binance.cancelAllAlgoOrders(this.symbol).catch(() => {});

      // 2. Place fresh single conditional Stop Loss order
      const slRes = await Binance.setStopLoss(this.symbol, side, qty, newSlPrice);
      const slId = slRes ? (slRes.algoId || slRes.orderId) : null;
      db.prepare('UPDATE active_positions SET sl_id = ? WHERE symbol = ? AND mode = ?')
        .run(slId ? slId.toString() : null, this.symbol, currentMode);
      console.log(`[BINANCE_TRAILING_SL] Updated Binance Stop Loss to ${newSlPrice} (Algo ID: ${slId})`);
    } catch (err) {
      console.warn(`[EXCHANGE_TRAILING_SL_NOTE] Failed to update exchange SL: ${err.message}`);
    } finally {
      this.isUpdatingExchangeSl = false;
    }
  }

  async shutdown() {
      console.log("Graceful shutdown initiated...");
      try {
          try {
            const { closeAllSseClients } = require('./dashboard-server');
            if (typeof closeAllSseClients === 'function') closeAllSseClients();
          } catch (e) {}

          // Sync close operations etc...
          db.pragma('wal_checkpoint(TRUNCATE)');
          db.close();
          redis.quit();
          console.log("Shutdown complete.");
          process.exit(0);
      } catch (e) {
          console.error("Shutdown Error", e);
          process.exit(1);
      }
  }
}

const core = new TradingCore();

process.on('SIGINT', () => core.shutdown());
process.on('SIGTERM', () => core.shutdown());

core.start();
module.exports = core;
require('./dashboard-server');
