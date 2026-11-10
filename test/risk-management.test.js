const test = require('node:test');
const assert = require('node:assert');
const strategy = require('../config/strategy');
const BigNumber = require('bignumber.js');

test('Risk Management Logic Suite', async (t) => {
    await t.test('Position sizing formula calculation', () => {
        const equity = new BigNumber(1000);
        const riskPct = strategy.trading.riskPerTradePct; // 2%
        const atr = new BigNumber(100);
        const multiplier = strategy.trading.atrMultiplierForSize; // 2

        // Risk = 20
        // Size = Risk / (ATR * Multiplier) = 20 / (100 * 2) = 0.1
        const riskAmt = equity.multipliedBy(riskPct).dividedBy(100);
        const qty = riskAmt.dividedBy(atr.multipliedBy(multiplier));

        const expected = 1000 * (strategy.trading.riskPerTradePct / 100) / (100 * multiplier);
        assert.strictEqual(qty.toNumber(), expected, `Position sizing should equal ${expected}`);
    });

    await t.test('Stop Loss and Take Profit calculation (LONG)', () => {
        const entryPrice = new BigNumber(80000);
        const atr = new BigNumber(50);

        const baseSl = atr.multipliedBy(strategy.trading.baseSlAtrMultiplier); // 50 * 1.0 = 50
        const floorSl = entryPrice.multipliedBy(strategy.trading.floorSlPct).dividedBy(100); // 80000 * 0.0020 = 160
        const slDist = BigNumber.maximum(baseSl, floorSl); // 160 (0.20%)
        const tpDist = slDist.multipliedBy(strategy.trading.rrRatio); // 160 * 2.0 = 320 (0.40%)

        const slPrice = entryPrice.minus(slDist); // 79840
        const tpPrice = entryPrice.plus(tpDist); // 80320

        assert.strictEqual(slPrice.toNumber(), 79840, 'Long SL should be 79840 (-0.20%)');
        assert.strictEqual(tpPrice.toNumber(), 80320, 'Long TP should be 80320 (+0.40% at 1:2.0 RR)');
    });

    await t.test('Stop Loss and Take Profit calculation (SHORT)', () => {
        const entryPrice = new BigNumber(80000);
        const atr = new BigNumber(50);

        const baseSl = atr.multipliedBy(strategy.trading.baseSlAtrMultiplier); // 50
        const floorSl = entryPrice.multipliedBy(strategy.trading.floorSlPct).dividedBy(100); // 160
        const slDist = BigNumber.maximum(baseSl, floorSl); // 160 (0.20%)
        const tpDist = slDist.multipliedBy(strategy.trading.rrRatio); // 320 (0.40%)

        const slPrice = entryPrice.plus(slDist); // 80160
        const tpPrice = entryPrice.minus(tpDist); // 79680

        assert.strictEqual(slPrice.toNumber(), 80160, 'Short SL should be 80160 (+0.20%)');
        assert.strictEqual(tpPrice.toNumber(), 79680, 'Short TP should be 79680 (-0.40% at 1:2.0 RR)');
    });

    await t.test('Trailing Stop Activation Threshold', () => {
        const atr = new BigNumber(100);
        const activationThreshold = atr.multipliedBy(strategy.trading.trailingStop.activationAtrMultiplier); // 150
        assert.strictEqual(activationThreshold.toNumber(), 150, 'Activation threshold should be 1.5 * ATR = 150');
    });

    await t.test('Position sizing with actual Stop Loss distance and margin cap', () => {
        const equity = new BigNumber(4922);
        const availableBalance = new BigNumber(4922);
        const price = new BigNumber(83000);
        const atr = new BigNumber(36.6);
        const leverage = new BigNumber(strategy.trading.leverage);

        const baseSl = atr.multipliedBy(strategy.trading.baseSlAtrMultiplier);
        const floorSl = price.multipliedBy(strategy.trading.floorSlPct).dividedBy(100);
        const actualSlDist = BigNumber.maximum(baseSl, floorSl);

        const riskAmt = equity.multipliedBy(strategy.trading.riskPerTradePct).dividedBy(100);
        let qty = riskAmt.dividedBy(actualSlDist);

        const maxUsableMargin = availableBalance.multipliedBy(0.70);
        const maxQty = maxUsableMargin.multipliedBy(leverage).dividedBy(price);
        if (qty.isGreaterThan(maxQty)) {
            qty = maxQty;
        }

        const qtyStr = qty.decimalPlaces(3, BigNumber.ROUND_DOWN).toString();
        assert.strictEqual(qtyStr, '0.296', 'Calculated quantity should be 0.296 BTC with 1.0% risk and 0.20% floor SL');
    });

    await t.test('Trailing Stop Minimum Step Threshold prevents micro-tick churn', () => {
        const atr = new BigNumber(100);
        const minStep = atr.multipliedBy(0.25); // 25
        const activeSl = new BigNumber(83000);

        // Candidate SL with micro-move of 5 (less than minStep 25)
        const microCandidate = new BigNumber(83005);
        const shouldTightenMicro = microCandidate.isGreaterThan(activeSl.plus(minStep));
        assert.strictEqual(shouldTightenMicro, false, 'Micro price tick should NOT trigger SL tightening');

        // Candidate SL with significant move of 30 (greater than minStep 25)
        const macroCandidate = new BigNumber(83030);
        const shouldTightenMacro = macroCandidate.isGreaterThan(activeSl.plus(minStep));
        assert.strictEqual(shouldTightenMacro, true, 'Significant price move >= 0.25 ATR SHOULD trigger SL tightening');
    });

    await t.test('Micro-account (e.g. 20 USDT) clamps safely to minimum 0.001 BTC lot size', () => {
        const equity = new BigNumber(20);
        const availableBalance = new BigNumber(20);
        const price = new BigNumber(83800);
        const leverage = new BigNumber(strategy.trading.leverage);
        const maxUsableMargin = availableBalance.multipliedBy(0.70); // 14 USDT

        const actualSlDist = price.multipliedBy(strategy.trading.floorSlPct).dividedBy(100);
        const riskAmt = equity.multipliedBy(strategy.trading.riskPerTradePct).dividedBy(100); // 0.30 USDT
        let qty = riskAmt.dividedBy(actualSlDist);

        let qtyStr = qty.decimalPlaces(3, BigNumber.ROUND_DOWN).toString();
        if (new BigNumber(qtyStr).isLessThanOrEqualTo(0)) {
            const minStepSize = new BigNumber(0.001);
            const minLotMargin = minStepSize.multipliedBy(price).dividedBy(leverage);
            if (minLotMargin.isLessThanOrEqualTo(maxUsableMargin)) {
                qtyStr = minStepSize.toString();
            }
        }

        assert.strictEqual(qtyStr, '0.001', 'Micro-account of 20 USDT should clamp to 0.001 BTC lot size');
    });

    await t.test('Kill Switch strictly isolates daily loss and trade history by mode (DEMO vs REAL)', () => {
        const mockTradeHistory = [
            { id: '1', timestamp: Date.now(), pnl: '-5.00', mode: 'DEMO' },
            { id: '2', timestamp: Date.now(), pnl: '-1.39', mode: 'DEMO' },
            { id: '3', timestamp: Date.now(), pnl: '0.00', mode: 'REAL' }
        ];

        const equity = new BigNumber(20);
        const maxDailyLoss = equity.multipliedBy(strategy.risk.dailyLossLimitPct).dividedBy(100); // 1.00 USDT

        // Mode REAL calculation
        const realTrades = mockTradeHistory.filter(t => t.mode === 'REAL');
        let realNetDailyPnl = new BigNumber(0);
        for (const t of realTrades) {
            realNetDailyPnl = realNetDailyPnl.plus(new BigNumber(t.pnl || 0));
        }

        const isRealLocked = realNetDailyPnl.isNegative() && realNetDailyPnl.abs().isGreaterThanOrEqualTo(maxDailyLoss);
        assert.strictEqual(isRealLocked, false, 'REAL mode should NOT be locked because REAL trades net PnL is $0.00');

        // Mode DEMO calculation
        const demoTrades = mockTradeHistory.filter(t => t.mode === 'DEMO');
        let demoNetDailyPnl = new BigNumber(0);
        for (const t of demoTrades) {
            demoNetDailyPnl = demoNetDailyPnl.plus(new BigNumber(t.pnl || 0));
        }
        const isDemoLocked = demoNetDailyPnl.isNegative() && demoNetDailyPnl.abs().isGreaterThanOrEqualTo(maxDailyLoss);
        assert.strictEqual(isDemoLocked, true, 'DEMO mode should be locked due to -$6.39 losses >= $1.00 daily loss limit');
    });

    await t.test('Whale Top Trader Long/Short Ratio Filter enforces smart money alignment', () => {
        const whaleCfg = strategy.trading.filters.whale.topTraderRatio;
        const minLong = whaleCfg.minLongThreshold; // 0.85
        const maxShort = whaleCfg.maxShortThreshold; // 1.80

        // Scenario 1: Whales heavily net short (ratio 0.72) -> LONG must be blocked
        const ttShortBias = 0.72;
        const isLongBlocked1 = ttShortBias < minLong;
        assert.strictEqual(isLongBlocked1, true, 'LONG trade should be BLOCKED when Top Trader ratio < 0.85 (whales short)');

        // Scenario 2: Whales neutral/bullish (ratio 1.15) -> LONG permitted
        const ttBullBias = 1.15;
        const isLongBlocked2 = ttBullBias < minLong;
        assert.strictEqual(isLongBlocked2, false, 'LONG trade should be PERMITTED when Top Trader ratio >= 0.85');

        // Scenario 3: Whales normal market long bias (ratio 1.45) -> SHORT permitted
        const isShortBlocked1 = ttBullBias > maxShort;
        assert.strictEqual(isShortBlocked1, false, 'SHORT trade permitted at 1.15');
        const isShortBlocked2 = 1.45 > maxShort;
        assert.strictEqual(isShortBlocked2, false, 'SHORT trade should be PERMITTED when Top Trader ratio is 1.45 <= 1.80');

        // Scenario 4: Whales overwhelmingly net long (ratio 1.95 > 1.80) -> SHORT blocked
        const isShortBlocked3 = 1.95 > maxShort;
        assert.strictEqual(isShortBlocked3, true, 'SHORT trade should be BLOCKED when Top Trader ratio > 1.80 (extreme whale long)');
    });

    await t.test('Taker Buy/Sell Order Flow Ratio Filter and Reality Triggers', () => {
        const realityCfg = strategy.trading.realityEngine;
        const minLongTaker = realityCfg.minTakerBuySellRatioLong; // 1.35
        const maxShortTaker = realityCfg.maxTakerBuySellRatioShort; // 0.65

        // Aggressive taker dumping (ratio 0.60 <= 0.65) -> SHORT candidate triggered
        const aggressiveSellFlow = 0.60;
        const isShortTriggered = aggressiveSellFlow <= maxShortTaker;
        assert.strictEqual(isShortTriggered, true, 'SHORT trade triggered when taker buy/sell ratio <= 0.65');

        // Aggressive taker pumping (ratio 1.40 >= 1.35) -> LONG candidate triggered
        const aggressiveBuyFlow = 1.40;
        const isLongTriggered = aggressiveBuyFlow >= minLongTaker;
        assert.strictEqual(isLongTriggered, true, 'LONG trade triggered when taker buy/sell ratio >= 1.35');

        // Balanced flow (ratio 1.00) -> Neutral (no trade)
        const balancedFlow = 1.00;
        assert.strictEqual(balancedFlow >= minLongTaker, false, 'Balanced flow does not trigger LONG');
        assert.strictEqual(balancedFlow <= maxShortTaker, false, 'Balanced flow does not trigger SHORT');
    });

    await t.test('Order Flow Reality Trigger & Candle Absorption Guard', () => {
        const realityCfg = strategy.trading.realityEngine;
        const minLongTaker = realityCfg.minTakerBuySellRatioLong; // 1.35
        const maxShortTaker = realityCfg.maxTakerBuySellRatioShort; // 0.65
        const requireCandle = realityCfg.requireCandleConfirmation;

        // Condition 1: High taker buy ratio (1.40) + Green candle (Close > Open) -> Valid LONG
        const takerBuyRatio = 1.40;
        const isGreenCandle = true;
        const validLong = (takerBuyRatio >= minLongTaker) && (!requireCandle || isGreenCandle);
        assert.strictEqual(validLong, true, 'LONG setup must pass with high taker buy ratio and green candle');

        // Condition 2: High taker buy ratio (1.40) + Red candle (iceberg absorption trap) -> Blocked LONG
        const isRedCandle = false;
        const absorbedLong = (takerBuyRatio >= minLongTaker) && (!requireCandle || isRedCandle);
        assert.strictEqual(absorbedLong, false, 'LONG setup must be blocked when candle is red (iceberg sell absorption)');

        // Condition 3: High taker sell ratio (0.60) + Red candle (Close < Open) -> Valid SHORT
        const takerSellRatio = 0.60;
        const isShortRed = true;
        const validShort = (takerSellRatio <= maxShortTaker) && (!requireCandle || isShortRed);
        assert.strictEqual(validShort, true, 'SHORT setup must pass with heavy taker sell flow and red candle');
    });

    await t.test('Volume participation filter enforces active liquidity', () => {
        const volCfg = strategy.trading.filters.volume;
        assert.strictEqual(volCfg.minMultiplier, 0.70, 'Volume filter minMultiplier should be 0.70 for liquid order execution');

        const currentVol = 400;
        const volSma = 500;
        const minVolRequired = volSma * volCfg.minMultiplier; // 350
        assert.strictEqual(currentVol >= minVolRequired, true, 'Volume at 80% of SMA should pass with 0.70 threshold');

        const dryVol = 300;
        assert.strictEqual(dryVol < minVolRequired, true, 'Volume below 70% of SMA should be blocked');
    });

    await t.test('Database schema strictly isolates active_positions by (symbol, mode) composite key', () => {
        const Database = require('better-sqlite3');
        const memDb = new Database(':memory:');
        memDb.exec(`
            CREATE TABLE active_positions (
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
        `);

        // Insert DEMO position
        memDb.prepare(`
            INSERT INTO active_positions (symbol, side, entry_price, qty, updated_at, mode)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run('BTCUSDT', 'LONG', '84000', '0.005', Date.now(), 'DEMO');

        // Insert REAL position on the same symbol
        memDb.prepare(`
            INSERT INTO active_positions (symbol, side, entry_price, qty, updated_at, mode)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run('BTCUSDT', 'SHORT', '84200', '0.002', Date.now(), 'REAL');

        const demoPos = memDb.prepare('SELECT * FROM active_positions WHERE symbol = ? AND mode = ?').get('BTCUSDT', 'DEMO');
        const realPos = memDb.prepare('SELECT * FROM active_positions WHERE symbol = ? AND mode = ?').get('BTCUSDT', 'REAL');

        assert.strictEqual(demoPos.side, 'LONG');
        assert.strictEqual(demoPos.qty, '0.005');
        assert.strictEqual(demoPos.mode, 'DEMO');

        assert.strictEqual(realPos.side, 'SHORT');
        assert.strictEqual(realPos.qty, '0.002');
        assert.strictEqual(realPos.mode, 'REAL');

        // Deleting DEMO does not affect REAL
        memDb.prepare('DELETE FROM active_positions WHERE symbol = ? AND mode = ?').run('BTCUSDT', 'DEMO');
        const remainingDemo = memDb.prepare('SELECT * FROM active_positions WHERE symbol = ? AND mode = ?').get('BTCUSDT', 'DEMO');
        const remainingReal = memDb.prepare('SELECT * FROM active_positions WHERE symbol = ? AND mode = ?').get('BTCUSDT', 'REAL');

        assert.strictEqual(remainingDemo, undefined);
        assert.strictEqual(remainingReal.side, 'SHORT');

        memDb.close();
    });

    await t.test('Net PnL calculation strictly deducts round-trip exchange commission fees', () => {
        const entryPrice = new BigNumber('83300');
        const exitPrice = new BigNumber('83500');
        const qty = new BigNumber('0.385');
        const isLong = true;

        const diff = isLong ? exitPrice.minus(entryPrice) : entryPrice.minus(exitPrice);
        const grossPnl = diff.multipliedBy(qty); // +77.00 USDT

        // Round-trip Binance taker commission (0.04% entry + 0.04% exit)
        const takerRate = new BigNumber(0.0004);
        const entryNotional = entryPrice.multipliedBy(qty);
        const exitNotional = exitPrice.multipliedBy(qty);
        const commission = entryNotional.plus(exitNotional).multipliedBy(takerRate);
        const netPnl = grossPnl.minus(commission);

        assert.strictEqual(grossPnl.toFixed(2), '77.00');
        assert.strictEqual(commission.toFixed(2), '25.69');
        assert.strictEqual(netPnl.toFixed(2), '51.31');
        assert.strictEqual(netPnl.isLessThan(grossPnl), true, 'Net PnL must strictly be lower than Gross PnL due to commission deduction');
    });

    await t.test('ADX Trend Strength Filter blocks trades in sideways choppy markets', () => {
        const adxCfg = strategy.trading.filters.adx;
        const threshold = adxCfg.threshold; // 22

        // Strong trend passes
        const strongTrendAdx = 24.5;
        const pass = !adxCfg.enabled || (strongTrendAdx >= threshold);
        assert.strictEqual(pass, true, 'ADX >= 22 must pass filter');

        // Sideways choppy market blocked
        const weakAdx = 14.2;
        const blocked = adxCfg.enabled && (weakAdx < threshold);
        assert.strictEqual(blocked, true, 'ADX < 22 must be blocked in Sniper Mode');
    });

    await t.test('Multi-Timeframe 15m Trend Filter enforces trend confluence', () => {
        const mtfCfg = strategy.trading.filters.multiTimeframe;

        // LONG setup with BULLISH 15m trend -> Passes
        let mtfTrend = 'BULLISH';
        let longPassed = !mtfCfg.enabled || (mtfTrend === 'BULLISH');
        assert.strictEqual(longPassed, true, 'LONG must pass when 15m trend is BULLISH');

        // LONG setup with BEARISH 15m trend -> Blocked
        mtfTrend = 'BEARISH';
        let longCounterTrendBlocked = mtfCfg.enabled && (mtfTrend !== 'BULLISH');
        assert.strictEqual(longCounterTrendBlocked, true, 'LONG must be blocked when 15m trend is BEARISH');

        // SHORT setup with BEARISH 15m trend -> Passes
        let shortPassed = !mtfCfg.enabled || (mtfTrend === 'BEARISH');
        assert.strictEqual(shortPassed, true, 'SHORT must pass when 15m trend is BEARISH');

        // SHORT setup with BULLISH 15m trend -> Blocked
        mtfTrend = 'BULLISH';
        let shortCounterTrendBlocked = mtfCfg.enabled && (mtfTrend !== 'BEARISH');
        assert.strictEqual(shortCounterTrendBlocked, true, 'SHORT must be blocked when 15m trend is BULLISH');
    });

    await t.test('Position reconciliation logic correctly synchronizes signed Binance positions', () => {
        // Binance SHORT returns negative positionAmt
        const exchangeShortPos = { positionAmt: "-0.127", entryPrice: "80925.68" };
        const dbShortPos = { symbol: 'BTCUSDT', side: 'SHORT', qty: '0.127', entry_price: '80925.68' };

        const exQty = new BigNumber(exchangeShortPos ? exchangeShortPos.positionAmt : 0);
        const locQty = new BigNumber(dbShortPos ? dbShortPos.qty : 0);
        const exSide = exQty.isGreaterThan(0) ? 'LONG' : (exQty.isLessThan(0) ? 'SHORT' : null);
        const locSide = dbShortPos ? dbShortPos.side : null;

        const isSynced = (exQty.isZero() && (!dbShortPos || locQty.isZero())) ||
            (!exQty.isZero() && dbShortPos && exQty.abs().isEqualTo(locQty.abs()) && exSide === locSide);

        assert.strictEqual(isSynced, true, 'Binance negative SHORT positionAmt must correctly match DB SHORT qty');

        // Mismatched side should fail
        const dbLongPos = { symbol: 'BTCUSDT', side: 'LONG', qty: '0.127', entry_price: '80925.68' };
        const isMismatched = !exQty.isZero() && dbLongPos && exQty.abs().isEqualTo(new BigNumber(dbLongPos.qty).abs()) && exSide === dbLongPos.side;
        assert.strictEqual(isMismatched, false, 'Opposite side must be flagged as mismatch');
    });

    await t.test('Break-Even Stop Loss Guard locks profit and round-trip fee buffer', () => {
        const beCfg = strategy.trading.trailingStop.breakEven;
        assert.strictEqual(beCfg.enabled, false, 'Break-even guard should be disabled to prevent premature profit throttling');
        assert.strictEqual(beCfg.triggerProfitPct, 0.25, 'Trigger profit should be 0.25%');
        assert.strictEqual(beCfg.feeBufferPct, 0.05, 'Fee buffer should be 0.05%');

        const entryPrice = new BigNumber(80000);
        const triggerProfitPct = new BigNumber(beCfg.triggerProfitPct);
        const feeBufferPct = new BigNumber(beCfg.feeBufferPct);

        // Long position: price rises by 0.25% (to 80200)
        const currLongPrice = entryPrice.multipliedBy(new BigNumber(1).plus(triggerProfitPct.dividedBy(100))); // 80200
        const profitPctLong = currLongPrice.minus(entryPrice).dividedBy(entryPrice).multipliedBy(100);
        assert.strictEqual(profitPctLong.gte(triggerProfitPct), true, 'Profit should reach or exceed trigger');

        const beLongSl = entryPrice.multipliedBy(new BigNumber(1).plus(feeBufferPct.dividedBy(100))).decimalPlaces(1, BigNumber.ROUND_DOWN);
        assert.strictEqual(beLongSl.toNumber(), 80040, 'Long Break-Even SL should be Entry + 0.05% = 80040');

        // Short position: price drops by 0.25% (to 79800)
        const currShortPrice = entryPrice.multipliedBy(new BigNumber(1).minus(triggerProfitPct.dividedBy(100))); // 79800
        const profitPctShort = entryPrice.minus(currShortPrice).dividedBy(entryPrice).multipliedBy(100);
        assert.strictEqual(profitPctShort.gte(triggerProfitPct), true, 'Short profit should reach trigger');

        const beShortSl = entryPrice.multipliedBy(new BigNumber(1).minus(feeBufferPct.dividedBy(100))).decimalPlaces(1, BigNumber.ROUND_UP);
        assert.strictEqual(beShortSl.toNumber(), 79960, 'Short Break-Even SL should be Entry - 0.05% = 79960');
    });

    await t.test('Funding Rate Guard blocks entry during extreme funding rate conditions', () => {
        const fundingCfg = strategy.trading.filters.fundingRate;
        assert.strictEqual(fundingCfg.enabled, true, 'Funding rate filter should be enabled');
        assert.strictEqual(fundingCfg.maxAbsoluteRate, 0.0004, 'Max absolute funding rate should be 0.04%');

        const normalFunding = 0.0001; // +0.01%
        assert.strictEqual(normalFunding <= fundingCfg.maxAbsoluteRate && normalFunding >= -fundingCfg.maxAbsoluteRate, true, 'Normal funding should pass');

        const extremeHighFunding = 0.0006; // +0.06%
        assert.strictEqual(extremeHighFunding > fundingCfg.maxAbsoluteRate, true, 'Extreme positive funding should block LONG');

        const extremeNegativeFunding = -0.0005; // -0.05%
        assert.strictEqual(extremeNegativeFunding < -fundingCfg.maxAbsoluteRate, true, 'Extreme negative funding should block SHORT');
    });

    await t.test('Post-Stop-Loss Cooldown period blocks new entries for configured duration', () => {
        const cooldownCfg = strategy.risk.lossCooldown;
        assert.strictEqual(cooldownCfg.enabled, true, 'Loss cooldown should be enabled');
        assert.strictEqual(cooldownCfg.minutes, 20, 'Loss cooldown duration should be 20 minutes');

        const now = Date.now();
        const recentSlTime = now - (5 * 60 * 1000); // 5 mins ago
        const cooldownMs = cooldownCfg.minutes * 60 * 1000;
        const isCooldownActive = (now - recentSlTime) < cooldownMs;
        assert.strictEqual(isCooldownActive, true, 'Cooldown must be active 5 minutes after Stop Loss');

        const oldSlTime = now - (25 * 60 * 1000); // 25 mins ago
        const isOldCooldownActive = (now - oldSlTime) < cooldownMs;
        assert.strictEqual(isOldCooldownActive, false, 'Cooldown must expire after 20 minutes');
    });

    await t.test('RSI Exhaustion Guard blocks buying overbought and selling oversold extremes', () => {
        const rsiCfg = strategy.trading.filters.rsi;
        assert.strictEqual(rsiCfg.enabled, true, 'RSI filter should be enabled');
        assert.strictEqual(rsiCfg.maxLongRsi, 65, 'Max RSI for Long should be 65');
        assert.strictEqual(rsiCfg.minShortRsi, 35, 'Min RSI for Short should be 35');

        // Overbought RSI (72 > 65) -> Blocks LONG
        const overboughtRsi = 72;
        const longBlocked = overboughtRsi > rsiCfg.maxLongRsi;
        assert.strictEqual(longBlocked, true, 'LONG must be blocked when RSI > 65 (overbought exhaustion)');

        // Healthy RSI for LONG (55 <= 65) -> Permits LONG
        const healthyLongRsi = 55;
        const longPermitted = healthyLongRsi <= rsiCfg.maxLongRsi;
        assert.strictEqual(longPermitted, true, 'LONG must be permitted when RSI <= 65');

        // Oversold RSI (28 < 35) -> Blocks SHORT
        const oversoldRsi = 28;
        const shortBlocked = oversoldRsi < rsiCfg.minShortRsi;
        assert.strictEqual(shortBlocked, true, 'SHORT must be blocked when RSI < 35 (oversold exhaustion)');

        // Healthy RSI for SHORT (45 >= 35) -> Permits SHORT
        const healthyShortRsi = 45;
        const shortPermitted = healthyShortRsi >= rsiCfg.minShortRsi;
        assert.strictEqual(shortPermitted, true, 'SHORT must be permitted when RSI >= 35');
    });

    await t.test('Key Level Sniper and News Directional Confluence Configuration', () => {
        assert.strictEqual(strategy.trading.strategyMode, 'KEY_LEVEL_SNIPER', 'Strategy mode should be KEY_LEVEL_SNIPER');
        assert.ok(strategy.trading.keyLevels, 'Key levels configuration must be present');
        assert.strictEqual(strategy.trading.keyLevels.enabled, true, 'Key levels should be enabled');
        assert.strictEqual(strategy.trading.keyLevels.lookbackCandles, 24, 'Lookback should be 24 candles');
        assert.strictEqual(strategy.trading.keyLevels.macroLookbackCandles, 96, 'Macro lookback should be 96 candles (24h daily swing)');
        assert.strictEqual(strategy.trading.keyLevels.multiHorizon, true, 'Multi-horizon S/R should be enabled');
        assert.ok(strategy.trading.confluence, 'Confluence scoring configuration must be present');
        assert.strictEqual(strategy.trading.confluence.enabled, true, 'Confluence scoring should be enabled');
        assert.strictEqual(strategy.trading.confluence.minScore, 70, 'Min confluence score should be 70 pts');
        assert.strictEqual(strategy.trading.trailingStop.enabled, false, 'Trailing stop should be disabled to preserve full 1:2 R:R profit');

        // News directional confluence
        const minVetoConf = strategy.ai.minVetoConfidence || 7;
        const bearishNews = { sentiment: 'BEARISH', confidence: 8 };
        const bullishNews = { sentiment: 'BULLISH', confidence: 8 };
        const neutralNews = { sentiment: 'NEUTRAL', confidence: 5 };

        // LONG at Support: Bullish or Neutral allowed, Bearish blocked
        const longWithBearish = (bearishNews.sentiment === 'BEARISH' && bearishNews.confidence >= minVetoConf);
        const longWithBullish = (bullishNews.sentiment === 'BEARISH' && bullishNews.confidence >= minVetoConf);
        const longWithNeutral = (neutralNews.sentiment === 'BEARISH' && neutralNews.confidence >= minVetoConf);

        assert.strictEqual(longWithBearish, true, 'LONG must be vetoed when News is Bearish');
        assert.strictEqual(longWithBullish, false, 'LONG must pass when News is Bullish');
        assert.strictEqual(longWithNeutral, false, 'LONG must pass when News is Neutral');

        // SHORT at Resistance: Bearish or Neutral allowed, Bullish blocked
        const shortWithBullish = (bullishNews.sentiment === 'BULLISH' && bullishNews.confidence >= minVetoConf);
        const shortWithBearish = (bearishNews.sentiment === 'BULLISH' && bearishNews.confidence >= minVetoConf);
        const shortWithNeutral = (neutralNews.sentiment === 'BULLISH' && neutralNews.confidence >= minVetoConf);

        assert.strictEqual(shortWithBullish, true, 'SHORT must be vetoed when News is Bullish');
        assert.strictEqual(shortWithBearish, false, 'SHORT must pass when News is Bearish');
        assert.strictEqual(shortWithNeutral, false, 'SHORT must pass when News is Neutral');
    });

    await t.test('Calibrated S/R Key Level filter confluence resolves MTF and ADX paradoxes', () => {
        const filters = strategy.trading.filters;

        // 1. ADX ceiling for Range-Bound S/R
        assert.strictEqual(filters.adx.maxRangeThreshold, 38, 'ADX maxRangeThreshold must be 38 to guard against runaway trend blowouts');
        const rangeAdx = 18.5;
        const runawayAdx = 42.0;
        assert.strictEqual(rangeAdx <= filters.adx.maxRangeThreshold, true, 'Low ADX (18.5) must be permitted for S/R range bounces');
        assert.strictEqual(runawayAdx <= filters.adx.maxRangeThreshold, false, 'Runaway breakout ADX (42.0) must be blocked');

        // 2. Taker Flow Absorption at Key Levels
        const takerCfg = filters.whale.takerVolumeRatio;
        assert.strictEqual(takerCfg.keyLevelMinLong, 0.85, 'Key Level Min Long Taker should be 0.85 for limit absorption');
        assert.strictEqual(takerCfg.keyLevelMaxShort, 1.15, 'Key Level Max Short Taker should be 1.15 for limit absorption');

        const earlyBounceTaker = 0.95;
        assert.strictEqual(earlyBounceTaker >= takerCfg.keyLevelMinLong, true, 'Early bounce taker ratio (0.95) passes in Key Level mode');

        // 3. Structural Top Trader Short Allowance
        const ttCfg = filters.whale.topTraderRatio;
        assert.strictEqual(ttCfg.keyLevelMaxShortThreshold, 2.25, 'Key Level Max Short Threshold must be 2.25 for Binance BTC futures');
        const structuralLongRatio = 1.95;
        assert.strictEqual(structuralLongRatio <= ttCfg.keyLevelMaxShortThreshold, true, 'Whale ratio 1.95 permits SHORT at Resistance in Key Level mode');
    });

    await t.test('Time-Based Stale Exit triggers when position duration exceeds maxHoldMinutes', () => {
        const maxHoldMin = strategy.trading.maxHoldMinutes || 60;
        assert.strictEqual(maxHoldMin, 60, 'Default maxHoldMinutes should be 60 minutes');

        const staleEntryTime = Date.now() - (65 * 60 * 1000); // 65m ago
        const staleElapsed = (Date.now() - staleEntryTime) / 60000;
        assert.strictEqual(staleElapsed >= maxHoldMin, true, 'Stale trade (65m) should trigger TIME_LIMIT_EXIT');

        const freshEntryTime = Date.now() - (30 * 60 * 1000); // 30m ago
        const freshElapsed = (Date.now() - freshEntryTime) / 60000;
        assert.strictEqual(freshElapsed >= maxHoldMin, false, 'Fresh trade (30m) should NOT trigger TIME_LIMIT_EXIT');
    });
});

