/**
 * Unnamed-surface routing used to live in handle.ts. Copilot never reaches it.
 * These cases must stay keyword-confident (no Vertex) or blocked, matching the
 * live bugs the venue-override comments in unnamed-intent.ts document.
 */
import { describe, expect, it } from "vitest";
import { resolveUnnamedIntent } from "@/lib/copilot/unnamed-intent";

const ctx = {
  smartAccount: null as string | null,
  trader: null as string | null,
  pageContext: null,
  request_id: "unnamed-intent-test",
};

describe("resolveUnnamedIntent", () => {
  it("trusts the keyword earn-pool list without asking Vertex", async () => {
    const result = await resolveUnnamedIntent({
      ...ctx,
      message: "list all earn pools",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.modelUnreachable).toBe(false);
    expect(result.routed).toMatchObject({
      kind: "read",
      template_id: "query_all_earn_pools",
    });
  });

  it("blocks an unsupported asset on a write instead of asking how much", async () => {
    const result = await resolveUnnamedIntent({
      ...ctx,
      message: "lend 10 BTC",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.template_id).toBe("unsupported_asset");
    expect(result.slots).toEqual({ asset: "BTC" });
  });
});
