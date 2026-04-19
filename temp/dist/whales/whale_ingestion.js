"use strict";
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — Ingestion Pipeline
   Fetches whale trades from Polymarket CLOB API, de-duplicates, normalises,
   enriches with orderbook snapshots, and stores.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhaleIngestion = void 0;
const logs_1 = require("../reporting/logs");
class WhaleIngestion {
    constructor(db, config, clobApi, gammaApi) {
        this.running = false;
        this.pollTimer = null;
        this.requestTimestamps = [];
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 10;
        this.marketMetadataCache = new Map();
        this.metadataCacheLoadedAt = 0;
        this.db = db;
        this.config = config;
        this.clobApi = clobApi;
        this.gammaApi = gammaApi;
    }
    /* ━━━━━━━━━━━━━━ Lifecycle ━━━━━━━━━━━━━━ */
    start() {
        if (this.running)
            return;
        this.running = true;
        logs_1.logger.info('WhaleIngestion started');
        // Immediately run, then schedule
        void this.pollCycle();
        this.pollTimer = setInterval(() => {
            void this.pollCycle();
        }, this.config.pollIntervalMs);
    }
    stop() {
        this.running = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        logs_1.logger.info('WhaleIngestion stopped');
    }
    /* ━━━━━━━━━━━━━━ Poll cycle ━━━━━━━━━━━━━━ */
    async pollCycle() {
        if (!this.running)
            return;
        try {
            const { whales } = this.db.listWhales({ trackingEnabled: true, limit: 1000 });
            if (whales.length === 0) {
                return;
            }
            let newTradesTotal = 0;
            for (const whale of whales) {
                if (!this.running)
                    break;
                await this.rateLimitWait();
                const newCount = await this.fetchWhaleTradesIncremental(whale.id, whale.address, whale.lastTradeCursor ?? undefined);
                newTradesTotal += newCount;
            }
            this.consecutiveErrors = 0;
            if (newTradesTotal > 0) {
                logs_1.logger.info({ newTradesTotal, whaleCount: whales.length }, 'Ingestion poll complete');
            }
        }
        catch (err) {
            this.consecutiveErrors++;
            logs_1.logger.error({ err, consecutiveErrors: this.consecutiveErrors }, 'Ingestion poll error');
            if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
                logs_1.logger.error('Too many consecutive errors, entering degraded mode — backing off');
                await this.sleep(60000);
                this.consecutiveErrors = Math.floor(this.consecutiveErrors / 2);
            }
        }
    }
    /* ━━━━━━━━━━━━━━ Incremental fetch ━━━━━━━━━━━━━━ */
    async fetchWhaleTradesIncremental(whaleId, address, cursor) {
        const trades = await this.fetchTradesFromClob(address, cursor);
        if (trades.length === 0)
            return 0;
        const newTrades = [];
        let latestCursor = cursor;
        for (const raw of trades) {
            const tradeId = raw.id;
            // Dedup: unique on (whale_id, trade_id)
            const existing = this.db.getTradeByTradeId(whaleId, tradeId);
            if (existing)
                continue;
            const price = parseFloat(raw.price);
            const size = parseFloat(raw.size);
            const notional = price * size;
            const feeRate = parseFloat(raw.fee_rate_bps || '0') / 10000;
            const feeUsd = notional * feeRate;
            // Attempt orderbook snapshot for slippage estimation
            let midpoint = null;
            let bestBid = null;
            let bestAsk = null;
            let slippageBps = null;
            // Only fetch orderbook if the trade is very recent (< 60s)
            const tradeAge = Date.now() - new Date(raw.match_time).getTime();
            if (tradeAge < 60000 && notional >= 100) {
                try {
                    await this.rateLimitWait();
                    const book = await this.fetchOrderbook(raw.asset_id);
                    if (book) {
                        bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : null;
                        bestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : null;
                        if (bestBid !== null && bestAsk !== null) {
                            midpoint = (bestBid + bestAsk) / 2;
                            if (midpoint > 0) {
                                slippageBps = ((price - midpoint) / midpoint) * 10000;
                                if (raw.side === 'SELL')
                                    slippageBps = -slippageBps;
                            }
                        }
                    }
                }
                catch {
                    // Non-critical: continue without orderbook enrichment
                }
            }
            const aggressor = this.classifyAggressor(raw);
            newTrades.push({
                whaleId,
                tradeId,
                logicalTradeGroupId: raw.taker_order_id || null,
                marketId: raw.market,
                outcome: raw.outcome || raw.asset_id,
                side: raw.side,
                price,
                size,
                notionalUsd: notional,
                feeUsd,
                isFeeEstimated: false,
                ts: raw.match_time,
                midpointAtFill: midpoint,
                bestBidAtFill: bestBid,
                bestAskAtFill: bestAsk,
                slippageBps,
                aggressor,
            });
            // Track the latest cursor (newest trade timestamp)
            if (!latestCursor || raw.match_time > latestCursor) {
                latestCursor = raw.match_time;
            }
        }
        if (newTrades.length > 0) {
            const inserted = this.db.insertTrades(newTrades);
            // Update whale cursor and last_active_at
            this.db.updateWhale(whaleId, {
                lastTradeCursor: latestCursor ?? undefined,
                lastActiveAt: new Date().toISOString(),
            });
            logs_1.logger.debug({ whaleId, address: address.slice(0, 10) + '...', inserted }, 'Ingested whale trades');
            return inserted;
        }
        return 0;
    }
    /* ━━━━━━━━━━━━━━ Backfill ━━━━━━━━━━━━━━ */
    async backfillWhale(whaleId, address, maxPages = 50) {
        logs_1.logger.info({ whaleId, address: address.slice(0, 10) + '...', maxPages }, 'Starting backfill');
        this.db.updateWhale(whaleId, { dataIntegrity: 'BACKFILLING' });
        let totalInserted = 0;
        let cursor;
        let page = 0;
        while (page < maxPages) {
            await this.rateLimitWait();
            const trades = await this.fetchTradesFromClob(address, cursor, 500);
            if (trades.length === 0)
                break;
            const newTrades = trades.map((raw) => {
                const price = parseFloat(raw.price);
                const size = parseFloat(raw.size);
                const notional = price * size;
                const feeRate = parseFloat(raw.fee_rate_bps || '0') / 10000;
                return {
                    whaleId,
                    tradeId: raw.id,
                    logicalTradeGroupId: raw.taker_order_id || null,
                    marketId: raw.market,
                    outcome: raw.outcome || raw.asset_id,
                    side: raw.side,
                    price,
                    size,
                    notionalUsd: notional,
                    feeUsd: notional * feeRate,
                    isFeeEstimated: false,
                    ts: raw.match_time,
                    midpointAtFill: null,
                    bestBidAtFill: null,
                    bestAskAtFill: null,
                    slippageBps: null,
                    aggressor: this.classifyAggressor(raw),
                };
            });
            const inserted = this.db.insertTrades(newTrades);
            totalInserted += inserted;
            // Oldest trade in this page becomes the next cursor (go backwards)
            const oldest = trades[trades.length - 1];
            cursor = oldest.match_time;
            page++;
            if (trades.length < 500)
                break; // No more pages
        }
        // Update whale metadata
        const allTrades = this.db.getWhaleTrades(whaleId, { limit: 1 });
        const latestCursor = allTrades.length > 0 ? allTrades[0].ts : undefined;
        this.db.updateWhale(whaleId, {
            dataIntegrity: 'HEALTHY',
            lastBackfillAt: new Date().toISOString(),
            lastTradeCursor: latestCursor,
        });
        logs_1.logger.info({ whaleId, totalInserted, pages: page }, 'Backfill complete');
        return totalInserted;
    }
    /* ━━━━━━━━━━━━━━ CLOB API helpers ━━━━━━━━━━━━━━ */
    async fetchTradesFromClob(address, after, limit = 100) {
        let url = `${this.clobApi}/trades?maker_address=${address}&limit=${limit}`;
        if (after)
            url += `&after=${encodeURIComponent(after)}`;
        this.recordRequest();
        const res = await this.fetchWithRetry(url);
        if (!res)
            return [];
        const data = await res.json();
        return Array.isArray(data) ? data : (data.trades ?? []);
    }
    async fetchOrderbook(tokenId) {
        const url = `${this.clobApi}/book?token_id=${tokenId}`;
        this.recordRequest();
        const res = await this.fetchWithRetry(url);
        if (!res)
            return null;
        return await res.json();
    }
    /** Fetch market metadata from Gamma for enrichment */
    async refreshMarketMetadata() {
        // Only refresh every metadataCacheTtlMs
        const now = Date.now();
        if (now - this.metadataCacheLoadedAt < (this.config.metadataCacheTtlMs ?? 300000))
            return;
        try {
            await this.rateLimitWait();
            const url = `${this.gammaApi}/markets?active=true&closed=false&limit=200&order=volume24hr&ascending=false`;
            const res = await this.fetchWithRetry(url);
            if (!res)
                return;
            const markets = await res.json();
            this.marketMetadataCache.clear();
            for (const m of markets) {
                this.marketMetadataCache.set(m.id, {
                    question: m.question,
                    slug: m.slug,
                    outcomes: JSON.parse(m.outcomes || '[]'),
                });
            }
            this.metadataCacheLoadedAt = now;
            logs_1.logger.debug({ count: this.marketMetadataCache.size }, 'Refreshed market metadata cache');
        }
        catch (err) {
            logs_1.logger.warn({ err }, 'Failed to refresh market metadata');
        }
    }
    getMarketMeta(marketId) {
        return this.marketMetadataCache.get(marketId);
    }
    /* ━━━━━━━━━━━━━━ Rate limiting ━━━━━━━━━━━━━━ */
    recordRequest() {
        this.requestTimestamps.push(Date.now());
        // Trim old entries
        const cutoff = Date.now() - 60000;
        this.requestTimestamps = this.requestTimestamps.filter((t) => t >= cutoff);
    }
    async rateLimitWait() {
        const maxReq = this.config.maxRequestsPerMinute;
        const cutoff = Date.now() - 60000;
        this.requestTimestamps = this.requestTimestamps.filter((t) => t >= cutoff);
        if (this.requestTimestamps.length >= maxReq) {
            const oldest = this.requestTimestamps[0];
            const waitMs = oldest + 60000 - Date.now() + 100; // +100ms buffer
            if (waitMs > 0) {
                logs_1.logger.debug({ waitMs }, 'Rate limit: waiting');
                await this.sleep(waitMs);
            }
        }
    }
    /* ━━━━━━━━━━━━━━ Fetch with retry + exponential backoff ━━━━━━━━━━━━━━ */
    async fetchWithRetry(url, maxRetries = 3) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const res = await fetch(url);
                if (res.ok)
                    return res;
                if (res.status === 429) {
                    const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
                    logs_1.logger.warn({ retryAfter, attempt }, 'Rate limited, backing off');
                    await this.sleep(retryAfter * 1000);
                    continue;
                }
                if (res.status >= 500) {
                    logs_1.logger.warn({ status: res.status, attempt }, 'Server error, retrying');
                    await this.sleep(Math.pow(2, attempt) * 1000);
                    continue;
                }
                // 4xx (non-429) — don't retry
                logs_1.logger.error({ status: res.status, url: url.replace(/maker_address=0x[a-fA-F0-9]+/, 'maker_address=REDACTED') }, 'CLOB request failed');
                return null;
            }
            catch (err) {
                if (attempt === maxRetries) {
                    logs_1.logger.error({ err, attempt }, 'Fetch failed after retries');
                    return null;
                }
                await this.sleep(Math.pow(2, attempt) * 1000);
            }
        }
        return null;
    }
    /* ━━━━━━━━━━━━━━ Helpers ━━━━━━━━━━━━━━ */
    classifyAggressor(raw) {
        // Simple heuristic: the taker is the aggressor
        // If the trade type indicates market vs limit, use that
        if (raw.type === 'GTC' || raw.type === 'GTD')
            return 'UNKNOWN'; // limit order
        return raw.side; // taker side = aggressor
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.WhaleIngestion = WhaleIngestion;
