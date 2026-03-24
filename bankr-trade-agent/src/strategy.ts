// ============================================================
// strategy.ts — Strategy evaluation engine
//
// Evaluates each enabled pair's strategies against current prices.
// Returns a list of strategies that should be triggered this cycle.
// Does NOT execute trades — that is executor.ts's responsibility.
//
// Key design decisions:
//   - Only ONE strategy fires per pair per cycle (to avoid conflicting
//     buy/sell orders within the same tick).
//   - When MULTIPLE strategies are simultaneously triggered, the most
//     protective one wins: stop_loss > take_profit/limit_sell > limit_buy.
//     (FIX C-2: previously whichever appeared first in YAML won, which
//      could cause a buy order when price was crashing through both
//      limit_buy and stop_loss thresholds simultaneously.)
// ============================================================

import { AgentConfig, PriceData, Strategy, StrategyTrigger, TradeDirection } from './types';
import { isOnCooldown, isStrategyExhausted, hasPendingJob, getDailyTradeCount } from './state';
import { log } from './logger';

// ---- Strategy priority (lower number = higher priority) ----
// When multiple strategies trigger at once on the same pair, the one with
// the lowest priority number executes. This ensures protective sells always
// override opportunistic buys.
const STRATEGY_PRIORITY: Record<Strategy['type'], number> = {
  stop_loss:   1, // Highest priority — protect capital NOW
  take_profit: 2, // Lock in gains before they evaporate
  limit_sell:  2, // Same urgency as take_profit
  limit_buy:   3, // Lowest priority — entering a new position
};

/**
 * Determine the trade direction for a given strategy type.
 */
function getDirection(strategyType: Strategy['type']): TradeDirection {
  switch (strategyType) {
    case 'limit_buy':
      return 'buy';
    case 'limit_sell':
    case 'take_profit':
    case 'stop_loss':
      return 'sell';
  }
}

/**
 * Check whether a strategy's price condition is currently met.
 *
 * Trigger conditions:
 *   limit_buy   → price ≤ trigger_price  (buy the dip)
 *   limit_sell  → price ≥ trigger_price  (sell into strength)
 *   take_profit → price ≥ trigger_price  (identical to limit_sell)
 *   stop_loss   → price ≤ trigger_price  (emergency exit)
 */
function isPriceConditionMet(strategy: Strategy, currentPrice: number): boolean {
  switch (strategy.type) {
    case 'limit_buy':
    case 'stop_loss':
      return currentPrice <= strategy.trigger_price;
    case 'limit_sell':
    case 'take_profit':
      return currentPrice >= strategy.trigger_price;
  }
}

/**
 * Evaluate all strategies for all enabled pairs against the current price map.
 *
 * For each pair, at most one strategy is returned (highest-priority triggered one).
 * Pre-flight checks are applied in this order:
 *   1. Daily trade cap
 *   2. Pending in-flight job (double-execution guard)
 *   3. Cooldown period
 *   4. Strategy max_executions cap
 *   5. Price condition
 *
 * @returns List of StrategyTrigger objects to be executed this cycle.
 */
