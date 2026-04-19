"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TradeExecutor = void 0;
class TradeExecutor {
    async execute(order, wallet) {
        await wallet.placeOrder({
            marketId: order.marketId,
            outcome: order.outcome,
            side: order.side,
            price: order.price,
            size: order.size,
        });
    }
}
exports.TradeExecutor = TradeExecutor;
