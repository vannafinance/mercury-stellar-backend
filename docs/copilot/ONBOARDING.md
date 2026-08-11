# Copilot onboarding

Get the copilot running, understand what you are looking at, and know what not to break.
This is the practical half. For how it works:
[ARCHITECTURE.md](./ARCHITECTURE.md) (diagrams) ·
[README.md](./README.md) (prose) ·
[GUARDRAILS.md](./GUARDRAILS.md) (every refusal and safety gate).

---

## 1. Run it

```bash
NODE_OPTIONS=--max-old-space-size=6144 npm run dev
```

Then open `http://localhost:3000/copilot`.

**Use that `NODE_OPTIONS`.** The Turbopack dev server sits at ~3.2 GB RSS, close to Node's
default ceiling, and has hard-exited under sustained load (every route 500s, then the
process disappears). It has survived everything since with the larger heap.

**Never start a second `next dev`.** Two Turbopack instances share one `.next` directory and
corrupt each other.

Health check:

```bash
curl -s http://localhost:3000/api/copilot
```

Expect `llm_provider: "vertex"`, `mcp_mode: "live"`, `templates: 14`. If `vertex_auth` says
`developer_login`, you are routing on your own `gcloud` credential — it will expire and
understanding will silently drop to keyword matching.

## 2. Env you actually need

`.env.local` (gitignored):

| Var | Why |
|---|---|
| `WORKOS_M2M_CLIENT_ID` / `_SECRET` | MCP transport credential. Without it every read fails |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Gates the Privy provider, the wallet bridge **and** the connect-modal option. Dropping this one var disables wallets app-wide |
| `VERTEX_MODEL` | Defaults to `gemini-3.6-flash` |
| `COPILOT_LOG=1` | Per-turn + per-model-call logging. Turn this on while working |
| `COPILOT_READS_ONLY` | **Set `true` before any write testing you do not want on chain** |

## 3. Before you test writes — read this

**A single-leg write typed into the copilot executes on chain immediately** when auto-sign
is active. There is no preview and no approval click; `plan_preview` only guards *multi*-step
plans.

This has already cost real (testnet) transactions: a prompt matrix that assumed writes would
stop at a preview executed a 5 XLM deposit, and the same list contained `settle account` and
`close account`.

So, before running write prompts:
- Set `COPILOT_READS_ONLY=true` and restart, **or** use a wallet with auto-sign off, **or**
  exclude write rows explicitly.
- Never put `settle_account`, `close_account` or `liquidate` in an automated list against a
  real account. (`liquidate` is safe — the router refuses it before any tool call.)

A read-only "strategy" is distinguishable: `kind: "answer"`,
`template_id: "strategy_read_only"`. If you see `kind: "executed"` with `tx_hash: null`,
something is claiming success it did not achieve.

## 4. Testing

**Unit / integration** — the fast loop, and it must stay green:

```bash
npx vitest run        # 778 tests
npx tsc --noEmit      # must be clean
```

**A handful of tests hit the network** (`tests/copilot-brain.test.ts` calls live MCP and
Vertex). They fail transiently when testnet RPC wobbles — `Error fetching pool stats: Error:
RPC down`, typically 2–3 failures, all green again on a re-run. **Re-run before you believe a
red suite**, and never conclude your change broke something that only touches unrelated
files.

**Live prompt matrix** — drives `POST /api/copilot`. Pace it; the dev server dies under
sustained load. Retry on 5xx after waiting for health to return 200.

**Browser (RPA)** — the copilot is a React app with a controlled input, and coordinate
clicking does not work reliably in a non-compositing browser pane. Drive it through the DOM:

```js
// set the value so React sees it, then click Run
const setVal = (el, v) => {
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  s.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const el = document.querySelector('input[placeholder*="Ask, or state"]');
setVal(el, 'park 20 XLM then farm 10 BLUSDC at 2x');
el.closest('form').querySelector('button[type=submit]').click();
```

Read the run region back from `document.body.innerText` between `YOUR INTENT` and
`SESSION LOG`. After editing server code, **hard-reload** — a dead HMR socket leaves a stale
bundle that silently posts nothing.

## 5. Prompts worth keeping in the loop

These cover the shapes that have actually broken. All should behave as stated.

| Prompt | Expected |
|---|---|
| `what are my positions` | Live position read — **never** "I don't have access" |
| `What is my available credit right now?` | `query_available_credit`, a figure |
| `how much XLM collateral do I have` | The XLM number, venue positions listed separately |
| `Park 20 XLM then farm 10 BLUSDC at 2x` | Plan, 2 steps, **4 signatures**, earn → farm |
| `Deposit 10 BLUSDC, borrow 5 BLUSDC, then supply that to Blend` | 3 legs, last one sized ~4.9825 (net of fee) |
| `swap 10 XLM to BLUSDC then farm it on Blend` | Farm leg has **no** leverage |
| `lend 15 SOUSDC, then tell me my health factor` | 2 steps, 1 signature, report runs **after** |
| `if my HF is above 2, borrow 5 BLUSDC, otherwise leave it` | Refused: `unsupported_conditional` |
| `keep an eye on my position and pull collateral out if it gets risky` | Refused: `unsupported_standing_order` |
| `Supply 20 DOGE to earn` / `add liquidity to the XLM/BTC pool` | Refused: `unsupported_asset` |
| `Farm Blend at 20x leverage` | Refused, names the 10× cap |
| `Supply -5 USDC` | Refused before asking for a wallet |
| `what is Blend?` | Page assistant, not a tool call |

