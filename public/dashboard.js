let eventSource = null;
let autoScroll = true;
let allLogs = [];
let lastPriceVal = null;
let currentToken = '';
let reconnectTimer = null;
let rawArticles = [];
let currentNewsTab = 'all';
let newsSearchQuery = '';
let currentHistoryTab = 'closed';
let latestAnalyzedHeadline = '';
let cachedHistory = [];
let cachedFills = [];
let cachedBotInfo = null;
let cachedPositions = [];
let selectedPerformanceMode = 'DEMO';
let selectedPerformanceTimeframe = 'all';
let lastKnownBotMode = null;
let currentTradingMode = 'DEMO';

async function fetchSessionToken() {
    try {
        const res = await fetch('/api/session-token?t=' + Date.now());
        if (res.ok) {
            const data = await res.json();
            if (data.token) {
                currentToken = data.token;
                localStorage.setItem('trading_bot_token', currentToken);
                return currentToken;
            }
        }
    } catch (e) {
        currentToken = localStorage.getItem('trading_bot_token') || '';
    }
    return currentToken;
}

// Authenticated fetch wrapper with automatic 403 token refresh & retry
async function authenticatedFetch(url, options = {}) {
    if (!currentToken) await fetchSessionToken();
    const headers = Object.assign({}, options.headers || {}, { 'x-internal-token': currentToken });
    const separator = url.includes('?') ? '&' : '?';
    let authedUrl = url.includes('token=') ? url : `${url}${separator}token=${encodeURIComponent(currentToken)}`;
    
    let res = await fetch(authedUrl, Object.assign({}, options, { headers }));
    if (res.status === 403) {
        // Token was invalidated by server restart, re-fetch and retry request once
        await fetchSessionToken();
        headers['x-internal-token'] = currentToken;
        authedUrl = url.includes('token=') 
            ? url.replace(/([?&])token=[^&]*/, `$1token=${encodeURIComponent(currentToken)}`)
            : `${url}${separator}token=${encodeURIComponent(currentToken)}`;
        res = await fetch(authedUrl, Object.assign({}, options, { headers }));
    }
    return res;
}

async function refreshNewsFeedManually() {
    const btn = document.getElementById('btnRefreshNews');
    const spinner = document.getElementById('refreshSpinner');
    if (spinner) spinner.classList.add('spinning');
    if (btn) btn.disabled = true;

    try {
        const res = await authenticatedFetch('/api/news?refresh=true');
        if (res.ok) {
            const data = await res.json();
            if (data.articles && Array.isArray(data.articles)) {
                rawArticles = data.articles;
                renderNewsFeed();
            }
        } else {
            await fetchNewsFeed();
        }
    } catch (e) {
        await fetchNewsFeed();
    } finally {
        setTimeout(() => {
            if (spinner) spinner.classList.remove('spinning');
            if (btn) btn.disabled = false;
        }, 500);
    }
}

async function fetchLogsFallback() {
    try {
        const res = await authenticatedFetch('/api/logs');
        if (res.ok) {
            const data = await res.json();
            if (data.logs && Array.isArray(data.logs)) {
                allLogs = data.logs;
                renderLogs();
            }
        }
    } catch (e) {
        // Handled silently
    }
}

const initDashboard = async () => {
    await fetchSessionToken();
    connectSSE();
    fetchNewsFeed();
    fetchLogsFallback();
    initDirectBinanceWs();
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDashboard);
} else {
    initDashboard();
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!eventSource || eventSource.readyState === EventSource.CLOSED)) {
        connectSSE();
        fetchNewsFeed();
        fetchLogsFallback();
    }
});

function scheduleReconnect(delayMs = 2000) {
    if (reconnectTimer) return;
    updateConnectionStatus(false, "RECONNECTING...");
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSSE();
    }, delayMs);
}

async function connectSSE() {
    // Always fetch fresh session token before connecting
    await fetchSessionToken();

    if (eventSource) {
        try { eventSource.close(); } catch (e) {}
        eventSource = null;
    }

    updateConnectionStatus(null, "CONNECTING...");

    try {
        eventSource = new EventSource(`/api/stream?token=${encodeURIComponent(currentToken)}`);

        eventSource.onopen = () => {
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            updateConnectionStatus(true, "CONNECTED • LIVE");
        };

        eventSource.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                handleServerMessage(payload);
            } catch (e) {
                console.error("Failed to parse SSE payload", e);
            }
        };

        eventSource.addEventListener('shutdown', () => {
            console.log("Server restarting. Reconnecting gracefully in 1.5s...");
            if (eventSource) {
                try { eventSource.close(); } catch (e) {}
                eventSource = null;
            }
            updateConnectionStatus(null, "RESTARTING...");
            currentToken = '';
            scheduleReconnect(1500);
        });

        eventSource.onerror = (err) => {
            console.warn("SSE stream disconnected. Re-fetching session token & reconnecting in 2s...", err);
            if (eventSource) {
                try { eventSource.close(); } catch (e) {}
                eventSource = null;
            }
            currentToken = ''; // Invalidate token to force fresh fetch on reconnect
            scheduleReconnect(2000);
        };
    } catch (err) {
        console.error("Failed to initialize EventSource", err);
        currentToken = '';
        scheduleReconnect(3000);
    }
}

function updateConnectionStatus(isConnected, text) {
    const connDot = document.getElementById('connDot');
    const connText = document.getElementById('connText');

    if (connText) connText.innerText = text;
    if (connDot) {
        if (isConnected === true) {
            connDot.style.background = "var(--green)";
            connDot.style.boxShadow = "0 0 10px var(--green)";
        } else if (isConnected === false) {
            connDot.style.background = "var(--red)";
            connDot.style.boxShadow = "0 0 10px var(--red)";
        } else {
            connDot.style.background = "var(--yellow)";
            connDot.style.boxShadow = "0 0 10px var(--yellow)";
        }
    }
}

function updateLivePriceDisplay(price, source = 'Binance Stream') {
    if (!price || isNaN(price)) return;
    const numPrice = Number(price);
    const priceEl = document.getElementById('livePrice');
    const tickIcon = document.getElementById('priceTickIcon');
    const subText = document.getElementById('priceSubText');
    if (!priceEl) return;

    const formattedPrice = numPrice.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 });

    if (lastPriceVal !== null) {
        if (numPrice > Number(lastPriceVal)) {
            priceEl.classList.remove('flash-green', 'flash-red');
            void priceEl.offsetWidth; // trigger reflow
            priceEl.classList.add('flash-green');
            if (tickIcon) {
                tickIcon.innerText = "▲";
                tickIcon.style.color = "var(--green)";
            }
        } else if (numPrice < Number(lastPriceVal)) {
            priceEl.classList.remove('flash-green', 'flash-red');
            void priceEl.offsetWidth; // trigger reflow
            priceEl.classList.add('flash-red');
            if (tickIcon) {
                tickIcon.innerText = "▼";
                tickIcon.style.color = "var(--red)";
            }
        }
    }

    priceEl.innerText = `$${formattedPrice}`;
    if (subText) {
        subText.innerText = `Live: $${formattedPrice} • ${source}`;
    }
    lastPriceVal = numPrice;
}

let browserWs = null;
function initDirectBinanceWs(symbol = 'btcusdt') {
    try {
        if (browserWs) {
            try { browserWs.close(); } catch (e) {}
            browserWs = null;
        }
        const wsUrl = `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@kline_5m`;
        browserWs = new WebSocket(wsUrl);
        browserWs.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.k && payload.k.c) {
                    updateLivePriceDisplay(payload.k.c, 'Binance Direct WS');
                }
            } catch (e) {}
        };
        browserWs.onerror = () => {
            // Direct browser connection might be blocked by ISP; seamlessly fall back to SSE
            try { browserWs.close(); } catch (e) {}
            browserWs = null;
        };
    } catch (e) {}
}

function handleServerMessage(msg) {
    if (msg.type === 'INIT_STATE') {
        if (msg.data) updateFullState(msg.data);
        if (msg.logs && Array.isArray(msg.logs)) {
            allLogs = msg.logs;
            renderLogs();
        }
    } else if (msg.type === 'STATE_UPDATE') {
        if (msg.data) updateFullState(msg.data);
    } else if (msg.type === 'PRICE_TICK') {
        if (msg.data && msg.data.price) {
            updateLivePriceDisplay(msg.data.price, msg.data.source || 'Binance Stream');
        }
    } else if (msg.type === 'LOG') {
        if (msg.data) {
            appendLog(msg.data);
        }
    }
}

async function fetchNewsFeed() {
    try {
        const res = await authenticatedFetch('/api/news');
        if (res.ok) {
            const data = await res.json();
            if (data.articles && Array.isArray(data.articles)) {
                rawArticles = data.articles;
                renderNewsFeed();
            }
        }
    } catch (e) {
        // Handled silently
    }
}

