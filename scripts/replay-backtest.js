#!/usr/bin/env node
'use strict';

/**
 * Mainnet Historical Replay & Backtest Harness (Strictly Read-Only)
 *
 * Fetches Binance Futures Mainnet 1m klines, reconstructs 5m candles with authentic
 * taker buy/sell ratio from kline takerBuyBaseAssetVolume, and replays the exact
 * Adaptive Multi-Regime + Key Level Sniper + Confluence Score logic from
 * services/indicators.js & src/trading-core.js with 1m intra-bar SL/TP/Time-Exit checks.
 *
 * Usage:
 *   node scripts/replay-backtest.js [--days=14] [--hold=30] [--floorSl=0.50] [--rr=2.0] [--fee=0.08]
 * Or via VPS container:
 *   ssh "$VPS_USER@$VPS_IP" 'docker exec -i -w /app bot-trading-bot-1 node -' < scripts/replay-backtest.js
 */

const path = require('path');
const axios = require('axios');
const BigNumber = require('bignumber.js');

function loadModule(relFromRoot) {
  const candidates = [
    path.resolve(process.cwd(), relFromRoot),
    path.resolve(__dirname, '..', relFromRoot)
  ];
  for (const p of candidates) {
    try {
      return require(p);
    } catch (e) {}
  }
  throw new Error(`Unable to load module: ${relFromRoot}`);
}

const Indicators = loadModule('services/indicators');
const strategy = loadModule('config/strategy');

function parseArgs(argv) {
  const opts = {
    days: Number(process.env.BACKTEST_DAYS || 14),
    holdMinutes: Number(process.env.BACKTEST_HOLD || strategy.trading.maxHoldMinutes || 30),
    floorSlPct: Number(process.env.BACKTEST_FLOOR_SL || strategy.trading.floorSlPct || 0.50),
    slAtrMult: Number(process.env.BACKTEST_SL_ATR || strategy.trading.baseSlAtrMultiplier || 2.0),
    rrRatio: Number(process.env.BACKTEST_RR || strategy.trading.rrRatio || 2.0),
    minScore: Number(process.env.BACKTEST_MIN_SCORE || strategy.trading.confluence?.minScore || 70),
    feeRoundTripPct: Number(process.env.BACKTEST_FEE_RT || 0.08),
    lossCooldownMin: Number(process.env.BACKTEST_COOLDOWN || (strategy.risk?.lossCooldown?.enabled ? strategy.risk.lossCooldown.minutes : 0)),
    initialEquity: Number(process.env.BACKTEST_EQUITY || 1000),
    riskPct: Number(process.env.BACKTEST_RISK_PCT || strategy.trading.riskPerTradePct || 1.0),
    leverage: Number(process.env.BACKTEST_LEVERAGE || strategy.trading.leverage || 50),
    compare: process.argv.includes('--compare')
  };
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z0-9]+)=(.+)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'days') opts.days = Number(v);
    else if (k === 'hold') opts.holdMinutes = Number(v);
    else if (k === 'floorSl') opts.floorSlPct = Number(v);
    else if (k === 'slAtr') opts.slAtrMult = Number(v);
    else if (k === 'rr') opts.rrRatio = Number(v);
    else if (k === 'minScore') opts.minScore = Number(v);
    else if (k === 'fee') opts.feeRoundTripPct = Number(v);
    else if (k === 'cooldown') opts.lossCooldownMin = Number(v);
    else if (k === 'equity') opts.initialEquity = Number(v);
  }
  return opts;
}

async function fetchMainnet1mKlines(symbol, days) {
  const end = Date.now();
  let start = end - days * 24 * 60 * 60 * 1000;
  const klines1m = [];
  while (start < end) {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol, interval: '1m', startTime: start, limit: 1500 },
      timeout: 10000
    });
    if (!Array.isArray(res.data) || res.data.length === 0) break;
    for (const k of res.data) {
      klines1m.push({
        startTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        takerBuyVol: Number(k[9])
      });
    }
    const lastOpen = Number(res.data[res.data.length - 1][0]);
    if (lastOpen + 60000 <= start) break;
    start = lastOpen + 60000;
  }
  return klines1m;
}

