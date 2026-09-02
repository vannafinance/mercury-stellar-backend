/**
 * Phase 2 — the typed intent contract.
 *
 * ## What these tests are actually protecting
 *
 * Not "borrow_asset works". Three separate fixes have already made one field work:
 *
 *   leverage      dropped on approve replay → approved "deploy 10 BLUSDC at 2×" ran as
 *                 a plain 1× supply. Fixed by adding a line.
 *   borrow_asset  dropped on approve replay → approved "deposit 500 AQUSDC, borrow XLM
 *                 at 3×" ran `borrow 1000 AQUSDC`, the DOLLAR debt as the wrong token.
 *                 Fixed by adding a line.
 *   token_out     still dropped at the time Phase 2 was commissioned.
 *
 * Every fix was correct and none prevented the next, because the executable content of
 * an action had no single definition — five sites each hand-listed a subset, and a
 * forgotten line is indistinguishable from a genuinely absent value.
 *
 * So the central test here is not per-field. `every executable slot survives…` LOOPS
 * OVER `SLOT_NAMES` and asserts carriage, hashing and rejection-on-drop for each. A slot
 * added to EXECUTABLE_SLOTS is covered by these tests the moment it is added, without
 * anyone remembering to write a case for it. That is the only form of this test that
 * closes the class rather than the instance.
 */

import { describe, expect, it } from "vitest";
import {
  EXECUTABLE_SLOTS,
  SLOT_NAMES,
  actionFrom,
  compactSlots,
  missingSlots,
  normalizeIntent,
  parseIntent,
  slotsAreEqual,
  slotsToAction,
  slotsToIntent,
  intentToSlots,
  toSlots,
  type IntentSlots,
  type SlotName,
} from "@/lib/copilot/registry/intent";
import { freezePlan, planFingerprint, verifyApprovedPlan } from "@/lib/copilot/plan-approval";
import { actionFromExpanded, expandPlanWrites } from "@/lib/copilot/multi-leg-agent";
import type { RoutedIntent } from "@/lib/copilot/types";

const NOW = 1_770_000_000_000;
const CTX = { smartAccount: null, trader: null, minHf: null };

/** A representative non-empty value per slot kind, used to drive the generic loop. */
const SAMPLE: Record<SlotName, string | number | boolean> = {
  asset: "AQUSDC",
  amount: 500,
  leverage: 3,
  borrow_asset: "XLM",
  borrow_amount: 42,
  token_a: "XLM",
  token_b: "BLUSDC",
  amount_a: 10,
  amount_b: 20,
  fraction: 0.5,
  venue: "aquarius",
  min_hf: 1.4,
  prefer_max_yield: true,
};

// ── boundary rejection ──────────────────────────────────────────────────────

