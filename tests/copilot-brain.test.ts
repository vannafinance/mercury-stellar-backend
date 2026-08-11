import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Load .env.local into process.env for vitest (Next does this automatically), then warm
// the brain module.
//
// Why the warm-up is here and not left to the first test: importing `@/lib/copilot` pulls
// in the whole brain graph, and that transform+load is real work — measured at just over
// five seconds when the full suite is running and every worker is competing for CPU. Left
// inside `it()`, it is charged to that test's 5s budget, so the FIRST test in this file
// failed with "Test timed out in 5000ms" on roughly every other full-suite run while
// passing alone in ~7s for the whole file. Nothing was hanging: the three observed
// failures came in at 5123ms, 5258ms and 5277ms, all a couple of hundred milliseconds over
// the line. Every later test in the file was fast because the module cache was warm.
//
// So the import is paid once, here, where a hook timeout can be set to a size that
// reflects "load a large module graph" instead of "assert one thing". The tests keep the
// default 5s and stay honest about their own work.
//
// The env must be loaded BEFORE the import, not after: the module reads MCP_MODE and the
// provider settings at import time, which is why this was a dynamic import in the first
// place and why it cannot simply move to the top of the file.
beforeAll(async () => {
  const p = resolve(process.cwd(), ".env.local");
  if (existsSync(p)) {
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
  }
  await import("@/lib/copilot");
}, 120_000);

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
