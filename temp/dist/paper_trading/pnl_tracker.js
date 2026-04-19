"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PnlTracker = void 0;
class PnlTracker {
    recordFill(fill, position, entryPrice) {
        if (fill.side === 'SELL') {
            const realized = (fill.price - entryPrice) * fill.size;
            position.realizedPnl += realized;
            return { realized };
        }
        return { realized: 0 };
    }
    /** Compute unrealized PnL for a position given the current market price */
    static unrealizedPnl(position, currentPrice) {
        if (position.size <= 0 || position.avgPrice === 0)
            return 0;
        return (currentPrice - position.avgPrice) * position.size;
    }
}
exports.PnlTracker = PnlTracker;
