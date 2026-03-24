// ============================================================
// state.ts — Persistent agent state
//
// Single source of truth for:
//   - Strategy execution counts and max-execution caps
//   - Cooldown timestamps per pair
//   - In-flight Bankr job locks (double-execution prevention)
//   - Daily trade counters
//
// All mutations are immediately flushed to state.json.
// An in-memory cache with a 2-second TTL prevents the O(N×M)
// file-reads-per-cycle that the naive "load on every call"
// approach would cause.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { AgentState, PairState } from './types';
import { log } from './logger';

const STATE_PATH = path.resolve(process.cwd(), 'state.json');

/**
 * Sentinel value written as pending_job_id BEFORE the Bankr API call.
 * Distinguishes "we are about to submit" from a real jobId, enabling
 * crash recovery logic in hasPendingJob().
 */
const SUBMITTING_SENTINEL = '__SUBMITTING__';

// ---- In-memory cache (FIX M-1) ----
// Prevents O(N×M) disk reads per polling cycle.
// Invalidated on every saveState() call.
let stateCache: AgentState | null = null;
let stateCacheTime = 0;
const STATE_CACHE_TTL_MS = 2000; // 2 seconds — well within a 30s poll cycle

// ---- Internal helpers ----

function loadState(): AgentState {
  // Return from cache if fresh
  if (stateCache !== null && (Date.now() - stateCacheTime) < STATE_CACHE_TTL_MS) {
    return stateCache;
  }

  if (!fs.existsSync(STATE_PATH)) {
    const fresh = freshState();
    stateCache = fresh;
    stateCacheTime = Date.now();
    return fresh;
  }

  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as AgentState;
    stateCache = parsed;
    stateCacheTime = Date.now();
    return parsed;
  } catch (err) {
    log.warn('Could not parse state.json — starting with fresh state.', err);
    const fresh = freshState();
    stateCache = fresh;
    stateCacheTime = Date.now();
    return fresh;
  }
}

function saveState(state: AgentState): void {
  // Update cache immediately so subsequent reads within TTL see the new state
  stateCache = state;
  stateCacheTime = Date.now();

  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    log.error('CRITICAL: Failed to save state.json — double-execution risk on next cycle!', err);
  }
}

function freshState(): AgentState {
  return {
    pairs: {},
    total_daily_trades: 0,
    daily_reset_at: todayUTC(),
  };
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10); // "2025-03-24"
}

/**
 * Ensure daily counters are reset if the UTC date has changed.
 * FIX C-3: previously mutated state in memory but did not persist the reset,
 *          causing stale disk reads to resurrect yesterday's counts.
 * Now calls saveState() when a reset actually happens.
 */
function maybeResetDailyCounters(state: AgentState): void {
  const today = todayUTC();
  if (state.daily_reset_at === today) return;

  state.total_daily_trades = 0;
  state.daily_reset_at = today;
  for (const ps of Object.values(state.pairs)) {
    ps.daily_trade_count = 0;
    ps.daily_count_reset_at = today;
  }
  log.info(`Daily counters reset for ${today}`);

  // Persist the reset immediately so other reads see consistent data
  saveState(state);
}

function getPairState(state: AgentState, pairId: string): PairState {
  if (!state.pairs[pairId]) {
    state.pairs[pairId] = {
      pair_id: pairId,
      strategy_executions: {},
      daily_trade_count: 0,
      daily_count_reset_at: todayUTC(),
    };
  }
  return state.pairs[pairId];
}

// ---- Public API ----

/**
 * Check whether a pair is currently within its cooldown period.
 * Returns true if the pair has traded recently and should be skipped.
 */
export function isOnCooldown(pairId: string, cooldownSeconds: number): boolean {
  if (cooldownSeconds <= 0) return false;
  const state = loadState();
  const ps = getPairState(state, pairId);
  if (!ps.last_trade_at) return false;
  const elapsedSeconds = (Date.now() - new Date(ps.last_trade_at).getTime()) / 1000;
  return elapsedSeconds < cooldownSeconds;
}

/**
 * Returns the number of seconds remaining in the cooldown period (0 if not cooling down).
 */
export function cooldownRemaining(pairId: string, cooldownSeconds: number): number {
  if (cooldownSeconds <= 0) return 0;
  const state = loadState();
  const ps = getPairState(state, pairId);
  if (!ps.last_trade_at) return 0;
  const elapsedSeconds = (Date.now() - new Date(ps.last_trade_at).getTime()) / 1000;
  return Math.max(0, cooldownSeconds - elapsedSeconds);
}

/**
 * Returns true if a strategy has reached its max_executions cap.
 */
