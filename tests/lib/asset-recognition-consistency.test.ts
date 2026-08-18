/**
 * The bXLM bug happened because "is this a known asset" was answered independently in
 * four places (the asset registry, the domain firewall's vocabulary, the page-guide
 * concept classifier, and — for USDT specifically — a hand-copied literal in
 * `router.ts`'s dual-amount parser and `vertex-tools.ts`'s pair list). Adding an asset or
 * a spelling to one never propagated to the others, so a real in-domain question kept
 * getting refused as off-topic chat or mishandled as a concept explainer, over and over,
 * for a different asset each time.
 *
 * `domain-firewall.ts` and `concept.ts` now DERIVE their asset vocabulary from
 * `registry/assets.ts` (`ASSET_DOMAIN_WORDS`/`ASSET_SYMBOL_PATTERN`) instead of
 * maintaining their own copies — so this test isn't pinning today's asset list, it's
 * pinning the PROPERTY that every asset the registry knows about is automatically
 * recognised everywhere else. Add a new asset or alias to the registry tomorrow and this
 * test covers it with zero other changes; remove the derivation and it fails immediately
 * instead of waiting for a live report.
 */
import { describe, expect, it } from "vitest";
import { allAssets } from "@/lib/copilot/registry/assets";
import { evaluateDomainFirewall } from "@/lib/copilot/domain-firewall";
import { isAssistantChat } from "@/lib/copilot/concept";
import { routeMessage } from "@/lib/copilot/router";

// One single-word alias per asset — multi-word forms ("Blend USDC") are a different,
// already-covered concern (resolveAsset's own free-text scan), not what this test is
// about: whether a bare, unambiguous asset word is treated as in-domain everywhere.
const singleWordAliases = allAssets().flatMap((def) =>
  def.aliases.filter((a) => !/\s/.test(a)).map((alias) => ({ id: def.id, alias })),
);

describe("every registry asset is recognised consistently across the whole surface", () => {
  for (const { id, alias } of singleWordAliases) {
    const ask = `What is the current rate of ${alias}?`;

    it(`domain firewall allows a plain rate question about ${alias} (${id})`, () => {
      const fw = evaluateDomainFirewall(ask);
      expect(fw.allow, `firewall refused "${ask}": ${!fw.allow ? fw.reason : ""}`).toBe(true);
    });

    it(`the page-guide classifier treats ${alias} (${id}) as a live-data lookup, not a concept question`, () => {
      expect(
        isAssistantChat(ask),
        `"${ask}" was routed to the generic concept explainer instead of a live data read`,
      ).toBe(false);
    });

    it(`the router never falls through to the generic capabilities blurb for ${alias} (${id})`, () => {
      const r = routeMessage(ask);
      if (r.kind === "clarify") {
        expect(r.template_id, `"${ask}" fell to: ${r.template_id}`).not.toBe("clarify_capabilities");
      }
    });
  }

  it("bare 'USDC' — the one deliberate exception — is still in-domain everywhere, without being a resolvable asset", () => {
    const ask = "What is the current rate of USDC?";
    expect(evaluateDomainFirewall(ask).allow).toBe(true);
    expect(isAssistantChat(ask)).toBe(false);
  });
});
