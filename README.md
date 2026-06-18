# Vanna — Stellar

Vanna Finance's Stellar-side frontend and on-chain integration. A Next.js (App
Router) app for **margin trading, lending (Earn), and farming** on Soroban —
talking to Stellar via the Stellar SDK, Horizon, the Mercury indexer, and (for
protocol analytics) SDF's Hubble BigQuery dataset.

## Stack

- **Next.js 16** (App Router), React, TypeScript (strict)
- **TanStack Query** + **Zustand** for data + state
- **Stellar SDK** · Soroban RPC · Horizon
- **Mercury** indexer (per-account event history)
- **Hubble** / BigQuery (protocol-wide `/stats` analytics, feature-gated)
- Tailwind CSS · Recharts · Framer Motion

## Data architecture

Reads flow through three layers, each for a different question:

| Layer | Answers | Used by |
| --- | --- | --- |
| **RPC** (Soroban) | "what does this account hold *now*?" | live balances, HF, the cached `/api/account` + `/api/pools` snapshots |
| **Mercury** | "what did *this account* do?" | per-user history tabs |
| **Hubble** | "what is the *whole protocol* doing?" | the `/stats` page |

See [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) for the full rationale.

## Getting started

```bash
npm install
# create .env.local (see Environment below)
npm run dev
```

Open http://localhost:3000.

## Environment

Server-only values in `.env.local` (never committed):

| Variable | Purpose |
| --- | --- |
| `SOROBAN_RPC_URL` | Soroban RPC endpoint |
| `HORIZON_URL` | Horizon endpoint |
| `MERCURY_URL`, `MERCURY_KEY` | Mercury indexer (event history) — proxied server-side |
| `GOOGLE_CREDS_JSON` | Hubble/BigQuery service-account key (protocol `/stats`) |
| `STATS_ENABLED` | `"true"` to expose the gated `/stats` page + analytics routes (off by default) |

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run test` | Unit tests (Vitest) |

## License

Proprietary — see [LICENSE](LICENSE). © Vanna Finance. All rights reserved.
