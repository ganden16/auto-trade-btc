const BigNumber = require('bignumber.js');

// Set precision
BigNumber.config({ DECIMAL_PLACES: 8, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = new BigNumber(2).dividedBy(period + 1);
  
  // Start with SMA for the first 'period' elements
  let sum = new BigNumber(0);
  for (let i = 0; i < period; i++) {
    sum = sum.plus(prices[i]);
  }
  let prevEma = sum.dividedBy(period);
  
  let emaResult = [prevEma];
  
  for (let i = period; i < prices.length; i++) {
    const currentPrice = new BigNumber(prices[i]);
    const ema = currentPrice.minus(prevEma).multipliedBy(k).plus(prevEma);
    emaResult.push(ema);
    prevEma = ema;
  }
  return emaResult;
}

function calculateRSI(prices, period = 14) {
  if (!prices || prices.length <= period) return null;
  
  let gains = new BigNumber(0);
  let losses = new BigNumber(0);
  
  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const diff = new BigNumber(prices[i]).minus(prices[i - 1]);
    if (diff.isGreaterThan(0)) {
      gains = gains.plus(diff);
    } else {
      losses = losses.plus(diff.abs());
    }
  }
  
  let avgGain = gains.dividedBy(period);
  let avgLoss = losses.dividedBy(period);
  
  let rsiResult = [];
  
  // Wilder's smoothing
  for (let i = period + 1; i < prices.length; i++) {
    const diff = new BigNumber(prices[i]).minus(prices[i - 1]);
    const gain = diff.isGreaterThan(0) ? diff : new BigNumber(0);
    const loss = diff.isLessThan(0) ? diff.abs() : new BigNumber(0);
    
    avgGain = avgGain.multipliedBy(period - 1).plus(gain).dividedBy(period);
    avgLoss = avgLoss.multipliedBy(period - 1).plus(loss).dividedBy(period);
    
    if (avgLoss.isZero()) {
      rsiResult.push(new BigNumber(100));
    } else {
      const rs = avgGain.dividedBy(avgLoss);
      const rsi = new BigNumber(100).minus(new BigNumber(100).dividedBy(rs.plus(1)));
      rsiResult.push(rsi);
    }
  }
  return rsiResult;
}

function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!prices || prices.length < slowPeriod + signalPeriod) return null;
  
  const fastEma = calculateEMA(prices, fastPeriod);
  const slowEma = calculateEMA(prices, slowPeriod);
  
  if (!fastEma || !slowEma) return null;
  
  // Align EMAs
  const diffLength = slowEma.length - fastEma.length; // usually negative
  const alignedFastEma = fastEma.slice(-slowEma.length);
  
  const macdLine = [];
  for (let i = 0; i < slowEma.length; i++) {
    macdLine.push(alignedFastEma[i].minus(slowEma[i]));
  }
  
  const signalLineEma = calculateEMA(macdLine.map(x => x.toNumber()), signalPeriod);
  if (!signalLineEma) return null;
  
  const alignedMacdLine = macdLine.slice(-signalLineEma.length);
  
  const histogram = [];
  for (let i = 0; i < signalLineEma.length; i++) {
    histogram.push(alignedMacdLine[i].minus(signalLineEma[i]));
  }
  
  return {
    macd: alignedMacdLine,
    signal: signalLineEma,
    histogram: histogram
  };
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length <= period) return null;
  
  // TR = max(high-low, abs(high-prevClose), abs(low-prevClose))
  const trList = [];
  for (let i = 1; i < candles.length; i++) {
    const high = new BigNumber(candles[i].high);
    const low = new BigNumber(candles[i].low);
    const prevClose = new BigNumber(candles[i - 1].close);
    
    const hl = high.minus(low);
    const hpc = high.minus(prevClose).abs();
    const lpc = low.minus(prevClose).abs();
    
    const tr = BigNumber.max(hl, hpc, lpc);
    trList.push(tr);
  }
  
  let sumTr = new BigNumber(0);
  for (let i = 0; i < period; i++) {
    sumTr = sumTr.plus(trList[i]);
  }
  
  let atr = sumTr.dividedBy(period);
  const atrResult = [atr];
  
  // Wilder's smoothing for ATR
  for (let i = period; i < trList.length; i++) {
    atr = atr.multipliedBy(period - 1).plus(trList[i]).dividedBy(period);
    atrResult.push(atr);
  }
  
  return atrResult;
}

