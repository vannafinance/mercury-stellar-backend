# Vanna MCP Server — Developer Guide

The Vanna MCP server exposes the full Vanna protocol — margin trading, Earn (lending), Blend leveraged farming, and Aquarius/Soroswap liquidity — to any [Model Context Protocol](https://modelcontextprotocol.io) client: Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, or your own agent.

It never holds a private key. Every write tool builds an unsigned Soroban transaction (or, for wallets with an active auto-sign session, signs and submits through the separate, policy-bounded Sign Service) — your client or your user always controls what actually gets signed.

## Two tool surfaces

The server can register two different sets of tools, controlled by the `MCP_TOOL_SURFACE` environment variable on the deployment you connect to:

| Mode | Tool count | What you get |
|---|---|---|
| `composites` | 14 tools | One tool per domain (`vanna_swap`, `vanna_margin_trade`, `vanna_earn_write`, …), each taking an `action` parameter that dispatches internally. Simpler tool list, fewer schemas for your client to reason over. |
| `full` (default) | ~66 tools | Every individual operation (`vanna_borrow`, `vanna_repay`, `vanna_add_liquidity`, …) registered as its own tool, **plus** the 14 composites, dual-registered. |

Vanna's own Copilot connects in `composites` mode. If you're building a new client and don't have a strong reason to want the full granular surface, `composites` mode is the simpler starting point. See the [Tool & Asset Reference](./reference.md) for the complete list either way.

## Connecting

Vanna hosts the MCP server for you — there is nothing to clone or run yourself. Point any MCP-capable coding agent at the hosted endpoint:

```
https://mcp.vanna.finance/mcp
```

- **Transport:** `streamable-http`
- **Auth:** OAuth 2.1. The endpoint is a standard resource server (it publishes `/.well-known/oauth-protected-resource` for discovery), so any MCP client with native remote-server support handles the login for you — add the URL, and the client opens a browser sign-in the first time it connects. You never paste a token in by hand for an interactive client. See [Authentication](#authentication) below for what's actually happening under the hood, and for the machine-to-machine path if you're wiring up a backend service rather than an interactive client.

Add it to your client of choice:

<details>
<summary><strong>Claude Code (CLI)</strong></summary>

```bash
claude mcp add --transport http vanna https://mcp.vanna.finance/mcp
```

Run `/mcp` inside a Claude Code session afterward to complete the OAuth sign-in.
</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Settings → Connectors → Add custom connector → paste `https://mcp.vanna.finance/mcp` as the URL. Claude Desktop opens a browser tab for the OAuth sign-in on first connect.
</details>

<details>
<summary><strong>Cursor</strong></summary>

Settings → MCP → Add new MCP server, or add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vanna": {
      "url": "https://mcp.vanna.finance/mcp"
    }
  }
}
```
</details>

<details>
<summary><strong>Windsurf / Codeium Cascade</strong></summary>

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "vanna": {
      "serverUrl": "https://mcp.vanna.finance/mcp"
    }
  }
}
```
</details>

<details>
<summary><strong>VS Code (native MCP support, Cline, Roo Code)</strong></summary>

`.vscode/mcp.json`:

```json
{
  "servers": {
    "vanna": {
      "url": "https://mcp.vanna.finance/mcp"
    }
  }
}
```
</details>

<details>
<summary><strong>Any other MCP client</strong></summary>

If your client supports remote MCP servers over `streamable-http` at all, it needs exactly two things: the URL above, and the ability to complete an OAuth redirect (or accept a Bearer token you supply yourself, for a client that doesn't do the redirect flow natively). Field names for the URL vary by client (`url`, `serverUrl`, `endpoint`) — check your client's own MCP docs for the exact key if it isn't one of the ones above.
</details>

Whichever client you use, once connected, a bare tool call is enough to discover the live tool list and schemas — nothing here needs to be hardcoded from this document; treat this page as an index, and the server's own tool metadata as the source of truth.

## Authentication

When auth is enabled, the server acts purely as an **OAuth 2.1 resource server** — it validates Bearer tokens against an external identity provider's JWKS; it does not issue tokens itself. It exposes the standard discovery endpoints (`/.well-known/oauth-protected-resource`, and a redirect to the IdP's `/.well-known/oauth-authorization-server`) so a compliant client can configure itself automatically.

Two identity concepts travel with every request:

- **The Bearer token** says *what app is calling* — this can be a shared machine-to-machine credential for your whole application, not necessarily one credential per human user.
- **The `X-Vanna-User-Assertion` header** says *which end user this call is on behalf of* — an individual user token, distinct from the app-level bearer. The MCP server does not itself verify this assertion's validity; it forwards it as-is to the Sign Service and to any downstream identity checks, which are the actual verifiers.

If a deployment has wallet-binding enforcement turned on, a write against a wallet that isn't verifiably bound to the calling identity is rejected with a `wallet_not_bound` error and a pointer to the wallet-connect flow (`vanna_connect_wallet_start`) rather than silently succeeding against the wrong wallet.

**Building a backend integration instead of using an interactive client?** You won't get the browser OAuth redirect a desktop client gets. Register your application for an M2M (client-credentials) grant with Vanna's identity provider to get a Bearer token for your app, and forward each individual end user's own token in the `X-Vanna-User-Assertion` header on every request made on their behalf — this is exactly the pattern Vanna's own Copilot uses to connect to this same hosted endpoint. Reach out to the Vanna team to get an M2M client registered.

## The write-tool contract

Every write tool, regardless of domain, returns the same shape:

```json
{
  "unsigned_xdr": "AAAAAg...",
  "auth_entries": [ ... ],
  "fee_estimate": "100100",
  "summary": "Borrow 20 USDC against your margin account",
  "function": "borrow",
  "contract": "CA...",
  "simulation_success": true
}
```

Your client is responsible for getting `unsigned_xdr` signed — either by the end user's own wallet, or, if that wallet has an active auto-sign session with the Sign Service, the tool call itself may sign-and-submit and return a transaction hash instead. Never construct or submit a transaction to this domain from a source other than `unsigned_xdr` returned by a tool call — the amounts, contracts, and auth entries are validated server-side against protocol state (risk checks, collateral allowlists, registry resolution) as part of building it.

## Reads are cheap, writes preflight

Nearly every write has a paired read that tells you whether it would succeed before you build it — `vanna_can_borrow` before `vanna_borrow`, `vanna_can_withdraw` before `vanna_withdraw_collateral`, `vanna_get_max_borrow` for a ceiling. Hot reads (oracle price, pool stats) are served from a short server-side cache (tens of seconds), not re-fetched from chain on every call — expect near-instant responses, not a fresh RPC round-trip each time.

## Next steps

- Full tool list, parameters, and the supported asset/protocol surface: [Tool & Asset Reference](./reference.md).
- How writes are gated before they're signed — spend caps, function allowlists, health-factor checks: [Security & Safety Model](./security.md).
- Building a chat-style product on top of this server rather than a raw MCP client integration: see how [Vanna Copilot](./copilot-guide.md) does it for a worked reference implementation.
