// ============================================================
// status.ts — CLI status dashboard
//
// Usage:  npm run status
//
// Displays a snapshot of the agent's current state:
//   - All configured pairs and their strategies
//   - Daily trade counter vs. limit
//   - Per-pair cooldown remaining time
//   - Pending/in-flight job locks
//   - Last 10 trades from the trade log
// ============================================================

import * as dotenv from 'dotenv';
dotenv.config();

import { loadConfig } from './config';
import { getFullState, getStrategyExecutionCount, cooldownRemaining } from './state';
import { readTrades } from './logger';
import { AgentConfig } from './types';
import chalk from 'chalk';

/**
 * Main status display function.
 * Reads config, state, and trade log — all read-only operations.
 */
function main(): void {
  // ---- Load config ----
  let config: AgentConfig;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`\n✗ Cannot load config: ${msg}`));
    console.log(chalk.yellow('  Run:  cp config.example.yaml config.yaml\n'));
    process.exit(1);
  }

  const state  = getFullState();
  const trades = readTrades();

  console.log(chalk.bold.cyan('\n══════════════ Bankr Trade Agent Status ══════════════\n'));

  // ---- Configured pairs and strategies ----
  console.log(chalk.bold('CONFIGURED PAIRS'));
  console.log(chalk.gray('─'.repeat(54)));

  for (const pair of config.pairs) {
    const statusBadge = pair.enabled
      ? chalk.green('● ACTIVE  ')
      : chalk.gray('○ disabled');

    console.log(`  ${statusBadge}  ${chalk.bold(pair.token)}/${pair.base_token}  ${chalk.gray(`(${pair.id})`)}`);

    for (const [i, strat] of pair.strategies.entries()) {
      const execCount = getStrategyExecutionCount(pair.id, i);
      const maxStr    = strat.max_executions ? `/${strat.max_executions}` : '';
      const isExhausted = strat.max_executions != null && execCount >= strat.max_executions;
      const countLabel  = isExhausted
        ? chalk.red(` [executed: ${execCount}${maxStr} — EXHAUSTED]`)
        : chalk.gray(` [executed: ${execCount}${maxStr}]`);

      const arrow = (strat.type === 'limit_buy' || strat.type === 'stop_loss') ? '▼' : '▲';
      console.log(
        `      ${arrow} ${strat.type.padEnd(14)} ` +
        `@ $${String(strat.trigger_price).padEnd(10)} ` +
        `$${strat.amount_usd} USD` +
        countLabel
      );
    }
  }

  // ---- Daily trade counter ----
  console.log(chalk.bold('\nDAILY TRADES'));
  console.log(chalk.gray('─'.repeat(54)));
  const dailyUsed = state.total_daily_trades;
  const dailyMax  = config.settings.max_daily_trades;
  const dailyBar  = dailyUsed >= dailyMax
    ? chalk.red(`${dailyUsed} / ${dailyMax}  ⚠ limit reached`)
    : chalk.green(`${dailyUsed} / ${dailyMax}`);
  console.log(`  Today: ${dailyBar}  ${chalk.gray(`(resets UTC midnight)`)}`);

  // ---- Cooldown status ----
  console.log(chalk.bold('\nCOOLDOWN & LOCK STATUS'));
  console.log(chalk.gray('─'.repeat(54)));

  for (const pair of config.pairs.filter(p => p.enabled)) {
    const ps = state.pairs[pair.id];

    // Cooldown
    const remaining = cooldownRemaining(pair.id, pair.cooldown_seconds);
    const coolLabel = remaining > 0
      ? chalk.yellow(`cooling down  (${Math.round(remaining)}s remaining)`)
      : chalk.green('ready');

    // In-flight job lock
    const lockLabel = ps?.pending_job_id
      ? chalk.red(`  ⚠ pending job: ${ps.pending_job_id}`)
      : '';

    console.log(`  ${pair.id.padEnd(22)} ${coolLabel}${lockLabel}`);
  }

  // ---- Recent trades ----
  console.log(chalk.bold('\nRECENT TRADES  (last 10)'));
  console.log(chalk.gray('─'.repeat(54)));

  if (trades.length === 0) {
    console.log(chalk.gray('  No trades recorded yet.'));
  } else {
    const recent = trades.slice(-10).reverse();
    for (const t of recent) {
      const statusColor =
        t.status === 'executed' ? chalk.green  :
        t.status === 'dry_run'  ? chalk.magenta :
        t.status === 'failed'   ? chalk.red     :
                                  chalk.yellow;

      const txStr = t.tx_hash
        ? chalk.gray(` TX: ${t.tx_hash.slice(0, 20)}…`)
        : '';

      console.log(
        `  ${statusColor(t.status.padEnd(10))}` +
        `  ${chalk.gray(t.timestamp.slice(0, 19))}` +
        `  ${t.token.padEnd(8)}` +
        `  ${t.strategy_type.padEnd(14)}` +
        `  $${t.executed_price.toFixed(2).padStart(10)}` +
        `  $${t.amount_usd} USD` +
        txStr
      );
    }
  }

  // ---- File paths ----
  console.log(chalk.bold('\nLOG FILES'));
  console.log(chalk.gray('─'.repeat(54)));
  console.log(`  ${chalk.cyan('logs/trades.jsonl')}   Append-only trade history (JSONL)`);
  console.log(`  ${chalk.cyan('logs/agent.log')}      Application log`);
  console.log(`  ${chalk.cyan('state.json')}          Live agent state (cooldowns, locks)\n`);
}

main();
