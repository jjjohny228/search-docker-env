"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const yaml_1 = __importDefault(require("yaml"));
const config_loader_1 = require("./core/config_loader");
const wallet_manager_1 = require("./wallets/wallet_manager");
const kill_switch_1 = require("./risk/kill_switch");
const risk_engine_1 = require("./risk/risk_engine");
const trade_executor_1 = require("./execution/trade_executor");
const order_router_1 = require("./execution/order_router");
const engine_1 = require("./core/engine");
const registry_1 = require("./strategies/registry");
const performance_1 = require("./reporting/performance");
const logs_1 = require("./reporting/logs");
const dashboard_server_1 = require("./reporting/dashboard_server");
const whale_service_1 = require("./whales/whale_service");
const whale_api_1 = require("./whales/whale_api");
const whale_types_1 = require("./whales/whale_types");
const program = new commander_1.Command();
const statePath = path_1.default.resolve('.runtime/state.json');
/* ── Config normalization helpers ── */
/** Convert a snake_case string to camelCase */
function snakeToCamel(s) {
    return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}
/** Recursively convert all snake_case keys in a plain object to camelCase */
function deepSnakeToCamel(obj) {
    if (Array.isArray(obj))
        return obj.map(deepSnakeToCamel);
    if (obj !== null && typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            out[snakeToCamel(k)] = deepSnakeToCamel(v);
        }
        return out;
    }
    return obj;
}
/**
 * YAML scanner config uses human-friendly key names that differ from the
 * TypeScript ScannerConfig property names.  This explicit mapping handles
 * both the legacy snake_case YAML keys and any naming divergences.
 */
