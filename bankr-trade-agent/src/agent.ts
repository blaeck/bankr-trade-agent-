// ============================================================
// agent.ts — Main entry point and polling loop
//
// Usage:
//   npm run dev        — run in live mode
//   npm run dry-run    — simulate trades without executing
//   npm run build && npm start  — compiled production run
//
// Lifecycle:
//   startup → validate config + env → first cycle → schedule loop
//   each cycle: fetch prices → evaluate strategies → execute triggers → log
//   shutdown: SIGINT/SIGTERM → flush logs → exit 0
// ============================================================

import * as dotenv from 'dotenv';
dotenv.config(); // Must be before any other local imports that read process.env

import { loadConfig, } from './config';
import { fetchPrices } from './monitor';
import { evaluateStrategies, formatPriceStatus } from './strategy';
import { executeTrade } from './executor';
import { log } from './logger';
import { AgentConfig } from './types';
import chalk from 'chalk';

// ---- Poll interval (FIX M-5: parseInt can return NaN → infinite tight loop) ----
function resolvePollIntervalMs(): number {
  const raw = process.env.POLL_INTERVAL_SECONDS;
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;

  if (isNaN(parsed) || parsed < 5) {
    if (raw !== undefined && raw !== '') {
      process.stderr.write(
        `[bankr-agent] WARNING: POLL_INTERVAL_SECONDS="${raw}" is invalid. ` +
        `Using default of 30 seconds.\n`
      );
    }
    return 30_000;
  }

  return parsed * 1000;
}

const POLL_INTERVAL_MS = resolvePollIntervalMs();
const IS_DRY_RUN       = process.env.DRY_RUN === 'true';

// ---- Startup banner ----

function printBanner(config: AgentConfig): void {
  const mode = IS_DRY_RUN
    ? chalk.magenta('[DRY RUN — no real trades will execute]')
    : chalk.green('[LIVE MODE]');

  const enabledPairs = config.pairs.filter(p => p.enabled);

  console.log(chalk.bold.cyan(`
╔════════════════════════════════════════════════╗
║       Bankr Price Alert + Auto-Trade Agent     ║
║              Base Chain Edition                ║
╚════════════════════════════════════════════════╝
`));
  console.log(`  Mode:         ${mode}`);
  console.log(`  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Active pairs:  ${enabledPairs.map(p => p.token).join(', ') || 'none'}\n`);
}

// ---- Config + API key validation ----

/**
 * Load config and validate the API key, exiting with a clear message on failure.
 * FIX M-7: returning AgentConfig (never undefined) removes the uninitialized-variable
 * issue that caused TS2454 compile errors in the original try/catch pattern.
 */
function loadAndValidate(): AgentConfig {
  let config: AgentConfig;

  try {
    config = loadConfig();
  } catch (err) {
    log.error('Failed to load config.yaml', err);
    process.exit(1);
  }

  if (!IS_DRY_RUN) {
    const key = process.env.BANKR_API_KEY;
    if (!key || key.trim() === '' || key === 'your_bankr_api_key_here') {
      log.error('BANKR_API_KEY is not set.');
      console.log(chalk.yellow(
        '\n  1. Copy the template:   cp .env.example .env' +
        '\n  2. Get your key at:     https://bankr.bot/api' +
        '\n  3. Add it to .env:      BANKR_API_KEY=your_key_here' +
        '\n  Or test without a key:  npm run dry-run\n'
      ));
      process.exit(1);
    }
  }

  return config;
}

// ---- Main polling cycle ----

/**
 * Execute one full polling cycle:
 *   1. Fetch current prices for all enabled pairs
 *   2. Log the price status table
 *   3. Evaluate all strategies against current prices
 *   4. Execute any triggered strategies sequentially
 */
async function runCycle(config: AgentConfig): Promise<void> {
  const cycleStart = Date.now();

  try {
    // 1. Fetch prices (batched single request)
    const prices = await fetchPrices(config.pairs);

    if (prices.size === 0) {
      log.warn('No price data available this cycle — skipping strategy evaluation.');
      return;
    }

    // 2. Log current prices and strategy targets
    log.info(`Prices:\n${formatPriceStatus(config, prices)}`);

    // 3. Evaluate strategies
    const triggers = evaluateStrategies(config, prices);

    if (triggers.length === 0) {
      log.debug('No strategies triggered this cycle.');
      return;
    }

    log.info(`${triggers.length} strategy trigger(s) — executing...`);

    // 4. Execute sequentially (prevents concurrent trades on the same pair)
    for (const trigger of triggers) {
      const record = await executeTrade(trigger, config.settings);
      log.trade(record);
    }

  } catch (err) {
    // Top-level catch: log and continue — a single bad cycle must not stop the agent
    log.error('Unexpected error in polling cycle', err);
  } finally {
    log.debug(`Cycle complete in ${Date.now() - cycleStart}ms`);
  }
}

// ---- Graceful shutdown ----

let isRunning = true;
let cycleTimer: NodeJS.Timeout | undefined;

function shutdown(signal: string): void {
  if (!isRunning) return; // prevent double-invocation
  isRunning = false;
  log.info(`Received ${signal} — shutting down gracefully...`);
  if (cycleTimer) clearTimeout(cycleTimer);
  log.info('Agent stopped. State and logs are up to date.');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Catch unhandled promise rejections to prevent silent failures
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', reason);
});

// ---- Entry point ----

async function main(): Promise<void> {
  // Load config (exits on failure — never returns undefined)
  const config = loadAndValidate();

  printBanner(config);

  const enabledCount = config.pairs.filter(p => p.enabled).length;
  log.info(`Config loaded. ${enabledCount} enabled pair(s). Polling every ${POLL_INTERVAL_MS / 1000}s.`);
  log.info('Press Ctrl+C to stop.\n');

  // Run the first cycle immediately, then schedule subsequent cycles
  await runCycle(config);

  // Recursive setTimeout loop (vs setInterval) ensures cycles never overlap:
  // the next cycle is only scheduled AFTER the current one completes.
  function scheduleNext(): void {
    if (!isRunning) return;
    cycleTimer = setTimeout(async () => {
      await runCycle(config);
      scheduleNext();
    }, POLL_INTERVAL_MS);
  }

  scheduleNext();
}

main().catch(err => {
  log.error('Fatal startup error', err);
  process.exit(1);
});
