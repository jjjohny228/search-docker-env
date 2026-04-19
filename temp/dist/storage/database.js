"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Database = void 0;
class Database {
    constructor() {
        this.wallets = [];
    }
    async connect() {
        return;
    }
    async saveWallets(wallets) {
        this.wallets = wallets.map((wallet) => ({ ...wallet }));
    }
    async loadWallets() {
        return this.wallets.map((wallet) => ({ ...wallet }));
    }
}
exports.Database = Database;
