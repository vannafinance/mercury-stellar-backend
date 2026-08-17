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
});