export function isStrategyExhausted(
  pairId: string,
  strategyIndex: number,
  maxExecutions?: number
): boolean {
  if (!maxExecutions) return false;
  const state = loadState();
  const ps = getPairState(state, pairId);
  const count = ps.strategy_executions[String(strategyIndex)] ?? 0;
  return count >= maxExecutions;
}

/**
 * Check if there is an active pending job or pre-submission lock for this pair.
 *
 * FIX C-1 + m-6: stale locks (older than maxAgeMs) are automatically cleared.
 * This handles the scenario where the process crashed after writing a lock
 * but before the job resolved, which would otherwise block the pair forever.
 *
 * @param pairId      - The pair identifier
 * @param maxAgeMs    - If the lock is older than this (ms), it is considered stale and cleared.
 *                      Defaults to 3 minutes. Set to the job_poll_timeout + a buffer.
 * @returns The pending job ID (or SUBMITTING_SENTINEL), or undefined if none / stale.
 */
export function hasPendingJob(pairId: string, maxAgeMs = 180_000): string | undefined {
  const state = loadState();
  const ps = getPairState(state, pairId);

  if (!ps.pending_job_id) return undefined;

  // Check for stale lock
  if (ps.pending_since) {
    const ageMs = Date.now() - new Date(ps.pending_since).getTime();
    if (ageMs > maxAgeMs) {
      log.warn(
        `Stale pending lock on pair "${pairId}" (job: ${ps.pending_job_id}, ` +
        `age: ${Math.round(ageMs / 1000)}s > max: ${maxAgeMs / 1000}s). Clearing lock.`
      );
      delete ps.pending_job_id;
      delete ps.pending_since;
      saveState(state);
      return undefined;
    }
  }

  return ps.pending_job_id;
}

/**
 * Write a pre-submission lock BEFORE calling the Bankr API.
 *
 * FIX C-1: Previously, the pending lock was written AFTER submitPrompt() returned.
 * If the process crashed between those two operations, the Bankr job was submitted
 * but no lock existed — the next restart would submit the same trade again.
 *
 * Call setSubmittingLock() → submitPrompt() → setPendingJob() in that order.
 */
export function setSubmittingLock(pairId: string): void {
  const state = loadState();
  maybeResetDailyCounters(state);
  const ps = getPairState(state, pairId);
  ps.pending_job_id = SUBMITTING_SENTINEL;
  ps.pending_since = new Date().toISOString();
  saveState(state);
}

/**
 * Update the pending lock with the real Bankr jobId after successful submission.
 * Preserves the original pending_since timestamp for stale-lock detection.
 */
export function setPendingJob(pairId: string, jobId: string): void {
  const state = loadState();
  const ps = getPairState(state, pairId);
  ps.pending_job_id = jobId;
  // Do NOT overwrite pending_since — keep the original time for stale-lock calculations
  saveState(state);
}

/**
 * Clear the pending job lock and (on success) record the completed trade.
 * Called both on successful completion and on failure/error.
 *
 * @param success - If true, increments execution counters and sets cooldown timestamp.
 *                  If false, only clears the lock so the next cycle can retry.
 */
export function recordTradeComplete(
  pairId: string,
  strategyIndex: number,
  options: { success: boolean } = { success: true }
): void {
  const state = loadState();
  maybeResetDailyCounters(state);
  const ps = getPairState(state, pairId);

  // Always clear the pending lock
  delete ps.pending_job_id;
  delete ps.pending_since;

  if (options.success) {
    // Set cooldown start time
    ps.last_trade_at = new Date().toISOString();

    // Increment this strategy's execution counter
    const key = String(strategyIndex);
    ps.strategy_executions[key] = (ps.strategy_executions[key] ?? 0) + 1;

    // Increment daily counters
    ps.daily_trade_count++;
    state.total_daily_trades++;
  }

  saveState(state);
}

/**
 * Get the total number of trades executed today across all pairs.
 * Safe to call frequently — uses the in-memory cache.
 */
export function getDailyTradeCount(): number {
  const state = loadState();
  maybeResetDailyCounters(state); // persists if reset needed (FIX C-3)
  return state.total_daily_trades;
}

/**
 * Get the number of times a specific strategy has been executed.
 */
export function getStrategyExecutionCount(pairId: string, strategyIndex: number): number {
  const state = loadState();
  const ps = getPairState(state, pairId);
  return ps.strategy_executions[String(strategyIndex)] ?? 0;
}

/**
 * Return the full agent state, used by the status CLI.
 */
export function getFullState(): AgentState {
  const state = loadState();
  maybeResetDailyCounters(state);
  return state;
}
