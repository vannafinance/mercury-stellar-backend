/**
 * The asset registry must agree with the chain, and with itself.
 *
 * ## Why this file was written before the registry
 *
 * A hand-authored knowledge layer is a second source of truth, and a second source of
 * truth is a bug waiting on a deploy. We have already shipped that bug once: a farm
 * pair list transcribed from a spec document advertised an XLM/AQUA pool that does not
 * exist on-chain, and the copilot told users it was farmable.
 *
 * So the registry is only allowed to exist if something checks it. `chain-facts.json`
 * is a recording of live MCP reads; these tests assert the registry never claims more
 * than that recording supports. Refresh it with `node scripts/refresh-chain-facts.mjs`
 * — the diff on that file IS the notification that the protocol moved.
 *
 * ## What this cannot catch
 *
 * The window between a protocol change and someone running the refresh. CI proves the
 * registry matches what we last observed, not what is true right now. That is a real
 * limit and the reason the refresh script exists as a separate, runnable thing rather
 * than a comment telling someone to remember.
 */

import { describe, expect, it } from "vitest";
import chainFacts from "@/lib/copilot/registry/chain-facts.json";
import {
  ASSET_IDS,
  ASSET_SCAN_ORDER,
  WRITE_ASSET_ENUM,
  assetDef,
  blendReserveSymbols,
  earnPoolSymbols,
  isDollarStable,
  marginCollateralSymbols,
  resolveAsset,
  USDC_VARIANTS,
} from "@/lib/copilot/registry/assets";

describe("the registry agrees with the recorded chain reads", () => {
  it("claims collateral only for assets the protocol actually allows", () => {
    const allowed = chainFacts.collateral.allowed as Record<string, boolean>;
    for (const id of ASSET_IDS) {
      const def = assetDef(id);
      if (!def.marginSymbol) continue;
      // The registry may map an alias onto the contract's symbol (BLUSDC → USDC),
      // so the claim is checked against the symbol actually sent on the wire.
      expect(
        allowed[def.marginSymbol],
        `${id} claims collateral via "${def.marginSymbol}", which the chain does not allow`,
      ).toBe(true);
    }
  });

  it("refuses collateral for assets the protocol rejects", () => {
    // EURC is a supported price symbol and a nameable write asset, and is NOT valid
    // collateral. Exactly the kind of asymmetry a single flat asset list cannot hold.
    const rejected = Object.entries(chainFacts.collateral.allowed as Record<string, boolean>)
      .filter(([, ok]) => !ok)
      .map(([sym]) => sym);
    for (const sym of rejected) {
      const claiming = ASSET_IDS.filter((id) => assetDef(id).marginSymbol === sym);
      expect(claiming, `${sym} is not allowed collateral, but the registry routes to it`).toEqual(
        [],
      );
    }
  });

  it("lists exactly the Blend reserves the pool reports", () => {
    expect(blendReserveSymbols().sort()).toEqual([...chainFacts.blendReserves.symbols].sort());
  });

  it("lists exactly the earn pools that answered pool_stats", () => {
    expect(earnPoolSymbols().sort()).toEqual([...chainFacts.earnPools.symbols].sort());
  });

  it("routes every earn alias to a pool that exists", () => {
    for (const [alias, target] of Object.entries(chainFacts.earnPools.aliases)) {
      const def = assetDef(alias as (typeof ASSET_IDS)[number]);
      expect(def.earnSymbol, `${alias} should earn-route to ${target}`).toBe(target);
    }
  });

  it("gives no earn route to a symbol the pool refused", () => {
    for (const sym of chainFacts.earnPools.rejected) {
      const def = ASSET_IDS.map(assetDef).find((d) => d.id === sym);
      if (def) expect(def.earnSymbol, `${sym} has no earn pool`).toBeNull();
    }
  });
});

