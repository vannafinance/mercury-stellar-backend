/**
 * Candidate ids: one module mints them and owns the validator the route uses.
 *
 * ## The live failure this pins
 *
 * First signed-in battery, 11 Sep: every *Prepare this plan* and *Switch →* returned 400.
 * The generator minted `supply_idle_BLUSDC`; the propose route accepted `/^[a-z0-9_]{1,80}$/`.
 * Two sides, two spellings of one shape, and no option button had ever worked.
 *
 * The acceptance test here is the one the handoff asked for, in its own words: *"add a
 * fourth candidate kind with a symbol containing a digit and a hyphen, touch neither the
 * route nor its regex, and its button works."* So the route is driven for real, with a
 * kind it has never heard of and a symbol no list contains, and must get past its own
 * input gate. Authority over which ids were actually offered stays with the sealed
 * evidence, which is why the route is allowed to be this permissive.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  CANDIDATE_KINDS, candidateId, candidateKindTraits, isCandidateId, parseCandidateId,
  requiresMarginAccount, REQUESTED_ACTIONS_ID, type CandidateKind,
} from "@/lib/copilot/investigation/candidate-id";

const KINDS = Object.keys(CANDIDATE_KINDS) as CandidateKind[];

/** Symbols nobody enumerated: mixed case, digits, hyphens, and a Stellar CODE:ISSUER pair. */
const UNENUMERATED = ["BLUSDC", "US-DC2", "xlm-2.0", "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"];

describe("candidate ids", () => {
  it("round-trips every registered kind with symbols no list contains", () => {
    for (const kind of KINDS) {
      for (const asset of UNENUMERATED) {
        const id = candidateId(kind, asset);
        expect(isCandidateId(id)).toBe(true);
        expect(parseCandidateId(id)).toEqual({ kind, asset, traits: CANDIDATE_KINDS[kind] });
      }
    }
  });

  it("accepts the exact id the generator minted on 11 Sep, which the old route refused", () => {
    // `supply_idle_BLUSDC` failed `/^[a-z0-9_]{1,80}$/` on the uppercase symbol.
    expect(isCandidateId(candidateId("supply_idle", "BLUSDC"))).toBe(true);
  });

  it("treats requested_actions as the one id without an asset", () => {
    expect(isCandidateId(REQUESTED_ACTIONS_ID)).toBe(true);
    expect(parseCandidateId(REQUESTED_ACTIONS_ID)).toEqual({ kind: REQUESTED_ACTIONS_ID, asset: null, traits: null });
  });

  it("parses nothing it did not mint", () => {
    // A registered kind with no asset is not a candidate.
    expect(parseCandidateId("supply_idle")).toBeNull();
    expect(parseCandidateId("supply_idle:")).toBeNull();
    // The old underscore spelling never reached the generator's consumers either.
    expect(parseCandidateId("supply_idle_BLUSDC")).toBeNull();
    // A well-shaped id whose kind has no sizing or compile code behind it.
    expect(parseCandidateId("future_kind:US-DC2")).toBeNull();
  });

  it("rejects input that is not a printable, bounded token", () => {
    for (const bad of [
      "", " ", "supply_idle: BLUSDC", "supply_idle:BL\tUSDC", "supply_idle:BLUSDC\n",
      "Supply_Idle:BLUSDC", ":BLUSDC", "supply_idle:ÜSDC", "supply_idle:" + "X".repeat(80),
      42, null, undefined, {}, ["supply_idle:BLUSDC"],
    ]) {
      expect(isCandidateId(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses to mint an id it could not later accept, rather than render a dead button", () => {
    expect(() => candidateId("supply_idle", "BL USDC")).toThrow(/not representable/);
    expect(() => candidateId("supply_idle", "")).toThrow(/not representable/);
  });

  it("derives the account requirement from traits, so Earn is wallet-only and Blend needs margin", () => {
    expect(requiresMarginAccount(candidateKindTraits("lend_idle"))).toBe(false);
    expect(requiresMarginAccount(candidateKindTraits("supply_idle"))).toBe(true);
    expect(requiresMarginAccount(candidateKindTraits("borrow_supply"))).toBe(true);
    // Anything that borrows needs the margin account whatever venue it supplies to.
    expect(requiresMarginAccount({ borrows: true, venue: "earn", funding: "borrow" })).toBe(true);
  });
});

describe("POST /api/copilot/workflow/propose input gate", () => {
  beforeAll(async () => {
    process.env.COPILOT_SESSION_SECRET ??= "test-session-secret-at-least-32-chars-long!!";
    await import("@/app/api/copilot/workflow/propose/route");
    await import("next/server");
  }, 120_000);

  async function post(body: unknown) {
    const { POST } = await import("@/app/api/copilot/workflow/propose/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("https://preview.vanna.finance/api/copilot/workflow/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const res = await POST(req);
    return { status: res.status, json: (await res.json()) as { code?: string } };
  }

  it("lets a kind it has never heard of, on a symbol with a digit and a hyphen, past the shape gate", async () => {
    // No user is signed in, so getting 401 rather than 400 proves the id was accepted
    // by the route without the route knowing the kind. Authority is the sealed evidence.
    const res = await post({ continuation: "c", candidateId: "future_kind:US-DC2" });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe("sign_in_required");
  });

  it("still accepts every id the generator can mint today", async () => {
    for (const kind of KINDS) {
      const res = await post({ continuation: "c", candidateId: candidateId(kind, "BLUSDC") });
      expect(res.status, kind).toBe(401);
    }
    expect((await post({ continuation: "c", candidateId: REQUESTED_ACTIONS_ID })).status).toBe(401);
  });

  it("still refuses ids that are not a bounded printable token", async () => {
    for (const candidate of ["", "supply idle:BLUSDC", "supply_idle:" + "X".repeat(80), 7]) {
      const res = await post({ continuation: "c", candidateId: candidate });
      expect(res.status, JSON.stringify(candidate)).toBe(400);
      expect(res.json.code).toBe("invalid_request");
    }
  });
});
