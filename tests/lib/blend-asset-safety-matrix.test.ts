/**
 * A wrong-venue write must always be an explicit refusal, never a silent coercion.
 *
 * This is the exact class of bug behind issue #16 this session: `deploy_to_blend`
 * silently coerced AQUSDC/SOUSDC into Blend's own USDC reserve instead of refusing, so a
 * swap-then-farm strategy that paused on a blocked BLUSDC swap could resume with a
 * corrected token and still end up depositing into the WRONG venue. The fix was a
 * per-op asset allowlist (`blendCompatible` in `mapOpToMcpStep`'s Blend cases) — this
 * test is the "never again" version: it enumerates every asset the registry knows about
 * against every Blend-family op, so adding a new asset to the registry tomorrow without
 * ALSO teaching Blend's compatibility check about it fails a test immediately, instead
 * of silently moving a future user's funds to the wrong place.
 *
 * Only XLM and BLUSDC are real Blend reserves (confirmed live and in
 * `docs/copilot/TEST-RUN-FINDINGS.md`) — everything else must be refused with a real
 * `blocker` message, never accepted with a built `step`.
 */
import { describe, expect, it } from "vitest";
import { allAssets } from "@/lib/copilot/registry/assets";
import { mapOpToMcpStep } from "@/lib/copilot/mcp-write";

const BLEND_OPS = ["deploy_to_blend", "supply_to_blend", "withdraw_from_blend"] as const;
const BLEND_COMPATIBLE = new Set(["XLM", "BLUSDC"]);

const ctx = {
  smartAccount: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  trader: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
};

describe("Blend ops never silently accept a non-Blend asset", () => {
  for (const op of BLEND_OPS) {
    for (const def of allAssets()) {
      const shouldSucceed = BLEND_COMPATIBLE.has(def.id);
      it(`${op} × ${def.id} → ${shouldSucceed ? "builds a step" : "refuses with a blocker"}`, () => {
        const result = mapOpToMcpStep(op, { asset: def.id, amount: 10 }, ctx);
        if (shouldSucceed) {
          expect(result.blocker, `${op} wrongly refused ${def.id}`).toBeUndefined();
          expect(result.step, `${op} built no step for ${def.id}`).toBeDefined();
        } else {
          expect(result.step, `${op} silently built a step for ${def.id} instead of refusing`).toBeUndefined();
          expect(result.blocker, `${op} accepted ${def.id} with no blocker`).toBeTruthy();
        }
      });
    }
  }
});
