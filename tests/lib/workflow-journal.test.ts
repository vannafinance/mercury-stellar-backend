import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { WorkflowJournal } from "@/lib/copilot/workflow/journal";
import type { RecordStore } from "@/lib/copilot/workflow/store";
import type { WorkflowRecord } from "@/lib/copilot/workflow/types";

const identity = { scope: { subject: "owner", trader: "wallet", smartAccount: "account", network: "testnet" }, server: "mcp" };
function fixture() {
  let row: { value: WorkflowRecord; version: string } | null = null;
  const store: RecordStore<WorkflowRecord> = {
    read: async () => structuredClone(row),
    write: async (_id, expected, value) => {
      if ((row?.version ?? null) !== expected) return false;
      row = { version: String(Number(expected ?? -1) + 1), value: structuredClone(value) };
      return true;
    },
  };
  let now = 1000;
  const journal = new WorkflowJournal(store, () => now);
  const create = () => journal.create({ ...identity, objective: "Supply 1 XLM", messages: ["Supply 1 XLM"], assumptions: [], constraints: [], floor: null,
    steps: [{ id: "one", op: "lend", asset: "XLM", amount: "1", label: "Supply 1 XLM", tool: "server-selected", args: { amount: "1" } }] });
  return { journal, create, advance: () => { now += 300_001; } };
}

