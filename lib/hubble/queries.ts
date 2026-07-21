// Hubble (BigQuery) analytics queries for the /stats page, scoped to the
// CURRENT 4-pool architecture (XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC) +
// AccountManager. Each builder returns { query, params } for `runQuery`.
//
// ─────────────────────────────────────────────────────────────────────────
// SCHEMA: verified live against the dataset (2026-06-16).
//   • Table is `history_contract_events` (NOT `contract_events`).
//   • Event name = topics_decoded[0].symbol  → JSON_VALUE(topics_decoded,'$[0].symbol')
//   • Topic addresses = topics_decoded[n].address (e.g. the margin account in topic2).
//   • Payload = data_decoded (typed JSON): a scalar i128 is {"i128":"..."}, a
//     struct is keyed by field, each value typed — so an amount field reads as
//     JSON_VALUE(data_decoded,'$.<field>.i128'). closed_at/contract_id as expected.
//
// ⚠️  NETWORK: SDF's public Hubble (`crypto-stellar.crypto_stellar`) indexes
//     PUBNET (mainnet) ONLY — there is no public testnet Hubble. Our protocol
//     is on testnet, so these queries return EMPTY until we deploy to mainnet.
//     The wiring is verified (auth + schema), but the `data_decoded.<field>`
//     paths below are validated only once OUR contracts appear on pubnet —
//     re-run a sample then and adjust field names if the payloads differ.
// ─────────────────────────────────────────────────────────────────────────

import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";

const EVENTS_TABLE = "`crypto-stellar.crypto_stellar.history_contract_events`";
const EVENT_NAME = "JSON_VALUE(topics_decoded, '$[0].symbol')";

const POOLS = [
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM,
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_USDC,
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC,
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC,
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLND,
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUA,
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_WETH,
  CONTRACT_ADDRESSES.LENDING_PROTOCOL_EURC,
].filter(Boolean) as string[];

const ACCOUNT_MANAGER = CONTRACT_ADDRESSES.ACCOUNT_MANAGER;

const LOOKBACK_DAYS = 90;

type Built = { query: string; params: Record<string, unknown> };

/** Daily deposit / withdraw flow across the 4 lending pools (90 days). */
export function tvlQuery(): Built {
  return {
    query: `
      SELECT
        FORMAT_DATE('%Y-%m-%d', DATE(closed_at)) AS day,
        CAST(SUM(CASE WHEN ev = 'deposit_event'  THEN dep ELSE 0 END) AS FLOAT64) AS deposits,
        CAST(SUM(CASE WHEN ev = 'withdraw_event' THEN wdr ELSE 0 END) AS FLOAT64) AS withdrawals
      FROM (
        SELECT closed_at,
          ${EVENT_NAME} AS ev,
          SAFE_CAST(JSON_VALUE(data_decoded, '$.amount.i128')        AS NUMERIC) / 1e18 AS dep,
          SAFE_CAST(JSON_VALUE(data_decoded, '$.vtoken_amount.i128') AS NUMERIC) / 1e18 AS wdr
        FROM ${EVENTS_TABLE}
        WHERE contract_id IN UNNEST(@pools)
          AND successful = TRUE
          AND closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      )
      WHERE ev IN ('deposit_event', 'withdraw_event')
      GROUP BY day
      ORDER BY day
    `,
    params: { pools: POOLS, days: LOOKBACK_DAYS },
  };
}

/** Top 100 borrowers all-time, by total borrowed (AccountManager Trader_Borrow). */
export function topBorrowersQuery(): Built {
  return {
    query: `
      SELECT
        JSON_VALUE(topics_decoded, '$[1].address') AS account,
        COUNT(*) AS borrow_count,
        CAST(SUM(SAFE_CAST(JSON_VALUE(data_decoded, '$.token_amount.i128') AS NUMERIC)) / 1e18 AS FLOAT64) AS total_borrowed
      FROM ${EVENTS_TABLE}
      WHERE contract_id = @account_manager
        AND successful = TRUE
        AND ${EVENT_NAME} = 'Trader_Borrow'
        AND JSON_VALUE(topics_decoded, '$[1].address') IS NOT NULL
      GROUP BY account
      ORDER BY total_borrowed DESC
      LIMIT 100
    `,
    params: { account_manager: ACCOUNT_MANAGER },
  };
}

/** Daily borrow volume (90 days) from AccountManager Trader_Borrow. */
export function volumeQuery(): Built {
  return {
    query: `
      SELECT
        FORMAT_DATE('%Y-%m-%d', DATE(closed_at)) AS day,
        CAST(SUM(SAFE_CAST(JSON_VALUE(data_decoded, '$.token_amount.i128') AS NUMERIC)) / 1e18 AS FLOAT64) AS volume,
        COUNT(*) AS count
      FROM ${EVENTS_TABLE}
      WHERE contract_id = @account_manager
        AND successful = TRUE
        AND ${EVENT_NAME} = 'Trader_Borrow'
        AND closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      GROUP BY day
      ORDER BY day
    `,
    params: { account_manager: ACCOUNT_MANAGER, days: LOOKBACK_DAYS },
  };
}

/** Most recent 50 liquidations (AccountManager Trader_Liquidate_Event). */
export function liquidationsQuery(): Built {
  return {
    query: `
      SELECT
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', closed_at) AS closed_at,
        transaction_hash,
        JSON_VALUE(topics_decoded, '$[1].address') AS account
      FROM ${EVENTS_TABLE}
      WHERE contract_id = @account_manager
        AND successful = TRUE
        AND ${EVENT_NAME} = 'Trader_Liquidate_Event'
      ORDER BY closed_at DESC
      LIMIT 50
    `,
    params: { account_manager: ACCOUNT_MANAGER },
  };
}
