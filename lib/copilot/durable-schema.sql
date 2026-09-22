-- Copilot durable state (P3). One Postgres schema, five concerns.
-- Cloud SQL is unprovisioned in this environment — do not invent an instance.
-- File backends under .local/copilot-* implement the same shape until DATABASE_URL exists.
-- Firestore is out (IAM grant was rejected).

CREATE TABLE IF NOT EXISTS copilot_sessions (
  subject       TEXT PRIMARY KEY,
  turns         JSONB NOT NULL,
  continuation  TEXT,
  result        JSONB,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS copilot_approvals (
  workflow_id   UUID PRIMARY KEY,
  subject       TEXT NOT NULL,
  digest        TEXT NOT NULL,
  status        TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  record        JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS copilot_approvals_subject ON copilot_approvals (subject);

CREATE TABLE IF NOT EXISTS copilot_checkpoints (
  workflow_id       UUID PRIMARY KEY,
  subject           TEXT NOT NULL,
  status            TEXT NOT NULL,
  digest            TEXT NOT NULL,
  settled_step_ids  JSONB NOT NULL,
  current_step_id   TEXT,
  last_tx_hash      TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS copilot_standing_orders (
  id            UUID PRIMARY KEY,
  subject       TEXT NOT NULL,
  trader        TEXT NOT NULL,
  smart_account TEXT,
  trigger       JSONB NOT NULL,
  action        JSONB NOT NULL,
  expiry        TIMESTAMPTZ NOT NULL,
  approval      JSONB,
  status        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  last_evaluated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS copilot_standing_orders_subject ON copilot_standing_orders (subject);

CREATE TABLE IF NOT EXISTS copilot_audit (
  at            TIMESTAMPTZ NOT NULL,
  subject       TEXT NOT NULL,
  action        TEXT NOT NULL,
  workflow_id   TEXT NOT NULL,
  digest        TEXT,
  step_id       TEXT,
  tx_hash       TEXT,
  evidence_ids  JSONB,
  floor         TEXT,
  cap_usd       JSONB,
  reason        TEXT
);

CREATE INDEX IF NOT EXISTS copilot_audit_subject_at ON copilot_audit (subject, at);