function calculateSMA(values, period) {
  if (!values || values.length < period) return null;
  const result = [];
  let sum = new BigNumber(0);
  for (let i = 0; i < period; i++) {
    sum = sum.plus(values[i]);
  }
  result.push(sum.dividedBy(period));

  for (let i = period; i < values.length; i++) {
    sum = sum.plus(values[i]).minus(values[i - period]);
    result.push(sum.dividedBy(period));
  }
  return result;
}

function calculateADX(candles, period = 14) {
  if (!candles || candles.length < period * 2) return null;

  const trList = [];
  const plusDmList = [];
  const minusDmList = [];

  for (let i = 1; i < candles.length; i++) {
    const high = new BigNumber(candles[i].high);
    const low = new BigNumber(candles[i].low);
    const prevHigh = new BigNumber(candles[i - 1].high);
    const prevLow = new BigNumber(candles[i - 1].low);
    const prevClose = new BigNumber(candles[i - 1].close);

    const hl = high.minus(low);
    const hpc = high.minus(prevClose).abs();
    const lpc = low.minus(prevClose).abs();
    const tr = BigNumber.max(hl, hpc, lpc);
    trList.push(tr);

    const upMove = high.minus(prevHigh);
    const downMove = prevLow.minus(low);

    if (upMove.isGreaterThan(downMove) && upMove.isGreaterThan(0)) {
      plusDmList.push(upMove);
    } else {
      plusDmList.push(new BigNumber(0));
    }

    if (downMove.isGreaterThan(upMove) && downMove.isGreaterThan(0)) {
      minusDmList.push(downMove);
    } else {
      minusDmList.push(new BigNumber(0));
    }
  }

  if (trList.length < period * 2) return null;

  let trSmooth = new BigNumber(0);
  let plusDmSmooth = new BigNumber(0);
  let minusDmSmooth = new BigNumber(0);

  for (let i = 0; i < period; i++) {
    trSmooth = trSmooth.plus(trList[i]);
    plusDmSmooth = plusDmSmooth.plus(plusDmList[i]);
    minusDmSmooth = minusDmSmooth.plus(minusDmList[i]);
  }

  const dxList = [];
  const p = new BigNumber(period);

  const getDx = (plusDmS, minusDmS, trS) => {
    if (trS.isZero()) return new BigNumber(0);
    const plusDi = plusDmS.dividedBy(trS).multipliedBy(100);
    const minusDi = minusDmS.dividedBy(trS).multipliedBy(100);
    const diSum = plusDi.plus(minusDi);
    if (diSum.isZero()) return new BigNumber(0);
    return plusDi.minus(minusDi).abs().dividedBy(diSum).multipliedBy(100);
  };

  dxList.push(getDx(plusDmSmooth, minusDmSmooth, trSmooth));

  for (let i = period; i < trList.length; i++) {
    trSmooth = trSmooth.minus(trSmooth.dividedBy(p)).plus(trList[i]);
    plusDmSmooth = plusDmSmooth.minus(plusDmSmooth.dividedBy(p)).plus(plusDmList[i]);
    minusDmSmooth = minusDmSmooth.minus(minusDmSmooth.dividedBy(p)).plus(minusDmList[i]);
    dxList.push(getDx(plusDmSmooth, minusDmSmooth, trSmooth));
  }

  if (dxList.length < period) return null;

  let adxSum = new BigNumber(0);
  for (let i = 0; i < period; i++) {
    adxSum = adxSum.plus(dxList[i]);
  }

  let adx = adxSum.dividedBy(p);
  const adxResult = [adx];

  for (let i = period; i < dxList.length; i++) {
    adx = adx.multipliedBy(period - 1).plus(dxList[i]).dividedBy(p);
    adxResult.push(adx);
  }

  return adxResult;
}

