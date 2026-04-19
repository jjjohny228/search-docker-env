"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Engine = void 0;
const scheduler_1 = require("./scheduler");
const orderbook_stream_1 = require("../data/orderbook_stream");
const registry_1 = require("../strategies/registry");
const logs_1 = require("../reporting/logs");
const console_log_1 = require("../reporting/console_log");
class Engine {
    constructor(config, walletManager, orderRouter) {
        this.config = config;
        this.walletManager = walletManager;
        this.orderRouter = orderRouter;
        this.scheduler = new scheduler_1.Scheduler();
        this.runners = [];
        this.pausedWallets = new Set();
        this.tickCount = 0;
        this.marketUpdateCount = 0;
        this.lastScanLog = 0;
        // Pass Gamma API URL from config to the OrderbookStream
        this.stream = new orderbook_stream_1.OrderbookStream(config.polymarket.gammaApi);
    }
    async initialize() {
        for (const wallet of this.config.wallets) {
            const StrategyCtor = registry_1.STRATEGY_REGISTRY[wallet.strategy];
            if (!StrategyCtor) {
                logs_1.logger.warn({ strategy: wallet.strategy }, 'Unknown strategy; skipping');
                console_log_1.consoleLog.warn('ENGINE', `Unknown strategy "${wallet.strategy}" — skipping wallet ${wallet.id}`);
                continue;
            }
            const walletState = this.walletManager.getWallet(wallet.id)?.getState();
            if (!walletState) {
                continue;
            }
            const strategy = new StrategyCtor();
            strategy.initialize({
                wallet: walletState,
                config: this.config.strategyConfig[wallet.strategy] ?? {},
            });
            this.runners.push({
                strategy,
                walletId: wallet.id,
                config: this.config.strategyConfig[wallet.strategy] ?? {},
            });
            console_log_1.consoleLog.info('STRATEGY', `Initialized "${wallet.strategy}" for wallet ${wallet.id}`, {
                walletId: wallet.id,
                strategy: wallet.strategy,
                capital: walletState.capitalAllocated,
                mode: walletState.mode,
            });
        }
        this.stream.on('update', (data) => this.handleMarketUpdate(data));
    }
    start() {
        this.stream.start();
        this.scheduler.start(() => this.tick());
        logs_1.logger.info({ wallets: this.runners.length }, 'Engine started with LIVE Polymarket data');
        console_log_1.consoleLog.success('ENGINE', `Engine started — ${this.runners.length} strategy runners active`, {
            runners: this.runners.length,
            strategies: [...new Set(this.runners.map((r) => r.strategy.name))],
        });
    }
    stop() {
        this.scheduler.stop();
        this.stream.stop();
        logs_1.logger.info('Engine stopped');
        console_log_1.consoleLog.warn('ENGINE', 'Engine stopped');
    }
    /** Expose the stream so the dashboard can query live market data */
    getStream() {
        return this.stream;
    }
    /* ━━━━━━━━━━━━━━ Runtime runner management ━━━━━━━━━━━━━━ */
    /**
     * Add a strategy runner for a wallet that was created at runtime
     * (e.g. via the dashboard).  The runner immediately receives all
     * cached market data so the strategy has context for its first tick.
     */
    addRunner(walletId, strategyKey) {
        // Prevent duplicate runners for the same wallet
        if (this.runners.some((r) => r.walletId === walletId)) {
            logs_1.logger.warn({ walletId }, 'Runner already exists for wallet');
            return false;
        }
        const StrategyCtor = registry_1.STRATEGY_REGISTRY[strategyKey];
        if (!StrategyCtor) {
            logs_1.logger.warn({ walletId, strategy: strategyKey }, 'Unknown strategy; cannot add runner');
            return false;
        }
        const walletState = this.walletManager.getWallet(walletId)?.getState();
        if (!walletState) {
            logs_1.logger.warn({ walletId }, 'Wallet not found in WalletManager');
            return false;
        }
        const strategy = new StrategyCtor();
        const cfg = this.config.strategyConfig[strategyKey] ?? {};
        strategy.initialize({ wallet: walletState, config: cfg });
        this.runners.push({ strategy, walletId, config: cfg });
        // Back-fill cached market data so the strategy can evaluate immediately
        for (const market of this.stream.getAllMarkets()) {
            strategy.onMarketUpdate(market);
        }
        logs_1.logger.info({ walletId, strategy: strategyKey, cachedMarkets: this.stream.getAllMarkets().length }, `Runtime runner added for wallet ${walletId} (${strategyKey})`);
        console_log_1.consoleLog.success('WALLET', `Runtime runner added: ${walletId} → ${strategyKey}`, {
            walletId,
            strategy: strategyKey,
            cachedMarkets: this.stream.getAllMarkets().length,
        });
        return true;
    }
    /**
     * Remove the strategy runner for a wallet (e.g. on wallet deletion).
     */
    removeRunner(walletId) {
        const idx = this.runners.findIndex((r) => r.walletId === walletId);
        if (idx === -1)
            return false;
        const runner = this.runners[idx];
        runner.strategy.shutdown();
        this.runners.splice(idx, 1);
        logs_1.logger.info({ walletId }, `Runtime runner removed for wallet ${walletId}`);
        console_log_1.consoleLog.warn('WALLET', `Runner removed: ${walletId} (${runner.strategy.name})`, {
            walletId,
            strategy: runner.strategy.name,
            remainingRunners: this.runners.length,
        });
        return true;
    }
    /** Number of active strategy runners (for dashboard display). */
    getRunnerCount() {
        return this.runners.length;
    }
    /** Get all strategy instances that match a given strategy name (for runtime config). */
    getStrategiesByName(strategyName) {
        return this.runners
            .filter((r) => r.config === this.config.strategyConfig[strategyName] || r.strategy.name === strategyName)
            .map((r) => r.strategy);
    }
    /* ━━━━━━━━━━━━━━ Pause / Resume ━━━━━━━━━━━━━━ */
    /**
     * Pause a wallet's strategy runner.  The runner stays in the list
     * (and still receives market updates to stay in-sync) but will not
     * generate signals, size positions, or place orders.
     */
    pauseRunner(walletId) {
        if (!this.runners.some((r) => r.walletId === walletId))
            return false;
        this.pausedWallets.add(walletId);
        console_log_1.consoleLog.warn('ENGINE', `Runner paused: ${walletId}`, { walletId });
        return true;
    }
    /**
     * Resume a previously paused wallet runner.
     */
    resumeRunner(walletId) {
        if (!this.pausedWallets.has(walletId))
            return false;
        this.pausedWallets.delete(walletId);
        console_log_1.consoleLog.success('ENGINE', `Runner resumed: ${walletId}`, { walletId });
        return true;
    }
    /** Check whether a specific wallet runner is paused. */
    isRunnerPaused(walletId) {
        return this.pausedWallets.has(walletId);
    }
    /** Return the set of all currently paused wallet IDs. */
    getPausedWallets() {
        return new Set(this.pausedWallets);
    }
    async tick() {
        this.tickCount++;
        // Log a periodic scan summary every 12 ticks (~60 s at 5 s interval)
        if (this.tickCount % 12 === 0) {
            console_log_1.consoleLog.debug('ENGINE', `Tick #${this.tickCount} — ${this.runners.length} runners, ${this.stream.getAllMarkets().length} cached markets, ${this.marketUpdateCount} updates since last summary`);
            this.marketUpdateCount = 0;
        }
        for (const runner of this.runners) {
            if (this.pausedWallets.has(runner.walletId))
                continue; // skip paused
            runner.strategy.onTimer();
            await this.processSignals(runner);
        }
    }
    handleMarketUpdate(data) {
        this.marketUpdateCount++;
        // Throttle per-market update logs to at most once every 30 s
        const now = Date.now();
        if (now - this.lastScanLog > 30000) {
            console_log_1.consoleLog.debug('SCAN', `Market update: ${data.marketId?.slice(0, 12)}… — ${data.outcomes?.length ?? 0} outcomes`, {
                marketId: data.marketId,
                question: data.question?.slice(0, 80),
            });
            this.lastScanLog = now;
        }
        for (const runner of this.runners) {
            runner.strategy.onMarketUpdate(data);
        }
    }
    async processSignals(runner) {
        const signals = await runner.strategy.generateSignals();
        if (signals.length > 0) {
            console_log_1.consoleLog.info('SIGNAL', `[${runner.strategy.name}] Generated ${signals.length} signal(s) for wallet ${runner.walletId}`, {
                walletId: runner.walletId,
                strategy: runner.strategy.name,
                signals: signals.map((s) => ({
                    market: s.marketId.slice(0, 12) + '…',
                    outcome: s.outcome,
                    side: s.side,
                    confidence: Number((s.confidence ?? 0).toFixed(3)),
                    edge: Number((s.edge ?? 0).toFixed(4)),
                })),
            });
        }
        const orders = await runner.strategy.sizePositions(signals);
        if (orders.length > 0) {
            console_log_1.consoleLog.info('ORDER', `[${runner.strategy.name}] Sized ${orders.length} order(s) for wallet ${runner.walletId}`, {
                walletId: runner.walletId,
                strategy: runner.strategy.name,
                orders: orders.map((o) => ({
                    market: o.marketId.slice(0, 12) + '…',
                    outcome: o.outcome,
                    side: o.side,
                    price: o.price,
                    size: o.size,
                })),
            });
        }
        for (const order of orders) {
            try {
                const executed = await this.orderRouter.route(order);
                if (executed) {
                    runner.strategy.notifyFill(order);
                    console_log_1.consoleLog.success('FILL', `[${runner.strategy.name}] Executed ${order.side} ${order.outcome} ×${order.size} @ $${order.price.toFixed(4)}`, {
                        walletId: order.walletId,
                        strategy: order.strategy,
                        marketId: order.marketId,
                        outcome: order.outcome,
                        side: order.side,
                        price: order.price,
                        size: order.size,
                        cost: Number((order.price * order.size).toFixed(4)),
                    });
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console_log_1.consoleLog.error('ORDER', `[${runner.strategy.name}] Order failed: ${msg}`, {
                    walletId: order.walletId,
                    marketId: order.marketId,
                    error: msg,
                });
            }
        }
        await runner.strategy.managePositions();
        /* ── Route exit orders produced by managePositions() ── */
        const exitOrders = runner.strategy.drainExitOrders();
        if (exitOrders.length > 0) {
            console_log_1.consoleLog.info('ORDER', `[${runner.strategy.name}] ${exitOrders.length} exit order(s) for wallet ${runner.walletId}`, {
                walletId: runner.walletId,
                strategy: runner.strategy.name,
                exits: exitOrders.map((o) => ({
                    market: o.marketId.slice(0, 12) + '…',
                    outcome: o.outcome,
                    side: o.side,
                    price: o.price,
                    size: o.size,
                })),
            });
        }
        for (const exitOrder of exitOrders) {
            try {
                const executed = await this.orderRouter.route(exitOrder);
                if (executed) {
                    console_log_1.consoleLog.success('FILL', `[${runner.strategy.name}] Exited ${exitOrder.outcome} ×${exitOrder.size} @ $${exitOrder.price.toFixed(4)}`, {
                        walletId: exitOrder.walletId,
                        strategy: exitOrder.strategy,
                        marketId: exitOrder.marketId,
                        outcome: exitOrder.outcome,
                        side: exitOrder.side,
                        price: exitOrder.price,
                        size: exitOrder.size,
                    });
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console_log_1.consoleLog.error('ORDER', `[${runner.strategy.name}] Exit order failed: ${msg}`, {
                    walletId: exitOrder.walletId,
                    marketId: exitOrder.marketId,
                    error: msg,
                });
            }
        }
    }
}
exports.Engine = Engine;
