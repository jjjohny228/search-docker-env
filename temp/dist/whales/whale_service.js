"use strict";
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — Service Orchestrator
   Initialises all whale sub-systems, manages lifecycle,
   exposes a unified API for the dashboard and CLI.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhaleService = void 0;
const logs_1 = require("../reporting/logs");
const whale_db_1 = require("./whale_db");
const whale_ingestion_1 = require("./whale_ingestion");
const whale_analytics_1 = require("./whale_analytics");
const whale_alerts_1 = require("./whale_alerts");
const whale_candidates_1 = require("./whale_candidates");
const shadow_portfolio_1 = require("./shadow_portfolio");
const whale_reconciliation_1 = require("./whale_reconciliation");
const whale_scanner_1 = require("./whale_scanner");
class WhaleService {
    constructor(config, clobApi, gammaApi) {
        this.analyticsTimer = null;
        this.running = false;
        this.config = config;
        this.clobApi = clobApi;
        this.gammaApi = gammaApi;
    }
    /* ━━━━━━━━━━━━━━ Lifecycle ━━━━━━━━━━━━━━ */
    start() {
        if (this.running)
            return;
        this.running = true;
        // Init DB
        this.db = new whale_db_1.WhaleDB(this.config.dbPath);
        // Init sub-systems
        this.ingestion = new whale_ingestion_1.WhaleIngestion(this.db, this.config, this.clobApi, this.gammaApi);
        this.analytics = new whale_analytics_1.WhaleAnalytics(this.db, this.config);
        this.alerts = new whale_alerts_1.WhaleAlerts(this.db, this.config);
        this.candidates = new whale_candidates_1.WhaleCandidates(this.db, this.config, this.clobApi);
        this.shadow = new shadow_portfolio_1.ShadowPortfolioManager(this.db, this.config);
        this.reconciliation = new whale_reconciliation_1.WhaleReconciliation(this.db, this.config, this.ingestion);
        this.scanner = new whale_scanner_1.WhaleScanner(this.db, this.config, this.gammaApi, this.clobApi);
        // Start background services
        this.ingestion.start();
        this.candidates.start();
        this.reconciliation.start();
        // Auto-start scanner if configured
        if (this.config.scanner.enabled) {
            this.scanner.start();
        }
        // Analytics refresh every 5 minutes
        this.analyticsTimer = setInterval(() => {
            void this.refreshAllAnalytics();
        }, 300000);
        logs_1.logger.info('WhaleService started — all sub-systems active');
    }
    stop() {
        this.running = false;
        this.ingestion?.stop();
        this.candidates?.stop();
        this.reconciliation?.stop();
        this.scanner?.stop();
        if (this.analyticsTimer) {
            clearInterval(this.analyticsTimer);
            this.analyticsTimer = null;
        }
        this.db?.close();
        logs_1.logger.info('WhaleService stopped');
    }
    isRunning() { return this.running; }
    /* ━━━━━━━━━━━━━━ Whale management ━━━━━━━━━━━━━━ */
    addWhale(address, opts) {
        const whale = this.db.addWhale(address, opts);
        // Trigger backfill
        void this.ingestion.backfillWhale(whale.id, whale.address);
        return whale;
    }
    getWhale(id) {
        return this.db.getWhale(id);
    }
    getWhaleByAddress(address) {
        return this.db.getWhaleByAddress(address);
    }
    listWhales(opts) {
        const result = this.db.listWhales(opts);
        const enriched = result.whales.map((w) => this.enrichWhaleListItem(w));
        return { whales: enriched, total: result.total };
    }
    updateWhale(id, updates) {
        this.db.updateWhale(id, updates);
    }
    deleteWhale(id) {
        this.db.deleteWhale(id);
    }
    /* ━━━━━━━━━━━━━━ Whale detail ━━━━━━━━━━━━━━ */
    getWhaleDetail(id) {
        const whale = this.db.getWhale(id);
        if (!whale)
            return null;
        const scoreBreakdown = this.analytics.computeScore(id);
        const equityCurve = this.analytics.getEquityCurve(id);
        const recentTrades = this.db.getWhaleTrades(id, { limit: 50 });
        const openPositions = this.db.getPositions(id);
        const timingAnalysis = this.analytics.computeTimingAnalysis(id);
        // Category distribution from trades
        const categoryDistribution = this.computeCategoryDistribution(id);
        return {
            whale,
            scoreBreakdown,
            equityCurve,
            recentTrades,
            openPositions,
            categoryDistribution,
            timingAnalysis,
        };
    }
    /* ━━━━━━━━━━━━━━ Trades ━━━━━━━━━━━━━━ */
    getWhaleTrades(whaleId, opts) {
        return this.db.getWhaleTrades(whaleId, opts);
    }
    /* ━━━━━━━━━━━━━━ Positions ━━━━━━━━━━━━━━ */
    getWhalePositions(whaleId) {
        return this.db.getPositions(whaleId);
    }
    /* ━━━━━━━━━━━━━━ Score + analytics ━━━━━━━━━━━━━━ */
    getWhaleScore(whaleId) {
        return this.analytics.computeScore(whaleId);
    }
    getTimingAnalysis(whaleId) {
        return this.analytics.computeTimingAnalysis(whaleId);
    }
    getDailyMetrics(whaleId, fromDate, toDate) {
        return this.db.getDailyMetrics(whaleId, { fromDate, toDate });
    }
    /* ━━━━━━━━━━━━━━ Alerts ━━━━━━━━━━━━━━ */
    getAlerts(opts) {
        return this.db.listAlerts(opts);
    }
    markAlertRead(id) {
        this.db.markAlertRead(id);
    }
    markAllAlertsRead(whaleId) {
        this.db.markAllAlertsRead(whaleId);
    }
    getUnreadAlertCount() {
        return this.db.getUnreadAlertCount();
    }
    /* ━━━━━━━━━━━━━━ Signals ━━━━━━━━━━━━━━ */
    getSignals(opts) {
        return this.db.listSignals(opts);
    }
    /* ━━━━━━━━━━━━━━ Candidates ━━━━━━━━━━━━━━ */
    listCandidates(opts) {
        return this.db.listCandidates(opts);
    }
    approveCandidate(address) {
        this.db.approveCandidate(address);
        return this.addWhale(address, { notes: 'Promoted from candidate pool' });
    }
    muteCandidate(address, days) {
        this.db.muteCandidate(address, days);
    }
    /* ━━━━━━━━━━━━━━ Watchlists ━━━━━━━━━━━━━━ */
    createWatchlist(name) {
        return this.db.createWatchlist(name);
    }
    listWatchlists() {
        return this.db.listWatchlists();
    }
    deleteWatchlist(id) {
        this.db.deleteWatchlist(id);
    }
    addToWatchlist(watchlistId, whaleId) {
        this.db.addToWatchlist(watchlistId, whaleId);
    }
    removeFromWatchlist(watchlistId, whaleId) {
        this.db.removeFromWatchlist(watchlistId, whaleId);
    }
    getWatchlistItems(watchlistId) {
        const whales = this.db.getWatchlistItems(watchlistId);
        return whales.map((w) => this.enrichWhaleListItem(w));
    }
    /* ━━━━━━━━━━━━━━ Shadow portfolios ━━━━━━━━━━━━━━ */
    getShadowPortfolio(whaleId) {
        return this.db.getShadowPortfolio(whaleId);
    }
    /* ━━━━━━━━━━━━━━ Market whale activity ━━━━━━━━━━━━━━ */
    getMarketWhaleActivity(marketId) {
        const trades = this.db.getMarketTrades(marketId, { limit: 500 });
        // Net flow by outcome
        const flowMap = new Map();
        for (const t of trades) {
            const current = flowMap.get(t.outcome) ?? 0;
            flowMap.set(t.outcome, current + (t.side === 'BUY' ? t.notionalUsd : -t.notionalUsd));
        }
        const whaleNetFlow = Array.from(flowMap.entries()).map(([outcome, netUsd]) => ({ outcome, netUsd }));
        // Biggest prints
        const biggestPrints = [...trades].sort((a, b) => b.notionalUsd - a.notionalUsd).slice(0, 10);
        // Concentration
        const whaleVol = new Map();
        const totalVol = trades.reduce((s, t) => s + t.notionalUsd, 0);
        for (const t of trades) {
            const current = whaleVol.get(t.whaleId) ?? { address: '', vol: 0 };
            current.vol += t.notionalUsd;
            whaleVol.set(t.whaleId, current);
        }
        // Enrich with addresses
        for (const [whaleId, data] of whaleVol) {
            const whale = this.db.getWhale(whaleId);
            if (whale)
                data.address = whale.address;
        }
        const concentration = Array.from(whaleVol.entries())
            .map(([whaleId, data]) => ({
            whaleId,
            address: data.address,
            pct: totalVol > 0 ? data.vol / totalVol : 0,
        }))
            .sort((a, b) => b.pct - a.pct)
            .slice(0, 10);
        // Recent entries / exits
        const recentEntries = trades.filter((t) => t.side === 'BUY').slice(0, 10);
        const recentExits = trades.filter((t) => t.side === 'SELL').slice(0, 10);
        return { marketId, whaleNetFlow, biggestPrints, concentration, recentEntries, recentExits };
    }
    /* ━━━━━━━━━━━━━━ Scanner ━━━━━━━━━━━━━━ */
    getScannerState() {
        return this.scanner.getState();
    }
    getScannerResults() {
        return this.scanner.getResults();
    }
    getScannerClusters() {
        return this.scanner.getClusters();
    }
    getScannerProfile(address) {
        return this.scanner.getProfile(address);
    }
    startScanner() {
        this.scanner.start();
    }
    stopScanner() {
        this.scanner.stop();
    }
    toggleScanner() {
        return this.scanner.toggle();
    }
    async triggerScan() {
        return this.scanner.triggerScan();
    }
    promoteScannedWhale(address) {
        return this.addWhale(address, {
            tags: ['scanner_discovered'],
            notes: 'Promoted from scanner results',
        });
    }
    /* ━━━━━━━━━━━━━━ Scanner — Advanced Features ━━━━━━━━━━━━━━ */
    getClusterSignals() {
        return this.scanner.getClusterSignals();
    }
    getNetworkGraph() {
        return this.scanner.getNetworkGraph();
    }
    getCopySimResults() {
        return this.scanner.getCopySimResults();
    }
    getCopySimResult(address) {
        return this.scanner.getCopySimResult(address);
    }
    getRegimeState() {
        return this.scanner.getRegimeState();
    }
    getApiPoolStatus() {
        return this.scanner.getApiPoolStatus();
    }
    getWalletBalance(address) {
        return this.scanner.getWalletBalance(address);
    }
    /* ━━━━━━━━━━━━━━ Reconciliation ━━━━━━━━━━━━━━ */
    async runReconciliation() {
        return this.reconciliation.reconcileCycle();
    }
    /* ━━━━━━━━━━━━━━ Comparison ━━━━━━━━━━━━━━ */
    compareWhales(ids) {
        return ids.map((id) => {
            const whale = this.db.getWhale(id);
            if (!whale)
                return null;
            const score = this.analytics.computeScore(id);
            return {
                whale,
                score,
                stats: {
                    totalVolume: this.db.getWhaleVolume(id),
                    tradeCount: this.db.getWhaleTradeCount(id),
                    winRate: this.db.getWinRate(id),
                    settledPnl: this.db.getSettledPnl(id),
                    distinctMarkets: this.db.getWhaleDistinctMarkets(id),
                },
            };
        }).filter(Boolean);
    }
    /* ━━━━━━━━━━━━━━ Summary for dashboard ━━━━━━━━━━━━━━ */
    getSummary() {
        const { total: totalWhales } = this.db.listWhales({ limit: 0 });
        const { total: trackedWhales } = this.db.listWhales({ trackingEnabled: true, limit: 0 });
        const unreadAlerts = this.db.getUnreadAlertCount();
        const candidates = this.db.listCandidates({ limit: 0 });
        const scannerState = this.scanner?.getState();
        return {
            totalWhales,
            trackedWhales,
            unreadAlerts,
            candidateCount: candidates.length,
            totalTradesIngested: 0, // Could be tracked with a counter
            serviceRunning: this.running,
            scannerEnabled: scannerState?.enabled ?? false,
            scannerStatus: scannerState?.status ?? 'idle',
        };
    }
    /* ━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━ */
    async refreshAllAnalytics() {
        if (!this.running)
            return;
        try {
            const { whales } = this.db.listWhales({ trackingEnabled: true, limit: 1000 });
            for (const whale of whales) {
                if (!this.running)
                    break;
                this.analytics.computeAllMetrics(whale.id);
            }
        }
        catch (err) {
            logs_1.logger.error({ err }, 'Analytics refresh error');
        }
    }
    enrichWhaleListItem(w) {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
        const tradeCount = this.db.getWhaleTradeCount(w.id);
        const volume = this.db.getWhaleVolume(w.id);
        const volume30d = this.db.getWhaleVolume(w.id, thirtyDaysAgo);
        const markets30d = this.db.getWhaleDistinctMarkets(w.id, thirtyDaysAgo);
        const marketsLifetime = this.db.getWhaleDistinctMarkets(w.id);
        const settledPnl = this.db.getSettledPnl(w.id);
        const settledPnl30d = this.db.getSettledPnl(w.id, thirtyDaysAgo);
        const winRate = this.db.getWinRate(w.id);
        const metrics = this.db.getDailyMetrics(w.id, { fromDate: thirtyDaysAgo });
        const avgHold = metrics.length > 0
            ? metrics.reduce((s, m) => s + m.avgHoldMinutes, 0) / metrics.length
            : 0;
        const avgSlippage = metrics.length > 0
            ? metrics.reduce((s, m) => s + m.avgSlippageBps, 0) / metrics.length
            : 0;
        const consistency = metrics.length > 0
            ? metrics.reduce((s, m) => s + m.consistencyScore, 0) / metrics.length
            : 0;
        const whaleScore = metrics.length > 0 ? metrics[metrics.length - 1].score : 0;
        return {
            ...w,
            marketsTraded30d: markets30d,
            marketsTraded_lifetime: marketsLifetime,
            totalVolume30d: volume30d,
            totalVolume_lifetime: volume,
            realizedPnl30d: settledPnl30d,
            realizedPnl_lifetime: settledPnl,
            unrealizedPnl: 0, // Requires mark-to-market
            winRate,
            avgHoldMinutes: avgHold,
            avgSlippageBps: avgSlippage,
            consistencyScore: consistency,
            whaleScore,
            scoreProvisional: tradeCount < this.config.provisionalMinTrades,
        };
    }
    computeCategoryDistribution(whaleId) {
        const trades = this.db.getWhaleTrades(whaleId, { limit: 10000 });
        const byMarket = new Map();
        for (const t of trades) {
            const existing = byMarket.get(t.marketId) ?? { count: 0, volumeUsd: 0 };
            existing.count++;
            existing.volumeUsd += t.notionalUsd;
            byMarket.set(t.marketId, existing);
        }
        // Use marketId as category (in production, would map via metadata)
        return Array.from(byMarket.entries())
            .map(([category, data]) => ({
            category: this.ingestion.getMarketMeta(category)?.slug ?? category.slice(0, 12),
            count: data.count,
            volumeUsd: data.volumeUsd,
        }))
            .sort((a, b) => b.volumeUsd - a.volumeUsd)
            .slice(0, 20);
    }
}
exports.WhaleService = WhaleService;
