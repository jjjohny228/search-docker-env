"use strict";
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — SQLite Database Layer
   Uses better-sqlite3 (synchronous, production-grade).
   Schema is Postgres-ready (standard SQL types, no SQLite-only features).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhaleDB = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const logs_1 = require("../reporting/logs");
class WhaleDB {
    constructor(dbPath) {
        const dir = path_1.default.dirname(dbPath);
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        this.db = new better_sqlite3_1.default(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.migrate();
        logs_1.logger.info({ dbPath }, 'WhaleDB initialised');
    }
    close() { this.db.close(); }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       MIGRATIONS
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS whales (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        address       TEXT    NOT NULL UNIQUE,
        display_name  TEXT,
        starred       INTEGER NOT NULL DEFAULT 0,
        tracking_enabled INTEGER NOT NULL DEFAULT 1,
        tags          TEXT    NOT NULL DEFAULT '[]',
        notes         TEXT    NOT NULL DEFAULT '',
        style         TEXT    NOT NULL DEFAULT 'UNKNOWN',
        data_integrity TEXT   NOT NULL DEFAULT 'BACKFILLING',
        copy_mode     TEXT    NOT NULL DEFAULT 'ALERTS_ONLY',
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        last_active_at TEXT,
        last_backfill_at TEXT,
        last_trade_cursor TEXT
      );

      CREATE TABLE IF NOT EXISTS whale_trades (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        whale_id             INTEGER NOT NULL REFERENCES whales(id),
        trade_id             TEXT,
        logical_trade_group_id TEXT,
        market_id            TEXT    NOT NULL,
        outcome              TEXT    NOT NULL,
        side                 TEXT    NOT NULL,
        price                REAL    NOT NULL,
        size                 REAL    NOT NULL,
        notional_usd         REAL    NOT NULL,
        fee_usd              REAL    NOT NULL DEFAULT 0,
        is_fee_estimated     INTEGER NOT NULL DEFAULT 1,
        ts                   TEXT    NOT NULL,
        midpoint_at_fill     REAL,
        best_bid_at_fill     REAL,
        best_ask_at_fill     REAL,
        slippage_bps         REAL,
        aggressor            TEXT    NOT NULL DEFAULT 'UNKNOWN',
        UNIQUE(whale_id, trade_id)
      );

      CREATE TABLE IF NOT EXISTS whale_positions (
        whale_id        INTEGER NOT NULL REFERENCES whales(id),
        market_id       TEXT    NOT NULL,
        outcome         TEXT    NOT NULL,
        net_shares      REAL    NOT NULL DEFAULT 0,
        avg_entry_price REAL    NOT NULL DEFAULT 0,
        cost_basis      REAL    NOT NULL DEFAULT 0,
        unrealized_pnl  REAL    NOT NULL DEFAULT 0,
        updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (whale_id, market_id, outcome)
      );

      CREATE TABLE IF NOT EXISTS whale_metrics_daily (
        whale_id               INTEGER NOT NULL REFERENCES whales(id),
        date                   TEXT    NOT NULL,
        realized_pnl           REAL    NOT NULL DEFAULT 0,
        unrealized_pnl         REAL    NOT NULL DEFAULT 0,
        volume_usd             REAL    NOT NULL DEFAULT 0,
        trades_count           INTEGER NOT NULL DEFAULT 0,
        win_rate               REAL    NOT NULL DEFAULT 0,
        avg_slippage_bps       REAL    NOT NULL DEFAULT 0,
        avg_hold_minutes       REAL    NOT NULL DEFAULT 0,
        timing_score           REAL    NOT NULL DEFAULT 0,
        consistency_score      REAL    NOT NULL DEFAULT 0,
        market_selection_score REAL    NOT NULL DEFAULT 0,
        score                  REAL    NOT NULL DEFAULT 0,
        score_confidence       REAL    NOT NULL DEFAULT 0,
        score_version          TEXT    NOT NULL DEFAULT '1.0.0',
        PRIMARY KEY (whale_id, date)
      );

      CREATE TABLE IF NOT EXISTS whale_settlement_ledger (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        whale_id                 INTEGER NOT NULL REFERENCES whales(id),
        market_id                TEXT    NOT NULL,
        outcome                  TEXT    NOT NULL,
        lot_id                   TEXT    NOT NULL,
        open_ts                  TEXT    NOT NULL,
        close_ts                 TEXT,
        qty                      REAL    NOT NULL,
        entry_price              REAL    NOT NULL,
        exit_price_or_settlement REAL,
        realized_pnl             REAL    NOT NULL DEFAULT 0,
        fee_usd                  REAL    NOT NULL DEFAULT 0,
        method                   TEXT    NOT NULL DEFAULT 'FIFO',
        is_estimated_fee         INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS whale_candidates (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        address               TEXT    NOT NULL UNIQUE,
        first_seen_at         TEXT    NOT NULL DEFAULT (datetime('now')),
        last_seen_at          TEXT    NOT NULL DEFAULT (datetime('now')),
        volume_usd_24h        REAL    NOT NULL DEFAULT 0,
        trades_24h            INTEGER NOT NULL DEFAULT 0,
        max_single_trade_usd  REAL    NOT NULL DEFAULT 0,
        markets_7d            INTEGER NOT NULL DEFAULT 0,
        rank_score            REAL    NOT NULL DEFAULT 0,
        suggested_tags        TEXT    NOT NULL DEFAULT '[]',
        muted_until           TEXT,
        approved              INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        whale_id    INTEGER REFERENCES whales(id),
        type        TEXT    NOT NULL,
        payload     TEXT    NOT NULL DEFAULT '{}',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        delivered   INTEGER NOT NULL DEFAULT 0,
        read_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS signals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT    NOT NULL,
        payload     TEXT    NOT NULL DEFAULT '{}',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        cursor_key  TEXT    NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS watchlists (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS watchlist_items (
        watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
        whale_id     INTEGER NOT NULL REFERENCES whales(id) ON DELETE CASCADE,
        PRIMARY KEY (watchlist_id, whale_id)
      );

      CREATE TABLE IF NOT EXISTS shadow_portfolios (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        whale_id     INTEGER NOT NULL REFERENCES whales(id),
        mode         TEXT    NOT NULL DEFAULT 'paper',
        positions    TEXT    NOT NULL DEFAULT '[]',
        pnl_series   TEXT    NOT NULL DEFAULT '[]',
        total_pnl    REAL    NOT NULL DEFAULT 0,
        drawdown     REAL    NOT NULL DEFAULT 0,
        last_updated TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(whale_id)
      );

      /* ── Indexes ── */
      CREATE INDEX IF NOT EXISTS idx_whale_trades_whale_ts     ON whale_trades(whale_id, ts);
      CREATE INDEX IF NOT EXISTS idx_whale_trades_market_ts    ON whale_trades(market_id, ts);
      CREATE INDEX IF NOT EXISTS idx_whale_metrics_whale_date  ON whale_metrics_daily(whale_id, date);
      CREATE INDEX IF NOT EXISTS idx_alerts_created            ON alerts(created_at);
      CREATE INDEX IF NOT EXISTS idx_signals_created           ON signals(created_at);
      CREATE INDEX IF NOT EXISTS idx_whale_candidates_rank     ON whale_candidates(rank_score DESC);
      CREATE INDEX IF NOT EXISTS idx_whale_trades_trade_id     ON whale_trades(trade_id);
    `);
    }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       WHALE CRUD
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    addWhale(address, opts) {
        const stmt = this.db.prepare(`
      INSERT INTO whales (address, display_name, tags, notes)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, whales.display_name),
        updated_at = datetime('now')
      RETURNING *
    `);
        const row = stmt.get(address.toLowerCase(), opts?.displayName ?? null, JSON.stringify(opts?.tags ?? []), opts?.notes ?? '');
        return this.rowToWhale(row);
    }
    bulkAddWhales(addresses) {
        const insert = this.db.prepare(`
      INSERT OR IGNORE INTO whales (address) VALUES (?)
    `);
        const trx = this.db.transaction((addrs) => {
            for (const addr of addrs)
                insert.run(addr.toLowerCase());
        });
        trx(addresses);
        return addresses.map((a) => this.getWhaleByAddress(a.toLowerCase())).filter(Boolean);
    }
    getWhale(id) {
        const row = this.db.prepare('SELECT * FROM whales WHERE id = ?').get(id);
        return row ? this.rowToWhale(row) : undefined;
    }
    getWhaleByAddress(address) {
        const row = this.db.prepare('SELECT * FROM whales WHERE address = ?').get(address.toLowerCase());
        return row ? this.rowToWhale(row) : undefined;
    }
    listWhales(opts) {
        let where = 'WHERE 1=1';
        const params = [];
        if (opts?.starred !== undefined) {
            where += ' AND starred = ?';
            params.push(opts.starred ? 1 : 0);
        }
        if (opts?.trackingEnabled !== undefined) {
            where += ' AND tracking_enabled = ?';
            params.push(opts.trackingEnabled ? 1 : 0);
        }
        if (opts?.style) {
            where += ' AND style = ?';
            params.push(opts.style);
        }
        if (opts?.tag) {
            where += ' AND tags LIKE ?';
            params.push(`%${opts.tag}%`);
        }
        const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM whales ${where}`).get(...params);
        const orderBy = opts?.orderBy ?? 'last_active_at DESC NULLS LAST';
        const limit = opts?.limit ?? 50;
        const offset = opts?.offset ?? 0;
        const rows = this.db.prepare(`SELECT * FROM whales ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
            .all(...params, limit, offset);
        return { whales: rows.map((r) => this.rowToWhale(r)), total: countRow.cnt };
    }
    updateWhale(id, updates) {
        const sets = ['updated_at = datetime(\'now\')'];
        const params = [];
        if (updates.displayName !== undefined) {
            sets.push('display_name = ?');
            params.push(updates.displayName);
        }
        if (updates.starred !== undefined) {
            sets.push('starred = ?');
            params.push(updates.starred ? 1 : 0);
        }
        if (updates.trackingEnabled !== undefined) {
            sets.push('tracking_enabled = ?');
            params.push(updates.trackingEnabled ? 1 : 0);
        }
        if (updates.tags !== undefined) {
            sets.push('tags = ?');
            params.push(JSON.stringify(updates.tags));
        }
        if (updates.notes !== undefined) {
            sets.push('notes = ?');
            params.push(updates.notes);
        }
        if (updates.style !== undefined) {
            sets.push('style = ?');
            params.push(updates.style);
        }
        if (updates.dataIntegrity !== undefined) {
            sets.push('data_integrity = ?');
            params.push(updates.dataIntegrity);
        }
        if (updates.copyMode !== undefined) {
            sets.push('copy_mode = ?');
            params.push(updates.copyMode);
        }
        if (updates.lastActiveAt !== undefined) {
            sets.push('last_active_at = ?');
            params.push(updates.lastActiveAt);
        }
        if (updates.lastBackfillAt !== undefined) {
            sets.push('last_backfill_at = ?');
            params.push(updates.lastBackfillAt);
        }
        if (updates.lastTradeCursor !== undefined) {
            sets.push('last_trade_cursor = ?');
            params.push(updates.lastTradeCursor);
        }
        params.push(id);
        this.db.prepare(`UPDATE whales SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    deleteWhale(id) {
        // Soft delete: disable tracking and clear from watchlists
        this.db.prepare('UPDATE whales SET tracking_enabled = 0, updated_at = datetime(\'now\') WHERE id = ?').run(id);
    }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       TRADES
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    insertTrade(trade) {
        const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO whale_trades
        (whale_id, trade_id, logical_trade_group_id, market_id, outcome, side,
         price, size, notional_usd, fee_usd, is_fee_estimated, ts,
         midpoint_at_fill, best_bid_at_fill, best_ask_at_fill, slippage_bps, aggressor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
        const info = stmt.run(trade.whaleId, trade.tradeId, trade.logicalTradeGroupId, trade.marketId, trade.outcome, trade.side, trade.price, trade.size, trade.notionalUsd, trade.feeUsd, trade.isFeeEstimated ? 1 : 0, trade.ts, trade.midpointAtFill, trade.bestBidAtFill, trade.bestAskAtFill, trade.slippageBps, trade.aggressor);
        return Number(info.lastInsertRowid);
    }
    insertTrades(trades) {
        const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO whale_trades
        (whale_id, trade_id, logical_trade_group_id, market_id, outcome, side,
         price, size, notional_usd, fee_usd, is_fee_estimated, ts,
         midpoint_at_fill, best_bid_at_fill, best_ask_at_fill, slippage_bps, aggressor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
        let inserted = 0;
        const trx = this.db.transaction((list) => {
            for (const t of list) {
                const info = stmt.run(t.whaleId, t.tradeId, t.logicalTradeGroupId, t.marketId, t.outcome, t.side, t.price, t.size, t.notionalUsd, t.feeUsd, t.isFeeEstimated ? 1 : 0, t.ts, t.midpointAtFill, t.bestBidAtFill, t.bestAskAtFill, t.slippageBps, t.aggressor);
                if (info.changes > 0)
                    inserted++;
            }
        });
        trx(trades);
        return inserted;
    }
    getWhaleTrades(whaleId, opts) {
        let where = 'WHERE whale_id = ?';
        const params = [whaleId];
        if (opts?.cursor) {
            where += ' AND ts < ?';
            params.push(opts.cursor);
        }
        if (opts?.marketId) {
            where += ' AND market_id = ?';
            params.push(opts.marketId);
        }
        const limit = opts?.limit ?? 100;
        const rows = this.db.prepare(`SELECT * FROM whale_trades ${where} ORDER BY ts DESC LIMIT ?`)
            .all(...params, limit);
        return rows.map((r) => this.rowToTrade(r));
    }
    getMarketTrades(marketId, opts) {
        const rows = this.db.prepare('SELECT * FROM whale_trades WHERE market_id = ? ORDER BY ts DESC LIMIT ?').all(marketId, opts?.limit ?? 100);
        return rows.map((r) => this.rowToTrade(r));
    }
    getTradeByTradeId(whaleId, tradeId) {
        const row = this.db.prepare('SELECT * FROM whale_trades WHERE whale_id = ? AND trade_id = ?').get(whaleId, tradeId);
        return row ? this.rowToTrade(row) : undefined;
    }
    getWhaleTradeCount(whaleId, sinceDate) {
        const where = sinceDate
            ? 'WHERE whale_id = ? AND ts >= ?'
            : 'WHERE whale_id = ?';
        const params = sinceDate ? [whaleId, sinceDate] : [whaleId];
        const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM whale_trades ${where}`).get(...params);
        return row.cnt;
    }
    getWhaleVolume(whaleId, sinceDate) {
        const where = sinceDate
            ? 'WHERE whale_id = ? AND ts >= ?'
            : 'WHERE whale_id = ?';
        const params = sinceDate ? [whaleId, sinceDate] : [whaleId];
        const row = this.db.prepare(`SELECT COALESCE(SUM(notional_usd),0) as vol FROM whale_trades ${where}`).get(...params);
        return row.vol;
    }
    getWhaleDistinctMarkets(whaleId, sinceDate) {
        const where = sinceDate
            ? 'WHERE whale_id = ? AND ts >= ?'
            : 'WHERE whale_id = ?';
        const params = sinceDate ? [whaleId, sinceDate] : [whaleId];
        const row = this.db.prepare(`SELECT COUNT(DISTINCT market_id) as cnt FROM whale_trades ${where}`).get(...params);
        return row.cnt;
    }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       POSITIONS
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    upsertPosition(pos) {
        this.db.prepare(`
      INSERT INTO whale_positions (whale_id, market_id, outcome, net_shares, avg_entry_price, cost_basis, unrealized_pnl, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(whale_id, market_id, outcome) DO UPDATE SET
        net_shares = excluded.net_shares,
        avg_entry_price = excluded.avg_entry_price,
        cost_basis = excluded.cost_basis,
        unrealized_pnl = excluded.unrealized_pnl,
        updated_at = datetime('now')
    `).run(pos.whaleId, pos.marketId, pos.outcome, pos.netShares, pos.avgEntryPrice, pos.costBasis, pos.unrealizedPnl);
    }
    getPositions(whaleId) {
        const rows = this.db.prepare('SELECT * FROM whale_positions WHERE whale_id = ? AND net_shares != 0').all(whaleId);
        return rows.map((r) => ({
            whaleId: r.whale_id,
            marketId: r.market_id,
            outcome: r.outcome,
            netShares: r.net_shares,
            avgEntryPrice: r.avg_entry_price,
            costBasis: r.cost_basis,
            unrealizedPnl: r.unrealized_pnl,
            updatedAt: r.updated_at,
        }));
    }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       METRICS
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    upsertDailyMetrics(m) {
        this.db.prepare(`
      INSERT INTO whale_metrics_daily
        (whale_id, date, realized_pnl, unrealized_pnl, volume_usd, trades_count,
         win_rate, avg_slippage_bps, avg_hold_minutes, timing_score,
         consistency_score, market_selection_score, score, score_confidence, score_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(whale_id, date) DO UPDATE SET
        realized_pnl = excluded.realized_pnl,
        unrealized_pnl = excluded.unrealized_pnl,
        volume_usd = excluded.volume_usd,
        trades_count = excluded.trades_count,
        win_rate = excluded.win_rate,
        avg_slippage_bps = excluded.avg_slippage_bps,
        avg_hold_minutes = excluded.avg_hold_minutes,
        timing_score = excluded.timing_score,
        consistency_score = excluded.consistency_score,
        market_selection_score = excluded.market_selection_score,
        score = excluded.score,
        score_confidence = excluded.score_confidence,
        score_version = excluded.score_version
    `).run(m.whaleId, m.date, m.realizedPnl, m.unrealizedPnl, m.volumeUsd, m.tradesCount, m.winRate, m.avgSlippageBps, m.avgHoldMinutes, m.timingScore, m.consistencyScore, m.marketSelectionScore, m.score, m.scoreConfidence, m.scoreVersion);
    }
    getDailyMetrics(whaleId, opts) {
        let where = 'WHERE whale_id = ?';
        const params = [whaleId];
        if (opts?.fromDate) {
            where += ' AND date >= ?';
            params.push(opts.fromDate);
        }
        if (opts?.toDate) {
            where += ' AND date <= ?';
            params.push(opts.toDate);
        }
        const rows = this.db.prepare(`SELECT * FROM whale_metrics_daily ${where} ORDER BY date`)
            .all(...params);
        return rows.map((r) => ({
            whaleId: r.whale_id,
            date: r.date,
            realizedPnl: r.realized_pnl,
            unrealizedPnl: r.unrealized_pnl,
            volumeUsd: r.volume_usd,
            tradesCount: r.trades_count,
            winRate: r.win_rate,
            avgSlippageBps: r.avg_slippage_bps,
            avgHoldMinutes: r.avg_hold_minutes,
            timingScore: r.timing_score,
            consistencyScore: r.consistency_score,
            marketSelectionScore: r.market_selection_score,
            score: r.score,
            scoreConfidence: r.score_confidence,
            scoreVersion: r.score_version,
        }));
    }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       SETTLEMENT LEDGER
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    insertSettlementEntry(e) {
        const info = this.db.prepare(`
      INSERT INTO whale_settlement_ledger
        (whale_id, market_id, outcome, lot_id, open_ts, close_ts, qty,
         entry_price, exit_price_or_settlement, realized_pnl, fee_usd, method, is_estimated_fee)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(e.whaleId, e.marketId, e.outcome, e.lotId, e.openTs, e.closeTs, e.qty, e.entryPrice, e.exitPriceOrSettlement, e.realizedPnl, e.feeUsd, e.method, e.isEstimatedFee ? 1 : 0);
        return Number(info.lastInsertRowid);
    }
    getSettlementEntries(whaleId) {
        const rows = this.db.prepare('SELECT * FROM whale_settlement_ledger WHERE whale_id = ? ORDER BY open_ts').all(whaleId);
        return rows.map((r) => ({
            id: r.id,
            whaleId: r.whale_id,
            marketId: r.market_id,
            outcome: r.outcome,
            lotId: r.lot_id,
            openTs: r.open_ts,
            closeTs: r.close_ts,
            qty: r.qty,
            entryPrice: r.entry_price,
            exitPriceOrSettlement: r.exit_price_or_settlement,
            realizedPnl: r.realized_pnl,
            feeUsd: r.fee_usd,
            method: r.method,
            isEstimatedFee: r.is_estimated_fee === 1,
        }));
    }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       CANDIDATES
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    upsertCandidate(c) {
        this.db.prepare(`
      INSERT INTO whale_candidates
        (address, first_seen_at, last_seen_at, volume_usd_24h, trades_24h,
         max_single_trade_usd, markets_7d, rank_score, suggested_tags, muted_until, approved)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(address) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        volume_usd_24h = excluded.volume_usd_24h,
        trades_24h = excluded.trades_24h,
        max_single_trade_usd = excluded.max_single_trade_usd,
        markets_7d = excluded.markets_7d,
        rank_score = excluded.rank_score,
        suggested_tags = excluded.suggested_tags
    `).run(c.address.toLowerCase(), c.firstSeenAt, c.lastSeenAt, c.volumeUsd24h, c.trades24h, c.maxSingleTradeUsd, c.markets7d, c.rankScore, JSON.stringify(c.suggestedTags), c.mutedUntil, c.approved ? 1 : 0);
    }
    listCandidates(opts) {
        let where = 'WHERE 1=1';
        const params = [];
        if (opts?.excludeApproved) {
            where += ' AND approved = 0';
        }
        if (opts?.excludeMuted) {
            where += ' AND (muted_until IS NULL OR muted_until < datetime(\'now\'))';
        }
        const limit = opts?.limit ?? 50;
        const offset = opts?.offset ?? 0;
        const rows = this.db.prepare(`SELECT * FROM whale_candidates ${where} ORDER BY rank_score DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
        return rows.map((r) => this.rowToCandidate(r));
    }
    approveCandidate(address) {
        this.db.prepare('UPDATE whale_candidates SET approved = 1 WHERE address = ?').run(address.toLowerCase());
    }
    muteCandidate(address, days = 30) {
        const until = new Date(Date.now() + days * 86400000).toISOString();
        this.db.prepare('UPDATE whale_candidates SET muted_until = ? WHERE address = ?').run(until, address.toLowerCase());
    }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       ALERTS + SIGNALS
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    insertAlert(alert) {
        const info = this.db.prepare(`
      INSERT INTO alerts (whale_id, type, payload, created_at, delivered, read_at)
      VALUES (?, ?, ?, datetime('now'), 0, NULL)
    `).run(alert.whaleId, alert.type, JSON.stringify(alert.payload));
        return Number(info.lastInsertRowid);
    }
    listAlerts(opts) {
        let where = 'WHERE 1=1';
        const params = [];
        if (opts?.whaleId) {
            where += ' AND whale_id = ?';
            params.push(opts.whaleId);
        }
        if (opts?.unreadOnly) {
            where += ' AND read_at IS NULL';
        }
        if (opts?.cursor) {
            where += ' AND created_at < ?';
            params.push(opts.cursor);
        }
        const rows = this.db.prepare(`SELECT * FROM alerts ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, opts?.limit ?? 50);
        return rows.map((r) => this.rowToAlert(r));
    }
    markAlertRead(id) {
        this.db.prepare("UPDATE alerts SET read_at = datetime('now') WHERE id = ?").run(id);
    }
    markAllAlertsRead(whaleId) {
        if (whaleId) {
            this.db.prepare("UPDATE alerts SET read_at = datetime('now') WHERE whale_id = ? AND read_at IS NULL").run(whaleId);
        }
        else {
            this.db.prepare("UPDATE alerts SET read_at = datetime('now') WHERE read_at IS NULL").run();
        }
    }
    getUnreadAlertCount() {
        const row = this.db.prepare('SELECT COUNT(*) as cnt FROM alerts WHERE read_at IS NULL').get();
        return row.cnt;
    }
    insertSignal(signal) {
        const info = this.db.prepare(`
      INSERT INTO signals (type, payload, created_at, cursor_key)
      VALUES (?, ?, datetime('now'), ?)
    `).run(signal.type, JSON.stringify(signal.payload), signal.cursorKey);
        return Number(info.lastInsertRowid);
    }
    listSignals(opts) {
        let where = 'WHERE 1=1';
        const params = [];
        if (opts?.cursor) {
            where += ' AND cursor_key > ?';
            params.push(opts.cursor);
        }
        const rows = this.db.prepare(`SELECT * FROM signals ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, opts?.limit ?? 50);
        return rows.map((r) => ({
            id: r.id,
            type: r.type,
            payload: JSON.parse(r.payload),
            createdAt: r.created_at,
            cursorKey: r.cursor_key,
        }));
    }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       WATCHLISTS
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    createWatchlist(name) {
        const info = this.db.prepare("INSERT INTO watchlists (name) VALUES (?)").run(name);
        return { id: Number(info.lastInsertRowid), name, createdAt: new Date().toISOString() };
    }
    listWatchlists() {
        const rows = this.db.prepare('SELECT * FROM watchlists ORDER BY created_at').all();
        return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
    }
    deleteWatchlist(id) {
        this.db.prepare('DELETE FROM watchlists WHERE id = ?').run(id);
    }
    addToWatchlist(watchlistId, whaleId) {
        this.db.prepare('INSERT OR IGNORE INTO watchlist_items (watchlist_id, whale_id) VALUES (?, ?)').run(watchlistId, whaleId);
    }
    removeFromWatchlist(watchlistId, whaleId) {
        this.db.prepare('DELETE FROM watchlist_items WHERE watchlist_id = ? AND whale_id = ?').run(watchlistId, whaleId);
    }
    getWatchlistItems(watchlistId) {
        const rows = this.db.prepare(`
      SELECT w.* FROM whales w
      JOIN watchlist_items wi ON wi.whale_id = w.id
      WHERE wi.watchlist_id = ?
      ORDER BY w.last_active_at DESC
    `).all(watchlistId);
        return rows.map((r) => this.rowToWhale(r));
    }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       SHADOW PORTFOLIOS
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    upsertShadowPortfolio(sp) {
        this.db.prepare(`
      INSERT INTO shadow_portfolios (whale_id, mode, positions, pnl_series, total_pnl, drawdown, last_updated)
      VALUES (?, 'paper', ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(whale_id) DO UPDATE SET
        positions = excluded.positions,
        pnl_series = excluded.pnl_series,
        total_pnl = excluded.total_pnl,
        drawdown = excluded.drawdown,
        last_updated = datetime('now')
    `).run(sp.whaleId, JSON.stringify(sp.positions), JSON.stringify(sp.pnlSeries), sp.totalPnl, sp.drawdown);
    }
    getShadowPortfolio(whaleId) {
        const row = this.db.prepare('SELECT * FROM shadow_portfolios WHERE whale_id = ?').get(whaleId);
        if (!row)
            return undefined;
        return {
            id: row.id,
            whaleId: row.whale_id,
            mode: 'paper',
            positions: JSON.parse(row.positions),
            pnlSeries: JSON.parse(row.pnl_series),
            totalPnl: row.total_pnl,
            drawdown: row.drawdown,
            lastUpdated: row.last_updated,
        };
    }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       AGGREGATION HELPERS
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    /** Sum realized PnL from settlement ledger */
    getSettledPnl(whaleId, sinceDate) {
        const where = sinceDate
            ? 'WHERE whale_id = ? AND close_ts >= ?'
            : 'WHERE whale_id = ?';
        const params = sinceDate ? [whaleId, sinceDate] : [whaleId];
        const row = this.db.prepare(`SELECT COALESCE(SUM(realized_pnl),0) as pnl FROM whale_settlement_ledger ${where}`).get(...params);
        return row.pnl;
    }
    /** Win rate from settlement ledger */
    getWinRate(whaleId) {
        const total = this.db.prepare('SELECT COUNT(*) as cnt FROM whale_settlement_ledger WHERE whale_id = ? AND close_ts IS NOT NULL').get(whaleId);
        if (total.cnt === 0)
            return 0;
        const wins = this.db.prepare('SELECT COUNT(*) as cnt FROM whale_settlement_ledger WHERE whale_id = ? AND close_ts IS NOT NULL AND realized_pnl > 0').get(whaleId);
        return wins.cnt / total.cnt;
    }
    /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       ROW CONVERTERS
       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
    rowToWhale(r) {
        return {
            id: r.id,
            address: r.address,
            displayName: r.display_name,
            starred: r.starred === 1,
            trackingEnabled: r.tracking_enabled === 1,
            tags: JSON.parse(r.tags || '[]'),
            notes: r.notes,
            style: r.style,
            dataIntegrity: r.data_integrity,
            copyMode: r.copy_mode,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            lastActiveAt: r.last_active_at,
            lastBackfillAt: r.last_backfill_at,
            lastTradeCursor: r.last_trade_cursor,
        };
    }
    rowToTrade(r) {
        return {
            id: r.id,
            whaleId: r.whale_id,
            tradeId: r.trade_id,
            logicalTradeGroupId: r.logical_trade_group_id,
            marketId: r.market_id,
            outcome: r.outcome,
            side: r.side,
            price: r.price,
            size: r.size,
            notionalUsd: r.notional_usd,
            feeUsd: r.fee_usd,
            isFeeEstimated: r.is_fee_estimated === 1,
            ts: r.ts,
            midpointAtFill: r.midpoint_at_fill,
            bestBidAtFill: r.best_bid_at_fill,
            bestAskAtFill: r.best_ask_at_fill,
            slippageBps: r.slippage_bps,
            aggressor: r.aggressor,
        };
    }
    rowToCandidate(r) {
        return {
            id: r.id,
            address: r.address,
            firstSeenAt: r.first_seen_at,
            lastSeenAt: r.last_seen_at,
            volumeUsd24h: r.volume_usd_24h,
            trades24h: r.trades_24h,
            maxSingleTradeUsd: r.max_single_trade_usd,
            markets7d: r.markets_7d,
            rankScore: r.rank_score,
            suggestedTags: JSON.parse(r.suggested_tags || '[]'),
            mutedUntil: r.muted_until,
            approved: r.approved === 1,
        };
    }
    rowToAlert(r) {
        return {
            id: r.id,
            whaleId: r.whale_id,
            type: r.type,
            payload: JSON.parse(r.payload || '{}'),
            createdAt: r.created_at,
            delivered: r.delivered === 1,
            readAt: r.read_at,
        };
    }
}
exports.WhaleDB = WhaleDB;
