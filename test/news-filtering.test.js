const test = require('node:test');
const assert = require('node:assert');
const News = require('../services/news');
const strategy = require('../config/strategy');

test('News & Macro Intelligence Filtering Suite', async (t) => {
    await t.test('Spam and promotional headlines are identified and blocked', () => {
        const spamHeadlines = [
            'Bitcoin News Today: Whale Activity Returns as Remittix Enters the Last Stretch Before Market Trading',
            'Best Crypto Presale to Buy Now: 100x Potential Meme Coin',
            'New Airdrop Announced: Claim Your Free Tokens Today',
            'Top 5 Sponsored ICOs Ready to Explode in 2026',
            'Bitcoin Price Prediction: A Whale Who Bought at $8,900 Turns $40.8M Into $378M, While Analysts Eye 1000x for Pepeto - openPR.com'
        ];

        for (const headline of spamHeadlines) {
            assert.strictEqual(News.isSpam(headline), true, `Failed to flag spam: ${headline}`);
            assert.strictEqual(News.isHighImpactMacro(headline), false, `Spam should not qualify as high impact: ${headline}`);
        }
    });

    await t.test('Pure altcoin noise without Bitcoin or macro anchor is filtered out', () => {
        const altcoinHeadlines = [
            'Ethereum News: ETH Price Surge 2.2% Amid Kraken Deposit and Whale Move - Coin Gabbar',
            'Whale Moves Ethereum Price, Earns $1.28 Million: New Platform Tightens Limits - Koin Bülteni',
            'Solana DeFi Volume Hits Record High on Raydium',
            'Cardano ADA Whale Transactions Jump 300%'
        ];

        for (const headline of altcoinHeadlines) {
            assert.strictEqual(News.isPureAltcoin(headline), true, `Failed to flag altcoin noise: ${headline}`);
            assert.strictEqual(News.isHighImpactMacro(headline), false, `Altcoin noise should not qualify as high impact: ${headline}`);
        }
    });

    await t.test('Genuine Bitcoin and macro headlines pass high-impact filter', () => {
        const validMacroHeadlines = [
            'Bitcoin Ranges Near $83K as Traders Look to US Inflation Data',
            'Strategy Scoops Up $21.5M in Bitcoin, Buys Back $192M in STRC',
            'Bitcoin shrugs off ETF outflows to trade above $84,000 as oil falls',
            'Fed Powell Signals Rate Cut as U.S. Inflation Cools'
        ];

        for (const headline of validMacroHeadlines) {
            assert.strictEqual(News.isSpam(headline), false, `Valid macro headline flagged as spam: ${headline}`);
            assert.strictEqual(News.isPureAltcoin(headline), false, `Valid macro headline flagged as altcoin noise: ${headline}`);
            assert.strictEqual(News.isHighImpactMacro(headline), true, `Valid macro headline failed high impact check: ${headline}`);
        }
    });

    await t.test('Emergency halt keywords trigger system protection', () => {
        const emergencyHeadlines = [
            'Binance Futures Scheduled Maintenance on Oct 15',
            'Exchange Halts Trading Following Critical Security Exploit',
            'Major Platform Outage Reported Across Asia',
            'Crypto exchange hacked for $100M',
            'Binance suspends withdrawals amid wallet upgrade'
        ];

        for (const headline of emergencyHeadlines) {
            assert.strictEqual(strategy.ai.haltKeywordsRegex.test(headline), true, `Halt keyword not matched: ${headline}`);
        }

        const nonTradingHeadlines = [
            'Ledger asks resellers to halt sales in Southeast Asia and Hong Kong',
            'Tech firm halts hiring for Q4',
            'Court halts crypto lawsuit proceedings'
        ];

        for (const headline of nonTradingHeadlines) {
            assert.strictEqual(strategy.ai.haltKeywordsRegex.test(headline), false, `Non-trading headline falsely matched halt: ${headline}`);
        }
    });

    await t.test('Opinion, prediction, and analyst commentary headlines are filtered out', () => {
        const opinionHeadlines = [
            'Bitcoin Price Prediction: Analyst Predicts BTC Will Reach $150K by End of Year',
            'Crypto Expert Believes Bitcoin Could Hit $70K Before Next Big Leg Up',
            'Why One Top Analyst Forecasts A Massive Bitcoin Pullback',
            'Senior Strategist Expects Bitcoin Volatility to Surge Next Month',
            'Opinion: The Bullish Case for Bitcoin Reaching New Highs in 2026'
        ];

        for (const headline of opinionHeadlines) {
            assert.strictEqual(News.isOpinion(headline), true, `Failed to flag opinion: ${headline}`);
            assert.strictEqual(News.isHighImpactMacro(headline), false, `Opinion should not pass high-impact check: ${headline}`);
        }
    });

    await t.test('News Freshness Guard accepts fresh headlines and rejects stale ones', () => {
        const now = Date.now();
        const freshDate = new Date(now - 15 * 60 * 1000).toISOString();
        const staleDate = new Date(now - 90 * 60 * 1000).toISOString();
        const ancientDate = new Date(now - 7 * 60 * 60 * 1000).toISOString();

        assert.strictEqual(News.isFresh(freshDate), true, '15m old news should be fresh');
        assert.strictEqual(News.isFresh(staleDate), false, '90m old news should be stale');
        assert.strictEqual(News.isFresh(ancientDate), false, '7h old news should be stale');

        const validHeadline = 'Fed Powell Signals Rate Cut as U.S. Inflation Cools';
        assert.strictEqual(News.isHighImpactMacro(validHeadline, freshDate), true, 'Fresh macro should pass');
        assert.strictEqual(News.isHighImpactMacro(validHeadline, staleDate), false, 'Stale macro should be rejected');
        assert.strictEqual(News.isHighImpactMacro(validHeadline, ancientDate), false, 'Ancient macro should be rejected');
    });
});

