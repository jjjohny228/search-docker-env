"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Scheduler = void 0;
const logs_1 = require("../reporting/logs");
class Scheduler {
    constructor(intervalMs = 5000) {
        this.intervalMs = intervalMs;
    }
    start(handler) {
        if (this.timer)
            return;
        this.timer = setInterval(async () => {
            try {
                await handler();
            }
            catch (error) {
                logs_1.logger.error({ error }, 'Scheduler tick failed');
            }
        }, this.intervalMs);
        logs_1.logger.info({ intervalMs: this.intervalMs }, 'Scheduler started');
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
            logs_1.logger.info('Scheduler stopped');
        }
    }
}
exports.Scheduler = Scheduler;
