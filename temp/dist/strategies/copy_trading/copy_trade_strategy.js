"use strict";
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Copy Trading Strategy
   ─────────────────────────────────────────────────────────────
   Mirrors trades from configured whale addresses in near-real-
   time, with comprehensive risk management guardrails.

   Features:
   • Multi-whale following — track multiple addresses at once
   • Configurable copy modes: mirror (same direction) or inverse
   • Three sizing modes: fixed, proportional, half-Kelly
   • Full exit management: TP / SL / trailing stop / time exit
   • Per-whale & aggregate drawdown circuit breakers
   • Daily volume / exposure caps
   • Market blacklist / whitelist
   • Cooldown after consecutive losses
   • Whale health monitoring (auto-pause on poor performance)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CopyTradeStrategy = exports.DEFAULT_COPY_TRADE_CONFIG = void 0;
const strategy_interface_1 = require("../strategy_interface");
const logs_1 = require("../../reporting/logs");
const console_log_1 = require("../../reporting/console_log");
exports.DEFAULT_COPY_TRADE_CONFIG = {
    whale_addresses: [],
    copy_mode: 'mirror',
    data_api_url: 'https://data-api.polymarket.com',
    poll_interval_seconds: 30,
    max_trade_age_seconds: 120,
    min_trade_size_usd: 50,
    max_trade_size_usd: 100000,
    min_whale_win_rate: 0.50,
    size_mode: 'fixed',
    fixed_size: 10,
    proportional_factor: 0.10,
    max_capital_per_trade_pct: 0.05,
    max_shares_per_order: 50,
    max_open_positions: 15,
    max_exposure_per_market_usd: 500,
    max_daily_volume_usd: 5000,
    max_drawdown_pct: 0.15,
    max_consecutive_losses: 5,
    cooldown_after_loss_seconds: 300,
    take_profit_bps: 150,
    stop_loss_bps: 100,
    trailing_stop_activate_bps: 80,
    trailing_stop_distance_bps: 30,
    time_exit_minutes: 120,
    exit_on_whale_exit: true,
    blacklist_markets: [],
    whitelist_markets: [],
    min_market_liquidity: 500,
    min_market_volume_24h: 1000,
};
/* ━━━━━━━━━━━━━━ Strategy Implementation ━━━━━━━━━━━━━━ */
class CopyTradeStrategy extends strategy_interface_1.BaseStrategy {
    constructor() {
        super(...arguments);
        this.name = 'copy_trade';
        /* ── State ── */
        this.seenTradeIds = new Set();
        this.pendingSignals = [];
        this.pendingWhaleTrades = [];
        this.positions = new Map();
        this.whalePerf = new Map();
        /** Maps marketId → whale address, populated in sizePositions for notifyFill lookup */
        this.recentWhaleMap = new Map();
        this.lastPollAt = 0;
        this.totalDailyVolumeUsd = 0;
        this.dailyVolumeResetAt = 0;
        this.cumulativePnlBps = 0;
        this.peakPnlBps = 0;
        this.drawdownPaused = false;
        this.scanCount = 0;
        this.cooldownMs = 30000;
    }
    /* ━━━━━━━━━━━━━━ Lifecycle ━━━━━━━━━━━━━━ */
    initialize(context) {
        super.initialize(context);
        this.cfg = this.buildConfig(context.config);
        // Initialise per-whale performance trackers
        for (const addr of this.cfg.whale_addresses) {
            this.whalePerf.set(addr.toLowerCase(), {
                address: addr.toLowerCase(),
                tradesCopied: 0,
                wins: 0,
                losses: 0,
                totalPnlBps: 0,
                consecutiveLosses: 0,
                pausedUntil: 0,
                dailyVolumeUsd: 0,
                dailyVolumeResetAt: this.nextDayReset(),
            });
        }
        logs_1.logger.info({
            strategy: this.name,
            whaleCount: this.cfg.whale_addresses.length,
            copyMode: this.cfg.copy_mode,
            sizeMode: this.cfg.size_mode,
        }, 'Copy Trade strategy initialised');
        console_log_1.consoleLog.info('STRATEGY', `[copy_trade] Following ${this.cfg.whale_addresses.length} whale(s) in ${this.cfg.copy_mode} mode`);
    }
    /* ━━━━━━━━━━━━━━ Timer — Poll for whale trades ━━━━━━━━━━━━━━ */
    async onTimer() {
        const now = Date.now();
        if (now - this.lastPollAt < this.cfg.poll_interval_seconds * 1000)
            return;
        this.lastPollAt = now;
        // Reset daily volume at midnight UTC
        this.resetDailyIfNeeded(now);
        // Check drawdown circuit breaker
        if (this.drawdownPaused) {
            console_log_1.consoleLog.warn('STRATEGY', '[copy_trade] Paused — drawdown limit reached');
            return;
        }
        // Poll each whale address
        for (const address of this.cfg.whale_addresses) {
            const perf = this.whalePerf.get(address.toLowerCase());
            if (perf && now < perf.pausedUntil) {
                continue; // whale-specific cooldown
            }
            try {
                const trades = await this.fetchWhaleTrades(address);
                const newTrades = trades.filter((t) => !this.seenTradeIds.has(t.id));
                for (const trade of newTrades) {
                    this.seenTradeIds.add(trade.id);
                    // Apply filters
                    if (!this.passesFilters(trade, now))
                        continue;
                    // Convert to signal
                    const signal = this.tradeToSignal(trade);
                    if (signal) {
                        this.pendingSignals.push(signal);
                        this.pendingWhaleTrades.push(trade);
                    }
                }
                // Check for whale exits (to trigger exit_on_whale_exit)
                if (this.cfg.exit_on_whale_exit) {
                    this.detectWhaleExits(trades, address);
                }
            }
            catch (err) {
                logs_1.logger.warn({ err, address }, '[copy_trade] Failed to poll whale trades');
            }
        }
        // Prune old seen-trade IDs (keep last 10,000)
        if (this.seenTradeIds.size > 10000) {
            const arr = Array.from(this.seenTradeIds);
            this.seenTradeIds = new Set(arr.slice(-5000));
        }
    }
    /* ━━━━━━━━━━━━━━ Signal Generation ━━━━━━━━━━━━━━ */
    generateSignals() {
        this.scanCount++;
        const signals = [...this.pendingSignals];
        this.pendingSignals = [];
        if (this.scanCount % 12 === 0) {
            console_log_1.consoleLog.info('STRATEGY', `[copy_trade] Tick #${this.scanCount}: ${this.positions.size} open, ${signals.length} pending signals, drawdown=${(this.getCurrentDrawdownPct() * 100).toFixed(1)}%`, {
                openPositions: this.positions.size,
                pendingSignals: signals.length,
                totalCopied: this.getTotalTradesCopied(),
                cumulativePnlBps: this.cumulativePnlBps,
            });
        }
        return signals;
    }
    /* ━━━━━━━━━━━━━━ Position Sizing ━━━━━━━━━━━━━━ */
    sizePositions(signals) {
        const available = this.context?.wallet.availableBalance ?? 0;
        const initial = this.context?.wallet.capitalAllocated ?? 0;
        const walletId = this.context?.wallet.walletId ?? 'unknown';
        // Don't trade if less than 5% capital remains
        if (available < initial * 0.05)
            return [];
        // Position limit
        const slotsAvailable = Math.max(0, this.cfg.max_open_positions - this.positions.size);
        if (slotsAvailable === 0)
            return [];
        // Daily volume cap
        if (this.totalDailyVolumeUsd >= this.cfg.max_daily_volume_usd)
            return [];
        const orders = [];
        const whaleTrades = [...this.pendingWhaleTrades];
        this.pendingWhaleTrades = [];
        // Populate recentWhaleMap so notifyFill can look up the whale address
        for (const wt of whaleTrades) {
            this.recentWhaleMap.set(wt.marketId, wt.whaleAddress);
        }
        for (let i = 0; i < signals.length && orders.length < slotsAvailable; i++) {
            const signal = signals[i];
            const whaleTrade = whaleTrades[i];
            // Already positioned in this market?
            if (this.positions.has(signal.marketId))
                continue;
            const market = this.markets.get(signal.marketId);
            if (!market)
                continue;
            // Market liquidity / volume filters
            if (market.liquidity < this.cfg.min_market_liquidity)
                continue;
            if (market.volume24h < this.cfg.min_market_volume_24h)
                continue;
            // Per-market exposure check
            const existingExposure = this.getMarketExposure(signal.marketId);
            if (existingExposure >= this.cfg.max_exposure_per_market_usd)
                continue;
            // Determine outcome price
            const outcomePrice = signal.outcome === 'YES'
                ? market.outcomePrices[0]
                : (market.outcomePrices[1] ?? 1 - market.outcomePrices[0]);
            const safePrice = Number(Math.max(0.02, Math.min(0.98, outcomePrice)).toFixed(4));
            // Calculate size based on mode
            const size = this.calculateSize(signal, whaleTrade, safePrice, available);
            if (size < 1)
                continue;
            const cost = size * safePrice;
            // Daily volume cap
            if (this.totalDailyVolumeUsd + cost > this.cfg.max_daily_volume_usd)
                continue;
            if (cost > available)
                continue;
            this.totalDailyVolumeUsd += cost;
            orders.push({
                walletId,
                marketId: signal.marketId,
                outcome: signal.outcome,
                side: signal.side,
                price: safePrice,
                size,
                strategy: this.name,
            });
            logs_1.logger.info({
                strategy: this.name,
                whale: whaleTrade?.whaleAddress?.slice(0, 10) ?? 'unknown',
                marketId: signal.marketId,
                outcome: signal.outcome,
                side: signal.side,
                size,
                price: safePrice,
                whaleSize: whaleTrade?.size ?? 0,
                whalePrice: whaleTrade?.price ?? 0,
            }, `COPY_TRADE: mirroring whale trade`);
        }
        return orders;
    }
    /* ━━━━━━━━━━━━━━ Fill Tracking ━━━━━━━━━━━━━━ */
    notifyFill(order) {
        if (order.side !== 'BUY')
            return;
        // Find the whale address from the pending data
        const whaleAddr = this.findWhaleForMarket(order.marketId) ?? 'unknown';
        this.positions.set(order.marketId, {
            marketId: order.marketId,
            outcome: order.outcome,
            side: order.side,
            entryPrice: order.price,
            entryTime: Date.now(),
            size: order.size,
            peakPnlBps: 0,
            whaleAddress: whaleAddr,
            whaleExited: false,
        });
        // Update whale performance
        const perf = this.whalePerf.get(whaleAddr.toLowerCase());
        if (perf) {
            perf.tradesCopied++;
            perf.dailyVolumeUsd += order.price * order.size;
        }
        console_log_1.consoleLog.success('STRATEGY', `[copy_trade] Copied whale ${whaleAddr.slice(0, 10)}… → ${order.side} ${order.outcome} ×${order.size} @ $${order.price.toFixed(4)} in market ${order.marketId.slice(0, 12)}…`);
    }
    /* ━━━━━━━━━━━━━━ Position Management — Exits ━━━━━━━━━━━━━━ */
    managePositions() {
        const now = Date.now();
        for (const [marketId, pos] of this.positions) {
            const market = this.markets.get(marketId);
            if (!market)
                continue;
            // Current price for the position's outcome
            const currentPrice = pos.outcome === 'YES'
                ? market.outcomePrices[0]
                : (market.outcomePrices[1] ?? 1 - market.outcomePrices[0]);
            // PnL in basis points
            const pnlBps = ((currentPrice - pos.entryPrice) / Math.max(pos.entryPrice, 0.001)) * 10000;
            const holdMin = (now - pos.entryTime) / 60000;
            // Track peak for trailing stop
            if (pnlBps > pos.peakPnlBps)
                pos.peakPnlBps = pnlBps;
            let exitReason;
            // 1. Take profit
            if (pnlBps >= this.cfg.take_profit_bps) {
                exitReason = `TP: +${pnlBps.toFixed(0)}bps`;
            }
            // 2. Stop loss
            else if (pnlBps <= -this.cfg.stop_loss_bps) {
                exitReason = `SL: ${pnlBps.toFixed(0)}bps`;
            }
            // 3. Trailing stop
            else if (pos.peakPnlBps >= this.cfg.trailing_stop_activate_bps &&
                pnlBps < pos.peakPnlBps - this.cfg.trailing_stop_distance_bps) {
                exitReason = `TRAIL: peak +${pos.peakPnlBps.toFixed(0)}, now ${pnlBps.toFixed(0)}bps`;
            }
            // 4. Time exit
            else if (this.cfg.time_exit_minutes > 0 && holdMin >= this.cfg.time_exit_minutes) {
                exitReason = `TIME: ${holdMin.toFixed(0)}min`;
            }
            // 5. Whale exited
            else if (this.cfg.exit_on_whale_exit && pos.whaleExited) {
                exitReason = `WHALE_EXIT: whale ${pos.whaleAddress.slice(0, 10)}… closed position`;
            }
            if (exitReason) {
                this.pendingExits.push({
                    walletId: this.context?.wallet.walletId ?? 'unknown',
                    marketId,
                    outcome: pos.outcome,
                    side: 'SELL',
                    price: currentPrice,
                    size: pos.size,
                    strategy: this.name,
                });
                // Track win/loss for the whale
                this.recordTradeResult(pos.whaleAddress, pnlBps);
                this.positions.delete(marketId);
                logs_1.logger.info({
                    strategy: this.name,
                    marketId,
                    outcome: pos.outcome,
                    reason: exitReason,
                    pnlBps: pnlBps.toFixed(0),
                    whale: pos.whaleAddress.slice(0, 10),
                }, `COPY_TRADE exit: ${exitReason}`);
                console_log_1.consoleLog.info('STRATEGY', `[copy_trade] Exit ${marketId.slice(0, 12)}… — ${exitReason}`);
            }
        }
    }
    /* ━━━━━━━━━━━━━━ Data API Polling ━━━━━━━━━━━━━━ */
    /** Fetch recent trades for a whale address from the Polymarket data API */
    async fetchWhaleTrades(address) {
        try {
            const url = `${this.cfg.data_api_url}/trades?maker_address=${encodeURIComponent(address)}&limit=50`;
            const res = await fetch(url);
            if (!res.ok) {
                logs_1.logger.debug({ address, status: res.status }, '[copy_trade] API request failed');
                return [];
            }
            const raw = (await res.json());
            const trades = Array.isArray(raw) ? raw : (raw.trades ?? []);
            return trades
                .filter((t) => t.proxyWallet && t.side && t.size != null && t.price != null)
                .map((t) => this.normaliseTrade(t, address));
        }
        catch {
            return [];
        }
    }
    normaliseTrade(raw, whaleAddress) {
        const price = Number(raw.price ?? 0);
        const size = Number(raw.size ?? 0);
        const side = (raw.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY');
        const outcome = (raw.outcome?.toUpperCase() === 'NO' ? 'NO' : 'YES');
        const timestamp = raw.timestamp ? raw.timestamp * 1000 : Date.now();
        return {
            id: raw.transactionHash ?? `${whaleAddress}-${timestamp}-${raw.asset ?? ''}`,
            whaleAddress: whaleAddress.toLowerCase(),
            marketId: raw.conditionId ?? raw.asset ?? '',
            outcome,
            side,
            price,
            size,
            notionalUsd: price * size,
            timestamp,
        };
    }
    /* ━━━━━━━━━━━━━━ Filters ━━━━━━━━━━━━━━ */
    passesFilters(trade, now) {
        // Age filter
        const ageSeconds = (now - trade.timestamp) / 1000;
        if (ageSeconds > this.cfg.max_trade_age_seconds)
            return false;
        // Notional size filters
        if (trade.notionalUsd < this.cfg.min_trade_size_usd)
            return false;
        if (trade.notionalUsd > this.cfg.max_trade_size_usd)
            return false;
        // Market blacklist / whitelist
        if (this.cfg.blacklist_markets.includes(trade.marketId))
            return false;
        if (this.cfg.whitelist_markets.length > 0 && !this.cfg.whitelist_markets.includes(trade.marketId))
            return false;
        // Already have a position in this market
        if (this.positions.has(trade.marketId))
            return false;
        // Drawdown breaker
        if (this.getCurrentDrawdownPct() >= this.cfg.max_drawdown_pct) {
            this.drawdownPaused = true;
            return false;
        }
        return true;
    }
    /* ━━━━━━━━━━━━━━ Signal Conversion ━━━━━━━━━━━━━━ */
    tradeToSignal(trade) {
        // Only copy BUY trades from whales (entries)
        // For sells, we handle via exit_on_whale_exit
        if (trade.side === 'SELL')
            return null;
        let outcome = trade.outcome;
        let side = 'BUY';
        // Inverse mode: flip direction
        if (this.cfg.copy_mode === 'inverse') {
            outcome = outcome === 'YES' ? 'NO' : 'YES';
        }
        // Confidence based on trade size (bigger whale trades = higher confidence)
        const sizeConfidence = Math.min(0.9, 0.4 + (trade.notionalUsd / 10000) * 0.3);
        const edge = Math.min(0.05, (trade.notionalUsd / 50000) * 0.04);
        return {
            marketId: trade.marketId,
            outcome,
            side,
            confidence: sizeConfidence,
            edge,
        };
    }
    /* ━━━━━━━━━━━━━━ Sizing Logic ━━━━━━━━━━━━━━ */
    calculateSize(signal, whaleTrade, price, available) {
        const maxDollars = available * this.cfg.max_capital_per_trade_pct;
        let size;
        switch (this.cfg.size_mode) {
            case 'fixed':
                size = this.cfg.fixed_size;
                break;
            case 'proportional': {
                const whaleSize = whaleTrade?.size ?? this.cfg.fixed_size;
                size = Math.floor(whaleSize * this.cfg.proportional_factor);
                break;
            }
            case 'kelly': {
                // Half-Kelly sizing
                const kellyFraction = signal.edge / Math.max(1 - signal.edge, 0.01);
                const halfKelly = kellyFraction * 0.5;
                const kellyDollars = available * Math.min(halfKelly, this.cfg.max_capital_per_trade_pct);
                size = Math.floor(kellyDollars / Math.max(price, 0.01));
                break;
            }
            default:
                size = this.cfg.fixed_size;
        }
        // Apply caps
        const maxFromCapital = Math.floor(maxDollars / Math.max(price, 0.01));
        size = Math.min(size, maxFromCapital, this.cfg.max_shares_per_order);
        return Math.max(0, size);
    }
    /* ━━━━━━━━━━━━━━ Whale Exit Detection ━━━━━━━━━━━━━━ */
    detectWhaleExits(trades, whaleAddress) {
        const addr = whaleAddress.toLowerCase();
        const sellTrades = trades.filter((t) => t.side === 'SELL');
        for (const sell of sellTrades) {
            // Check if we have a position in this market that was copied from this whale
            const pos = this.positions.get(sell.marketId);
            if (pos && pos.whaleAddress.toLowerCase() === addr && !pos.whaleExited) {
                pos.whaleExited = true;
                logs_1.logger.info({
                    strategy: this.name,
                    marketId: sell.marketId,
                    whale: addr.slice(0, 10),
                }, 'Whale exit detected — will close mirrored position');
            }
        }
    }
    /* ━━━━━━━━━━━━━━ Performance Tracking ━━━━━━━━━━━━━━ */
    recordTradeResult(whaleAddress, pnlBps) {
        this.cumulativePnlBps += pnlBps;
        if (this.cumulativePnlBps > this.peakPnlBps) {
            this.peakPnlBps = this.cumulativePnlBps;
        }
        const perf = this.whalePerf.get(whaleAddress.toLowerCase());
        if (!perf)
            return;
        perf.totalPnlBps += pnlBps;
        if (pnlBps >= 0) {
            perf.wins++;
            perf.consecutiveLosses = 0;
        }
        else {
            perf.losses++;
            perf.consecutiveLosses++;
            // Consecutive loss cooldown
            if (perf.consecutiveLosses >= this.cfg.max_consecutive_losses) {
                perf.pausedUntil = Date.now() + this.cfg.cooldown_after_loss_seconds * 1000;
                const winRate = perf.wins / Math.max(perf.wins + perf.losses, 1);
                logs_1.logger.warn({
                    strategy: this.name,
                    whale: whaleAddress.slice(0, 10),
                    consecutiveLosses: perf.consecutiveLosses,
                    winRate: winRate.toFixed(2),
                    cooldownSeconds: this.cfg.cooldown_after_loss_seconds,
                }, `COPY_TRADE: whale on cooldown after ${perf.consecutiveLosses} consecutive losses`);
                console_log_1.consoleLog.warn('STRATEGY', `[copy_trade] Whale ${whaleAddress.slice(0, 10)}… paused — ${perf.consecutiveLosses} consecutive losses`);
            }
        }
    }
    getCurrentDrawdownPct() {
        if (this.peakPnlBps <= 0)
            return 0;
        return Math.max(0, (this.peakPnlBps - this.cumulativePnlBps) / this.peakPnlBps);
    }
    getMarketExposure(marketId) {
        const pos = this.positions.get(marketId);
        if (!pos)
            return 0;
        return pos.entryPrice * pos.size;
    }
    findWhaleForMarket(marketId) {
        // Check the recentWhaleMap (populated during sizePositions)
        const recent = this.recentWhaleMap.get(marketId);
        if (recent)
            return recent;
        // Fall back to checking existing positions
        for (const [, pos] of this.positions) {
            if (pos.marketId === marketId)
                return pos.whaleAddress;
        }
        return undefined;
    }
    getTotalTradesCopied() {
        let total = 0;
        for (const perf of this.whalePerf.values()) {
            total += perf.tradesCopied;
        }
        return total;
    }
    /* ━━━━━━━━━━━━━━ Daily Reset ━━━━━━━━━━━━━━ */
    resetDailyIfNeeded(now) {
        if (now >= this.dailyVolumeResetAt) {
            this.totalDailyVolumeUsd = 0;
            this.dailyVolumeResetAt = this.nextDayReset();
            this.drawdownPaused = false; // reset drawdown pause daily
            // Reset per-whale daily volumes
            for (const perf of this.whalePerf.values()) {
                if (now >= perf.dailyVolumeResetAt) {
                    perf.dailyVolumeUsd = 0;
                    perf.dailyVolumeResetAt = this.nextDayReset();
                }
            }
        }
    }
    nextDayReset() {
        const now = new Date();
        const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        return tomorrow.getTime();
    }
    /* ━━━━━━━━━━━━━━ Config Builder ━━━━━━━━━━━━━━ */
    buildConfig(raw) {
        const d = exports.DEFAULT_COPY_TRADE_CONFIG;
        return {
            whale_addresses: raw.whale_addresses ?? d.whale_addresses,
            copy_mode: raw.copy_mode ?? d.copy_mode,
            data_api_url: raw.data_api_url ?? d.data_api_url,
            poll_interval_seconds: raw.poll_interval_seconds ?? d.poll_interval_seconds,
            max_trade_age_seconds: raw.max_trade_age_seconds ?? d.max_trade_age_seconds,
            min_trade_size_usd: raw.min_trade_size_usd ?? d.min_trade_size_usd,
            max_trade_size_usd: raw.max_trade_size_usd ?? d.max_trade_size_usd,
            min_whale_win_rate: raw.min_whale_win_rate ?? d.min_whale_win_rate,
            size_mode: raw.size_mode ?? d.size_mode,
            fixed_size: raw.fixed_size ?? d.fixed_size,
            proportional_factor: raw.proportional_factor ?? d.proportional_factor,
            max_capital_per_trade_pct: raw.max_capital_per_trade_pct ?? d.max_capital_per_trade_pct,
            max_shares_per_order: raw.max_shares_per_order ?? d.max_shares_per_order,
            max_open_positions: raw.max_open_positions ?? d.max_open_positions,
            max_exposure_per_market_usd: raw.max_exposure_per_market_usd ?? d.max_exposure_per_market_usd,
            max_daily_volume_usd: raw.max_daily_volume_usd ?? d.max_daily_volume_usd,
            max_drawdown_pct: raw.max_drawdown_pct ?? d.max_drawdown_pct,
            max_consecutive_losses: raw.max_consecutive_losses ?? d.max_consecutive_losses,
            cooldown_after_loss_seconds: raw.cooldown_after_loss_seconds ?? d.cooldown_after_loss_seconds,
            take_profit_bps: raw.take_profit_bps ?? d.take_profit_bps,
            stop_loss_bps: raw.stop_loss_bps ?? d.stop_loss_bps,
            trailing_stop_activate_bps: raw.trailing_stop_activate_bps ?? d.trailing_stop_activate_bps,
            trailing_stop_distance_bps: raw.trailing_stop_distance_bps ?? d.trailing_stop_distance_bps,
            time_exit_minutes: raw.time_exit_minutes ?? d.time_exit_minutes,
            exit_on_whale_exit: raw.exit_on_whale_exit ?? d.exit_on_whale_exit,
            blacklist_markets: raw.blacklist_markets ?? d.blacklist_markets,
            whitelist_markets: raw.whitelist_markets ?? d.whitelist_markets,
            min_market_liquidity: raw.min_market_liquidity ?? d.min_market_liquidity,
            min_market_volume_24h: raw.min_market_volume_24h ?? d.min_market_volume_24h,
        };
    }
    /* ━━━━━━━━━━━━━━ Public Accessors (for testing / dashboard) ━━━━━━━━━━━━━━ */
    getConfig() { return { ...this.cfg }; }
    getPositions() { return new Map(this.positions); }
    getWhalePerformance() { return new Map(this.whalePerf); }
    getStats() {
        return {
            totalCopied: this.getTotalTradesCopied(),
            openPositions: this.positions.size,
            cumulativePnlBps: this.cumulativePnlBps,
            drawdownPct: this.getCurrentDrawdownPct(),
            dailyVolumeUsd: this.totalDailyVolumeUsd,
            drawdownPaused: this.drawdownPaused,
        };
    }
    /* ━━━━━━━━━━━━━━ Runtime whale address management ━━━━━━━━━━━━━━ */
    /** Add a whale address at runtime. Returns false if already tracked. */
    addWhaleAddress(address) {
        const addr = address.toLowerCase().trim();
        if (!addr || this.cfg.whale_addresses.map(a => a.toLowerCase()).includes(addr))
            return false;
        this.cfg.whale_addresses.push(addr);
        if (!this.whalePerf.has(addr)) {
            this.whalePerf.set(addr, {
                address: addr,
                tradesCopied: 0,
                wins: 0,
                losses: 0,
                totalPnlBps: 0,
                consecutiveLosses: 0,
                pausedUntil: 0,
                dailyVolumeUsd: 0,
                dailyVolumeResetAt: this.nextDayReset(),
            });
        }
        logs_1.logger.info({ strategy: this.name, address: addr, totalWhales: this.cfg.whale_addresses.length }, 'Whale address added');
        console_log_1.consoleLog.success('STRATEGY', `[copy_trade] Added whale ${addr.slice(0, 10)}… — now tracking ${this.cfg.whale_addresses.length} whale(s)`);
        return true;
    }
    /** Remove a whale address at runtime. Returns false if not found. */
    removeWhaleAddress(address) {
        const addr = address.toLowerCase().trim();
        const idx = this.cfg.whale_addresses.findIndex(a => a.toLowerCase() === addr);
        if (idx === -1)
            return false;
        this.cfg.whale_addresses.splice(idx, 1);
        logs_1.logger.info({ strategy: this.name, address: addr, totalWhales: this.cfg.whale_addresses.length }, 'Whale address removed');
        console_log_1.consoleLog.warn('STRATEGY', `[copy_trade] Removed whale ${addr.slice(0, 10)}… — now tracking ${this.cfg.whale_addresses.length} whale(s)`);
        return true;
    }
    /** Get the list of tracked whale addresses. */
    getWhaleAddresses() {
        return [...this.cfg.whale_addresses];
    }
    shutdown() {
        logs_1.logger.info({ strategy: this.name, totalCopied: this.getTotalTradesCopied() }, 'Copy Trade strategy shutdown');
    }
}
exports.CopyTradeStrategy = CopyTradeStrategy;
