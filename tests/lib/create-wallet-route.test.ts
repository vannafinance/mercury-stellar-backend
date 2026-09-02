import { describe, it, expect } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("create / connect G-wallet routing", () => {
  it("create wallet opens client tool, not MCP create_account", () => {
    for (const msg of [
      "create a wallet",
      "create vanna wallet",
      "create my wallet",
      "new wallet",
      "set up a wallet",
    ]) {
      const r = routeMessage(msg);
      expect(r.kind, msg).toBe("client");
      if (r.kind === "client") {
        expect(r.tool).toBe("openConnectWallet");
        expect(r.template_id).toBe("create_g_wallet");
        expect(r.args?.prefer).toBe("privy");
      }
    }
  });

  it("connect wallet opens modal client tool", () => {
    const r = routeMessage("connect wallet");
    expect(r.kind).toBe("client");
    if (r.kind === "client") {
      expect(r.tool).toBe("openConnectWallet");
      expect(r.template_id).toBe("connect_g_wallet");
    }
  });

  it("create margin account stays MCP write", () => {
    const r = routeMessage("open a margin account");
    expect(r.kind).toBe("write");
    if (r.kind === "write") {
      expect(r.op).toBe("create_account");
    }
  });

  it("create smart account stays MCP write", () => {
    const r = routeMessage("create smart account");
    expect(r.kind).toBe("write");
    if (r.kind === "write") {
      expect(r.op).toBe("create_account");
    }
  });
});
