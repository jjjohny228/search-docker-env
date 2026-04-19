"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlippageModel = void 0;
class SlippageModel {
    /**
     * Apply slippage to a fill price.
     * BUY  → price goes UP   (you pay more)
     * SELL → price goes DOWN  (you receive less)
     */
    apply(price, size, side = 'BUY') {
        const slippage = Math.min(0.01, 0.001 * Math.log10(size + 1));
        return side === 'SELL'
            ? price * (1 - slippage)
            : price * (1 + slippage);
    }
}
exports.SlippageModel = SlippageModel;
