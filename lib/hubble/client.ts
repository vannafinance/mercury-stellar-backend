// BigQuery client for Hubble — SDF's public Stellar dataset
// (`crypto-stellar.crypto_stellar.contract_events`). Server-only.
//
// The client is lazy: it is built on first query, not at import time, so the
// app boots fine while `GOOGLE_CREDS_JSON` is still missing (the API routes
// return a clean "not configured" instead of crashing). The dataset lives in
// the US multi-region, so queries are pinned to `location: "US"`.

import { BigQuery } from "@google-cloud/bigquery";

let client: BigQuery | null = null;

/**
 * Configured if EITHER credential path is available:
 *  - `GOOGLE_CREDS_JSON` — a service-account key JSON (prod / Vercel).
 *  - `GOOGLE_CLOUD_PROJECT` — use Application Default Credentials instead
 *    (e.g. `gcloud auth application-default login` locally, or the metadata
 *    server on GCP). No key file needed — handy while the org policy blocks
 *    service-account key creation.
 */
export function isHubbleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CREDS_JSON || process.env.GOOGLE_CLOUD_PROJECT);
}

function getClient(): BigQuery {
  if (client) return client;
  const raw = process.env.GOOGLE_CREDS_JSON;
  if (raw) {
    const credentials = JSON.parse(raw);
    client = new BigQuery({ credentials, projectId: credentials.project_id });
  } else if (process.env.GOOGLE_CLOUD_PROJECT) {
    // Application Default Credentials — no explicit key.
    client = new BigQuery({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
  } else {
    throw new Error("Hubble not configured: set GOOGLE_CREDS_JSON or GOOGLE_CLOUD_PROJECT");
  }
  return client;
}

/** Run a parameterized query against Hubble and return plain rows. */
export async function runQuery<T = Record<string, unknown>>(
  query: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const bq = getClient();
  const [rows] = await bq.query({ query, params, location: "US" });
  return rows as T[];
}