function build5mCandlesFrom1m(klines1m) {
  const buckets = new Map();
  for (const k of klines1m) {
    const bucketStart = Math.floor(k.startTime / 300000) * 300000;
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, []);
    buckets.get(bucketStart).push(k);
  }
  const candles5m = [];
  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const t of sortedKeys) {
    const bars = buckets.get(t);
    if (bars.length < 5) continue; // Only complete 5m candles
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    let takerBuyVol = 0;
    for (const b of bars) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume;
      takerBuyVol += b.takerBuyVol;
    }
    const takerSellVol = Math.max(0, volume - takerBuyVol);
    const takerRatio = takerSellVol > 0 ? takerBuyVol / takerSellVol : 1.0;
    candles5m.push({
      startTime: String(t),
      closeTimeMs: t + 300000,
      open: String(bars[0].open),
      high: String(high),
      low: String(low),
      close: String(bars[bars.length - 1].close),
      volume: String(volume),
      takerRatio: Number(takerRatio.toFixed(3)),
      bars1m: bars
    });
  }
  return candles5m;
}

function getAligned(series, index, totalLen) {
  if (!series) return null;
  const pos = series.length - (totalLen - index);
  return pos >= 0 && pos < series.length ? series[pos] : null;
}

function evaluateSignalAtIndex(candles5m, i, seriesCache) {
  const N = candles5m.length;
  const lastCandle = candles5m[i];
  const takerRatio = lastCandle.takerRatio;

  const lastEma20 = getAligned(seriesCache.ema20, i, N);
  const lastEma50 = getAligned(seriesCache.ema50, i, N);
  const lastRsi = getAligned(seriesCache.rsi, i, N);
  const lastMacdHist = getAligned(seriesCache.macdHist, i, N);
  const prevMacdHist = i > 0 ? getAligned(seriesCache.macdHist, i - 1, N) : lastMacdHist;
  const currentAtr = getAligned(seriesCache.atr, i, N);
  const adxVal = getAligned(seriesCache.adx, i, N);
  const volSmaVal = getAligned(seriesCache.volSma, i, N);

  if (!lastEma20 || !lastEma50 || !lastRsi || !lastMacdHist || !currentAtr) return null;

  const lastClose = new BigNumber(lastCandle.close);
  const lastOpen = new BigNumber(lastCandle.open);
  const lastHigh = new BigNumber(lastCandle.high);
  const lastLow = new BigNumber(lastCandle.low);
  const isCandleGreen = lastClose.isGreaterThan(lastOpen);
  const isCandleRed = lastClose.isLessThan(lastOpen);
  const isMacdRising = prevMacdHist ? lastMacdHist.isGreaterThan(prevMacdHist) : false;
  const isMacdFalling = prevMacdHist ? lastMacdHist.isLessThan(prevMacdHist) : false;

  const filterConfig = strategy.trading.filters || {};
  const currentAdx = adxVal !== null ? Number(adxVal.toFixed(2)) : null;

  const currentVol = Number(lastCandle.volume || 0);
  const currentVolSma = volSmaVal !== null ? Number(volSmaVal.toFixed(2)) : null;

  const maxMem = strategy.trading.maxMemoryCandles || 500;
  const candlesSlice = candles5m.slice(Math.max(0, i + 1 - maxMem), i + 1);

  const mtfMinutes = filterConfig.multiTimeframe?.higherIntervalMinutes || 15;
  const mtfEmaPeriod = filterConfig.multiTimeframe?.higherEmaPeriod || 25;
  const agg15 = Indicators.aggregateCandles(candlesSlice, mtfMinutes);
  let mtfTrend = 'NEUTRAL';
  let mtfEma50 = null;
  if (agg15 && agg15.length >= mtfEmaPeriod) {
    const closes15 = agg15.map(c => Number(c.close));
    const ema15 = Indicators.calculateEMA(closes15, mtfEmaPeriod);
    if (ema15 && ema15.length > 0) {
      mtfEma50 = Number(ema15[ema15.length - 1].toFixed(2));
      mtfTrend = closes15[closes15.length - 1] >= mtfEma50 ? 'BULLISH' : 'BEARISH';
    }
  }

  const keyLevelsCfg = strategy.trading.keyLevels || {};
  const keyLevels = (agg15 && agg15.length >= 3)
    ? Indicators.calculateSupportResistance(agg15, keyLevelsCfg.lookbackCandles || 24, keyLevelsCfg.macroLookbackCandles || 96)
    : Indicators.calculateSupportResistance(candlesSlice, keyLevelsCfg.lookbackCandles || 24, keyLevelsCfg.macroLookbackCandles || 96);

  const keyLevelSetup = keyLevels
    ? Indicators.evaluateKeyLevelSetup(lastCandle, keyLevels, {
        zoneTolerancePct: keyLevelsCfg.zoneTolerancePct || 0.35,
        minRejectionWickPct: keyLevelsCfg.minRejectionWickPct || 0.25
      })
    : null;

  const trendRegimeCfg = strategy.trading.trendRegime || {};
  const regimeInfo = Indicators.classifyMarketRegime({
    close: lastClose.toNumber(),
    ema20: lastEma20.toNumber(),
    ema50: lastEma50.toNumber(),
    mtfTrend,
    adx: currentAdx,
    adxTrendThreshold: trendRegimeCfg.adxTrendThreshold || 20,
    adxStrongThreshold: trendRegimeCfg.adxStrongThreshold || 25
  });

  const marketRegime = regimeInfo.marketRegime;
  const isSidewaysMarket = regimeInfo.isSideways;
  const isNormalMarket = regimeInfo.isNormal;
  const isBullishRegime = marketRegime === 'STRONG_BULLISH' || marketRegime === 'BULLISH_TREND';
  const isBearishRegime = marketRegime === 'STRONG_BEARISH' || marketRegime === 'BEARISH_TREND';

  const isTestingSupport = keyLevelSetup && keyLevelSetup.isAtSupport;
  const isTestingResistance = keyLevelSetup && keyLevelSetup.isAtResistance;
  const isLowerZone = keyLevelSetup && keyLevelSetup.isLowerRangeZone;
  const isUpperZone = keyLevelSetup && keyLevelSetup.isUpperRangeZone;
  const lowerWick = keyLevelSetup ? keyLevelSetup.lowerWickRatio : 0;
  const upperWick = keyLevelSetup ? keyLevelSetup.upperWickRatio : 0;

  const pullbackTol = (trendRegimeCfg.emaPullbackTolerancePct || 0.45) / 100;
  const ema20Val = lastEma20.toNumber();
  const ema50Val = lastEma50.toNumber();
  const mtfEmaVal = mtfEma50 || ema50Val;
  const closeVal = lastClose.toNumber();
  const lowVal = lastLow.toNumber();
  const highVal = lastHigh.toNumber();

  const touchedBullEma = (
    (Math.abs(lowVal - ema20Val) / ema20Val <= pullbackTol && closeVal >= ema20Val * 0.998) ||
    (Math.abs(lowVal - ema50Val) / ema50Val <= pullbackTol && closeVal >= ema50Val * 0.998) ||
    (Math.abs(lowVal - mtfEmaVal) / mtfEmaVal <= pullbackTol && closeVal >= mtfEmaVal * 0.998) ||
    (lowVal <= ema20Val && closeVal >= ema20Val)
  );
  const touchedBearEma = (
    (Math.abs(highVal - ema20Val) / ema20Val <= pullbackTol && closeVal <= ema20Val * 1.002) ||
    (Math.abs(highVal - ema50Val) / ema50Val <= pullbackTol && closeVal <= ema50Val * 1.002) ||
    (Math.abs(highVal - mtfEmaVal) / mtfEmaVal <= pullbackTol && closeVal <= mtfEmaVal * 1.002) ||
    (highVal >= ema20Val && closeVal <= ema20Val)
  );

  let baseLong = false;
  let baseShort = false;
  let activePlaybook = 'SCANNING';
  let setupQualityPts = 0;

  if (isBullishRegime) {
    if ((isTestingSupport || isLowerZone) && (isCandleGreen || lowerWick >= 0.20)) {
      baseLong = true;
      activePlaybook = keyLevelSetup?.isMacroLevel ? 'BULL_MACRO_SUPPORT_BOUNCE' : 'BULL_SUPPORT_BOUNCE';
      setupQualityPts = keyLevelSetup?.isMacroLevel ? 25 : 23;
    } else if (keyLevelSetup?.isBreakout || (isTestingResistance && isCandleGreen && takerRatio >= (trendRegimeCfg.breakoutBuyTakerRatio || 1.05) && (lastMacdHist.isGreaterThan(0) || isMacdRising))) {
      baseLong = true;
      activePlaybook = 'BULL_BREAKOUT_CONTINUATION';
      setupQualityPts = 23;
    } else if (touchedBullEma && (isCandleGreen || lowerWick >= 0.22) && lastRsi.isLessThanOrEqualTo(65) && takerRatio >= 0.80) {
      baseLong = true;
      activePlaybook = 'BULL_EMA_PULLBACK';
      setupQualityPts = 22;
    } else if (closeVal >= ema20Val && ema20Val >= ema50Val * 0.999 && isCandleGreen && (lastMacdHist.isGreaterThan(0) || isMacdRising) && lastRsi.isGreaterThanOrEqualTo(42) && lastRsi.isLessThanOrEqualTo(64) && takerRatio >= 0.92) {
      baseLong = true;
      activePlaybook = 'BULL_MOMENTUM_CONTINUATION';
      setupQualityPts = 20;
    }
  } else if (isBearishRegime) {
    if ((isTestingResistance || isUpperZone) && (isCandleRed || upperWick >= 0.20)) {
      baseShort = true;
      activePlaybook = keyLevelSetup?.isMacroLevel ? 'BEAR_MACRO_RESISTANCE_REJECT' : 'BEAR_RESISTANCE_REJECT';
      setupQualityPts = keyLevelSetup?.isMacroLevel ? 25 : 23;
    } else if (keyLevelSetup?.isBreakdown || (isTestingSupport && isCandleRed && takerRatio <= (trendRegimeCfg.breakdownSellTakerRatio || 0.95) && (lastMacdHist.isLessThan(0) || isMacdFalling))) {
      baseShort = true;
      activePlaybook = 'BEAR_BREAKDOWN_CONTINUATION';
      setupQualityPts = 23;
    } else if (touchedBearEma && (isCandleRed || upperWick >= 0.22) && lastRsi.isGreaterThanOrEqualTo(35) && takerRatio <= 1.20) {
      baseShort = true;
      activePlaybook = 'BEAR_EMA_PULLBACK';
      setupQualityPts = 22;
    } else if (closeVal <= ema20Val && ema20Val <= ema50Val * 1.001 && isCandleRed && (lastMacdHist.isLessThan(0) || isMacdFalling) && lastRsi.isGreaterThanOrEqualTo(36) && lastRsi.isLessThanOrEqualTo(58) && takerRatio <= 1.08) {
      baseShort = true;
      activePlaybook = 'BEAR_MOMENTUM_CONTINUATION';
      setupQualityPts = 20;
    }
  } else if (isSidewaysMarket) {
    if ((isTestingSupport || (isLowerZone && lastRsi.isLessThanOrEqualTo(48))) && (keyLevelSetup?.hasBullishRejection || isCandleGreen || lowerWick >= 0.20)) {
      baseLong = takerRatio >= 0.60;
      activePlaybook = keyLevelSetup?.isMacroLevel ? 'RANGE_MACRO_SUPPORT_BOUNCE' : 'RANGE_SUPPORT_BOUNCE';
      setupQualityPts = keyLevelSetup?.isMacroLevel ? 25 : 22;
    } else if ((isTestingResistance || (isUpperZone && lastRsi.isGreaterThanOrEqualTo(52))) && (keyLevelSetup?.hasBearishRejection || isCandleRed || upperWick >= 0.20)) {
      baseShort = takerRatio <= 1.65;
      activePlaybook = keyLevelSetup?.isMacroLevel ? 'RANGE_MACRO_RESISTANCE_REJECT' : 'RANGE_RESISTANCE_REJECT';
      setupQualityPts = keyLevelSetup?.isMacroLevel ? 25 : 22;
    } else if (keyLevels && closeVal < keyLevels.midPoint.toNumber() && lastRsi.isLessThanOrEqualTo(40) && isCandleGreen && takerRatio >= 0.60) {
      baseLong = true;
      activePlaybook = 'RANGE_OVERSOLD_BOUNCE';
      setupQualityPts = 20;
    } else if (keyLevels && closeVal > keyLevels.midPoint.toNumber() && lastRsi.isGreaterThanOrEqualTo(60) && isCandleRed && takerRatio <= 1.65) {
      baseShort = true;
      activePlaybook = 'RANGE_OVERBOUGHT_REJECT';
      setupQualityPts = 20;
    }
  } else {
    if ((isTestingSupport || isLowerZone) && (keyLevelSetup?.hasBullishRejection || isCandleGreen)) {
      baseLong = takerRatio >= 0.65;
      activePlaybook = 'NORMAL_SUPPORT_BOUNCE';
      setupQualityPts = keyLevelSetup?.isMacroLevel ? 25 : 22;
    } else if ((isTestingResistance || isUpperZone) && (keyLevelSetup?.hasBearishRejection || isCandleRed)) {
      baseShort = takerRatio <= 1.55;
      activePlaybook = 'NORMAL_RESISTANCE_REJECT';
      setupQualityPts = keyLevelSetup?.isMacroLevel ? 25 : 22;
    } else if (closeVal > ema20Val && (closeVal >= ema50Val || touchedBullEma) && isCandleGreen && (lastMacdHist.isGreaterThan(0) || isMacdRising) && lastRsi.isGreaterThanOrEqualTo(40) && lastRsi.isLessThanOrEqualTo(65) && takerRatio >= 0.90) {
      baseLong = true;
      activePlaybook = 'NORMAL_BULLISH_INFLECTION';
      setupQualityPts = 21;
    } else if (closeVal < ema20Val && (closeVal <= ema50Val || touchedBearEma) && isCandleRed && (lastMacdHist.isLessThan(0) || isMacdFalling) && lastRsi.isGreaterThanOrEqualTo(35) && lastRsi.isLessThanOrEqualTo(60) && takerRatio <= 1.10) {
      baseShort = true;
      activePlaybook = 'NORMAL_BEARISH_INFLECTION';
      setupQualityPts = 21;
    } else if (takerRatio >= 1.18 && isCandleGreen && lastRsi.isLessThanOrEqualTo(65)) {
      baseLong = true;
      activePlaybook = 'NORMAL_ORDERFLOW_LONG';
      setupQualityPts = 20;
    } else if (takerRatio <= 0.82 && isCandleRed && lastRsi.isGreaterThanOrEqualTo(35)) {
      baseShort = true;
      activePlaybook = 'NORMAL_ORDERFLOW_SHORT';
      setupQualityPts = 20;
    }
  }

  if (!baseLong && !baseShort) return { signal: 'NEUTRAL', marketRegime, activePlaybook };

  const adxMaxRange = filterConfig.adx?.maxRangeThreshold || 38;
  const isCounterTrendBounce = (baseLong && mtfTrend === 'BEARISH') || (baseShort && mtfTrend === 'BULLISH');
  const maxLongRsi = filterConfig.rsi?.maxLongRsi || 65;
  const minShortRsi = filterConfig.rsi?.minShortRsi || 35;

  const hardBlocked =
    (isCounterTrendBounce && currentAdx !== null && currentAdx > adxMaxRange) ||
    (baseLong && lastRsi.isGreaterThan(maxLongRsi)) ||
    (baseShort && lastRsi.isLessThan(minShortRsi));

  // Confluence score (historical replay uses neutral defaults for live-only OBI/Whale/AI: 12 + 8 + 8 = 28)
  const whaleConfig = filterConfig.whale || {};
  let takerScore = 0;
  if (baseLong && takerRatio >= 1.10) takerScore = 20;
  else if (baseShort && takerRatio <= 0.90) takerScore = 20;
  else if (baseLong && takerRatio >= 0.95) takerScore = 17;
  else if (baseShort && takerRatio <= 1.05) takerScore = 17;
  else if (baseLong && takerRatio >= (whaleConfig.takerVolumeRatio?.keyLevelMinLong || 0.85)) takerScore = 15;
  else if (baseShort && takerRatio <= (whaleConfig.takerVolumeRatio?.keyLevelMaxShort || 1.15)) takerScore = 15;
  else if (baseLong && takerRatio >= 0.70) takerScore = 10;
  else if (baseShort && takerRatio <= 1.30) takerScore = 10;

  const volMultiplier = filterConfig.volume?.minMultiplier ?? 0.70;
  let volScore = 8;
  if (currentVolSma !== null) {
    if (currentVol >= currentVolSma * 1.0) volScore = 10;
    else if (currentVol >= currentVolSma * volMultiplier) volScore = 8;
    else if (currentVol >= currentVolSma * 0.45) volScore = 6;
    else volScore = 3;
  }

  let mtfScore = 0;
  if (baseLong && mtfTrend === 'BULLISH') mtfScore = 10;
  else if (baseShort && mtfTrend === 'BEARISH') mtfScore = 10;
  else if (isSidewaysMarket || isNormalMarket || mtfTrend === 'NEUTRAL') mtfScore = 9;
  else if (keyLevelSetup && keyLevelSetup.isMacroLevel) mtfScore = 8;

  const confluenceScore = setupQualityPts + takerScore + 12 /* OB neutral */ + 8 /* Whale neutral */ + volScore + mtfScore + 8 /* AI neutral */;

  return {
    signal: baseLong ? 'LONG' : 'SHORT',
    marketRegime,
    activePlaybook,
    hardBlocked,
    confluenceScore,
    closePrice: closeVal,
    atr: currentAtr.toNumber()
  };
}

