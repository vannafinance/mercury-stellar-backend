---
name: ship-across-repos
description: Work the copilot app and the MCP server together in one pass — change both sides, verify the contract between them before deploying, run both test suites, deploy in the safe order, and confirm live. Use for any phase or task that touches both repos, any new or renamed MCP tool, any change to catalog.ts or surface_tools.py, before deploying either service, or whenever a change on one side assumes something on the other. Also use when a fallback exists because the other repo has not caught up yet.
---

# Shipping a change across both repos

Two repositories hold one system. The app's `catalog.ts` is a **contract** with the MCP
server's `surface_tools.py`, and nothing fails at build time when they drift — the failure
surfaces to a user as "data was unavailable".

The failure mode this skill exists to prevent is **sequential work with a gap in the
middle**: build one side, discover the mismatch live, patch it with a fallback, and leave
the fallback in place. That has already happened here more than once.

**Rule: change both sides in the same pass, prove the contract holds before deploying, and
never leave a fallback as the steady state.**

## The repos

| | Path | Tests | Deploys to |
|---|---|---|---|
| **App** | `vanna-copilot-orchestrator` | `npx vitest run` · `npx tsc --noEmit` | Next.js host |
| **MCP** | `C:\Users\akgam\Documents\vanna_mcp` | `python -m pytest tests/ -q` | GCP `vanna-mcp` |

Never deploy contracts. MCP and Sign Service deploys are authorised.

## Step 1 — Establish the contract before writing code

Work out what each side needs from the other, and write it down before either side moves.
For a tool change that means: **tool name, action name, exact argument names, response
shape**.

Verify names against the **live** server, not the Python source — the source is what will
be deployed, not what is running:

- App-side declaration: `lib/copilot/investigation/catalog.ts`
- App-side remap: `LEGACY_TOOL_MAP` in `lib/copilot/mcp-client.ts`
- Server-side dispatch: `mcp_server/tools/surface_tools.py`

Most composite tools take `action` plus `kwargs`, so a capability is a **pair**
(`vanna_margin_status`, `liquidation_snapshot`) — both halves must match, and the remap has
to exist. A capability declared in `catalog.ts` with no `LEGACY_TOOL_MAP` entry 404s on a
composites-only server.

## Step 2 — Change both sides in one pass

Do not "do MCP this phase and app next phase". Write both, then verify both. If the work is
genuinely too large for one pass, ship the **server** side first and leave the app
untouched — an unused server capability is harmless; an app calling a capability that does
not exist is a live failure.

## Step 3 — Verify the contract before deploying

Run all three, and treat any red as blocking:

```bash
cd <app>  && npx tsc --noEmit && npx vitest run
cd <mcp>  && python -m pytest tests/ -q
```

Then check parity explicitly, because no test does:

1. Every capability in `catalog.ts` resolves to a real surface + action in
   `surface_tools.py`.
2. Every one has a `LEGACY_TOOL_MAP` entry if the live server is composites-only.
3. Argument names match exactly on both sides.
4. **No write action is reachable through a capability the model can select.** Read
   catalogue names must not map onto a write dispatcher.

Point 4 is not paperwork. `vanna_margin_trade` carries `can_withdraw` *and*
`borrow`/`repay`/`settle`; a catalogue "alignment" to the live tool name would hand the
model the write dispatcher.

`scripts/check-mcp-parity.py` does points 1–4 automatically. Run it before every deploy.

### The trap in checking parity: registered name ≠ function name

`surface_tools.py` defines some surfaces under one name and **registers them under
another** via a `__name__` override:

```python
async def vanna_farm_overview_surface(...)   # registered as "vanna_farm_overview"
```

Comparing against `async def` names therefore reports drift that does not exist. That
happened: a check built on `def` names flagged `farm_overview`, a "fix" was applied to the
app's remap to match the function name, and it **broke a working path**. The existing test
caught it, and the test was right all along.

**Only the registered name reaches the wire.** When a parity check disagrees with a passing
test, assume the check is wrong until proven otherwise — the test was written by someone
looking at the running system.

## Step 4 — Deploy in the safe order: expand, then contract

The direction depends on what changed:

| Change | Order | Why |
|---|---|---|
| **Adding** a tool or action | **MCP first**, then app | The app can only call what exists. An unused server capability harms nothing. |
| **Removing** or renaming | **App first** (stop calling it), then MCP | Otherwise the app calls something that has gone. |
| **Changing a response shape** | Server accepts/returns both forms → deploy app → retire the old form | Never a flag day. |

Deploy each service **from its own directory** with `--source .`:

```bash
cd <mcp>/vanna-mcp/sign-service && gcloud run deploy vanna-sign-service --source . \
  --region us-central1 --project vanna-mcp
```

Two traps, both already hit:

- Running the **parent** `cloudbuild.yaml` uploads from one directory above
  `.gcloudignore`, so `node_modules` is included and the upload dies on Windows `MAX_PATH`.
- The Cloud Build service account lacks `run.services.get`. Deploy as
  `aditya@vanna.finance`.

**Check what is in the build context before deploying.** `git status` in the MCP repo first.
An MCP image once shipped unrelated in-flight edits to `risk_engine.py` and `sign_tools.py`
purely because they sat in the working tree. If the tree is dirty with unrelated work,
either commit it deliberately or stash it — do not let it ride along unnoticed.

## Step 5 — Verify against the deployed server, not the local one

A local pass proves nothing about production. After deploying:

1. Call the capability against **live** MCP and confirm the real response shape.
2. Confirm the app took the **catalogue path**, not a fallback. Log which path served it.
3. Run the affected prompts on the signed-in UI and record them in
   `docs/copilot/PROMPT-LIBRARY.md` via the `stress-test-copilot` skill.

## Step 6 — Fallbacks are temporary, and must be labelled

A fallback for "the other repo has not caught up" is good engineering during the gap and a
liability afterwards, because it hides the fact that the real path is broken.

Every fallback carries: **why it exists, what removes it, and how you can tell it fired.**
Log the path taken (`mcp` vs `simulate_fallback`) so the metric is observable rather than
assumed. When the dependency lands, **delete the fallback in the same pass** as verifying
the real path — not "later".

## Step 7 — Commit and record both repos

Both repos get a commit. The MCP repo pushes to a branch with a PR, since it is shared:

- One-line commit messages, no attribution.
- If code was **deployed before review**, say so in the PR body. `main` not matching what is
  running in production is a genuine hazard — a deploy from `main` would roll production
  back.
- State in your summary **which repo each change landed in**.

## Reporting

Report both sides together, never one:

```
**Done**
- app  <file:line> — …
- mcp  <file:line> — …

**Verified**
- app: tsc clean · vitest 1585/0/3
- mcp: pytest 559 passed
- parity: <N> capabilities resolve; <N> remap entries present
- deployed: <service> revision <rev>
- live: <capability> returned <shape> on <account>
- path taken: mcp (not fallback)

**Fallbacks still in place**
- <what> — removed when <condition>
```

A phase is not done while one repo is green and the other is unverified.
