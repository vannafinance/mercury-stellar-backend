# Handoff — Copilot Chat chrome (continue from PR #77)

Aditya wants the other-dev to **continue from this branch**. Chrome and live thread are in. Do not restyle ranking / Freighter / routing / bind. Do not invent transcript copy.

---

## 1. How to use this

Pixel-match the **deployed** Copilot Chat mock as chrome on `/copilot`. Wire tx + ledger **inside the assistant turn** (ExecutionStepper). Keep old investigation turns visible.

## 2. Current state

| Item | Value |
|---|---|
| Repo | `vannafinance/mercury-stellar-backend` (orchestrator) |
| Branch | `fix/copilot-chat-shell` |
| PR | https://github.com/vannafinance/mercury-stellar-backend/pull/77 |
| Base | `copilot-upgrade` |
| Mock | https://adityavanna.github.io/copilot-designs/ — **Pages wins** over anything in `design/` |

**Already on this PR**

- Left rail + shell: `components/copilot/copilot-rail.tsx`, `copilot-shell.tsx`, `auto-approve-menu.tsx`, `app/globals.css`
- Live thread: `chat-message.tsx` (`ChatTurns` = real `investigation.turns`, user right / copilot left)
- Workspace: composer POSTs `/api/copilot` and `/api/copilot/investigate`; Recents rename/delete
- Executed overlay **removed** so it cannot cover old turns
- Recents rename plumbing: `session-store.ts`, `app/api/copilot/session/[id]/route.ts`, `hooks/use-investigation.ts`

**Still owed**

- Direct writes do not persist `executionReceipt` on stored turns. ExecutionStepper only paints while the current `txHash` is in memory. Attach the other-dev stepper (tx hash + ledger #) to the **assistant turn**, not a closing Executed card.
- `repay 1 XLM` answered "You have no outstanding margin debt to repay" while the rail showed borrowed XLM.
- Unused `ExecutedTxReceipt` is still defined in `copilot-workspace.tsx`.
- `store/assistant-session.ts` has `updateAssistantExecutionReceipt` (Vanna Assist panel), unused by `/copilot` ChatTurns.

## 3. Read these first

| What | Where |
|---|---|
| Live mock | https://adityavanna.github.io/copilot-designs/ |
| Source | https://github.com/AdityaVanna/copilot-designs — `index.html` + `support.js` + `assets/` |
| Stepper | `components/copilot/execution-stepper.tsx` — `tx {hash}` + `· ledger #{n}` |

Do **not** use `design/copilot-agent-workspace/Copilot Chat.dc.html` (stale Design Canvas: uppercase COPILOT, HF gauge card, Run pill).

## 4. Decisions

- **No mock transcript.** ChatTurns is live session turns + in-flight `/api/copilot` reply.
- **No Executed card.** It replaced the thread. Tx/ledger belong in ExecutionStepper under the assistant message.
- **Do not hardcode chat strings.** Server/tool copy only.
- Tailwind v4 drops custom classes with `--` in `globals.css`. Layout on the DOM (inline or Tailwind without `--`).
- Full rail is **one** scroller. Recents selected row is `vgray-50` including the ⋯.
- Live HF on the test wallet is ~70. Show the live number; do not fake the mock’s 1.82.

## 5. Test account

- G `GD4BQRQPYLVM7YS57V4USR265UFZFEXIVDJJBIK3BAFQJ3F6SCA5NPDH`
- C `CBOQAN5NFII4P5HD73M2IRSFYZSXC5XC76FQWQ5JU7LJAO66TFFPG5XY`
- Never close / settle / liquidate in batteries. Probe `/copilot`, not MCP.

## 6. Immediate next action

1. Open Pages side by side with signed-in `/copilot`.
2. Persist `executionReceipt` on the direct-write assistant turn so tx + ledger survive reload.
3. Fix repay-says-no-debt vs rail borrowed XLM.
4. Verify empty stage, thread, collapse, Auto-approve flyout to the **right**, Recents rename, light/dark, wallet on.
