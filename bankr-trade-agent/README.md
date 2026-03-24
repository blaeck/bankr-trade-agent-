# Bankr Price Alert + Auto-Trade Agent

A production-ready, self-supervised trading agent that monitors token prices on **Base chain** and executes swaps automatically when configurable price targets are hit — using **Bankr Wallet** for transaction signing. No private keys stored anywhere.

---

## Table of Contents

1. [Features](#features)
2. [Tech Stack](#tech-stack)
3. [Architecture Overview](#architecture-overview)
4. [Quick Start](#quick-start)
5. [Configuration Reference](#configuration-reference)
6. [Environment Variables](#environment-variables)
7. [Strategy Reference](#strategy-reference)
8. [Usage Guide](#usage-guide)
9. [Trade Log Format](#trade-log-format)
10. [Safety & Anti-Abuse Features](#safety--anti-abuse-features)
11. [Deployment](#deployment)
12. [Troubleshooting](#troubleshooting)
13. [File Structure](#file-structure)

---

## Features

| Feature | Detail |
|---|---|
| **Price monitoring** | CoinGecko API, batched per cycle, in-memory cache with fallback |
| **4 strategy types** | `limit_buy`, `limit_sell`, `take_profit`, `stop_loss` |
| **Bankr wallet signing** | Swaps via Bankr Agent API — zero private keys on disk |
| **Append-only trade log** | Every trade saved as JSONL: timestamp, price, amount, tx hash |
| **Double-execution prevention** | Pre-submission lock written to disk before any API call |
| **Priority-based conflict resolution** | `stop_loss` beats `limit_buy` when both trigger simultaneously |
| **Cooldown periods** | Per-pair configurable wait time between trades |
| **Execution caps** | Per-strategy `max_executions` hard limit |
| **Daily trade cap** | Global `max_daily_trades` guard across all pairs |
| **Stale lock recovery** | Auto-clears orphaned locks from crashed runs |
| **Dry-run mode** | Full simulation without touching your wallet |
| **CLI status dashboard** | `npm run status` — live snapshot of state, strategies, trades |
| **Graceful shutdown** | SIGINT/SIGTERM flushed cleanly; no mid-trade interruption |
| **Multiple pairs** | Monitor any number of CoinGecko-listed tokens simultaneously |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.3 (strict mode) |
| Runtime | Node.js 18+ |
| Price data | [CoinGecko Simple Price API](https://docs.coingecko.com/reference/simple-price) |
| Trade execution | [Bankr Agent API](https://docs.bankr.bot/agent-api/overview) |
| HTTP client | axios |
| Config format | YAML (`js-yaml`) |
| Console output | chalk (colored, leveled) |
| State persistence | JSON file (`state.json`) |
| Trade history | Append-only JSONL (`logs/trades.jsonl`) |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                      agent.ts                        │
│   main loop:  loadConfig → runCycle every Ns        │
└───────────┬──────────────────────────────────────────┘
            │
     ┌──────▼──────┐      ┌──────────────┐
     │  monitor.ts  │      │  config.ts   │
     │  CoinGecko   │      │  YAML loader │
     │  price fetch │      │  + validator │
     └──────┬───────┘      └──────────────┘
            │ Map<id, PriceData>
     ┌──────▼──────────────┐
     │    strategy.ts       │
     │  evaluate each pair  │
     │  sort by priority    │
     │  return triggers[]   │
     └──────┬───────────────┘
            │ StrategyTrigger[]
     ┌──────▼──────────────┐     ┌──────────────┐
     │    executor.ts       │────▶│   state.ts   │
     │  build NL prompt    │     │  lock/unlock  │
     │  POST /agent/prompt │     │  counters     │
     │  poll /agent/job/id │     │  cooldowns    │
     └──────┬───────────────┘     └──────────────┘
            │ TradeRecord
     ┌──────▼──────────────┐
     │    logger.ts         │
     │  console (colored)  │
     │  logs/agent.log     │
     │  logs/trades.jsonl  │
     └──────────────────────┘
```

### Data Flow (one cycle)

1. `agent.ts` calls `fetchPrices()` — one batched CoinGecko request for all enabled pairs
2. `evaluateStrategies()` checks each pair's strategies against current prices, applying pre-flight guards (daily cap → pending lock → cooldown → max_executions → price condition)
3. For each trigger: `executeTrade()` writes a **pre-submission lock** to `state.json`, submits the swap prompt to Bankr, upgrades the lock to the real jobId, polls until the job completes, then records the result
4. `log.trade()` writes the `TradeRecord` to console and appends it to `logs/trades.jsonl`
5. Agent sleeps for `POLL_INTERVAL_SECONDS`, then repeats

### State file (`state.json`)

Written atomically after every mutation. Contains:
- `pending_job_id` / `pending_since` — in-flight trade lock (prevents double-execution)
- `last_trade_at` — cooldown anchor per pair
- `strategy_executions` — per-strategy execution count map
- `total_daily_trades` / `daily_reset_at` — daily cap tracking

---

## Quick Start

### Prerequisites

- **Node.js 18+** — check with `node --version`
- A **Bankr account** with Agent API access enabled at [bankr.bot/api](https://bankr.bot/api)
- Your wallet must have a **USDC balance on Base** for buy strategies (or the token balance for sell strategies)

### 1. Install

```bash
git clone https://github.com/YOUR_USERNAME/bankr-trade-agent
cd bankr-trade-agent
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set your Bankr API key:

```env
BANKR_API_KEY=bkr_live_xxxxxxxxxxxxxxxxxxxx
```

### 3. Configure strategies

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` to set your trading pairs and price targets. A minimal example:

```yaml
pairs:
  - id: eth-usdc
    token: ETH
    base_token: USDC
    coingecko_id: ethereum
    chain: base
    enabled: true
    cooldown_seconds: 300
    strategies:
      - type: limit_buy
        trigger_price: 1900
        amount_usd: 50
        max_executions: 3
        note: "Buy the dip"

      - type: stop_loss
        trigger_price: 1650
        amount_usd: 100
        max_executions: 1
        note: "Emergency exit"

settings:
  max_daily_trades: 10
```

### 4. Test with dry-run first (strongly recommended)

```bash
npm run dry-run
```

This runs the complete agent loop — fetching real prices, evaluating strategies, and logging what trades would have executed — **without touching your wallet or spending any funds**.

Expected output:
```
╔════════════════════════════════════════════════╗
║       Bankr Price Alert + Auto-Trade Agent     ║
║              Base Chain Edition                ║
╚════════════════════════════════════════════════╝

  Mode:          [DRY RUN — no real trades will execute]
  Poll interval: 30s
  Active pairs:  ETH

[2025-03-24T10:00:00.000Z] INFO  Config loaded. 1 enabled pair(s). Polling every 30s.
[2025-03-24T10:00:01.234Z] INFO  Prices:
  ETH             $1887.3200  (1s ago)
    ▼ limit_buy    @ $1900
    ▼ stop_loss    @ $1650
[2025-03-24T10:00:01.235Z] INFO  ✓ TRIGGER: eth-usdc [limit_buy] @ $1887.32 (threshold: $1900)
[2025-03-24T10:00:01.236Z] INFO  [DRY RUN] Would execute: "swap $50 of USDC to ETH on base"
────────────────────────────────────────────────────────────
🔔 TRADE DRY_RUN | 2025-03-24T10:00:01.237Z
   Pair:      eth-usdc
   Strategy:  limit_buy (BUY)
   Token:     ETH
   Price:     $1887.3200 (trigger: $1900)
   Amount:    $50 USD
   Note:      Buy the dip
────────────────────────────────────────────────────────────
```

### 5. Check status

```bash
npm run status
```

### 6. Run live

```bash
npm run dev
```

---

## Configuration Reference

### Pair fields

| Field | Required | Type | Description |
|---|---|---|---|
| `id` | ✓ | string | Unique identifier (e.g. `eth-usdc`) |
| `token` | ✓ | string | Token symbol as Bankr understands it (e.g. `ETH`, `cbBTC`) |
| `base_token` | ✓ | string | Quote currency (e.g. `USDC`) |
| `coingecko_id` | ✓ | string | CoinGecko token ID for price feed |
| `chain` | ✓ | string | Must be `base` |
| `enabled` | ✓ | boolean | Set `false` to pause without deleting |
| `cooldown_seconds` | — | number | Seconds between trades on this pair (default: 0) |
| `strategies` | ✓ | array | At least one strategy object required |

### Strategy fields

| Field | Required | Type | Description |
|---|---|---|---|
| `type` | ✓ | string | `limit_buy` \| `limit_sell` \| `take_profit` \| `stop_loss` |
| `trigger_price` | ✓ | number | USD price threshold |
| `amount_usd` | ✓ | number | USD value of the swap |
| `max_executions` | — | integer | Max times this strategy fires (default: unlimited) |
| `note` | — | string | Human label shown in logs |

### Global settings

| Field | Default | Description |
|---|---|---|
| `max_daily_trades` | 20 | Hard cap across all pairs per UTC day |
| `price_deviation_threshold` | 0.05 | Reserved for future stale-price guard |
| `job_poll_timeout_ms` | 120000 | Max wait (ms) for a Bankr job to complete |
| `job_poll_interval_ms` | 2000 | How often to poll job status |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BANKR_API_KEY` | — | **Required in live mode.** Get from [bankr.bot/api](https://bankr.bot/api) |
| `DRY_RUN` | `false` | Set `true` to simulate without executing trades |
| `POLL_INTERVAL_SECONDS` | `30` | Price check frequency in seconds (minimum: 5) |
| `COINGECKO_API_KEY` | — | Optional. Unlocks higher CoinGecko rate limits |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

---

## Strategy Reference

| Type | Triggers When | Direction | Use Case |
|---|---|---|---|
| `limit_buy` | price ≤ `trigger_price` | Buy token | Accumulate on dips |
| `limit_sell` | price ≥ `trigger_price` | Sell token | Sell into strength |
| `take_profit` | price ≥ `trigger_price` | Sell token | Lock in gains |
| `stop_loss` | price ≤ `trigger_price` | Sell token | Cap downside loss |

### Priority resolution

When multiple strategies on the same pair trigger simultaneously (e.g., price crashes through both `limit_buy` and `stop_loss` thresholds), the agent executes the **highest-priority** one:

```
stop_loss  >  take_profit / limit_sell  >  limit_buy
```

This ensures capital-protective sells always override opportunistic buys.

---

## Usage Guide

### Checking status

```bash
npm run status
```

Shows: active pairs, strategy execution counts, cooldown timers, in-flight locks, and the last 10 trades.

### Resetting state

```bash
rm state.json          # Clears ALL state (counters, cooldowns, locks)
```

To reset only one pair, manually edit `state.json` and delete the entry for that pair from the `pairs` object.

### Viewing trade history

```bash
# Pretty-print all trades
cat logs/trades.jsonl | python3 -m json.tool

# Filter for successful trades
grep '"status":"executed"' logs/trades.jsonl

# Count trades today
grep "$(date -u +%Y-%m-%d)" logs/trades.jsonl | wc -l
```

### Adjusting log verbosity

```env
LOG_LEVEL=debug    # Verbose — shows all price checks and strategy evaluations
LOG_LEVEL=info     # Default — shows triggers, executions, and warnings
LOG_LEVEL=warn     # Quiet — only warnings and errors
```

---

## Trade Log Format

Every executed, failed, or dry-run trade is appended to `logs/trades.jsonl` as a newline-delimited JSON record:

```json
{
  "id": "trade_1711234567890_a1b2c3d4",
  "timestamp": "2025-03-24T10:30:00.000Z",
  "pair_id": "eth-usdc",
  "token": "ETH",
  "strategy_type": "limit_buy",
  "direction": "buy",
  "trigger_price": 1900,
  "executed_price": 1887.32,
  "amount_usd": 50,
  "status": "executed",
  "tx_hash": "0xabc123def456789...",
  "bankr_job_id": "job_xyz789abc",
  "bankr_response": "Swapped $50 of USDC to ETH on Base. TX: 0xabc123...",
  "note": "Buy the dip"
}
```

| Field | Description |
|---|---|
| `status` | `executed` \| `dry_run` \| `failed` \| `skipped` |
| `trigger_price` | The configured threshold that was crossed |
| `executed_price` | The actual price at the moment of execution |
| `tx_hash` | On-chain transaction hash (present on successful live trades) |
| `bankr_job_id` | Bankr's internal job ID for the prompt |

---

## Safety & Anti-Abuse Features

### Double-execution prevention (3-layer)

1. **Pre-submission lock**: `setSubmittingLock()` writes a sentinel value to `state.json` *before* any Bankr API call. If the process crashes between writing the lock and completing the job, no second trade fires.
2. **Job ID lock**: After successful submission, the sentinel is replaced with the real `jobId`. The pair is blocked until the lock is explicitly cleared.
3. **Stale lock auto-expiry**: Locks older than `job_poll_timeout_ms + 60s` are automatically cleared on the next cycle, preventing a crashed run from permanently blocking a pair.

### Priority-based conflict resolution

When `stop_loss` and `limit_buy` both trigger simultaneously (e.g., price gaps down through both thresholds), `stop_loss` always wins. The original code executed whichever strategy appeared first in the YAML, which could cause the agent to buy into a crash.

### Daily trade cap

`max_daily_trades` provides a hard ceiling across all pairs. Counter resets at UTC midnight and is persisted to `state.json` immediately to survive restarts.

### Cooldown periods

`cooldown_seconds` per pair prevents re-entry immediately after a trade. Useful for limit orders where you want to avoid repeatedly buying the same dip.

### No overlapping cycles

The polling loop uses recursive `setTimeout` rather than `setInterval`, ensuring a new cycle never starts while the previous one is still running (e.g., waiting on a slow Bankr job).

---

## Deployment

### Production build

```bash
npm run build    # Compiles TypeScript to dist/
npm start        # Runs the compiled agent
```

### Run as a service with PM2

```bash
npm install -g pm2
npm run build
pm2 start dist/agent.js --name bankr-agent
pm2 save           # Persist across reboots
pm2 startup        # Generate startup script
pm2 logs bankr-agent --lines 50   # View logs
pm2 restart bankr-agent           # Apply config changes
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
COPY config.yaml .env ./
CMD ["node", "dist/agent.js"]
```

Build and run:
```bash
npm run build
docker build -t bankr-trade-agent .
docker run -d --name bankr-agent \
  -v $(pwd)/state.json:/app/state.json \
  -v $(pwd)/logs:/app/logs \
  bankr-trade-agent
```

---

## Troubleshooting

### Agent exits immediately with "BANKR_API_KEY is not set"

1. Check that `.env` exists: `ls -la .env`
2. Check the key is not the placeholder: `grep BANKR_API_KEY .env`
3. Verify Agent API access is enabled at [bankr.bot/api](https://bankr.bot/api)
4. To test without a key: `npm run dry-run`

### "Config file not found"

```bash
cp config.example.yaml config.yaml
```

### Prices show as "N/A" / "[cached]"

- CoinGecko free tier allows ~10–30 requests/minute. If you have many pairs or a fast poll interval, you may be rate-limited.
- Fix: add a `COINGECKO_API_KEY` in `.env`, or increase `POLL_INTERVAL_SECONDS`.
- The agent uses cached prices as a fallback — no trades will be skipped due to stale prices, but the executed price in the trade record will reflect the cached value.

### "Daily limit reached"

Your `max_daily_trades` setting has been hit. Options:
- Wait until UTC midnight (auto-resets)
- Increase `max_daily_trades` in `config.yaml` and restart

### A pair is stuck with a pending job lock

A previous run may have crashed mid-trade, leaving an orphaned lock in `state.json`. Options:

**Option A — Wait for auto-expiry** (recommended):
The lock auto-clears after `job_poll_timeout_ms + 60s` (default: ~3 minutes).

**Option B — Manual clear**:
```bash
# Edit state.json and remove pending_job_id and pending_since from the affected pair
nano state.json
```

**Option C — Full reset**:
```bash
rm state.json
```

### "Bankr job failed" in logs

- Check your wallet has sufficient balance for the trade amount
- Verify the `token` and `base_token` symbols in `config.yaml` are recognized by Bankr
- Check [bankr.bot](https://bankr.bot) for service status

### Build fails with TypeScript errors

```bash
npm run build 2>&1 | head -30
```

Common causes:
- Node.js version too old: `node --version` must be 18+
- Missing `dist/` directory: run `npm run build` before `npm start`

### `npm run status` shows all strategies as "EXHAUSTED"

The `max_executions` cap has been reached for every strategy. To reset:
```bash
# Reset execution counts for all strategies on all pairs
node -e "
const s = JSON.parse(require('fs').readFileSync('state.json'));
Object.values(s.pairs).forEach(p => p.strategy_executions = {});
require('fs').writeFileSync('state.json', JSON.stringify(s, null, 2));
console.log('Reset complete.');
"
```

---

## File Structure

```
bankr-trade-agent/
├── src/
│   ├── agent.ts          Main entry point: polling loop, lifecycle, startup banner
│   ├── config.ts         YAML config loader with full validation and defaults
│   ├── executor.ts       Bankr API interaction: prompt submission and job polling
│   ├── logger.ts         Console + file logging; readTrades() for status CLI
│   ├── monitor.ts        CoinGecko price fetching with in-memory cache
│   ├── state.ts          Persistent state: locks, cooldowns, counters, cache
│   ├── status.ts         CLI dashboard: pairs, cooldowns, trades summary
│   ├── strategy.ts       Strategy evaluation with priority-based conflict resolution
│   └── types.ts          Shared TypeScript interfaces and type aliases
│
├── logs/                 Created automatically on first run
│   ├── trades.jsonl      Append-only trade history (one JSON object per line)
│   └── agent.log         Application log
│
├── dist/                 Compiled output (created by `npm run build`)
│
├── config.yaml           Your strategies (create from config.example.yaml)
├── config.example.yaml   Annotated template with all supported options
├── state.json            Live agent state — auto-managed, do not edit while running
├── .env                  Your API keys (create from .env.example)
├── .env.example          Environment variable template
├── .gitignore            Excludes .env, state.json, logs/, node_modules/
├── package.json          Dependencies and npm scripts
└── tsconfig.json         TypeScript compiler configuration (strict mode)
```

---

## Common CoinGecko IDs

| Token | `coingecko_id` |
|---|---|
| ETH (Wrapped) | `ethereum` |
| cbBTC (Coinbase Wrapped BTC) | `coinbase-wrapped-btc` |
| USDC | `usd-coin` |
| BNKR | `bankr` |
| cbETH | `coinbase-wrapped-staked-eth` |
| AERO (Aerodrome) | `aerodrome-finance` |
| BRETT | `brett` |

Look up any token at [coingecko.com](https://www.coingecko.com) — the ID appears in the URL: `coingecko.com/en/coins/{id}`.

---

## Bankr API Rate Limits

| Plan | Daily prompts |
|---|---|
| Standard | 100 / day |
| Bankr Club | 1,000 / day |

With `POLL_INTERVAL_SECONDS=30` and `max_daily_trades=20`, the agent uses at most **20 prompt API calls per day** for trades (price checks use CoinGecko, not Bankr). You are well within the standard free limit.

---

## License

MIT — use freely, no warranty.

## Links

- [Bankr Documentation](https://docs.bankr.bot)
- [Bankr Agent API Reference](https://docs.bankr.bot/agent-api/overview)
- [Get your Bankr API key](https://bankr.bot/api)
- [CoinGecko API Docs](https://docs.coingecko.com/reference/introduction)
