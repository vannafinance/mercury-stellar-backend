# Session handoff — Vanna Copilot, 11 Sep 2026 *(rev 4 — first signed-in battery run; the copilot is more enumerated than intelligent)*

**For any AI agent** — Claude, Grok, Gemini, Cursor, GPT. Written so you can pick this up
cold and work at the same level: test, audit, decide, and write the next handoff yourself.

Read §0 and §1 before touching anything. **§5–§8 are the parts you cannot reconstruct from
the repo** — decisions and their reasoning, what was already tried and failed, and where the
previous agent was wrong.

**Honest opening:** every infrastructure blocker is now closed — write scope, transport,
schema, auto-approve. The write path works end to end. **And the first real signed-in battery
showed the copilot is substantially enumerated rather than intelligent.** Four defects, all
the same shape: capability that belongs in the model, or should be derived from data, was
moved into a hand-maintained list. **§3d.**

That is the real state of this project. Do not read the passing suite, the green deploys, or
the confident-looking screenshots as evidence the agent reasons — in the places that matter,
it fills a template.

---

## 0. How to work here — non-negotiable

| Rule | Detail |
|---|---|
| **Do not commit or push** | Leave work in the tree; say what changed. Aditya decides what reaches GitHub. |
| **Never raise a PR from `copilot-upgrade`** | To anything, unless asked by name. |
| **`dev` is read-only** | Pull from it (`git merge origin/dev` while on our branch). Never merge into it, push to it, or check it out. State direction and location when reporting: *"merged origin/dev into copilot-upgrade, locally, nothing pushed."* |
| **Copilot scope only** | §2. Report bugs in app code; do not fix them. |
| **Never deploy contracts** | MCP and Sign Service deploys are authorised; contracts never. |
| **Commits, when asked** | Aditya's name only, one short line, no AI attribution. |
| **Research before recommending** | Web-search current production practice before proposing an architecture or technology, then say where our design falls short — and **always return sources as links**. |
| **Write the next handoff unprompted** | After verifying, generate the next phase handoff. Never ask permission to write a document. |
| **Report honestly** | Failures as failures, with output. If a hypothesis in a handoff was wrong, say which and what the truth was — that has been the most valuable line in every report. |

**Do not test while an agent is editing the tree.** Eight files written in fifteen minutes
broke a live test session: every save recompiles, the route module swaps mid-request, and an
in-flight Approve dies with no response, no popup, no error. Freeze, then test.

---

---

## 0a. How to audit here — the working method

This is the part that is hardest to reconstruct and the part that matters most. Aditya works
with several coding agents in parallel (Grok in Cursor, Gemini in Antigravity, Astra) and one
auditor. **If you are the auditor, this is the job.**

### Never fix by enumeration

**A fix that names a capability, tool, symbol, field, venue or phrase is not a fix.** It works
for the case in front of you and leaves the next one broken identically. Fix the mechanism,
then prove it on an input **nobody enumerated**. Write every acceptance test in the form
*"something not in any list now works."*

This applies to **every** agent, on **every** kind of work — coding, testing, auditing,
recommending. When the generalised fix is genuinely more work, say so and let Aditya decide.
Never quietly ship the enumerated version. Full rule in memory as
`feedback-no-hardcoded-fixes`.

### Verify, do not relay

Agent reports are evidence, not conclusions. Three real examples from this project:

- A deploy report listed *"a read-scoped token sees no write tools"* as a **passing** security
  criterion. The observation was correct. The token was **the app's own production
  credential** — the split had locked out the first party, and production could not write.
  The report and the outage were the same sentence read two ways.
- The same report claimed the token carried `vanna:read`. Decoding it showed **no scope claim
  at all**. Nobody had looked.
- Two criteria were reported verified but had been established by **reading the source**, not
  by calling the deployed service.

So: re-run the claim yourself, against the live system, with the real credential. **Ask who the
test credential belongs to** — a criterion that proves a stranger is blocked proves nothing
until you have checked you are not the stranger.

### When a check disagrees with a passing test, suspect the check

