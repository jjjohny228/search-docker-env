"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletManager = void 0;
const paper_wallet_1 = require("./paper_wallet");
const polymarket_wallet_1 = require("./polymarket_wallet");
const logs_1 = require("../reporting/logs");
class WalletManager {
    constructor() {
        this.wallets = new Map();
    }
    registerWallet(config, assignedStrategy, enableLive) {
        if (this.wallets.has(config.id)) {
            throw new Error(`Wallet ${config.id} already registered`);
        }
        if (config.mode === 'LIVE' && !enableLive) {
            logs_1.logger.warn({ walletId: config.id }, 'LIVE trading requested but ENABLE_LIVE_TRADING is false; refusing LIVE wallet');
            return;
        }
        const wallet = config.mode === 'LIVE'
            ? new polymarket_wallet_1.PolymarketWallet(config, assignedStrategy)
            : new paper_wallet_1.PaperWallet(config, assignedStrategy);
        this.wallets.set(config.id, wallet);
        const state = wallet.getState();
        logs_1.logger.info({ walletId: state.walletId, mode: state.mode, strategy: state.assignedStrategy, capital: state.capitalAllocated }, `Registered wallet ${state.walletId} (${state.mode}) strategy=${state.assignedStrategy}`);
    }
    getWallet(walletId) {
        return this.wallets.get(walletId);
    }
    listWallets() {
        return Array.from(this.wallets.values()).map((wallet) => wallet.getState());
    }
    getTradeHistory(walletId) {
        const wallet = this.wallets.get(walletId);
        if (!wallet)
            return [];
        return wallet.getTradeHistory();
    }
    getAllTradeHistories() {
        const map = new Map();
        for (const [id, wallet] of this.wallets) {
            map.set(id, wallet.getTradeHistory());
        }
        return map;
    }
    removeWallet(walletId) {
        if (!this.wallets.has(walletId)) {
            return false;
        }
        this.wallets.delete(walletId);
        logs_1.logger.info({ walletId }, `Wallet ${walletId} removed`);
        return true;
    }
    registerExternalWallet(walletId, wallet) {
        if (this.wallets.has(walletId)) {
            throw new Error(`Wallet ${walletId} already registered`);
        }
        this.wallets.set(walletId, wallet);
    }
    addWallet(wallet) {
        const state = wallet.getState();
        if (this.wallets.has(state.walletId)) {
            throw new Error(`Wallet ${state.walletId} already registered`);
        }
        this.wallets.set(state.walletId, wallet);
        logs_1.logger.info({ walletId: state.walletId, mode: state.mode, strategy: state.assignedStrategy, capital: state.capitalAllocated }, `Wallet ${state.walletId} added at runtime (${state.mode}) strategy=${state.assignedStrategy}`);
    }
}
exports.WalletManager = WalletManager;
