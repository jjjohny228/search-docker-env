"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderRouter = void 0;
const logs_1 = require("../reporting/logs");
const console_log_1 = require("../reporting/console_log");
class OrderRouter {
    constructor(walletManager, riskEngine, tradeExecutor) {
        this.walletManager = walletManager;
        this.riskEngine = riskEngine;
        this.tradeExecutor = tradeExecutor;
    }
    async route(order) {
        const wallet = this.walletManager.getWallet(order.walletId);
        if (!wallet) {
            logs_1.logger.warn({ walletId: order.walletId }, 'Wallet not found');
            console_log_1.consoleLog.warn('ORDER', `Wallet ${order.walletId} not found — order dropped`, {
                walletId: order.walletId,
                marketId: order.marketId,
            });
            return false;
        }
        const state = wallet.getState();
        const risk = this.riskEngine.check(order, state);
        if (!risk.ok) {
            logs_1.logger.warn({ walletId: order.walletId, reason: risk.reason }, 'Risk check failed');
            console_log_1.consoleLog.warn('RISK', `Risk rejected: ${risk.reason} [${order.walletId}] ${order.side} ${order.outcome} ×${order.size}`, {
                walletId: order.walletId,
                marketId: order.marketId,
                reason: risk.reason,
                side: order.side,
                outcome: order.outcome,
                price: order.price,
                size: order.size,
            });
            return false;
        }
        await this.tradeExecutor.execute(order, wallet);
        return true;
    }
}
exports.OrderRouter = OrderRouter;