describe("the registry is internally consistent", () => {
  it("has no duplicate aliases across assets", () => {
    const seen = new Map<string, string>();
    for (const id of ASSET_IDS) {
      for (const alias of assetDef(id).aliases) {
        const prior = seen.get(alias.toUpperCase());
        expect(prior, `alias "${alias}" is claimed by both ${prior} and ${id}`).toBeUndefined();
        seen.set(alias.toUpperCase(), id);
      }
    }
  });

  it("never lets a concrete asset answer to bare USDC", () => {
    // The ambiguity is the point: "USDC" is a question, not an asset. If any AssetDef
    // claimed it as an alias, the variant prompt would silently resolve to one token.
    for (const id of ASSET_IDS) {
      expect(assetDef(id).aliases.map((a) => a.toUpperCase())).not.toContain("USDC");
    }
  });

  it("keeps the two order-sensitive lists in step with the asset set", () => {
    // These stay hand-ordered because order changes behaviour — the scan order decides
    // which asset a sentence resolves to, and the enum order shapes the model prompt.
    // Their MEMBERSHIP is what used to drift, so that is what is pinned.
    const expected = [...ASSET_IDS, "USDC"].sort();
    expect([...ASSET_SCAN_ORDER].sort()).toEqual(expected);
    expect([...WRITE_ASSET_ENUM].sort()).toEqual(expected);
  });

  it("scans longest-first so a variant always beats bare USDC", () => {
    const idx = (s: string) => ASSET_SCAN_ORDER.indexOf(s as never);
    for (const v of USDC_VARIANTS) {
      expect(idx(v), `${v} must be scanned before bare USDC`).toBeLessThan(idx("USDC"));
    }
  });

  it("prices all three USDC variants off one oracle feed", () => {
    for (const v of USDC_VARIANTS) {
      expect(assetDef(v).oracleSymbol).toBe("USDC");
      expect(isDollarStable(v)).toBe(true);
    }
    expect(isDollarStable("XLM")).toBe(false);
  });

  it("keeps every declared margin symbol inside the allowed set", () => {
    const allowed = marginCollateralSymbols();
    expect(allowed).toContain("XLM");
    expect(allowed).toContain("AQUSDC");
    expect(allowed).toContain("SOUSDC");
    expect(allowed).toContain("USDC");
    expect(allowed).not.toContain("BLUSDC"); // the contract rejects this spelling
    expect(allowed).not.toContain("EURC");
  });
});

describe("resolveAsset — one answer for what the user said", () => {
  const concrete: Array<[string, string]> = [
    ["XLM", "XLM"],
    ["xlm", "XLM"],
    ["BLUSDC", "BLUSDC"],
    ["blusdc", "BLUSDC"],
    ["Blend USDC", "BLUSDC"],
    ["BLEND_USDC", "BLUSDC"],
    ["AQUSDC", "AQUSDC"],
    ["AqUSDC", "AQUSDC"],
    ["aquarius_usdc", "AQUSDC"],
    ["SOUSDC", "SOUSDC"],
    ["soroswap usdc", "SOUSDC"],
    ["AQUA", "AQUA"],
    ["EURC", "EURC"],
  ];

  for (const [input, id] of concrete) {
    it(`resolves "${input}" to ${id}`, () => {
      const r = resolveAsset(input);
      expect(r.kind).toBe("asset");
      if (r.kind === "asset") expect(r.def.id).toBe(id);
    });
  }

  it("treats bare USDC as ambiguous, offering exactly the three variants", () => {
    const r = resolveAsset("USDC");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.options.map((d) => d.id).sort()).toEqual(["AQUSDC", "BLUSDC", "SOUSDC"]);
    }
  });

  it("never reads the USDC inside BLUSDC as bare USDC", () => {
    // The nested-substring trap: a naive contains() makes every variant ambiguous.
    for (const v of USDC_VARIANTS) {
      expect(resolveAsset(v).kind).toBe("asset");
    }
  });

  it("returns nothing for an asset we do not support", () => {
    expect(resolveAsset("DOGE").kind).toBe("unknown");
    expect(resolveAsset("").kind).toBe("unknown");
  });
});
