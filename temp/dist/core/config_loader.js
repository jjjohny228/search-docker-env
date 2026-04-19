"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
const fs_1 = __importDefault(require("fs"));
const yaml_1 = __importDefault(require("yaml"));
const DEFAULT_LIMITS = {
    maxPositionSize: 100,
    maxExposurePerMarket: 200,
    maxDailyLoss: 100,
    maxOpenTrades: 5,
    maxDrawdown: 0.2,
};
function loadConfig(path) {
    const raw = fs_1.default.readFileSync(path, 'utf8');
    const parsed = yaml_1.default.parse(raw);
    const wallets = (parsed.wallets ?? []).map((wallet) => ({
        id: wallet.id,
        mode: wallet.mode ?? 'PAPER',
        strategy: wallet.strategy,
        capital: wallet.capital ?? 0,
        riskLimits: {
            ...DEFAULT_LIMITS,
            ...toRiskLimits(wallet.risk_limits),
        },
    }));
    const liveRequested = Boolean(parsed.environment?.enable_live_trading ?? false);
    const liveEnvEnabled = process.env.ENABLE_LIVE_TRADING === 'true';
    return {
        environment: {
            enableLiveTrading: liveRequested && liveEnvEnabled,
        },
        wallets,
        strategyConfig: parsed.strategy_config ?? {},
        polymarket: {
            gammaApi: parsed.polymarket?.gamma_api ?? 'https://gamma-api.polymarket.com',
            clobApi: parsed.polymarket?.clob_api ?? 'https://clob.polymarket.com',
        },
    };
}
function toRiskLimits(risk) {
    if (!risk)
        return {};
    return {
        maxPositionSize: risk.max_position_size,
        maxExposurePerMarket: risk.max_exposure_per_market,
        maxDailyLoss: risk.max_daily_loss,
        maxOpenTrades: risk.max_open_trades,
        maxDrawdown: risk.max_drawdown,
    };
}
