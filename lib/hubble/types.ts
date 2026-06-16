// Row shapes returned by the Hubble analytics API routes. The SQL casts dates
// to ISO strings and amounts to FLOAT64 (see queries.ts) so these are plain
// JSON — no BigQuery wrapper types leak to the client.

export type TvlPoint = {
  day: string; // YYYY-MM-DD
  deposits: number; // token units (see scaling note in queries.ts)
  withdrawals: number;
};

export type TopBorrower = {
  account: string;
  borrow_count: number;
  total_borrowed: number;
};

export type VolumePoint = {
  day: string; // YYYY-MM-DD
  volume: number;
  count: number;
};

export type LiquidationRow = {
  closed_at: string; // ISO 8601
  transaction_hash: string;
  account: string;
};