export function evaluateStrategies(
  config: AgentConfig,
  prices: Map<string, PriceData>
): StrategyTrigger[] {
  const triggers: StrategyTrigger[] = [];

  // Hard daily cap — check once before the pair loop
  const dailyCount = getDailyTradeCount();
  if (dailyCount >= config.settings.max_daily_trades) {
    log.warn(
      `Daily trade limit reached (${dailyCount}/${config.settings.max_daily_trades}). ` +
      `No further trades until UTC midnight.`
    );
    return [];
  }

  for (const pair of config.pairs) {
    if (!pair.enabled) continue;

    const priceData = prices.get(pair.coingecko_id);
    if (!priceData) {
      log.warn(`No price data for ${pair.token} (${pair.coingecko_id}). Skipping pair.`);
      continue;
    }

    const currentPrice = priceData.price_usd;

    // ---- Pre-flight: in-flight job lock ----
    // Pass timeout as maxAgeMs so stale locks from crashed runs auto-clear
    const pendingJob = hasPendingJob(pair.id, config.settings.job_poll_timeout_ms + 60_000);
    if (pendingJob) {
      log.debug(`Pair ${pair.id}: pending job "${pendingJob}" — skipping this cycle`);
      continue;
    }

    // ---- Pre-flight: cooldown ----
    if (isOnCooldown(pair.id, pair.cooldown_seconds)) {
      const remaining = Math.round(
        // Import cooldownRemaining directly to avoid re-reading state separately
        pair.cooldown_seconds -
        (Date.now() - new Date(priceData.fetched_at).getTime()) / 1000
      );
      log.debug(`Pair ${pair.id}: cooldown active (~${remaining}s remaining)`);
      continue;
    }

    log.debug(`Evaluating ${pair.id} at $${currentPrice}`);

    // ---- Collect ALL triggered strategies for this pair ----
    // FIX C-2: previously broke on first triggered strategy (YAML order determined winner).
    // Now collect all triggered strategies, then pick by priority.
    const triggeredCandidates: StrategyTrigger[] = [];

    for (const [index, strategy] of pair.strategies.entries()) {
      if (isStrategyExhausted(pair.id, index, strategy.max_executions)) {
        log.debug(`  [${strategy.type}] exhausted (max_executions reached)`);
        continue;
      }

      if (isPriceConditionMet(strategy, currentPrice)) {
        triggeredCandidates.push({
          pair,
          strategy,
          strategy_index: index,
          current_price: currentPrice,
          direction: getDirection(strategy.type),
        });
      } else {
        const arrow = (strategy.type === 'limit_buy' || strategy.type === 'stop_loss') ? '↓' : '↑';
        log.debug(
          `  [${strategy.type}] waiting: $${currentPrice} needs ${arrow} $${strategy.trigger_price}`
        );
      }
    }

    if (triggeredCandidates.length === 0) continue;

    // ---- Pick highest-priority trigger for this pair ----
    triggeredCandidates.sort(
      (a, b) => STRATEGY_PRIORITY[a.strategy.type] - STRATEGY_PRIORITY[b.strategy.type]
    );
    const best = triggeredCandidates[0];

    if (triggeredCandidates.length > 1) {
      const names = triggeredCandidates.map(t => t.strategy.type).join(', ');
      log.warn(
        `Pair ${pair.id}: ${triggeredCandidates.length} strategies triggered simultaneously ` +
        `[${names}]. Executing highest-priority: ${best.strategy.type}`
      );
    } else {
      log.info(
        `✓ TRIGGER: ${pair.id} [${best.strategy.type}] @ $${currentPrice} ` +
        `(threshold: $${best.strategy.trigger_price})`
      );
    }

    triggers.push(best);
  }

  return triggers;
}

/**
 * Format a human-readable price + strategy status summary for all enabled pairs.
 * Used in the main loop's info log every cycle.
 */
export function formatPriceStatus(config: AgentConfig, prices: Map<string, PriceData>): string {
  const lines: string[] = [];

  for (const pair of config.pairs) {
    if (!pair.enabled) continue;

    const priceData = prices.get(pair.coingecko_id);
    const price = priceData ? `$${priceData.price_usd.toFixed(4)}` : 'N/A';
    const source = priceData?.source === 'fallback' ? ' [cached]' : '';
    const age = priceData
      ? `${Math.round((Date.now() - new Date(priceData.fetched_at).getTime()) / 1000)}s ago`
      : '—';

    lines.push(`  ${pair.token.padEnd(10)} ${price.padStart(14)}${source}  (${age})`);

    for (const strat of pair.strategies) {
      const arrow = (strat.type === 'limit_buy' || strat.type === 'stop_loss') ? '▼' : '▲';
      lines.push(`    ${arrow} ${strat.type.padEnd(14)} @ $${strat.trigger_price}`);
    }
  }

  return lines.join('\n');
}
