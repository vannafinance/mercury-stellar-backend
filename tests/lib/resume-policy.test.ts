/**
 * Multi-leg resume policy: one leg per hop, and who owns the queue.
 *
 * The bug these pin: continuing a 4-leg run posted every remaining leg in one
 * request, the server executed the whole tail inside that hop, and with no
 * streaming the card could not repaint until the batch finished. Leg 2 sat on
 * "waiting on ledger" for tens of seconds and then legs 3 and 4 appeared
 * already settled, having never been shown running. Correct final state,
 * invisible progress — which on a money path is its own failure.
 */

import { describe, expect, it } from "vitest";
import {
  LEDGER_CONFIRM_HINT,
  claimFirstAwaitingLeg,
  hasMoreLegs,
  ledgerWaitCopy,
  legsFromUnsettledSteps,
  pickRemainingLegs,
  pendingLpStepFromResume,
  farmWriteAlreadySettled,
  pruneDuplicateFarmAdds,
  shouldAutoResume,
  splitResumeBatch,
  strategyIsComplete,
  type ResumeLegLike,
} from "@/components/copilot/resume-policy";

/** Park 20 XLM then farm 10 BLUSDC at 2x — the repro from the report. */
const FOUR_LEGS: ResumeLegLike[] = [
  { op: "lend", asset: "XLM", amount: 20, label: "Lend 20 XLM" },
  { op: "deposit_collateral", asset: "BLUSDC", amount: 10, label: "Deposit 10 BLUSDC" },
  { op: "borrow", asset: "BLUSDC", amount: 10, label: "Borrow 10 BLUSDC" },
  { op: "supply_to_blend", asset: "BLUSDC", amount: 20, label: "Supply 20 BLUSDC to Blend" },
];

describe("splitResumeBatch — one leg per hop", () => {
  it("sends exactly one leg and keeps the rest", () => {
    const { head, tail } = splitResumeBatch(FOUR_LEGS);
    expect(head).toHaveLength(1);
    expect(head[0].op).toBe("lend");
    expect(tail).toHaveLength(3);
    expect(tail.map((l) => l.op)).toEqual(["deposit_collateral", "borrow", "supply_to_blend"]);
  });

  it("walks the whole strategy in order, one hop at a time", () => {
    // The behaviour the user should see: four separate hops, so four repaints.
    const order: string[] = [];
    let queue: ResumeLegLike[] = FOUR_LEGS;
    let hops = 0;
    while (queue.length) {
      const { head, tail } = splitResumeBatch(queue);
      order.push(head[0].op);
      queue = tail;
      hops += 1;
      if (hops > 10) throw new Error("did not terminate");
    }
    expect(hops).toBe(4);
    expect(order).toEqual(["lend", "deposit_collateral", "borrow", "supply_to_blend"]);
  });

  it("never batches, even for a two-leg tail", () => {
    expect(splitResumeBatch(FOUR_LEGS.slice(2)).head).toHaveLength(1);
  });

  it("a single leg leaves an empty tail (the run ends)", () => {
    const { head, tail } = splitResumeBatch([FOUR_LEGS[3]]);
    expect(head).toHaveLength(1);
    expect(tail).toEqual([]);
  });

  it("handles empty / null / undefined without throwing", () => {
    for (const input of [[], null, undefined]) {
      expect(splitResumeBatch(input as ResumeLegLike[] | null)).toEqual({ head: [], tail: [] });
    }
  });

  it("does not mutate the input", () => {
    const legs = [...FOUR_LEGS];
    splitResumeBatch(legs);
    expect(legs).toHaveLength(4);
  });

  it("carries the leg payload through untouched", () => {
    // Dropping leverage here would resume a levered leg unlevered — a different
    // transaction from the one that was approved.
    const levered: ResumeLegLike = { op: "borrow", asset: "XLM", amount: 5, leverage: 2 };
    expect(splitResumeBatch([levered]).head[0]).toEqual(levered);
  });
});

