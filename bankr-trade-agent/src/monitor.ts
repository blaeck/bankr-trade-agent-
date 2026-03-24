// ============================================================
// monitor.ts — Price monitoring via CoinGecko API
//
// Fetches real-time USD prices for all configured tokens in a
// single batched HTTP request. Falls back to the last cached
// price when the API is unavailable or rate-limited.
//
// Free tier:    https://api.coingecko.com/api/v3
// Pro tier:     https://pro-api.coingecko.com/api/v3
//               Set COINGECKO_API_KEY env var to use pro.
// ============================================================

import axios from 'axios';
import { PairConfig, PriceData } from './types';
import { log } from './logger';

const COINGECKO_FREE_BASE = 'https://api.coingecko.com/api/v3';
const COINGECKO_PRO_BASE  = 'https://pro-api.coingecko.com/api/v3';

/** In-memory price cache: coingecko_id → last known PriceData */
const priceCache = new Map<string, PriceData>();

function getBaseUrl(): string {
  return process.env.COINGECKO_API_KEY ? COINGECKO_PRO_BASE : COINGECKO_FREE_BASE;
}

function getHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { 'x-cg-pro-api-key': key } : {};
}

/**
 * Fetch current USD prices for all enabled pairs in a single batched request.
 * Falls back to the last cached price per token on any API failure.
 *
 * @returns Map of coingecko_id → PriceData. A token may be absent if it has
 *          never been fetched and the current request also failed for that token.
 */
export async function fetchPrices(pairs: PairConfig[]): Promise<Map<string, PriceData>> {
  const enabledPairs = pairs.filter(p => p.enabled);
  if (enabledPairs.length === 0) {
    log.warn('fetchPrices: no enabled pairs configured.');
    return new Map();
  }

  // De-duplicate coingecko IDs (multiple pairs may share one token)
  const ids = [...new Set(enabledPairs.map(p => p.coingecko_id))];

  try {
    const response = await axios.get<Record<string, { usd: number }>>(
      `${getBaseUrl()}/simple/price`,
      {
        params: { ids: ids.join(','), vs_currencies: 'usd' },
        headers: getHeaders(),
        timeout: 10_000,
      }
    );

    const data = response.data;
    const result = new Map<string, PriceData>();
    const now = new Date().toISOString();

    for (const id of ids) {
      if (data[id]?.usd !== undefined) {
        const priceData: PriceData = {
          token: id,
          price_usd: data[id].usd,
          fetched_at: now,
          source: 'coingecko',
        };
        result.set(id, priceData);
        priceCache.set(id, priceData);
        log.debug(`Price: ${id} = $${data[id].usd}`);
      } else {
        log.warn(`fetchPrices: no price returned for "${id}" — check coingecko_id in config`);
        // Fall back to last cached value
        const cached = priceCache.get(id);
        if (cached) {
          log.warn(`  Using cached price: $${cached.price_usd} (as of ${cached.fetched_at})`);
          result.set(id, { ...cached, source: 'fallback' });
        }
      }
    }

    return result;

  } catch (err) {
    if (axios.isAxiosError(err)) {
      if (err.response?.status === 429) {
        log.warn('CoinGecko rate limit exceeded (429). Using cached prices this cycle.');
      } else {
        log.error(
          `CoinGecko API error: ${err.response?.status ?? 'network'} ${err.response?.statusText ?? err.message}`
        );
      }
    } else {
      log.error('fetchPrices: unexpected error', err);
    }

    // Return all available cached values
    const fallback = new Map<string, PriceData>();
    for (const id of ids) {
      const cached = priceCache.get(id);
      if (cached) fallback.set(id, { ...cached, source: 'fallback' });
    }
    if (fallback.size === 0) {
      log.warn('fetchPrices: no cached prices available — skipping this cycle');
    }
    return fallback;
  }
}

/**
 * Fetch the current price for a single token.
 * Falls back to cache on failure; throws if neither is available.
 *
 * @public Useful utility for one-off price checks outside the main loop.
 */
export async function getPrice(coingeckoId: string): Promise<PriceData> {
  try {
    const response = await axios.get<Record<string, { usd: number }>>(
      `${getBaseUrl()}/simple/price`,
      {
        params: { ids: coingeckoId, vs_currencies: 'usd' },
        headers: getHeaders(),
        timeout: 10_000,
      }
    );

    const price = response.data[coingeckoId]?.usd;
    if (price === undefined) {
      throw new Error(`No price data returned for "${coingeckoId}"`);
    }

    const data: PriceData = {
      token: coingeckoId,
      price_usd: price,
      fetched_at: new Date().toISOString(),
      source: 'coingecko',
    };
    priceCache.set(coingeckoId, data);
    return data;

  } catch (err) {
    const cached = priceCache.get(coingeckoId);
    if (cached) {
      log.warn(`getPrice: using cached price for ${coingeckoId}: $${cached.price_usd}`);
      return { ...cached, source: 'fallback' };
    }
    throw err;
  }
}

/**
 * Return the last known cached price for a token without making an API call.
 * Returns undefined if the token has never been fetched in this session.
 */
export function getCachedPrice(coingeckoId: string): PriceData | undefined {
  return priceCache.get(coingeckoId);
}