function aggregateCandles(candles, bucketMinutes = 15) {
  if (!candles || candles.length === 0) return [];
  const bucketMs = bucketMinutes * 60 * 1000;
  const groups = new Map();

  for (const c of candles) {
    const time = Number(c.startTime);
    const bucketTime = Math.floor(time / bucketMs) * bucketMs;
    if (!groups.has(bucketTime)) {
      groups.set(bucketTime, []);
    }
    groups.get(bucketTime).push(c);
  }

  const sortedBuckets = Array.from(groups.keys()).sort((a, b) => a - b);
  const result = [];

  for (let i = 0; i < sortedBuckets.length; i++) {
    const bucketTime = sortedBuckets[i];
    const bucketCandles = groups.get(bucketTime);
    bucketCandles.sort((a, b) => Number(a.startTime) - Number(b.startTime));

    const open = bucketCandles[0].open;
    const close = bucketCandles[bucketCandles.length - 1].close;
    let high = new BigNumber(bucketCandles[0].high);
    let low = new BigNumber(bucketCandles[0].low);
    let vol = new BigNumber(0);

    for (const bc of bucketCandles) {
      high = BigNumber.max(high, new BigNumber(bc.high));
      low = BigNumber.min(low, new BigNumber(bc.low));
      vol = vol.plus(bc.volume || 0);
    }

    result.push({
      startTime: bucketTime.toString(),
      open: String(open),
      high: high.toString(),
      low: low.toString(),
      close: String(close),
      volume: vol.toString(),
      count: bucketCandles.length
    });
  }

  return result;
}

function calculateSupportResistance(candles, lookback = 24, macroLookback = 96) {
  if (!candles || candles.length < 3) return null;
  const recent = candles.slice(-lookback);
  let highestHigh = new BigNumber(recent[0].high);
  let lowestLow = new BigNumber(recent[0].low);

  for (let i = 1; i < recent.length; i++) {
    const h = new BigNumber(recent[i].high);
    const l = new BigNumber(recent[i].low);
    if (h.isGreaterThan(highestHigh)) highestHigh = h;
    if (l.isLessThan(lowestLow)) lowestLow = l;
  }

  const range = highestHigh.minus(lowestLow);
  const midPoint = lowestLow.plus(range.dividedBy(2));
  const rangePct = lowestLow.isGreaterThan(0)
    ? range.dividedBy(lowestLow).multipliedBy(100)
    : new BigNumber(0);

  // Multi-Horizon Macro Swing Levels (e.g., 96 x 15m = 24 hours rolling macro bounds)
  let macroSupport = lowestLow;
  let macroResistance = highestHigh;
  const macroRecent = candles.slice(-macroLookback);
  if (macroRecent.length > 0) {
    let macroHigh = new BigNumber(macroRecent[0].high);
    let macroLow = new BigNumber(macroRecent[0].low);
    for (let i = 1; i < macroRecent.length; i++) {
      const mh = new BigNumber(macroRecent[i].high);
      const ml = new BigNumber(macroRecent[i].low);
      if (mh.isGreaterThan(macroHigh)) macroHigh = mh;
      if (ml.isLessThan(macroLow)) macroLow = ml;
    }
    macroSupport = macroLow;
    macroResistance = macroHigh;
  }

  // Prior Swing Bounds (excluding the latest closed candle so breakout/breakdown detection is mathematically reachable)
  const priorSlice = candles.length > 1 ? candles.slice(-Math.min(candles.length, lookback + 1), -1) : recent;
  let priorHigh = new BigNumber(priorSlice[0].high);
  let priorLow = new BigNumber(priorSlice[0].low);
  for (let i = 1; i < priorSlice.length; i++) {
    const ph = new BigNumber(priorSlice[i].high);
    const pl = new BigNumber(priorSlice[i].low);
    if (ph.isGreaterThan(priorHigh)) priorHigh = ph;
    if (pl.isLessThan(priorLow)) priorLow = pl;
  }

  return {
    support: lowestLow,
    resistance: highestHigh,
    priorSupport: priorLow,
    priorResistance: priorHigh,
    macroSupport,
    macroResistance,
    midPoint,
    range,
    rangePct,
    lookbackCandles: recent.length,
    macroLookbackCandles: macroRecent.length
  };
}

