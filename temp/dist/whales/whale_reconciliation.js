"use strict";
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — Reconciliation Engine
   Validates data quality, re-fetches missing trades, flags anomalies,
   runs audit trail checks, and fixes inconsistencies.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhaleReconciliation = void 0;
const logs_1 = require("../reporting/logs");
class WhaleReconciliation {
    constructor(db, config, ingestion) {
        this.running = false;
        this.reconcileTimer = null;
        this.db = db;
        this.config = config;
        this.ingestion = ingestion;
    }
    /* ━━━━━━━━━━━━━━ Lifecycle ━━━━━━━━━━━━━━ */
    start() {
        if (this.running)
            return;
        this.running = true;
        logs_1.logger.info('WhaleReconciliation started');
        this.reconcileTimer = setInterval(() => {
            void this.reconcileCycle();
        }, this.config.reconcileIntervalMs);
    }
    stop() {
        this.running = false;
        if (this.reconcileTimer) {
            clearInterval(this.reconcileTimer);
            this.reconcileTimer = null;
        }
        logs_1.logger.info('WhaleReconciliation stopped');
    }
    /* ━━━━━━━━━━━━━━ Full reconcile cycle ━━━━━━━━━━━━━━ */
    async reconcileCycle() {
        const { whales } = this.db.listWhales({ trackingEnabled: true, limit: 1000 });
        const reports = [];
        for (const whale of whales) {
            if (!this.running)
                break;
            const report = await this.reconcileWhale(whale.id, whale.address);
            if (report.issues.length > 0) {
                reports.push(report);
            }
        }
        if (reports.length > 0) {
            const totalIssues = reports.reduce((s, r) => s + r.issues.length, 0);
            logs_1.logger.info({ whalesChecked: whales.length, whalesWithIssues: reports.length, totalIssues }, 'Reconciliation complete');
        }
        return reports;
    }
    /* ━━━━━━━━━━━━━━ Per-whale reconciliation ━━━━━━━━━━━━━━ */
    async reconcileWhale(whaleId, address) {
        const issues = [];
        // 1. Check for trade gaps
        this.checkTradeGaps(whaleId, issues);
        // 2. Check cursor staleness
        this.checkCursorStaleness(whaleId, issues);
        // 3. Check position consistency
        this.checkPositionConsistency(whaleId, issues);
        // 4. Check data integrity status
        this.checkDataIntegrity(whaleId, issues);
        // 5. If gaps found, attempt re-fetch
        const hasGaps = issues.some((i) => i.type === 'gap_detected');
        if (hasGaps) {
            try {
                await this.ingestion.backfillWhale(whaleId, address, 5);
                logs_1.logger.info({ whaleId }, 'Re-fetched trades after gap detection');
            }
            catch (err) {
                issues.push({
                    type: 'gap_detected',
                    severity: 'error',
                    message: 'Failed to re-fetch trades after gap detection',
                    details: { error: String(err) },
                });
            }
        }
        // Update data integrity based on issues
        if (issues.filter((i) => i.severity === 'error').length > 0) {
            this.db.updateWhale(whaleId, { dataIntegrity: 'DEGRADED' });
        }
        else if (issues.length === 0) {
            this.db.updateWhale(whaleId, { dataIntegrity: 'HEALTHY' });
        }
        return {
            whaleId,
            address,
            issues,
            timestamp: new Date().toISOString(),
        };
    }
    /* ━━━━━━━━━━━━━━ Check: Trade gaps ━━━━━━━━━━━━━━ */
    checkTradeGaps(whaleId, issues) {
        const lookbackDays = this.config.reconcileLookbackDays;
        const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
        const trades = this.db.getWhaleTrades(whaleId, { limit: 10000 })
            .filter((t) => t.ts >= since)
            .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        if (trades.length < 2)
            return;
        // Check for suspiciously large gaps between consecutive trades
        for (let i = 1; i < trades.length; i++) {
            const gap = new Date(trades[i].ts).getTime() - new Date(trades[i - 1].ts).getTime();
            const gapHours = gap / 3600000;
            // Flag gaps > 72 hours for active whales
            if (gapHours > 72) {
                issues.push({
                    type: 'gap_detected',
                    severity: 'warning',
                    message: `${Math.round(gapHours)}h gap between trades`,
                    details: {
                        before: trades[i - 1].ts,
                        after: trades[i].ts,
                        gapHours: Math.round(gapHours),
                    },
                });
            }
        }
    }
    /* ━━━━━━━━━━━━━━ Check: Cursor staleness ━━━━━━━━━━━━━━ */
    checkCursorStaleness(whaleId, issues) {
        const whale = this.db.getWhale(whaleId);
        if (!whale)
            return;
        if (whale.lastTradeCursor) {
            const cursorAge = Date.now() - new Date(whale.lastTradeCursor).getTime();
            const cursorAgeDays = cursorAge / 86400000;
            if (cursorAgeDays > 7) {
                issues.push({
                    type: 'stale_cursor',
                    severity: 'warning',
                    message: `Trade cursor is ${Math.round(cursorAgeDays)} days old`,
                    details: { lastCursor: whale.lastTradeCursor, ageDays: Math.round(cursorAgeDays) },
                });
            }
        }
        else if (whale.trackingEnabled) {
            issues.push({
                type: 'stale_cursor',
                severity: 'info',
                message: 'No trade cursor set — whale may need backfill',
                details: {},
            });
        }
    }
    /* ━━━━━━━━━━━━━━ Check: Position consistency ━━━━━━━━━━━━━━ */
    checkPositionConsistency(whaleId, issues) {
        const positions = this.db.getPositions(whaleId);
        for (const pos of positions) {
            // Negative positions shouldn't exist in prediction markets
            if (pos.netShares < -0.001) {
                issues.push({
                    type: 'position_mismatch',
                    severity: 'error',
                    message: `Negative position: ${pos.netShares} shares in ${pos.marketId}`,
                    details: { marketId: pos.marketId, outcome: pos.outcome, netShares: pos.netShares },
                });
            }
            // Positions with 0 shares should be cleaned up
            if (Math.abs(pos.netShares) < 0.0001 && Math.abs(pos.costBasis) > 0.01) {
                issues.push({
                    type: 'position_mismatch',
                    severity: 'warning',
                    message: `Ghost position: 0 shares but non-zero cost basis in ${pos.marketId}`,
                    details: { marketId: pos.marketId, outcome: pos.outcome, costBasis: pos.costBasis },
                });
            }
        }
    }
    /* ━━━━━━━━━━━━━━ Check: Data integrity ━━━━━━━━━━━━━━ */
    checkDataIntegrity(whaleId, issues) {
        const whale = this.db.getWhale(whaleId);
        if (!whale)
            return;
        // If whale has been backfilling for > 24h, something is wrong
        if (whale.dataIntegrity === 'BACKFILLING' && whale.lastBackfillAt) {
            const backfillAge = Date.now() - new Date(whale.lastBackfillAt).getTime();
            if (backfillAge > 86400000) {
                issues.push({
                    type: 'missing_metadata',
                    severity: 'error',
                    message: 'Whale stuck in BACKFILLING state for >24h',
                    details: { lastBackfillAt: whale.lastBackfillAt },
                });
            }
        }
        // Check trade count vs expected
        const tradeCount = this.db.getWhaleTradeCount(whaleId);
        if (tradeCount === 0 && whale.trackingEnabled) {
            issues.push({
                type: 'missing_metadata',
                severity: 'warning',
                message: 'Tracked whale has 0 trades — may need backfill',
                details: { address: whale.address },
            });
        }
    }
}
exports.WhaleReconciliation = WhaleReconciliation;
