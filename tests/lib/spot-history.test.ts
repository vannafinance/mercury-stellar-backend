import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mercury-client", () => ({ fetchContractEvents: vi.fn() }));
vi.mock("@/lib/mercury-timestamps", () => ({ fetchTxTimestamps: vi.fn() }));

import {
  applyMarginExecs,
  decodeMarginExecuted,
  decodeSpotTransfer,
  transfersToSpotHistory,
} from "@/lib/spot-history";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";

describe("margin_executed spot history decoding", () => {
  it("decodes a swap (one token in, one token out) and names the venue", () => {
    const exec = decodeMarginExecuted(
      {
        margin: "CACCT",
        target: CONTRACT_ADDRESSES.SOROSWAP_ROUTER,
        tokens_in: [CONTRACT_ADDRESSES.SOROSWAP_USDC],
        tokens_out: [CONTRACT_ADDRESSES.BLEND_XLM],
      },
      "tx1",
    );
    expect(exec).toEqual({
      txHash: "tx1",
      target: CONTRACT_ADDRESSES.SOROSWAP_ROUTER,
      tokenIn: CONTRACT_ADDRESSES.SOROSWAP_USDC,
      tokenOut: CONTRACT_ADDRESSES.BLEND_XLM,
    });
  });

  it("ignores LP and Blend executions", () => {
    // AddLiquidity: two tokens out, the LP token in.
    expect(decodeMarginExecuted({
      target: CONTRACT_ADDRESSES.SOROSWAP_ROUTER,
      tokens_in: [CONTRACT_ADDRESSES.SOROSWAP_XLM_USDC_POOL],
      tokens_out: [CONTRACT_ADDRESSES.BLEND_XLM, CONTRACT_ADDRESSES.SOROSWAP_USDC],
    }, "tx2")).toBeNull();
    // Blend supply: one token out, nothing in.
    expect(decodeMarginExecuted({
      target: CONTRACT_ADDRESSES.BLEND_POOL,
      tokens_in: [],
      tokens_out: [CONTRACT_ADDRESSES.BLEND_XLM],
    }, "tx3")).toBeNull();
  });

  it("sets the protocol from the event target on the transfer-built row", () => {
    const legs = [
      decodeSpotTransfer(CONTRACT_ADDRESSES.BLEND_XLM, ["transfer", "CACCT", "CPAIR", "native"], BigInt("10000000"), "CACCT", "tx4", 1),
      decodeSpotTransfer(CONTRACT_ADDRESSES.SOROSWAP_USDC, ["transfer", "CPAIR", "CACCT"], BigInt("2000000"), "CACCT", "tx4", 1),
    ].map((l) => l!);
    const rows = transfersToSpotHistory(legs, "CACCT");
    const exec = decodeMarginExecuted({
      target: CONTRACT_ADDRESSES.SOROSWAP_ROUTER,
      tokens_in: [CONTRACT_ADDRESSES.SOROSWAP_USDC],
      tokens_out: [CONTRACT_ADDRESSES.BLEND_XLM],
    }, "tx4")!;
    expect(applyMarginExecs(rows, [exec])).toEqual([
      expect.objectContaining({ protocol: "soroswap", tokenIn: "XLM", tokenOut: "SoUSDC", amountIn: "1.0000000", amountOut: "0.2000000" }),
    ]);
  });
});

describe("token-transfer spot history fallback", () => {
  const account = "CACCT";

  it("reconstructs an Aquarius swap from SEP-41 transfer events", () => {
    const out = decodeSpotTransfer(
      CONTRACT_ADDRESSES.BLEND_XLM,
      ["transfer", account, "CPOOL"],
      BigInt("12500000"),
      account,
      "tx-transfer",
      100,
    );
    const received = decodeSpotTransfer(
      CONTRACT_ADDRESSES.AQUARIUS_USDC,
      ["transfer", "CPOOL", account],
      BigInt("2500000"),
      account,
      "tx-transfer",
      100,
    );

    expect(out).not.toBeNull();
    expect(received).not.toBeNull();
    expect(transfersToSpotHistory([out!, received!], account)).toEqual([
      expect.objectContaining({
        protocol: "aquarius",
        tokenIn: "XLM",
        tokenOut: "AqUSDC",
        amountIn: "1.2500000",
        amountOut: "0.2500000",
        txHash: "tx-transfer",
      }),
    ]);
  });

  it("supports struct-style transfer data and excludes one-way movements", () => {
    const leg = decodeSpotTransfer(
      CONTRACT_ADDRESSES.SOROSWAP_USDC,
      ["transfer"],
      { from: account, to: "CPOOL", amount: BigInt("10000000") },
      account,
      "tx-one-way",
      200,
    );

    expect(leg).toMatchObject({ direction: "out", amount: BigInt("10000000") });
    expect(transfersToSpotHistory([leg!], account)).toEqual([]);
  });

  it("decodes the native XLM SAC's 4-topic transfer (trailing asset topic)", () => {
    const leg = decodeSpotTransfer(
      CONTRACT_ADDRESSES.BLEND_XLM,
      ["transfer", account, "CPOOL", "native"],
      BigInt("100000000"),
      account,
      "tx-sac",
      300,
    );
    expect(leg).toMatchObject({ direction: "out", amount: BigInt("100000000") });
  });

  it("excludes an LP deposit whose over-supplied side is refunded", () => {
    // Aquarius deposit_liquidity: XLM and AqUSDC both leave, a few stroops of
    // AqUSDC come back. Not a swap, though it has an outgoing and an incoming leg.
    const legs = [
      decodeSpotTransfer(CONTRACT_ADDRESSES.AQUARIUS_USDC, ["transfer", account, "CPOOL"], BigInt("20000000"), account, "tx-lp", 400),
      decodeSpotTransfer(CONTRACT_ADDRESSES.BLEND_XLM, ["transfer", account, "CPOOL", "native"], BigInt("2601400000"), account, "tx-lp", 400),
      decodeSpotTransfer(CONTRACT_ADDRESSES.AQUARIUS_USDC, ["transfer", "CPOOL", account], BigInt("277"), account, "tx-lp", 400),
    ];
    expect(legs.every(Boolean)).toBe(true);
    expect(transfersToSpotHistory(legs.map((leg) => leg!), account)).toEqual([]);
  });
});
