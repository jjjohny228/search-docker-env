"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseStrategy = void 0;
class BaseStrategy {
    constructor() {
        /** Live market cache populated by onMarketUpdate() */
        this.markets = new Map();
        /**
         * Exit orders queued by managePositions() — the engine drains and
         * routes these through the wallet after each tick.
         */
        this.pendingExits = [];
        /**
         * Per-market cooldown: prevents trading the same market more than once
         * within a cooldown window (default 60 seconds).
         */
        this.tradeCooldowns = new Map();
        this.cooldownMs = 60000;
    }
    initialize(context) {
        this.context = context;
    }
    onMarketUpdate(data) {
        this.markets.set(data.marketId, data);
    }
    onTimer() {
        return;
    }
    /** Filter signals through cooldown, then size them */
    sizePositions(signals) {
        const now = Date.now();
        const walletId = this.context?.wallet.walletId ?? 'unknown';
        // Filter out signals for markets still in cooldown
        const filtered = signals.filter((s) => {
            const key = `${s.marketId}:${s.outcome}:${s.side}`;
            const lastTrade = this.tradeCooldowns.get(key) ?? 0;
            return now - lastTrade > this.cooldownMs;
        });
        return filtered.map((signal) => {
            // Record cooldown
            const key = `${signal.marketId}:${signal.outcome}:${signal.side}`;
            this.tradeCooldowns.set(key, now);
            // Use actual market price when available, fall back to 0.5 + edge
            const market = this.markets.get(signal.marketId);
            let price;
            if (market) {
                price = signal.outcome === 'YES'
                    ? market.outcomePrices[0]
                    : (market.outcomePrices[1] ?? 1 - market.outcomePrices[0]);
            }
            else {
                price = Number((0.5 + signal.edge).toFixed(4));
            }
            return {
                walletId,
                marketId: signal.marketId,
                outcome: signal.outcome,
                side: signal.side,
                price: Number(Math.max(0.01, Math.min(0.99, price)).toFixed(4)),
                size: Math.max(1, Math.floor(10 * signal.confidence)),
                strategy: this.name,
            };
        });
    }
    submitOrders(_orders) {
        return;
    }
    /**
     * Called by the engine after a successful fill.
     * Override in subclasses to track positions.
     */
    notifyFill(_order) {
        return;
    }
    managePositions() {
        return;
    }
    /** Return and clear any exit orders queued during managePositions() */
    drainExitOrders() {
        const exits = this.pendingExits;
        this.pendingExits = [];
        return exits;
    }
    shutdown() {
        return;
    }
}
exports.BaseStrategy = BaseStrategy;
