const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Explicitly parse and override .env so container environment variable cache does not shadow file updates
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envConfig = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
} else {
  dotenv.config({ override: true });
}

// Harmonize with SQLite system_state (Single Source of Truth) if present
try {
  const Database = require('better-sqlite3');
  const dbFile = path.resolve(__dirname, '../data/trading.db');
  if (fs.existsSync(dbFile)) {
    const tempDb = new Database(dbFile, { readonly: true });
    const row = tempDb.prepare("SELECT value FROM system_state WHERE key = 'trading_mode'").get();
    tempDb.close();
    if (row && row.value) {
      process.env.BINANCE_TESTNET = row.value === 'DEMO' ? 'true' : 'false';
    }
  }
} catch (e) {
  // Database not initialized yet or table doesn't exist
}

module.exports = {
  trading: {
    symbol: 'BTCUSDT',
    strategyMode: 'KEY_LEVEL_SNIPER', // 'KEY_LEVEL_SNIPER' (V5 S/R Key Level Sniper) | 'ORDER_FLOW_SNIPER' | 'ORDER_FLOW_REALITY' | 'LAGGING_INDICATORS'
    keyLevels: {
      enabled: true,
      higherIntervalMinutes: 15,
      lookbackCandles: 24, // 24 x 15m candles = 6 hours tactical swing lookback
      macroLookbackCandles: 96, // 96 x 15m candles = 24 hours rolling macro daily swing lookback (Solusi 2: Multi-Horizon)
      multiHorizon: true, // Multi-horizon structural level confluence
      zoneTolerancePct: 0.35, // 0.35% proximity threshold to qualify as testing Support or Resistance
      minRejectionWickPct: 0.25, // 25% wick ratio of candle range showing absorption/rejection
      requireConfirmation: true // Require wick rejection or directional candle bounce
    },
    confluence: {
      enabled: true, // Confluence Scoring Engine (Solusi 3: Resolves under-trading / over-filtering)
      minScore: 70, // Minimum 70 points out of 100 required for trade entry approval
      weights: {
        keyLevelAndRejection: 25, // Up to 25 pts for Regime Setup / S/R structural quality & confirmation
        takerFlow: 20,            // Up to 20 pts for order flow aggression / absorption
        orderBook: 15,            // Up to 15 pts for order book depth imbalance (OBI)
        whalePosition: 10,        // Up to 10 pts for Top Trader L/S ratio alignment
        volume: 10,               // Up to 10 pts for volume participation vs SMA 20
        mtfTrend: 10,             // Up to 10 pts for 15m trend & regime confluence
        aiSentiment: 10           // Up to 10 pts for SumoPod AI macro sentiment
      }
    },
    trendRegime: {
      enabled: true,
      adaptiveMode: true, // Adaptive Multi-Regime Engine (Bullish, Bearish, Sideways, Normal/Transition)
      strictTrendAlignment: true, // Prohibit suicidal counter-trend entries in confirmed strong trends
      adxTrendThreshold: 20, // ADX >= 20 confirms directional trend; ADX < 20 activates Sideways Range mode
      adxStrongThreshold: 25, // ADX >= 25 confirms strong directional momentum
      emaPullbackTolerancePct: 0.45, // 0.45% dynamic pullback zone around 5m EMA 20 / EMA 50 / 15m EMA 25
      allowBreakoutEntries: true, // Allow breakout/breakdown continuation entries in trending markets
      allowPullbackEntries: true, // Allow dynamic EMA pullback entries in trending markets
      allowMomentumEntries: true, // Allow momentum continuation entries in trending & normal markets
      breakdownSellTakerRatio: 0.95, // Taker ratio <= 0.95 confirms sell flow on breakdown/continuation
      breakoutBuyTakerRatio: 1.05 // Taker ratio >= 1.05 confirms buy flow on breakout/continuation
    },
    realityEngine: {
      enabled: true,
      minTakerBuySellRatioLong: 1.35, // Taker buy/sell volume ratio >= 1.35 triggers aggressive BUY dominance (high-precision sniper)
      maxTakerBuySellRatioShort: 0.65, // Taker buy/sell volume ratio <= 0.65 triggers aggressive SELL dominance (high-precision sniper)
      requireCandleConfirmation: true // Require Green candle (Close > Open) for LONG, Red candle (Close < Open) for SHORT to guard against iceberg absorption
    },
    leverage: 50, // 50x Leverage (Scalper Engine)
    maxMemoryCandles: 500,
    interval: '5m',
    riskPerTradePct: 1.0, // 1.0% of equity (balanced institutional risk sizing)
    minNotionalUSD: 10,
    atrMultiplierForSize: 2, // Size = Risk / (ATR * Multiplier)
    baseSlAtrMultiplier: 2.0, // Dynamic Stop Loss = 2.0 * ATR (bounded by floorSlPct)
    floorSlPct: 0.50, // 0.50% of entry price (Anti-noise wick guard, ~$370 on BTC ~$74,000 per AGENTS.md)
    rrRatio: 2.0, // Take Profit = 1:2.0 RR (1.00% of entry price, ~$740 on BTC ~$74,000)
    maxHoldMinutes: 30, // Time-Based Exit: close stale positions held longer than 30 minutes (6 5m candles)
    trailingStop: {
      enabled: false, // Disabled: prevents premature profit throttling; allows full Take Profit target (1:2 RR)
      activationAtrMultiplier: 1.5,
      startTrailAtrMultiplier: 3,
      tightenAtrMultiplier: 0.5,
      profitGainAtrMultiplier: 1,
      minTrailAtrMultiplier: 1,
      breakEven: {
        enabled: false, // Disabled: prevents micro-retracement wick stop-outs at entry
        triggerProfitPct: 0.25, // Floating profit >= 0.25% activates break-even guard
        feeBufferPct: 0.05 // Locks Stop Loss at Entry + 0.05% (LONG) or Entry - 0.05% (SHORT) to cover fees
      }
    },
    slippageMaxPct: 0.05, // 0.05% max slippage allowed for surgical sniper execution
    filters: {
      adx: {
        enabled: true, // Activated for Sniper Mode
        period: 14,
        threshold: 22, // Enforce strong trending market (ADX >= 22) for breakout/momentum modes
        maxRangeThreshold: 38 // Anti-blowout ceiling for S/R: avoid catching falling knives during extreme runaway trends
      },
      rsi: {
        enabled: true, // RSI Exhaustion Guard
        period: 14,
        maxLongRsi: 65, // Disallow LONG if RSI > 65 (prevent buying the top / overbought exhaustion)
        minShortRsi: 35 // Disallow SHORT if RSI < 35 (prevent selling the bottom / oversold exhaustion)
      },
      volume: {
        enabled: true,
        period: 20, // 20-period SMA volume
        minMultiplier: 0.70 // Volume >= 0.70 * 20 SMA volume required for liquid execution
      },
      multiTimeframe: {
        enabled: true, // Activated for Sniper Mode
        higherIntervalMinutes: 15,
        higherEmaPeriod: 25 // 15m EMA 25 trend confluence
      },
      fundingRate: {
        enabled: true,
        maxAbsoluteRate: 0.0004 // Reject LONG if funding > +0.04%, reject SHORT if funding < -0.04%
      },
      whale: {
        enabled: true,
        topTraderRatio: {
          enabled: true,
          period: '5m',
          minLongThreshold: 0.85, // Disallow LONG if whale Top Traders L/S ratio < 0.85 (heavily net short)
          maxShortThreshold: 1.80, // Disallow SHORT if whale Top Traders L/S ratio > 1.80 (standard mode)
          keyLevelMaxShortThreshold: 2.25 // Structural long-bias allowance for S/R Key Level mode on Binance BTC
        },
        takerVolumeRatio: {
          enabled: true,
          period: '5m',
          minBuySellRatioForLong: 1.35, // Order flow trigger bound for LONG (Reality mode)
          maxBuySellRatioForShort: 0.65, // Order flow trigger bound for SHORT (Reality mode)
          keyLevelMinLong: 0.85, // S/R Key Level mode: limit buyers absorb selling; taker ratio >= 0.85 confirms bounce
          keyLevelMaxShort: 1.15 // S/R Key Level mode: limit sellers absorb buying; taker ratio <= 1.15 confirms rejection
        },
        onChainAlerts: {
          enabled: true
        }
      },
      liquidation: {
        enabled: true,
        maxCascadeUsd60s: 150000, // Disallow counter-trade if > $150k liquidated in last 60s (falling knife guard)
        minExhaustionUsd5m: 250000, // $250k burst in 5m marks major liquidation cluster
        exhaustionCalmUsd60s: 30000 // 60s liquidation < $30k after burst indicates cascade exhaustion
      },
      orderBook: {
        enabled: true,
        minLongObi: 0.35, // Reject LONG if Bids < 35% of top 20 depth (smoothed against micro-spoofing)
        maxShortObi: 0.65 // Reject SHORT if Bids > 65% of top 20 depth (Asks < 35%)
      },
      openInterestDelta: {
        enabled: true,
        lookbackMinutes: 5,
        minExpansionPct: 0.15 // 0.15% OI change indicates significant institutional positioning
      },
      realtimeCvd: {
        enabled: true,
        minLongBuySellRatio: 1.15,
        maxShortBuySellRatio: 0.85
      }
    }
  },
  risk: {
    dailyLossLimitPct: 5,
    dailyLossLimitEnabled: false, // Dinonaktifkan sementara untuk fase development & pengujian akun demo
    consecutiveLossPause: {
      enabled: false, // Dinonaktifkan sementara untuk fase development & pengujian akun demo
      count: 3,
      pauseHours: 4
    },
    lossCooldown: {
      enabled: true,
      minutes: 20 // 20-minute cooling off period after Stop Loss hit (anti-revenge trading)
    },
    disableInDemo: true // Bypass penuh pembatas loss harian dan jeda kekalahan beruntun pada akun DEMO
  },
  notifications: {
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || ''
    }
  },
  ai: {
    model: process.env.AI_MODEL_NAME || 'glm-5.3-flash',
    macroKeywordsRegex: /\b(BTC|BITCOIN|FED|FOMC|POWELL|CPI|INFLATION|RATE|SEC|CFTC|DOJ|ETF|BLACKROCK|SAYLOR|STRATEGY|INFLOW|OUTFLOW|WHALE|HALVING|CRASH|RALLY|DUMP|PUMP|LIQUIDATION|LIQUIDITY|VOLATILITY)\b/i,
    haltKeywordsRegex: /\b(MAINTENANCE|OUTAGE|EXPLOIT(?:ED|S)?|HACK(?:ED|ING|S)?|(?:TRADING|MARKET|NETWORK|EXCHANGE)\s+HALTS?|HALTS?\s+(?:TRADING|WITHDRAWALS?|DEPOSITS?|NETWORK|OPERATIONS?)|(?:TRADING|WITHDRAWAL|DEPOSIT|NETWORK)\s+SUSPEND(?:ED|S)?|SUSPEND(?:ED|S)?\s+(?:TRADING|WITHDRAWALS?|DEPOSITS?|SERVICES?))\b/i,
    spamKeywordsRegex: /\b(PRESALE|ICO|AIRDROP|REMITTIX|PEPETO|\d+X|MEMECOIN|MEME COIN|SPONSORED|GIVEAWAY|LOTTERY|CASINO|PRESALES|BUY NOW|BONUS|PROMO|REFERRAL|OPENPR|PRNEWSWIRE|GLOBENEWSWIRE|PRESS RELEASE)\b/i,
    altcoinNoiseRegex: /\b(ETH|ETHEREUM|SOL|SOLANA|XRP|RIPPLE|DOGE|DOGECOIN|SHIB|SHIBA|PEPE|CARDANO|ADA|BNB|AVAX|SUNDOG|TRX|NEAR|SUI|APT)\b/i,
    opinionKeywordsRegex: /\b(ANALYST(?:S)?|PREDICTS?|PREDICTION(?:S)?|FORECAST(?:S)?|COULD\s+(?:HIT|REACH|DROP|SURGE)|WILL\s+(?:HIT|REACH|DROP|SURGE)|TARGETS?|PRICE\s+TARGET|BELIEVES?|EXPECTS?|SPECULATES?|OPINION|CASE\s+FOR)\b/i,
    maxNewsAgeMinutes: 45, // Headlines older than 45 minutes are treated as fully priced-in (neutral)
    minVetoConfidence: 7, // Minimum AI confidence to veto pre-trade entry (filters mild editorial bias)
    requireConfluence: true, // Directional confluence: LONG only if Bullish/Neutral; SHORT only if Bearish/Neutral
    emergencyHaltEnabled: false, // Disabled: bot will never lock or halt execution due to news headlines
    emergencyExitConf: 9, // Minimum confidence to trigger emergency exit
    emergencyExitBlackSwanOnly: true, // Only trigger emergency exit on verified black-swan/halt events
    timeoutMs: 25000,
    maxConsecutiveFailures: 3
  },
  api: {
    isTestnet: process.env.BINANCE_TESTNET !== 'false',
    baseUrl: process.env.BINANCE_TESTNET === 'false' ? 'https://fapi.binance.com' : 'https://testnet.binancefuture.com',
    wsUrl: process.env.BINANCE_TESTNET === 'false' ? 'wss://fstream.binance.com/market/ws' : 'wss://stream.binancefuture.com/ws',
    reconciliationIntervalMs: 15000 // 15 seconds reconciliation (fast recovery without rate limit exhaustion)
  }
};
