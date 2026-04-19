"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TradeHistory = void 0;
const logs_1 = require("../reporting/logs");
/**
 * Fetches real price history from the Polymarket CLOB API.
 * Uses the `/prices-history` endpoint with a given clobTokenId.
 */
class TradeHistory {
    constructor(clobApi = 'https://clob.polymarket.com') {
        this.clobApi = clobApi;
    }
    /**
     * Fetch recent price history for a market.
     * @param clobTokenId – the CLOB token ID (not the market's numeric ID)
     * @param interval – timeframe: '1d','1w','1m','all'  (default '1d')
     * @param fidelity – seconds between data points (default 60)
     */
    async fetchPriceHistory(clobTokenId, interval = '1d', fidelity = 60) {
        const url = `${this.clobApi}/prices-history?market=${clobTokenId}&interval=${interval}&fidelity=${fidelity}`;
        try {
            const response = await fetch(url);
            if (!response.ok) {
                logs_1.logger.warn({ status: response.status, clobTokenId }, 'CLOB prices-history request failed');
                return [];
            }
            const data = (await response.json());
            if (!data.history || !Array.isArray(data.history))
                return [];
            return data.history.map((h) => ({
                price: h.p,
                timestamp: h.t,
            }));
        }
        catch (error) {
            logs_1.logger.error({ error, clobTokenId }, 'Failed to fetch price history');
            return [];
        }
    }
    /**
     * Legacy compatibility wrapper – returns simple {price, size} tuples
     * by sampling from real price history.
     */
    async fetchRecentTrades(clobTokenId) {
        const history = await this.fetchPriceHistory(clobTokenId, '1d', 300);
        if (history.length === 0)
            return [];
        // Take the last 20 price points and approximate size from the interval
        return history.slice(-20).map((h) => ({ price: h.price, size: 10 }));
    }
}
exports.TradeHistory = TradeHistory;
