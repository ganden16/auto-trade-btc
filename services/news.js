const Parser = require('rss-parser');
const parser = new Parser();

const strategy = require('../config/strategy');

class NewsService {
    constructor() {
        this.macroKeywords = strategy.ai.macroKeywordsRegex;
        this.haltKeywords = strategy.ai.haltKeywordsRegex;
        this.spamKeywords = strategy.ai.spamKeywordsRegex;
        this.altcoinNoiseRegex = strategy.ai.altcoinNoiseRegex;
        this.opinionKeywords = strategy.ai.opinionKeywordsRegex;
    }

    isSpam(title) {
        if (!title) return false;
        return this.spamKeywords ? this.spamKeywords.test(title) : false;
    }

    isOpinion(title) {
        if (!title) return false;
        return this.opinionKeywords ? this.opinionKeywords.test(title) : false;
    }

    isFresh(pubDate, maxMinutes = (strategy.ai && strategy.ai.maxNewsAgeMinutes) || 45) {
        if (!pubDate) return false;
        const itemTime = new Date(pubDate).getTime();
        if (isNaN(itemTime) || itemTime === 0) return false;
        const ageMinutes = (Date.now() - itemTime) / 60000;
        return ageMinutes >= 0 && ageMinutes <= maxMinutes;
    }

    isPureAltcoin(title) {
        if (!title) return false;
        // If it explicitly mentions Bitcoin or macro anchors, it is relevant to BTC market
        if (/\b(BTC|BITCOIN|SAYLOR|STRATEGY|FED|CPI|INFLATION|ETF|SEC)\b/i.test(title)) {
            return false;
        }
        return this.altcoinNoiseRegex ? this.altcoinNoiseRegex.test(title) : false;
    }

    isHighImpactMacro(title, pubDate = null) {
        if (!title) return false;
        if (this.isSpam(title)) return false;
        if (this.isPureAltcoin(title)) return false;
        if (this.isOpinion(title)) return false;
        if (pubDate && !this.isFresh(pubDate)) return false;
        return this.macroKeywords.test(title);
    }

    async fetchBinanceAnnouncements() {
        const feedSources = [
            { source: 'Binance', url: 'https://news.google.com/rss/search?q=binance+announcement+when:7d&hl=en-US&gl=US&ceid=US:en' },
            { source: 'Binance', url: 'https://cointelegraph.com/rss/tag/binance' },
            { source: 'Whale Alert', url: 'https://cointelegraph.com/rss/tag/whale' },
            { source: 'Whale Alert', url: 'https://news.google.com/rss/search?q=bitcoin+whale+alert+OR+whale+wallet+when:7d&hl=en-US&gl=US&ceid=US:en' },
            { source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
            { source: 'Decrypt', url: 'https://decrypt.co/feed' },
            { source: 'Cointelegraph', url: 'https://cointelegraph.com/rss' }
        ];

        const results = await Promise.allSettled(
            feedSources.map(f => parser.parseURL(f.url).then(res => ({ source: f.source, data: res })))
        );

        const allItems = [];
        const seenTitles = new Set();

        for (const res of results) {
            if (res.status === 'fulfilled' && res.value && res.value.data && Array.isArray(res.value.data.items)) {
                const feedSource = res.value.source;
                for (const item of res.value.data.items) {
                    if (item && item.title) {
                        const cleanTitle = item.title.trim();
                        const titleKey = cleanTitle.toLowerCase();
                        // Filter out duplicates and spam/promotional press releases
                        if (!seenTitles.has(titleKey) && !this.isSpam(cleanTitle)) {
                            seenTitles.add(titleKey);
                            const isBinance = feedSource === 'Binance' || titleKey.includes('binance');
                            const isWhale = (feedSource === 'Whale Alert' || /\b(whale|transferred|accumulate|inflow|outflow|dormant wallet|whale alert)\b/i.test(titleKey)) && !this.isPureAltcoin(cleanTitle);
                            item._feedSource = isWhale ? 'Whale Alert' : (isBinance ? 'Binance' : feedSource);
                            item.isBinance = isBinance;
                            item.isWhale = isWhale;
                            allItems.push(item);
                        }
                    }
                }
            }
        }

        if (allItems.length === 0) {
            throw new Error("All news RSS feeds unreachable or blocked");
        }

        allItems.sort((a, b) => {
            const dateA = new Date(a.isoDate || a.pubDate || 0).getTime();
            const dateB = new Date(b.isoDate || b.pubDate || 0).getTime();
            return dateB - dateA;
        });

        return allItems;
    }
}

module.exports = new NewsService();
