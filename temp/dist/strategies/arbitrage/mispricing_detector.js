"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MispricingArbitrageStrategy = void 0;
const strategy_interface_1 = require("../strategy_interface");
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Mispricing Arbitrage Strategy – Enhanced
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   Multi-factor mispricing detector that combines:
   1. Spread analysis – wide bid-ask as a percentage of mid
   2. Volume-weighted fair value estimation (VWAP deviation)
   3. Price-volume divergence – volume surging but price stagnant
   4. Mean-reversion scoring – deviation from rolling average
   5. Order-flow imbalance – bid vs ask side depth proxy
   6. Cross-market validation – compare with related event markets

   Position management:
   • Kelly-inspired sizing with max position constraints
   • Time-based exit (mispricing should correct within 20 min)
   • Profit-taking at 60 bps, stop-loss at 80 bps
   • Trailing stop after 40 bps gain
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const MIN_VOLUME = 1000;
const MIN_LIQUIDITY = 200;
const STALE_MS = 60000;
const MIN_SPREAD_PCT = 0.006; // 0.6% minimum spread to flag
const MAX_CONFIDENCE = 0.90;
const MAX_POSITIONS = 15;
class MispricingArbitrageStrategy extends strategy_interface_1.BaseStrategy {
    constructor() {
        super(...arguments);
        this.name = 'mispricing_arbitrage';
        this.cooldownMs = 45000;
        this.positions = [];
        this.priceSnapshots = new Map();
        this.volumeHistory = new Map();
    }
    /* ── Market update ──────────────────────────────────────────── */
    onMarketUpdate(data) {
        super.onMarketUpdate(data);
        // Track price snapshots
        const snaps = this.priceSnapshots.get(data.marketId) ?? [];
        snaps.push({
            price: data.midPrice,
            volume: data.volume24h,
            timestamp: data.timestamp,
        });
        if (snaps.length > 40)
            snaps.shift();
        this.priceSnapshots.set(data.marketId, snaps);
        // Track volume history
        const vols = this.volumeHistory.get(data.marketId) ?? [];
        vols.push(data.volume24h);
        if (vols.length > 20)
            vols.shift();
        this.volumeHistory.set(data.marketId, vols);
    }
    /* ── Signal generation ──────────────────────────────────────── */
    generateSignals() {
        const signals = [];
        if (this.positions.length >= MAX_POSITIONS)
            return signals;
        const now = Date.now();
        const eventGroups = this.groupByEvent();
        for (const [marketId, market] of this.markets) {
            if (!this.passesFilters(market, now))
                continue;
            const score = this.computeMispricingScore(marketId, market, eventGroups);
            if (score.total < 0.3)
                continue; // Not enough mispricing evidence
            const snaps = this.priceSnapshots.get(marketId) ?? [];
            const vwap = this.computeVWAP(snaps);
            const yesPrice = market.outcomePrices[0];
            // Determine trade direction based on fair value estimate
            let direction;
            let side;
            let edge;
            if (vwap > 0 && Math.abs(yesPrice - vwap) > 0.005) {
                // Price deviates from VWAP: trade toward VWAP
                if (yesPrice < vwap) {
                    direction = 'YES';
                    side = 'BUY';
                    edge = vwap - yesPrice; // full deviation — no halving
                }
                else {
                    direction = 'NO';
                    side = 'BUY';
                    edge = yesPrice - vwap;
                }
            }
            else {
                // Spread-based: buy at bid when spread is wide
                const spreadEdge = market.spread * 0.4; // capture 40% of spread
                if (yesPrice < 0.5) {
                    direction = 'YES';
                    side = 'BUY';
                    edge = spreadEdge;
                }
                else {
                    direction = 'NO';
                    side = 'BUY';
                    edge = spreadEdge;
                }
            }
            // Boost edge with volume-price divergence
            const volDivergence = this.volumePriceDivergence(marketId);
            if (volDivergence > 0.5) {
                edge *= 1 + volDivergence * 0.3;
            }
            const confidence = Math.min(MAX_CONFIDENCE, score.total * 1.2);
            signals.push({
                marketId,
                outcome: direction,
                side,
                confidence,
                edge: Math.min(edge, 0.08),
            });
        }
        // Sort by mispricing score (best first)
        signals.sort((a, b) => b.confidence * b.edge - a.confidence * a.edge);
        return signals.slice(0, MAX_POSITIONS - this.positions.length);
    }
    /* ── Sizing: risk-adjusted with Kelly ───────────────────────── */
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
            // Half-Kelly sizing
            const winProb = 0.5 + signal.edge;
            const kellyFrac = Math.max(0, (winProb * 2 - 1) / 1) / 2;
            const maxFromCapital = capital * Math.min(kellyFrac, 0.05);
            const maxFromLiquidity = liquidity * 0.008;
            const size = Math.max(1, Math.floor(Math.min(maxFromCapital, maxFromLiquidity, 50)));
            // Use actual bid/ask for realistic pricing
            let price;
            if (signal.side === 'BUY') {
                // Buy at the bid (limit order) — realistic execution
                price = market?.bid ?? (market?.outcomePrices[0] ?? 0.5) * 0.98;
            }
            else {
                // Sell at the ask
                price = market?.ask ?? (market?.outcomePrices[0] ?? 0.5) * 1.02;
            }
            price = Number(Math.max(0.01, Math.min(0.99, price)).toFixed(4));
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
            mispricingScore: 0,
            peakBps: 0,
        });
    }
    /** Legacy — position tracking now handled by notifyFill */
    submitOrders(_orders) {
        return;
    }
    /* ── Manage positions ───────────────────────────────────────── */
    managePositions() {
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
            // 1. Take profit at 100 bps
            if (edgeBps >= 100) {
                exitReason = 'TAKE_PROFIT';
            }
            // 2. Stop-loss at 60 bps adverse
            if (!exitReason && edgeBps <= -60) {
                exitReason = 'STOP_LOSS';
            }
            // 3. Trailing stop: was up 50+ bps, dropped 25 from peak
            if (!exitReason && pos.peakBps > 50 && edgeBps < pos.peakBps - 25) {
                exitReason = 'TRAILING_STOP';
            }
            // 4. Time exit: mispricings should correct within 15 min
            if (!exitReason && holdingMin > 15) {
                exitReason = 'TIME_EXIT';
            }
            // 5. Spread normalized: no longer mispriced
            if (!exitReason && market.spread < 0.003 && holdingMin > 2) {
                exitReason = 'SPREAD_NORMAL';
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
    /* ── Multi-factor mispricing score ──────────────────────────── */
    computeMispricingScore(marketId, market, eventGroups) {
        // Factor 1: Spread width (wider = more mispriced)
        const spreadPct = market.spread / Math.max(market.midPrice, 0.01);
        const spreadScore = Math.min(1, (spreadPct - MIN_SPREAD_PCT) / 0.04);
        // Factor 2: VWAP deviation
        const snaps = this.priceSnapshots.get(marketId) ?? [];
        const vwap = this.computeVWAP(snaps);
        const vwapDev = vwap > 0 ? Math.abs(market.midPrice - vwap) / Math.max(vwap, 0.01) : 0;
        const vwapScore = Math.min(1, vwapDev / 0.03);
        // Factor 3: Volume-price divergence
        const volDiv = this.volumePriceDivergence(marketId);
        const volDivScore = Math.min(1, volDiv);
        // Factor 4: Mean reversion potential
        const meanRevScore = this.meanReversionScore(marketId);
        // Factor 5: Cross-market validation
        const crossMktScore = this.crossMarketScore(market, eventGroups);
        const total = spreadScore * 0.25 +
            vwapScore * 0.25 +
            volDivScore * 0.15 +
            meanRevScore * 0.20 +
            crossMktScore * 0.15;
        return { total, spread: spreadScore, vwapDev: vwapScore, volDiv: volDivScore, meanRev: meanRevScore, crossMkt: crossMktScore };
    }
    /* ── Helpers ────────────────────────────────────────────────── */
    computeVWAP(snapshots) {
        if (snapshots.length < 3)
            return 0;
        let sumPriceVol = 0;
        let sumVol = 0;
        for (let i = 1; i < snapshots.length; i++) {
            // Use volume DELTA between snapshots as weight (actual traded volume)
            const volDelta = Math.max(1, snapshots[i].volume - snapshots[i - 1].volume);
            sumPriceVol += snapshots[i].price * volDelta;
            sumVol += volDelta;
        }
        return sumVol > 0 ? sumPriceVol / sumVol : 0;
    }
    volumePriceDivergence(marketId) {
        const snaps = this.priceSnapshots.get(marketId) ?? [];
        if (snaps.length < 5)
            return 0;
        const recent = snaps.slice(-10);
        const priceChange = Math.abs(recent[recent.length - 1].price - recent[0].price);
        const volumeChange = recent.length > 1
            ? Math.abs(recent[recent.length - 1].volume - recent[0].volume) / Math.max(recent[0].volume, 1)
            : 0;
        // High volume change with low price change = divergence
        if (priceChange < 0.005 && volumeChange > 0.1) {
            return Math.min(1, volumeChange * 3);
        }
        return 0;
    }
    meanReversionScore(marketId) {
        const snaps = this.priceSnapshots.get(marketId) ?? [];
        if (snaps.length < 10)
            return 0;
        const prices = snaps.map((s) => s.price);
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        const current = prices[prices.length - 1];
        const deviation = Math.abs(current - avg);
        // Standard deviation
        const variance = prices.reduce((sum, p) => sum + (p - avg) ** 2, 0) / prices.length;
        const stdDev = Math.sqrt(variance);
        if (stdDev === 0)
            return 0;
        // Z-score: how many standard deviations from mean
        const zScore = deviation / stdDev;
        // Mean reversion opportunity if |z| > 1.5
        return Math.min(1, Math.max(0, (zScore - 1) / 2));
    }
    crossMarketScore(market, eventGroups) {
        if (!market.eventId)
            return 0;
        const group = eventGroups.get(market.eventId);
        if (!group || group.length < 2)
            return 0;
        // Compare this market's spread to others in the same event
        const spreads = group.map((m) => m.spread / Math.max(m.midPrice, 0.01));
        const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
        const thisSpread = market.spread / Math.max(market.midPrice, 0.01);
        // If this market has a significantly wider spread than peers, it's mispriced
        if (thisSpread > avgSpread * 1.5) {
            return Math.min(1, (thisSpread - avgSpread) / avgSpread);
        }
        return 0;
    }
    passesFilters(market, now) {
        if (market.volume24h < MIN_VOLUME)
            return false;
        if (market.liquidity < MIN_LIQUIDITY)
            return false;
        if (now - market.timestamp > STALE_MS)
            return false;
        const yesPrice = market.outcomePrices[0] ?? 0.5;
        if (yesPrice < 0.05 || yesPrice > 0.95)
            return false;
        const spreadPct = market.spread / Math.max(market.midPrice, 0.01);
        if (spreadPct < MIN_SPREAD_PCT)
            return false;
        return true;
    }
    groupByEvent() {
        const groups = new Map();
        for (const [, market] of this.markets) {
            const eventId = market.eventId;
            if (!eventId)
                continue;
            const group = groups.get(eventId) ?? [];
            group.push(market);
            groups.set(eventId, group);
        }
        return groups;
    }
}
exports.MispricingArbitrageStrategy = MispricingArbitrageStrategy;