Added 2026-08-10, all verified on chain against a live wallet:

| Prompt | Expected |
|---|---|
| `deposit 50% of XLM on my margin account` | Sized off the live wallet balance, minus the real `(2+subentries)×0.5` reserve + fee buffer. **Never** "how much?" |
| `swap 25% of my XLM to USDC` | Sized off the **smart account** (what Trade/Spot reads), **no** wallet reserve deducted |
| `deposit 25% of my XLM as collateral and borrow BLUSDC at 2x` | ONE `deposit_and_borrow` step · 2 signatures · card shows `25%` |
| `deposit 20% of my BLUSDC as collateral and borrow XLM at 3x` | Cross-asset: borrow = `deposit_usd × (L−1)` through the oracle |
| `swap 10 XLM to BLUSDC` | **Refused** — BLUSDC is not a DEX token; offers AQUSDC / SOUSDC |
| `swap 5 XLM to SOUSDC` | Picks **Soroswap** on its own; label says SOUSDC because that is what is bought |
| `lend 20 USDC into the earn pool` | Variant chips — never guesses which USDC |
| `what is the total value locked across all earn pools?` | One USD **total**, then the breakdown |
| `compare the XLM and BLUSDC pools` | Verdict + the gap, only the two named pools |
| `simulate borrowing 10 BLUSDC — what happens to my health factor?` | **Projected** HF, not the current one |
| `what is my liquidation price?` | The XLM price where HF hits 1, not the spot oracle price |
| `remove half my liquidity from the XLM/USDC pool` | Asks for an LP amount or "remove all" — never sends a fraction MCP rejects |
| `create a margin account for me` (auto-approve **OFF**) | Approve & sign → Privy signs → C-address returned |

## 5b. Turning auto-approve on

Rail toggle → budget radio (`defaults` pre-selected, switch to `custom` if you want) →
**`Done`**. Only `Done` calls `enableAutoSign`; the radios just set the mode, so the choice
can still be changed before it is committed.

A wallet's **first** enable also needs the one-time signer bind (`Authorize in app`). After
that, `disable auto-sign` revokes only the policy session — *"Privy addSigners was NOT
removed"* — so the bind never reappears for that wallet.

## 6. Things that will mislead you

- **An MCP error can arrive as HTTP 200.** A Soroban budget overrun returns
  `{ error: "contract_error", message: "…HostError: Error(Budget, ExceededLimit)" }` with a
  **200** — it never rejects. So `try/catch` around an MCP read is the wrong guard on its
  own: the catch never fires, no field parses, and a failed read becomes a plausible zero.
  This bit `runRead` once and `risk.ts` again months later. **Check the payload, not just
  the promise**, and never let the fallback path be silent. Probe it directly:
  ```bash
  node probes/probe-mcp.mjs vanna_margin_status '{"action":"health","kwargs":{"smart_account":"C…"}}'
  ```
- **Turbopack recompiles after every server edit.** The first request after an edit reads
  9–60s regardless of your change. Measured **warm**: read 6.7s · 2-step plan 7.4s · 4-step
  plan 6.5s. A claim in an earlier session that plan preview takes 40–60s was simply this
  trap — every sample was a post-edit recompile.
- **`gcloud` / MCP timings vary a lot.** Take medians over 4+ samples.
- **Do not trust your own tooling over the product.** Two false bug reports in one session
  came from this: a mid-flight card read as "the click did nothing" (it had worked), and a
  button-search regex that never matched `Done`, reported as "the button is broken". The
  method that never misled: **open the site and compare its numbers** — that is how the
  swap figure `2241.7178423` and the collateral figure `2498.9290941` were settled.
- **A swallowed exception in a retry loop looks like a slow network.** One live example:
  `BigInt(acc.sequenceNumber)` — a method, not a property — threw on every iteration inside
  a `catch` marked "transient", so every multi-leg hop stalled 16s and then reported the
  sequence had never applied.
- **Two type definitions for the same thing.** `components/copilot/execute.ts` used to
  declare its own `CopilotAction` with 8 of 22 fields, and the workspace imported *that* —
  so real fields the server sends were invisible to the client. Now re-exported from
  `lib/copilot/types.ts`. Do not re-fork it.
- **`_human` vs raw fields.** MCP returns both (`total_liquidity` = an 18-decimal wad,
  `total_liquidity_human` = "22,219.1975"). Only ever show the human one.
- **Earn positions live on the G-wallet, not the C-account.** A vToken read scoped to the
  smart account returns 0 for an account that holds a position.

## 7. Ground rules

1. **The model interprets language. It does not decide safety.** Amounts, assets, ordering,
   refusals and venue are deterministic code's job.
2. **Never invent a slot the user did not give.** Defaulting leverage to 2× turned a
   one-signature supply into three signatures and a debt position.
3. **Match the website, and prefer its code.** When the copilot and the Margin page
   disagree about one account, the page is right — it is what the user already trusts. Reuse
   its services (`margin-utils.ts`, `account-snapshot.ts`) rather than writing a second
   implementation.
4. **Refuse out loud.** A conditional, a standing order or a missing variant gets a plain
   sentence, not a silent best guess.
5. **Never widen the plan fingerprint's blind spot.** Every executable slot is hashed. If
   you add a slot, it is hashed automatically — do not hand-pick fields.
6. **Say what is unverified.** Several fixes here could not be exercised live; they are
   labelled that way in OPEN-ISSUES.md and should stay labelled until someone proves them.