function precomputeSignals(candles5m) {
  const closes = candles5m.map(c => Number(c.close));
  const volumes = candles5m.map(c => Number(c.volume || 0));
  const filterConfig = strategy.trading.filters || {};
  const macd = Indicators.calculateMACD(closes, 12, 26, 9);
  const seriesCache = {
    ema20: Indicators.calculateEMA(closes, 20),
    ema50: Indicators.calculateEMA(closes, 50),
    rsi: Indicators.calculateRSI(closes, 14),
    macdHist: macd ? macd.histogram : null,
    atr: Indicators.calculateATR(candles5m, 14),
    adx: Indicators.calculateADX(candles5m, filterConfig.adx?.period || 14),
    volSma: Indicators.calculateSMA(volumes, filterConfig.volume?.period || 20)
  };
  const signals = new Array(candles5m.length).fill(null);
  for (let i = 100; i < candles5m.length - 1; i++) {
    signals[i] = evaluateSignalAtIndex(candles5m, i, seriesCache);
  }
  return signals;
}

function runSimulation(candles5m, klines1m, opts, precomputedSignals) {
  const index1mByTime = new Map();
  for (let i = 0; i < klines1m.length; i++) {
    index1mByTime.set(klines1m[i].startTime, i);
  }

  let equity = opts.initialEquity;
  let peakEquity = equity;
  let maxDdPct = 0;
  let lastSlExitTimeMs = 0;
  let busyUntilMs = 0;
  let signalsDetected = 0;
  let signalsBlocked = 0;
  const trades = [];

  for (let i = 100; i < candles5m.length - 1; i++) {
    const c = candles5m[i];
    const closeTimeMs = c.closeTimeMs;
    if (closeTimeMs < busyUntilMs) continue;

    const res = precomputedSignals[i];
    if (!res || res.signal === 'NEUTRAL') continue;

    signalsDetected++;
    if (res.hardBlocked || res.confluenceScore < opts.minScore) {
      signalsBlocked++;
      continue;
    }

    if (opts.lossCooldownMin > 0 && lastSlExitTimeMs > 0 && closeTimeMs - lastSlExitTimeMs < opts.lossCooldownMin * 60000) {
      signalsBlocked++;
      continue;
    }

    const entryPrice = res.closePrice;
    const baseSlDist = res.atr * opts.slAtrMult;
    const floorSlDist = entryPrice * (opts.floorSlPct / 100);
    const slDist = Math.max(baseSlDist, floorSlDist);
    const tpDist = slDist * opts.rrRatio;

    const isLong = res.signal === 'LONG';
    const slPrice = isLong ? entryPrice - slDist : entryPrice + slDist;
    const tpPrice = isLong ? entryPrice + tpDist : entryPrice - tpDist;

    // Position sizing matching TradingCore.executeTrade
    const riskAmt = equity * (opts.riskPct / 100);
    let qty = riskAmt / slDist;
    const maxQty = (equity * 0.70 * opts.leverage) / entryPrice;
    if (qty > maxQty) qty = maxQty;
    if (qty * entryPrice < (strategy.trading.minNotionalUSD || 10)) {
      qty = (strategy.trading.minNotionalUSD || 10) / entryPrice;
    }

    // Walk 1m bars from entry closeTimeMs up to holdMinutes
    const firstBarIdx = index1mByTime.get(closeTimeMs);
    if (firstBarIdx === undefined) continue;
    const maxBars = Math.max(1, Math.round(opts.holdMinutes));
    const endBarIdx = Math.min(klines1m.length - 1, firstBarIdx + maxBars - 1);

    let exitReason = 'TIME_LIMIT_EXIT';
    let exitPrice = klines1m[endBarIdx].close;
    let exitTimeMs = klines1m[endBarIdx].startTime + 60000;

    for (let j = firstBarIdx; j <= endBarIdx; j++) {
      const bar = klines1m[j];
      const hitSl = isLong ? bar.low <= slPrice : bar.high >= slPrice;
      const hitTp = isLong ? bar.high >= tpPrice : bar.low <= tpPrice;
      if (hitSl) {
        exitReason = 'STOP_LOSS';
        exitPrice = slPrice;
        exitTimeMs = bar.startTime + 60000;
        break;
      }
      if (hitTp) {
        exitReason = 'TAKE_PROFIT';
        exitPrice = tpPrice;
        exitTimeMs = bar.startTime + 60000;
        break;
      }
    }

    const grossPnl = isLong ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
    const notional = entryPrice * qty;
    const fee = notional * (opts.feeRoundTripPct / 100);
    const netPnl = grossPnl - fee;

    equity += netPnl;
    if (equity > peakEquity) peakEquity = equity;
    const ddPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;

    busyUntilMs = exitTimeMs;
    if (exitReason === 'STOP_LOSS') lastSlExitTimeMs = exitTimeMs;

    trades.push({
      time: new Date(closeTimeMs).toISOString(),
      side: res.signal,
      regime: res.marketRegime,
      playbook: res.activePlaybook,
      score: res.confluenceScore,
      entryPrice,
      exitPrice,
      qty,
      exitReason,
      holdMin: Math.round((exitTimeMs - closeTimeMs) / 60000),
      grossPnl,
      fee,
      netPnl
    });
  }

  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const totalFees = trades.reduce((s, t) => s + t.fee, 0);
  const totalNet = trades.reduce((s, t) => s + t.netPnl, 0);

  return {
    config: {
      floorSlPct: opts.floorSlPct,
      slAtrMult: opts.slAtrMult,
      rrRatio: opts.rrRatio,
      holdMinutes: opts.holdMinutes,
      feeRoundTripPct: opts.feeRoundTripPct,
      minScore: opts.minScore
    },
    signalsDetected,
    signalsBlocked,
    tradesCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? Infinity : 0),
    totalFees: Number(totalFees.toFixed(2)),
    totalNet: Number(totalNet.toFixed(2)),
    returnPct: Number((((equity - opts.initialEquity) / opts.initialEquity) * 100).toFixed(2)),
    maxDrawdownPct: Number(maxDdPct.toFixed(2)),
    avgHoldMin: trades.length ? Number((trades.reduce((s, t) => s + t.holdMin, 0) / trades.length).toFixed(1)) : 0,
    exits: {
      TP: trades.filter(t => t.exitReason === 'TAKE_PROFIT').length,
      SL: trades.filter(t => t.exitReason === 'STOP_LOSS').length,
      TIME: trades.filter(t => t.exitReason === 'TIME_LIMIT_EXIT').length
    },
    byRegime: groupBreakdown(trades, 'regime'),
    byPlaybook: groupBreakdown(trades, 'playbook')
  };
}