A parity script here once reported drift that did not exist, a "fix" based on it broke a
working path, and the passing test that caught it was initially dismissed as stale. Cost: a
production tool mapping. **The passing test is usually right.**

### Read the error, not the symptom

Three consecutive failures this session looked like copilot bugs and were not: a scope gate in
the MCP server, a dropped TLS connection, and an unapplied database migration. Each was sitting
in plain text in a service log. **When a write fails but reads work, read the service's own
logs before touching app code.**

### Say what is not proven

Distinguish measured, inferred, and assumed — every time. "Measured from one machine on one
ISP" is a different claim from "the endpoint is fine". Aditya makes decisions on these
statements; hedging late is worse than hedging early.

## 1. What this is

An agent-native margin copilot for Vanna on Stellar/Soroban. A user states an objective in
their own words; the system investigates the live account through audited reads, sizes
options in deterministic code, proposes them for approval, executes leg by leg, and verifies
what settled.

**The goal:** handle any prompt a user gives, with real domain intelligence — not a pattern
matcher with a model bolted on. Understanding is deliberately unlimited. **Only arithmetic
and authority are closed.**

| | Path | Tests | Deploys to |
|---|---|---|---|
| App | `C:\Users\akgam\Documents\vanna-copilot-orchestrator` | `npx tsc --noEmit`, `npx vitest run` | GCP `vanna-main` |
| MCP | `C:\Users\akgam\Documents\vanna_mcp` | `python -m pytest tests/ -q`; sign-service uses **`npm test`** (node --test, *not* vitest) | GCP `vanna-mcp` |

**MCP and the copilot are two separate products.** MCP ships publicly, like Aave's.

---

## 2. Scope boundary

| In scope | Out of scope — the app developer's |
|---|---|
| `lib/copilot/**`, `components/copilot/**`, `app/api/copilot/**` | any page, any component outside `components/copilot/` |
| `hooks/use-investigation.ts`, `use-copilot-entry.ts`, `use-workflow.ts` | `components/margin/**`, `navbar.tsx`, `components/wallet/**`, `app/globals.css` |
| `lib/usable-read.ts`, `docs/copilot/**`, `.claude/**`, copilot tests | `lib/account-snapshot.ts`, `lib/margin-utils.ts`, `lib/blend-utils.ts`, `lib/mercury-*`, `app/api/mercury/**` |
| the whole `vanna_mcp` repo | `store/**`, `contexts/**`, `hooks/use-wallet.ts`, `use-margin.ts` |

Narrow exception, flag every time: `instrumentation.ts` (Next.js requires repo root), the
`next.config.ts` hook, `package.json` deps, CI config, `lib/server/broken-pipe.ts`.

---

## 3. Current state

- **App** `copilot-upgrade` @ `26a29de` (merged `origin/dev`), ~56 uncommitted files — Grok's thread, P2 peel, P3 store. `handle.ts` **4,346** (target met). vitest **1650 / 0 / 3**.
- `tsc` clean · vitest **1,636 / 0 / 3** · MCP pytest **582** · sign-service **232**.
- `handle.ts` **~7,900** (from 8,642). Realistic target **~4,000–4,500**, *not* 2,000 — writes legitimately live there. `router.ts` ~2,645.
- **Deployed (11 Sep, by Gemini):** `vanna-mcp-server 00092-2ch` (was `00091-sbs`), `vanna-sign-service 00049-vzh`, `vanna-connect-gateway 00011-mwr`. MCP `main` @ `60b2717` **+ three local commits that are NOT pushed** — `01de49c` (the deployed state, pinning what is live), `8ab4a36` (docs), `b5398d1` (the §3a fix). Push them: `cd C:/Users/akgam/Documents/vanna_mcp && git push origin main`. Revisions confirmed by `gcloud run services describe`.
- **Langfuse** local `:3100` — `aditya@vanna.finance` / `vanna-local-dev`. OTLP verified.
- **Test account:** Privy `GD4BQR…NPDH` → `CBOQAN…G5XY`, testnet. **Privy embedded, not Freighter** — auto-approve ON *is* testable.

