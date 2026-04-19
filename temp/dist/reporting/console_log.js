"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.consoleLog = void 0;
const events_1 = require("events");
const MAX_ENTRIES = 2000;
class ConsoleLogSingleton extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.buffer = [];
        this.seq = 0;
        this.sseClients = new Set();
    }
    /* ── Public API ─────────────────────────────────────────────── */
    log(level, category, message, data) {
        const entry = {
            id: ++this.seq,
            timestamp: Date.now(),
            level,
            category,
            message,
            data,
        };
        // Ring buffer
        this.buffer.push(entry);
        if (this.buffer.length > MAX_ENTRIES) {
            this.buffer.shift();
        }
        // Broadcast to SSE clients
        this.broadcast(entry);
        // EventEmitter for in-process listeners
        this.emit('entry', entry);
    }
    /* Convenience methods */
    debug(category, message, data) {
        this.log('DEBUG', category, message, data);
    }
    info(category, message, data) {
        this.log('INFO', category, message, data);
    }
    warn(category, message, data) {
        this.log('WARN', category, message, data);
    }
    error(category, message, data) {
        this.log('ERROR', category, message, data);
    }
    success(category, message, data) {
        this.log('SUCCESS', category, message, data);
    }
    /* ── Buffer access ──────────────────────────────────────────── */
    getEntries(limit = 500, offset = 0) {
        const start = Math.max(0, this.buffer.length - limit - offset);
        const end = this.buffer.length - offset;
        return this.buffer.slice(start, end);
    }
    getEntriesSince(sinceId) {
        const idx = this.buffer.findIndex((e) => e.id > sinceId);
        if (idx === -1)
            return [];
        return this.buffer.slice(idx);
    }
    getStats() {
        const byLevel = {};
        const byCategory = {};
        for (const e of this.buffer) {
            byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
            byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
        }
        return { total: this.buffer.length, byLevel, byCategory };
    }
    /* ── SSE (Server-Sent Events) ───────────────────────────────── */
    /** Handle an incoming SSE connection from the dashboard */
    addSSEClient(res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        // Send recent history as a burst so the client is immediately populated
        const recent = this.getEntries(200);
        for (const entry of recent) {
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
        }
        this.sseClients.add(res);
        res.on('close', () => {
            this.sseClients.delete(res);
        });
    }
    broadcast(entry) {
        const payload = `data: ${JSON.stringify(entry)}\n\n`;
        for (const client of this.sseClients) {
            try {
                client.write(payload);
            }
            catch {
                this.sseClients.delete(client);
            }
        }
    }
}
/** Global singleton */
exports.consoleLog = new ConsoleLogSingleton();
