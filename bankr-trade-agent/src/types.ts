// ============================================================
// types.ts — Shared type definitions for the Bankr Trade Agent
// ============================================================

export type StrategyType = 'limit_buy' | 'limit_sell' | 'take_profit' | 'stop_loss';

export type TradeDirection = 'buy' | 'sell';

export interface Strategy {
  type: StrategyType;
  trigger_price: number;
  amount_usd: number;
  max_executions?: number;
  note?: string;
}

export interface PairConfig {
  id: string;
  token: string;
  base_token: string;
  coingecko_id: string;
  chain: string;
  enabled: boolean;
  cooldown_seconds: number;
  strategies: Strategy[];
}

export interface AgentConfig {
  pairs: PairConfig[];
  settings: {
    max_daily_trades: number;
    price_deviation_threshold: number;
    job_poll_timeout_ms: number;
    job_poll_interval_ms: number;
  };
}

export interface PriceData {
  token: string;
  price_usd: number;
  fetched_at: string;
  source: 'coingecko' | 'fallback';
}

export type TradeStatus = 'executed' | 'dry_run' | 'failed' | 'skipped';

export interface TradeRecord {
  id: string;
  timestamp: string;
  pair_id: string;
  token: string;
  strategy_type: StrategyType;
  direction: TradeDirection;
  trigger_price: number;
  executed_price: number;
  amount_usd: number;
  status: TradeStatus;
  tx_hash?: string;
  bankr_job_id?: string;
  bankr_response?: string;
  error?: string;
  note?: string;
}

// Persisted per-pair state for dedup and cooldown
export interface PairState {
  pair_id: string;
  last_trade_at?: string;
  strategy_executions: Record<string, number>; // strategy index → execution count
  pending_job_id?: string;                     // Bankr job currently in-flight (or '__SUBMITTING__' pre-submit)
  pending_since?: string;                      // ISO timestamp when pending lock was first set (for stale-lock detection)
  daily_trade_count: number;
  daily_count_reset_at: string;
}

export interface AgentState {
  pairs: Record<string, PairState>;
  total_daily_trades: number;
  daily_reset_at: string;
}

// Bankr API types
export interface BankrPromptResponse {
  success: boolean;
  jobId: string;
  threadId: string;
  status: string;
  message: string;
}

export type BankrJobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface BankrJobResult {
  success: boolean;
  jobId: string;
  status: BankrJobStatus;
  prompt: string;
  createdAt: string;
  completedAt?: string;
  processingTime?: number;
  response?: string;
  richData?: unknown[];
  error?: string;
}

// Strategy evaluation result
export interface StrategyTrigger {
  pair: PairConfig;
  strategy: Strategy;
  strategy_index: number;
  current_price: number;
  direction: TradeDirection;
}
