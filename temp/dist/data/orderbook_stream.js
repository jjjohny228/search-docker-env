"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderbookStream = void 0;
const events_1 = require("events");
const market_fetcher_1 = require("./market_fetcher");
const logs_1 = require("../reporting/logs");
const console_log_1 = require("../reporting/console_log");
/**
 * Polls the Polymarket Gamma API at a configurable interval and emits
 * real MarketData updates for every tracked market.
 */
class OrderbookStream extends events_1.EventEmitter {
    constructor(gammaApi, pollMs = 15000) {
        super();
        /** Cache of latest data keyed by marketId so strategies see history */
        this.cache = new Map();
        this.pollCount = 0;
        this.fetcher = new market_fetcher_1.MarketFetcher(gammaApi);
        this.pollMs = pollMs;
    }
    /** Start polling. First poll fires immediately. */
    start() {
        if (this.timer)
            return;
        // Fire immediately, then at interval
        void this.poll();
        this.timer = setInterval(() => void this.poll(), this.pollMs);
        logs_1.logger.info({ pollMs: this.pollMs }, 'OrderbookStream started (live Gamma polling)');
        console_log_1.consoleLog.success('SCAN', `OrderbookStream started — polling Gamma every ${this.pollMs / 1000}s`);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
            logs_1.logger.info('OrderbookStream stopped');
            console_log_1.consoleLog.warn('SCAN', 'OrderbookStream stopped');
        }
    }
    getMarket(marketId) {
        return this.cache.get(marketId);
    }
    getAllMarkets() {
        return [...this.cache.values()];
    }
    async poll() {
        try {
            const markets = await this.fetcher.fetchSnapshot();
            const prevSize = this.cache.size;
            for (const m of markets) {
                this.cache.set(m.marketId, m);
                this.emit('update', m);
            }
            this.pollCount++;
            const newMarkets = this.cache.size - prevSize;
            console_log_1.consoleLog.info('SCAN', `Poll #${this.pollCount} complete — ${markets.length} markets fetched, ${this.cache.size} cached${newMarkets > 0 ? `, ${newMarkets} new` : ''}`, {
                pollNumber: this.pollCount,
                fetched: markets.length,
                cached: this.cache.size,
                newMarkets,
            });
        }
        catch (error) {
            logs_1.logger.error({ error }, 'OrderbookStream poll failed');
            const msg = error instanceof Error ? error.message : String(error);
            console_log_1.consoleLog.error('SCAN', `Poll failed: ${msg}`, { error: msg });
        }
    }
}
exports.OrderbookStream = OrderbookStream;
