# Full-stack sandbox evaluation

This runner sends real HTTP requests to a running app. The app uses its configured
Vertex/MCP services; the runner never substitutes a canned model or MCP. It adds no
production routes or phrase matching. Scenarios define ordered requests, references
and structured assertions. An infrastructure failure is an error, never a pass.

Uses the already installed `playwright-core` API request contexts. Each scenario has
its own cookie jar. JSON and the app's NDJSON investigation stream are supported.
Redirects are disabled so session credentials cannot follow a redirect to another host.
Reports contain step IDs, durations and assertion outcomes, not tokens, cookies,
envelopes, prompts, wallet secrets or raw responses. Reports go to ignored `.local/evaluation`.

## Read-only smoke

```powershell
$env:COPILOT_EVAL_BASE_URL = 'http://localhost:3000'
$env:COPILOT_EVAL_READ_PROMPT = 'what is the price of XLM?'
node scripts/evaluation/run.mjs scripts/evaluation/smoke.json
```

The phrase above is a test input; change it freely. The runner does not interpret it.
The suite requires real MCP mode, a successful research terminal event and an actual
fact. It refuses to treat a healthy web server alone as a successful research run.

`structured-reply.json` adds assertions that the research turn actually returned
composed reply blocks. Use it with the composer enabled and a supported public factual
question. A verified fallback, or a warning-gated response without composed blocks,
fails this quality check even when research itself succeeded.

## Manual testnet transaction roundtrip

`manual-workflow.json` exercises research → proposal → digest approval → build →
wallet signature → app submit → ledger confirmation → durable receipt → whole-run
summary → restored summary → post-action research. It is
deliberately a single-step/manual-sign scenario. Use a funded disposable testnet wallet
bound to the supplied user session, with auto-sign disabled for that scenario.
The prompt must yield one proposed candidate; other outcomes fail rather than choosing
a different execution path silently.

The summary checks require `source=model`, persisted blocks and the same journal hash/ledger
on the original assistant turn. A verified fallback remains safe runtime behavior but fails
this model-quality evaluation. This suite has not been run without the explicitly supplied
funded disposable wallet and bound session. It does not prove auto-approve ON or multi-leg
financial postconditions; use the manual UI prompt checklist for those cases.

Set `COPILOT_EVAL_BASE_URL`, `COPILOT_EVAL_RPC_URL`, `COPILOT_EVAL_PRIVY_TOKEN`,
`COPILOT_EVAL_TESTNET_SECRET`, `COPILOT_EVAL_WALLET`, `COPILOT_EVAL_WRITE_PROMPT`,
`COPILOT_EVAL_BALANCE_PROMPT`, `COPILOT_EVAL_FACT_LABEL`, `COPILOT_EVAL_FACT_UNIT`,
`COPILOT_EVAL_FACT_VENUE` and `COPILOT_EVAL_EXPECTED_DELTA` in the process environment.
Do not put real credentials in suite JSON or commit environment values.

```powershell
node scripts/evaluation/run.mjs scripts/evaluation/manual-workflow.json --execute
```

Execution requires a declared testnet suite and `getNetwork` returning the Stellar
SDK's testnet passphrase from the configured RPC. The research response must also
identify the expected testnet wallet before approval. The signer verifies that the
disposable key matches the expected wallet and transaction source. Signing does not
broadcast; the app's existing submit route remains the authority.

The example checks the first fact's configured label, unit and venue before execution,
then verifies the same scope, label, unit, venue and source path after confirmation.
It checks an explicit exact balance delta using integer arithmetic and a non-older
observation timestamp. Choose a balance quantity with a known delta (account for fees
when checking a fee-paying balance). Unexpected fact ordering fails this fixture;
adapt data paths for the chosen scenario rather than guessing which figure to use. Complex flows
should have their own fixture with every intermediate step and postcondition asserted.

## Suite contract

- `{ "$env": "NAME" }` injects a required process input.
- `{ "$ref": "stepId#/body/path" }` copies an earlier response field.
- A path may be an array of literal route segments and references; it must stay on the app origin.
- Each step must assert something. `eq`, `in`, `exists`, `gte` and `lte` operate on data paths.
- `delta` checks actual minus the resolved `from` value equals the expected decimal `value`.
- Decimal comparisons use integer arithmetic. Supply fractional values as decimal strings.
- HTTP result roots contain `status` and `body`. NDJSON bodies expose the terminal `type` and `result`.
- `poll` requires an explicit attempt/interval budget. Only GET, confirm and recheck observations repeat.
- Approval, advance and submit are never automatically retried. An uncertain outcome stops the scenario.
- Failed checks stop later steps. No execution fallback, auto-funding, faucet or wallet setup is performed.
- Signed-in sessions may also be supplied as Playwright `storageState` through a `$env` path.

Extend fixtures for multiple steps, questionnaire continuations, wallet rejection,
auto-sign ON/OFF, floor preservation and three-pocket balance isolation. Use exact
data references for expected amounts, source accounts and constraints. Expected
financial outcomes must be established from trusted chain state, not model prose.

Sources: [Playwright API testing](https://playwright.dev/docs/test-api-testing),
[Stellar RPC getNetwork](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getNetwork).

## Verification limits

The transport/regression tests use a controlled local HTTP server with fixture responses.
They verify harness mechanics, not deployed MCP or on-chain execution.
A smoke report from a real app is a separate check. A financial roundtrip is only
verified when the explicitly configured disposable-wallet scenario actually runs.