**Proven:** `repay 1 XLM` landed — tx `075aa4a1…`, ledger **4619359**, Horizon
`successful: true`. Proposed → approved → signed → submitted → settled → confirmed. What
fixed it was not the write code; it was bounding the app snapshot so risk validation could
finish. Health questions answer in ~16s from contract `liquidation_snapshot`. Auto-approve
arms with $1000/tx, $1000/day.

**Not proven:** open-ended strategy prompts (§4), three-turn refinement, live on-chain
injection test, anything under load.

---

---

## 3a. RESOLVED — the app could not write against production

**Status: RESOLVED in production, 11 Sep.** Kept here because the *shape* of this failure
recurs — see "How to apply" in `[[mcp-scope-gate-blocks-first-party-writes]]`.

Fixed by revision **`vanna-mcp-server-00092-2ch`** (source commit `b5398d1`). Verified
independently, not taken on report: `tools/list` against `https://mcp.vanna.finance/mcp`
with the app's own token now returns **18 tools including `vanna_sign`**, with all six
write surfaces present. Before the redeploy it returned 9 and none could write.

The fix grandfathers the first-party client id with a dated removal note (2026-12-31) and
makes an unauthenticated caller fail closed. Both were the right calls.

Everything below is the original finding, kept as the record of how it was found.

### What is true, with evidence

Against production `https://mcp.vanna.finance/mcp`, using the app's own credential
(`WORKOS_M2M_CLIENT_ID=client_01KXBNHSTPDZZ90370X7JEQ7HS` from `.env.local`), `tools/list`
returns **9 tools and not one of them can write**:

```
vanna_account_read   vanna_earn_market     vanna_earn_position
vanna_farm_overview  vanna_margin_read     vanna_margin_status
vanna_oracle         vanna_protocol_info   vanna_wallet
```

No `vanna_margin_write`, no `vanna_account_write`, no `vanna_earn_write`, no `vanna_swap`,
no `vanna_farm_lp`, no `vanna_farm_blend`. Legacy `vanna_margin_trade` still dispatches, but
its write actions are rejected with `insufficient_scope`.

### Why

The app's M2M token **carries no scope claim at all**. Decoded claim set, verbatim:

```
aud   client_id   exp   iat   iss   jti   org_id   sub
```

There is no `scope`, no `scp`, no `permissions`. Requesting `scope=vanna:write` at the token
endpoint returns **HTTP 400** - the scope is not configured on that WorkOS client.

Then, in `vanna-mcp/mcp_server/identity.py`:

```python
def caller_scopes() -> set[str] | None:
    claims = current_claims()
    if claims is None:
        return None          # unauthenticated -> unrestricted
    raw = claims.get("scope") or claims.get("scp")
    if raw is None:
        return set()         # authenticated, no scope -> nothing
    ...

def caller_has_write_scope() -> bool:
    scopes = caller_scopes()
    if scopes is None:
        return True          # unauthenticated can write
    return bool(scopes & WRITE_SCOPES)
```

**The default is inverted.** An *unauthenticated* caller is treated as unrestricted; an
*authenticated* caller whose IdP simply does not emit scopes is treated as read-only. The
app is the second case, so the app is locked out.

This is the same failure shape as `copilot-reads-only-gate-blocked-all-writes` in memory -
a gate that is invisible from the app side, because the app sees a healthy server answering
reads.

### Fix - do the first one, and separately fix the inversion

1. **Preferred, no code:** attach `vanna:write` to the first-party M2M client in WorkOS
   (`sensitive-silk-47-staging`), then re-run the `tools/list` probe and confirm the write
   tools appear. This keeps the gate honest and the security split intact.
2. **If WorkOS cannot be changed quickly:** grandfather **by client id only** - a hardcoded
   first-party client id gets write for one release, with a dated removal note. **Do not**
   make a missing scope claim globally unrestricted; that reopens the confused deputy for
   every third-party token, which is the entire reason the split was built.
3. **Independently:** `caller_scopes() is None` must not grant write. Unauthenticated should
   be the most restricted case, not the least.

**Acceptance:** the app's real token is offered the write tools in `tools/list`, **and** one
real write lands on chain from `/copilot` against the deployed server - not a local one.