describe("parseIntent refuses bad input where it enters", () => {
  it("no op at all", () => {
    const r = parseIntent({ asset: "XLM", amount: 5 });
    expect("invalid" in r && r.invalid.reason).toBe("missing_op");
  });

  it("an asset Vanna cannot trade", () => {
    const r = parseIntent({ op: "lend", asset: "DOGE", amount: 5 });
    expect("invalid" in r && r.invalid.reason).toBe("unknown_asset");
  });

  it("a bare USDC is AMBIGUOUS, not invalid — the product asks", () => {
    // The distinction is load-bearing. Flattening this to an error would replace a
    // working variant-chip question with a failure; flattening it to null would drop
    // the user's own word and ask "which one?" about nothing.
    const r = parseIntent({ op: "lend", asset: "USDC", amount: 5 });
    expect("invalid" in r).toBe(true);
    if (!("invalid" in r)) return;
    expect(r.invalid.reason).toBe("ambiguous_asset");
    if (r.invalid.reason !== "ambiguous_asset") return;
    expect(r.invalid.options.map((o) => o.id)).toEqual(["BLUSDC", "AQUSDC", "SOUSDC"]);
  });

  it("an unusable borrow asset is caught on its own slot", () => {
    const r = parseIntent({ op: "deposit_and_borrow", asset: "AQUSDC", amount: 500, borrow_asset: "WBTC" });
    expect("invalid" in r && r.invalid.reason).toBe("unknown_asset");
    if (!("invalid" in r) || r.invalid.reason !== "unknown_asset") return;
    expect(r.invalid.slot).toBe("borrow_asset");
  });

  it("a non-numeric size", () => {
    const r = parseIntent({ op: "lend", asset: "XLM", amount: "lots" });
    expect("invalid" in r && r.invalid.reason).toBe("bad_amount");
  });

  it("a negative or zero size", () => {
    for (const amount of [-5, 0]) {
      const r = parseIntent({ op: "lend", asset: "XLM", amount });
      expect("invalid" in r && r.invalid.reason, String(amount)).toBe("bad_amount");
    }
  });

  it("1× or below is not leverage", () => {
    // A borrow leg sized from L≤1 is zero or negative — meaningless, and previously it
    // would have been sized and handed to a signature prompt.
    for (const leverage of [1, 0, -2]) {
      const r = parseIntent({ op: "deposit_and_borrow", asset: "XLM", amount: 10, leverage });
      expect("invalid" in r && r.invalid.reason, String(leverage)).toBe("bad_leverage");
    }
  });

  it("accepts a fully specified intent and groups it", () => {
    const r = parseIntent({
      op: "deposit_and_borrow",
      asset: "AQUSDC",
      amount: 500,
      leverage: 3,
      borrow_asset: "XLM",
      min_hf: 1.4,
    });
    expect("intent" in r).toBe(true);
    if (!("intent" in r)) return;
    expect(r.intent.collateral).toEqual({ asset: "AQUSDC", amount: 500 });
    expect(r.intent.borrow).toEqual({ asset: "XLM", amount: null });
    expect(r.intent.leverage).toBe(3);
    expect(r.intent.minHf).toBe(1.4);
  });

  it("reads an alias and a lowercase spelling to the canonical id", () => {
    const r = parseIntent({ op: "lend", asset: "blend usdc", amount: 5 });
    expect("intent" in r && r.intent.collateral.asset).toBe("BLUSDC");
  });
});

// ── the generic guarantee ───────────────────────────────────────────────────

/**
 * A one-step plan carrying exactly one slot on top of a minimal base.
 *
 * `lend` on purpose: it is a single-leg op, so the expansion passes it straight through
 * and this measures CARRIAGE rather than the split semantics of a levered op (whose
 * derived deposit leg legitimately does not inherit every slot). The base values are
 * deliberately different from every SAMPLE value, so adding the slot always changes the
 * fingerprint — a base that collided with the sample would make the hash test pass for
 * the wrong reason.
 */
function planWithSlot(slot: SlotName): Extract<RoutedIntent, { kind: "plan" }> {
  return {
    kind: "plan",
    template_id: "t",
    summary: "s",
    steps: [
      {
        kind: "write",
        op: "lend",
        asset: "XLM",
        amount: 1,
        args: { [slot]: SAMPLE[slot] },
      },
    ],
  };
}

/** The approval payload exactly as components/copilot/copilot-workspace.tsx builds it. */
function approvalPayload(p: ReturnType<typeof freezePlan>) {
  return {
    plan_id: p.plan_id,
    created_at: p.created_at,
    steps: p.steps.map((s) => ({
      op: s.op,
      slots: s.slots,
      asset: s.asset,
      amount: s.amount,
      leverage: s.leverage,
      borrow_asset: s.borrow_asset ?? null,
    })),
  };
}

