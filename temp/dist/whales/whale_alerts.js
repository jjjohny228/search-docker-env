"use strict";
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — Alert Engine
   Generates alerts on whale activity: large trades, position flips,
   new market entries, near-resolution activity, whale coordination, etc.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhaleAlerts = void 0;
const logs_1 = require("../reporting/logs");
class WhaleAlerts {
    constructor(db, config) {
        this.tradeStdDevCache = new Map();
        this.db = db;
        this.config = config;
        this.webhookUrl = config.telegramWebhookUrl;
    }
    /* ━━━━━━━━━━━━━━ Process new trades for alerts ━━━━━━━━━━━━━━ */
    processNewTrades(whaleId, trades) {
        for (const trade of trades) {
            this.checkLargeTrade(whaleId, trade);
            this.checkNewMarketEntry(whaleId, trade);
        }
        this.checkPositionFlip(whaleId, trades);
    }
    /* ━━━━━━━━━━━━━━ Alert type: Large trade ━━━━━━━━━━━━━━ */
    checkLargeTrade(whaleId, trade) {
        const stats = this.getTradeStats(whaleId);
        if (!stats)
            return;
        const threshold = stats.mean + (stats.stdDev * this.config.largeTradeSigmaThreshold);
        if (trade.notionalUsd >= threshold) {
            this.createAlert(whaleId, 'large_trade', {
                tradeId: trade.tradeId,
                marketId: trade.marketId,
                side: trade.side,
                notionalUsd: trade.notionalUsd,
                threshold,
                sigmas: stats.stdDev > 0 ? (trade.notionalUsd - stats.mean) / stats.stdDev : 0,
            });
            this.createSignal('large_trade_detected', {
                whaleId,
                marketId: trade.marketId,
                side: trade.side,
                notionalUsd: trade.notionalUsd,
                ts: trade.ts,
            });
        }
    }
    /* ━━━━━━━━━━━━━━ Alert type: New market entry ━━━━━━━━━━━━━━ */
    checkNewMarketEntry(whaleId, trade) {
        if (trade.side !== 'BUY')
            return;
        // Check if this is the whale's first trade in this market
        const marketTrades = this.db.getWhaleTrades(whaleId, { marketId: trade.marketId, limit: 2 });
        if (marketTrades.length <= 1) {
            this.createAlert(whaleId, 'new_market_entry', {
                marketId: trade.marketId,
                outcome: trade.outcome,
                price: trade.price,
                size: trade.size,
                notionalUsd: trade.notionalUsd,
            });
            this.createSignal('new_market_entry', {
                whaleId,
                marketId: trade.marketId,
                outcome: trade.outcome,
                price: trade.price,
                ts: trade.ts,
            });
        }
    }
    /* ━━━━━━━━━━━━━━ Alert type: Position flip ━━━━━━━━━━━━━━ */
    checkPositionFlip(whaleId, trades) {
        // Group by market
        const byMarket = new Map();
        for (const t of trades) {
            if (!byMarket.has(t.marketId))
                byMarket.set(t.marketId, []);
            byMarket.get(t.marketId).push(t);
        }
        for (const [marketId, marketTrades] of byMarket) {
            const buys = marketTrades.filter((t) => t.side === 'BUY');
            const sells = marketTrades.filter((t) => t.side === 'SELL');
            // Simple flip detection: if we see both buys and sells in same batch
            if (buys.length > 0 && sells.length > 0) {
                const netBuy = buys.reduce((s, t) => s + t.size, 0);
                const netSell = sells.reduce((s, t) => s + t.size, 0);
                // Position flipped if net changed sign
                if (netSell > netBuy * 0.8) {
                    this.createAlert(whaleId, 'position_flip', {
                        marketId,
                        netBuy,
                        netSell,
                        direction: netSell > netBuy ? 'LONG_TO_SHORT' : 'REDUCING',
                    });
                }
            }
        }
    }
    /* ━━━━━━━━━━━━━━ Alert type: Whale coordination ━━━━━━━━━━━━━━ */
    checkWhaleCoordination(marketId, windowMinutes = 30) {
        const since = new Date(Date.now() - windowMinutes * 60000).toISOString();
        const recentTrades = this.db.getMarketTrades(marketId, { limit: 500 })
            .filter((t) => t.ts >= since);
        if (recentTrades.length < 3)
            return;
        // Count unique whales
        const whaleIds = new Set(recentTrades.map((t) => t.whaleId));
        if (whaleIds.size < 2)
            return;
        // Check if most are on the same side
        const buys = recentTrades.filter((t) => t.side === 'BUY');
        const sells = recentTrades.filter((t) => t.side === 'SELL');
        const sameSideRatio = Math.max(buys.length, sells.length) / recentTrades.length;
        if (sameSideRatio > 0.75 && whaleIds.size >= 2) {
            const dominantSide = buys.length > sells.length ? 'BUY' : 'SELL';
            const totalVolume = recentTrades.reduce((s, t) => s + t.notionalUsd, 0);
            this.createAlert(null, 'whale_coordination', {
                marketId,
                whaleCount: whaleIds.size,
                tradeCount: recentTrades.length,
                dominantSide,
                sameSideRatio,
                totalVolumeUsd: totalVolume,
                windowMinutes,
            });
            this.createSignal('whale_cluster', {
                marketId,
                whaleCount: whaleIds.size,
                dominantSide,
                totalVolumeUsd: totalVolume,
            });
        }
    }
    /* ━━━━━━━━━━━━━━ Alert type: Score change ━━━━━━━━━━━━━━ */
    checkScoreChange(whaleId, newScore, previousScore) {
        const diff = newScore - previousScore;
        if (Math.abs(diff) >= 10) {
            const type = diff > 0 ? 'score_surge' : 'score_drop';
            this.createAlert(whaleId, type, {
                previousScore,
                newScore,
                change: diff,
            });
        }
    }
    /* ━━━━━━━━━━━━━━ Alert type: Drawdown ━━━━━━━━━━━━━━ */
    checkDrawdown(whaleId, totalPnl, peakPnl) {
        if (peakPnl <= 0)
            return;
        const drawdownPct = (peakPnl - totalPnl) / peakPnl;
        if (drawdownPct >= 0.2) {
            this.createAlert(whaleId, 'drawdown_alert', {
                totalPnl,
                peakPnl,
                drawdownPct,
            });
        }
    }
    /* ━━━━━━━━━━━━━━ Core alert creation ━━━━━━━━━━━━━━ */
    createAlert(whaleId, type, payload) {
        const id = this.db.insertAlert({
            whaleId,
            type,
            payload,
            createdAt: new Date().toISOString(),
            delivered: false,
            readAt: null,
        });
        logs_1.logger.info({ alertId: id, type, whaleId }, 'Alert created');
        // Deliver to webhook if configured
        if (this.webhookUrl) {
            void this.deliverWebhook(type, payload);
        }
    }
    createSignal(type, payload) {
        const cursorKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.db.insertSignal({
            type,
            payload,
            createdAt: new Date().toISOString(),
            cursorKey,
        });
    }
    /* ━━━━━━━━━━━━━━ Trade stats cache ━━━━━━━━━━━━━━ */
    getTradeStats(whaleId) {
        const cached = this.tradeStdDevCache.get(whaleId);
        if (cached && Date.now() - cached.updatedAt < 600000)
            return cached;
        const trades = this.db.getWhaleTrades(whaleId, { limit: 500 });
        if (trades.length < 5)
            return null;
        const notionals = trades.map((t) => t.notionalUsd);
        const mean = notionals.reduce((s, n) => s + n, 0) / notionals.length;
        const variance = notionals.reduce((s, n) => s + (n - mean) ** 2, 0) / notionals.length;
        const stdDev = Math.sqrt(variance);
        const stats = { mean, stdDev, updatedAt: Date.now() };
        this.tradeStdDevCache.set(whaleId, stats);
        return stats;
    }
    /* ━━━━━━━━━━━━━━ Webhook delivery ━━━━━━━━━━━━━━ */
    async deliverWebhook(type, payload) {
        if (!this.webhookUrl)
            return;
        try {
            await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, payload, ts: new Date().toISOString() }),
            });
        }
        catch (err) {
            logs_1.logger.warn({ err }, 'Webhook delivery failed');
        }
    }
}
exports.WhaleAlerts = WhaleAlerts;