### Two other things from the same deploy

- **Production has no source pin.** The deploy shipped an uncommitted working tree - 23
  modified files, nothing committed, `main` level with `origin/main`. Nothing records what
  is inside revision `00091-sbs`, and a stray `git checkout` would destroy the only copy.
  `asset_ids.py` (created 10:58 UTC) postdates the deploy (10:32 UTC), so the Gap 1 work is
  **not** live. **Commit the deployed state and tag it before the next deploy.**
- **Credentials were exposed in plaintext.** A full service-account JSON for
  `vanna-copilot@vanna-mcp.iam.gserviceaccount.com` (base64, private key included) and the
  WorkOS M2M client secret were pasted inline into shell commands and into scratch scripts
  under the Antigravity scratch directory. They are in shell history and on disk.
  **Rotate both**, and never inline a key - read it from the file.

### What in Gemini's report held up, and what did not

| Claim | Verdict |
|---|---|
| Revisions `00091-sbs` / `00049-vzh` deployed | **True** - confirmed via `gcloud run services describe` |
| Nothing committed or pushed | **True** - `main` is level with `origin/main` |
| Reads answer live with real numbers | **True** - durations and shapes look genuine |
| Legacy `vanna_margin_trade` / `vanna_account` still dispatch | **True** |
| Rate limiting degrades to 429 under burst | **True** - live-measured, 4 of 8 throttled |
| `duration_ms` present on responses | **True** |
| "Read-scoped token sees no write tools" = criterion **passed** | **Misread.** The observation is correct; the conclusion is not. That token *is the app's production credential*. The split did not merely work - it locked out the first party. |
| "The M2M token issues `vanna:read` and `read:copilot`" | **False.** The token carries no scope claim whatsoever. |
| Criterion 4 - cross-client `client_not_authorized` returns `unsignedXdr` | **Not verified.** Established by reading `sign_tools.py`, not by calling the deployed service. Still open. |
| Criterion 5 - existing sessions still sign, `first-party` migration | **Not verified.** Same - code-reading, not a live call against real rows. Still open. |
| "git status: no unrelated in-flight changes" | **False** - 23 modified files were in the build context. |

**The pattern to carry forward:** Gemini's measurements were sound and its code reading was
accurate. What it did not do is ask *who the test credential belongs to*. A criterion that
proves a stranger is blocked proves nothing until you have checked that you are not the
stranger.

---

## 3b. OPEN - the MCP handshake has no retry, and the public hostname is lossy here

**Status: open.** Found immediately after \u00a73a was fixed, because the error text changed from
`Tool 'vanna_sign' requires write scope` to `could not reach MCP (fetch failed)` - a
network error wearing the same clothes as a permission error.

### Measured, 20 requests per endpoint, from the author's machine

| Endpoint | Reachable | Failed |
|---|---|---|
| `https://mcp.vanna.finance/mcp` (Cloud Run domain mapping) | 12 / 20 | **8** |
| &nbsp;&nbsp;\u2192 IPv6 `2404:6800:4000:1010::79` only | **0 / 12** | 12 |
| &nbsp;&nbsp;\u2192 IPv4 `142.251.106.121` only | 8 / 12 | 4 |
| `https://vanna-mcp-server-uscm2gn35a-uc.a.run.app/mcp` (direct) | **20 / 20** | 0 |

Same server, identical 18-tool `tools/list` over both.

**The mapping itself is healthy.** `gcloud beta run domain-mappings describe` reports
`Ready`, `CertificateProvisioned` and `DomainRoutable` all `True` since 9 Jul 2026. So this
is a network path between one machine and the `ghs.googlehosted.com` frontend, **not** a
misconfigured mapping.

**Do not conclude the public endpoint is fine.** This was measured from a single machine on
a single ISP. IPv6 being 0/12 while IPv4 is 8/12 points at a local path problem, but one
vantage point cannot prove that. **Someone off this network must run the same loop before
the MCP is announced** - `mcp.vanna.finance` is the hostname Claude Code, Cursor and every
third-party agent will be given, and they cannot fall back to a `run.app` URL.