describe("workflow approval and execution journal", () => {
  it("refuses to hold a proposal whose amount is still a sentinel or zero", async () => {
    const { journal } = fixture();
    const step = { id: "one", op: "borrow" as const, asset: "XLM", label: "Borrow", tool: "t", args: {} };
    const base = { ...identity, objective: "o", messages: ["o"], assumptions: [], constraints: [], floor: "1.30" };
    for (const amount of ["max", "", "0", "-1", "1e3", "abc"]) {
      await expect(journal.create({ ...base, steps: [{ ...step, amount }] })).rejects.toThrow("unsized_proposal_step");
    }
    // A resolved amount is held as normal.
    expect((await journal.create({ ...base, steps: [{ ...step, amount: "6541.043333" }] })).proposal.steps[0].amount)
      .toBe("6541.043333");
  });

  it("rejects wrong identity, modified approval, and expiration", async () => {
    const { journal, create, advance } = fixture();
    const { proposal: p } = await create();
    await expect(journal.read(p.id, { ...identity, scope: { ...identity.scope, subject: "attacker" } })).rejects.toThrow("workflow_not_found");
    await expect(journal.approve(p.id, identity, 1, "changed", async () => null)).rejects.toThrow("proposal_changed");
    advance();
    await expect(journal.approve(p.id, identity, 1, p.digest, async () => null)).rejects.toThrow("proposal_expired");
  });
  it("looks up a record by authenticated subject without a pre-resolved wallet", async () => {
    const { journal, create } = fixture();
    const { proposal: p } = await create();
    expect((await journal.lookup(p.id, "owner")).value.proposal.id).toBe(p.id);
    await expect(journal.lookup(p.id, "attacker")).rejects.toThrow("workflow_not_found");
  });
  it("allows one validation and one MCP claim despite concurrent requests", async () => {
    const { journal, create } = fixture();
    const { proposal: p } = await create();
    let validations = 0;
    const approvals = await Promise.allSettled(Array.from({ length: 8 }, () => journal.approve(p.id, identity, 1, p.digest, async () => { validations++; return null; })));
    expect(approvals.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(validations).toBe(1);
    const claims = await Promise.allSettled([journal.claimNext(p.id, identity), journal.claimNext(p.id, identity)]);
    expect(claims.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(journal.claimNext(p.id, identity)).rejects.toThrow("step_already_claimed");
  });
  /**
   * Approval is not a standing licence. Between approving a plan and broadcasting a later
   * step, a price move can push the position through the floor the user set — so the
   * readiness check runs per step, and refusing must STOP the run rather than re-size the
   * amount to make it fit.
   */
  it("stops the run when the position is no longer ready, without submitting anything", async () => {
    const { journal, create } = fixture();
    const { proposal: p } = await create();
    await journal.approve(p.id, identity, 1, p.digest, async () => null);

    await expect(journal.claimNext(p.id, identity, async () => ({ kind: "stop", reason: "Your 1.30 floor would be breached at the current price." })))
      .rejects.toThrow("step_not_ready");

    const record = await journal.read(p.id, identity);
    expect(record.value.status).toBe("blocked");
    expect(record.value.message).toMatch(/1.30 floor would be breached/);
    // Nothing was submitted, so the step is not a FAILED transaction — and a blocked run
    // cannot be claimed again, so returning it to pending is not a retry.
    expect(record.value.steps[0]).toEqual({ id: "one", status: "pending" });
    await expect(journal.claimNext(p.id, identity)).rejects.toThrow("workflow_not_runnable");
  });

  it("treats an unavailable readiness check as a refusal, not a pass", async () => {
    const { journal, create } = fixture();
    const { proposal: p } = await create();
    await journal.approve(p.id, identity, 1, p.digest, async () => null);

    await expect(journal.claimNext(p.id, identity, async () => { throw new Error("rpc down"); }))
      .rejects.toThrow("step_not_ready");
    const record = await journal.read(p.id, identity);
    expect(record.value.status).toBe("blocked");
    expect(record.value.message).toMatch(/could not be re-checked/);
  });

  it("hands over the step when the readiness check passes", async () => {
    const { journal, create } = fixture();
    const { proposal: p } = await create();
    await journal.approve(p.id, identity, 1, p.digest, async () => null);

    const seen: string[] = [];
    const step = await journal.claimNext(p.id, identity, async (proposal, s) => {
      seen.push(`${proposal.id === p.id}:${s.id}`);
      return { kind: "ready" };
    });
    expect(step.id).toBe("one");
    // The check sees the server-held proposal and the specific step about to go out.
    expect(seen).toEqual(["true:one"]);
    expect((await journal.read(p.id, identity)).value.steps[0].status).toBe("invoking");
  });

  it("blocks uncertain tool outcomes rather than issuing the write again", async () => {
    const { journal, create } = fixture();
    const { proposal: p } = await create();
    await journal.approve(p.id, identity, 1, p.digest, async () => null);
    await journal.claimNext(p.id, identity);
    await journal.invocationResult(p.id, identity, "one", { kind: "uncertain" });
    await expect(journal.claimNext(p.id, identity)).rejects.toThrow("workflow_not_runnable");
    await expect(journal.cancel(p.id, identity)).rejects.toThrow("reconcile_inflight_step_first");
  });
  it("does not report success until the matching hash settles on chain", async () => {
    const { journal, create } = fixture();
    const { proposal: p } = await create();
    await journal.approve(p.id, identity, 1, p.digest, async () => null);
    await journal.claimNext(p.id, identity);
    const hash = "a".repeat(64);
    await journal.invocationResult(p.id, identity, "one", { kind: "submitted", txHash: hash });
    expect((await journal.read(p.id, identity)).value.status).toBe("running");
    await expect(journal.settled(p.id, identity, "one", "b".repeat(64), 100, true)).rejects.toThrow("settlement_mismatch");
    expect((await journal.settled(p.id, identity, "one", hash, 100, true)).status).toBe("completed");
  });
  it("a failed fresh validation consumes approval without claiming a write", async () => {
    const { journal, create } = fixture();
    const { proposal: p } = await create();
    expect((await journal.approve(p.id, identity, 1, p.digest, async () => "Balance changed")).status).toBe("blocked");
    await expect(journal.claimNext(p.id, identity)).rejects.toThrow("workflow_not_runnable");
  });
  /**
   * Reconcile before retrying. An uncertain step's transaction may or may not be in flight,
   * so the ledger — not a retry — decides what happened.
   */
  describe("reconciling an uncertain submission", () => {
    const uncertain = async (txHash?: string) => {
      const f = fixture();
      const { proposal: p } = await f.create();
      await f.journal.approve(p.id, identity, 1, p.digest, async () => null);
      await f.journal.claimNext(p.id, identity);
      await f.journal.invocationResult(p.id, identity, "one", { kind: "uncertain", txHash });
      return { ...f, p };
    };

    it("settles the step when the recorded reference is found on chain", async () => {
      const hash = "c".repeat(64);
      const { journal, p } = await uncertain(hash);
      const asked: string[] = [];
      const record = await journal.reconcile(p.id, identity, "one", async (h) => {
        asked.push(h);
        return { found: true, success: true, ledger: 42 };
      });
      expect(asked).toEqual([hash]);
      expect(record.status).toBe("completed");
      expect(record.steps[0]).toMatchObject({ status: "settled", settledLedger: 42 });
    });

    it("stops the run when the reference is found to have failed", async () => {
      const { journal, p } = await uncertain("d".repeat(64));
      const record = await journal.reconcile(p.id, identity, "one", async () => ({ found: true, success: false, ledger: 43 }));
      expect(record.status).toBe("blocked");
      expect(record.steps[0].status).toBe("failed");
      await expect(journal.claimNext(p.id, identity)).rejects.toThrow("workflow_not_runnable");
    });

    it("frees the step for a genuine retry only once the ledger shows nothing was spent", async () => {
      const { journal, p } = await uncertain("e".repeat(64));
      const record = await journal.reconcile(p.id, identity, "one", async () => ({ found: false }));
      expect(record.status).toBe("uncertain");
      expect(record.steps[0].txHash).toBe("e".repeat(64));
      await expect(journal.claimNext(p.id, identity)).rejects.toThrow("workflow_not_runnable");
    });

    it("refuses to reconcile with no reference to look up, rather than guessing", async () => {
      const { journal, p } = await uncertain();
      await expect(journal.reconcile(p.id, identity, "one", async () => ({ found: false })))
        .rejects.toThrow("unreconcilable_without_reference");
      // Still uncertain, still unclaimable: no duplicate transaction can escape this way.
      expect((await journal.read(p.id, identity)).value.steps[0].status).toBe("uncertain");
      await expect(journal.claimNext(p.id, identity)).rejects.toThrow("workflow_not_runnable");
    });

    it("leaves the step uncertain when the lookup itself fails", async () => {
      const { journal, p } = await uncertain("f".repeat(64));
      await expect(journal.reconcile(p.id, identity, "one", async () => { throw new Error("horizon down"); })).rejects.toThrow();
      expect((await journal.read(p.id, identity)).value.steps[0].status).toBe("uncertain");
    });

    it("rejects a malformed reference instead of recording it", async () => {
      const f = fixture();
      const { proposal: p } = await f.create();
      await f.journal.approve(p.id, identity, 1, p.digest, async () => null);
      await f.journal.claimNext(p.id, identity);
      await expect(f.journal.invocationResult(p.id, identity, "one", { kind: "uncertain", txHash: "nope" }))
        .rejects.toThrow("invalid_transaction_hash");
    });
  });
  /**
   * Re-sizing between legs, and its limits.
   *
   * Stopping mid-plan is not neutral: leg one's borrowed money pays interest while leg two
   * is blocked. So an amount DERIVED from a constraint is re-derived at broadcast time. An
   * amount the user STATED is not — that would carry out a different instruction — and
   * re-derivation is bounded, or the health floor stops being a stop condition.
   */
  describe("re-sizing a derived amount between legs", () => {
    const derived = (minAmountUsd: string) => ({
      id: "one", op: "borrow" as const, asset: "USDC", amount: "1000", label: "Borrow to the 1.30 floor",
      tool: "t", args: {}, sizing: { basis: "derived_max_at_floor" as const, minAmountUsd },
    });
    const base = { ...identity, objective: "o", messages: ["o"], assumptions: [], constraints: [], floor: "1.30" };

    const approved = async (step: ReturnType<typeof derived> | Record<string, unknown>) => {
      const f = fixture();
      const created = await f.journal.create({ ...base, steps: [step as never] });
      await f.journal.approve(created.proposal.id, identity, 1, created.proposal.digest, async () => null);
      return { ...f, p: created.proposal };
    };

    it("carries the step out at the re-derived size and records what was actually sent", async () => {
      const { journal, p } = await approved(derived("500"));
      await expect(journal.claimNext(p.id, identity, async () => ({ kind: "resize", amountUsd: "820" }))).rejects.toThrow("step_not_ready");
      const record = await journal.read(p.id, identity);
      expect(record.value.proposal.steps[0].amount).toBe("1000");
      expect(record.value.status).toBe("blocked");
    });

    it("stops rather than re-sizing an amount the user stated outright", async () => {
      const { journal, p } = await approved({
        id: "one", op: "borrow", asset: "USDC", amount: "500", label: "Borrow 500 USDC", tool: "t", args: {},
        sizing: { basis: "stated" },
      });
      await expect(journal.claimNext(p.id, identity, async () => ({ kind: "resize", amountUsd: "430" })))
        .rejects.toThrow("step_not_ready");
      const record = await journal.read(p.id, identity);
      expect(record.value.status).toBe("blocked");
      expect(record.value.message).toMatch(/carry out a different instruction/);
      expect(record.value.steps[0].executedAmountUsd).toBeUndefined();
    });

    it("treats a step with no recorded sizing basis as stated, not as re-sizable", async () => {
      const { journal, p } = await approved({
        id: "one", op: "borrow", asset: "USDC", amount: "500", label: "Borrow", tool: "t", args: {},
      });
      await expect(journal.claimNext(p.id, identity, async () => ({ kind: "resize", amountUsd: "400" })))
        .rejects.toThrow("step_not_ready");
    });

    it("refuses to re-size UPWARD — a favourable move is not authority to borrow more", async () => {
      const { journal, p } = await approved(derived("500"));
      await expect(journal.claimNext(p.id, identity, async () => ({ kind: "resize", amountUsd: "1200" })))
        .rejects.toThrow("step_not_ready");
      expect((await journal.read(p.id, identity)).value.message).toMatch(/new proposal/);
    });

    it("stops below the approved bound, so the floor stays a stop condition not a slider", async () => {
      const { journal, p } = await approved(derived("500"));
      await expect(journal.claimNext(p.id, identity, async () => ({ kind: "resize", amountUsd: "499.99" })))
        .rejects.toThrow("step_not_ready");
      const record = await journal.read(p.id, identity);
      expect(record.value.message).toMatch(/new proposal/);
      expect(record.value.message).toMatch(/different instruction/);
    });

    it("refuses an unreadable re-sized amount instead of sending something", async () => {
      for (const amountUsd of ["", "max", "-5", "1e3"]) {
        const { journal, p } = await approved(derived("500"));
        await expect(journal.claimNext(p.id, identity, async () => ({ kind: "resize", amountUsd })))
          .rejects.toThrow("step_not_ready");
        expect((await journal.read(p.id, identity)).value.status).toBe("blocked");
      }
    });
  });

  it("blocks a failed invocation without recording a hash", async () => {
    const { journal, create } = fixture();
    const { proposal: p } = await create();
    await journal.approve(p.id, identity, 1, p.digest, async () => null);
    await journal.claimNext(p.id, identity);
    const record = await journal.invocationResult(p.id, identity, "one", {
      kind: "failed", message: "Simulation failed. Nothing was submitted.",
    });
    expect(record.status).toBe("blocked");
    expect(record.steps[0]).toMatchObject({ status: "failed", message: "Simulation failed. Nothing was submitted." });
    expect(record.steps[0].txHash).toBeUndefined();
    await expect(journal.claimNext(p.id, identity)).rejects.toThrow("workflow_not_runnable");
  });

  it("accepts a submitted hash only from awaiting_signature", async () => {
    const { journal, create } = fixture();
    const { proposal: p } = await create();
    await journal.approve(p.id, identity, 1, p.digest, async () => null);
    await journal.claimNext(p.id, identity);
    const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), { fee: "100", networkPassphrase: Networks.TESTNET }).setTimeout(60).build();
    const hash = tx.hash().toString("hex");
    await journal.invocationResult(p.id, identity, "one", {
      kind: "unsigned", unsignedXdr: tx.toXDR(),
    });
    await expect(journal.acceptSubmittedHash(p.id, identity, "one", "not-a-hash"))
      .rejects.toThrow("invalid_transaction_hash");
    await expect(journal.acceptSubmittedHash(p.id, identity, "one", "f".repeat(64))).rejects.toThrow("transaction_mismatch");
    const record = await journal.acceptSubmittedHash(p.id, identity, "one", hash);
    expect(record.status).toBe("running");
    expect(record.steps[0]).toMatchObject({ status: "submitted", txHash: hash });
    expect(record.steps[0].unsignedXdr).toBeUndefined();
    await expect(journal.acceptSubmittedHash(p.id, identity, "one", "b".repeat(64)))
      .rejects.toThrow("step_changed");
  });
});
