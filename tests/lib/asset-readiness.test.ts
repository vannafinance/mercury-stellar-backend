/**
 * Asset readiness + trustline failure classification.
 * Prevention path: setup before MCP. Fallback: never surface raw HostError #13.
 */

import { describe, expect, it } from "vitest";
import {
  classifyTrustlineFailure,
  isTrustlineMissingError,
  readinessDisplayAsset,
} from "@/lib/copilot/asset-readiness";
import { humanizeMcpWriteError } from "@/lib/copilot/mcp-write";
import { normalizeDepositCollateralError } from "@/lib/errors/normalize";

describe("readinessDisplayAsset", () => {
  it("maps Blend aliases to BLUSDC", () => {
    expect(readinessDisplayAsset("BLUSDC")).toBe("BLUSDC");
    expect(readinessDisplayAsset("USDC")).toBe("BLUSDC");
    expect(readinessDisplayAsset("blend_usdc")).toBe("BLUSDC");
  });
  it("keeps AQUSDC / SOUSDC / XLM distinct", () => {
    expect(readinessDisplayAsset("AQUSDC")).toBe("AQUSDC");
    expect(readinessDisplayAsset("SOUSDC")).toBe("SOUSDC");
    expect(readinessDisplayAsset("XLM")).toBe("XLM");
  });
});

describe("isTrustlineMissingError", () => {
  it("detects classic HostError #13 trustline text", () => {
    expect(
      isTrustlineMissingError(
        'HostError: Error(Storage, MissingValue) trustline entry is missing for account "GABC…"',
      ),
    ).toBe(true);
    expect(isTrustlineMissingError("Error(Contract, #13)")).toBe(true);
  });
  it("ignores unrelated failures", () => {
    expect(isTrustlineMissingError("Error(Contract, #3)")).toBe(false);
    expect(isTrustlineMissingError("insufficient balance")).toBe(false);
  });
});

describe("classifyTrustlineFailure", () => {
  const g = "G" + "A".repeat(55);

  it("wallet account → setup guidance, not HostError", () => {
    const msg = classifyTrustlineFailure(
      `trustline entry is missing for account ${g}`,
      { asset: "BLUSDC", trader: g },
    );
    expect(msg.reason).toBe("wallet_setup");
    expect(msg.message).not.toMatch(/HostError/i);
    expect(msg.message).toMatch(/trustline|setup|wallet/i);
  });

  it("other G-account → protocol treasury guidance", () => {
    const treasury = "G" + "B".repeat(55);
    const msg = classifyTrustlineFailure(
      `trustline entry is missing for account ${treasury}`,
      { asset: "XLM", trader: g },
    );
    expect(msg.reason).toBe("protocol_treasury");
    expect(msg.message).toMatch(/protocol|treasury|admin/i);
    expect(msg.message).not.toMatch(/HostError #13/i);
  });
});

describe("humanizeMcpWriteError trustline fallback", () => {
  it("never returns raw HostError #13 for deposit", () => {
    const out = humanizeMcpWriteError(
      {
        error: "simulation_failed",
        message:
          'HostError: trustline entry is missing for account GDPMCPUXAHICI4SPGSXG5YXQI2OECTD5A3OCEDKDL3YOOPZ475OSM6YH',
      },
      "vanna_deposit_collateral",
    );
    expect(out).not.toMatch(/HostError/i);
    expect(out).toMatch(/trustline|Faucet|wallet|protocol|setup/i);
  });
});

describe("normalizeDepositCollateralError trustline", () => {
  it("points at setup/Faucet without dumping HostError", () => {
    const out = normalizeDepositCollateralError(
      'trustline entry is missing for account GDPMCPUXAHICI4SPGSXG5YXQI2OECTD5A3OCEDKDL3YOOPZ475OSM6YH',
    );
    expect(out).toMatch(/Faucet|trustline/i);
    expect(out).not.toMatch(/HostError/i);
  });
});