function groupBreakdown(trades, key) {
  const map = {};
  for (const t of trades) {
    const g = map[t[key]] || (map[t[key]] = { n: 0, wins: 0, net: 0 });
    g.n++;
    if (t.netPnl > 0) g.wins++;
    g.net = Number((g.net + t.netPnl).toFixed(2));
  }
  return map;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const symbol = strategy.trading.symbol || 'BTCUSDT';
  console.log(`[REPLAY] Fetching ${opts.days}d of Mainnet 1m klines for ${symbol}...`);
  const klines1m = await fetchMainnet1mKlines(symbol, opts.days);
  const candles5m = build5mCandlesFrom1m(klines1m);
  console.log(`[REPLAY] Loaded ${klines1m.length} 1m bars -> ${candles5m.length} complete 5m candles (${new Date(klines1m[0].startTime).toISOString()} .. ${new Date(klines1m[klines1m.length - 1].startTime).toISOString()}).`);

  const signals = precomputeSignals(candles5m);
  const baseline = runSimulation(candles5m, klines1m, opts, signals);
  console.log('\n=== BASELINE STRATEGY REPLAY ===');
  console.log(JSON.stringify(baseline, null, 2));

  if (opts.compare) {
    console.log('\n=== PARAMETER SENSITIVITY MATRIX ===');
    const scenarios = [
      { label: 'Current (SL>=0.50%, RR 1:2, 30m, taker 0.08%)', floorSlPct: 0.50, slAtrMult: 2.0, rrRatio: 2.0, holdMinutes: 30, feeRoundTripPct: 0.08 },
      { label: 'Longer Hold (SL>=0.50%, RR 1:2, 120m, taker 0.08%)', floorSlPct: 0.50, slAtrMult: 2.0, rrRatio: 2.0, holdMinutes: 120, feeRoundTripPct: 0.08 },
      { label: 'Pure ATR (SL>=0.15% / 2.0 ATR, RR 1:2, 60m, taker 0.08%)', floorSlPct: 0.15, slAtrMult: 2.0, rrRatio: 2.0, holdMinutes: 60, feeRoundTripPct: 0.08 },
      { label: 'Pure ATR + Maker Entry (SL>=0.15% / 2.0 ATR, RR 1:2, 60m, fee 0.05%)', floorSlPct: 0.15, slAtrMult: 2.0, rrRatio: 2.0, holdMinutes: 60, feeRoundTripPct: 0.05 },
      { label: 'Pure ATR Wide (SL>=0.20% / 2.5 ATR, RR 1:2, 120m, fee 0.05%)', floorSlPct: 0.20, slAtrMult: 2.5, rrRatio: 2.0, holdMinutes: 120, feeRoundTripPct: 0.05 }
    ];
    for (const sc of scenarios) {
      const r = runSimulation(candles5m, klines1m, { ...opts, ...sc }, signals);
      console.log(`\n-- ${sc.label} --`);
      console.log(JSON.stringify({
        trades: r.tradesCount,
        winRate: r.winRatePct + '%',
        PF: r.profitFactor,
        net: r.totalNet,
        fees: r.totalFees,
        maxDD: r.maxDrawdownPct + '%',
        exits: r.exits
      }));
    }
  }
})().catch((err) => {
  console.error('[REPLAY_ERROR]', err.message);
  process.exit(1);
});