### Why it looked like an auto-sign bug

`getSession()` caches the session id, so reads ride an already-open session and rarely
handshake. A cold auto-sign attempt needs a **fresh `initialize`**, so each attempt is an
independent coin flip. Restarting the dev server made it *more* likely to fail, because a
restart guarantees a cold handshake - which is why "I restarted and it still fails" was
evidence *for* this cause, not against it.

The UI toast *"Auto-approve refused - the Sign Service is not enforcing spend caps"* is
correct behaviour on bad input: the status call failed, so caps could not be confirmed, so
the client refused to arm on a browser-only limit. Do not "fix" that refusal.

### The fix, in two parts

1. **Retry the handshake.** `getSession()` in `lib/copilot/mcp-client.ts:396` throws
   `MCPCallError` on the first network failure with no retry - `call()` retries only a
   *stale session*, which is a different case. `lib/copilot/retry-policy.ts` already exists
   and is not used here. Retry twice with backoff on a network throw, and leave the
   timeout and auth branches alone. **This is needed whoever's network is at fault**: a
   public endpoint over the internet will drop connections for somebody.
2. **Confirm the hostname from off this network** before the MCP is announced. If it is
   lossy generally, that is a launch blocker and the mapping needs replacing, not retrying.

### Temporary local workaround - do not commit, do not deploy

`.env.local` now points at the direct Cloud Run URL so auto-approve can be tested at all,
with the audience pinned so it cannot drift if `mcpSendResource` is ever turned on:

```
MCP_BASE_URL=https://vanna-mcp-server-uscm2gn35a-uc.a.run.app/mcp
MCP_RESOURCE=https://mcp.vanna.finance/mcp
```

Backup at `.env.local.bak`. **Revert once the retry lands.** Shipping this would hide the
problem rather than fix it, and it does nothing for third-party callers.

---

## 3c. RESOLVED - Sign Service 500, and the deploy-ordering rule

After §3a and §3b were cleared the copilot reported *"Sign Service returned non-JSON
(HTTP 500)"*. Cause, straight from the service's Cloud Run log:

```
error: column "client_id" does not exist
    at async getActiveSessionByWallet (/app/src/sessions/store.ts:106:20)
```

`007_session_client_id.sql` had **never been applied to the production database**, while the
code that queries the column was already deployed. Every `/sessions` call threw, the service
returned an HTML 500, and auto-approve refused because caps could not be confirmed. One
missing `ALTER TABLE` produced what looked like four separate bugs.

Applied 11 Sep via a one-off Cloud Run Job on the service's own image - verified from the job
log, `Applied 1 migration(s): 007_session_client_id.sql`, exit 0. The Cloud SQL proxy route
is a dead end: public IP has an empty authorized-networks list, so only the Cloud Run socket
works. Exact command and the `--args="^|^run|migrate"` gotcha are in
`[[sign-service-migrations-via-cloud-run-job]]`.

**The rule, now broken three times in two days:** the side that must lead is whichever side
grants capability. The MCP server had to gain write scope before the app could write (§3a);
the database must gain a column before the code that reads it ships (here). **Before any
Sign Service deploy, check whether `migrations/` gained a file, and run the job first.**

---

## 3d. The first signed-in battery — what it actually showed

Run 11 Sep with auto-approve **on**. Infrastructure held. The agent behaviour did not.

### Finding 1 — every option button is dead *(proven)*

`POST /api/copilot/workflow/propose` returns **400** on every *Prepare this plan* and
*Switch →*. The route requires `/^[a-z0-9_]{1,80}$/`; `candidates.ts` mints
`supply_idle_${symbol}` → `supply_idle_BLUSDC`. The rendered label shows the same uppercase
symbol, so this is certain, not inferred. **No option button has ever worked.**

### Finding 2 — a successful read reported as unavailable *(proven, and the headline)*

```
tool: 'vanna_get_max_borrow', ms: 8500, keys: [... 'max_borrow_human' ...]
investigation fact extract { capability: 'max_borrow', status: 'ok', kind: 'no_fields' }
```

