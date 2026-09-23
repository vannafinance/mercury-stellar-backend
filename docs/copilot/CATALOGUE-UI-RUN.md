# Catalogue — live UI run, 23 Sep, `try/investigate-first`, wallet GDW3B2…VJ52, auto-approve ON

Aditya drives the browser; results read from the rendered page, the network panel and the
local audit trail. "Approve" = Aditya clicked it; otherwise the plan card was only inspected.

| Row | Prompt | Understood as | Outcome | Notes |
|---|---|---|---|---|
| E1 | lend 50 XLM | (run collided — I and Aditya typed at once) | — | re-run |
| E2 | supply 25 AQUSDC to earn | Supply 25 AQUSDC into Vanna Earn pool → Lend 25 AQUSDC | cancelled by user | UI: EXECUTION PROGRESS "Queued" card sits above "Not executed" — a cancelled plan still writes a receipt |
| — | lend 20 xlm | Lend 20 XLM into Vanna Earn | **executed, settled** tx 5af8de69…, ledger 4824185 | first full propose→approve→advance on investigate-first |
| — | lend me 20xlm | Borrow 20 XLM from Vanna Margin | plan offered with Approve | debt guard runs on fresh code and still passes it — OPEN |
| E3 | lend 10 SOUSDC | Lend 10 SOUSDC to Vanna Earn | proposed (b1d41470), not approved | once the next turn starts, the plan card vanishes and the headline "Approve to run this step" stays with nothing to approve; | after moving on, E2's "Not executed" card disappears but its stale "Queued" execution card stays in history |
| E4 | redeem 10 XLM from earn | Redeem 10 XLM from Vanna Earn → "Redeem 9.9451295 XLM vTokens (≈ 10 XLM)" | proposed (450df780) | PASS: pro-rata vToken sizing as catalogue expects. UI: pocket says "Earn · XLM 44.8665031 available / Plan spends 9.9451295" — 9.945 is vTokens, labelled XLM; units ambiguous |
| E5 | redeem all my AQUSDC from earn | Redeem all AQUSDC from Vanna Earn → whole vToken balance 14.8783043 (≈ 15.1755174 AQUSDC) | proposed (89781434) | PASS: redeems the full vToken count, so no dust. UI: step reads "(≈ 15.1755174 AQUSDC) (14.8783043 AQUSDC)" — two numbers both labelled AQUSDC, the second is vTokens |
| E6 | what is my earn position? | Check current Vanna Earn positions across all assets | answered | PASS: vTokens + underlying per pool. Read path labels vTokens CORRECTLY (VXLM, VAQUSDC) — so item 9 is the plan card not reusing it. Leak: BLUSDC's vToken shown as "VUSDC" (wire name) not vBLUSDC |
|  | (history) | — | — | E3/E4/E5 each collapse to "…Approve to run this step" after moving on: no card, no outcome (UI item 10) |