function evaluateKeyLevelSetup(candle, keyLevels, options = {}) {
  if (!candle || !keyLevels) return null;

  const zoneTolerancePct = options.zoneTolerancePct !== undefined ? options.zoneTolerancePct : 0.35;
  const minRejectionWickPct = options.minRejectionWickPct !== undefined ? options.minRejectionWickPct : 0.25;

  const open = new BigNumber(candle.open);
  const high = new BigNumber(candle.high);
  const low = new BigNumber(candle.low);
  const close = new BigNumber(candle.close);
  const totalRange = high.minus(low);

  const support = new BigNumber(keyLevels.support);
  const resistance = new BigNumber(keyLevels.resistance);
  const priorSupport = keyLevels.priorSupport ? new BigNumber(keyLevels.priorSupport) : support;
  const priorResistance = keyLevels.priorResistance ? new BigNumber(keyLevels.priorResistance) : resistance;
  const macroSupport = keyLevels.macroSupport ? new BigNumber(keyLevels.macroSupport) : support;
  const macroResistance = keyLevels.macroResistance ? new BigNumber(keyLevels.macroResistance) : resistance;
  const tol = new BigNumber(zoneTolerancePct).dividedBy(100);

  const range = resistance.minus(support);
  const midPoint = keyLevels.midPoint ? new BigNumber(keyLevels.midPoint) : support.plus(range.dividedBy(2));
  const macroRange = macroResistance.minus(macroSupport);
  const macroMidPoint = macroSupport.plus(macroRange.dividedBy(2));

  // Position within tactical range (0.0 = at support, 1.0 = at resistance)
  const rangePosition = range.isGreaterThan(0)
    ? close.minus(support).dividedBy(range)
    : new BigNumber(0.5);
  const isLowerRangeZone = rangePosition.isLessThanOrEqualTo(0.28) && close.isGreaterThanOrEqualTo(support.multipliedBy(new BigNumber(1).minus(tol)));
  const isUpperRangeZone = rangePosition.isGreaterThanOrEqualTo(0.72) && close.isLessThanOrEqualTo(resistance.multipliedBy(new BigNumber(1).plus(tol)));

  // Tactical Proximity (e.g. 6h S/R)
  const supportUpperLimit = support.multipliedBy(new BigNumber(1).plus(tol));
  const supportLowerLimit = support.multipliedBy(new BigNumber(1).minus(tol));
  const isAtTacticalSupport = low.isLessThanOrEqualTo(supportUpperLimit) &&
                              close.isGreaterThanOrEqualTo(supportLowerLimit) &&
                              close.isLessThanOrEqualTo(midPoint);

  const resistanceLowerLimit = resistance.multipliedBy(new BigNumber(1).minus(tol));
  const resistanceUpperLimit = resistance.multipliedBy(new BigNumber(1).plus(tol));
  const isAtTacticalResistance = high.isGreaterThanOrEqualTo(resistanceLowerLimit) &&
                                 close.isLessThanOrEqualTo(resistanceUpperLimit) &&
                                 close.isGreaterThanOrEqualTo(midPoint);

  // Macro Proximity (e.g. 24h Daily S/R Anchor)
  const macroSupportUpper = macroSupport.multipliedBy(new BigNumber(1).plus(tol));
  const macroSupportLower = macroSupport.multipliedBy(new BigNumber(1).minus(tol));
  const isAtMacroSupport = low.isLessThanOrEqualTo(macroSupportUpper) &&
                           close.isGreaterThanOrEqualTo(macroSupportLower) &&
                           close.isLessThanOrEqualTo(macroMidPoint);

  const macroResLower = macroResistance.multipliedBy(new BigNumber(1).minus(tol));
  const macroResUpper = macroResistance.multipliedBy(new BigNumber(1).plus(tol));
  const isAtMacroResistance = high.isGreaterThanOrEqualTo(macroResLower) &&
                              close.isLessThanOrEqualTo(macroResUpper) &&
                              close.isGreaterThanOrEqualTo(macroMidPoint);

  const isAtSupport = isAtTacticalSupport || isAtMacroSupport;
  const isAtResistance = isAtTacticalResistance || isAtMacroResistance;
  const isMacroLevel = isAtMacroSupport || isAtMacroResistance;

  const activeSupport = isAtMacroSupport ? macroSupport : support;
  const activeResistance = isAtMacroResistance ? macroResistance : resistance;

  // Wick & Rejection Calculation
  const bodyBottom = BigNumber.min(open, close);
  const bodyTop = BigNumber.max(open, close);
  const lowerWick = bodyBottom.minus(low);
  const upperWick = high.minus(bodyTop);
  const candleBody = close.minus(open).abs();

  const lowerWickRatio = totalRange.isGreaterThan(0) ? lowerWick.dividedBy(totalRange) : new BigNumber(0);
  const upperWickRatio = totalRange.isGreaterThan(0) ? upperWick.dividedBy(totalRange) : new BigNumber(0);

  const isGreenCandle = close.isGreaterThan(open);
  const isRedCandle = close.isLessThan(open);

  const minWick = new BigNumber(minRejectionWickPct);
  // Rejection confirmed by absorption wick >= minWick OR a directional bounce candle
  const isDecisiveGreen = isGreenCandle && (lowerWickRatio.isGreaterThanOrEqualTo(0.15) || candleBody.isGreaterThan(totalRange.multipliedBy(0.25)));
  const isDecisiveRed = isRedCandle && (upperWickRatio.isGreaterThanOrEqualTo(0.15) || candleBody.isGreaterThan(totalRange.multipliedBy(0.25)));

  const hasBullishRejection = (isAtSupport || isLowerRangeZone) && (lowerWickRatio.isGreaterThanOrEqualTo(minWick) || isDecisiveGreen || isGreenCandle);
  const hasBearishRejection = (isAtResistance || isUpperRangeZone) && (upperWickRatio.isGreaterThanOrEqualTo(minWick) || isDecisiveRed || isRedCandle);

  const supportDistPct = close.minus(activeSupport).dividedBy(activeSupport).multipliedBy(100);
  const resistanceDistPct = activeResistance.minus(close).dividedBy(activeResistance).multipliedBy(100);

  const isBreakdown = (close.isLessThan(support) || close.isLessThan(priorSupport)) && isRedCandle;
  const isBreakout = (close.isGreaterThan(resistance) || close.isGreaterThan(priorResistance)) && isGreenCandle;

  return {
    isAtSupport,
    isAtResistance,
    isAtTacticalSupport,
    isAtTacticalResistance,
    isAtMacroSupport,
    isAtMacroResistance,
    isMacroLevel,
    isLowerRangeZone,
    isUpperRangeZone,
    rangePosition: Number(rangePosition.toFixed(3)),
    isBreakdown,
    isBreakout,
    hasBullishRejection,
    hasBearishRejection,
    isGreenCandle,
    isRedCandle,
    lowerWickRatio: lowerWickRatio.toNumber(),
    upperWickRatio: upperWickRatio.toNumber(),
    supportDistPct: Number(supportDistPct.toFixed(2)),
    resistanceDistPct: Number(resistanceDistPct.toFixed(2)),
    supportPrice: activeSupport.toFixed(2),
    resistancePrice: activeResistance.toFixed(2),
    priorSupportPrice: priorSupport.toFixed(2),
    priorResistancePrice: priorResistance.toFixed(2),
    tacticalSupportPrice: support.toFixed(2),
    tacticalResistancePrice: resistance.toFixed(2),
    macroSupportPrice: macroSupport.toFixed(2),
    macroResistancePrice: macroResistance.toFixed(2)
  };
}