const SCANNER_KEY_MAP = {
    // Direct camelCase matches (new YAML format)
    enabled: 'enabled',
    scanIntervalMs: 'scanIntervalMs',
    marketsPerScan: 'marketsPerScan',
    minMarketLiquidityUsd: 'minMarketLiquidityUsd',
    minMarketVolume24hUsd: 'minMarketVolume24hUsd',
    tradesPerMarket: 'tradesPerMarket',
    tradePageDepth: 'tradePageDepth',
    minAddressVolumeUsd: 'minAddressVolumeUsd',
    minAddressTrades: 'minAddressTrades',
    minWinRate: 'minWinRate',
    minRoi: 'minRoi',
    autoPromoteMinScore: 'autoPromoteMinScore',
    autoPromoteEnabled: 'autoPromoteEnabled',
    autoPromoteMaxPerScan: 'autoPromoteMaxPerScan',
    bigTradeMinUsd: 'bigTradeMinUsd',
    crossRefEnabled: 'crossRefEnabled',
    crossRefMaxPerBatch: 'crossRefMaxPerBatch',
    clusterDetectionEnabled: 'clusterDetectionEnabled',
    clusterMinWhales: 'clusterMinWhales',
    clusterWindowHours: 'clusterWindowHours',
    parallelFetchBatch: 'parallelFetchBatch',
    // Legacy snake_case → camelCase aliases (backward compat)
    scanIntervalMs_: 'scanIntervalMs', // auto-converted snake hits this
    topMarketsCount: 'marketsPerScan',
    minMarketVolumeUsd: 'minMarketVolume24hUsd',
    tradesPerMarketLimit: 'tradesPerMarket',
    minWhaleTrades: 'minAddressTrades',
    minWhaleVolumeUsd: 'minAddressVolumeUsd',
    minWhaleWinRate: 'minWinRate',
    minWhaleRoi: 'minRoi',
    autoTrackEnabled: 'autoPromoteEnabled',
    autoTrackMinScore: 'autoPromoteMinScore',
    autoTrackMaxPerScan: 'autoPromoteMaxPerScan',
};
/** Normalise a raw YAML scanner object into a proper ScannerConfig */
function normaliseScannerConfig(raw) {
    // First convert any remaining snake_case keys to camelCase
    const camelRaw = deepSnakeToCamel(raw);
    const out = { ...whale_types_1.DEFAULT_SCANNER_CONFIG };
    for (const [key, value] of Object.entries(camelRaw)) {
        const mapped = SCANNER_KEY_MAP[key];
        if (mapped) {
            out[mapped] = value;
        }
    }
    /* ── Deep-merge nested config objects ── */
    // apiPool
    const apiPoolRaw = (camelRaw.apiPool ?? {});
    out.apiPool = {
        ...whale_types_1.DEFAULT_API_POOL_CONFIG,
        ...apiPoolRaw,
        endpoints: Array.isArray(apiPoolRaw.endpoints) ? apiPoolRaw.endpoints : whale_types_1.DEFAULT_API_POOL_CONFIG.endpoints,
    };
    // fastScan
    const fastScanRaw = (camelRaw.fastScan ?? {});
    out.fastScan = { ...whale_types_1.DEFAULT_FAST_SCAN_CONFIG, ...fastScanRaw };
    // exchangeSources
    if (Array.isArray(camelRaw.exchangeSources)) {
        out.exchangeSources = camelRaw.exchangeSources;
    }
    else {
        out.exchangeSources = [...whale_types_1.DEFAULT_EXCHANGE_SOURCES];
    }
    // Simple scalar fields that pass through unchanged
    if (camelRaw.backfillDays !== undefined)
        out.backfillDays = camelRaw.backfillDays;
    if (camelRaw.polygonRpcUrl !== undefined)
        out.polygonRpcUrl = camelRaw.polygonRpcUrl;
    if (camelRaw.usdcContractAddress !== undefined)
        out.usdcContractAddress = camelRaw.usdcContractAddress;
    if (camelRaw.networkGraphEnabled !== undefined)
        out.networkGraphEnabled = camelRaw.networkGraphEnabled;
    if (camelRaw.copySimEnabled !== undefined)
        out.copySimEnabled = camelRaw.copySimEnabled;
    if (camelRaw.copySimSlippageBps !== undefined)
        out.copySimSlippageBps = camelRaw.copySimSlippageBps;
    if (camelRaw.copySimDelaySeconds !== undefined)
        out.copySimDelaySeconds = camelRaw.copySimDelaySeconds;
    if (camelRaw.regimeAdaptiveEnabled !== undefined)
        out.regimeAdaptiveEnabled = camelRaw.regimeAdaptiveEnabled;
    return out;
}
/** Deep-merge a YAML whale_tracking block into WhaleTrackingConfig defaults */
function buildWhaleConfig(raw) {
    // Convert top-level snake_case keys
    const camelRaw = deepSnakeToCamel(raw);
    // Extract and normalise nested objects before the shallow merge
    const scannerRaw = (camelRaw.scanner ?? {});
    delete camelRaw.scanner;
    const copyRaw = (camelRaw.copy ?? {});
    delete camelRaw.copy;
    const scoreWeightsRaw = (camelRaw.scoreWeights ?? {});
    delete camelRaw.scoreWeights;
    return {
        ...whale_types_1.DEFAULT_WHALE_CONFIG,
        ...camelRaw,
        scoreWeights: { ...whale_types_1.DEFAULT_WHALE_CONFIG.scoreWeights, ...scoreWeightsRaw },
        copy: { ...whale_types_1.DEFAULT_WHALE_CONFIG.copy, ...copyRaw },
        scanner: normaliseScannerConfig(scannerRaw),
    };
}
function writeState(state) {
    fs_1.default.mkdirSync(path_1.default.dirname(statePath), { recursive: true });
    fs_1.default.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
function readState() {
    if (!fs_1.default.existsSync(statePath)) {
        return { status: 'stopped' };
    }
    return JSON.parse(fs_1.default.readFileSync(statePath, 'utf8'));
}
program
    .name('bot')
    .description('Polymarket multi-strategy trading platform')
    .version('0.1.0');
program
    .command('start')
    .description('Start the trading engine')
    .option('-c, --config <path>', 'Config path', 'config.yaml')
    .action(async (options) => {
    const config = (0, config_loader_1.loadConfig)(options.config);
    const walletManager = new wallet_manager_1.WalletManager();
    for (const wallet of config.wallets) {
        walletManager.registerWallet(wallet, wallet.strategy, config.environment.enableLiveTrading);
    }
    const dashboardPort = Number(process.env.DASHBOARD_PORT ?? 3000);
    const dashboardServer = new dashboard_server_1.DashboardServer(walletManager, dashboardPort);
    /* ── Whale Tracking Engine ── */
    const rawConfig = yaml_1.default.parse(fs_1.default.readFileSync(options.config, 'utf8'));
    const whaleConfigRaw = (rawConfig.whale_tracking ?? {});
    const whaleConfig = buildWhaleConfig(whaleConfigRaw);
    logs_1.logger.info({
        scannerEnabled: whaleConfig.scanner.enabled,
        marketsPerScan: whaleConfig.scanner.marketsPerScan,
        minLiquidity: whaleConfig.scanner.minMarketLiquidityUsd,
        minVolume24h: whaleConfig.scanner.minMarketVolume24hUsd,
    }, 'Whale config loaded');
    if (whaleConfig.enabled) {
        const clobApi = config.polymarket?.clobApi ?? 'https://clob.polymarket.com';
        const gammaApi = config.polymarket?.gammaApi ?? 'https://gamma-api.polymarket.com';
        const whaleService = new whale_service_1.WhaleService(whaleConfig, clobApi, gammaApi);
        const whaleApi = new whale_api_1.WhaleAPI(whaleService);
        dashboardServer.setWhaleApi(whaleApi);
        whaleService.start();
        logs_1.logger.info('Whale Tracking Engine active');
    }
    dashboardServer.start();
    const killSwitch = new kill_switch_1.KillSwitch();
    const riskEngine = new risk_engine_1.RiskEngine(killSwitch);
    const orderRouter = new order_router_1.OrderRouter(walletManager, riskEngine, new trade_executor_1.TradeExecutor());
    const engine = new engine_1.Engine(config, walletManager, orderRouter);
    await engine.initialize();
    dashboardServer.setEngine(engine);
    engine.start();
    writeState({ status: 'running', startedAt: new Date().toISOString() });
});
program
    .command('stop')
    .description('Stop the trading engine')
    .action(() => {
    writeState({ status: 'stopped', stoppedAt: new Date().toISOString() });
    logs_1.logger.info('Engine stop requested');
});
program
    .command('status')
    .description('Get engine status')
    .action(() => {
    logs_1.logger.info(readState());
});
program
    .command('list-strategies')
    .description('List available strategies')
    .action(() => {
    logs_1.logger.info({ strategies: (0, registry_1.listStrategies)() });
});
program
    .command('performance')
    .description('Show performance snapshot')
    .option('-c, --config <path>', 'Config path', 'config.yaml')
    .action((options) => {
    const config = (0, config_loader_1.loadConfig)(options.config);
    const walletManager = new wallet_manager_1.WalletManager();
    for (const wallet of config.wallets) {
        walletManager.registerWallet(wallet, wallet.strategy, config.environment.enableLiveTrading);
    }
    logs_1.logger.info((0, performance_1.computeAllPerformance)(walletManager.listWallets()));
});
program
    .command('paper-report')
    .description('Show paper trading report')
    .option('-c, --config <path>', 'Config path', 'config.yaml')
    .action((options) => {
    const config = (0, config_loader_1.loadConfig)(options.config);
    const walletManager = new wallet_manager_1.WalletManager();
    for (const wallet of config.wallets) {
        walletManager.registerWallet(wallet, wallet.strategy, config.environment.enableLiveTrading);
    }
    logs_1.logger.info({ paperWallets: walletManager.listWallets().filter((w) => w.mode === 'PAPER') });
});
program
    .command('add-wallet')
    .description('Add a wallet to the config file')
    .requiredOption('--id <id>', 'Wallet id')
    .requiredOption('--strategy <strategy>', 'Strategy name')
    .option('--mode <mode>', 'Trading mode (PAPER|LIVE)', 'PAPER')
    .option('--capital <capital>', 'Capital allocation', '0')
    .option('-c, --config <path>', 'Config path', 'config.yaml')
    .action((options) => {
    const raw = fs_1.default.readFileSync(options.config, 'utf8');
    const parsed = yaml_1.default.parse(raw);
    parsed.wallets = parsed.wallets ?? [];
    parsed.wallets.push({
        id: options.id,
        mode: options.mode,
        strategy: options.strategy,
        capital: Number(options.capital),
    });
    fs_1.default.writeFileSync(options.config, yaml_1.default.stringify(parsed));
    logs_1.logger.info({ walletId: options.id }, 'Wallet added');
});
program
    .command('remove-wallet')
    .description('Remove a wallet from the config file')
    .requiredOption('--id <id>', 'Wallet id')
    .option('-c, --config <path>', 'Config path', 'config.yaml')
    .action((options) => {
    const raw = fs_1.default.readFileSync(options.config, 'utf8');
    const parsed = yaml_1.default.parse(raw);
    parsed.wallets = (parsed.wallets ?? []).filter((wallet) => wallet.id !== options.id);
    fs_1.default.writeFileSync(options.config, yaml_1.default.stringify(parsed));
    logs_1.logger.info({ walletId: options.id }, 'Wallet removed');
});
program.parseAsync(process.argv);