`normalize.ts` is a **14-case switch over capability names**; the loop may call ~24 reads.
`max_borrow_human` is extracted only inside `case "can_borrow"` — a different tool. The number
arrived and was discarded, and the user was told the data was unavailable. **This is the
mechanism that makes the copilot feel scripted, and it silently caps what the model can ever
say.**

### Finding 3 — clarify and rank cancelled each other out

The conversation thread was built so a clarifying question can be answered. The same pass
removed the clarifying question ("compound how-much / which-variant questions are dropped when
ranking exists"). Live result: it asked nothing, so repeated replies just re-ran the same
restatement. Neither behaviour is wrong; **no rule was written for which applies.** The rule
adopted: rank when the alternatives are comparable from evidence already read; ask when the
gap is a preference no read can supply.

### Finding 4 — an aborted request is reported as a timeout

```
POST /api/copilot/investigate 200 in 4.6s
position seed failed { name: 'ResponseAborted' }  →  loop stopped, modelTurns: 0
```

4.6 s and zero model turns, reported as *"ran out of time"*. Work continued after the response
closed. Some "timeouts" in the record are this; others are real (`repay 1 xlm` sat at 1m 51s).

### And one that is not a bug but is wrong

The ranked card read *"AQUSDC pays 11.2% more but you'd swap 2,680 first, which costs more
than it gains."* **Over what period?** A swap cost is one-time; an APR gap is per year. With no
horizon that sentence rejects every swap forever and permanently favours whatever is already
held. The ranked list also contained BLUSDC at 30.58% — the best rate on screen — which the
prose never mentioned, because ranking and explanation are generated in different places.

## 4. RESOLVED — the UI was single-shot; the thread is now built

**Status: built, not browser-tested.** The thread persists, a reply continues the same
investigation, and refinement re-solves. The session split was corrected to reset **only
the commitment** - the open question, a competing plan, the approval fingerprint - while
the transcript stays on screen and chain evidence is reused inside the existing 60s
freshness window. That last part also removed a real cost: an "independent" prompt used to
re-pay the 12.3s unseeded `vanna_get_account_health`.

Persistence is a subject-keyed file store (`.local/copilot-sessions`) plus a client copy.
**No Cloud SQL instance exists** - the schema is written, nothing is provisioned, so a
thread does not survive a deploy. A closed tab loses the client copy until reopened while
the process lives.

The original finding follows, kept because it is why the thread exists at all.

The acceptance prompt produced **correct behaviour**:

> *"One choice still changes the plan: how much BLUSDC (193 available) and which USDC variant
> (AQUSDC 2,680 / SOUSDC 74,985) would you like to commit?"*

**There is no way to answer it.** The only input is the top prompt bar, which starts a fresh
investigation and discards the question. The thread does not persist.

So the *better* behaviour produces a dead end, and every open-ended strategy prompt dies at
the first question — which is most of them, because those are the ones needing clarification.
It also blocks conversational refinement, chosen **instead of** inline leg editing (§5).

**Blocked, not failed:** owner acceptance paragraph, three-turn refinement, bare-`USDC`
ambiguity.

Also open: strategy prompts time out at **45s–1m39s**; the degraded message repeats
*"Recorded X before the time budget ran out"* seven times instead of saying what it
established.

---

## 5. Decisions, and why — do not re-litigate

**The model never produces a number.** It interprets language and chooses what to inspect.
Amounts, thresholds and "did this settle" are deterministic code. Every serious bug here
looked identical from outside: the model said something plausible and wrong.

**Display from the app snapshot; sizing from the contract.** Display must match the Margin
page. Sizing must match the contract, because that decides liquidation. When they disagree
beyond max($0.50, 0.5%), **refuse to quote a size** rather than pick one.

**Both health numbers are correct.** App = `posted + farm + unposted ÷ debt` (solvency).
Contract = `posted ÷ debt` (liquidation proximity) — 3.89 vs 3.42 on the test account. Only
the contract's governs the 1.10 threshold. Quote it for sizing and **label which you used**.

**Ask vs decide** — separate uncertainty about **facts**, **preferences** and **authority**.
Look facts up (never ask). Decide reversible preferences with a sensible default and show it.
Ask only about authority. Our clarifying question asked all three at once. **Rank the variant
and explain the deciding factor** in one line, with a switch — and the reason must be
**computed**, not composed by the model.

**Do not migrate to LangGraph.** No open bug is a runtime bug. `runtime.ts` is ~470 lines and
the ~984-line domain layer does not import it, so a later change of mind costs one file.
Revisit only for pause-across-days standing orders or multi-agent. Keep the parity checklist
honest: durable checkpointing and interrupts are the two real gaps, both P3.

**No inline leg editing.** An editable amount hands the user a control that breaks the
constraint the system exists to protect, then makes them guess against a solver. **Edit the
inputs — floor, budget, assets, borrow yes/no — never the outputs.**

**Binding rules.** Reads need none (public chain data). Manual writes need none (the
signature *is* the proof). Auto-sign needs one. Coupling all three caused four phases of
misleading refusals.

**Execution stays in MCP.** Not latency — transaction construction and spend policy must have
exactly one implementation, server-side, unroutable-around.

**Auto-sign sessions are user *and* client bound.** `session_user_mismatch` is **the design
working**; a different client cannot spend your session. **Do not "fix" it.** An unknown
client gets **unsigned XDR** — capability degrades, never escalates.

**Postgres, not Redis, for durable state.** Firestore is out; the IAM grant was rejected, do
not retry.

**`can_withdraw` stays a read-only catalogue name.** Do not align it to `vanna_margin_trade`,
which also dispatches `borrow`/`repay`/`settle`. Confused-deputy risk.

---

## 6. What was tried and failed

**Both hypotheses about the debt bug were wrong** — not a missing price, not `Math.max`.
`get_all_borrowed_tokens` listed `["XLM","USDC"]`, the USDC leg rejected, `allSettled`
dropped it, and the scan still returned `success: true`.

**A "28m 45s" run never happened.** The UI clock started at mount. Every latency figure
before that fix is untrustworthy.

**The generic error hid four distinct failures for three phases.** One `console.error` was
the highest-leverage change in the project.

**The same defect class has appeared five times** — a failed read becoming a confident value:
partial collateral scan → "HF 0.01"; missing price → $1,021 of debt erased; empty bindings →
"your wallet isn't linked"; normalizer shape mismatch → "no supported display fields";
dropped debt leg → HF 2.51 vs 1.56. `lib/usable-read.ts` centralises the fix. **Route new
read sites through it.**

**Swallowed errors keep returning** — `investigate/route.ts` (fixed), `risk.ts` (fixed),
**`app/api/copilot/workflow/propose/route.ts:63` (still open)**. Standing rule: **no bare
catch on any user-reachable path.**

**The unbounded app snapshot caused five failures** and is now fixed **by the app team**
(commit `c68077d`) with a 12s `withTimeout`, `partial: true`, and retries. We took their
version in the merge. Their retries mean a flaky read now takes *longer* before failing —
the right trade, but worth knowing if prompts feel slower.

---

## 7. Corrections — where Claude was wrong

**A parity check flagged a non-bug and the "fix" broke a working path.**
`scripts/check-mcp-parity.py` compared `async def` names; `surface_tools.py` registers some
surfaces under a different name via `__name__` override. **Only the registered name reaches
the wire. When a parity check disagrees with a passing test, assume the check is wrong.**

**Twice I reported copilot-owned code as the app team's bug** — the parity script, and
`components/copilot/health-dial.tsx`. Same error both times: reasoning from a file's
*content* without checking **ownership**.

**I over-reached on the source of truth**, declaring the contract authoritative and the app
wrong from one unpinned spot-check. It is a definitional difference, not an error.

**My `handle.ts` target of ~2,000 was unreachable.** Writes alone are ~3,650 lines. An
unreachable target stops telling you when you are done.

**I estimated a LangGraph migration at 3–6 weeks**; practitioner reports say 2–5 days. The
decision held, the reasoning had to change.

**Tests written against another team's internals died twice.** If you test shared code,
assert on **how the copilot behaves when it fails**, not on their implementation's shape.

---

## 8. Aave's Action Lifecycle — two gaps worth closing

Aave's public MCP uses **Discover → Inspect → Simulate → Build → Sign**, with the same safety
boundary as ours: *"never holds private keys or signs transactions."* Two differences matter.

**1. They thread opaque IDs; we thread symbols.** `get_markets` returns `reserveId` values and
*"agents must fetch reserves first rather than constructing IDs manually."* Every later stage
takes that ID.

**This is arguably why we have the bare-USDC problem at all.** Threading symbols means the
ambiguity survives into every downstream call and must be re-resolved each time. Threading an
ID resolves it **once, at discovery**, and it cannot return. Worth adopting in the
variant-selection work — the ranked choice should emit an ID, not a symbol.

**2. `get_transaction_processed` — indexer lag.** It tells a dependent follow-up when the
protocol's own view has caught up. We confirm settlement on Horizon and let the next leg
read. For **direct contract reads** that is fine — state is current at the ledger. But our
**app snapshot and Mercury are indexed or cached views**, so a multi-leg plan whose later leg
sizes against those can read stale state. Narrower than Aave's exposure, but real, and we
have no equivalent primitive.

**Where we go further:** Aave cannot sign at all; we can, under a server-enforced daily cap.
That is the differentiator and the risk surface — hence user+client session binding (§5).

**Also worth copying:** their `preview_action` is a single mandatory step —
*"never skip it before a borrow or a withdraw."* Ours is split across preflight and sizing
rather than being one named, required call.

---

## 9. Who is doing what

- **Grok (Cursor)** — app repo. `docs/copilot/HANDOFF-generalize-not-enumerate.md`: the four
  §3d findings, the horizon rule, strategy latency, then the leftovers (propose bare catch,
  MCP handshake retry, P3).
- **Gemini (Antigravity)** — MCP repo. `HANDOFF-shape-conventions-and-owed-verifications.md`:
  response-shape conventions (Grok's shape-driven extractor depends on it), Gap 3 freshness,
  and the two live verifications still owed from the deploy report.
- **Astra** — this document. Audit per §0a; do not take either agent's report at face value.
- **Parallel rule:** one repo each, or an explicit file allowlist. No file is opened by two
  agents. Nothing deploys while the other side is mid-change. **Do not test while an agent is
  writing the tree** — 8 files changed in 15 minutes once killed an in-flight approval.

## 10. Reference documents

| File | Purpose |
|---|---|
| `docs/copilot/ARCHITECTURE-WORKFLOWS.html` | Full architecture as rendered Mermaid diagrams, why-and-how per step. Open in a browser. |
| `docs/copilot/HANDOFF-conversation-thread.md` | The current pass. |
| `docs/copilot/HANDOFF-remaining-work.md` | Everything remaining, ordered. |
| `docs/copilot/PHASES.md` | Canonical numbering (P0–P7, M-A/B/C) + translation for older docs. |
| `docs/copilot/PROMPT-LIBRARY.md` | Every live prompt result, verbatim, with cause. |
| `docs/copilot/app-team/BUGS-FOR-APP-TEAM.md` | Reported bugs — since fixed by them. |
| `scripts/check-mcp-parity.py` | Verifies `catalog.ts` ↔ `LEGACY_TOOL_MAP` ↔ server. Run before any deploy. |
| `.claude/skills/` | `stress-test-copilot`, `generate-test-prompts`, `ship-across-repos`, `deploy-mcp-services`. |

## 11. The immediate next action

**Generalise, then re-run the battery.** In order: the candidate-id mismatch (30 minutes, and
nothing is testable until buttons work), then the normalizer, then abort-vs-deadline, then the
clarify/rank rule with the horizon fix.

Then run the battery with **prompts a real user would type**. The last round used a synthetic
one written by the auditor — *"use USDC and BLUSDC so my health factor stays above 1.3"* —
which nobody would say, and it produced a misleading result. Aditya caught it. Use his words,
not ours.

Log every result to `PROMPT-LIBRARY.md` verbatim, with the cause when it fails. The cause is
worth more than the verdict — that is what turns a battery into the next handoff.