function classifyMarketRegime({ close, ema20, ema50, mtfTrend, adx, adxTrendThreshold = 20, adxStrongThreshold = 25 }) {
  const closeNum = Number(close);
  const ema20Num = ema20 !== null && ema20 !== undefined ? Number(ema20) : closeNum;
  const ema50Num = ema50 !== null && ema50 !== undefined ? Number(ema50) : closeNum;
  const adxNum = adx !== null && adx !== undefined ? Number(adx) : 20;

  const is15mBullish = mtfTrend === 'BULLISH';
  const is15mBearish = mtfTrend === 'BEARISH';
  const is5mAboveEma50 = closeNum >= ema50Num;
  const is5mBelowEma50 = closeNum < ema50Num;
  const is5mAboveEma20 = closeNum >= ema20Num;
  const is5mBelowEma20 = closeNum < ema20Num;
  const isEmaBullishStack = ema20Num >= ema50Num;
  const isEmaBearishStack = ema20Num <= ema50Num;

  // 1. SIDEWAYS / RANGE REGIME: Low directional trend strength (ADX < threshold)
  if (adxNum < adxTrendThreshold) {
    return {
      marketRegime: 'SIDEWAYS_RANGE',
      trendBias: 'DUAL_DIRECTION',
      isTrending: false,
      isSideways: true,
      isNormal: false
    };
  }

  // 2. BULLISH TREND REGIMES (STRONG_BULLISH / BULLISH_TREND)
  if (is15mBullish && is5mAboveEma50 && isEmaBullishStack && adxNum >= adxStrongThreshold) {
    return {
      marketRegime: 'STRONG_BULLISH',
      trendBias: 'LONGS_ONLY',
      isTrending: true,
      isSideways: false,
      isNormal: false
    };
  }
  if (is15mBullish && (is5mAboveEma50 || is5mAboveEma20)) {
    return {
      marketRegime: 'BULLISH_TREND',
      trendBias: 'LONGS_ONLY',
      isTrending: true,
      isSideways: false,
      isNormal: false
    };
  }

  // 3. BEARISH TREND REGIMES (STRONG_BEARISH / BEARISH_TREND)
  if (is15mBearish && is5mBelowEma50 && isEmaBearishStack && adxNum >= adxStrongThreshold) {
    return {
      marketRegime: 'STRONG_BEARISH',
      trendBias: 'SHORTS_ONLY',
      isTrending: true,
      isSideways: false,
      isNormal: false
    };
  }
  if (is15mBearish && (is5mBelowEma50 || is5mBelowEma20)) {
    return {
      marketRegime: 'BEARISH_TREND',
      trendBias: 'SHORTS_ONLY',
      isTrending: true,
      isSideways: false,
      isNormal: false
    };
  }

  // 4. NORMAL / TRANSITION MARKET REGIME (5m and 15m diverging or inflection phase)
  return {
    marketRegime: 'NORMAL_MARKET',
    trendBias: 'DUAL_DIRECTION',
    isTrending: false,
    isSideways: false,
    isNormal: true
  };
}