describe("pickRemainingLegs — the server stops knowing, the client keeps knowing", () => {
  it("prefers the server list while it still reports later legs", () => {
    const server = FOUR_LEGS.slice(1);
    expect(pickRemainingLegs(server, [FOUR_LEGS[3]])).toEqual(server);
  });

  it("does not drop a client-held LP leg when the server reports only part of the tail", () => {
    const server = [{ op: "add_liquidity", asset: "AQUSDC", amount: 5, venue: "aquarius" }];
    const clientTail = [
      server[0],
      { op: "add_liquidity", asset: "AQUSDC", amount: 5, venue: "aquarius", token_b: "AQUSDC" },
    ];
    const remaining = pickRemainingLegs(server, clientTail);
    expect(remaining).toHaveLength(2);
    expect(remaining[1]).toMatchObject({ op: "add_liquidity", token_b: "AQUSDC" });
  });

  it("THE FIX: falls back to the client tail when the server reports none", () => {
    // Hand the server one leg and it plans one leg, so remaining_legs comes back
    // empty and it declares the strategy finished. Without this fallback the run
    // stops silently after leg 2.
    const tail = FOUR_LEGS.slice(2);
    expect(pickRemainingLegs([], tail)).toEqual(tail);
    expect(pickRemainingLegs(null, tail)).toEqual(tail);
    expect(pickRemainingLegs(undefined, tail)).toEqual(tail);
  });

  it("last resort: rebuilds from unsettled card rows when both lists are empty", () => {
    const fromCard = FOUR_LEGS.slice(2);
    expect(pickRemainingLegs([], [], fromCard)).toEqual(fromCard);
    expect(pickRemainingLegs(null, null, fromCard)).toEqual(fromCard);
  });

  it("is empty only when all sources are", () => {
    expect(pickRemainingLegs(null, [])).toEqual([]);
    expect(pickRemainingLegs(undefined, undefined)).toEqual([]);
    expect(pickRemainingLegs([], [], [])).toEqual([]);
  });

  it("returns a copy, so the caller cannot mutate the queue by accident", () => {
    const tail = FOUR_LEGS.slice(2);
    const out = pickRemainingLegs(null, tail);
    out.pop();
    expect(tail).toHaveLength(2);
  });

  it("hasMoreLegs mirrors it — used to hold back 'All steps completed'", () => {
    expect(hasMoreLegs([], FOUR_LEGS.slice(3))).toBe(true);
    expect(hasMoreLegs(FOUR_LEGS.slice(1), [])).toBe(true);
    expect(hasMoreLegs([], [], FOUR_LEGS.slice(2))).toBe(true);
    expect(hasMoreLegs([], [])).toBe(false);
    expect(hasMoreLegs(null, null)).toBe(false);
  });
});

describe("legsFromUnsettledSteps", () => {
  it("keeps pending / needs_sign legs and drops settled ones", () => {
    const steps = [
      { op: "lend", status: "ok", amount: 20, asset: "XLM", label: "Lend 20 XLM" },
      { op: "deposit_collateral", status: "ok", amount: 10, asset: "BLUSDC", label: "Deposit" },
      { op: "borrow", status: "pending", amount: 10, asset: "BLUSDC", label: "Borrow" },
      { op: "supply_to_blend", status: "pending", amount: 10, asset: "BLUSDC", label: "Supply" },
    ];
    expect(legsFromUnsettledSteps(steps).map((l) => l.op)).toEqual([
      "borrow",
      "supply_to_blend",
    ]);
  });
});

describe("full auto-approve walk", () => {
  it("four legs produce four hops and finish exactly once", () => {
    // Simulates the client loop: post head, server returns nothing remaining
    // (it only saw one leg), client tail drives the next hop.
    let tail: ResumeLegLike[] = [];
    let remaining = pickRemainingLegs(FOUR_LEGS, tail);
    const posted: string[] = [];

    while (remaining.length) {
      const split = splitResumeBatch(remaining);
      posted.push(split.head[0].op);
      tail = split.tail;
      // Server saw one leg → reports no remaining legs of its own.
      remaining = pickRemainingLegs([], tail);
    }

    expect(posted).toEqual(["lend", "deposit_collateral", "borrow", "supply_to_blend"]);
    expect(tail).toEqual([]);
    expect(hasMoreLegs([], tail)).toBe(false);
  });
});

