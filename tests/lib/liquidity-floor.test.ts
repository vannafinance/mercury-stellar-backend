import { describe, expect, it } from "vitest";
import { liquidityFloor } from "@/lib/copilot/investigation/pool-quote";
import { decimalWad, formatWad } from "@/lib/copilot/investigation/fixed";

/**
 * 8 Oct, live: every add-liquidity the copilot sent was refused by the router (Aquarius HostError #2006, Soroswap
 * #506) because `min_liquidity_out` carried the pool-share estimate, which the MCP's AccountManager halves and
 * applies as a per-token minimum to both legs. Measured against the live pools through simulation:
 *   Aquarius 20 XLM + 0.2321538 AQUSDC: floors up to about 0.625 pass, 2 fails; the share estimate was 2.13.
 *   Soroswap 15 XLM + 2.9854772 SOUSDC: floors up to about 5.97 (twice the smaller leg) pass; the share estimate was 6.46.
 */
const wad = (text: string) => decimalWad(text);
const show = (value: bigint) => Number(formatWad(value));

describe("liquidityFloor", () => {
  it("caps the Aquarius floor below what the live simulation accepts (0.625), not at the 2.13 share estimate", () => {
    const floor = liquidityFloor(wad("2.1444304"), wad("20"), wad("0.2321538"));
    expect(show(floor)).toBeLessThan(0.625);
    expect(show(floor)).toBeGreaterThan(0.4);
  });

  it("caps the Soroswap floor below twice the smaller leg (5.97), not at the 6.46 share estimate", () => {
    const floor = liquidityFloor(wad("6.4934589"), wad("15"), wad("2.9854772"));
    expect(show(floor)).toBeLessThan(2 * 2.9854772);
    expect(show(floor)).toBeGreaterThan(5.5);
  });

  it("keeps the slippage-protected share count when it is already under the cap", () => {
    // A pool whose shares are small relative to the legs (shares 1, legs 10 and 10).
    expect(show(liquidityFloor(wad("1"), wad("10"), wad("10")))).toBeCloseTo(0.995, 6);
  });

  it("does not depend on which leg is smaller", () => {
    expect(liquidityFloor(wad("9"), wad("2"), wad("5"))).toBe(liquidityFloor(wad("9"), wad("5"), wad("2")));
  });
});
