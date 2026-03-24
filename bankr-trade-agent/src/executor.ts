// ============================================================
// executor.ts — Execute trades via the Bankr Agent API
//
// Uses Bankr's natural language prompt endpoint to execute swaps.
// No private keys stored anywhere — Bankr handles all wallet signing.
//
// Execution flow (live mode):
//   1. Write pre-submission lock to state (BEFORE any API call)  ← FIX C-1
//   2. POST /agent/prompt  → returns jobId (async 202 response)
//   3. Update lock with real jobId
//   4. Poll GET /agent/job/{jobId} until completed / failed / timeout
//   5. Extract tx hash from response
//   6. Record completion (clear lock, update counters)
//
// On any failure, the lock is cleared so the next cycle can retry.
// ============================================================

import axios from 'axios';
import { BankrPromptResponse, BankrJobResult, StrategyTrigger, TradeRecord } from './types';
import { log } from './logger';
import { setSubmittingLock, setPendingJob, recordTradeComplete } from './state';
import * as crypto from 'crypto';

const BANKR_API_BASE = 'https://api.bankr.bot';

// ---- Helpers ----

/**
 * Return the validated Bankr API key from environment.
 * Throws a clear error if missing or still set to the placeholder value.
 */
function getApiKey(): string {
  const key = process.env.BANKR_API_KEY;
  if (!key || key.trim() === '' || key === 'your_bankr_api_key_here') {
    throw new Error(
      'BANKR_API_KEY is not configured. ' +
      'Copy .env.example to .env and add your key from https://bankr.bot/api'
    );
  }
  return key;
}

function isDryRun(): boolean {
  return process.env.DRY_RUN === 'true';
}

/**
 * Build the natural language swap prompt Bankr will execute.
 *
 * Buy direction:  "swap $50 of USDC to ETH on base"
 * Sell direction: "swap $50 of ETH to USDC on base"
 */
function buildSwapPrompt(trigger: StrategyTrigger): string {
  const { pair, strategy, direction } = trigger;
  if (direction === 'buy') {
    return `swap $${strategy.amount_usd} of ${pair.base_token} to ${pair.token} on ${pair.chain}`;
  } else {
    return `swap $${strategy.amount_usd} of ${pair.token} to ${pair.base_token} on ${pair.chain}`;
  }
}

/**
 * POST a natural-language prompt to Bankr's agent endpoint.
 * Returns the jobId on success; throws on any failure.
 */
async function submitPrompt(prompt: string): Promise<string> {
  const response = await axios.post<BankrPromptResponse>(
    `${BANKR_API_BASE}/agent/prompt`,
    { prompt },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': getApiKey(),
      },
      timeout: 15_000,
    }
  );

  if (!response.data.success) {
    throw new Error(`Bankr rejected prompt: ${response.data.message}`);
  }

  return response.data.jobId;
}

/**
 * Poll GET /agent/job/{jobId} until the job reaches a terminal state
 * (completed, failed, or cancelled) or the timeout is exceeded.
 *
 * @throws If the job fails, is cancelled, or times out.
 */
