"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionManager = void 0;
class PositionManager {
    constructor() {
        this.positions = new Map();
    }
    getPositions(walletId) {
        return this.positions.get(walletId) ?? [];
    }
    setPositions(walletId, positions) {
        this.positions.set(walletId, positions);
    }
}
exports.PositionManager = PositionManager;