function updateFullState(state) {
    const { positions, fills, history, botInfo } = state;

    if (history && Array.isArray(history)) cachedHistory = history;
    if (fills && Array.isArray(fills)) cachedFills = fills;
    if (positions && Array.isArray(positions)) cachedPositions = positions;
    if (botInfo) cachedBotInfo = botInfo;

    if (!botInfo) return;

    // Automatically synchronize performance view mode whenever bot trading mode changes
    const botMode = botInfo.tradingMode || (botInfo.isTestnet ? 'DEMO' : 'REAL');
    if (botMode && botMode !== lastKnownBotMode) {
        lastKnownBotMode = botMode;
        currentTradingMode = botMode;
        selectedPerformanceMode = botMode;
    } else if (!lastKnownBotMode) {
        lastKnownBotMode = botMode;
        currentTradingMode = botMode;
        selectedPerformanceMode = botMode;
    }

    // Render Performance & Exposure (Metric 4) for selected mode & timeframe
    renderPerformanceMetrics();

    // 0. Update Trading Mode Button (Demo vs Real)
    if (botInfo.tradingMode) {
        currentTradingMode = botInfo.tradingMode;
    } else if (botInfo.isTestnet !== undefined) {
        currentTradingMode = botInfo.isTestnet ? 'DEMO' : 'REAL';
    }
    const modeBtn = document.getElementById('modeBtn');
    const modeText = document.getElementById('modeText');
    if (modeBtn && modeText) {
        if (currentTradingMode === 'REAL') {
            modeBtn.className = 'btn btn-mode real';
            modeText.innerText = '🔴 REAL (LIVE)';
            modeBtn.title = 'Active Mode: REAL (Live Capital). Click to switch to DEMO.';
        } else {
            modeBtn.className = 'btn btn-mode demo';
            modeText.innerText = '🟡 DEMO (TESTNET)';
            modeBtn.title = 'Active Mode: DEMO (Testnet Simulation). Click to switch to REAL.';
        }
    }

    const headerEquityVal = document.getElementById('headerEquityVal');
    if (headerEquityVal && botInfo.accountBalances) {
        const activeBal = botInfo.accountBalances[currentTradingMode];
        if (activeBal && activeBal.totalMarginBalance) {
            const num = parseFloat(activeBal.totalMarginBalance);
            headerEquityVal.innerText = `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }
    }

    // 1. Update Market & Strategy Header Badges & Banner
    document.getElementById('marketBadge').innerText = `${botInfo.symbol} • ${botInfo.interval.toUpperCase()}`;
    document.getElementById('priceSymbol').innerText = botInfo.symbol;

    if (botInfo.strategy) {
        const strat = botInfo.strategy;
        const lev = strat.leverage || 50;
        const risk = strat.riskPerTradePct || 1.5;
        const slVal = strat.floorSlPct ? Number(strat.floorSlPct).toFixed(2) : '0.20';
        const rr = strat.rrRatio ? Number(strat.rrRatio) : 2.0;
        const tpVal = (Number(slVal) * rr).toFixed(2);
        const netSl = Number(slVal) + 0.10;
        const netTp = Math.max(0.01, Number(tpVal) - 0.10);
        const netRrVal = (netTp / netSl).toFixed(1);
        const beRateVal = ((netSl / (netSl + netTp)) * 100).toFixed(1);

        const elLev = document.getElementById('stratLev');
        if (elLev) elLev.innerText = `LEV ${lev}x`;
        const elRisk = document.getElementById('stratRisk');
        if (elRisk) elRisk.innerText = `RISK ${risk}%`;
        const elSlTp = document.getElementById('stratSlTp');
        if (elSlTp) elSlTp.innerText = `SL ${slVal}% • TP ${tpVal}% (RR ${rr.toFixed(1)})`;
        const elNetRr = document.getElementById('stratNetRr');
        if (elNetRr) elNetRr.innerText = `NET RR 1:${netRrVal} (${beRateVal}% BE)`;
        const isKeyLevel = strat.strategyMode === 'KEY_LEVEL_SNIPER' || strat.keyLevels?.enabled;
        const isSniper = strat.strategyMode === 'ORDER_FLOW_SNIPER' || (strat.filters?.adx?.enabled && strat.filters?.multiTimeframe?.enabled);
        const elEngine = document.getElementById('stratEngine');
        if (elEngine) {
            elEngine.innerText = isKeyLevel ? 'V5 KEY LEVEL SNIPER' : (isSniper ? 'V4 ORDER FLOW SNIPER' : (strat.strategyMode === 'ORDER_FLOW_REALITY' ? 'V4 ORDER FLOW REALITY' : 'V3 MULTI-INDICATOR'));
        }

        // Strategy Architecture & Reality Overview Banner Elements
        const bMode = document.getElementById('bannerStratMode');
        if (bMode) bMode.innerText = isKeyLevel ? 'KEY_LEVEL_SNIPER' : (isSniper ? 'ORDER_FLOW_SNIPER' : (strat.strategyMode || 'ORDER_FLOW_REALITY'));
        const bannerBadge = document.querySelector('.strat-banner-badge');
        if (bannerBadge) {
            bannerBadge.innerText = isKeyLevel ? 'V5 KEY LEVEL SNIPER' : (isSniper ? 'V4 SNIPER ENGINE' : 'V4 REALITY ENGINE');
        }
        const bannerTitle = document.querySelector('.strat-banner-title-group h2');
        if (bannerTitle) {
            bannerTitle.innerText = isKeyLevel 
                ? 'ACTIVE TRADING STRATEGY: KEY LEVEL SNIPER (15M S/R + REJECTION + NEWS)'
                : (isSniper 
                    ? 'ACTIVE TRADING STRATEGY: ORDER FLOW SNIPER (ADX & 15M CONFLUENCE)' 
                    : 'ACTIVE TRADING STRATEGY: PURE ORDER FLOW REALITY');
        }
        const bModeSub = document.querySelector('#bannerStratMode + .param-sub');
        if (bModeSub) {
            bModeSub.innerText = isKeyLevel ? '15M S/R + Rejection + News Confluence' : (isSniper ? 'Order Flow + ADX & 15M Guard' : 'Zero Lagging Dependency');
        }
        const bLev = document.getElementById('bannerStratLev');
        if (bLev) bLev.innerText = `${lev}x CROSS`;
        const bRisk = document.getElementById('bannerStratRisk');
        if (bRisk) bRisk.innerText = `${risk}%`;
        const bSl = document.getElementById('bannerStratSl');
        if (bSl) bSl.innerText = `${slVal}%`;
        const bTp = document.getElementById('bannerStratTp');
        if (bTp) bTp.innerText = `${tpVal}%`;
        const bGrossRr = document.getElementById('bannerStratGrossRr');
        if (bGrossRr) bGrossRr.innerText = `1 : ${rr.toFixed(1)}`;
        const bNetRr = document.getElementById('bannerStratNetRr');
        if (bNetRr) bNetRr.innerText = `1 : ${netRrVal}`;
        const bBeRate = document.getElementById('bannerStratBeRate');
        if (bBeRate) bBeRate.innerText = `${beRateVal}%`;
    }

    // 2. Price Ticker with Smooth Flash Animation
    if (botInfo.lastPrice) {
        updateLivePriceDisplay(botInfo.lastPrice, 'State Sync');
    }

    // 3. Execution Status
    const statusText = document.getElementById('botStatusText');
    const stateBadge = document.getElementById('botStateBadge');
    const unlockBtn = document.getElementById('btnUnlock');

    if (botInfo.isTradingLocked) {
        statusText.innerText = "LOCKED / HALT";
        statusText.style.color = "var(--rose)";
        stateBadge.innerText = "HALTED";
        stateBadge.className = "badge badge-bearish";
        unlockBtn.style.display = "inline-flex";
    } else if (botInfo.degradedMode) {
        statusText.innerText = "DEGRADED MODE";
        statusText.style.color = "var(--amber)";
        stateBadge.innerText = "WARN";
        stateBadge.className = "badge badge-neutral";
        unlockBtn.style.display = "none";
    } else {
        statusText.innerText = "RUNNING";
        statusText.style.color = "#ffffff";
        stateBadge.innerText = "ACTIVE";
        stateBadge.className = "badge badge-bullish";
        unlockBtn.style.display = "none";
    }

    // Uptime
    const mins = Math.floor((botInfo.uptimeSeconds || 0) / 60);
    const hours = Math.floor(mins / 60);
    document.getElementById('botUptime').innerText = `${hours}h ${mins % 60}m`;

    // 4. AI Sentiment & Reasoning Card
    if (botInfo.latestSentiment) {
        const s = botInfo.latestSentiment.sentiment || 'NEUTRAL';
        const conf = botInfo.latestSentiment.confidence || 0;
        const reason = botInfo.latestSentiment.reason || 'AI analyzes macro events to detect risk shifts.';
        
        const aiBadge = document.getElementById('aiBadge');
        const aiText = document.getElementById('aiSentimentText');
        const aiBar = document.getElementById('aiConfidenceBar');
        const aiConfText = document.getElementById('aiConfidenceText');
        const aiConfBadge = document.getElementById('aiConfidenceBadge');
        const aiReasonEl = document.getElementById('aiReasonText');
        const aiPolicyBadge = document.getElementById('aiPolicyBadge');
        const aiVetoNotice = document.getElementById('aiVetoNotice');
        
        aiText.innerText = s;
        aiBadge.innerText = s;
        if (s === 'BULLISH') {
            aiBadge.className = "badge badge-bullish";
            aiText.style.color = "var(--emerald)";
            if (aiBar) aiBar.style.background = "linear-gradient(90deg, #10b981, #38bdf8)";
            if (aiPolicyBadge) {
                aiPolicyBadge.innerText = "Bullish Momentum Active";
                aiPolicyBadge.className = "badge badge-bullish";
            }
        } else if (s === 'BEARISH') {
            aiBadge.className = "badge badge-bearish";
            aiText.style.color = "var(--rose)";
            if (aiBar) aiBar.style.background = "linear-gradient(90deg, #f43f5e, #fb923c)";
            if (aiPolicyBadge) {
                aiPolicyBadge.innerText = "Caution • Bearish Risk";
                aiPolicyBadge.className = "badge badge-bearish";
            }
        } else {
            aiBadge.className = "badge badge-neutral";
            aiText.style.color = "#ffffff";
            if (aiBar) aiBar.style.background = "linear-gradient(90deg, #64748b, #94a3b8)";
            if (aiPolicyBadge) {
                aiPolicyBadge.innerText = "Trading Permitted • Neutral Baseline";
                aiPolicyBadge.className = "badge badge-neutral";
            }
        }

        aiConfText.innerText = `${conf}/10`;
        aiBar.style.width = `${conf * 10}%`;
        aiConfBadge.innerText = `Confidence: ${conf}/10`;
        aiReasonEl.innerText = `"${reason}"`;
        const minVetoConf = (botInfo.strategy?.ai?.minVetoConfidence) ?? 7;
        const isVetoArmed = conf >= minVetoConf && (s === 'BEARISH' || s === 'BULLISH');
        document.getElementById('aiVetoStatus').innerText = isVetoArmed ? `Armed (${s})` : "Inactive";
        if (aiVetoNotice) {
            aiVetoNotice.innerText = isVetoArmed ? `VETO GUARD: ARMED (${s})` : "VETO GUARD: INACTIVE (NEUTRAL)";
            aiVetoNotice.style.color = isVetoArmed ? "var(--rose)" : "var(--text-dim)";
        }

        // V4 Strip: AI Sentiment Gatekeeper Chip
        const aiChipVal = document.getElementById('indAiSentiment');
        const aiChipStatus = document.getElementById('indAiStatus');
        if (aiChipVal) {
            aiChipVal.innerText = `${s} (${conf}/10)`;
            aiChipVal.style.color = s === 'BULLISH' ? "var(--emerald)" : (s === 'BEARISH' ? "var(--rose)" : "#ffffff");
        }
        if (aiChipStatus) {
            aiChipStatus.innerText = isVetoArmed ? (s === 'BEARISH' ? "VETO ARMED" : "STRONG BIAS") : "PERMITTED";
            aiChipStatus.style.color = isVetoArmed ? (s === 'BEARISH' ? "var(--rose)" : "var(--emerald)") : "var(--text-muted)";
        }
    }

    if (botInfo.latestNewsHeadline) {
        latestAnalyzedHeadline = botInfo.latestNewsHeadline;
        document.getElementById('aiHeadlineText').innerText = botInfo.latestNewsHeadline;
    }

    // Dynamic AI Model Information & Auto Reconcile Badge
    const activeAiModel = (botInfo.strategy?.ai?.model) || 'mimo-v2.6-flash';
    const isMimo = activeAiModel.toLowerCase().includes('mimo');
    const aiModelTag = document.getElementById('aiModelTag');
    if (aiModelTag) {
        aiModelTag.innerText = `SumoPod ${activeAiModel}`;
    }
    const aiSubBadge = document.getElementById('aiSubBadge');
    if (aiSubBadge) {
        aiSubBadge.innerText = isMimo ? 'SumoPod MiMo LLM' : `SumoPod ${activeAiModel}`;
    }
    const indAiDesc = document.getElementById('indAiDesc');
    if (indAiDesc) {
        indAiDesc.innerText = isMimo ? 'SumoPod MiMo Macro Veto' : `SumoPod ${activeAiModel} Veto`;
    }
    const autoRecBadge = document.getElementById('autoReconcileBadge');
    if (autoRecBadge) {
        const rSec = botInfo.reconciliationIntervalSec || 15;
        autoRecBadge.innerText = `Auto Reconcile: ${rSec}s`;
    }

    // 5. Order Flow Reality & Gatekeeper Strip
    if (botInfo.lastIndicators) {
        const ind = botInfo.lastIndicators;
        
        // Candle Direction & Iceberg Absorption Guard (V4 Reality Core)
        const candleDirEl = document.getElementById('indCandleDir');
        const candleStatusEl = document.getElementById('indCandleStatus');
        const candleDescEl = document.getElementById('indCandleDesc');
        if (candleDirEl && candleStatusEl) {
            if (ind.candle) {
                const c = ind.candle;
                const sign = (c.changePct >= 0) ? '+' : '';
                candleDirEl.innerText = `${c.direction} (${sign}${c.changePct}%)`;
                if (c.direction === 'GREEN') {
                    candleDirEl.style.color = "var(--emerald)";
                    candleStatusEl.innerText = "BULL CONFIRMED";
                    candleStatusEl.style.color = "var(--emerald)";
                } else if (c.direction === 'RED') {
                    candleDirEl.style.color = "var(--rose)";
                    candleStatusEl.innerText = "BEAR CONFIRMED";
                    candleStatusEl.style.color = "var(--rose)";
                } else {
                    candleDirEl.style.color = "#ffffff";
                    candleStatusEl.innerText = "DOJI (FLAT)";
                    candleStatusEl.style.color = "var(--text-muted)";
                }
                if (candleDescEl) {
                    candleDescEl.innerText = `O: $${Number(c.open).toLocaleString()} / C: $${Number(c.close).toLocaleString()}`;
                }
            } else {
                candleDirEl.innerText = '---';
                candleDirEl.style.color = "#ffffff";
                candleStatusEl.innerText = 'WAITING CANDLE';
                candleStatusEl.style.color = 'var(--text-dim)';
            }
        }

        // Volume / SMA 20 (Liquidity Participation Gatekeeper)
        const volEl = document.getElementById('indVol');
        const volStatus = document.getElementById('indVolStatus');
        if (volEl && volStatus) {
            if (ind.volume !== null && ind.volume !== undefined && ind.volumeSma) {
                const volNum = Number(ind.volume);
                const avgNum = Number(ind.volumeSma);
                volEl.innerText = `${volNum.toFixed(1)} / ${avgNum.toFixed(1)}`;
                const mult = (botInfo.strategy?.filters?.volume?.minMultiplier) ?? 0.70;
                const minRequired = avgNum * mult;
                const volDescEl = document.querySelector('#chipVol .chip-desc');
                if (volDescEl) {
                    volDescEl.innerText = `Volume Participation Guard (≥ ${Math.round(mult * 100)}% SMA)`;
                }
                if (volNum >= minRequired) {
                    volEl.style.color = "var(--emerald)";
                    volStatus.innerText = `CONFIRMED (>=${Math.round(mult * 100)}%)`;
                    volStatus.style.color = "var(--emerald)";
                } else {
                    volEl.style.color = "var(--text-secondary)";
                    volStatus.innerText = "LOW VOLUME";
                    volStatus.style.color = "var(--text-muted)";
                }
            } else {
                volEl.innerText = '---';
                volEl.style.color = "#ffffff";
                volStatus.innerText = "LIQUIDITY";
                volStatus.style.color = "var(--text-dim)";
            }
        }

        // ADX Trend Strength (Sniper Mode Guard)
        const adxEl = document.getElementById('indAdx');
        const adxStatus = document.getElementById('indAdxStatus');
        const adxDesc = document.getElementById('indAdxDesc');
        if (adxEl && adxStatus) {
            if (ind.adx !== null && ind.adx !== undefined) {
                const adxNum = Number(ind.adx);
                adxEl.innerText = adxNum.toFixed(1);
                const adxThreshold = (botInfo.strategy?.filters?.adx?.threshold) ?? 20;
                if (adxNum >= adxThreshold) {
                    adxEl.style.color = "var(--emerald)";
                    adxStatus.innerText = `TRENDING (>=${adxThreshold})`;
                    adxStatus.style.color = "var(--emerald)";
                } else {
                    adxEl.style.color = "var(--text-secondary)";
                    adxStatus.innerText = `CHOP / SIDEWAYS (<${adxThreshold})`;
                    adxStatus.style.color = "var(--text-muted)";
                }
                if (adxDesc) {
                    adxDesc.innerText = `14-Period ADX (Floor: ${adxThreshold})`;
                }
            } else {
                adxEl.innerText = '---';
                adxEl.style.color = "#ffffff";
                adxStatus.innerText = "WAITING";
                adxStatus.style.color = "var(--text-dim)";
            }
        }

        // 15M MTF Trend Confluence (Sniper Mode Guard)
        const mtfEl = document.getElementById('indMtf');
        const mtfStatus = document.getElementById('indMtfStatus');
        const mtfDesc = document.getElementById('indMtfDesc');
        if (mtfEl && mtfStatus) {
            if (ind.mtfTrend) {
                mtfEl.innerText = ind.mtfTrend;
                if (ind.mtfTrend === 'BULLISH') {
                    mtfEl.style.color = "var(--emerald)";
                    mtfStatus.innerText = "BULL ALIGNED";
                    mtfStatus.style.color = "var(--emerald)";
                } else if (ind.mtfTrend === 'BEARISH') {
                    mtfEl.style.color = "var(--rose)";
                    mtfStatus.innerText = "BEAR ALIGNED";
                    mtfStatus.style.color = "var(--rose)";
                } else {
                    mtfEl.style.color = "#ffffff";
                    mtfStatus.innerText = "NEUTRAL";
                    mtfStatus.style.color = "var(--text-muted)";
                }
                if (mtfDesc) {
                    mtfDesc.innerText = ind.mtfEma50 ? `EMA(25): $${Number(ind.mtfEma50).toLocaleString()}` : '15m Higher Timeframe';
                }
            } else {
                mtfEl.innerText = '---';
                mtfEl.style.color = "#ffffff";
                mtfStatus.innerText = "WAITING MTF";
                mtfStatus.style.color = "var(--text-dim)";
            }
        }

        // RSI Exhaustion Guard (Sniper Mode Filter)
        const rsiEl = document.getElementById('indRsi');
        const rsiStatus = document.getElementById('indRsiStatus');
        const rsiDesc = document.getElementById('indRsiDesc');
        if (rsiEl && rsiStatus) {
            if (ind.rsi !== null && ind.rsi !== undefined) {
                const rsiNum = Number(ind.rsi);
                rsiEl.innerText = rsiNum.toFixed(1);
                const maxLongRsi = (botInfo.strategy?.filters?.rsi?.maxLongRsi) ?? 65;
                const minShortRsi = (botInfo.strategy?.filters?.rsi?.minShortRsi) ?? 35;
                if (rsiNum >= maxLongRsi) {
                    rsiEl.style.color = "var(--rose)";
                    rsiStatus.innerText = `OVERBOUGHT (>=${maxLongRsi})`;
                    rsiStatus.style.color = "var(--rose)";
                } else if (rsiNum <= minShortRsi) {
                    rsiEl.style.color = "var(--emerald)";
                    rsiStatus.innerText = `OVERSOLD (<=${minShortRsi})`;
                    rsiStatus.style.color = "var(--emerald)";
                } else {
                    rsiEl.style.color = "#ffffff";
                    rsiStatus.innerText = `NORMAL [${minShortRsi}-${maxLongRsi}]`;
                    rsiStatus.style.color = "var(--text-muted)";
                }
                if (rsiDesc) {
                    rsiDesc.innerText = `Exhaustion Floor [${minShortRsi} - ${maxLongRsi}]`;
                }
            } else {
                rsiEl.innerText = '---';
                rsiEl.style.color = "#ffffff";
                rsiStatus.innerText = "WAITING RSI";
                rsiStatus.style.color = "var(--text-dim)";
            }
        }

        // 15M Key Level Support & Resistance Chip
        const klEl = document.getElementById('indKeyLevels');
        const klStatus = document.getElementById('indKeyLevelsStatus');
        const klDesc = document.getElementById('indKeyLevelsDesc');
        if (klEl && klStatus) {
            if (ind.keyLevels) {
                klEl.innerText = `$${Number(ind.keyLevels.support).toLocaleString()} / $${Number(ind.keyLevels.resistance).toLocaleString()}`;
                if (ind.keyLevelSetup) {
                    if (ind.keyLevelSetup.isAtSupport) {
                        klEl.style.color = "var(--emerald)";
                        klStatus.innerText = "AT SUPPORT (BUY ZONE)";
                        klStatus.style.color = "var(--emerald)";
                    } else if (ind.keyLevelSetup.isAtResistance) {
                        klEl.style.color = "var(--rose)";
                        klStatus.innerText = "AT RESIST (SELL ZONE)";
                        klStatus.style.color = "var(--rose)";
                    } else {
                        klEl.style.color = "#ffffff";
                        klStatus.innerText = "MID-RANGE (WAITING S/R)";
                        klStatus.style.color = "var(--text-dim)";
                    }
                } else {
                    klEl.style.color = "#ffffff";
                }
                if (klDesc && ind.keyLevelSetup) {
                    klDesc.innerText = `Range: ${ind.keyLevels.rangePct}% (Dist S: +${ind.keyLevelSetup.supportDistPct}%, R: -${ind.keyLevelSetup.resistanceDistPct}%)`;
                }
            } else {
                klEl.innerText = '---';
                klEl.style.color = "#ffffff";
                klStatus.innerText = "WAITING S/R";
                klStatus.style.color = "var(--text-dim)";
            }
        }
    }

    // 5b. Whale & Smart Money Radar Strip
    if (botInfo.whaleMetrics) {
        const wm = botInfo.whaleMetrics;
        
        // Whale Top Trader Long/Short Ratio
        const whaleEl = document.getElementById('indWhaleRatio');
        const whaleStatus = document.getElementById('indWhaleStatus');
        const whaleDesc = document.getElementById('indWhaleDesc');
        if (whaleEl && whaleStatus) {
            if (wm.topTraderRatio !== null && wm.topTraderRatio !== undefined) {
                const ratio = Number(wm.topTraderRatio);
                whaleEl.innerText = ratio.toFixed(2);
                if (ratio >= 1.65) {
                    whaleEl.style.color = "var(--emerald)";
                    whaleStatus.innerText = "HEAVY LONG";
                    whaleStatus.style.color = "var(--emerald)";
                } else if (ratio < 0.85) {
                    whaleEl.style.color = "var(--rose)";
                    whaleStatus.innerText = "HEAVY SHORT";
                    whaleStatus.style.color = "var(--rose)";
                } else {
                    whaleEl.style.color = "#ffffff";
                    whaleStatus.innerText = "BALANCED";
                    whaleStatus.style.color = "var(--text-dim)";
                }
                if (wm.longAccount && wm.shortAccount && whaleDesc) {
                    whaleDesc.innerText = `L: ${(wm.longAccount * 100).toFixed(0)}% / S: ${(wm.shortAccount * 100).toFixed(0)}%`;
                }
            } else {
                whaleEl.innerText = '---';
                whaleEl.style.color = "#ffffff";
                whaleStatus.innerText = 'WAITING';
                whaleStatus.style.color = "var(--text-dim)";
            }
        }

        // Taker Buy/Sell Volume Ratio (V4 Pure Order Flow Imbalance)
        const takerEl = document.getElementById('indTakerRatio');
        const takerStatus = document.getElementById('indTakerStatus');
        const takerDesc = document.getElementById('indTakerDesc');
        if (takerEl && takerStatus) {
            if (wm.takerBuySellRatio !== null && wm.takerBuySellRatio !== undefined) {
                const tRatio = Number(wm.takerBuySellRatio);
                takerEl.innerText = tRatio.toFixed(2);
                const minLongTaker = (botInfo.strategy?.realityEngine?.minTakerBuySellRatioLong) ?? 1.35;
                const maxShortTaker = (botInfo.strategy?.realityEngine?.maxTakerBuySellRatioShort) ?? 0.65;
                if (tRatio >= minLongTaker) {
                    takerEl.style.color = "var(--emerald)";
                    takerStatus.innerText = `BUY IMBALANCE (>=${minLongTaker})`;
                    takerStatus.style.color = "var(--emerald)";
                } else if (tRatio <= maxShortTaker) {
                    takerEl.style.color = "var(--rose)";
                    takerStatus.innerText = `SELL IMBALANCE (<=${maxShortTaker})`;
                    takerStatus.style.color = "var(--rose)";
                } else {
                    takerEl.style.color = "#ffffff";
                    takerStatus.innerText = "BALANCED FLOW";
                    takerStatus.style.color = "var(--text-dim)";
                }
                if (wm.takerBuyVol && wm.takerSellVol && takerDesc) {
                    takerDesc.innerText = `Buy: ${wm.takerBuyVol.toFixed(1)} / Sell: ${wm.takerSellVol.toFixed(1)}`;
                }
            } else {
                takerEl.innerText = '---';
                takerEl.style.color = "#ffffff";
                takerStatus.innerText = 'WAITING';
                takerStatus.style.color = "var(--text-dim)";
            }
        }

        // Open Interest & Delta OI
        const oiEl = document.getElementById('indOi');
        const oiStatus = document.getElementById('indOiStatus');
        if (oiEl && oiStatus) {
            if (wm.openInterest !== null && wm.openInterest !== undefined) {
                const oiVal = Number(wm.openInterest);
                const deltaText = wm.deltaOiPct !== undefined && wm.deltaOiPct !== 0 ? ` (${wm.deltaOiPct > 0 ? '+' : ''}${wm.deltaOiPct.toFixed(2)}%)` : '';
                oiEl.innerText = (oiVal >= 1000 ? `${(oiVal / 1000).toFixed(1)}k BTC` : `${oiVal.toFixed(2)} BTC`) + deltaText;
                oiStatus.innerText = wm.oiRegime ? wm.oiRegime.replace('_', ' ') : "ACTIVE LIQUIDITY";
                if (wm.oiRegime === 'BULLISH_EXPANSION') {
                    oiEl.style.color = "var(--emerald)";
                    oiStatus.style.color = "var(--emerald)";
                } else if (wm.oiRegime === 'BEARISH_EXPANSION') {
                    oiEl.style.color = "var(--rose)";
                    oiStatus.style.color = "var(--rose)";
                } else if (wm.oiRegime === 'LONG_LIQUIDATION' || wm.oiRegime === 'SHORT_SQUEEZE') {
                    oiEl.style.color = "var(--amber)";
                    oiStatus.style.color = "var(--amber)";
                } else {
                    oiEl.style.color = "#ffffff";
                    oiStatus.style.color = "var(--text-dim)";
                }
            } else {
                oiEl.innerText = '---';
                oiEl.style.color = "#ffffff";
                oiStatus.innerText = 'OI DEPTH';
                oiStatus.style.color = "var(--text-dim)";
            }
        }

        // Liquidation Orders (60s / 5m)
        const liqEl = document.getElementById('indLiqVal');
        const liqStatus = document.getElementById('indLiqStatus');
        const liqDesc = document.getElementById('indLiqDesc');
        const lm = botInfo.liquidationMetrics;
        if (liqEl && lm) {
            const l60 = Math.round((lm.longLiq60s || 0) / 1000);
            const s60 = Math.round((lm.shortLiq60s || 0) / 1000);
            const tot5m = Math.round((lm.totalLiq5m || 0) / 1000);
            liqEl.innerText = `$${l60 + s60}k (60s)`;
            if (liqDesc) liqDesc.innerText = `Long: $${l60}k | Short: $${s60}k | 5m: $${tot5m}k`;
            if (l60 >= 100) {
                liqEl.style.color = "var(--rose)";
                if (liqStatus) { liqStatus.innerText = "LONG CASCADE"; liqStatus.style.color = "var(--rose)"; }
            } else if (s60 >= 100) {
                liqEl.style.color = "var(--emerald)";
                if (liqStatus) { liqStatus.innerText = "SHORT SQUEEZE"; liqStatus.style.color = "var(--emerald)"; }
            } else {
                liqEl.style.color = "#ffffff";
                if (liqStatus) { liqStatus.innerText = "NORMAL FLOW"; liqStatus.style.color = "var(--text-dim)"; }
            }
        }

        // Order Book Imbalance (OBI Top 20)
        const obiEl = document.getElementById('indObiVal');
        const obiStatus = document.getElementById('indObiStatus');
        const obiDesc = document.getElementById('indObiDesc');
        if (obiEl && wm.orderBookImbalance !== null && wm.orderBookImbalance !== undefined) {
            const obiPct = (wm.orderBookImbalance * 100).toFixed(1);
            obiEl.innerText = `${obiPct}% Bids`;
            if (obiDesc) obiDesc.innerText = `Bids: ${wm.bidVolumeTop20 ?? 0} BTC | Asks: ${wm.askVolumeTop20 ?? 0} BTC`;
            if (wm.orderBookImbalance >= 0.55) {
                obiEl.style.color = "var(--emerald)";
                if (obiStatus) { obiStatus.innerText = "BID WALL DOMINANT"; obiStatus.style.color = "var(--emerald)"; }
            } else if (wm.orderBookImbalance <= 0.45) {
                obiEl.style.color = "var(--rose)";
                if (obiStatus) { obiStatus.innerText = "ASK WALL DOMINANT"; obiStatus.style.color = "var(--rose)"; }
            } else {
                obiEl.style.color = "#ffffff";
                if (obiStatus) { obiStatus.innerText = "BALANCED DEPTH"; obiStatus.style.color = "var(--text-dim)"; }
            }
        }
    }

    // 6. News Articles Sync
    if (botInfo.latestArticles && Array.isArray(botInfo.latestArticles) && botInfo.latestArticles.length > 0) {
        rawArticles = botInfo.latestArticles;
        renderNewsFeed();
    }

    // 7. Update Positions Card & Summary
    updatePositionsView(positions || [], botInfo.lastPrice);

    // 7.5 Pre-Trade Open Position Gatekeeper & Filter Radar
    if (botInfo.filterEvaluation) {
        renderGatekeeperFilters(botInfo.filterEvaluation);
    }

    // 8. Update History & Fills Tables
    renderHistoryTables();
}

function updatePositionsView(positions, currentPrice) {
    const container = document.getElementById('positionContainer');
    const posCountBadge = document.getElementById('posCountBadge');
    const activePosCount = document.getElementById('activePosCount');
    const totalExposure = document.getElementById('totalExposure');
    const totalPnL = document.getElementById('totalPnL');
    const syncStatusEl = document.getElementById('exchangeSyncStatus');

    const targetMode = selectedPerformanceMode || 'DEMO';
    const modePositions = (positions || []).filter(p => (p.mode || 'DEMO').toUpperCase() === targetMode);
    if (posCountBadge) posCountBadge.innerText = `${modePositions.length} Open (${targetMode})`;
    if (activePosCount) activePosCount.innerText = `${modePositions.length} OPEN (${targetMode})`;

    const lev = (cachedBotInfo?.strategy?.leverage) || 50;
    const slPct = (cachedBotInfo?.strategy?.floorSlPct) || 0.20;
    const rr = (cachedBotInfo?.strategy?.rrRatio) || 2.0;
    const tpPct = slPct * rr;
    const isKeyLevel = cachedBotInfo?.strategy?.strategyMode === 'KEY_LEVEL_SNIPER' || cachedBotInfo?.strategy?.keyLevels?.enabled;

    if (modePositions.length === 0) {
        if (container) {
            container.innerHTML = `
                <div class="empty-position-state">
                    <div class="radar-scan-anim">
                        <div class="radar-circle"></div>
                    </div>
                    <div class="empty-title">No Active ${targetMode} Position</div>
                    <div class="empty-desc" id="emptyPositionDesc">
                        Engine actively scanning for ${isKeyLevel ? 'Key Level setups (15M Support/Resistance, Rejection Wick, AI News Confluence)' : 'Sniper setups (Order Flow Taker Imbalance, ADX &ge; 20, 15M MTF Confluence)'} on BTCUSDT 5M (SL ${slPct.toFixed(2)}% • TP ${tpPct.toFixed(2)}%, LEV ${lev}x) [${targetMode}].
                    </div>
                </div>
            `;
        }
        if (totalExposure) totalExposure.innerText = "$0.00";
        if (totalPnL) {
            totalPnL.innerText = "$0.00";
            totalPnL.style.color = "inherit";
        }
        if (syncStatusEl) {
            syncStatusEl.innerText = "Exchange: Ready";
            syncStatusEl.style.color = "var(--green)";
        }
        return;
    }

    let exposureSum = 0;
    let pnlSum = 0;

    modePositions.forEach(p => {
        const isLong = p.side === 'LONG';
        const entryPrice = parseFloat(p.entry_price || 0);
        const qty = Math.abs(parseFloat(p.qty || 0));
        const currP = (currentPrice && !isNaN(currentPrice)) ? parseFloat(currentPrice) : entryPrice;
        const notional = (entryPrice * qty).toFixed(2);
        
        // Sum exposure and floating PnL strictly for the active selectedPerformanceMode
        const priceDiff = isLong ? (currP - entryPrice) : (entryPrice - currP);
        const pnl = priceDiff * qty;
        exposureSum += parseFloat(notional);
        pnlSum += pnl;

        const defaultSlDist = entryPrice * (slPct / 100);
        const defaultTpDist = entryPrice * (tpPct / 100);
        const slPrice = parseFloat(p.trailing_sl || p.sl_price || (isLong ? entryPrice - defaultSlDist : entryPrice + defaultSlDist));
        const tpPrice = parseFloat(p.tp_price || (isLong ? entryPrice + defaultTpDist : entryPrice - defaultTpDist));
        const isBe = p.is_be_active === 1 || p.is_be_active === true;
        const slBeTag = isBe ? ' (🛡️ BE ACTIVE)' : '';

        // Range calculation: 0% is ALWAYS Stop Loss (Left/Red), 100% is ALWAYS Take Profit (Right/Green)
        let currentPct = 50;
        let entryPct = 33.3;

        if (isLong) {
            const span = tpPrice - slPrice;
            if (span > 0) {
                currentPct = Math.min(100, Math.max(0, ((currP - slPrice) / span) * 100));
                entryPct = Math.min(100, Math.max(0, ((entryPrice - slPrice) / span) * 100));
            }
        } else {
            // For SHORT: SL is higher price (0% on left), TP is lower price (100% on right)
            const span = slPrice - tpPrice;
            if (span > 0) {
                currentPct = Math.min(100, Math.max(0, ((slPrice - currP) / span) * 100));
                entryPct = Math.min(100, Math.max(0, ((slPrice - entryPrice) / span) * 100));
            }
        }

        const pnlColor = pnl >= 0 ? "var(--green)" : "var(--red)";
        const pnlSign = pnl >= 0 ? "+" : "";

        // Margin estimate using dynamic strategy leverage
        const marginUsed = (parseFloat(notional) / lev).toFixed(2);
        const roiPct = marginUsed > 0 ? ((pnl / parseFloat(marginUsed)) * 100).toFixed(2) : "0.00";

        const cardKey = `${p.symbol}_${targetMode}`;
        const existingCard = document.getElementById(`posCard_${cardKey}`);
        if (existingCard && !container.querySelector('.empty-position-state')) {
            // Smoothly update elements without destroying the DOM so transition animations play
            const pin = document.getElementById(`posPin_${cardKey}`);
            const entryMarker = document.getElementById(`posEntryMarker_${cardKey}`);
            const liveText = document.getElementById(`posLive_${cardKey}`);
            const pnlVal = document.getElementById(`posPnlVal_${cardKey}`);
            const pnlSub = document.getElementById(`posPnlSub_${cardKey}`);
            const slLabel = document.getElementById(`posSlLabel_${cardKey}`);
            const tpLabel = document.getElementById(`posTpLabel_${cardKey}`);

            if (pin) {
                pin.style.left = `${currentPct.toFixed(2)}%`;
                pin.title = `Current Price: $${Number(currP).toLocaleString()} (${currentPct.toFixed(1)}%)`;
            }
            if (entryMarker) entryMarker.style.left = `${entryPct.toFixed(2)}%`;
            if (liveText) liveText.innerText = `LIVE: $${Number(currP).toFixed(1)}`;
            if (pnlVal) {
                pnlVal.innerText = `${pnlSign}$${pnl.toFixed(2)}`;
                pnlVal.style.color = pnlColor;
            }
            if (pnlSub) {
                pnlSub.innerHTML = `ROI: <strong style="color: ${pnlColor};">${pnlSign}${roiPct}%</strong> (${lev}x)`;
            }
            if (slLabel) slLabel.innerText = `STOP LOSS: $${Number(slPrice).toLocaleString()}${slBeTag}`;
            if (tpLabel) tpLabel.innerText = `TAKE PROFIT: $${Number(tpPrice).toLocaleString()}`;
        } else {
            // Initial render of the position card
            const isReal = targetMode === 'REAL';
            const modeBadgeHtml = isReal
                ? `<span style="font-size: 0.65rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4); margin-left: 6px;">REAL</span>`
                : `<span style="font-size: 0.65rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(245, 158, 11, 0.2); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.4); margin-left: 6px;">DEMO</span>`;

            const cardHtml = `
                <div class="active-pos-card" id="posCard_${cardKey}">
                    <div class="pos-card-top">
                        <div class="pos-symbol-group">
                            <span class="side-pill ${isLong ? 'long' : 'short'}">${p.side}</span>
                            <div>
                                <span class="pos-asset-name">${p.symbol}</span>
                                ${modeBadgeHtml}
                                <span class="pos-qty-tag mono"> ${qty.toFixed(3)} BTC</span>
                            </div>
                        </div>
                        <div class="pos-pnl-group">
                            <div class="pos-pnl-val mono" id="posPnlVal_${cardKey}" style="color: ${pnlColor};">
                                ${pnlSign}$${pnl.toFixed(2)}
                            </div>
                            <div class="pos-pnl-sub" id="posPnlSub_${cardKey}">
                                ROI: <strong style="color: ${pnlColor};">${pnlSign}${roiPct}%</strong> (${lev}x)
                            </div>
                        </div>
                    </div>

                    <!-- Visual Range Bar Tracker -->
                    <div class="pos-range-container">
                        <div class="range-labels">
                            <span class="target-sl" id="posSlLabel_${cardKey}">STOP LOSS: $${slPrice.toLocaleString()}${slBeTag}</span>
                            <span class="target-entry">ENTRY: $${entryPrice.toLocaleString()}</span>
                            <span class="target-tp" id="posTpLabel_${cardKey}">TAKE PROFIT: $${tpPrice.toLocaleString()}</span>
                        </div>
                        <div class="range-bar-track">
                            <div class="range-entry-marker" id="posEntryMarker_${cardKey}" style="left: ${entryPct.toFixed(2)}%;"></div>
                            <div class="range-current-pin" id="posPin_${cardKey}" style="left: ${currentPct.toFixed(2)}%;" title="Current Price: $${currP.toLocaleString()}"></div>
                        </div>
                        <div class="range-targets-row">
                            <span class="target-sl mono">-${slPct.toFixed(2)}%</span>
                            <span class="mono" id="posLive_${cardKey}" style="color: #fff;">LIVE: $${currP.toFixed(1)}</span>
                            <span class="target-tp mono">+${tpPct.toFixed(2)}%</span>
                        </div>
                    </div>

                    <!-- Position Meta Grid -->
                    <div class="pos-details-grid">
                        <div class="pos-detail-item">
                            <span>NOTIONAL VALUE</span>
                            <strong class="mono">$${Number(notional).toLocaleString()}</strong>
                        </div>
                        <div class="pos-detail-item">
                            <span>MARGIN USED (${lev}x)</span>
                            <strong class="mono">~$${marginUsed}</strong>
                        </div>
                        <div class="pos-detail-item">
                            <span>BINANCE SL ALGO ID</span>
                            <strong class="mono" style="font-size: 0.65rem;">${p.sl_id || 'Active'}</strong>
                        </div>
                        <div class="pos-detail-item">
                            <span>EXCHANGE TP ID</span>
                            <strong class="mono" style="font-size: 0.65rem;">${p.tp_id || 'Active'}</strong>
                        </div>
                    </div>
                </div>
            `;
            if (container) container.innerHTML = cardHtml;
        }
    });

    if (totalExposure) totalExposure.innerText = `$${exposureSum.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    if (totalPnL) {
        totalPnL.innerText = `${pnlSum >= 0 ? '+' : ''}$${pnlSum.toFixed(2)}`;
        totalPnL.style.color = pnlSum >= 0 ? "var(--green)" : "var(--red)";
    }

    if (syncStatusEl) {
        syncStatusEl.innerText = "Exchange: Guarded on Binance";
        syncStatusEl.style.color = "var(--green)";
    }
}

function switchHistoryTab(tab) {
    currentHistoryTab = tab;
    const btnClosed = document.getElementById('tabHistoryClosed');
    const btnFills = document.getElementById('tabHistoryFills');
    const tblClosed = document.getElementById('tableClosedTrades');
    const tblFills = document.getElementById('tableFills');

    if (btnClosed) btnClosed.classList.toggle('active', tab === 'closed');
    if (btnFills) btnFills.classList.toggle('active', tab === 'fills');

    if (tblClosed) tblClosed.style.display = tab === 'closed' ? '' : 'none';
    if (tblFills) tblFills.style.display = tab === 'fills' ? '' : 'none';
    
    renderHistoryTables();
}

function renderPerformanceMetrics() {
    const targetMode = selectedPerformanceMode || 'DEMO';
    const tf = selectedPerformanceTimeframe || 'all';
    const now = Date.now();

    let cutoff = 0;
    let tfLabel = 'All-Time';
    if (tf === '24h') {
        cutoff = now - (24 * 60 * 60 * 1000);
        tfLabel = 'Last 24 Hours';
    } else if (tf === '3d') {
        cutoff = now - (3 * 24 * 60 * 60 * 1000);
        tfLabel = 'Last 3 Days';
    } else if (tf === '7d') {
        cutoff = now - (7 * 24 * 60 * 60 * 1000);
        tfLabel = 'Last 7 Days';
    } else if (tf === '14d') {
        cutoff = now - (14 * 24 * 60 * 60 * 1000);
        tfLabel = 'Last 14 Days';
    } else if (tf === '30d') {
        cutoff = now - (30 * 24 * 60 * 60 * 1000);
        tfLabel = 'Last 30 Days';
    }

    const tradeHist = cachedHistory || [];
    const modeTrades = tradeHist.filter(h => {
        const m = (h.mode || 'DEMO').toUpperCase();
        if (m !== targetMode) return false;
        if (cutoff > 0 && Number(h.timestamp) < cutoff) return false;
        return true;
    });

    const totalRealizedPnl = modeTrades.reduce((acc, h) => acc + parseFloat(h.pnl || 0), 0);
    const wins = modeTrades.filter(h => parseFloat(h.pnl || 0) > 0).length;
    const losses = modeTrades.filter(h => parseFloat(h.pnl || 0) < 0).length;
    const totalTrades = modeTrades.length;
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';

    // 1. Update Mode Toggle Pills
    const demoBtn = document.getElementById('perfModeDemo');
    const realBtn = document.getElementById('perfModeReal');
    if (demoBtn && realBtn) {
        demoBtn.className = `perf-mode-pill ${targetMode === 'DEMO' ? 'active demo' : ''}`;
        realBtn.className = `perf-mode-pill ${targetMode === 'REAL' ? 'active real' : ''}`;
    }

    // 2. Update Timeframe Filter Buttons
    ['all', '24h', '3d', '7d', '14d', '30d'].forEach(t => {
        const btn = document.getElementById(`tf_${t}`);
        if (btn) btn.classList.toggle('active', t === tf);
    });

    // 3. Update Realized PnL Value and Context Label
    const pnlEl = document.getElementById('totalRealizedPnL');
    if (pnlEl) {
        const sign = totalRealizedPnl > 0 ? '+' : '';
        pnlEl.innerText = `${sign}$${totalRealizedPnl.toFixed(2)}`;
        pnlEl.style.color = totalRealizedPnl > 0 ? "var(--green)" : (totalRealizedPnl < 0 ? "var(--red)" : "#ffffff");
    }

    const labelEl = document.getElementById('perfTimeframeLabel');
    if (labelEl) {
        labelEl.innerHTML = `<span class="perf-pnl-title">Net Realized PnL</span> <span class="perf-context-pill">${tfLabel} • ${targetMode}</span>`;
    }

    // 4. Update Win Rate & Total Trades
    const winRateEl = document.getElementById('winRateText');
    if (winRateEl) {
        winRateEl.innerText = `${winRate}% (${wins}W / ${losses}L)`;
    }
    const tradeCountEl = document.getElementById('perfTradeCount');
    if (tradeCountEl) {
        tradeCountEl.innerText = `${totalTrades} Trades`;
    }

    // 5. Update Exposure & Open PnL strictly for the selected mode
    const modePositions = (cachedPositions || []).filter(p => (p.mode || 'DEMO').toUpperCase() === targetMode);
    const posCountBadge = document.getElementById('activePosCount');
    if (posCountBadge) {
        posCountBadge.innerText = `${modePositions.length} OPEN (${targetMode})`;
        posCountBadge.className = `badge ${modePositions.length > 0 ? (targetMode === 'REAL' ? 'badge-bullish' : 'badge-yellow') : 'badge-dim'}`;
    }

    let exposureSum = 0;
    let openPnlSum = 0;
    const currentPrice = cachedBotInfo?.lastPrice ? parseFloat(cachedBotInfo.lastPrice) : null;

    modePositions.forEach(p => {
        const entryPrice = parseFloat(p.entry_price || 0);
        const qty = Math.abs(parseFloat(p.qty || 0));
        exposureSum += entryPrice * qty;
        const currP = currentPrice || entryPrice;
        const isLong = p.side === 'LONG';
        const diff = isLong ? (currP - entryPrice) : (entryPrice - currP);
        openPnlSum += diff * qty;
    });

    const expEl = document.getElementById('totalExposure');
    if (expEl) expEl.innerText = `$${exposureSum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const openPnlEl = document.getElementById('totalPnL');
    if (openPnlEl) {
        const sign = openPnlSum > 0 ? '+' : '';
        openPnlEl.innerText = `${sign}$${openPnlSum.toFixed(2)}`;
        openPnlEl.style.color = openPnlSum > 0 ? "var(--green)" : (openPnlSum < 0 ? "var(--red)" : "inherit");
    }

    // 6. Update Balance (Equity) and Available Margin for the selected mode
    const equityEl = document.getElementById('perfEquityText');
    const availEl = document.getElementById('perfAvailText');
    const modeBal = cachedBotInfo?.accountBalances ? cachedBotInfo.accountBalances[targetMode] : null;
    if (equityEl) {
        if (modeBal && modeBal.totalMarginBalance) {
            const num = parseFloat(modeBal.totalMarginBalance);
            equityEl.innerText = `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        } else {
            equityEl.innerText = '--';
        }
    }
    if (availEl) {
        if (modeBal && modeBal.availableBalance) {
            const num = parseFloat(modeBal.availableBalance);
            availEl.innerText = `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        } else {
            availEl.innerText = '--';
        }
    }
}

function setPerfMode(mode) {
    if (mode !== 'DEMO' && mode !== 'REAL') return;
    selectedPerformanceMode = mode;
    renderPerformanceMetrics();
    renderHistoryTables();
    if (cachedBotInfo) {
        updatePositionsView(cachedPositions || [], cachedBotInfo.lastPrice);
    }
}

function setPerfTimeframe(tf) {
    selectedPerformanceTimeframe = tf;
    renderPerformanceMetrics();
    renderHistoryTables();
}

function renderHistoryTables() {
    const badge = document.getElementById('historyCountBadge');
    if (currentHistoryTab === 'closed') {
        const tbody = document.getElementById('closedTradesTable');
        if (!tbody) return;

        const targetMode = selectedPerformanceMode || 'DEMO';
        const tf = selectedPerformanceTimeframe || 'all';
        const now = Date.now();
        let cutoff = 0;
        if (tf === '24h') cutoff = now - (24 * 60 * 60 * 1000);
        else if (tf === '3d') cutoff = now - (3 * 24 * 60 * 60 * 1000);
        else if (tf === '7d') cutoff = now - (7 * 24 * 60 * 60 * 1000);
        else if (tf === '14d') cutoff = now - (14 * 24 * 60 * 60 * 1000);
        else if (tf === '30d') cutoff = now - (30 * 24 * 60 * 60 * 1000);

        const filteredTrades = (cachedHistory || []).filter(h => {
            const m = (h.mode || 'DEMO').toUpperCase();
            if (m !== targetMode) return false;
            if (cutoff > 0 && Number(h.timestamp) < cutoff) return false;
            return true;
        });

        if (badge) badge.innerText = `${filteredTrades.length} Trades (${targetMode})`;

        if (filteredTrades.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-table-cell">No closed trades recorded (${targetMode} • ${selectedPerformanceTimeframe.toUpperCase()}).</td></tr>`;
            return;
        }

        let html = '';
        filteredTrades.slice(0, 50).forEach(h => {
            const d = new Date(h.timestamp);
            const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
            const pnlNum = parseFloat(h.pnl || 0);
            const pnlClass = pnlNum >= 0 ? 'pnl-win' : 'pnl-loss';
            const sign = pnlNum >= 0 ? '+' : '';
            const isReal = (h.mode === 'REAL');
            const modeBadge = isReal
                ? `<span style="display:inline-block; font-size: 0.6rem; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.35);">REAL</span>`
                : `<span style="display:inline-block; font-size: 0.6rem; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.35);">DEMO</span>`;
            const commNum = parseFloat(h.commission || 0);
            const feeSub = commNum > 0 ? `<div style="font-size: 0.62rem; color: var(--text-dim); font-weight: normal;">Fee: -$${commNum.toFixed(2)}</div>` : '';
            html += `
                <tr>
                    <td class="mono" style="color: var(--text-dim); font-size: 0.72rem;">${timeStr}</td>
                    <td>${modeBadge}</td>
                    <td><span class="side-pill ${h.side === 'BUY' ? 'long' : 'short'}" style="font-size: 0.62rem; padding: 1px 5px;">${h.side}</span></td>
                    <td class="mono" style="color: #fff; font-weight: 600;">$${Number(h.price).toLocaleString()}</td>
                    <td class="mono">${Number(h.qty).toFixed(3)} BTC</td>
                    <td class="mono ${pnlClass}">${sign}$${pnlNum.toFixed(2)}${feeSub}</td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    } else {
        updateFillsTable(cachedFills);
    }
}

function updateFillsTable(fills) {
    const tbody = document.getElementById('fillsTable');
    const badge = document.getElementById('historyCountBadge');
    const targetMode = selectedPerformanceMode || 'DEMO';
    const modeFills = (fills || []).filter(f => (f.mode || 'DEMO').toUpperCase() === targetMode);

    if (badge && currentHistoryTab === 'fills') badge.innerText = `${modeFills.length} Fills (${targetMode})`;
    if (!tbody) return;

    if (modeFills.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" class="empty-table-cell">
                    No order fills recorded for ${targetMode} mode yet.
                </td>
            </tr>
        `;
        return;
    }

    let html = '';
    modeFills.slice(0, 50).forEach(f => {
        const timeStr = new Date(f.timestamp).toLocaleTimeString();
        const isReal = ((f.mode || 'DEMO').toUpperCase() === 'REAL');
        const modeBadge = isReal
            ? `<span style="display:inline-block; font-size: 0.6rem; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.35);">REAL</span>`
            : `<span style="display:inline-block; font-size: 0.6rem; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.35);">DEMO</span>`;
        html += `
            <tr>
                <td class="mono" style="color: var(--text-dim); font-size: 0.72rem;">${timeStr}</td>
                <td>${modeBadge}</td>
                <td class="mono" style="color: #38bdf8; font-size: 0.72rem;">${f.order_id}</td>
                <td class="mono" style="color: #fff; font-weight: 600;">$${Number(f.fill_price).toLocaleString()}</td>
                <td class="mono" style="color: var(--green);">${Number(f.fill_qty).toFixed(3)} BTC</td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
}

// News Feed Filtering & Rendering
function switchNewsTab(tab) {
    currentNewsTab = tab;
    document.getElementById('tabAll').classList.toggle('active', tab === 'all');
    const tabAi = document.getElementById('tabAi');
    if (tabAi) tabAi.classList.toggle('active', tab === 'ai');
    document.getElementById('tabMacro').classList.toggle('active', tab === 'macro');
    const tabWhale = document.getElementById('tabWhale');
    if (tabWhale) tabWhale.classList.toggle('active', tab === 'whale');
    document.getElementById('tabBinance').classList.toggle('active', tab === 'binance');
    renderNewsFeed();
}

function filterNewsList() {
    newsSearchQuery = document.getElementById('newsSearchInput').value.toLowerCase().trim();
    renderNewsFeed();
}

function renderNewsFeed() {
    const container = document.getElementById('newsStreamList');
    const countBadge = document.getElementById('newsCountBadge');

    if (!rawArticles || rawArticles.length === 0) {
        container.innerHTML = `
            <div class="news-loading-placeholder">
                <span>No news articles aggregated yet. Fetching next cycle...</span>
            </div>
        `;
        if (countBadge) countBadge.innerText = "0 Articles";
        return;
    }

    // Update Source Distribution Pills
    let coindeskCnt = 0;
    let decryptCnt = 0;
    let cointeleCnt = 0;
    let binanceCnt = 0;
    let whaleCnt = 0;

    rawArticles.forEach(a => {
        const s = (a.source || '').toLowerCase();
        if (a.isWhale || s.includes('whale') || (a.title && /\b(whale|transferred|dormant)\b/i.test(a.title))) {
            whaleCnt++;
        } else if (s.includes('binance') || a.isBinance || (a.title && a.title.toUpperCase().includes('BINANCE'))) {
            binanceCnt++;
        } else if (s.includes('coindesk')) {
            coindeskCnt++;
        } else if (s.includes('decrypt')) {
            decryptCnt++;
        } else if (s.includes('cointelegraph')) {
            cointeleCnt++;
        }
    });

    const cntCd = document.getElementById('cntCoindesk');
    const cntDc = document.getElementById('cntDecrypt');
    const cntCt = document.getElementById('cntCointelegraph');
    const cntBn = document.getElementById('cntBinance');
    const cntWh = document.getElementById('cntWhale');
    if (cntCd) cntCd.innerText = `CoinDesk: ${coindeskCnt}`;
    if (cntDc) cntDc.innerText = `Decrypt: ${decryptCnt}`;
    if (cntCt) cntCt.innerText = `Cointelegraph: ${cointeleCnt}`;
    if (cntBn) cntBn.innerText = `Binance: ${binanceCnt}`;
    if (cntWh) cntWh.innerText = `Whale Alert: ${whaleCnt}`;

    // Filter by tab and search
    let filtered = rawArticles.filter(item => {
        if (currentNewsTab === 'ai') {
            return latestAnalyzedHeadline && (item.title === latestAnalyzedHeadline || item.title.includes(latestAnalyzedHeadline.slice(0, 30)));
        }
        if (currentNewsTab === 'macro' && !item.isMacro) return false;
        if (currentNewsTab === 'whale') {
            const isWhaleRelated = item.isWhale || (item.source && item.source.toLowerCase().includes('whale')) || (item.title && /\b(whale|transferred|accumulate|dormant wallet)\b/i.test(item.title));
            if (!isWhaleRelated) return false;
        }
        if (currentNewsTab === 'binance') {
            const isBinanceRelated = item.source === 'Binance' || item.isBinance || (item.title && item.title.toUpperCase().includes('BINANCE')) || item.isHalt;
            if (!isBinanceRelated) return false;
        }
        if (newsSearchQuery && !item.title.toLowerCase().includes(newsSearchQuery)) return false;
        return true;
    });

    if (countBadge) countBadge.innerText = `${filtered.length} Articles`;

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="news-loading-placeholder">
                <span>No articles match the current filter "${currentNewsTab.toUpperCase()}".</span>
            </div>
        `;
        return;
    }

    let html = '';
    filtered.slice(0, 50).forEach(item => {
        const sourceLower = (item.source || '').toLowerCase();
        let sourceClass = 'source-coindesk';
        if (sourceLower.includes('decrypt')) sourceClass = 'source-decrypt';
        else if (sourceLower.includes('cointelegraph')) sourceClass = 'source-cointelegraph';
        if (sourceLower.includes('binance') || item.isBinance) sourceClass = 'source-binance';
        if (sourceLower.includes('whale') || item.isWhale) sourceClass = 'source-whale';

        // Check if this article is the one evaluated by AI
        const isAiEvaluated = latestAnalyzedHeadline && (item.title === latestAnalyzedHeadline || item.title.includes(latestAnalyzedHeadline.slice(0, 30)));

        // Relative time calculation
        const timeAgo = formatTimeAgo(item.pubDate);

        // Tags detection
        const titleUpper = item.title.toUpperCase();
        const tags = [];
        if (titleUpper.includes('BTC') || titleUpper.includes('BITCOIN')) tags.push('BTC');
        if (titleUpper.includes('FED') || titleUpper.includes('FOMC') || titleUpper.includes('POWELL')) tags.push('FED');
        if (titleUpper.includes('CPI') || titleUpper.includes('INFLATION')) tags.push('CPI');
        if (titleUpper.includes('ETF')) tags.push('ETF');
        if (titleUpper.includes('SEC') || titleUpper.includes('CFTC')) tags.push('REGULATION');
        if (titleUpper.includes('LIQUIDATION') || titleUpper.includes('CRASH')) tags.push('VOLATILITY');
        if (item.isWhale || titleUpper.includes('WHALE')) tags.push('WHALE RADAR');
        if (titleUpper.includes('HACK') || titleUpper.includes('EXPLOIT') || titleUpper.includes('AUDIT') || titleUpper.includes('SECURITY')) tags.push('SECURITY');
        if (item.isHalt) tags.push('BREAKING');

        let cardSpecialClass = '';
        if (isAiEvaluated) cardSpecialClass = 'is-ai-evaluated';
        else if (item.isHalt) cardSpecialClass = 'is-halt';
        else if (item.isMacro) cardSpecialClass = 'is-macro';

        html += `
            <div class="news-article-card ${cardSpecialClass}">
                <div class="news-meta-row">
                    <div class="news-badges-wrap">
                        <span class="source-badge ${sourceClass}">${escapeHtml(item.source || 'News')}</span>
                        ${isAiEvaluated ? `<span class="badge-ai-eval">⭐ AI EVALUATED</span>` : ''}
                        ${item.isWhale ? `<span class="impact-badge whale-impact">WHALE RADAR</span>` : ''}
                        ${item.isMacro && !isAiEvaluated ? `<span class="impact-badge macro-impact">HIGH IMPACT</span>` : ''}
                        ${item.isHalt ? `<span class="impact-badge halt-impact">HALT NOTICE</span>` : ''}
                    </div>
                    <span class="article-time mono">${timeAgo || 'Recent'}</span>
                </div>
                <a href="${item.link}" target="_blank" rel="noopener noreferrer" class="article-title-link news-title">
                    <span>${escapeHtml(item.title)}</span>
                    <span class="news-external-icon">↗</span>
                </a>
                <div class="news-tags-row">
                    ${tags.map(t => `<span class="keyword-tag news-tag ${t === 'BREAKING' ? 'tag-halt' : ''}">#${t}</span>`).join('')}
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    try {
        const diffMs = Date.now() - new Date(dateStr).getTime();
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        const diffDays = Math.floor(diffHours / 24);
        return `${diffDays}d ago`;
    } catch (e) {
        return '';
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ==============================================================================
// PRE-TRADE OPEN POSITION GATEKEEPER & FILTER RADAR
// ==============================================================================
function renderGatekeeperFilters(evalData) {
    if (!evalData) return;

    const signalBadge = document.getElementById('gatekeeperSignalBadge');
    const verdictBadge = document.getElementById('gatekeeperVerdictBadge');

    // 1. Signal Badge
    if (signalBadge) {
        const sig = evalData.signal || 'NEUTRAL';
        signalBadge.innerText = `Signal: ${sig}`;
        if (sig === 'LONG') {
            signalBadge.className = 'badge badge-bullish';
        } else if (sig === 'SHORT') {
            signalBadge.className = 'badge badge-bearish';
        } else {
            signalBadge.className = 'badge badge-dim';
        }
    }

    // 2. Verdict Badge Styling
    let verdict = evalData.verdict || 'NO_SIGNAL_SCANNING';
    if ((!cachedPositions || cachedPositions.length === 0) && verdict === 'IN_POSITION') {
        verdict = 'NO_SIGNAL_SCANNING';
    }

    if (verdictBadge) {
        if (verdict === 'ENTRY_READY') {
            verdictBadge.className = 'badge badge-bullish';
            verdictBadge.innerText = 'ENTRY READY (ALL PASS)';
        } else if (verdict === 'BLOCKED_BY_FILTER') {
            verdictBadge.className = 'badge badge-yellow';
            verdictBadge.innerText = `BLOCKED (${evalData.blockedReasons?.length || 1} FILTERS)`;
        } else if (verdict === 'IN_POSITION') {
            verdictBadge.className = 'badge badge-neutral';
            verdictBadge.innerText = 'ACTIVE POSITION IN PROGRESS';
        } else {
            verdictBadge.className = 'badge badge-dim';
            verdictBadge.innerText = 'SCANNING 5M';
        }
    }

    const summaryCard = document.getElementById('gatekeeperSummaryCard');
    const dot = document.getElementById('gatekeeperDot');
    const title = document.getElementById('gatekeeperTitle');
    const desc = document.getElementById('gatekeeperDesc');
    const blockReasonsEl = document.getElementById('gatekeeperBlockReasons');
    const grid = document.getElementById('gatekeeperFiltersGrid');

    if (!summaryCard || !grid) return;

    summaryCard.className = 'gatekeeper-summary-card';
    if (dot) dot.className = 'status-indicator-dot';

    const isKeyLevel = cachedBotInfo?.strategy?.strategyMode === 'KEY_LEVEL_SNIPER' || cachedBotInfo?.strategy?.keyLevels?.enabled;

    if (verdict === 'ENTRY_READY') {
        summaryCard.classList.add('verdict-ready');
        if (dot) dot.classList.add('dot-ready');
        if (title) {
            title.innerText = `Signal ${evalData.signal} Validated for Entry`;
            title.style.color = 'var(--emerald)';
        }
        if (desc) {
            desc.innerText = isKeyLevel
                ? 'Key Level S/R setup validated with rejection wick & all Gatekeeper filters passed. Primed for execution.'
                : 'Order Flow trigger & all Gatekeeper filters passed. System primed for execution.';
        }
    } else if (verdict === 'BLOCKED_BY_FILTER') {
        summaryCard.classList.add('verdict-blocked');
        if (dot) dot.classList.add('dot-blocked');
        if (title) {
            title.innerText = `Signal ${evalData.signal} Blocked by Gatekeeper Filter`;
            title.style.color = 'var(--amber)';
        }
        if (desc) {
            desc.innerText = isKeyLevel
                ? 'Key Level setup detected but execution held by rejection wick, volume, trend, or risk guards.'
                : 'Order flow imbalance detected but execution held by risk, liquidity, or absorption guards.';
        }
    } else if (verdict === 'IN_POSITION') {
        summaryCard.classList.add('verdict-in-position');
        if (dot) dot.classList.add('dot-in-pos');
        if (title) {
            title.innerText = 'Single Concurrent Position Guard Active';
            title.style.color = '#ffffff';
        }
        if (desc) {
            desc.innerText = `Position ${evalData.activePosition?.side || 'BTCUSDT'} is currently open. New entries blocked until exit (anti-pyramiding).`;
        }
    } else {
        if (title) {
            title.innerText = isKeyLevel
                ? 'Monitoring 5M Candle Close (15M S/R Key Level Sniper)'
                : 'Monitoring 5M Candle Close (Order Flow Reality)';
            title.style.color = '#ffffff';
        }
        if (desc) {
            desc.innerText = `Last candle closed at $${Number(evalData.candleClosePrice || 0).toLocaleString()} (Neutral / Consolidation Phase).`;
        }
    }

    // 3. Blocked Reasons Pills
    if (blockReasonsEl) {
        if (evalData.blockedReasons && evalData.blockedReasons.length > 0) {
            blockReasonsEl.style.display = 'flex';
            blockReasonsEl.innerHTML = evalData.blockedReasons.map(r => `
                <div class="block-pill">
                    <span class="block-pill-icon">⚠️</span>
                    <span>${escapeHtml(r)}</span>
                </div>
            `).join('');
        } else {
            blockReasonsEl.style.display = 'none';
            blockReasonsEl.innerHTML = '';
        }
    }

    // 4. Reality Triggers & Gatekeeper Filter Cards Grid
    if (evalData.filters) {
        const filterKeys = Object.keys(evalData.filters);
        grid.innerHTML = filterKeys.map(k => {
            const f = evalData.filters[k];
            const isPass = f.passed === true;
            const isBypass = (f.threshold && typeof f.threshold === 'string' && f.threshold.toLowerCase().includes('bypass'));
            let statusTagClass = isPass ? 'pass' : 'block';
            let statusText = isPass ? 'PASS' : 'BLOCKED';
            let cardClass = isPass ? 'passed' : 'blocked';
            if (isBypass) {
                statusTagClass = 'bypass';
                statusText = 'BYPASS';
                cardClass = 'bypassed';
            }
            return `
                <div class="filter-card ${cardClass}">
                    <div class="filter-card-header">
                        <span class="filter-card-title">${escapeHtml(f.name || k)}</span>
                        <span class="filter-status-tag ${statusTagClass}">${statusText}</span>
                    </div>
                    <div class="filter-card-value">${escapeHtml(f.value || '---')}</div>
                    <div class="filter-card-sub">${escapeHtml(f.statusText || f.threshold || '')}</div>
                </div>
            `;
        }).join('');
    }
}

// ==============================================================================
// REALTIME TERMINAL LOGS & CATEGORY FILTERING
// ==============================================================================
let currentLogCategory = 'all';

function switchLogCategory(cat) {
    currentLogCategory = cat;
    ['logTabAll', 'logTabBlocked', 'logTabSignals', 'logTabTrades', 'logTabAi'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    const activeMap = {
        'all': 'logTabAll',
        'blocked': 'logTabBlocked',
        'signals': 'logTabSignals',
        'trades': 'logTabTrades',
        'ai': 'logTabAi'
    };
    const activeBtnId = activeMap[cat];
    if (activeBtnId) {
        const el = document.getElementById(activeBtnId);
        if (el) el.classList.add('active');
    }
    renderLogs();
}

function isLogInCategory(logEntry, category) {
    if (!category || category === 'all') return true;
    const msg = (logEntry.message || logEntry.msg || '');
    if (category === 'blocked') {
        return msg.includes('[FILTER_BLOCKED]') || msg.toLowerCase().includes('blocked') || msg.toLowerCase().includes('contradict') || msg.toLowerCase().includes('veto');
    }
    if (category === 'signals') {
        return msg.includes('[SIGNAL') || msg.includes('[CANDLE') || msg.includes('[SCAN') || msg.includes('kline') || msg.includes('Candle closed');
    }
    if (category === 'trades') {
        return msg.includes('[ORDER') || msg.includes('[BINANCE') || msg.includes('[TRAILING') || msg.includes('[CLEANUP') || msg.includes('EXECUTION') || msg.includes('Position') || msg.includes('Filled');
    }
    if (category === 'ai') {
        return msg.includes('[AI_') || msg.includes('SumoPod') || msg.includes('Headline');
    }
    return true;
}

function updateBlockedLogCounters(filteredCount = 0) {
    const tabAll = document.getElementById('tabAllBadge');
    if (tabAll) tabAll.innerText = allLogs.length;

    const blockedCount = allLogs.filter(l => {
        const m = l.message || l.msg || '';
        return m.includes('[FILTER_BLOCKED]') || m.toLowerCase().includes('blocked');
    }).length;

    const tabBadge = document.getElementById('tabBlockedBadge');
    if (tabBadge) tabBadge.innerText = blockedCount;

    const pill = document.getElementById('blockedLogsCountBadge');
    if (pill) {
        pill.innerText = `${blockedCount} Blocked`;
        pill.style.display = blockedCount > 0 ? 'inline-block' : 'none';
    }

    const sigCount = allLogs.filter(l => isLogInCategory(l, 'signals')).length;
    const tabSignals = document.getElementById('tabSignalsBadge');
    if (tabSignals) tabSignals.innerText = sigCount;

    const tradeCount = allLogs.filter(l => isLogInCategory(l, 'trades')).length;
    const tabTrades = document.getElementById('tabTradesBadge');
    if (tabTrades) tabTrades.innerText = tradeCount;

    const aiCount = allLogs.filter(l => isLogInCategory(l, 'ai')).length;
    const tabAi = document.getElementById('tabAiBadge');
    if (tabAi) tabAi.innerText = aiCount;

    const bufferEl = document.getElementById('terminalBufferText');
    if (bufferEl) bufferEl.innerText = `Buffer: ${allLogs.length} / 1000`;

    const catNames = {
        all: 'All Logs',
        blocked: 'Filter Blocked',
        signals: 'Signals & Scans',
        trades: 'Orders & Positions',
        ai: 'AI Macro'
    };
    const filterText = (document.getElementById('logFilter')?.value || '').trim();
    const activeEl = document.getElementById('terminalActiveFilterText');
    if (activeEl) {
        activeEl.innerText = `Category: ${catNames[currentLogCategory] || 'All Logs'}${filterText ? ` • Keyword: "${filterText}"` : ''}`;
    }

    const statsEl = document.getElementById('terminalStatsText');
    if (statsEl) {
        statsEl.innerText = `Displaying: ${filteredCount} logs`;
    }
}

function formatLogEntryHtml(logEntry) {
    const time = formatLogTime(logEntry);
    const msg = logEntry.message || logEntry.msg || '';
    const level = logEntry.level || 'INFO';
    const logMode = (logEntry.mode || 'DEMO').toUpperCase();
    let entryClass = 'log-entry';
    let displayTag = `[${level}]`;
    let tagClass = level;

    if (msg.includes('[FILTER_BLOCKED]')) {
        entryClass += ' entry-blocked';
        displayTag = '[BLOCKED]';
        tagClass = 'BLOCKED';
    } else if (msg.includes('[SIGNAL_DETECTED]')) {
        entryClass += ' entry-signal';
        displayTag = '[SIGNAL]';
        tagClass = 'SIGNAL';
    } else if (msg.includes('[SIGNAL_PASSED]')) {
        entryClass += ' entry-passed';
        displayTag = '[APPROVED]';
        tagClass = 'PASSED';
    } else if (msg.includes('[CANDLE_SCAN]')) {
        entryClass += ' entry-scan';
        displayTag = '[SCAN]';
        tagClass = 'SCAN';
    } else if (msg.includes('[AI_') || msg.includes('SumoPod')) {
        entryClass += ' entry-ai';
        displayTag = '[AI]';
        tagClass = 'AI';
    } else if (msg.includes('[BINANCE_') || msg.includes('[ORDER') || msg.includes('[TRAILING') || msg.includes('[CLEANUP')) {
        entryClass += ' entry-trade';
        displayTag = '[TRADE]';
        tagClass = 'TRADE';
    }

    let cleanMsg = escapeHtml(msg)
        .replace(/\[FILTER_BLOCKED\]/g, '<span style="color:#fbbf24;font-weight:700;">[FILTER BLOCKED]</span>')
        .replace(/\[SIGNAL_DETECTED\]/g, '<span style="color:#38bdf8;font-weight:700;">[SIGNAL DETECTED]</span>')
        .replace(/\[SIGNAL_PASSED\]/g, '<span style="color:#34d399;font-weight:700;">[SIGNAL PASSED]</span>')
        .replace(/\[CANDLE_SCAN\]/g, '<span style="color:#94a3b8;font-weight:600;">[CANDLE SCAN]</span>');

    const modeBadge = logMode === 'REAL'
        ? `<span style="display:inline-block; font-size:0.62rem; font-weight:700; padding:1px 4px; border-radius:3px; background:rgba(16,185,129,0.18); color:#10b981; border:1px solid rgba(16,185,129,0.35); margin-right:4px;">[REAL]</span>`
        : `<span style="display:inline-block; font-size:0.62rem; font-weight:700; padding:1px 4px; border-radius:3px; background:rgba(245,158,11,0.18); color:#f59e0b; border:1px solid rgba(245,158,11,0.35); margin-right:4px;">[DEMO]</span>`;

    return `
        <div class="${entryClass}">
            <span class="log-time">[${time}]</span>
            ${modeBadge}
            <span class="log-tag ${tagClass}">${displayTag}</span>
            <span class="log-msg">${cleanMsg}</span>
        </div>
    `;
}

function formatLogTime(entry) {
    if (!entry) return '--:--:--';
    if (entry.fullTime) {
        try {
            return new Date(entry.fullTime).toLocaleTimeString();
        } catch (e) {}
    }
    if (entry.timestamp && typeof entry.timestamp === 'string') {
        return entry.timestamp;
    }
    if (entry.timestamp && typeof entry.timestamp === 'number') {
        return new Date(entry.timestamp).toLocaleTimeString();
    }
    return new Date().toLocaleTimeString();
}

function renderLogs() {
    const box = document.getElementById('terminalLogBox');
    if (!box) return;
    const filterText = (document.getElementById('logFilter')?.value || '').toLowerCase();

    const filtered = allLogs.filter(l => {
        if (!isLogInCategory(l, currentLogCategory)) return false;
        if (!filterText) return true;
        const msg = (l.message || l.msg || '').toLowerCase();
        const level = (l.level || '').toLowerCase();
        return msg.includes(filterText) || level.includes(filterText);
    });

    updateBlockedLogCounters(filtered.length);

    if (filtered.length === 0) {
        box.innerHTML = `<div class="log-entry"><span class="log-time">[SYS]</span><span class="log-tag INFO">[INFO]</span><span class="log-msg">${filterText || currentLogCategory !== 'all' ? 'No log entries match the active filter criteria.' : 'Live terminal ready. Listening for incoming events...'}</span></div>`;
        return;
    }

    let html = '';
    filtered.slice(-500).forEach(l => {
        html += formatLogEntryHtml(l);
    });

    box.innerHTML = html;
    if (autoScroll) {
        box.scrollTop = box.scrollHeight;
    }
}

function appendLog(logEntry) {
    if (!logEntry) return;
    allLogs.push(logEntry);
    if (allLogs.length > 1000) allLogs.shift();

    if (!isLogInCategory(logEntry, currentLogCategory)) {
        updateBlockedLogCounters();
        return;
    }

    const msg = logEntry.message || logEntry.msg || '';
    const level = logEntry.level || 'INFO';
    const filterText = (document.getElementById('logFilter')?.value || '').toLowerCase();

    if (filterText && !msg.toLowerCase().includes(filterText) && !level.toLowerCase().includes(filterText)) {
        updateBlockedLogCounters();
        return;
    }

    const box = document.getElementById('terminalLogBox');
    if (!box) return;

    const div = document.createElement('div');
    div.innerHTML = formatLogEntryHtml(logEntry);
    const entryEl = div.firstElementChild;
    if (entryEl) {
        box.appendChild(entryEl);
        if (autoScroll) {
            box.scrollTop = box.scrollHeight;
        }
    }

    updateBlockedLogCounters();
}

function filterLogs() {
    renderLogs();
}

function toggleAutoScroll() {
    autoScroll = !autoScroll;
    const btn = document.getElementById('btnAutoScroll');
    btn.innerText = `Scroll: ${autoScroll ? 'ON' : 'OFF'}`;
    btn.style.color = autoScroll ? 'var(--green)' : 'var(--text-dim)';
}

let terminalHeightMode = 0;
function cycleTerminalHeight() {
    const panel = document.getElementById('mainTerminalPanel');
    const btn = document.getElementById('btnTerminalHeight');
    if (!panel || !btn) return;
    terminalHeightMode = (terminalHeightMode + 1) % 2;
    if (terminalHeightMode === 1) {
        panel.classList.add('expanded');
        btn.innerText = 'Height: 720px';
    } else {
        panel.classList.remove('expanded');
        btn.innerText = 'Height: 520px';
    }
    const box = document.getElementById('terminalLogBox');
    if (box && autoScroll) box.scrollTop = box.scrollHeight;
}

function toggleTerminalFullscreen() {
    const panel = document.getElementById('mainTerminalPanel');
    const btn = document.getElementById('btnTerminalFullscreen');
    if (!panel || !btn) return;
    const isFull = panel.classList.toggle('fullscreen');
    if (isFull) {
        btn.innerText = '✖ Exit Fullscreen';
        btn.classList.add('active');
        document.body.style.overflow = 'hidden';
    } else {
        btn.innerText = '⛶ Fullscreen';
        btn.classList.remove('active');
        document.body.style.overflow = '';
    }
    const box = document.getElementById('terminalLogBox');
    if (box && autoScroll) box.scrollTop = box.scrollHeight;
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const panel = document.getElementById('mainTerminalPanel');
        if (panel && panel.classList.contains('fullscreen')) {
            toggleTerminalFullscreen();
        }
    }
});

function copyTerminalLogs() {
    const box = document.getElementById('terminalLogBox');
    const btn = document.getElementById('btnCopyLogs');
    if (!box) return;
    const text = box.innerText;
    if (!navigator.clipboard) {
        alert('Clipboard API is not supported in this browser.');
        return;
    }
    navigator.clipboard.writeText(text).then(() => {
        if (btn) {
            const orig = btn.innerText;
            btn.innerText = '✅ Copied!';
            setTimeout(() => { btn.innerText = orig; }, 2000);
        }
    }).catch(err => {
        console.error('Failed to copy logs', err);
    });
}

function clearLogs() {
    allLogs = [];
    updateBlockedLogCounters(0);
    document.getElementById('terminalLogBox').innerHTML = '';
}

// Emergency Actions
async function triggerPanic() {
    if (!confirm("🚨 ARE YOU SURE? This will immediately close all active positions and HALT all trade executions!")) return;
    try {
        const res = await authenticatedFetch('/api/panic', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        const data = await res.json();
        if (res.ok) {
            if (data.positionClosed) {
                alert(`🚨 PANIC EXECUTED: Position (${data.details?.side} ${data.details?.qty} BTC) has been CLOSED at market price and trading is LOCKED.`);
            } else {
                alert("🚨 PANIC EXECUTED: All open orders cancelled and trading is LOCKED.");
            }
            if (typeof fetchInitialState === 'function') {
                fetchInitialState();
            }
        } else {
            alert("Failed to execute panic: " + (data.error || 'Server error'));
        }
    } catch (e) {
        alert("Failed to send panic request: " + e.message);
    }
}

async function unlockTrading() {
    if (!confirm("Unlock bot trading execution?")) return;
    try {
        const res = await authenticatedFetch('/api/unlock', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        if (res.ok) {
            alert("Bot Trading Execution has been UNLOCKED.");
            if (typeof fetchInitialState === 'function') {
                fetchInitialState();
            }
        }
    } catch (e) {
        alert("Failed to unlock: " + e.message);
    }
}

// Mode Switching Modal Handlers
let targetSwitchMode = 'REAL';

function openSwitchModeModal() {
    targetSwitchMode = (currentTradingMode === 'REAL') ? 'DEMO' : 'REAL';
    const modal = document.getElementById('switchModeModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalIcon = document.getElementById('modalIcon');
    const alertBox = document.getElementById('modalAlertBox');
    const infoList = document.getElementById('modalInfoList');
    const check = document.getElementById('confirmSwitchCheck');
    const btnConfirm = document.getElementById('btnConfirmSwitch');
    const checkText = document.getElementById('confirmCheckText');

    if (check) check.checked = false;
    if (btnConfirm) btnConfirm.disabled = true;

    if (targetSwitchMode === 'REAL') {
        if (modalIcon) modalIcon.innerText = "🚨";
        if (modalTitle) modalTitle.innerText = "Konfirmasi Beralih ke REAL PRODUCTION (Modal Riil)";
        if (alertBox) {
            alertBox.className = "modal-alert-box alert-to-real";
            alertBox.innerHTML = `<strong>PERINGATAN RISIKO TINGGI (HIGH RISK WARNING):</strong> Anda beralih ke <strong>Live Production (Modal Riil / Real Money)</strong>. Semua eksekusi order berikutnya akan mempertaruhkan <strong>modal riil USDT</strong> di Binance Futures. Pastikan API Key Live memiliki izin Futures dan saldo margin mencukupi.`;
        }
        if (infoList) {
            const realBal = cachedBotInfo?.accountBalances?.REAL?.totalMarginBalance;
            const balStr = realBal ? `$${parseFloat(realBal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT` : 'Ready';
            const stratLev = (cachedBotInfo?.strategy?.leverage) || 25;
            const stratRisk = (cachedBotInfo?.strategy?.riskPerTradePct) || 1.5;
            infoList.innerHTML = `
                <div class="modal-info-item"><span>Target Mode:</span> <strong style="color: var(--red);">REAL PRODUCTION (Live Trading)</strong></div>
                <div class="modal-info-item"><span>Exchange Endpoint:</span> <strong>https://fapi.binance.com</strong></div>
                <div class="modal-info-item"><span>Saldo Modal Riil:</span> <strong style="color: var(--emerald);">${balStr}</strong></div>
                <div class="modal-info-item"><span>Account Leverage:</span> <strong>${stratLev}x Cross (BTCUSDT)</strong></div>
                <div class="modal-info-item"><span>Toleransi Risiko:</span> <strong>${stratRisk}% Margin Tersedia / Trade</strong></div>
            `;
        }
        if (checkText) checkText.innerText = "Saya memahami risiko kerugian modal riil dan menyetujui peralihan ke Live Production.";
        if (btnConfirm) {
            btnConfirm.className = "btn-confirm-mode btn-to-real";
            btnConfirm.innerText = "Konfirmasi Beralih ke Modal Riil (Live)";
        }
    } else {
        if (modalIcon) modalIcon.innerText = "🧪";
        if (modalTitle) modalTitle.innerText = "Konfirmasi Beralih ke TESTNET DEMO (Simulasi Modal Virtual)";
        if (alertBox) {
            alertBox.className = "modal-alert-box alert-to-demo";
            alertBox.innerHTML = `Anda beralih ke <strong>Mode Simulasi (Binance Futures Testnet)</strong>. Semua eksekusi order berikutnya akan menggunakan saldo modal virtual Testnet tanpa risiko finansial nyata.`;
        }
        if (infoList) {
            const demoBal = cachedBotInfo?.accountBalances?.DEMO?.totalMarginBalance;
            const balStr = demoBal ? `$${parseFloat(demoBal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT` : 'Ready';
            infoList.innerHTML = `
                <div class="modal-info-item"><span>Target Mode:</span> <strong style="color: var(--yellow);">DEMO TESTNET (Simulasi)</strong></div>
                <div class="modal-info-item"><span>Exchange Endpoint:</span> <strong>https://testnet.binancefuture.com</strong></div>
                <div class="modal-info-item"><span>Saldo Modal Virtual:</span> <strong style="color: var(--yellow);">${balStr}</strong></div>
                <div class="modal-info-item"><span>Risiko Finansial:</span> <strong>Nol (Risk-Free Paper Trading)</strong></div>
            `;
        }
        if (checkText) checkText.innerText = "Saya mengonfirmasi beralih ke mode simulasi (Testnet).";
        if (btnConfirm) {
            btnConfirm.className = "btn-confirm-mode btn-to-demo";
            btnConfirm.innerText = "Konfirmasi Beralih ke Modal Demo (Testnet)";
        }
    }

    if (modal) modal.style.display = 'flex';
}

function closeSwitchModeModal() {
    const modal = document.getElementById('switchModeModal');
    if (modal) modal.style.display = 'none';
}

function toggleConfirmBtn() {
    const check = document.getElementById('confirmSwitchCheck');
    const btnConfirm = document.getElementById('btnConfirmSwitch');
    if (check && btnConfirm) {
        btnConfirm.disabled = !check.checked;
    }
}

async function executeSwitchMode() {
    const btnConfirm = document.getElementById('btnConfirmSwitch');
    if (btnConfirm) {
        btnConfirm.disabled = true;
        btnConfirm.innerText = "Memproses Peralihan...";
    }

    try {
        const res = await authenticatedFetch('/api/switch-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetMode: targetSwitchMode })
        });

        const data = await res.json();
        if (res.ok) {
            closeSwitchModeModal();
            const connText = document.getElementById('connText');
            if (connText) connText.innerText = `RELOADING (${targetSwitchMode})...`;
            alert(`✅ Success: Trading mode switched to ${targetSwitchMode}. Bot is reloading configuration in a few seconds.`);
            setTimeout(() => {
                window.location.reload();
            }, 2500);
        } else {
            alert("Failed to switch mode: " + (data.error || 'Server error'));
            if (btnConfirm) {
                btnConfirm.disabled = false;
                btnConfirm.innerText = "Switch Now";
            }
        }
    } catch (e) {
        alert("Network error: " + e.message);
        if (btnConfirm) {
            btnConfirm.disabled = false;
            btnConfirm.innerText = "Switch Now";
        }
    }
}