async function pollJob(
  jobId: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<BankrJobResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await axios.get<BankrJobResult>(
      `${BANKR_API_BASE}/agent/job/${jobId}`,
      {
        headers: { 'X-API-Key': getApiKey() },
        timeout: 10_000,
      }
    );

    const job = response.data;
    log.debug(`Job ${jobId}: ${job.status}`);

    switch (job.status) {
      case 'completed':
        return job;
      case 'failed':
        throw new Error(`Bankr job failed: ${job.error ?? 'unknown error'}`);
      case 'cancelled':
        throw new Error(`Bankr job was cancelled`);
      case 'pending':
      case 'processing':
        break; // continue polling
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Bankr job ${jobId} timed out after ${timeoutMs}ms`);
}

/**
 * Extract an Ethereum transaction hash from a completed Bankr job result.
 * Checks richData fields first, then falls back to a regex scan of response text.
 */
function extractTxHash(job: BankrJobResult): string | undefined {
  if (job.richData) {
    for (const item of job.richData as Array<Record<string, unknown>>) {
      if (typeof item.tx_hash === 'string') return item.tx_hash;
      if (typeof item.txHash  === 'string') return item.txHash;
      if (typeof item.hash    === 'string') return item.hash;
    }
  }

  // Fallback: scan response text for a 0x-prefixed 32-byte hex string
  if (job.response) {
    const match = job.response.match(/0x[a-fA-F0-9]{64}/);
    if (match) return match[0];
  }

  return undefined;
}

/** Generate a collision-resistant unique trade record ID. */
function generateTradeId(): string {
  return `trade_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// ---- Main export ----

/**
 * Execute a triggered strategy via the Bankr Agent API.
 *
 * In dry-run mode (DRY_RUN=true), logs what would happen and returns
 * a 'dry_run' TradeRecord without making any API calls.
 *
 * In live mode:
 *   1. Writes a pre-submission lock to state.json BEFORE touching the API (FIX C-1)
 *   2. Submits the swap prompt to Bankr
 *   3. Updates lock with real jobId
 *   4. Polls until job resolves
 *   5. Records result (clears lock, increments counters on success)
 *
 * Always returns a TradeRecord regardless of outcome. The 'status' field
 * indicates whether the trade executed, failed, or was a dry run.
 */
export async function executeTrade(
  trigger: StrategyTrigger,
  config: { job_poll_timeout_ms: number; job_poll_interval_ms: number }
): Promise<TradeRecord> {
  const { pair, strategy, strategy_index, current_price, direction } = trigger;
  const tradeId   = generateTradeId();
  const timestamp = new Date().toISOString();
  const prompt    = buildSwapPrompt(trigger);

  // ========== DRY RUN ==========
  if (isDryRun()) {
    log.info(`[DRY RUN] Would execute: "${prompt}"`);
    // Record in state so cooldowns and counters work correctly in dry-run
    recordTradeComplete(pair.id, strategy_index, { success: true });
    return {
      id: tradeId,
      timestamp,
      pair_id:        pair.id,
      token:          pair.token,
      strategy_type:  strategy.type,
      direction,
      trigger_price:  strategy.trigger_price,
      executed_price: current_price,
      amount_usd:     strategy.amount_usd,
      status:         'dry_run',
      note:           strategy.note,
    };
  }

  // ========== LIVE EXECUTION ==========
  log.info(`Executing trade: "${prompt}"`);

  let jobId: string | undefined;

  try {
    // ---- Step 1: Write pre-submission lock BEFORE the API call (FIX C-1) ----
    // If the process crashes between here and step 3, the stale-lock timeout
    // in hasPendingJob() will clear this lock on the next restart, preventing
    // the pair from being permanently stuck.
    setSubmittingLock(pair.id);

    // ---- Step 2: Submit prompt to Bankr ----
    jobId = await submitPrompt(prompt);
    log.info(`Bankr job submitted: ${jobId}`);

    // ---- Step 3: Upgrade lock from sentinel to real jobId ----
    setPendingJob(pair.id, jobId);

    // ---- Step 4: Poll until terminal state ----
    const job     = await pollJob(jobId, config.job_poll_timeout_ms, config.job_poll_interval_ms);
    const txHash  = extractTxHash(job);

    log.info(`Job ${jobId} completed. TX: ${txHash ?? '(no hash in response)'}`);

    // ---- Step 5: Record success (clears lock, increments counters, starts cooldown) ----
    recordTradeComplete(pair.id, strategy_index, { success: true });

    return {
      id: tradeId,
      timestamp,
      pair_id:        pair.id,
      token:          pair.token,
      strategy_type:  strategy.type,
      direction,
      trigger_price:  strategy.trigger_price,
      executed_price: current_price,
      amount_usd:     strategy.amount_usd,
      status:         'executed',
      tx_hash:        txHash,
      bankr_job_id:   jobId,
      bankr_response: job.response,
      note:           strategy.note,
    };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(`Trade failed for pair "${pair.id}" (job: ${jobId ?? 'not submitted'})`, err);

    // Clear the lock so the next polling cycle can attempt this strategy again
    recordTradeComplete(pair.id, strategy_index, { success: false });

    return {
      id: tradeId,
      timestamp,
      pair_id:        pair.id,
      token:          pair.token,
      strategy_type:  strategy.type,
      direction,
      trigger_price:  strategy.trigger_price,
      executed_price: current_price,
      amount_usd:     strategy.amount_usd,
      status:         'failed',
      bankr_job_id:   jobId,
      error:          errorMsg,
      note:           strategy.note,
    };
  }
}
