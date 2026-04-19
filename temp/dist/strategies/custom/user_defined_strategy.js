"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserDefinedStrategy = void 0;
const strategy_interface_1 = require("../strategy_interface");
const DEFAULTS = {
    minVolume: 1000,
    minLiquidity: 200,
    priceFloor: 0.08,
    priceCeiling: 0.92,
    emaShort: 5,
    emaLong: 15,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    maxPositions: 8,
    takeProfitBps: 120,
    stopLossBps: 100,
    trailingActivation: 60,
    trailingDistance: 35,
    maxHoldMinutes: 45,
    positionSizePct: 0.02,
};
class UserDefinedStrategy extends strategy_interface_1.BaseStrategy {
    constructor() {
        super(...arguments);
        this.name = 'user_defined';
        this.cooldownMs = 120000;
        this.params = { ...DEFAULTS };
        this.priceHistory = new Map();
        this.volumeHistory = new Map();
        this.positions = [];
    }
    /* ── Initialization: merge user config over defaults ─────────── */
    initialize(context) {
        super.initialize(context);
        const userCfg = (context.config ?? {});
        this.params = { ...DEFAULTS, ...userCfg };
    }
    /* ── Market update ──────────────────────────────────────────── */
    onMarketUpdate(data) {
        super.onMarketUpdate(data);
        const prices = this.priceHistory.get(data.marketId) ?? [];
        prices.push(data.midPrice);
        if (prices.length > 60)
            prices.shift();
        this.priceHistory.set(data.marketId, prices);
        const vols = this.volumeHistory.get(data.marketId) ?? [];
        vols.push(data.volume24h);
        if (vols.length > 30)
            vols.shift();
        this.volumeHistory.set(data.marketId, vols);
    }
    /* ── Signal generation ──────────────────────────────────────── */
    /*
     * DEFAULT LOGIC: EMA crossover + RSI confirmation + volume trend.
     * Replace or extend this method with your own custom logic.
     */
    generateSignals() {
        const { params } = this;
        const signals = [];
        if (this.positions.length >= params.maxPositions)
            return signals;
        for (const [marketId, market] of this.markets) {
            // ── Filters ────────────────────────────────────────────
            if (market.volume24h < params.minVolume)
                continue;
            if (market.liquidity < params.minLiquidity)
                continue;
            const yesPrice = market.outcomePrices[0] ?? 0.5;
            if (yesPrice < params.priceFloor || yesPrice > params.priceCeiling)
                continue;
            const prices = this.priceHistory.get(marketId) ?? [];
            if (prices.length < params.emaLong + 2)
                continue;
            // ── Indicators ─────────────────────────────────────────
            const emaShort = this.computeEMA(prices, params.emaShort);
            const emaLong = this.computeEMA(prices, params.emaLong);
            if (emaShort.length < 2 || emaLong.length < 2)
                continue;
            const shortCurrent = emaShort[emaShort.length - 1];
            const longCurrent = emaLong[emaLong.length - 1];
            const shortPrev = emaShort[emaShort.length - 2];
            const longPrev = emaLong[emaLong.length - 2];
            const rsi = this.computeRSI(prices, params.rsiPeriod);
            const volumeRising = this.isVolumeRising(marketId);
            // ── EMA crossover: short crosses above long → bullish ──
            const bullishCross = shortPrev <= longPrev && shortCurrent > longCurrent;
            const bearishCross = shortPrev >= longPrev && shortCurrent < longCurrent;
            if (bullishCross && rsi < params.rsiOverbought && volumeRising) {
                const edge = Math.min(0.05, Math.abs(shortCurrent - longCurrent) * 10);
                const confidence = Math.min(0.85, 0.4 + (market.volume24h / 30000) + edge * 3);
                signals.push({
                    marketId,
                    outcome: 'YES',
                    side: 'BUY',
                    confidence,
                    edge,
                });
            }
            if (bearishCross && rsi > params.rsiOversold && volumeRising) {
                const edge = Math.min(0.05, Math.abs(shortCurrent - longCurrent) * 10);
                const confidence = Math.min(0.85, 0.4 + (market.volume24h / 30000) + edge * 3);
                signals.push({
                    marketId,
                    outcome: 'NO',
                    side: 'BUY',
                    confidence,
                    edge,
                });
            }
            // ── RSI extremes (mean-reversion) ──────────────────────
            if (rsi > params.rsiOverbought + 5) {
                const edge = Math.min(0.04, (rsi - params.rsiOverbought) / 500);
                signals.push({
                    marketId,
                    outcome: 'NO',
                    side: 'BUY',
                    confidence: Math.min(0.7, 0.3 + edge * 5),
                    edge,
                });
            }
            else if (rsi < params.rsiOversold - 5) {
                const edge = Math.min(0.04, (params.rsiOversold - rsi) / 500);
                signals.push({
                    marketId,
                    outcome: 'YES',
                    side: 'BUY',
                    confidence: Math.min(0.7, 0.3 + edge * 5),
                    edge,
                });
            }
        }
        signals.sort((a, b) => b.confidence * b.edge - a.confidence * a.edge);
        return signals.slice(0, params.maxPositions - this.positions.length);
    }
    /* ── Sizing ─────────────────────────────────────────────────── */
    sizePositions(signals) {
        const capital = this.context?.wallet.availableBalance ?? 100;
        const walletId = this.context?.wallet.walletId ?? 'unknown';
        const now = Date.now();
        return signals
            .filter((s) => {
            const key = `${s.marketId}:${s.outcome}:${s.side}`;
            const last = this.tradeCooldowns?.get(key) ?? 0;
            return now - last > this.cooldownMs;
        })
            .map((signal) => {
            const market = this.markets.get(signal.marketId);
            const liquidity = market?.liquidity ?? 500;
            const baseSize = capital * this.params.positionSizePct * signal.confidence;
            const maxFromLiquidity = liquidity * 0.003;
            const size = Math.max(1, Math.floor(Math.min(baseSize, maxFromLiquidity, 40)));
            const price = signal.side === 'BUY'
                ? Number(Math.min(0.5 + signal.edge, market?.bid ?? 0.5).toFixed(4))
                : Number(Math.max(0.5 - signal.edge, market?.ask ?? 0.5).toFixed(4));
            return {
                walletId,
                marketId: signal.marketId,
                outcome: signal.outcome,
                side: signal.side,
                price,
                size,
                strategy: this.name,
            };
        });
    }
    /* ── Position tracking via engine callback ──────────────────── */
    notifyFill(order) {
        if (order.strategy !== this.name)
            return;
        this.positions.push({
            marketId: order.marketId,
            outcome: order.outcome,
            side: order.side,
            entryPrice: order.price,
            size: order.size,
            entryTime: Date.now(),
            peakBps: 0,
        });
    }
    /** Legacy — position tracking now handled by notifyFill */
    submitOrders(_orders) {
        return;
    }
    /* ── Manage positions ───────────────────────────────────────── */
    managePositions() {
        const { params } = this;
        const toRemove = [];
        for (let i = 0; i < this.positions.length; i++) {
            const pos = this.positions[i];
            const market = this.markets.get(pos.marketId);
            if (!market)
                continue;
            const currentPrice = pos.outcome === 'YES'
                ? market.outcomePrices[0]
                : market.outcomePrices[1];
            const edgeBps = pos.side === 'BUY'
                ? (currentPrice - pos.entryPrice) * 10000
                : (pos.entryPrice - currentPrice) * 10000;
            pos.peakBps = Math.max(pos.peakBps, edgeBps);
            const holdingMin = (Date.now() - pos.entryTime) / 60000;
            let exitReason;
            // Take profit
            if (edgeBps >= params.takeProfitBps) {
                exitReason = 'TAKE_PROFIT';
            }
            // Stop loss
            if (!exitReason && edgeBps <= -params.stopLossBps) {
                exitReason = 'STOP_LOSS';
            }
            // Trailing stop
            if (!exitReason &&
                pos.peakBps > params.trailingActivation &&
                edgeBps < pos.peakBps - params.trailingDistance) {
                exitReason = 'TRAILING_STOP';
            }
            // Time exit
            if (!exitReason && holdingMin > params.maxHoldMinutes) {
                exitReason = 'TIME_EXIT';
            }
            if (exitReason) {
                toRemove.push(i);
                const exitSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
                this.pendingExits.push({
                    walletId: this.context?.wallet.walletId ?? 'unknown',
                    marketId: pos.marketId,
                    outcome: pos.outcome,
                    side: exitSide,
                    price: currentPrice,
                    size: pos.size,
                    strategy: this.name,
                });
            }
        }
        for (let i = toRemove.length - 1; i >= 0; i--) {
            this.positions.splice(toRemove[i], 1);
        }
    }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       Built-in indicator helpers
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    /** Exponential Moving Average */
    computeEMA(prices, period) {
        if (prices.length < period)
            return [];
        const k = 2 / (period + 1);
        const result = [];
        let sum = 0;
        for (let i = 0; i < period; i++)
            sum += prices[i];
        let prev = sum / period;
        result.push(prev);
        for (let i = period; i < prices.length; i++) {
            const val = prices[i] * k + prev * (1 - k);
            result.push(val);
            prev = val;
        }
        return result;
    }
    /** Relative Strength Index */
    computeRSI(prices, period) {
        if (prices.length < period + 1)
            return 50;
        let gains = 0;
        let losses = 0;
        const start = prices.length - period - 1;
        for (let i = start + 1; i < prices.length; i++) {
            const change = prices[i] - prices[i - 1];
            if (change > 0)
                gains += change;
            else
                losses += Math.abs(change);
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        if (avgLoss === 0)
            return 100;
        const rs = avgGain / avgLoss;
        return 100 - 100 / (1 + rs);
    }
    /** Z-score: how many stdevs the current price is from rolling mean */
    computeZScore(prices, lookback) {
        if (prices.length < lookback)
            return 0;
        const recent = prices.slice(-lookback);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((s, p) => s + (p - mean) ** 2, 0) / recent.length;
        const stdDev = Math.sqrt(variance);
        if (stdDev === 0)
            return 0;
        return (prices[prices.length - 1] - mean) / stdDev;
    }
    /** Check if volume is rising over recent snapshots */
    isVolumeRising(marketId) {
        const vols = this.volumeHistory.get(marketId) ?? [];
        if (vols.length < 3)
            return true; // Assume OK with insufficient data
        const recent = vols.slice(-5);
        let rising = 0;
        for (let i = 1; i < recent.length; i++) {
            if (recent[i] >= recent[i - 1])
                rising++;
        }
        return rising >= (recent.length - 1) * 0.5;
    }
}
exports.UserDefinedStrategy = UserDefinedStrategy;
