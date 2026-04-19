"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FillSimulator = void 0;
const slippage_model_1 = require("./slippage_model");
const console_log_1 = require("../reporting/console_log");
class FillSimulator {
    constructor() {
        this.slippage = new slippage_model_1.SlippageModel();
    }
    simulate(request) {
        const adjusted = this.slippage.apply(request.price, request.size, request.side);
        const fill = {
            orderId: `paper-${Date.now()}`,
            marketId: request.marketId,
            outcome: request.outcome,
            side: request.side,
            price: Number(adjusted.toFixed(4)),
            size: request.size,
            timestamp: Date.now(),
        };
        const slippageBps = Math.abs(fill.price - request.price) / request.price * 10000;
        console_log_1.consoleLog.info('FILL', `Paper fill: ${fill.side} ${fill.outcome} ×${fill.size} @ $${fill.price} (slip ${slippageBps.toFixed(1)} bps) — ${fill.orderId}`, {
            orderId: fill.orderId,
            marketId: fill.marketId,
            outcome: fill.outcome,
            side: fill.side,
            requestedPrice: request.price,
            filledPrice: fill.price,
            size: fill.size,
            slippageBps: Number(slippageBps.toFixed(1)),
            cost: Number((fill.price * fill.size).toFixed(4)),
        });
        return fill;
    }
}
exports.FillSimulator = FillSimulator;