function calculateOrderBookImbalance(depth) {
  if (!depth || !depth.bids || !depth.asks || depth.bids.length === 0 || depth.asks.length === 0) {
    return null;
  }
  let bidVol = new BigNumber(0);
  let askVol = new BigNumber(0);

  for (const b of depth.bids) {
    bidVol = bidVol.plus(b[1] || 0);
  }
  for (const a of depth.asks) {
    askVol = askVol.plus(a[1] || 0);
  }

  const totalVol = bidVol.plus(askVol);
  if (totalVol.isZero()) return null;

  const obi = bidVol.dividedBy(totalVol);
  const ratio = askVol.isGreaterThan(0) ? bidVol.dividedBy(askVol) : new BigNumber(1);

  return {
    obi: Number(obi.toFixed(4)), // e.g. 0.5821 (58.21% bids)
    bidVol: Number(bidVol.toFixed(3)),
    askVol: Number(askVol.toFixed(3)),
    ratio: Number(ratio.toFixed(2)),
    levels: Math.min(depth.bids.length, depth.asks.length)
  };
}

module.exports = {
  calculateEMA,
  calculateRSI,
  calculateMACD,
  calculateATR,
  calculateSMA,
  calculateADX,
  aggregateCandles,
  calculateSupportResistance,
  evaluateKeyLevelSetup,
  classifyMarketRegime,
  calculateOrderBookImbalance
};

