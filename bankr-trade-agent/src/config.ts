// ============================================================
// config.ts — Load and validate agent configuration
//
// Reads config.yaml, applies defaults for optional fields, and
// throws descriptive errors for any invalid or missing values
// before the agent loop ever starts.
// ============================================================

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import { AgentConfig } from './types';

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'config.yaml');

/**
 * Load and fully validate the agent configuration from a YAML file.
 * Applies sensible defaults for optional fields.
 * Throws a descriptive Error if anything is missing or invalid.
 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): AgentConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config file not found at: ${configPath}\n` +
      `Run:  cp config.example.yaml config.yaml  then customize your strategies.`
    );
  }

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    parsed = yaml.load(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config.yaml: ${msg}`);
  }

  const config = parsed as AgentConfig;
  validateConfig(config);
  return config;
}

// ---- Private validation helpers ----

function validateConfig(config: AgentConfig): void {
  if (!config || typeof config !== 'object') {
    throw new Error('Config: file is empty or not valid YAML');
  }

  if (!config.pairs || !Array.isArray(config.pairs)) {
    throw new Error('Config: top-level "pairs" key must be a list');
  }

  if (config.pairs.length === 0) {
    throw new Error('Config: "pairs" list is empty — define at least one trading pair');
  }

  const seenIds = new Set<string>();

  for (const pair of config.pairs) {
    // ---- Required identity fields ----
    if (!pair.id || typeof pair.id !== 'string') {
      throw new Error('Config: every pair must have a non-empty string "id"');
    }
    if (seenIds.has(pair.id)) {
      throw new Error(`Config: duplicate pair id "${pair.id}" — each id must be unique`);
    }
    seenIds.add(pair.id);

    if (!pair.token || typeof pair.token !== 'string') {
      throw new Error(`Config pair "${pair.id}": missing or invalid "token" (e.g. "ETH")`);
    }

    // FIX M-3: base_token was never validated — silent bad prompts to Bankr
    if (!pair.base_token || typeof pair.base_token !== 'string') {
      throw new Error(`Config pair "${pair.id}": missing or invalid "base_token" (e.g. "USDC")`);
    }

    if (!pair.coingecko_id || typeof pair.coingecko_id !== 'string') {
      throw new Error(`Config pair "${pair.id}": missing "coingecko_id" (e.g. "ethereum")`);
    }
    if (!pair.chain || typeof pair.chain !== 'string') {
      throw new Error(`Config pair "${pair.id}": missing "chain" — must be "base"`);
    }

    // ---- Defaults for optional scalar fields ----
    if (pair.enabled === undefined || pair.enabled === null) {
      pair.enabled = false; // default to disabled for safety
    }

    // FIX M-3: cooldown_seconds was validated with `< 0` but undefined passes that check silently
    if (pair.cooldown_seconds === undefined || pair.cooldown_seconds === null) {
      pair.cooldown_seconds = 0; // default: no cooldown
    } else if (typeof pair.cooldown_seconds !== 'number' || isNaN(pair.cooldown_seconds)) {
      throw new Error(`Config pair "${pair.id}": "cooldown_seconds" must be a number`);
    } else if (pair.cooldown_seconds < 0) {
      throw new Error(`Config pair "${pair.id}": "cooldown_seconds" must be >= 0`);
    }

    // ---- Strategies ----
    // FIX M-2: strategies was never validated for existence or minimum length
    if (!pair.strategies || !Array.isArray(pair.strategies)) {
      throw new Error(
        `Config pair "${pair.id}": "strategies" must be a list. ` +
        `Add at least one strategy (limit_buy, limit_sell, take_profit, or stop_loss).`
      );
    }
    if (pair.strategies.length === 0) {
      throw new Error(
        `Config pair "${pair.id}": "strategies" list is empty — add at least one strategy`
      );
    }

    for (const [i, strat] of pair.strategies.entries()) {
      const loc = `Config pair "${pair.id}" strategy[${i}]`;

      const validTypes = ['limit_buy', 'limit_sell', 'take_profit', 'stop_loss'];
      if (!strat.type || !validTypes.includes(strat.type)) {
        throw new Error(
          `${loc}: invalid type "${strat.type ?? '(missing)'}". ` +
          `Must be one of: ${validTypes.join(', ')}`
        );
      }
      if (typeof strat.trigger_price !== 'number' || isNaN(strat.trigger_price) || strat.trigger_price <= 0) {
        throw new Error(`${loc}: "trigger_price" must be a positive number`);
      }
      if (typeof strat.amount_usd !== 'number' || isNaN(strat.amount_usd) || strat.amount_usd <= 0) {
        throw new Error(`${loc}: "amount_usd" must be a positive number`);
      }
      if (strat.max_executions !== undefined) {
        if (
          typeof strat.max_executions !== 'number' ||
          strat.max_executions < 1 ||
          !Number.isInteger(strat.max_executions)
        ) {
          throw new Error(`${loc}: "max_executions" must be a positive integer`);
        }
      }
    }
  }

  // ---- Apply settings defaults ----
  if (!config.settings || typeof config.settings !== 'object') {
    config.settings = {
      max_daily_trades: 20,
      price_deviation_threshold: 0.05,
      job_poll_timeout_ms: 120000,
      job_poll_interval_ms: 2000,
    };
  } else {
    config.settings.max_daily_trades        ??= 20;
    config.settings.price_deviation_threshold ??= 0.05;
    config.settings.job_poll_timeout_ms      ??= 120000;
    config.settings.job_poll_interval_ms     ??= 2000;
  }

  if (config.settings.max_daily_trades < 1) {
    throw new Error('Config settings: "max_daily_trades" must be >= 1');
  }
  if (config.settings.job_poll_timeout_ms < 5000) {
    throw new Error('Config settings: "job_poll_timeout_ms" must be >= 5000 (5 seconds minimum)');
  }
  if (config.settings.job_poll_interval_ms < 500) {
    throw new Error('Config settings: "job_poll_interval_ms" must be >= 500 (0.5 seconds minimum)');
  }
}
