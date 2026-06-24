# Changelog

## [0.1.1](https://github.com/vannafinance/mercury-stellar-backend/compare/vanna-app-v0.1.0...vanna-app-v0.1.1) (2026-06-24)


### Features

* **farm:** source Aquarius LP history from Mercury ([#38](https://github.com/vannafinance/mercury-stellar-backend/issues/38)) ([6488148](https://github.com/vannafinance/mercury-stellar-backend/commit/648814846b6efcc5db6fc52a0b3d906006d6ace8))
* **margin:** dual-borrow UI + position/health data consistency ([840060f](https://github.com/vannafinance/mercury-stellar-backend/commit/840060f7496410df8ff36199358e95f54851b4d4))
* **margin:** dual-borrow UI + position/health data consistency ([7ece2bd](https://github.com/vannafinance/mercury-stellar-backend/commit/7ece2bd9a249b915f07bf6467d9cf266930a245a))
* **margin:** enable Repay for any real debt incl. sub-cent dust ([46d27bd](https://github.com/vannafinance/mercury-stellar-backend/commit/46d27bdbaa43d025bc3c2960284f38ec7aa81023))
* **margin:** instant reload + shimmer stats (no 0-flash) ([#44](https://github.com/vannafinance/mercury-stellar-backend/issues/44)) ([f202512](https://github.com/vannafinance/mercury-stellar-backend/commit/f2025122c48ee19c28189dd5e6cd85aed63afaa0))
* **margin:** leverage-driven auto-calc for dual borrow ([25d55a9](https://github.com/vannafinance/mercury-stellar-backend/commit/25d55a9ad0a704efbad980151f27bdc30688eb5c))
* **margin:** leverage-driven auto-calc for dual borrow ([e0f7e14](https://github.com/vannafinance/mercury-stellar-backend/commit/e0f7e14ff74933088d2049808f11642aae941f64))
* **mercury/earn:** Mercury-source useEarnTransactions; drop RPC scrapers ([#29](https://github.com/vannafinance/mercury-stellar-backend/issues/29)) ([fd6940b](https://github.com/vannafinance/mercury-stellar-backend/commit/fd6940bb8355269269eec2b2930a03492371e60d))
* **mercury/soroswap:** Mercury-source useSoroswapEvents LP history ([#28](https://github.com/vannafinance/mercury-stellar-backend/issues/28)) ([d2cebc3](https://github.com/vannafinance/mercury-stellar-backend/commit/d2cebc3b9099ab3cf2529d86dc86bf6546e4ae1a))
* **mercury+margin:** farm/margin Mercury events, pure-Mercury history, dust UX + repay fixes ([#32](https://github.com/vannafinance/mercury-stellar-backend/issues/32)) ([d78c773](https://github.com/vannafinance/mercury-stellar-backend/commit/d78c773333c90be2aa356424d0ce4407fde21ed6))
* **mercury:** margin history via Mercury Classic REST (D21 Dev A) ([#24](https://github.com/vannafinance/mercury-stellar-backend/issues/24)) ([a575384](https://github.com/vannafinance/mercury-stellar-backend/commit/a5753845259950c62406f12ca9094cb919e11e55))
* **mercury:** per-account event filter + cursor pagination ([#26](https://github.com/vannafinance/mercury-stellar-backend/issues/26)) ([9dfdfca](https://github.com/vannafinance/mercury-stellar-backend/commit/9dfdfca1f312ca690e63599ba5c9db4ae720746d))
* **mercury:** server-side GraphQL proxy + client (D20 foundation) ([#23](https://github.com/vannafinance/mercury-stellar-backend/issues/23)) ([afbac2b](https://github.com/vannafinance/mercury-stellar-backend/commit/afbac2bfa3bcae7bd2e92058d1997346d309ebab))
* **optimistic-earn:** optimistic updates for earn supply + withdraw ([c76af38](https://github.com/vannafinance/mercury-stellar-backend/commit/c76af389476fdaa1a897164b543f8110215e2c5e))
* **optimistic-earn:** optimistic updates for earn supply + withdraw ([5cf92e5](https://github.com/vannafinance/mercury-stellar-backend/commit/5cf92e5c772dc1cc32d70790eb968c0c0ce27aa7))
* **optimistic-margin:** optimistic debt + HF update for loan repay ([8c6bf38](https://github.com/vannafinance/mercury-stellar-backend/commit/8c6bf3863c0f9d1aad7c6cc78d7dc3840c064db4))
* **optimistic-margin:** optimistic debt + HF update for loan repay ([e7a4c61](https://github.com/vannafinance/mercury-stellar-backend/commit/e7a4c61f18018a712bd715ca5cbacbe23185e753))
* **perf:** D25 account snapshot + edge cache (/api/account, /api/pools) ([#40](https://github.com/vannafinance/mercury-stellar-backend/issues/40)) ([c52ce51](https://github.com/vannafinance/mercury-stellar-backend/commit/c52ce51dd64dfa917e2044750e9ac3d55c10940a))
* **s1-day-1:** LedgerSubscriberProvider + doc sync to current state ([1c6c562](https://github.com/vannafinance/mercury-stellar-backend/commit/1c6c5626428fa42b315e46fc8d87f3afe9e140ad))
* **stats:** Hubble analytics + /stats (gated) + branded 404 ([#35](https://github.com/vannafinance/mercury-stellar-backend/issues/35)) ([26878ac](https://github.com/vannafinance/mercury-stellar-backend/commit/26878ac6abbda07b5a0e0a6db0b6a84c4af143a5))
* **test:** add vitest test infrastructure + 80 passing tests ([e37d31b](https://github.com/vannafinance/mercury-stellar-backend/commit/e37d31b70d2e5998916b4f0b0bcac2931769f1a9))
* **test:** add vitest test infrastructure + 80 passing tests ([59555ab](https://github.com/vannafinance/mercury-stellar-backend/commit/59555abb948389cfedc13691fac62da13484a033))


### Bug Fixes

* **earn:** instant Overall Deposit headline (live total, not throttled snapshot) ([d3b0036](https://github.com/vannafinance/mercury-stellar-backend/commit/d3b0036ab8d188aec0e92bd5d3700ef397a06546))
* **error-ux:** catch Freighter XDR cancel error as user cancellation ([ec7261f](https://github.com/vannafinance/mercury-stellar-backend/commit/ec7261f2632d3ee614ae8976810a32d0b4ef71f6))
* **error-ux:** normalize Freighter-cancel across margin/farm/swap/lite (D16-17 follow-up) ([#21](https://github.com/vannafinance/mercury-stellar-backend/issues/21)) ([b4d4fae](https://github.com/vannafinance/mercury-stellar-backend/commit/b4d4fae720544c15cfbe9593e9aca80704bd93fc))
* **farm:** 4-column Positions table, breakdown as subtext (no overlap) ([6def352](https://github.com/vannafinance/mercury-stellar-backend/commit/6def352e2becbb7e5c45403769d6189531288b91))
* **farm:** correct Positions table column labels ([09c9c7a](https://github.com/vannafinance/mercury-stellar-backend/commit/09c9c7a45851f90aae38761d4aea4c22ef6a1d97))
* **home:** single-source the store from the snapshot (stop positions flicker) ([b671fbc](https://github.com/vannafinance/mercury-stellar-backend/commit/b671fbceb023c9958d3e141d7f9eaa0d9375cd90))
* **layout, margin-store:** hydrate marginAccountAddress globally on wallet connect ([0a6a24d](https://github.com/vannafinance/mercury-stellar-backend/commit/0a6a24de0492491c56c11e88a17e88b5267565ee))
* **lite:** redirect away from Earn in lite mode ([ee845b2](https://github.com/vannafinance/mercury-stellar-backend/commit/ee845b2ef4bb371a29d4e229e7cbd72a2a2a6f44))
* **lite:** replace dead fetch('/api/prices') with oracle price hook ([a4e73b2](https://github.com/vannafinance/mercury-stellar-backend/commit/a4e73b2fe9851c61ee19b307e7c38bf489964602))
* **margin-store:** use BigInt arithmetic for WAD borrow-amount conversion ([332295e](https://github.com/vannafinance/mercury-stellar-backend/commit/332295e8f28f201ccbb265b5233ae24a9b9fdb34))
* **margin/earn:** post-merge position fixes, budget split-fallback, no-optimistic UX ([#27](https://github.com/vannafinance/mercury-stellar-backend/issues/27)) ([6b59cdc](https://github.com/vannafinance/mercury-stellar-backend/commit/6b59cdc9e44c8340bec03151e7f194c990edff46))
* **margin:** guard post-success store refresh against transient Freighter getAddress() failures ([75066a8](https://github.com/vannafinance/mercury-stellar-backend/commit/75066a8ff8bf48ed506250ecb6a86587234a5e20))
* **margin:** instant MB collateral + full-precision amount inputs ([f9a32a9](https://github.com/vannafinance/mercury-stellar-backend/commit/f9a32a90f18c9444a12d440f0c2cea5cf1fb5dc5))
* **margin:** stable newest-account resolution + bounded lookback ([#37](https://github.com/vannafinance/mercury-stellar-backend/issues/37)) ([c371d0d](https://github.com/vannafinance/mercury-stellar-backend/commit/c371d0dc1747a01031e5921f3b40542f025d03c5))
* **one-click:** decouple deposit-only (1x) from the borrow contract path ([70e2946](https://github.com/vannafinance/mercury-stellar-backend/commit/70e294672dff7071d0f0e6da135e87f3e82268ce))
* **one-click:** respect real XLM min reserve on deposit (fixes Contract [#10](https://github.com/vannafinance/mercury-stellar-backend/issues/10)) ([6060fe1](https://github.com/vannafinance/mercury-stellar-backend/commit/6060fe1a4d92107bd3a1ff51dfcb509773719425))
* **price:** source XLM from Reflector oracle, drop CoinGecko (D12 follow-up) ([#20](https://github.com/vannafinance/mercury-stellar-backend/issues/20)) ([99b21d7](https://github.com/vannafinance/mercury-stellar-backend/commit/99b21d702aa5659f07cc097ea290c378ff5e5e0a))


### Performance Improvements

* **analytics:** edge-cache the protocol-wide account scan ([#46](https://github.com/vannafinance/mercury-stellar-backend/issues/46)) ([ccfcca7](https://github.com/vannafinance/mercury-stellar-backend/commit/ccfcca72d867cf3df82830a6aaf5e139ed353f0b))
