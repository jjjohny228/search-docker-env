"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketFetcher = void 0;
const logs_1 = require("../reporting/logs");
class MarketFetcher {
    constructor(gammaApi = 'https://gamma-api.polymarket.com', limit = 0) {
        this.gammaApi = gammaApi;
        this.limit = limit;
    }
    /**
     * Fetch active, open Polymarket markets sorted by volume.
     * Paginates through the Gamma API to collect all qualifying
     * markets (or up to `limit` if set).
     */
    async fetchSnapshot() {
        try {
            const raw = await this.fetchAllPages();
            const markets = this.parseMarkets(raw);
            logs_1.logger.info({ count: markets.length, pages: Math.ceil(raw.length / MarketFetcher.PAGE_SIZE) }, 'Fetched live markets from Gamma API');
            return markets;
        }
        catch (error) {
            logs_1.logger.error({ error }, 'Failed to fetch markets from Gamma API');
            return [];
        }
    }
    /* ── Paginated fetcher ── */
    async fetchAllPages() {
        const all = [];
        let offset = 0;
        const pageSize = MarketFetcher.PAGE_SIZE;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const url = `${this.gammaApi}/markets?active=true&closed=false&limit=${pageSize}&offset=${offset}&order=volume24hr&ascending=false`;
            const response = await fetch(url);
            if (!response.ok) {
                logs_1.logger.error({ status: response.status, offset }, 'Gamma API page request failed');
                break;
            }
            const page = await response.json();
            if (page.length === 0)
                break;
            all.push(...page);
            // Stop early if we've hit the caller-requested limit
            if (this.limit > 0 && all.length >= this.limit) {
                return all.slice(0, this.limit);
            }
            // Last page was under-full → no more data
            if (page.length < pageSize)
                break;
            offset += pageSize;
        }
        return all;
    }
    /* ── Parse raw Gamma response into MarketData ── */
    parseMarkets(raw) {
        const markets = [];
        for (const m of raw) {
            try {
                if (!m.acceptingOrders)
                    continue;
                if (!m.clobTokenIds || m.clobTokenIds === '[]')
                    continue;
                const outcomes = JSON.parse(m.outcomes || '[]');
                const outcomePrices = JSON.parse(m.outcomePrices || '[]').map(Number);
                const clobTokenIds = JSON.parse(m.clobTokenIds || '[]');
                if (outcomePrices.length === 0 || outcomePrices.every((p) => p === 0))
                    continue;
                const yesPrice = outcomePrices[0] ?? 0.5;
                const noPrice = outcomePrices[1] ?? 1 - yesPrice;
                let bid = m.bestBid ?? Math.max(0.01, yesPrice - 0.02);
                let ask = m.bestAsk ?? Math.min(0.99, yesPrice + 0.02);
                // Gamma sometimes returns bestBid > bestAsk; normalise
                if (bid > ask) {
                    const tmp = bid;
                    bid = ask;
                    ask = tmp;
                }
                // Fallback: derive from yesPrice when bid/ask are zero or equal
                if (bid === 0 && ask === 0) {
                    bid = Math.max(0.001, yesPrice - 0.01);
                    ask = Math.min(0.999, yesPrice + 0.01);
                }
                const mid = (bid + ask) / 2;
                markets.push({
                    marketId: m.id,
                    question: m.question,
                    slug: m.slug,
                    outcomes,
                    outcomePrices: [yesPrice, noPrice],
                    clobTokenIds,
                    midPrice: Number(mid.toFixed(4)),
                    bid: Number(bid.toFixed(4)),
                    ask: Number(ask.toFixed(4)),
                    spread: Number((ask - bid).toFixed(4)),
                    volume24h: m.volume24hr ?? 0,
                    liquidity: m.liquidityNum ?? 0,
                    timestamp: Date.now(),
                    endDate: m.endDate ?? undefined,
                    eventId: m.events?.[0]?.id ?? undefined,
                    eventSlug: m.events?.[0]?.slug ?? undefined,
                    seriesSlug: m.events?.[0]?.series?.[0]?.slug ?? undefined,
                    oneDayPriceChange: m.oneDayPriceChange ?? undefined,
                    oneWeekPriceChange: m.oneWeekPriceChange ?? undefined,
                });
            }
            catch {
                logs_1.logger.warn({ marketId: m.id }, 'Skipping unparseable market');
            }
        }
        return markets;
    }
}
exports.MarketFetcher = MarketFetcher;
/** Page size for Gamma API pagination */
MarketFetcher.PAGE_SIZE = 100;