describe.each(SLOT_NAMES)("every executable slot survives the whole path — %s", (slot) => {
  it("is carried from the plan into the frozen step", () => {
    const [step] = freezePlan(planWithSlot(slot), NOW).steps;
    expect(compactSlots(step.slots)[slot]).toBeDefined();
  });

  it("is inside the approval fingerprint", () => {
    // If it is not hashed, a client can change it after approval and the plan_id still
    // matches — which is exactly how a different trade executed silently.
    const base = { op: "lend", slots: { asset: "XLM", amount: 1 } as IntentSlots };
    const withSlot = { op: base.op, slots: { ...base.slots, [slot]: SAMPLE[slot] } as IntentSlots };
    expect(planFingerprint([withSlot])).not.toBe(planFingerprint([base]));
  });

  it("survives the approve replay", () => {
    const frozen = freezePlan(planWithSlot(slot), NOW);
    const check = verifyApprovedPlan(approvalPayload(frozen), NOW + 1_000);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const replayed = toSlots(check.plan.steps[0]);
    expect(compactSlots(replayed)[slot]).toBeDefined();
    // And the whole record is unchanged, not merely this one slot.
    expect(slotsAreEqual(replayed, frozen.steps[0].slots)).toBe(true);
  });

  it("stripping it from the approval is REJECTED, never silently executed", () => {
    const frozen = freezePlan(planWithSlot(slot), NOW);
    const payload = approvalPayload(frozen);
    // Strip BOTH spellings. The legacy top-level fields are honoured on purpose (an
    // older client that never learned `slots` must still validate), so a strip that
    // leaves one of them behind is not a strip at all — it is a correct approval.
    const stripped = {
      ...payload,
      steps: payload.steps.map((s) => {
        const slots = { ...compactSlots(s.slots) };
        delete slots[slot];
        const legacy = { ...s, slots } as Record<string, unknown>;
        delete legacy[slot];
        return legacy as typeof s;
      }),
    };
    const check = verifyApprovedPlan(stripped, NOW + 1_000);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    // Rejection is the guarantee. Which slot went missing is NOT knowable here — only
    // the hash of the approved plan is held, not the plan — so the message stays generic
    // and the two hashes go to a log line instead.
    expect(check.reason).toBe("fingerprint_mismatch");
  });

  it("reaches the executable action", () => {
    const frozen = freezePlan(planWithSlot(slot), NOW);
    const check = verifyApprovedPlan(approvalPayload(frozen), NOW + 1_000);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const expanded = expandPlanWrites(check.plan.steps);
    const action = actionFromExpanded(expanded[0], CTX) as unknown as Record<string, unknown>;
    // token_a/token_b are the swap spelling too, so both names are acceptable here.
    const seen = action[slot] ?? action[slot === "token_a" ? "token_in" : "token_out"];
    expect(seen, `${slot} did not reach the action`).not.toBeNull();
    expect(seen).not.toBeUndefined();
  });
});

// ── the specific slot the operator called out ───────────────────────────────

describe("a swap's token_out — the next instance of the same bug", () => {
  const swapPlan: Extract<RoutedIntent, { kind: "plan" }> = {
    kind: "plan",
    template_id: "t",
    summary: "swap",
    steps: [
      {
        kind: "write",
        op: "swap",
        asset: "XLM",
        amount: 10,
        args: { token_in: "XLM", token_out: "BLUSDC" },
      },
    ],
  };

  it("survives approve → replay → expand as the swap's destination token", () => {
    const frozen = freezePlan(swapPlan, NOW);
    const check = verifyApprovedPlan(approvalPayload(frozen), NOW + 1_000);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const [leg] = expandPlanWrites(check.plan.steps);
    expect(leg.op).toBe("swap");
    // Live, this arrived null and the swap had no destination — the same class of drop
    // as leverage and borrow_asset, in the third field.
    expect(leg.token_out).toBe("BLUSDC");
    const action = actionFromExpanded(leg, CTX);
    expect(action.token_b).toBe("BLUSDC");
    expect(action.token_a).toBe("XLM");
  });

  it("a stripped token_out is rejected rather than swapped to nowhere", () => {
    const frozen = freezePlan(swapPlan, NOW);
    const payload = approvalPayload(frozen);
    const stripped = {
      ...payload,
      steps: payload.steps.map((s) => {
        const slots = { ...compactSlots(s.slots) };
        delete slots.token_b;
        return { ...s, slots };
      }),
    };
    expect(verifyApprovedPlan(stripped, NOW + 1_000).ok).toBe(false);
  });
});

// ── the five conversion sites are now one ──────────────────────────────────

