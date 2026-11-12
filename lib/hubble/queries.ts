// Hubble (BigQuery) analytics queries for the /stats page, scoped to the
// CURRENT credit-layer architecture: the 4 Reserves (XLM, BLUSDC, AQUSDC,
// SOUSDC) + the CreditLayer. Each builder returns { query, params } for `runQuery`.
//
// Credit-layer events (testnet redeploy 2026-11-06):
//   Reserve:     supplied / redeemed  [name, lender] data LenderEvent { lender, assets, shares }
//   CreditLayer: borrowed             [name, margin] data { margin, token, amount }
//                liquidated           [name, margin] data { margin, liquidator }
// All amounts are U256 WAD (1e18), so they decode as {"u256":"..."}.
//
// ─────────────────────────────────────────────────────────────────────────
// SCHEMA: verified live against the dataset (2026-06-16).
//   • Table is `history_contract_events` (NOT `contract_events`).
//   • Event name = topics_decoded[0].symbol  → JSON_VALUE(topics_decoded,'$[0].symbol')
//   • Topic addresses = topics_decoded[n].address (e.g. the margin account in topic2).
//   • Payload = data_decoded (typed JSON): a scalar i128 is {"i128":"..."}, a
//     struct is keyed by field, each value typed — so an amount field reads as
//     JSON_VALUE(data_decoded,'$.<field>.i128') (or `.u256` for the U256 WAD
//     amounts the credit-layer contracts emit). closed_at/contract_id as expected.
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
].filter(Boolean) as string[];

const CREDIT_LAYER = CONTRACT_ADDRESSES.CREDIT_LAYER;

/** U256 WAD field of the event payload → NUMERIC in whole tokens. */
const wadField = (field: string) => `SAFE_CAST(JSON_VALUE(data_decoded, '$.${field}.u256') AS NUMERIC) / 1e18`;

const LOOKBACK_DAYS = 90;

type Built = { query: string; params: Record<string, unknown> };

/** Daily supply / redeem flow (underlying, WAD) across the 4 Reserves (90 days). */
export function tvlQuery(): Built {
  return {
    query: `
      SELECT
        FORMAT_DATE('%Y-%m-%d', DATE(closed_at)) AS day,
        CAST(SUM(CASE WHEN ev = 'supplied' THEN amt ELSE 0 END) AS FLOAT64) AS deposits,
        CAST(SUM(CASE WHEN ev = 'redeemed' THEN amt ELSE 0 END) AS FLOAT64) AS withdrawals
      FROM (
        SELECT closed_at,
          ${EVENT_NAME} AS ev,
          ${wadField("assets")} AS amt
        FROM ${EVENTS_TABLE}
        WHERE contract_id IN UNNEST(@pools)
          AND successful = TRUE
          AND closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      )
      WHERE ev IN ('supplied', 'redeemed')
      GROUP BY day
      ORDER BY day
    `,
    params: { pools: POOLS, days: LOOKBACK_DAYS },
  };
}

/** Top 100 margin accounts all-time, by total borrowed (CreditLayer `borrowed`). */
export function topBorrowersQuery(): Built {
  return {
    query: `
      SELECT
        JSON_VALUE(topics_decoded, '$[1].address') AS account,
        COUNT(*) AS borrow_count,
        CAST(SUM(${wadField("amount")}) AS FLOAT64) AS total_borrowed
      FROM ${EVENTS_TABLE}
      WHERE contract_id = @credit_layer
        AND successful = TRUE
        AND ${EVENT_NAME} = 'borrowed'
        AND JSON_VALUE(topics_decoded, '$[1].address') IS NOT NULL
      GROUP BY account
      ORDER BY total_borrowed DESC
      LIMIT 100
    `,
    params: { credit_layer: CREDIT_LAYER },
  };
}

/** Daily borrow volume (90 days) from CreditLayer `borrowed`. */
export function volumeQuery(): Built {
  return {
    query: `
      SELECT
        FORMAT_DATE('%Y-%m-%d', DATE(closed_at)) AS day,
        CAST(SUM(${wadField("amount")}) AS FLOAT64) AS volume,
        COUNT(*) AS count
      FROM ${EVENTS_TABLE}
      WHERE contract_id = @credit_layer
        AND successful = TRUE
        AND ${EVENT_NAME} = 'borrowed'
        AND closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      GROUP BY day
      ORDER BY day
    `,
    params: { credit_layer: CREDIT_LAYER, days: LOOKBACK_DAYS },
  };
}

/** Most recent 50 liquidations (CreditLayer `liquidated`; topic[1] = margin account). */
export function liquidationsQuery(): Built {
  return {
    query: `
      SELECT
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', closed_at) AS closed_at,
        transaction_hash,
        JSON_VALUE(topics_decoded, '$[1].address') AS account
      FROM ${EVENTS_TABLE}
      WHERE contract_id = @credit_layer
        AND successful = TRUE
        AND ${EVENT_NAME} = 'liquidated'
      ORDER BY closed_at DESC
      LIMIT 50
    `,
    params: { credit_layer: CREDIT_LAYER },
  };
}
