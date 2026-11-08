import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mercury-client", () => ({ fetchContractEvents: vi.fn() }));
vi.mock("@/lib/mercury-timestamps", () => ({ fetchTxTimestamps: vi.fn() }));

import {
  decodeSpotTransfer,
  decodeTraderExec,
  transfersToSpotHistory,
} from "@/lib/spot-history";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";

describe("Trader_Exec spot history decoding", () => {
  it("decodes Soroban's unit-enum vector and measured WAD deltas", () => {
    const row = decodeTraderExec(
      {
        action: ["Swap"],
        target: CONTRACT_ADDRESSES.AQUARIUS_ROUTER,
        deltas: {
          tokens: [CONTRACT_ADDRESSES.BLEND_XLM, CONTRACT_ADDRESSES.AQUARIUS_USDC],
          deltas: [BigInt("-1250000000000000000"), BigInt("250000000000000000")],
        },
      },
      "CACCT",
      "tx1",
      123,
    );

    expect(row).toMatchObject({
      protocol: "aquarius",
      tokenIn: "XLM",
      tokenOut: "AqUSDC",
      amountIn: "1.2500000",
      amountOut: "0.2500000",
      txHash: "tx1",
      timestamp: 123,
    });
  });

  it("ignores non-swap exec events", () => {
    expect(decodeTraderExec({ action: ["AddLiquidity"] }, "CACCT", "tx2", 0)).toBeNull();
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
