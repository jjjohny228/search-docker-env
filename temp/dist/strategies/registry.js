"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STRATEGY_REGISTRY = void 0;
exports.listStrategies = listStrategies;
const cross_market_arbitrage_1 = require("./arbitrage/cross_market_arbitrage");
const mispricing_detector_1 = require("./arbitrage/mispricing_detector");
const ai_forecast_strategy_1 = require("./research_ai/ai_forecast_strategy");
const spread_strategy_1 = require("./market_making/spread_strategy");
const momentum_strategy_1 = require("./trend/momentum_strategy");
const user_defined_strategy_1 = require("./custom/user_defined_strategy");
const filtered_high_prob_convergence_1 = require("./convergence/filtered_high_prob_convergence");
const copy_trade_strategy_1 = require("./copy_trading/copy_trade_strategy");
exports.STRATEGY_REGISTRY = {
    cross_market_arbitrage: cross_market_arbitrage_1.CrossMarketArbitrageStrategy,
    mispricing_arbitrage: mispricing_detector_1.MispricingArbitrageStrategy,
    ai_forecast: ai_forecast_strategy_1.AiForecastStrategy,
    market_making: spread_strategy_1.SpreadStrategy,
    momentum: momentum_strategy_1.MomentumStrategy,
    user_defined: user_defined_strategy_1.UserDefinedStrategy,
    filtered_high_prob_convergence: filtered_high_prob_convergence_1.FilteredHighProbConvergenceStrategy,
    copy_trade: copy_trade_strategy_1.CopyTradeStrategy,
};
function listStrategies() {
    return Object.keys(exports.STRATEGY_REGISTRY);
}