describe("one conversion, so the sites cannot disagree", () => {
  const slots: IntentSlots = {
    asset: "AQUSDC",
    amount: 500,
    leverage: 3,
    borrow_asset: "XLM",
    fraction: 0.5,
    venue: "aquarius",
    min_hf: 1.4,
  };

  it("router output and a resume payload produce the same action", () => {
    const fromRouter = actionFrom({ op: "deposit_and_borrow", ...slots }, CTX);
    const fromResume = actionFrom({ op: "deposit_and_borrow", args: slots }, CTX);
    expect(fromResume).toEqual(fromRouter);
  });

  it("an expanded leg produces the same action as the router did", () => {
    const [leg] = expandPlanWrites([
      { kind: "write", op: "deposit_and_borrow", asset: "AQUSDC", amount: 500, args: slots },
    ]);
    const fromLeg = actionFromExpanded(leg, CTX) as unknown as Record<string, unknown>;
    const fromRouter = actionFrom({ op: "deposit_and_borrow", ...slots }, CTX) as unknown as Record<string, unknown>;
    for (const name of SLOT_NAMES) {
      expect(fromLeg[name], `${name} differs between conversion sites`).toEqual(
        fromRouter[name],
      );
    }
  });

  it("reads both spellings of every slot", () => {
    // Producers disagree — the extractor writes args.borrow_asset, the router writes
    // borrow_asset. Each site used to know only its own, which is how a slot vanished
    // depending on which path built the step.
    for (const name of SLOT_NAMES) {
      const top = toSlots({ op: "x", [name]: SAMPLE[name] });
      const nested = toSlots({ op: "x", args: { [name]: SAMPLE[name] } });
      expect(slotsAreEqual(top, nested), name).toBe(true);
    }
  });

  it("derives requires_amount / requires_account rather than carrying them", () => {
    const noAmount = slotsToAction("borrow", { asset: "XLM" }, CTX);
    expect(noAmount.requires_amount).toBe(true);
    expect(slotsToAction("create_account", {}, CTX).requires_amount).toBe(false);
    expect(slotsToAction("lend", { asset: "XLM", amount: 5 }, CTX).requires_account).toBe(false);
    // remove_liquidity is sized by fraction, so it needs no amount.
    expect(
      slotsToAction("remove_liquidity", { fraction: 0.5 }, CTX).requires_amount,
    ).toBe(false);
  });

  it("a slot-level min_hf beats the ambient one", () => {
    // An approved plan carries the floor that was approved, not whatever the current
    // message happens to parse to.
    const a = slotsToAction("borrow", { asset: "XLM", amount: 5, min_hf: 2 }, { ...CTX, minHf: 1.3 });
    expect(a.min_hf).toBe(2);
    const b = slotsToAction("borrow", { asset: "XLM", amount: 5 }, { ...CTX, minHf: 1.3 });
    expect(b.min_hf).toBe(1.3);
  });
});

// ── shape invariants ───────────────────────────────────────────────────────

describe("slot record invariants", () => {
  it("SLOT_NAMES covers EXECUTABLE_SLOTS exactly", () => {
    expect([...SLOT_NAMES].sort()).toEqual(Object.keys(EXECUTABLE_SLOTS).sort());
  });

  it("absent and empty spell the same thing", () => {
    expect(slotsAreEqual(toSlots({ op: "x" }), toSlots({ op: "x", asset: "", amount: null }))).toBe(
      true,
    );
  });

  it("intent ↔ slots round-trips without loss", () => {
    const slots = compactSlots({
      asset: "AQUSDC",
      amount: 500,
      leverage: 3,
      borrow_asset: "XLM",
      token_a: "XLM",
      token_b: "BLUSDC",
      amount_a: 1,
      amount_b: 2,
      fraction: 0.25,
      venue: "soroswap",
      min_hf: 1.5,
      prefer_max_yield: true,
    });
    expect(slotsAreEqual(intentToSlots(slotsToIntent("swap", slots)), slots)).toBe(true);
  });

  it("missingSlots names exactly what was lost", () => {
    const before = toSlots({ op: "x", asset: "XLM", amount: 5, borrow_asset: "AQUSDC" });
    const after = toSlots({ op: "x", asset: "XLM", amount: 5 });
    expect(missingSlots(before, after)).toEqual(["borrow_asset"]);
  });

  it("normalizeIntent canonicalises without rejecting", () => {
    // Internal hops must not re-validate — see the module header.
    const n = normalizeIntent({ op: "lend", asset: "usdc", amount: "5" });
    expect(n.op).toBe("lend");
    expect(n.slots.amount).toBe(5);
    // Bare USDC is preserved verbatim so the clarify flow can still ask about it.
    expect(n.slots.asset).toBe("USDC");
  });

  it("venue spellings normalise to one id", () => {
    for (const raw of ["soroswap", "Soroswap", "soro", "SOROSWAP_AMM"]) {
      expect(toSlots({ op: "swap", venue: raw }).venue, raw).toBe("soroswap");
    }
  });
});