describe("claimFirstAwaitingLeg — one signature settles one leg", () => {
  const steps = [
    { n: 1, status: "ok", tx_hash: "hash_leg1" },
    { n: 2, status: "needs_sign", tx_hash: null as string | null },
    { n: 3, status: "pending", tx_hash: null as string | null },
    { n: 4, status: "pending", tx_hash: null as string | null },
  ];

  it("claims only the first awaiting leg", () => {
    const { steps: out, claimed } = claimFirstAwaitingLeg(steps, (s) => ({
      ...s,
      status: "ok",
      tx_hash: "hash_leg2",
    }));
    expect(claimed).toBe(true);
    expect(out[1]).toMatchObject({ n: 2, status: "ok", tx_hash: "hash_leg2" });
  });

  it("NEVER stamps a pending leg with an earlier hash", () => {
    // The regression: legs 3 and 4 once read "DONE tx c7ec9aa…" — leg 2's hash —
    // while only two transactions existed on chain.
    const { steps: out } = claimFirstAwaitingLeg(steps, (s) => ({
      ...s,
      status: "ok",
      tx_hash: "hash_leg2",
    }));
    expect(out[2]).toMatchObject({ n: 3, status: "pending", tx_hash: null });
    expect(out[3]).toMatchObject({ n: 4, status: "pending", tx_hash: null });
  });

  it("leaves already-settled legs alone", () => {
    const { steps: out } = claimFirstAwaitingLeg(steps, (s) => ({ ...s, tx_hash: "other" }));
    expect(out[0]).toMatchObject({ n: 1, status: "ok", tx_hash: "hash_leg1" });
  });

  it("treats staged and needs_wallet_sign as awaiting too", () => {
    for (const status of ["staged", "needs_wallet_sign", "needs_sign"]) {
      const { claimed } = claimFirstAwaitingLeg([{ status }], (s) => s);
      expect(claimed).toBe(true);
    }
  });

  it("claims nothing when no leg is awaiting", () => {
    const { claimed } = claimFirstAwaitingLeg(
      [{ status: "ok" }, { status: "pending" }],
      (s) => ({ ...s, status: "ok" }),
    );
    expect(claimed).toBe(false);
  });

  it("THE LIVE BUG: claim BEFORE pickRemainingLegs so the signed borrow is not re-queued", () => {
    // Wallet-sign success used to call pickRemainingLegs while borrow still read
    // needs_sign, so legsFromUnsettledSteps re-queued it and auto-approve borrowed
    // ~309 XLM over and over on the same 50 AQUSDC @ 2× plan.
    const card = [
      {
        op: "deposit_collateral",
        status: "ok",
        amount: 50,
        asset: "AQUSDC",
        label: "Deposit 50 AQUSDC as collateral",
      },
      {
        op: "borrow",
        status: "needs_sign",
        amount: 309.1208496,
        asset: "XLM",
        label: "Borrow 309.1208496 XLM",
      },
    ];
    // Wrong order (what the client used to do):
    const beforeClaim = pickRemainingLegs(
      null,
      [],
      legsFromUnsettledSteps(card),
    );
    expect(beforeClaim.map((l) => l.op)).toEqual(["borrow"]);

    // Right order: settle the signed leg first, then ask what remains.
    const { steps: settled } = claimFirstAwaitingLeg(card, (s) => ({
      ...s,
      status: "ok",
      tx_hash: "abc",
    }));
    const afterClaim = pickRemainingLegs(
      null,
      [],
      legsFromUnsettledSteps(settled),
    );
    expect(afterClaim).toEqual([]);
    expect(hasMoreLegs(null, [], legsFromUnsettledSteps(settled))).toBe(false);
  });

  it("the submit-time stamp adds a hash WITHOUT settling the leg", () => {
    // Submitted ≠ confirmed. Marking it ok here would claim an outcome the
    // ledger has not given yet.
    const { steps: out } = claimFirstAwaitingLeg(steps, (s) => ({
      ...s,
      tx_hash: "hash_leg2",
      message: ledgerWaitCopy("hash_leg2"),
    }));
    expect(out[1].status).toBe("needs_sign");
    expect(out[1].tx_hash).toBe("hash_leg2");
  });

  it("handles empty input", () => {
    expect(claimFirstAwaitingLeg([], (s) => s)).toEqual({ steps: [], claimed: false });
    expect(claimFirstAwaitingLeg(null, (s) => s)).toEqual({ steps: [], claimed: false });
  });
});

