import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("F7: outbound external transfers are restricted, not reinterpreted as withdrawals", () => {
  it("refuses 'send my funds to GXXXX' with unsupported_transfer", () => {
    const r = routeMessage("send my funds to GXXXX");
    expect(r.kind).toBe("restricted");
    if (r.kind !== "restricted") return;
    expect(r.template_id).toBe("unsupported_transfer");
    expect(r.reason).toContain("Outbound asset transfers to external addresses are not supported");
  });

  it("refuses full 56-character Stellar G address transfer", () => {
    const r = routeMessage("send 100 XLM to GD4BQRQPYLVM7YS57V4USR265UFZFEXIVDJJBIK3BAFQJ3F6SCA5NPDH");
    expect(r.kind).toBe("restricted");
    if (r.kind !== "restricted") return;
    expect(r.template_id).toBe("unsupported_transfer");
  });

  it("refuses transfers to external descriptive targets", () => {
    const r1 = routeMessage("transfer my funds to another wallet");
    expect(r1.kind).toBe("restricted");
    if (r1.kind !== "restricted") return;
    expect(r1.template_id).toBe("unsupported_transfer");

    const r2 = routeMessage("wire my balance to an external address");
    expect(r2.kind).toBe("restricted");
    if (r2.kind !== "restricted") return;
    expect(r2.template_id).toBe("unsupported_transfer");
  });

  it("refuses EVM address outbound transfers", () => {
    const r = routeMessage("transfer 50 USDC to 0x1234567890abcdef1234567890abcdef12345678");
    expect(r.kind).toBe("restricted");
    if (r.kind !== "restricted") return;
    expect(r.template_id).toBe("unsupported_transfer");
  });

  it("preserves internal protocol transfers / deposits", () => {
    // "send 100 XLM to my margin account" is a collateral deposit, not an external transfer
    const r1 = routeMessage("send 100 XLM to my margin account");
    expect(r1.kind).toBe("write");
    if (r1.kind === "write") {
      expect(r1.op).toBe("deposit_collateral");
    }

    // "supply 50 BLUSDC to blend" is a blend supply
    const r2 = routeMessage("supply 50 BLUSDC to blend");
    expect(r2.kind).toBe("write");
    if (r2.kind === "write") {
      expect(r2.op).toBe("deploy_to_blend");
    }
  });

  it("proves on an un-enumerated recipient address format", () => {
    const r = routeMessage("forward all funds to GABCDEF1234567");
    expect(r.kind).toBe("restricted");
    if (r.kind !== "restricted") return;
    expect(r.template_id).toBe("unsupported_transfer");
  });
});
