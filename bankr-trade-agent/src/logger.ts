// ============================================================
// logger.ts — Console + file logging for the agent
//
// Provides structured, leveled logging to both console (colored)
// and append-only files in the logs/ directory.
// Trade records are written to trades.jsonl as newline-delimited JSON.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { TradeRecord } from './types';

const LOG_DIR        = path.resolve(process.cwd(), 'logs');
const TRADE_LOG_PATH = path.join(LOG_DIR, 'trades.jsonl');
const APP_LOG_PATH   = path.join(LOG_DIR, 'agent.log');

// FIX m-3: top-level mkdir was unguarded — wrap in try/catch so a permissions
// failure degrades gracefully (console-only logging) instead of crashing at import.
let fileLoggingAvailable = true;
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (err) {
  fileLoggingAvailable = false;
  process.stderr.write(
    `[bankr-agent] WARNING: Could not create logs/ directory. ` +
    `File logging disabled. Reason: ${err instanceof Error ? err.message : String(err)}\n`
  );
}

// ---- Log level setup ----

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const VALID_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

/**
 * Resolve and cache the minimum log level at module init.
 * FIX m-2: previously re-read process.env on every log call;
 *          also now validates the value and falls back to 'info'.
 */
function resolveMinLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw && VALID_LEVELS.includes(raw as LogLevel)) {
    return raw as LogLevel;
  }
  if (raw && raw !== '') {
    // Invalid value — warn once to stderr so it isn't silently ignored
    process.stderr.write(
      `[bankr-agent] WARNING: Invalid LOG_LEVEL="${process.env.LOG_LEVEL}". ` +
      `Valid values: ${VALID_LEVELS.join(', ')}. Defaulting to "info".\n`
    );
  }
  return 'info';
}

// Cached at startup — changing LOG_LEVEL at runtime requires a restart.
const MIN_LEVEL_PRIORITY = LEVEL_PRIORITY[resolveMinLevel()];

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= MIN_LEVEL_PRIORITY;
}

// ---- Timestamp helper ----

function ts(): string {
  return new Date().toISOString();
}

// ---- File write helper ----

function writeToFile(line: string): void {
  if (!fileLoggingAvailable) return;
  try {
    fs.appendFileSync(APP_LOG_PATH, line + '\n', 'utf-8');
  } catch {
    // Silently ignore file write failures at runtime — never crash the agent over logging
  }
}

// ---- Public log object ----

export const log = {
  debug(msg: string, ...args: unknown[]): void {
    if (!shouldLog('debug')) return;
    const line = `[${ts()}] DEBUG ${msg}${args.length ? ' ' + JSON.stringify(args) : ''}`;
    console.log(chalk.gray(line));
    writeToFile(line);
  },

  info(msg: string, ...args: unknown[]): void {
    if (!shouldLog('info')) return;
    const line = `[${ts()}] INFO  ${msg}${args.length ? ' ' + JSON.stringify(args) : ''}`;
    console.log(chalk.cyan(line));
    writeToFile(line);
  },

  warn(msg: string, ...args: unknown[]): void {
    if (!shouldLog('warn')) return;
    const line = `[${ts()}] WARN  ${msg}${args.length ? ' ' + JSON.stringify(args) : ''}`;
    console.log(chalk.yellow(line));
    writeToFile(line);
  },

  error(msg: string, err?: unknown): void {
    if (!shouldLog('error')) return;
    const detail = err instanceof Error ? err.message : String(err ?? '');
    const line = `[${ts()}] ERROR ${msg}${detail ? ' ' + detail : ''}`;
    console.log(chalk.red(line));
    writeToFile(line);
  },

  /**
   * Log a completed trade record to both console and the append-only JSONL trade log.
   * Always writes to file regardless of LOG_LEVEL — trade records are audit data.
   */
  trade(record: TradeRecord): void {
    const statusColor =
      record.status === 'executed' ? chalk.green  :
      record.status === 'dry_run'  ? chalk.magenta :
      record.status === 'failed'   ? chalk.red     :
                                     chalk.yellow;

    const lines = [
      `\n${'─'.repeat(60)}`,
      `🔔 TRADE ${record.status.toUpperCase()} | ${record.timestamp}`,
      `   Pair:      ${record.pair_id}`,
      `   Strategy:  ${record.strategy_type} (${record.direction.toUpperCase()})`,
      `   Token:     ${record.token}`,
      `   Price:     $${record.executed_price.toFixed(4)} (trigger: $${record.trigger_price})`,
      `   Amount:    $${record.amount_usd} USD`,
      record.tx_hash ? `   TX Hash:   ${record.tx_hash}` : '',
      record.error   ? `   Error:     ${record.error}`   : '',
      record.note    ? `   Note:      ${record.note}`    : '',
      `${'─'.repeat(60)}\n`,
    ].filter(Boolean).join('\n');

    console.log(statusColor(lines));
    writeToFile(lines);

    // Append to JSONL trade log — append-only, never truncates
    if (!fileLoggingAvailable) return;
    try {
      fs.appendFileSync(TRADE_LOG_PATH, JSON.stringify(record) + '\n', 'utf-8');
    } catch (err) {
      // Log to console if we can't write to file — trade data is critical
      console.error(chalk.red(`[ERROR] Failed to write trade to ${TRADE_LOG_PATH}:`), err);
    }
  },
};

/**
 * Read all trade records from the JSONL log file.
 * FIX M-4: previously crashed on any malformed line; now skips bad lines with a warning.
 *
 * @returns Array of parsed TradeRecord objects (corrupt lines are skipped).
 */
export function readTrades(): TradeRecord[] {
  if (!fs.existsSync(TRADE_LOG_PATH)) return [];

  const raw = fs.readFileSync(TRADE_LOG_PATH, 'utf-8').trim();
  if (!raw) return [];

  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const records: TradeRecord[] = [];
  let skipped = 0;

  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as TradeRecord);
    } catch {
      skipped++;
    }
  }

  if (skipped > 0) {
    log.warn(`readTrades: skipped ${skipped} malformed line(s) in ${TRADE_LOG_PATH}`);
  }

  return records;
}

export { TRADE_LOG_PATH };
