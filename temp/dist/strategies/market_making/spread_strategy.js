"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpreadStrategy = void 0;
const strategy_interface_1 = require("../strategy_interface");
const logs_1 = require("../../reporting/logs");
class SpreadStrategy extends strategy_interface_1.BaseStrategy {
    constructor() {
        super(...arguments);
        this.name = 'market_making';
        /* ── Inventory per market ── */
        this.inventory = new Map();
        /* ── Price history for volatility calc ── */
        this.priceHistory = new Map();
        /* ── Configuration ── */
        this.minVolume = 1500;
        this.minLiquidity = 300;
        this.minSpread = 0.004; // 40 bps minimum spread to be profitable
        this.maxInventoryPerMarket = 60; // max shares per side per market
        this.maxTotalMarkets = 12; // max number of markets to quote
        this.inventorySkewFactor = 0.3; // how much to skew quotes with inventory
        this.volSpreadMultiplier = 2.0; // widen spread with volatility
        this.cooldownMs = 30000; // 30s cooldown — market makers need to refresh frequently
    }
    initialize(context) {
        super.initialize(context);
        const cfg = context.config;
        if (cfg.minVolume)
            this.minVolume = cfg.minVolume;
        if (cfg.minLiquidity)
            this.minLiquidity = cfg.minLiquidity;
        if (cfg.maxInventoryPerMarket)
            this.maxInventoryPerMarket = cfg.maxInventoryPerMarket;
        if (cfg.maxTotalMarkets)
            this.maxTotalMarkets = cfg.maxTotalMarkets;
        logs_1.logger.info({ strategy: this.name }, 'Market making strategy initialised');
    }
    onMarketUpdate(data) {
        super.onMarketUpdate(data);
        const hist = this.priceHistory.get(data.marketId) ?? [];
        hist.push({ price: data.midPrice, timestamp: data.timestamp });
        if (hist.length > 120)
            hist.shift(); // ~30 min of data
        this.priceHistory.set(data.marketId, hist);
    }
    generateSignals() {
        const signals = [];
        let quotedMarkets = 0;
        /* Sort markets by spread (widest first = most profitable) */
        const sorted = [...this.markets.entries()]
            .filter(([, m]) => m.volume24h >= this.minVolume && m.liquidity >= this.minLiquidity)
            .sort(([, a], [, b]) => (b.ask - b.bid) - (a.ask - a.bid));
        for (const [, market] of sorted) {
            if (quotedMarkets >= this.maxTotalMarkets)
                break;
            const spread = market.ask - market.bid;
            if (spread < this.minSpread)
                continue;
            const yesPrice = market.outcomePrices[0];
            if (yesPrice < 0.05 || yesPrice > 0.95)
                continue;
            /* Adverse selection check: skip if recent price moved sharply */
            if (this.hasRecentSpike(market.marketId))
                continue;
            /* Compute dynamic spread based on volatility */
            const vol = this.computeVolatility(market.marketId);
            const dynamicMinSpread = Math.max(this.minSpread, vol * this.volSpreadMultiplier);
            if (spread < dynamicMinSpread)
                continue;
            /* Inventory-adjusted edge */
            const inv = this.inventory.get(market.marketId) ?? { yesShares: 0, noShares: 0, totalCost: 0 };
            const netInventory = inv.yesShares - inv.noShares; // positive = long YES
            const halfSpread = spread / 2;
            // Skew: if we're long YES, make YES-buy less aggressive and YES-sell more aggressive
            const skew = netInventory * this.inventorySkewFactor * 0.001;
            const buyEdge = halfSpread * 0.6 - skew; // reduce buy edge when long
            const sellEdge = halfSpread * 0.6 + skew; // increase sell edge when long
            /* Only quote buy side if not maxed out on inventory */
            if (inv.yesShares < this.maxInventoryPerMarket && buyEdge > 0.001) {
                signals.push({
                    marketId: market.marketId,
                    outcome: 'YES',
                    side: 'BUY',
                    confidence: Math.min(0.6, 0.3 + spread * 5),
                    edge: buyEdge,
                });
            }
            /* Only quote sell side if we actually hold YES shares to sell */
            if (inv.yesShares > 0 && sellEdge > 0.001) {
                signals.push({
                    marketId: market.marketId,
                    outcome: 'YES',
                    side: 'SELL',
                    confidence: Math.min(0.6, 0.3 + spread * 5),
                    edge: sellEdge, // positive edge — override handles pricing
                });
            }
            quotedMarkets++;
        }
        return signals;
    }
    /** Override to use real bid/ask for pricing with inventory skew */
    sizePositions(signals) {
        const orders = super.sizePositions(signals);
        const capital = this.context?.wallet.capitalAllocated ?? 0;
        if (capital <= 0)
            return [];
        return orders.map((order) => {
            const market = this.markets.get(order.marketId);
            if (!market)
                return order;
            const inv = this.inventory.get(order.marketId) ?? { yesShares: 0, noShares: 0, totalCost: 0 };
            const netInventory = inv.yesShares - inv.noShares;
            const skew = netInventory * this.inventorySkewFactor * 0.001;
            const offset = Math.max(0.001, (market.ask - market.bid) * 0.3);
            let price;
            if (order.side === 'BUY') {
                price = market.bid + offset - skew; // bid less when long
            }
            else {
                price = market.ask - offset - skew; // ask less when long (attract sellers)
            }
            price = Number(Math.max(0.01, Math.min(0.99, price)).toFixed(4));
            /* Size: smaller when inventory is building up */
            const inventoryPenalty = Math.max(0.3, 1 - Math.abs(netInventory) / this.maxInventoryPerMarket);
            const baseSize = Math.max(1, Math.floor(capital * 0.01 / price));
            const adjustedSize = Math.max(1, Math.floor(baseSize * inventoryPenalty));
            return { ...order, price, size: adjustedSize };
        });
    }
    /** Track inventory on fill via engine callback */
    notifyFill(order) {
        if (order.strategy !== this.name)
            return;
        const inv = this.inventory.get(order.marketId) ?? { yesShares: 0, noShares: 0, totalCost: 0 };
        if (order.side === 'BUY' && order.outcome === 'YES') {
            inv.yesShares += order.size;
            inv.totalCost += order.price * order.size;
        }
        else if (order.side === 'SELL' && order.outcome === 'YES') {
            const sellSize = Math.min(order.size, inv.yesShares);
            if (sellSize <= 0)
                return;
            inv.yesShares -= sellSize;
            inv.totalCost -= order.price * sellSize;
        }
        else if (order.side === 'BUY' && order.outcome === 'NO') {
            inv.noShares += order.size;
            inv.totalCost += order.price * order.size;
        }
        else {
            const sellSize = Math.min(order.size, inv.noShares);
            if (sellSize <= 0)
                return;
            inv.noShares -= sellSize;
            inv.totalCost -= order.price * sellSize;
        }
        this.inventory.set(order.marketId, inv);
    }
    /** Legacy — inventory tracking now handled by notifyFill */
    submitOrders(_orders) {
        return;
    }
    /** Manage: liquidate inventory when spread collapses, market near resolution, or inventory too large */
    managePositions() {
        const walletId = this.context?.wallet.walletId ?? 'unknown';
        for (const [marketId, inv] of this.inventory.entries()) {
            const market = this.markets.get(marketId);
            if (!market)
                continue;
            const netYes = inv.yesShares; // shares we actually hold
            if (netYes <= 0)
                continue; // nothing to unwind
            const spread = market.ask - market.bid;
            const yesPrice = market.outcomePrices[0];
            const currentAsk = market.ask;
            let exitReason;
            let exitSize = 0;
            // 1. Spread collapsed below profitability → full unwind
            if (spread < this.minSpread * 0.5) {
                exitReason = 'SPREAD_COLLAPSED';
                exitSize = netYes;
            }
            // 2. Market approaching resolution → full flatten
            if (!exitReason && (yesPrice > 0.95 || yesPrice < 0.05)) {
                exitReason = 'NEAR_RESOLUTION';
                exitSize = netYes;
            }
            // 3. Inventory exceeds max → trim to max
            if (!exitReason && netYes > this.maxInventoryPerMarket) {
                exitReason = 'INVENTORY_OVERFLOW';
                exitSize = netYes - this.maxInventoryPerMarket;
            }
            // 4. Unrealized loss: if avg cost > current price by >3%, unwind half
            if (!exitReason && netYes > 0) {
                const avgCost = inv.totalCost / Math.max(netYes, 1);
                if (avgCost > 0 && yesPrice < avgCost * 0.97) {
                    exitReason = 'ADVERSE_MOVE';
                    exitSize = Math.max(1, Math.floor(netYes / 2));
                }
            }
            if (exitReason && exitSize > 0) {
                logs_1.logger.info({ strategy: this.name, marketId, reason: exitReason, size: exitSize, inventory: netYes }, `MM: exiting inventory — ${exitReason}`);
                this.pendingExits.push({
                    walletId,
                    marketId,
                    outcome: 'YES',
                    side: 'SELL',
                    price: Number(Math.max(0.02, currentAsk - 0.002).toFixed(4)), // hit the bid aggressively
                    size: exitSize,
                    strategy: this.name,
                });
                // Update local inventory tracking immediately
                inv.yesShares -= exitSize;
                inv.totalCost -= (inv.totalCost / Math.max(netYes, 1)) * exitSize;
            }
        }
    }
    /* ━━━━━━ Helpers ━━━━━━ */
    computeVolatility(marketId) {
        const hist = this.priceHistory.get(marketId) ?? [];
        if (hist.length < 5)
            return 0.01;
        const prices = hist.map(h => h.price);
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i - 1]) / Math.max(0.001, prices[i - 1]));
        }
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
        return Math.sqrt(variance);
    }
    hasRecentSpike(marketId) {
        const hist = this.priceHistory.get(marketId) ?? [];
        if (hist.length < 5)
            return false;
        const recent = hist.slice(-5);
        const oldest = recent[0].price;
        const newest = recent[recent.length - 1].price;
        const change = Math.abs(newest - oldest) / Math.max(0.001, oldest);
        return change > 0.03; // 3% move in last 5 updates = adverse selection risk
    }
}
exports.SpreadStrategy = SpreadStrategy;
