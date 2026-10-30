const test = require('node:test');
const assert = require('node:assert');
const Indicators = require('../services/indicators');

test('Indicators Calculation Suite', async (t) => {
    await t.test('calculateEMA should compute correctly', () => {
        const prices = [10, 11, 12, 13, 14, 15, 16];
        const period = 3;
        const ema = Indicators.calculateEMA(prices, period);
        assert.ok(ema !== null, 'EMA should not be null');
        assert.strictEqual(ema.length, prices.length - period + 1, 'EMA length should be correct');
        // SMA of first 3 is (10+11+12)/3 = 11
        // Next is (13 - 11) * (2/4) + 11 = 12
        assert.strictEqual(ema[0].toNumber(), 11, 'Initial SMA should be 11');
        assert.strictEqual(ema[1].toNumber(), 12, 'Next EMA should be 12');
    });

    await t.test('calculateEMA with too few prices', () => {
        const prices = [10, 11];
        const ema = Indicators.calculateEMA(prices, 3);
        assert.strictEqual(ema, null, 'EMA should return null if insufficient prices');
    });

    await t.test('calculateSMA should compute moving average correctly', () => {
        const values = [10, 20, 30, 40, 50];
        const sma = Indicators.calculateSMA(values, 3);
        assert.ok(sma !== null, 'SMA should not be null');
        assert.strictEqual(sma.length, 3, 'SMA length should be 3');
        assert.strictEqual(sma[0].toNumber(), 20, 'First SMA (10+20+30)/3 = 20');
        assert.strictEqual(sma[1].toNumber(), 30, 'Second SMA (20+30+40)/3 = 30');
        assert.strictEqual(sma[2].toNumber(), 40, 'Third SMA (30+40+50)/3 = 40');
    });

    await t.test('calculateADX should compute trend strength and identify strong trend', () => {
        const candles = [];
        let price = 80000;
        for (let i = 0; i < 50; i++) {
            price += 100; // Strong uptrend
            candles.push({
                startTime: (1700000000000 + i * 300000).toString(),
                open: price - 50,
                high: price + 60,
                low: price - 60,
                close: price,
                volume: 50
            });
        }
        const adx = Indicators.calculateADX(candles, 14);
        assert.ok(adx !== null, 'ADX should not be null');
        assert.ok(adx.length > 0, 'ADX series should contain elements');
        const lastAdx = adx[adx.length - 1].toNumber();
        assert.ok(lastAdx > 20, `ADX during strong trend should be > 20 (got ${lastAdx})`);
    });

    await t.test('aggregateCandles should group 5m candles into 15m intervals', () => {
        const bucketMs = 15 * 60 * 1000;
        const baseTime = Math.floor(1700000000000 / bucketMs) * bucketMs;
        const candles = [
            { startTime: (baseTime).toString(), open: 100, high: 105, low: 98, close: 102, volume: 10 },
            { startTime: (baseTime + 300000).toString(), open: 102, high: 110, low: 101, close: 108, volume: 15 },
            { startTime: (baseTime + 600000).toString(), open: 108, high: 112, low: 107, close: 111, volume: 20 },
            { startTime: (baseTime + 900000).toString(), open: 111, high: 115, low: 109, close: 114, volume: 12 }
        ];

        const agg = Indicators.aggregateCandles(candles, 15);
        assert.strictEqual(agg.length, 2, 'Should aggregate into 2 buckets (1 full 15m and 1 next bucket)');
        const first = agg[0];
        assert.strictEqual(first.open, '100', 'First open should match earliest candle open');
        assert.strictEqual(first.high, '112', 'First high should match max high');
        assert.strictEqual(first.low, '98', 'First low should match min low');
        assert.strictEqual(first.close, '111', 'First close should match last candle close');
        assert.strictEqual(first.volume, '45', 'First volume should be sum of 10+15+20');
        assert.strictEqual(first.count, 3, 'First bucket should have 3 candles');
    });

    await t.test('calculateSupportResistance should extract key levels correctly', () => {
        const candles = [
            { startTime: '1', open: '81500', high: '82000', low: '81200', close: '81800' },
            { startTime: '2', open: '81800', high: '83500', low: '81600', close: '83200' },
            { startTime: '3', open: '83200', high: '83400', low: '81000', close: '81300' },
            { startTime: '4', open: '81300', high: '82500', low: '81100', close: '82200' }
        ];

        const sr = Indicators.calculateSupportResistance(candles, 4);
        assert.ok(sr !== null, 'S/R should not be null');
        assert.strictEqual(sr.support.toNumber(), 81000, 'Support should be min low (81000)');
        assert.strictEqual(sr.resistance.toNumber(), 83500, 'Resistance should be max high (83500)');
        assert.strictEqual(sr.midPoint.toNumber(), 82250, 'Midpoint should be (83500+81000)/2 = 82250');
    });

    await t.test('evaluateKeyLevelSetup should identify Support bounce, Resistance rejection, and Mid-range chop', () => {
        const keyLevels = {
            support: '81000',
            resistance: '83500'
        };

        // 1. Support bounce with bullish hammer candle
        const supportCandle = {
            open: '81250',
            high: '81350',
            low: '81050', // tests support (within 0.35%)
            close: '81300' // green hammer
        };
        const suppSetup = Indicators.evaluateKeyLevelSetup(supportCandle, keyLevels, { zoneTolerancePct: 0.35, minRejectionWickPct: 0.25 });
        assert.strictEqual(suppSetup.isAtSupport, true, 'Should detect price at Support zone');
        assert.strictEqual(suppSetup.isAtResistance, false, 'Should not be at Resistance');
        assert.strictEqual(suppSetup.hasBullishRejection, true, 'Should confirm bullish rejection / bounce');

        // 2. Resistance rejection with bearish shooting star candle
        const resistanceCandle = {
            open: '83400',
            high: '83550', // tests resistance (within 0.35%)
            low: '83200',
            close: '83250' // red shooting star
        };
        const resSetup = Indicators.evaluateKeyLevelSetup(resistanceCandle, keyLevels, { zoneTolerancePct: 0.35, minRejectionWickPct: 0.25 });
        assert.strictEqual(resSetup.isAtResistance, true, 'Should detect price at Resistance zone');
        assert.strictEqual(resSetup.isAtSupport, false, 'Should not be at Support');
        assert.strictEqual(resSetup.hasBearishRejection, true, 'Should confirm bearish rejection');

        // 3. Mid-range chop (neither at support nor resistance)
        const midCandle = {
            open: '82200',
            high: '82350',
            low: '82100',
            close: '82280'
        };
        const midSetup = Indicators.evaluateKeyLevelSetup(midCandle, keyLevels, { zoneTolerancePct: 0.35, minRejectionWickPct: 0.25 });
        assert.strictEqual(midSetup.isAtSupport, false, 'Mid-range should NOT be at Support');
        assert.strictEqual(midSetup.isAtResistance, false, 'Mid-range should NOT be at Resistance');
    });

    await t.test('calculateOrderBookImbalance should compute depth OBI ratio accurately', () => {
        const mockDepth = {
            bids: [
                ['82000', '10.5'],
                ['81990', '5.0'],
                ['81980', '4.5']
            ], // total bids = 20.0
            asks: [
                ['82010', '15.0'],
                ['82020', '10.0'],
                ['82030', '5.0']
            ] // total asks = 30.0
        };

        const obi = Indicators.calculateOrderBookImbalance(mockDepth);
        assert.ok(obi !== null, 'OBI should not be null');
        assert.strictEqual(obi.bidVol, 20.0, 'Total bid volume should be 20.0');
        assert.strictEqual(obi.askVol, 30.0, 'Total ask volume should be 30.0');
        assert.strictEqual(obi.obi, 0.4, 'OBI ratio should be 20 / 50 = 0.4');
        assert.strictEqual(obi.ratio, 0.67, 'Bid/Ask ratio should be 20 / 30 = 0.67');
    });
});