describe("ledger wait copy", () => {
  it("leads with the hash so there is something checkable during the wait", () => {
    const copy = ledgerWaitCopy("abc123def456789");
    expect(copy).toContain("abc123def4…");
    expect(copy).toContain(LEDGER_CONFIRM_HINT);
    expect(copy).toMatch(/confirming on ledger/i);
  });

  it("still says something useful before a hash exists", () => {
    for (const h of [null, undefined, ""]) {
      const copy = ledgerWaitCopy(h);
      expect(copy).toMatch(/confirming on ledger/i);
      expect(copy).toContain(LEDGER_CONFIRM_HINT);
    }
  });

  it("names a duration, so a normal wait does not read as a hang", () => {
    expect(LEDGER_CONFIRM_HINT).toMatch(/30/);
    expect(LEDGER_CONFIRM_HINT).toMatch(/60/);
  });
});

describe("strategyIsComplete + shouldAutoResume — hard stop after final", () => {
  const fourOk = [
    { status: "ok" },
    { status: "ok" },
    { status: "done" },
    { status: "ok" },
  ];

  it("4/4 terminal with success → complete", () => {
    expect(strategyIsComplete(fourOk)).toBe(true);
  });

  it("skipped-only is not complete (no success)", () => {
    expect(
      strategyIsComplete([{ status: "skipped" }, { status: "skipped" }]),
    ).toBe(false);
  });

  it("any pending / needs_sign → not complete", () => {
    expect(
      strategyIsComplete([
        { status: "ok" },
        { status: "ok" },
        { status: "needs_sign" },
        { status: "pending" },
      ]),
    ).toBe(false);
  });

  it("hop patch of 1 settled leg is NOT a complete run (borrow stuck bug)", () => {
    // Deposit hop returns multi_leg_steps:[deposit ok]. Full card still has
    // borrow+supply pending — must NOT treat the hop as RUN COMPLETE.
    const fullCard = [
      { status: "ok" },
      { status: "ok" },
      { status: "pending" },
      { status: "pending" },
    ];
    const hopPatch = [{ status: "ok" }];
    expect(strategyIsComplete(hopPatch)).toBe(true); // alone looks done
    expect(strategyIsComplete(fullCard)).toBe(false); // authority
    expect(
      shouldAutoResume({
        complete: strategyIsComplete(fullCard),
        clientTail: [{ op: "borrow", amount: 10 }],
      }),
    ).toBe(true);
  });

  it("auto-sign path: hop execution.status=completed must not clear the tail", () => {
    // multi_leg_resume returns execution.status:"completed" when the ONE leg it
    // was handed succeeds (allOk for that hop). The executed useEffect used to
    // treat that as cardComplete → strategyTailRef=[] + strategyCompleteRef=true
    // while the full card still had borrow/supply PENDING.
    const fullCard = [
      { status: "ok" }, // lend
      { status: "ok" }, // deposit
      { status: "pending" }, // borrow
      { status: "pending" }, // supply
    ];
    const hopExecutionCompleted = true; // response.execution.status === "completed"
    const hopStrategyCompleteFlag = false; // usually unset on resume hops
    // Correct client gate: full card only (never hop status flags alone).
    const complete =
      strategyIsComplete(fullCard) ||
      (hopExecutionCompleted && strategyIsComplete(fullCard)) ||
      hopStrategyCompleteFlag;
    expect(complete).toBe(false);
    const clientTail = FOUR_LEGS.slice(2);
    expect(
      shouldAutoResume({
        complete,
        clientTail,
        preferFlag: false,
        canResumeWithAutoApprove: true,
      }),
    ).toBe(true);
    // Done only when complete AND nothing remains — not !preferResume.
    const remaining = pickRemainingLegs([], clientTail, legsFromUnsettledSteps(fullCard));
    expect(remaining.map((l) => l.op)).toEqual(["borrow", "supply_to_blend"]);
    expect(complete && remaining.length === 0).toBe(false);
  });

  it("cross-asset deposit+borrow: unsettled rebuild keeps assets", () => {
    const steps = [
      { op: "deposit_collateral", status: "ok", amount: 10, asset: "BLUSDC", label: "Deposit 10 BLUSDC" },
      { op: "borrow", status: "needs_wallet_sign", amount: 50, asset: "XLM", label: "Borrow 50 XLM" },
      { op: "supply_to_blend", status: "pending", amount: 20, asset: "BLUSDC", label: "Supply" },
    ];
    // Claim settle the signed borrow BEFORE pickRemaining — do not re-queue it.
    const { steps: settled } = claimFirstAwaitingLeg(steps, (s) => ({
      ...s,
      status: "ok",
      tx_hash: "x",
    }));
    const remaining = pickRemainingLegs(
      null,
      [],
      legsFromUnsettledSteps(settled),
    );
    expect(remaining).toEqual([
      expect.objectContaining({ op: "supply_to_blend", asset: "BLUSDC", amount: 20 }),
    ]);
    expect(strategyIsComplete(settled)).toBe(false);
  });

  it("THE LIVE BUG: complete → never auto-resume even with tail / unsettled garbage", () => {
    // After RUN COMPLETE, leftover client tail + orphan staged rows used to
    // toast "Running Borrow 10 BLUSDC (1 more after this)…" and re-submit.
    expect(
      shouldAutoResume({
        complete: true,
        serverRemaining: FOUR_LEGS.slice(2),
        clientTail: FOUR_LEGS.slice(2),
        preferFlag: true,
        canResumeWithAutoApprove: true,
      }),
    ).toBe(false);
  });

  it("incomplete + client tail → resume", () => {
    expect(
      shouldAutoResume({
        complete: false,
        clientTail: [{ op: "supply_to_blend", amount: 9.965 }],
      }),
    ).toBe(true);
  });

  it("incomplete + only orphan unsettled card (no server/tail flags) → do NOT resume", () => {
    // Card fallback alone must not restart a finished-looking hop; orphans from
    // a prior STAGED plan were the other half of the idle re-run bug.
    expect(
      shouldAutoResume({
        complete: false,
        serverRemaining: [],
        clientTail: [],
        preferFlag: false,
        canResumeWithAutoApprove: false,
      }),
    ).toBe(false);
  });

  it("incomplete + can_resume with auto-approve → resume", () => {
    expect(
      shouldAutoResume({
        complete: false,
        canResumeWithAutoApprove: true,
      }),
    ).toBe(true);
  });

  it("unsized add_liquidity after swap never auto-resumes — wait for XLM|AQUSDC amount", () => {
    expect(
      shouldAutoResume({
        complete: false,
        clientTail: [{ op: "add_liquidity", asset: "AQUSDC", amount: null }],
        preferFlag: true,
        canResumeWithAutoApprove: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoResume({
        complete: false,
        serverRemaining: [{ op: "add_liquidity", amount: 0 }],
        clientTail: [{ op: "add_liquidity", amount: 0 }],
      }),
    ).toBe(false);
    expect(
      shouldAutoResume({
        complete: false,
        clientTail: [{ op: "add_liquidity", amount: 1.64 }],
      }),
    ).toBe(true);
  });

  it("does not auto-resume when the HF floor pause is up", () => {
    expect(
      shouldAutoResume({
        complete: false,
        clientTail: [{ op: "borrow", amount: 10 }],
        preferFlag: true,
        canResumeWithAutoApprove: true,
        hfPaused: true,
      }),
    ).toBe(false);
  });

  it("pins a queued unsized LP so the amount card can attach after swap", () => {
    const row = pendingLpStepFromResume({
      op: "add_liquidity",
      asset: "AQUSDC",
      amount: null,
      token_in: "XLM",
      token_out: "AQUSDC",
    });
    expect(row.status).toBe("pending");
    expect(row.amount).toBeNull();
    expect(row.token_a).toBe("XLM");
    expect(row.token_b).toBe("AQUSDC");
    expect(row.label.toLowerCase()).toContain("liquidity");
    expect(strategyIsComplete([{ status: "ok" }, row])).toBe(false);
  });

  it("drops a leftover unsized add once the sized add has settled", () => {
    const card = [
      { op: "swap", status: "ok" },
      { op: "add_liquidity", status: "ok", label: "add liquidity 2 XLM" },
      { op: "add_liquidity", status: "pending", label: "add liquidity SOUSDC" },
    ];
    expect(farmWriteAlreadySettled("add_liquidity", card)).toBe(true);
    const pruned = pruneDuplicateFarmAdds(card);
    expect(pruned.map((s) => `${s.op}:${s.status}`)).toEqual([
      "swap:ok",
      "add_liquidity:ok",
    ]);
    expect(strategyIsComplete(pruned)).toBe(true);
  });
});
