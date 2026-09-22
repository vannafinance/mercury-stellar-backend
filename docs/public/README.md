# Vanna Documentation

Vanna Finance is a non-custodial margin lending and trading protocol on Stellar (Soroban). This section documents the two ways to interact with Vanna programmatically or conversationally, rather than by clicking through the app UI:

| Guide | Audience | What it covers |
|---|---|---|
| [Copilot User Guide](./copilot-guide.md) | Anyone using Vanna | Talking to Vanna in plain English on `/copilot` — reading your position, lending, borrowing, swapping, farming, and running multi-step strategies |
| [MCP Server Guide](./mcp-server-guide.md) | Developers, AI agent builders | Connecting your own AI client (Claude Desktop, Cursor, Windsurf, or any MCP-compatible agent) directly to the Vanna MCP server |
| [Tool & Asset Reference](./reference.md) | Developers | The full tool catalogue, supported assets, and protocol addresses exposed by the Vanna MCP server |
| [Security & Safety Model](./security.md) | Everyone | How Vanna keeps your keys yours, what guardrails exist before any transaction is signed, and what auto-sign actually authorizes |

## The short version

Vanna exposes its entire protocol surface — margin trading, lending (Earn), leveraged yield farming (Blend), and liquidity provision (Aquarius/Soroswap) — through the **Vanna MCP server**, an implementation of Anthropic's [Model Context Protocol](https://modelcontextprotocol.io). Any MCP-aware AI client can read live on-chain state and *propose* transactions through it. The **Vanna Copilot** (the chat panel at `/copilot` on the Vanna app) is Vanna's own first-party client built on top of that same MCP server, wrapped in a UI with plan previews, risk simulation, and either manual wallet signing or opt-in delegated auto-signing.

Two invariants hold everywhere in this stack:

- **The AI never holds your keys.** Every write the MCP server can perform returns an *unsigned* transaction; nothing reaches the chain without either your wallet's signature or a policy-bounded, revocable auto-sign session you explicitly opted into.
- **The AI never sets the risk rules.** Health-factor checks, collateral allowlists, spend caps, and contract/function allowlists are all enforced by deterministic code and on-chain contracts — not by anything the language model decides at inference time.

Start with the [Copilot User Guide](./copilot-guide.md) if you just want to use Vanna. Start with the [MCP Server Guide](./mcp-server-guide.md) if you're building your own client.

> **Network:** All addresses, examples, and caps in this documentation reflect the current **Stellar testnet** deployment. Moving to mainnet is a configuration change (RPC URL, network passphrase, registry address) rather than a code change, but do not treat testnet spend caps or asset lists as mainnet guarantees.
