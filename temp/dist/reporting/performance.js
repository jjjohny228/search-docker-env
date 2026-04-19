"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeAllPerformance = computeAllPerformance;
const dashboard_api_1 = require("./dashboard_api");
function computeAllPerformance(wallets) {
    return wallets.map((w) => (0, dashboard_api_1.computePerformance)(w, [], 0));
}
