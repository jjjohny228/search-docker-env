"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PolymarketWallet = void 0;
const logs_1 = require("../reporting/logs");
class PolymarketWallet {
    constructor(config, assignedStrategy) {
        this.trades = [];
        this.state = {
            walletId: config.id,
            mode: 'LIVE',
            assignedStrategy,
            capitalAllocated: config.capital,
            availableBalance: config.capital,
            openPositions: [],
            realizedPnl: 0,
            riskLimits: {
                maxPositionSize: config.riskLimits?.maxPositionSize ?? 100,
                maxExposurePerMarket: config.riskLimits?.maxExposurePerMarket ?? 200,
                maxDailyLoss: config.riskLimits?.maxDailyLoss ?? 100,
                maxOpenTrades: config.riskLimits?.maxOpenTrades ?? 5,
                maxDrawdown: config.riskLimits?.maxDrawdown ?? 0.2,
            },
        };
    }
    getState() {
        return { ...this.state, openPositions: [...this.state.openPositions] };
    }
    getTradeHistory() {
        return [...this.trades];
    }
    updateBalance(delta) {
        this.state.availableBalance += delta;
    }
    async placeOrder(request) {
        const apiKey = process.env.POLYMARKET_API_KEY;
        if (!apiKey) {
            logs_1.logger.warn('POLYMARKET_API_KEY not set; refusing LIVE order');
            return;
        }
        logs_1.logger.info({
            walletId: this.state.walletId,
            marketId: request.marketId,
            price: request.price,
            size: request.size,
        }, `LIVE order submitted ${request.side} ${request.outcome} market=${request.marketId} price=${request.price} size=${request.size}`);
    }
}
exports.PolymarketWallet = PolymarketWallet;
