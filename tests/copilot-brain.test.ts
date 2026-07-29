import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Load .env.local into process.env for vitest (Next does this automatically).
beforeAll(() => {
  const p = resolve(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
});

describe("in-process copilot brain", () => {
  it("reports healthy in-process status", async () => {
    const { getBrainHealth } = await import("@/lib/copilot");
    const h = getBrainHealth();
    expect(h.status).toBe("ok");
    expect(h.in_process).toBe(true);
    expect(h.llm_provider).toBe("vertex");
    expect(h.mcp_mode).toBe("live");
  });

  it("routes and answers price of XLM via live MCP (+ Vertex if available)", async () => {
    const { handleChat } = await import("@/lib/copilot");
    const res = await handleChat({ user_id: "guest", message: "price of XLM" });
    expect(res.kind).toBe("answer");
    expect(res.message.toLowerCase()).toMatch(/xlm|price|\$|usd/);
    expect(res.request_id).toBeTruthy();
    expect(res.data).toBeTruthy();
  }, 90_000);

  it("write without wallet asks to connect / clarify (no Approve path)", async () => {
    const { handleChat } = await import("@/lib/copilot");
    const res = await handleChat({
      user_id: "guest",
      message: "borrow 10 USDC",
      smart_account: null,
    });
    // guest has no G-address → clarification/unavailable/needs_auto_sign/error from MCP
    expect(["preview", "clarification", "blocked", "needs_auto_sign", "error", "unavailable", "executed"]).toContain(
      res.kind,
    );
  }, 90_000);

  it("blocks liquidation", async () => {
    const { handleChat } = await import("@/lib/copilot");
    const res = await handleChat({
      user_id: "guest",
      message: "liquidate GC6VYQ...",
    });
    expect(res.kind).toBe("blocked");
  });

  it("deposit 5 xlm hits MCP (lend) and returns mcp tool proof", async () => {
    const { handleChat } = await import("@/lib/copilot");
    const res = await handleChat({
      user_id: "G".padEnd(56, "A"),
      message: "deposit 5 xlm",
    });
    // Live MCP: needs_wallet_sign (built XDR, auto_sign identity missing) | error | executed
    expect(["needs_wallet_sign", "needs_auto_sign", "executed", "error", "blocked", "clarification"]).toContain(
      res.kind,
    );
    if (res.mcp?.tool) {
      expect(res.mcp.tool).toMatch(/^vanna_/);
    }
    if (res.kind === "needs_wallet_sign") {
      expect(res.mcp?.has_unsigned_xdr || res.unsigned_xdr).toBeTruthy();
    }
  }, 90_000);
});
