# Vanna diagrams — Mermaid sources

Import any of these into Excalidraw to get an editable, hand-drawn diagram:

1. Open https://excalidraw.com
2. Hamburger menu (top left) -> **Mermaid to Excalidraw**
3. Open the `.mmd` file, copy its whole contents, paste into the box
4. **Insert** — the diagram lands as normal Excalidraw shapes you can move, restyle and export

Everything is editable after import: text, colours, arrows, layout. Export as PNG or SVG
from Excalidraw when you need a picture for a deck.

## Files

| File | Diagram |
|---|---|
| `workflows-01-system-at-a-glance.mmd` | Six layers, the trust boundary, MCP as the only path to chain |
| `workflows-02-model-calls.mmd` | All five model calls, what each reads and writes |
| `workflows-03-prompt-lifecycle.mmd` | A prompt end to end, with every named exit |
| `workflows-04-investigation-loop.mmd` | Inside the loop: turns, batching, validation, seeded reads |
| `workflows-05-sources-of-truth.mmd` | App vs MCP vs contract, and which one sizes |
| `workflows-06-approval-execution.mmd` | Approval, revalidation, the auto-sign branch, leg failure |
| `workflows-07-usdc-ambiguity.mmd` | Why bare USDC is a question, not a token |
| `readiness-01-three-day-comparison.mmd` | A 3-day agent vs a financial agent — the same first three rows |
| `readiness-02-corrected-architecture.mmd` | Target architecture with the telemetry and durable-state planes |

If a paste fails in Excalidraw, it is almost always an unquoted label containing a
bracket or a colon — wrap that label in double quotes and retry.
